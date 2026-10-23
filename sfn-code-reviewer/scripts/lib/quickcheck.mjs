// Fast deterministic checks — no model, seconds. The mechanical half of the rules, on every push.
// Pure: works on parsed diff + file contents provided by the caller. Unit-tested.
// Each check returns findings in the normal finding format (specialist "quick-check"). Heuristic
// checks report confidence "possible"; exact ones (migration numbering, secrets) "confirmed".

/** `git diff -U0` → { file: [{line, text}] } for ADDED lines (new-file line numbers). */
export function parseAddedLines(diff) {
  const out = {};
  let file;
  let line = 0;
  for (const raw of diff.split('\n')) {
    const f = raw.match(/^\+\+\+ (?:b\/(.+)|\/dev\/null)$/);
    if (f) { file = f[1]; continue; }
    if (raw.startsWith('--- ')) continue;
    const h = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) { line = Number(h[1]); continue; }
    if (!file) continue;
    if (raw.startsWith('+')) { (out[file] ??= []).push({ line, text: raw.slice(1) }); line++; }
    else if (!raw.startsWith('-') && !raw.startsWith('\\')) line++;
  }
  return out;
}

const MIG = /(?:^|\/)V(\d+)(?:_(\d+))?__([\w-]+)\.sql$/;
const migVersion = (p) => { const m = p.match(MIG); return m ? Number(`${m[1]}.${m[2] ?? 0}`) : undefined; };

function finding(o) {
  return { confidence: 'possible', specialist: 'quick-check', ...o, title: o.title.slice(0, 140) };
}

/**
 * @param {object} ctx
 * @param {string} ctx.repoKey
 * @param {string} ctx.stack java-spring | react-vite | unknown
 * @param {Array<{path:string,status:string}>} ctx.changedFiles
 * @param {Object<string, Array<{line:number,text:string}>>} ctx.added   from parseAddedLines
 * @param {(path:string)=>string} ctx.read      file content at head ('' if missing)
 * @param {string[]} ctx.baseMigrations          migration file paths on the base
 * @param {string} [ctx.migrationsDir]
 * @param {(column:string)=>boolean} [ctx.columnKnownElsewhere]  true if any existing migration (this repo's
 *        base or a sibling repo — the APIs share one database) already creates/mentions the column
 * @param {string} [ctx.allowlist]  MutatingEndpointAllowlist.java content at head
 */
