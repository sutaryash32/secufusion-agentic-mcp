// Release readiness — deterministic analysis of a commit range. Pure helpers; unit-tested.

export function parseIncluded(subjects) {
  const prs = [];
  const workItems = new Set();
  for (const s of subjects) {
    const m = s.match(/^Merged PR (\d+): (.+)$/);
    if (m) prs.push({ id: Number(m[1]), title: m[2] });
    for (const w of s.matchAll(/\b(?:WI|BUG|US|TASK|AB#)[- #]?(\d{3,6})\b/gi)) workItems.add(Number(w[1]));
  }
  return { prs, workItems: [...workItems].sort((a, b) => a - b) };
}

const MIG = /(?:^|\/)V(\d+)(?:_(\d+))?__([\w-]+)\.sql$/;
export const migrationVersion = (path) => {
  const m = path.match(MIG);
  return m ? Number(`${m[1]}.${m[2] ?? 0}`) : undefined;
};

/**
 * @param {Array<{status:string, path:string}>} changes name-status within the migrations dir
 * @param {string[]} allAtTo every migration file at the `to` ref
 */
export function analyseMigrations(changes, allAtTo) {
  const added = changes.filter((c) => c.status === 'A' && migrationVersion(c.path) !== undefined)
    .map((c) => ({ path: c.path, version: migrationVersion(c.path) }))
    .sort((a, b) => a.version - b.version);
  const modified = changes.filter((c) => c.status === 'M').map((c) => c.path);
  const deleted = changes.filter((c) => c.status === 'D').map((c) => c.path);
  const malformed = changes.filter((c) => c.status === 'A' && /\.sql$/.test(c.path) && migrationVersion(c.path) === undefined).map((c) => c.path);
  const byVersion = new Map();
  for (const p of allAtTo) {
    const v = migrationVersion(p);
    if (v !== undefined) byVersion.set(v, [...(byVersion.get(v) ?? []), p]);
  }
  const duplicates = [...byVersion.entries()].filter(([, ps]) => ps.length > 1).map(([v, ps]) => ({ version: v, files: ps }));
  const priorMax = Math.max(0, ...[...byVersion.keys()].filter((v) => !added.some((a) => a.version === v)));
  const outOfOrder = added.filter((a) => a.version < priorMax).map((a) => a.path);
  return { added, modified, deleted, malformed, duplicates, outOfOrder };
}

/** .properties → { key: value } */
export function parseProperties(text = '') {
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const m = line.match(/^([^=:\s]+)\s*[=:]\s*(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** Minimal YAML flattener for Spring config (mappings + scalars; lists are kept as raw text). */
export function flattenYaml(text = '') {
  const out = {};
  const stack = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#') || raw.trim() === '---') continue;
    const indent = raw.length - raw.trimStart().length;
    const m = raw.trim().match(/^([\w.\-[\]]+)\s*:\s*(.*)$/);
    if (!m) continue;
    while (stack.length && stack.at(-1).indent >= indent) stack.pop();
    const key = [...stack.map((s) => s.key), m[1]].join('.');
    if (m[2] === '' || m[2] === '|' || m[2] === '>') stack.push({ indent, key: m[1] });
    else out[key] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

export function diffConfig(file, before, after) {
  const added = [];
  const removed = [];
  const changed = [];
  for (const [k, v] of Object.entries(after)) {
    if (!(k in before)) added.push({ key: k, value: v });
    else if (before[k] !== v) changed.push({ key: k, from: before[k], to: v });
  }
  for (const k of Object.keys(before)) if (!(k in after)) removed.push({ key: k, value: before[k] });
  return { file, added, removed, changed };
}

/** Environment variables referenced as ${VAR} / ${VAR:default}; `required` = no default. */
export function envVars(configDiffs) {
  const vars = new Map();
  for (const d of configDiffs) {
    for (const e of [...d.added, ...d.changed.map((c) => ({ key: c.key, value: c.to }))]) {
      for (const m of String(e.value).matchAll(/\$\{([A-Z][A-Z0-9_]*)(?::([^}]*))?\}/g)) {
        const prev = vars.get(m[1]);
        vars.set(m[1], { name: m[1], required: m[2] === undefined && (prev?.required ?? true), default: m[2] ?? prev?.default, usedBy: [...(prev?.usedBy ?? []), `${d.file}:${e.key}`] });
      }
    }
  }
  return [...vars.values()];
}

export function featureFlags(configDiffs) {
  const flags = [];
  for (const d of configDiffs) {
    for (const e of d.added) {
      if (/(^|\.)(enabled|enable|feature\.[\w.-]+)$/i.test(e.key)) {
        const def = String(e.value).match(/\$\{[A-Z0-9_]+:(true|false)\}/i)?.[1] ?? String(e.value);
        flags.push({ file: d.file, key: e.key, default: def, onByDefault: /^true$/i.test(def) });
      }
    }
  }
  return flags;
}

/** Endpoint / topic surface changes from a unified diff (added vs removed lines). */
export function surfaceChanges(diffText) {
  const endpoints = { added: [], removed: [] };
  const topics = { added: [], removed: [] };
  for (const line of diffText.split('\n')) {
    const sign = line[0];
    if (sign !== '+' && sign !== '-') continue;
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    const body = line.slice(1);
    const ep = body.match(/@(Get|Post|Put|Delete|Patch|Request)Mapping\s*\(\s*(?:value\s*=\s*|path\s*=\s*)?"([^"]*)"/);
    if (ep) (sign === '+' ? endpoints.added : endpoints.removed).push(`${ep[1] === 'Request' ? '*' : ep[1].toUpperCase()} ${ep[2]}`);
    const tp = body.match(/\b\w*TOPIC\w*\s*=\s*"([^"]+)"/);
    if (tp) (sign === '+' ? topics.added : topics.removed).push(tp[1]);
  }
  const net = (x) => ({ added: x.added.filter((a) => !x.removed.includes(a)), removed: x.removed.filter((r) => !x.added.includes(r)) });
  return { endpoints: net(endpoints), topics: net(topics) };
}

export function releaseVerdict(r) {
  const attention = [];
  if (r.migrations.modified.length) attention.push(`${r.migrations.modified.length} already-existing migration(s) modified`);
  if (r.migrations.duplicates.length) attention.push(`duplicate migration version(s): ${r.migrations.duplicates.map((d) => `V${d.version}`).join(', ')}`);
  if (r.migrations.outOfOrder.length) attention.push(`${r.migrations.outOfOrder.length} migration(s) numbered below the current head`);
  if (r.migrations.malformed.length) attention.push(`${r.migrations.malformed.length} malformed migration filename(s)`);
  const req = r.envVars.filter((v) => v.required);
  if (req.length) attention.push(`${req.length} new env var(s) with no default: ${req.map((v) => v.name).join(', ')}`);
  const on = r.flags.filter((f) => f.onByDefault);
  if (on.length) attention.push(`${on.length} new flag(s) on by default`);
  const majors = r.dependencyChanges.filter((d) => d.bump === 'major');
  if (majors.length) attention.push(`${majors.length} major dependency upgrade(s)`);
  if (r.surface.endpoints.removed.length) attention.push(`${r.surface.endpoints.removed.length} endpoint mapping(s) removed`);
  if (r.surface.topics.removed.length) attention.push(`${r.surface.topics.removed.length} Kafka topic constant(s) removed`);
  return { verdict: attention.length ? 'attention' : 'ready', attention };
}
