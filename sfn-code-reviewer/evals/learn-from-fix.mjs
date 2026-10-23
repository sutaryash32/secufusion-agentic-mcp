#!/usr/bin/env node
// Learn from a bug the reviewer missed: turn its fix into a permanent eval case.
//
//   node evals/learn-from-fix.mjs --repo ../sfn-tenants-api (--fix <sha> | --bug <workItemId>)
//        [--pr <id>] [--name <case-name>] [--estate <dir>] [--run]
//
// --pr <id>: you know which PR introduced it — review that PR instead of the one history suggests.
//
// 1. Finds the fix commit(s): --fix, or every commit linked to Boards item --bug (work item relations,
//    then commit messages "WI <id>" / "BUG-<id>" / "AB#<id>").
// 2. git blame on the fix's parent tells which commit WROTE the lines the fix changed — the commit that
//    introduced the bug — and the PR merge that brought it into develop.
// 3. Writes evals/cases/<name>/case.json, a HISTORY case: review that PR as it was, expect a
//    major-or-worse finding near those lines. Plus evals/drafts/<name>.md: the fix, the candidate
//    rule area, and a rule-row template to fill in if the reviewer keeps missing it.
// 4. --run: runs the new case right away (caught or missed).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { authHeaders, createAdo, parseRemote } from '../scripts/lib/ado-api.mjs';
import { parseBlamePorcelain, parseOldRanges } from '../scripts/lib/history.mjs';
import { loadConfig } from '../scripts/lib/paths.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({
  options: {
    repo: { type: 'string' }, fix: { type: 'string', multiple: true, default: [] }, bug: { type: 'string' },
    name: { type: 'string' }, estate: { type: 'string' }, run: { type: 'boolean', default: false },
    develop: { type: 'string', default: 'origin/develop' },
    'out-dir': { type: 'string' },
    pr: { type: 'string' },
  },
});
const log = (m) => console.error(`[learn] ${m}`);
const fail = (m) => { log(m); process.exit(2); };
if (!args.repo || (!args.fix.length && !args.bug)) fail('usage: learn-from-fix.mjs --repo <path> (--fix <sha> | --bug <id>) [--name] [--run]');

const repo = resolve(args.repo);
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).trim();
const tryGit = (...a) => { try { return git(...a); } catch { return ''; } };
const repoKey = basename(repo);
const CODE = /\.(java|kt|sql|js|jsx|ts|tsx|properties|ya?ml)$/;
const NOT_PROD = /(^|\/)(src\/test\/|__tests__\/|docs?\/|specs?\/)|\.md$/;
const develop = tryGit('rev-parse', '--verify', '--quiet', args.develop) ? args.develop : 'HEAD';

// 1. fix commits ------------------------------------------------------------------------------
let fixes = args.fix.map((f) => git('rev-parse', f));
if (args.bug) {
  try {
    const remote = parseRemote(git('remote', 'get-url', 'origin'));
    if (remote) {
      const wi = await createAdo({ ...remote, headers: authHeaders() }).call('GET', `wit/workitems/${args.bug}?$expand=relations`);
      for (const r of wi.relations ?? []) {
        const m = decodeURIComponent(r.url ?? '').match(/vstfs:\/\/\/Git\/Commit\/[^/]+\/([^/]+)\/([0-9a-f]{40})$/i);
        if (m && tryGit('rev-parse', '--verify', '--quiet', `${m[2]}^{commit}`)) fixes.push(m[2]);
      }
    }
  } catch (e) { log(`work item lookup skipped: ${e.message.split('\n')[0]}`); }
  // Linked commits are often feature-branch commits; only commits that reached develop are usable.
  const onDevelop = (sha) => spawnSync('git', ['-C', repo, 'merge-base', '--is-ancestor', sha, develop]).status === 0;
  const linked = fixes.length;
  fixes = fixes.filter(onDevelop);
  if (linked && !fixes.length) log(`${linked} linked commit(s) are not on ${develop} (feature-branch commits) — using commit messages instead`);
  if (!fixes.length) {
    fixes = tryGit('log', develop, '--no-merges', '-E', '-i', `--grep=(^|[^0-9A-Za-z])(WI|BUG|US|AB#)[- #]?${args.bug}([^0-9]|$)`, '--format=%H').split('\n').filter(Boolean);
  }
  if (!fixes.length) fail(`no commits found for work item ${args.bug} (no linked commits, no "WI ${args.bug}" in messages)`);
}
fixes = [...new Set(fixes)];
log(`fix commit(s): ${fixes.map((f) => f.slice(0, 10)).join(', ')}`);

