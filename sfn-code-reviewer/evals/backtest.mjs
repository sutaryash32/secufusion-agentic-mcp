#!/usr/bin/env node
// Backtest on real history: would the reviewer have flagged PRs that later needed a fix, and does it
// stay quiet on PRs that didn't?
//
//   node evals/backtest.mjs select --estate ~/IdeaProjects/secufusion [--days 180] [--pos 10] [--neg 6]
//   node evals/backtest.mjs run    --plan <plan.json> [--engine anthropic] [--level auto] [--only <pr>]
//   node evals/backtest.mjs score  --plan <plan.json>
//
// select: finds merged PRs ("Merged PR <n>: …") on origin/develop; a PR is a POSITIVE when a later
//         fix-like commit (integrations.history.fixPattern) rewrites lines that git blame attributes to
//         the PR's commits. NEGATIVES are code PRs no later fix touched (as far as git can tell).
// run:    reviews each PR exactly as it was at merge time — a detached worktree at the PR commit, sibling
//         repos as worktrees at the same date — then removes the worktrees. Your checkouts are untouched.
// score:  positives: did a finding land on a file (and near the lines) the later fix changed?
//         negatives: blocker/major findings, written to labels.md for a human to mark real / noise.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseBlamePorcelain, parseOldRanges } from '../scripts/lib/history.mjs';
import { loadConfig } from '../scripts/lib/paths.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [cmd] = process.argv.slice(2);
const { values: args } = parseArgs({
  args: process.argv.slice(3),
  options: {
    estate: { type: 'string' },
    days: { type: 'string', default: '180' },
    pos: { type: 'string', default: '10' },
    neg: { type: 'string', default: '6' },
    plan: { type: 'string' },
    out: { type: 'string' },
    engine: { type: 'string' },
    level: { type: 'string', default: 'auto' },
    only: { type: 'string' },
    consensus: { type: 'string' },
    tag: { type: 'string', default: '' },
    'fix-window-days': { type: 'string', default: '60' },
    'max-lines': { type: 'string', default: '2500' },
  },
});
const log = (m) => console.error(`[backtest] ${m}`);
const git = (repo, ...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).trim();
const tryGit = (repo, ...a) => { try { return git(repo, ...a); } catch { return ''; } };
const cfg = loadConfig();
const CODE = /\.(java|kt|sql|js|jsx|ts|tsx|properties|ya?ml)$/;
const NOISE_PATH = /(^|\/)(docs?|specs?|plans?)\/|\.md$|package-lock\.json$/;

if (cmd === 'select') select();
else if (cmd === 'run') run();
else if (cmd === 'score') score();
else { console.error('usage: backtest.mjs select|run|score …'); process.exit(64); }

