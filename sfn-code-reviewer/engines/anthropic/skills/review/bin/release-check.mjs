#!/usr/bin/env node
// Release readiness for one or more repos: what's in the release and what ops must do.
// Deterministic (git only). Optionally runs a deep review of the same range (--review).
//
//   node release-check.mjs --repo ../sfn-tenants-api [--repo ../sfn-iam-api ...]
//        [--from <ref>] [--to <ref>] [--out <dir>] [--review]
//
// --from defaults to the latest tag reachable from --to; --to defaults to origin/develop (else HEAD).
// Output: <out>/release-readiness.json + release-readiness.md + release-readiness.html
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { findDeployOrder } from './lib/deployorder.mjs';
import { diffDeps, manifestKind, parsePackageJson, parsePom } from './lib/deps.mjs';
import { loadConfig } from './lib/paths.mjs';
import {
  analyseMigrations, diffConfig, envVars, featureFlags, flattenYaml, parseIncluded, parseProperties, releaseVerdict, surfaceChanges,
} from './lib/release.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({
  options: {
    repo: { type: 'string', multiple: true, default: [] },
    from: { type: 'string' },
    to: { type: 'string' },
    out: { type: 'string', default: '.sfn-release' },
    review: { type: 'boolean', default: false },
  },
});
if (!args.repo.length) { console.error('usage: release-check.mjs --repo <path> [--repo ...] [--from ref] [--to ref] [--out dir] [--review]'); process.exit(64); }
const log = (m) => console.error(`[sfn-release] ${m}`);
const cfg = loadConfig();

