#!/usr/bin/env node
// Weekly learning loop: every Boards Bug closed recently becomes a history eval case (via
// learn-from-fix.mjs), and — with --run — we learn whether the reviewer would have caught it.
//
//   node evals/auto-learn.mjs [--estate <dir>] [--days 7] [--bug <id> ...] [--run] [--max 10] [--out-dir <evals dir>]
//
// Bugs: closed in the last --days in the sfn repos' Azure DevOps project (or --bug ids). For each, the
// repo is the one whose develop has a commit linked to / mentioning it. Existing cases are skipped.
// Writes <out-dir>/results/auto-learn-<date>.md (and .json). Never commits or pushes: new cases are
// files to review and commit (the CI job publishes them as an artifact).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { authHeaders, createAdo, parseRemote } from '../scripts/lib/ado-api.mjs';
import { loadConfig } from '../scripts/lib/paths.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({
  options: {
    estate: { type: 'string' }, days: { type: 'string', default: '7' }, bug: { type: 'string', multiple: true, default: [] },
    run: { type: 'boolean', default: false }, max: { type: 'string', default: '10' }, 'out-dir': { type: 'string' },
  },
});
const log = (m) => console.error(`[auto-learn] ${m}`);
const cfg = loadConfig();
const estate = resolve(args.estate ?? join(root, '..'));
const evalsDir = resolve(args['out-dir'] ?? join(root, 'evals'));
const repos = Object.keys(cfg.repos.repos).map((k) => ({ key: k, dir: join(estate, k) })).filter((r) => existsSync(join(r.dir, '.git')));
if (!repos.length) { log(`no sfn repos found under ${estate}`); process.exit(2); }
const git = (dir, ...a) => { try { return execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim(); } catch { return ''; } };