// ---------------------------------------------------------------------------
function select() {
  const estate = resolve(args.estate ?? join(root, '..'));
  const fixRe = new RegExp(cfg.review.integrations.history.fixPattern, 'i');
  const since = `${args.days}.days`;
  const prs = [];
  for (const key of Object.keys(cfg.repos.repos)) {
    const repo = join(estate, key);
    if (!existsSync(join(repo, '.git'))) { log(`${key}: not found, skipped`); continue; }
    const ref = tryGit(repo, 'rev-parse', '--verify', '--quiet', 'origin/develop') ? 'origin/develop' : 'HEAD';

    // Fix commits in the window: for each, which commits wrote the lines it rewrites?
    const fixes = git(repo, 'log', ref, `--since=${Number(args.days) + Number(args['fix-window-days'])}.days`, '--no-merges', '--format=%H%x09%cI%x09%s')
      .split('\n').filter(Boolean).map((l) => { const [sha, date, subject] = l.split('\t'); return { sha, date, subject }; })
      .filter((f) => fixRe.test(f.subject));
    const blamedBy = new Map(); // pr-commit sha -> [{fix, file, oldLines}]
    for (const f of fixes) {
      const files = tryGit(repo, 'diff', '--no-renames', '--name-only', `${f.sha}^`, f.sha).split('\n').filter((p) => p && CODE.test(p) && !NOISE_PATH.test(p));
      if (!files.length || files.length > 30) continue;
      const ranges = parseOldRanges(tryGit(repo, 'diff', '--no-renames', '-U0', `${f.sha}^`, f.sha, '--', ...files));
      for (const [file, rs] of Object.entries(ranges)) {
        const blame = parseBlamePorcelain(tryGit(repo, 'blame', '--porcelain', '-w', ...rs.slice(0, 20).flatMap(([a, b]) => ['-L', `${a},${b}`]), `${f.sha}^`, '--', file));
        const lines = new Map();
        for (const { sha, line } of blame.lines) lines.set(sha, [...(lines.get(sha) ?? []), line]);
        for (const [sha, ls] of lines) {
          blamedBy.set(sha, [...(blamedBy.get(sha) ?? []), { fix: f.sha.slice(0, 10), fixDate: f.date.slice(0, 10), fixSubject: f.subject, file, fixedLines: ls }]);
        }
      }
    }

    for (const l of git(repo, 'log', ref, '--first-parent', `--since=${since}`, '--format=%H%x09%P%x09%cI%x09%s').split('\n').filter(Boolean)) {
      const [sha, parents, date, subject] = l.split('\t');
      const m = subject.match(/^Merged PR (\d+): (.+)$/);
      if (!m) continue;
      const [p1, p2] = parents.split(' ');
      const commits = p2 ? tryGit(repo, 'rev-list', `${p1}..${p2}`).split('\n').filter(Boolean) : [sha];
      const stat = tryGit(repo, 'diff', '--no-renames', '--numstat', p1, sha).split('\n').filter(Boolean)
        .map((x) => { const [a, r, p] = x.split('\t'); return { p, n: (Number(a) || 0) + (Number(r) || 0) }; });
      const code = stat.filter((s) => CODE.test(s.p) && !NOISE_PATH.test(s.p));
      const lines = code.reduce((n, s) => n + s.n, 0);
      if (!code.length || lines > Number(args['max-lines'])) continue;
      const laterFixes = commits.flatMap((c) => blamedBy.get(c) ?? [])
        .filter((x) => !commits.some((c) => c.startsWith(x.fix)) && x.fixDate > date.slice(0, 10));
      prs.push({ repo: key, pr: Number(m[1]), title: m[2], mergeCommit: sha, base: p1, date: date.slice(0, 10), codeLines: lines, codeFiles: code.length, laterFixes });
    }
  }

  // Positives: most distinct later fixes first, spread across repos. Negatives: similar size, no later fix.
  const spread = (list, n) => {
    const byRepo = new Map();
    for (const p of list) byRepo.set(p.repo, [...(byRepo.get(p.repo) ?? []), p]);
    const out = [];
    while (out.length < n && [...byRepo.values()].some((l) => l.length)) for (const l of byRepo.values()) if (l.length && out.length < n) out.push(l.shift());
    return out;
  };
  const positives = spread(prs.filter((p) => p.laterFixes.length).sort((a, b) => new Set(b.laterFixes.map((f) => f.fix)).size - new Set(a.laterFixes.map((f) => f.fix)).size), Number(args.pos));
  // Negatives must have had time to need a fix (older than the fix window) and be typical-sized.
  const cutoff = new Date(Date.now() - Number(args['fix-window-days']) * 86400000).toISOString().slice(0, 10);
  const negatives = spread(prs.filter((p) => !p.laterFixes.length && p.date <= cutoff && p.codeLines >= 60 && p.codeLines <= 900)
    .sort((a, b) => Math.abs(a.codeLines - 300) - Math.abs(b.codeLines - 300)), Number(args.neg));

  const out = resolve(args.out ?? join(root, 'evals/results', `backtest-${new Date().toISOString().slice(0, 10)}`));
  mkdirSync(out, { recursive: true });
  const plan = { createdAt: new Date().toISOString(), estate, days: Number(args.days), out, candidates: prs.length, positives, negatives };
  writeFileSync(join(out, 'plan.json'), JSON.stringify(plan, null, 2));
  log(`${prs.length} code PRs; ${prs.filter((p) => p.laterFixes.length).length} later needed a fix → plan: ${positives.length} positives, ${negatives.length} negatives`);
  for (const p of positives) log(`  + ${p.repo} !${p.pr} ${p.title.slice(0, 60)} — fixed by ${[...new Set(p.laterFixes.map((f) => `${f.fix} ${f.fixSubject.slice(0, 50)}`))].slice(0, 2).join(' | ')}`);
  for (const p of negatives) log(`  - ${p.repo} !${p.pr} ${p.title.slice(0, 60)} (${p.codeLines} lines)`);
  console.log(join(out, 'plan.json'));
}