const git = (repo, ...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).trim();
const tryGit = (repo, ...a) => { try { return git(repo, ...a); } catch { return ''; } };
const exists = (repo, ref) => tryGit(repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`) !== '';

const outDir = resolve(args.out);
mkdirSync(outDir, { recursive: true });
const repos = [];

for (const r of args.repo) {
  const repo = resolve(git(resolve(r), 'rev-parse', '--show-toplevel'));
  const key = basename(repo);
  const to = args.to ?? (exists(repo, 'origin/develop') ? 'origin/develop' : 'HEAD');
  const from = args.from ?? tryGit(repo, 'describe', '--tags', '--abbrev=0', to);
  if (!from || !exists(repo, from) || !exists(repo, to)) { log(`${key}: cannot resolve range ${from || '(no tag)'}..${to} — pass --from`); continue; }
  const range = `${from}..${to}`;
  const subjects = tryGit(repo, 'log', '--format=%s', range).split('\n').filter(Boolean);
  const nameStatus = tryGit(repo, 'diff', '--no-renames', '--name-status', from, to).split('\n').filter(Boolean)
    .map((l) => { const [status, path] = l.split('\t'); return { status, path }; });

  const repoCfg = cfg.repos.repos?.[key] ?? cfg.repos.defaults?.['java-spring'] ?? {};
  const migDir = repoCfg.migrations ?? 'src/main/resources/db/migration';
  const migrations = analyseMigrations(
    nameStatus.filter((c) => c.path.startsWith(`${migDir}/`)),
    tryGit(repo, 'ls-tree', '--name-only', to, `${migDir}/`).split('\n').filter(Boolean),
  );

  const show = (rev, path) => tryGit(repo, 'show', `${rev}:${path}`);
  const configDiffs = nameStatus
    .filter((c) => /(^|\/)application[^/]*\.(properties|ya?ml)$/.test(c.path) && !c.path.includes('/test/'))
    .map((c) => {
      const parse = c.path.endsWith('.properties') ? parseProperties : flattenYaml;
      return diffConfig(c.path, parse(c.status === 'A' ? '' : show(from, c.path)), parse(c.status === 'D' ? '' : show(to, c.path)));
    })
    .filter((d) => d.added.length || d.removed.length || d.changed.length);

  const dependencyChanges = nameStatus.flatMap(({ path, status }) => {
    const kind = manifestKind(path);
    if (!kind) return [];
    const parse = kind === 'pom' ? parsePom : parsePackageJson;
    return diffDeps(path, parse(status === 'A' ? '' : show(from, path)), parse(status === 'D' ? '' : show(to, path)));
  });

  const javaDiff = tryGit(repo, 'diff', '-U0', from, to, '--', '*.java');
  const surface = surfaceChanges(javaDiff);
  const entry = {
    repo: key, from, to, commits: subjects.length, filesChanged: nameStatus.length,
    ...parseIncluded(subjects),
    migrations, configDiffs, envVars: envVars(configDiffs), flags: featureFlags(configDiffs), dependencyChanges, surface,
  };
  // Work in this release whose counterpart in another repo isn't merged yet.
  entry.deployOrder = findDeployOrder({ repoKey: key, estateRoot: dirname(repo), subjects, repoKeys: Object.keys(cfg.repos.repos ?? {}) })
    .map((f) => ({ repo: f.repo, branch: f.file.replace(/^branch:/, ''), title: f.title }));
  Object.assign(entry, releaseVerdict(entry));
  for (const d of entry.deployOrder) { entry.attention.push(`depends on unmerged ${d.repo} ${d.branch}`); entry.verdict = 'attention'; }

  if (args.review && !existsSync(join(here, 'run-review.sh'))) {
    entry.review = 'skipped — --review needs the sfn-code-reviewer repo (scripts/release-check.mjs), not the plugin copy';
  } else if (args.review) {
    log(`${key}: deep review of ${range}…`);
    const res = spawnSync('bash', [join(here, 'run-review.sh'), '--repo', repo, '--base', from, '--head', to, '--level', 'deep', '--out', join(outDir, key)], { stdio: ['ignore', 'ignore', 'inherit'] });
    entry.review = res.status === 0 ? join(outDir, key, 'report.html') : `review failed (exit ${res.status})`;
  }
  repos.push(entry);
  log(`${key}: ${range} · ${entry.commits} commits · ${entry.prs.length} PRs · ${migrations.added.length} migration(s) · ${entry.verdict}`);
}

const report = { generatedAt: new Date().toISOString(), verdict: repos.some((r) => r.verdict === 'attention') ? 'attention' : 'ready', repos };
writeFileSync(join(outDir, 'release-readiness.json'), JSON.stringify(report, null, 2));
writeFileSync(join(outDir, 'release-readiness.md'), toMarkdown(report));
writeFileSync(join(outDir, 'release-readiness.html'), toHtml(toMarkdown(report)));
log(`${report.verdict.toUpperCase()} → ${join(outDir, 'release-readiness.md')}`);

function toMarkdown(rep) {
  const L = [`# Release readiness — ${rep.verdict === 'ready' ? '✅ ready' : '⚠️ needs attention'}`, '', `_Generated ${rep.generatedAt.slice(0, 16).replace('T', ' ')} UTC by sfn-code-reviewer._`, ''];
  for (const r of rep.repos) {
    L.push(`## ${r.repo} — \`${r.from}\` → \`${r.to}\` · ${r.verdict === 'ready' ? '✅' : '⚠️'}`, '');
    L.push(`${r.commits} commits · ${r.filesChanged} files · ${r.prs.length} PRs${r.workItems.length ? ` · work items ${r.workItems.map((w) => `#${w}`).join(', ')}` : ''}`, '');
    if (r.attention.length) L.push('**Needs attention**', ...r.attention.map((a) => `- ${a}`), '');
    L.push('### Ops checklist', '');
    if (r.migrations.added.length) {
      L.push(`- [ ] Apply migrations **in this order** (${cfg.repos.repos?.[r.repo] ? 'applied manually per repo' : 'per repo'}):`);
      r.migrations.added.forEach((m) => L.push(`  - [ ] \`${basename(m.path)}\``));
    } else L.push('- No new migrations.');
    for (const v of r.envVars) L.push(`- [ ] ${v.required ? 'Set' : 'Optionally set'} env \`${v.name}\`${v.default !== undefined ? ` (default \`${v.default}\`)` : ' — **no default, startup fails without it**'} — used by ${v.usedBy.join(', ')}`);
    for (const f of r.flags) L.push(`- [ ] Flag \`${f.key}\` defaults to \`${f.default}\`${f.onByDefault ? ' — **on by default**' : ''} (${f.file})`);
    for (const d of r.configDiffs) {
      for (const c of d.changed) L.push(`- [ ] Config \`${c.key}\` changed \`${c.from}\` → \`${c.to}\` (${d.file})`);
      for (const c of d.removed) L.push(`- [ ] Config \`${c.key}\` removed (${d.file}) — remove overrides in env files`);
    }
    L.push('');
    if (r.migrations.modified.length || r.migrations.duplicates.length || r.migrations.outOfOrder.length || r.migrations.malformed.length) {
      L.push('### Migration problems', ...r.migrations.modified.map((p) => `- modified after apply: \`${p}\``),
        ...r.migrations.duplicates.map((d) => `- duplicate V${d.version}: ${d.files.map((f) => `\`${basename(f)}\``).join(', ')}`),
        ...r.migrations.outOfOrder.map((p) => `- below current head: \`${basename(p)}\``),
        ...r.migrations.malformed.map((p) => `- malformed name: \`${basename(p)}\``), '');
    }
    if (r.deployOrder?.length) L.push('### Cross-repo deploy order', ...r.deployOrder.map((d) => `- [ ] ${d.title} — merge and release it together with or before this`), '');
    if (r.dependencyChanges.length) {
      L.push('### Dependencies', ...r.dependencyChanges.map((d) => `- ${d.change} \`${d.name}\` ${d.from ? `${d.from} → ` : ''}${d.to ?? ''}${d.bump === 'major' ? ' **(major)**' : ''}`), '');
    }
    const s = r.surface;
    if (s.endpoints.added.length || s.endpoints.removed.length || s.topics.added.length || s.topics.removed.length) {
      L.push('### API & Kafka surface',
        ...s.endpoints.added.map((e) => `- ➕ endpoint \`${e}\``), ...s.endpoints.removed.map((e) => `- ➖ endpoint \`${e}\` — check callers`),
        ...s.topics.added.map((t) => `- ➕ topic \`${t}\``), ...s.topics.removed.map((t) => `- ➖ topic \`${t}\` — check consumers`), '');
    }
    if (r.prs.length) L.push('### Pull requests', ...r.prs.map((p) => `- !${p.id} ${p.title}`), '');
    if (r.review) L.push(`Deep review: ${r.review}`, '');
  }
  return L.join('\n');
}