// 1. which bugs ------------------------------------------------------------------------------------
let bugs = args.bug.map((id) => ({ id: Number(id), title: '' }));
if (!bugs.length) {
  const remote = parseRemote(git(repos[0].dir, 'remote', 'get-url', 'origin'));
  if (!remote) { log('origin is not an Azure Repos URL — pass --bug ids'); process.exit(2); }
  const ado = createAdo({ ...remote, headers: authHeaders() });
  const project = remote.project.replace(/'/g, "''");
  const q = (dateField) => `SELECT [System.Id], [System.Title] FROM WorkItems WHERE [System.TeamProject] = '${project}' AND [System.WorkItemType] = 'Bug' AND [System.State] IN ('Closed', 'Done', 'Resolved') AND [${dateField}] >= @Today - ${Number(args.days)} ORDER BY [${dateField}] DESC`;
  let res;
  try { res = await ado.wiql(q('Microsoft.VSTS.Common.ClosedDate')); } catch { res = await ado.wiql(q('System.ChangedDate')); }
  const ids = (res.workItems ?? []).map((w) => w.id).slice(0, 200);
  if (ids.length) {
    const items = await ado.call('GET', `wit/workitems?ids=${ids.join(',')}&fields=System.Id,System.Title`);
    bugs = (items.value ?? []).map((w) => ({ id: w.id, title: w.fields['System.Title'] }));
  }
}
bugs = bugs.slice(0, Number(args.max));
log(`${bugs.length} bug(s) to learn from (last ${args.days} days)`);

// 2. learn each ---------------------------------------------------------------------------------------
const rows = [];
for (const b of bugs) {
  const pattern = `(^|[^0-9A-Za-z])(WI|BUG|US|AB#)[- #]?${b.id}([^0-9]|$)`;
  // every repo whose develop mentions the bug, in order; the first where learning succeeds wins
  const candidates = repos.filter((r) => git(r.dir, 'log', 'origin/develop', '--no-merges', '-E', '-i', `--grep=${pattern}`, '--format=%H', '-n', '1')
    || git(r.dir, 'log', 'HEAD', '--no-merges', '-E', '-i', `--grep=${pattern}`, '--format=%H', '-n', '1'));
  const row = { bug: b.id, title: b.title, repo: candidates[0]?.key ?? null, status: '', detail: '' };
  rows.push(row);
  if (!candidates.length) { row.status = 'skipped'; row.detail = 'no commit on develop links to or mentions it'; continue; }
  const existing = candidates.map((r) => `history-${r.key.replace(/^sfn-/, '')}-bug${b.id}`).find((n) => existsSync(join(evalsDir, 'cases', n, 'case.json')));
  if (existing) { row.status = 'exists'; row.case = existing; continue; }
  let learned;
  const reasons = [];
  for (const repo of candidates) {
    const name = `history-${repo.key.replace(/^sfn-/, '')}-bug${b.id}`;
    const develop = git(repo.dir, 'rev-parse', '--verify', '--quiet', 'origin/develop') ? 'origin/develop' : 'HEAD';
    const r = spawnSync('node', [join(root, 'evals/learn-from-fix.mjs'), '--repo', repo.dir, '--bug', String(b.id), '--name', name,
      '--develop', develop, '--estate', estate, '--out-dir', evalsDir], { encoding: 'utf8' });
    const learnLog = `${r.stdout}${r.stderr}`;
    if (r.status === 0) { learned = { repo, name, learnLog }; break; }
    reasons.push(`${repo.key}: ${(learnLog.trim().split('\n').pop() ?? '').replace(/^\[learn\]\s*/, '')}`);
  }
  if (!learned) { row.status = 'skipped'; row.detail = reasons.join(' · '); continue; }
  const { name, learnLog } = learned;
  row.repo = learned.repo.key;
  row.case = name;
  row.status = 'case created';
  row.detail = (learnLog.match(/review (PR !\d+|\w{10}) .*$/m) ?? [''])[0];
  if (args.run) {
    const e = spawnSync('bash', [join(root, 'evals/run-evals.sh'), '--case', name], { encoding: 'utf8', env: { ...process.env } });
    const line = `${e.stdout}${e.stderr}`.split('\n').find((l) => /^(PASS|FAIL|GAP)\s/.test(l)) ?? '';
    row.status = line.startsWith('PASS') ? 'caught' : line.startsWith('FAIL') ? 'MISSED' : 'run failed';
  }
}

// 3. report ------------------------------------------------------------------------------------------------
const date = new Date().toISOString().slice(0, 10);
const count = (s) => rows.filter((r) => r.status === s).length;
const md = [
  `# Auto-learn — ${date}`, '',
  `Bugs closed in the last ${args.days} days: ${rows.length} · new cases ${count('case created') + count('caught') + count('MISSED')} · caught ${count('caught')} · **missed ${count('MISSED')}** · skipped ${count('skipped')} · already learned ${count('exists')}`, '',
  '| Bug | Repo | Result | Detail |', '|---|---|---|---|',
  ...rows.map((r) => `| #${r.bug} ${(r.title ?? '').slice(0, 60)} | ${r.repo ?? '–'} | ${r.status} | ${r.case ? `\`${r.case}\` ` : ''}${r.detail ?? ''} |`),
  '',
  count('MISSED') ? 'For each MISSED case: read `evals/drafts/<case>.md`, sharpen or add a rule, re-run the case, and commit the case either way. If the miss is beyond a diff review (e.g. a change that should have been made elsewhere), add `"knownGap": "<why>"` to its case.json.' : '',
  'New cases are files under `evals/cases/` and `evals/drafts/` — review and commit them.',
].join('\n');
mkdirSync(join(evalsDir, 'results'), { recursive: true });
writeFileSync(join(evalsDir, 'results', `auto-learn-${date}.md`), md);
writeFileSync(join(evalsDir, 'results', `auto-learn-${date}.json`), JSON.stringify({ date, days: Number(args.days), rows }, null, 2));
console.log(md);