// ---------------------------------------------------------------------------
function run() {
  const plan = JSON.parse(readFileSync(args.plan, 'utf8'));
  const all = [...plan.positives.map((p) => ({ ...p, kind: 'positive' })), ...plan.negatives.map((p) => ({ ...p, kind: 'negative' }))]
    .filter((p) => !args.only || String(p.pr) === args.only);
  for (const p of all) {
    const dir = join(plan.out, `${p.repo}-${p.pr}${args.tag ? `-${args.tag}` : ''}`);
    if (existsSync(join(dir, 'out', 'review-result.json'))) { log(`!${p.pr} already reviewed, skipping`); continue; }
    rmSync(join(dir, 'estate'), { recursive: true, force: true });
    mkdirSync(join(dir, 'estate'), { recursive: true });
    const added = [];
    try {
      // The PR repo at the merge commit; siblings at the same date.
      for (const key of Object.keys(plan.estate ? cfg.repos.repos : {})) {
        const src = join(plan.estate, key);
        if (!existsSync(join(src, '.git'))) continue;
        const at = key === p.repo ? p.mergeCommit : tryGit(src, 'rev-list', '-1', `--before=${p.date}T23:59:59`, 'origin/develop') || tryGit(src, 'rev-parse', 'origin/develop');
        const wt = join(dir, 'estate', key);
        git(src, 'worktree', 'add', '--detach', '--quiet', wt, at);
        added.push([src, wt]);
      }
      log(`reviewing ${p.repo} !${p.pr} (${p.kind}) …`);
      const res = spawnSync('bash', [join(root, 'scripts/run-review.sh'), '--repo', join(dir, 'estate', p.repo), '--repo-key', p.repo,
        '--base', p.base, '--head', p.mergeCommit, '--estate-root', join(dir, 'estate'), '--out', join(dir, 'out'), '--level', args.level,
        ...(args.engine ? ['--engine', args.engine] : []), ...(args.consensus ? ['--consensus', args.consensus] : [])], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
      writeFileSync(join(dir, 'run.log'), res.stderr ?? '');
      log(`  → ${res.status === 0 ? 'ok' : `failed (exit ${res.status}) — see ${join(dir, 'run.log')}`}`);
    } finally {
      for (const [src, wt] of added.reverse()) tryGit(src, 'worktree', 'remove', '--force', wt);
      rmSync(join(dir, 'estate'), { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
function score() {
  const plan = JSON.parse(readFileSync(args.plan, 'utf8'));
  const rows = [];
  const labels = ['# Backtest — label each finding', '', 'Mark each blocker/major: `[x] real` / `[x] noise` / `[x] unsure`. This is the precision ground truth.', ''];
  const NEAR = 25;
  const sev = { blocker: 4, major: 3, minor: 2, nit: 1 };
  for (const kind of ['positives', 'negatives']) {
    for (const p of plan[kind]) {
      const file = join(plan.out, `${p.repo}-${p.pr}`, 'out', 'review-result.json');
      if (!existsSync(file)) { rows.push({ ...p, kind, status: 'not run' }); continue; }
      const r = JSON.parse(readFileSync(file, 'utf8'));
      const own = r.findings.filter((f) => !f.repo || f.repo === p.repo);
      let hit = 'n/a';
      if (kind === 'positives') {
        const fixedFiles = new Set(p.laterFixes.map((f) => f.file));
        const near = own.filter((f) => p.laterFixes.some((x) => x.file === f.file && x.fixedLines.some((l) => Math.abs(l - f.line) <= NEAR)));
        const sameFile = own.filter((f) => fixedFiles.has(f.file));
        hit = near.some((f) => sev[f.severity] >= 3) ? 'caught' : near.length ? 'noticed (minor)' : sameFile.length ? 'same file' : 'missed';
      }
      const strong = r.findings.filter((f) => sev[f.severity] >= 3);
      rows.push({ ...p, kind, status: 'reviewed', verdict: r.verdict, findings: r.findings.length, strong: strong.length, hit, cost: readCost(join(plan.out, `${p.repo}-${p.pr}`, 'out')) });
      if (strong.length) {
        labels.push(`## ${p.repo} !${p.pr} — ${p.title} (${kind.slice(0, -1)})`, '');
        if (kind === 'positives') labels.push(`Later fixed by: ${[...new Set(p.laterFixes.map((f) => `\`${f.fix}\` ${f.fixSubject} (${f.file})`))].join('; ')}`, '');
        for (const f of strong) labels.push(`- ${f.severity} ${f.confidence} \`${f.ruleId}\` **${f.title}** — \`${f.file}:${f.line}\``, `  - ${f.failureScenario}`, '  - [ ] real  [ ] noise  [ ] unsure', '');
      }
    }
  }
  const pos = rows.filter((r) => r.kind === 'positives' && r.status === 'reviewed');
  const neg = rows.filter((r) => r.kind === 'negatives' && r.status === 'reviewed');
  const summary = {
    positives: pos.length,
    caught: pos.filter((r) => r.hit === 'caught').length,
    noticed: pos.filter((r) => r.hit === 'noticed (minor)').length,
    sameFile: pos.filter((r) => r.hit === 'same file').length,
    missed: pos.filter((r) => r.hit === 'missed').length,
    negatives: neg.length,
    negativesWithStrongFindings: neg.filter((r) => r.strong > 0).length,
    strongFindingsOnNegatives: neg.reduce((n, r) => n + r.strong, 0),
    totalCostUsd: +rows.reduce((n, r) => n + (r.cost ?? 0), 0).toFixed(2),
  };
  const md = ['# Backtest results', '', `Plan: ${plan.positives.length} PRs that later needed a fix, ${plan.negatives.length} that did not (merged in the last ${plan.days} days).`, '',
    `**Later-fixed PRs:** caught ${summary.caught}/${summary.positives} · noticed as minor ${summary.noticed} · same file only ${summary.sameFile} · missed ${summary.missed}`,
    `**Clean PRs:** ${summary.negativesWithStrongFindings}/${summary.negatives} had blocker/major findings (${summary.strongFindingsOnNegatives} total) — label them in labels.md`,
    `**Cost:** $${summary.totalCostUsd}`, '',
    '| Repo | PR | Kind | Result | Verdict | Findings (blocker+major) | Later fix |', '|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.repo} | !${r.pr} ${r.title.slice(0, 50)} | ${r.kind.slice(0, -1)} | ${r.kind === 'positives' ? r.hit : '—'} | ${r.verdict ?? r.status} | ${r.findings ?? '–'} (${r.strong ?? '–'}) | ${r.laterFixes?.length ? [...new Set(r.laterFixes.map((f) => f.fixSubject.slice(0, 50)))].slice(0, 1).join('') : ''} |`),
    '', 'Caveats: "later needed a fix" comes from git blame, so some positives are refactors that only look like fixes, and some negatives had bugs nobody fixed yet. "missed" is an upper bound on misses; strong findings on negatives are not automatically false alarms — label them.',
  ];
  writeFileSync(join(plan.out, 'results.json'), JSON.stringify({ summary, rows }, null, 2));
  writeFileSync(join(plan.out, 'results.md'), md.join('\n'));
  writeFileSync(join(plan.out, 'labels.md'), labels.join('\n'));
  console.log(md.slice(0, 6).join('\n'));
  log(`→ ${join(plan.out, 'results.md')} · ${join(plan.out, 'labels.md')}`);
}

function readCost(outDir) {
  for (const f of ['raw-output.json']) {
    try { return JSON.parse(readFileSync(join(outDir, f), 'utf8')).total_cost_usd ?? 0; } catch { /* openai or missing */ }
  }
  return 0;
}