function toHtml(md) {
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/_(.+?)_/g, '<i>$1</i>');
  const html = md.split('\n').map((l) => {
    if (l.startsWith('# ')) return `<h1>${inline(l.slice(2))}</h1>`;
    if (l.startsWith('## ')) return `<h2>${inline(l.slice(3))}</h2>`;
    if (l.startsWith('### ')) return `<h3>${inline(l.slice(4))}</h3>`;
    const cb = l.match(/^(\s*)- \[ \] (.*)$/);
    if (cb) return `<label class="cb" style="margin-left:${cb[1].length * 10}px"><input type="checkbox"> ${inline(cb[2])}</label>`;
    if (l.startsWith('- ')) return `<div class="li">${inline(l.slice(2))}</div>`;
    return l.trim() ? `<p>${inline(l)}</p>` : '';
  }).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Release readiness</title>
<style>:root{--bg:#fcfcfb;--text:#0b0b0b;--muted:#52514e;--line:#e6e5e0;--code:#f1f0ec}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#121211;--text:#f0efec;--muted:#c3c2b7;--line:#2e2d2a;--code:#232321}}
:root[data-theme="dark"]{--bg:#121211;--text:#f0efec;--muted:#c3c2b7;--line:#2e2d2a;--code:#232321}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:900px;margin:0 auto;padding:28px 16px 64px}h1{font-size:22px}h2{font-size:18px;margin-top:32px;padding-top:16px;border-top:1px solid var(--line)}h3{font-size:15px;color:var(--muted)}
code{font:13px ui-monospace,Menlo,monospace;background:var(--code);padding:1px 5px;border-radius:4px;word-break:break-all}
.cb{display:block;margin:4px 0}.li{margin:3px 0 3px 4px}.li::before{content:"• ";color:var(--muted)}</style></head><body><main>${html}</main></body></html>`;
}