// 2. which change last touched the code the fix changed? -------------------------------------------
// `git log -L` on each fixed region (±3 lines) finds the most recent commit that modified it before the
// fix — unlike blame, this also catches bugs that DELETED a line (a removed guard or delete call).
const fixSet = new Set(fixes);
const regions = []; // {file, a, b, fix}
for (const f of fixes) {
  const files = tryGit('diff', '--no-renames', '--name-only', `${f}^`, f).split('\n').filter((p) => p && CODE.test(p) && !NOT_PROD.test(p));
  if (!files.length) continue;
  const ranges = parseOldRanges(tryGit('diff', '--no-renames', '-U0', `${f}^`, f, '--', ...files));
  for (const [file, rs] of Object.entries(ranges)) for (const [a, b] of rs.slice(0, 20)) regions.push({ file, a, b, fix: f });
  // pure insertions (a guard the fix ADDS) have no old range: anchor on the insertion point
  for (const h of insertionPoints(f, files)) regions.push({ ...h, fix: f });
}
function insertionPoints(f, files) {
  const out = [];
  let file;
  for (const l of tryGit('diff', '--no-renames', '-U0', `${f}^`, f, '--', ...files).split('\n')) {
    const fm = l.match(/^--- a\/(.+)$/);
    if (fm) { file = fm[1]; continue; }
    const m = l.match(/^@@ -(\d+),0 /);
    if (m && file) out.push({ file, a: Math.max(1, Number(m[1])), b: Math.max(1, Number(m[1])) });
  }
  return out;
}
if (!regions.length) fail('the fix changes no production code (only tests/docs?) — pass --fix for the code fix.');

const votes = new Map();
const touched = []; // {sha, file, a, b}
for (const r of regions) {
  const len = Number(tryGit('show', `${r.fix}^:${r.file}`).split('\n').length) || r.b;
  const a = Math.max(1, r.a - 3);
  const b = Math.min(len, r.b + 3);
  const shas = tryGit('log', '-L', `${a},${b}:${r.file}`, '--format=%H', '--no-patch', '-n', '5', `${r.fix}^`)
    .split('\n').filter((x) => /^[0-9a-f]{40}$/.test(x) && !fixSet.has(x));
  if (!shas.length) continue;
  votes.set(shas[0], (votes.get(shas[0]) ?? 0) + 1);
  touched.push({ sha: shas[0], file: r.file, a: r.a, b: r.b, fix: r.fix });
}
if (!votes.size) fail('no earlier commit touched the fixed code (new file?) — nothing to learn from.');
const introducedBy = [...votes.entries()].sort((x, y) => y[1] - x[1])[0][0];
const own = touched.filter((t) => t.sha === introducedBy);
log(`introduced by ${introducedBy.slice(0, 10)} "${git('show', '-s', '--format=%s', introducedBy)}" (${own.length} of ${touched.length} fixed region(s))`);

// the change to review: the first-parent commit on develop that brought `introducedBy` in
// Binary search develop's first-parent line (newest → oldest) for the oldest commit that contains it.
function mergeThatBrought(sha) {
  const line = tryGit('rev-list', '--first-parent', develop).split('\n').filter(Boolean);
  const contains = (i) => spawnSync('git', ['-C', repo, 'merge-base', '--is-ancestor', sha, line[i]]).status === 0;
  if (!line.length || !contains(0)) return undefined;
  let lo = 0;                 // contains
  let hi = line.length - 1;   // find the largest index that still contains
  if (contains(hi)) return line[hi];
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (contains(mid)) lo = mid; else hi = mid;
  }
  return line[lo];
}
let head = mergeThatBrought(introducedBy);
if (args.pr) {
  head = tryGit('log', develop, '--first-parent', '-E', `--grep=^Merged PR ${args.pr}:`, '--format=%H', '-n', '1');
  if (!head) fail(`no "Merged PR ${args.pr}:" commit on ${develop}`);
  log(`--pr ${args.pr}: reviewing that PR instead (history suggested ${introducedBy.slice(0, 10)})`);
}
if (!head) fail(`${introducedBy.slice(0, 10)} is not on ${develop} — fetch, or pass --develop`);
if (!tryGit('rev-parse', '--verify', '--quiet', `${head}^1`)) fail(`${head.slice(0, 10)} has no parent (initial commit) — nothing to review`);
const base = git('rev-parse', `${head}^1`);
const headSubject = git('show', '-s', '--format=%s', head);
const pr = headSubject.match(/^Merged PR (\d+):/)?.[1];