export function quickCheck(ctx) {
  const out = [];
  const { changedFiles, added, read } = ctx;
  const migDir = ctx.migrationsDir ?? 'src/main/resources/db/migration';
  const java = ctx.stack !== 'react-vite';

  // ---- migrations (exact) -------------------------------------------------------------------
  if (java) {
    const baseVersions = ctx.baseMigrations.map(migVersion).filter((v) => v !== undefined);
    const head = Math.max(0, ...baseVersions);
    for (const c of changedFiles.filter((f) => f.path.startsWith(`${migDir}/`))) {
      if (c.status === 'M') {
        out.push(finding({ ruleId: 'DB-002', severity: 'blocker', confidence: 'confirmed', category: 'db', file: c.path, line: 1, anchor: c.path.split('/').pop(),
          title: `Existing migration ${c.path.split('/').pop()} was modified`, problem: 'An already-existing migration file changed. Migrations are applied by hand once; environments that already ran it will never see the change.',
          failureScenario: 'Dev/QA/prod already applied the old version → schema differs between environments; the edit silently never runs there.', suggestion: 'Revert the edit and add a new V<next>__*.sql with the change.' }));
      }
      if (c.status !== 'A' || !c.path.endsWith('.sql')) continue;
      const v = migVersion(c.path);
      const name = c.path.split('/').pop();
      if (v === undefined) {
        out.push(finding({ ruleId: 'DB-003', severity: 'major', confidence: 'confirmed', category: 'db', file: c.path, line: 1, anchor: name,
          title: `Migration ${name} doesn't match V<n>__<name>.sql`, problem: 'The filename is not a versioned migration name, so ops will not know where it goes in the apply order.',
          failureScenario: 'The file is skipped or applied out of order when ops apply migrations by version.', suggestion: `Rename to V${Math.floor(head) + 1}__<snake_case>.sql.` }));
      } else if (baseVersions.includes(v)) {
        out.push(finding({ ruleId: 'DB-003', severity: 'major', confidence: 'confirmed', category: 'db', file: c.path, line: 1, anchor: name,
          title: `Migration version V${v} already exists on the base branch`, problem: `${name} reuses a version number that is already taken.`,
          failureScenario: 'Two different migrations share one version → one of them is never applied in some environment.', suggestion: `Renumber to V${Math.floor(head) + 1}.` }));
      } else if (v < head) {
        out.push(finding({ ruleId: 'DB-003', severity: 'major', confidence: 'confirmed', category: 'db', file: c.path, line: 1, anchor: name,
          title: `Migration V${v} is numbered below the current head V${head}`, problem: `${name} slots in below migrations that environments have already applied.`,
          failureScenario: 'Environments at V' + head + ' never apply it, because ops apply only higher versions.', suggestion: `Renumber to V${Math.floor(head) + 1}.` }));
      }
    }

    // entity column without a migration that mentions it (heuristic)
    const migText = changedFiles.filter((f) => f.status !== 'D' && f.path.startsWith(`${migDir}/`)).map((f) => read(f.path).toLowerCase()).join('\n');
    for (const [file, lines] of Object.entries(added)) {
      if (!/\/entity\/.+\.java$/.test(file)) continue;
      for (const l of lines) {
        const m = l.text.match(/@Column\s*\(\s*[^)]*name\s*=\s*"([A-Za-z0-9_]+)"/);
        if (m && !migText.includes(m[1].toLowerCase()) && !(ctx.columnKnownElsewhere?.(m[1]))) {
          out.push(finding({ ruleId: 'DB-001', severity: 'blocker', category: 'db', file, line: l.line, anchor: `${file.split('/').pop().replace('.java', '')}#${m[1]}`,
            title: `Column ${m[1]} is mapped but no migration in this change creates it`, problem: `A new @Column(name = "${m[1]}") was added and no migration in the change mentions ${m[1]}. ddl-auto is none.`,
            failureScenario: `After deploy every query on this entity selects ${m[1]} and fails until the column exists.`, suggestion: 'Add V<next>__*.sql creating the column (or confirm it already exists in every environment).' }));
        }
      }
    }
  }

  // ---- line-level checks on added code ------------------------------------------------------
  for (const [file, lines] of Object.entries(added)) {
    const isTest = /(^|\/)(src\/test\/|__tests__\/)|\.(test|spec)\.[jt]sx?$/.test(file);
    for (const l of lines) {
      const t = l.text;
      // secrets (exact-ish): literal values, not ${PLACEHOLDERS}
      if (!isTest && /(-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{32,}|xox[baprs]-[A-Za-z0-9-]{10,})/.test(t)
        || (!isTest && /\b(password|passwd|secret|api[_-]?key|client[_-]?secret|token)\b\s*[=:]\s*["']?[^\s"'${}<>]{8,}/i.test(t) && !/\$\{|<|example|changeme|dummy|test/i.test(t))) {
        out.push(finding({ ruleId: 'SEC-008', severity: 'blocker', confidence: 'confirmed', category: 'security', file, line: l.line, anchor: `${file}#secret@${l.line}`,
          title: 'A credential appears to be committed', problem: 'An added line contains what looks like a literal secret.',
          failureScenario: 'Anyone with repo access (and every clone, backup and pipeline log) has the credential.', suggestion: 'Remove it, rotate the credential, and read it from the external properties file / variable group.' }));
      }
      if (/authz\.scope-coverage\.enforce\s*[=:]\s*false/.test(t)) {
        out.push(finding({ ruleId: 'SEC-007', severity: 'major', confidence: 'confirmed', category: 'security', file, line: l.line, anchor: 'authz.scope-coverage.enforce',
          title: 'Scope-coverage enforcement turned off', problem: 'authz.scope-coverage.enforce=false puts the mutating-endpoint gate in shadow mode.',
          failureScenario: 'An unclassified mutating endpoint ships without a scope check and is reachable by any authenticated user.', suggestion: 'Keep enforce=true outside local profiles.' }));
      }
      const flag = t.match(/\$\{([A-Z0-9_]*(ENABLED|ENABLE|FEATURE)[A-Z0-9_]*):true\}/);
      if (flag) {
        out.push(finding({ ruleId: 'SEC-016', severity: 'major', category: 'security', file, line: l.line, anchor: flag[1],
          title: `New flag ${flag[1]} defaults to on`, problem: 'A feature flag is added with default true.',
          failureScenario: 'Every environment gets the feature on deploy, before anyone opts in.', suggestion: `Default it off: \${${flag[1]}:false}.` }));
      }
      if (java && /lb:\/\/|@LoadBalanced/.test(t)) {
        out.push(finding({ ruleId: 'RUN-005', severity: 'major', confidence: 'confirmed', category: 'runtime', file, line: l.line, anchor: `${file}#lb`,
          title: 'Peer call through Eureka load balancing', problem: '`lb://` / @LoadBalanced relies on Eureka, which is disabled in practice.', failureScenario: 'The call fails to resolve the service in every environment.', suggestion: 'Call the peer by its gateway URL.' }));
      }
      if (ctx.repoKey === 'sfn-events-api' && !isTest && !file.endsWith('.sql') && /(\bDELETE\s+FROM\b|\.delete(All|ById|AllById|AllInBatch)?\s*\()/i.test(t)) {
        // one finding per file, listing every location (a cascade-delete PR adds many)
        const anchor = `${file.split('/').pop()}#hard-delete`;
        const prev = out.find((f) => f.anchor === anchor);
        if (prev) { prev.evidence.push({ file, line: l.line, note: t.trim().slice(0, 120) }); prev.title = `${prev.evidence.length} hard deletes in ${file.split('/').pop()} (soft-delete repo)`; }
        else out.push(finding({ ruleId: 'DB-007', severity: 'major', category: 'db', file, line: l.line, anchor,
          title: 'Hard delete in sfn-events-api (soft-delete repo)', problem: 'sfn-events-api soft-deletes by status; this file adds hard deletes.',
          failureScenario: 'Rows other code expects to remain (with a status) disappear; FK-linked rows (incident_events) can make the delete fail mid-batch.', suggestion: 'Use the status flag, or document why this table is the exception (and delete children first).',
          evidence: [{ file, line: l.line, note: t.trim().slice(0, 120) }] }));
      }
      if (ctx.stack === 'react-vite' && /^src\//.test(file) && !isTest) {
        if (/import\s+axios\s+from\s+['"]axios['"]/.test(t) && !file.endsWith('utils/axiosConfig.js')) {
          out.push(finding({ ruleId: 'CON-007', severity: 'major', confidence: 'confirmed', category: 'contracts', file, line: l.line, anchor: `${file}#axios`,
            title: 'axios imported directly instead of axiosConfig', problem: 'Direct axios bypasses the shared client: token refresh, tenant headers and the error handling.', failureScenario: 'Calls fail with 401 after token expiry, or go out without the acting-tenant header.', suggestion: "import apiClient from '../utils/axiosConfig' instead." }));
        }
        if (/['"`]\/api\/(tenants|iam|events)\//.test(t) && !file.endsWith('utils/apiEndpoints.js')) {
          out.push(finding({ ruleId: 'CON-007', severity: 'minor', category: 'contracts', file, line: l.line, anchor: `${file}#url@${l.line}`,
            title: 'API URL inlined outside apiEndpoints.js', problem: 'URLs live only in src/utils/apiEndpoints.js.', failureScenario: 'A backend path change is updated in apiEndpoints.js but not here.', suggestion: 'Add the URL to apiEndpoints.js and use it.' }));
        }
        if (/currentUser\??\.tenantId/.test(t)) {
          out.push(finding({ ruleId: 'SEC-014', severity: 'major', category: 'security', file, line: l.line, anchor: `${file}#currentUser.tenantId`,
            title: 'Tenant id from currentUser instead of the acting tenant', problem: 'currentUser.tenantId ignores MSSP "Open as me" impersonation.', failureScenario: 'An MSSP operator acting as tenant B sees or writes their own tenant A data.', suggestion: 'Use useEffectiveTenantId() / selectActingTenantId.' }));
        }
      }
    }
  }

  // ---- mutating endpoints without a scope check (heuristic) ---------------------------------
  if (java) {
    const allow = ctx.allowlist ?? '';
    for (const [file, lines] of Object.entries(added)) {
      if (!/\/controller\/.+\.java$/.test(file)) continue;
      const src = read(file).split('\n');
      const classPreAuth = /@PreAuthorize/.test(src.slice(0, src.findIndex((x) => /\bclass\s+\w+/.test(x)) + 1).join('\n'));
      for (const l of lines) {
        const m = l.text.match(/@(Post|Put|Patch|Delete)Mapping\b/);
        if (!m || classPreAuth) continue;
        // annotations above the mapping (back to the previous member) …
        const block = [];
        for (let i = l.line - 2; i >= 0 && /^\s*(@|\/\/|\*|\/\*|\)|[\w"{},.=: ]+[,)]?\s*$)/.test(src[i] ?? '') && !/[;}]\s*$/.test(src[i] ?? ''); i--) block.push(src[i]);
        // … and everything from the mapping down to the method signature (multi-line @Operation etc.)
        let sig = '';
        for (let j = l.line - 1; j < Math.min(src.length, l.line + 80); j++) {
          if (/^\s*(public|protected|private)\b[^=;]*\(/.test(src[j])) { sig = src[j]; break; }
          block.push(src[j]);
        }
        const method = sig.match(/\b(\w+)\s*\(/)?.[1];
        const cls = file.split('/').pop().replace('.java', '');
        if (block.some((b) => /@PreAuthorize/.test(b)) || (method && allow.includes(`${cls}#${method}`))) continue;
        out.push(finding({ ruleId: 'SEC-001', severity: 'blocker', category: 'security', file, line: l.line, anchor: `${cls}#${method ?? `line${l.line}`}`,
          title: `New ${m[1].toUpperCase()} endpoint ${cls}#${method ?? '?'} has no @PreAuthorize`, problem: 'A mutating handler without @PreAuthorize (and not allowlisted) is denied by EndpointScopeCoverageInterceptor — or, if enforcement is off, reachable without a scope.',
          failureScenario: 'Enforced: every call gets 403 UNCLASSIFIED_ENDPOINT. Shadow mode: any authenticated user can call it.', suggestion: 'Add @PreAuthorize with the right scope, or a justified MutatingEndpointAllowlist entry.' }));
      }
    }
  }

  // ---- web-ui tests outside src/__tests__ ------------------------------------------------------
  if (ctx.stack === 'react-vite') {
    for (const c of changedFiles.filter((f) => f.status === 'A' && /\.(test|spec)\.[jt]sx?$/.test(f.path) && !f.path.startsWith('src/__tests__/'))) {
      out.push(finding({ ruleId: 'TST-008', severity: 'minor', confidence: 'confirmed', category: 'tests', file: c.path, line: 1, anchor: c.path,
        title: 'Test file outside src/__tests__ will not run', problem: 'Vitest is configured to run tests only from src/__tests__/.', failureScenario: 'The test never runs in CI, so it protects nothing.', suggestion: 'Move it under src/__tests__/.' }));
    }
  }
  return out;
}