// expected location in the reviewed (head) version: lines near the fixed regions that the reviewed change
// wrote (blame at the fix's parent → commits of head^1..head → their line number in head); otherwise
// the fixed region itself when the file didn't change between head and the fix.
const changeCommits = new Set(tryGit('rev-list', `${base}..${head}`).split('\n').filter(Boolean));
const expect = [];
for (const file of [...new Set(touched.map((t) => t.file))]) {
  const mine = touched.filter((t) => t.file === file);
  const fixParent = `${mine[0].fix}^`;
  const near = (l) => mine.some((t) => l >= t.a - 3 && l <= t.b + 3);
  const atHead = parseBlamePorcelain(tryGit('blame', '--porcelain', '-w', fixParent, '--', file)).lines
    .filter((l) => near(l.line) && changeCommits.has(l.sha))
    .map((l) => l.origLine); // line in the PR commit that wrote it ≈ line in head
  let lines = atHead;
  if (!lines.length && spawnOk('diff', '--quiet', head, fixParent, '--', file)) lines = mine.flatMap((t) => [t.a, t.b]);
  // tight clusters (gap > 20 lines starts a new one) so "near" stays meaningful in big files
  const sorted = [...new Set(lines)].sort((x, y) => x - y);
  let group = [];
  for (const l of sorted) {
    if (group.length && l - group.at(-1) > 20) { expect.push({ file, nearLines: [group[0], group.at(-1)], minSeverity: 'major' }); group = []; }
    group.push(l);
  }
  if (group.length) expect.push({ file, nearLines: [group[0], group.at(-1)], minSeverity: 'major' });
}
if (!expect.length) fail('the reviewed change did not write any of the fixed code — wrong PR? (try --pr)');
function spawnOk(...a) { return spawnSync('git', ['-C', repo, ...a]).status === 0; }

// 3. write the case + rule draft ---------------------------------------------------------------
const tag = args.bug ? `bug${args.bug}` : fixes[0].slice(0, 8);
const name = args.name ?? `history-${repoKey.replace(/^sfn-/, '')}-${tag}`;
const evalsDir = resolve(args['out-dir'] ?? join(root, 'evals'));
const caseDir = join(evalsDir, 'cases', name);
if (existsSync(join(caseDir, 'case.json'))) fail(`evals/cases/${name} exists — pass --name`);
mkdirSync(caseDir, { recursive: true });
const fixSubjects = fixes.map((f) => git('show', '-s', '--format=%s', f));
const kase = {
  type: 'history',
  repoKey,
  estate: resolve(args.estate ?? dirname(repo)),
  base,
  head,
  description: `Missed bug${args.bug ? ` #${args.bug}` : ''}: introduced by ${pr ? `PR !${pr}` : `commit ${head.slice(0, 10)}`} ("${headSubject}"), later fixed by ${fixes.map((f, i) => `${f.slice(0, 10)} "${fixSubjects[i]}"`).join(', ')}. The reviewer should flag the code the fix changed, at major or worse.`,
  source: { fixes, fixSubjects, introducedBy, pr: pr ? Number(pr) : null, bug: args.bug ? Number(args.bug) : null },
  expect: { mustFind: [{ anyOf: expect }], verdictIn: ['fix_first', 'needs_discussion'] },
};
writeFileSync(join(caseDir, 'case.json'), JSON.stringify(kase, null, 2) + '\n');

const cfg = loadConfig();
const areas = [...new Set(cfg.repos.riskRules.filter((r) => expect.some((e) => new RegExp(r.match).test(e.file))).flatMap((r) => r.specialists))];
const fixDiff = fixes.map((f) => tryGit('show', '--stat', '--patch', '-U3', f, '--', ...expect.map((e) => e.file))).join('\n').split('\n').slice(0, 160).join('\n');
mkdirSync(join(evalsDir, 'drafts'), { recursive: true });
writeFileSync(join(evalsDir, 'drafts', `${name}.md`), `# Learned from: ${fixSubjects[0]}

- Case: \`evals/cases/${name}\` — run \`evals/run-evals.sh --case ${name}\`
- Introduced by: ${pr ? `PR !${pr} — ` : ''}${headSubject} (\`${head.slice(0, 10)}\`)
- Fixed by: ${fixes.map((f, i) => `\`${f.slice(0, 10)}\` ${fixSubjects[i]}`).join('; ')}
- Expected finding near: ${expect.map((e) => `\`${e.file}:${e.nearLines.join('-')}\``).join(', ')}
- Specialists that own these files: ${areas.join(', ') || 'general'}

## If the reviewer misses this case

1. Read the fix below and name the **failure** it prevented, in one sentence.
2. If a rule already covers it, sharpen that rule's text in \`rules/shared/<area>.md\` (or raise its
   severity / add a floor in \`config/review.config.yml\`). Otherwise add a row:

   \`| XXX-NNN | major | <what is wrong> — <how it fails in production> |\`

3. If the file path didn't trigger the right specialist, add a \`riskRules\` entry in \`config/repos.yml\`.
4. \`npm run build\`, re-run the case, and keep the case in \`evals/cases\` forever.

## The fix

\`\`\`diff
${fixDiff}
\`\`\`
`);
log(`wrote evals/cases/${name}/case.json and evals/drafts/${name}.md`);
log(`  review ${pr ? `PR !${pr}` : head.slice(0, 10)} (${base.slice(0, 8)}..${head.slice(0, 8)}); expect a major+ finding near any of ${expect.length} region(s): ${expect.slice(0, 6).map((e) => `${e.file.split('/').pop()}:${e.nearLines.join('-')}`).join(', ')}${expect.length > 6 ? ', …' : ''}`);

if (args.run) {
  const r = spawnSync('bash', [join(root, 'evals/run-evals.sh'), '--case', name], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
