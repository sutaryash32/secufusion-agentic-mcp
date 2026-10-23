#!/usr/bin/env node
// Computes WHAT to review and HOW DEEP — deterministically, from git — and writes scope.json.
// Same script locally (via the plugin's bin/) and in CI (via run-review.sh).
//
//   node collect-scope.mjs [--repo <path>] [--repo-key <key>] [--base <ref>] [--head <ref>]
//                          [--working-tree] [--pr <id>] [--level auto|quick|standard|deep]
//                          [--estate-root <dir>] [--out <file>]
//
// --pr <id>: resolve an Azure DevOps pull request (auth: AZURE_DEVOPS_PAT, `az login`, or the pipeline
// token), fetch its target branch and source commit, and review exactly the PR's changes.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from './lib/paths.mjs';
import { authHeaders, createAdo, parseRemote } from './lib/ado-api.mjs';
import { diffDeps, manifestKind, parsePackageJson, parsePom } from './lib/deps.mjs';
import { buildHints, parseBlamePorcelain, parseOldRanges } from './lib/history.mjs';
import { suggestReviewers } from './lib/reviewers.mjs';
import { planReview, repoConfigFor } from './lib/scope.mjs';

const { values: args } = parseArgs({
  options: {
    repo: { type: 'string' },
    'repo-key': { type: 'string' },
    base: { type: 'string' },
    head: { type: 'string', default: 'HEAD' },
    'working-tree': { type: 'boolean', default: false },
    pr: { type: 'string' },
    level: { type: 'string', default: 'auto' },
    'estate-root': { type: 'string' },
    out: { type: 'string' },
  },
});

const git = (repo, ...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
const refExists = (repo, ref) => {
  try { git(repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`); return true; } catch { return false; }
};

const repoPath = resolve(args.repo ?? git(process.cwd(), 'rev-parse', '--show-toplevel'));
const repoKey = args['repo-key'] ?? basename(repoPath);
const cfg = loadConfig();

let pr;
if (args.pr) {
  if (args['working-tree']) fail('--pr and --working-tree are mutually exclusive.');
  const remote = parseRemote(git(repoPath, 'remote', 'get-url', 'origin'));
  if (!remote) fail('origin is not an Azure Repos URL — --pr needs one.');
  let p;
  try {
    p = await createAdo({ ...remote, headers: authHeaders() }).getPullRequest(remote.repo, args.pr);
  } catch (e) { fail(`could not read PR ${args.pr}: ${e.message}`); }
  const target = p.targetRefName.replace(/^refs\/heads\//, '');
  const sourceSha = p.lastMergeSourceCommit?.commitId;
  if (!sourceSha) fail(`PR ${args.pr} has no source commit.`);
  git(repoPath, 'fetch', '--quiet', 'origin', `+refs/heads/${target}:refs/remotes/origin/${target}`, p.sourceRefName);
  if (!refExists(repoPath, sourceSha)) git(repoPath, 'fetch', '--quiet', 'origin', sourceSha);
  pr = {
    id: Number(args.pr), title: p.title, status: p.status, sourceRef: p.sourceRefName, targetRef: p.targetRefName,
    repositoryId: p.repository?.id, collectionUri: remote.collectionUri, project: remote.project,
    url: `${remote.collectionUri}${encodeURIComponent(remote.project)}/_git/${encodeURIComponent(remote.repo)}/pullrequest/${args.pr}`,
  };
  // A completed PR is already in the target branch: diff against the target as it was at merge time.
  const targetAtMerge = p.status === 'completed' ? p.lastMergeTargetCommit?.commitId : undefined;
  if (targetAtMerge && !refExists(repoPath, targetAtMerge)) git(repoPath, 'fetch', '--quiet', 'origin', targetAtMerge);
  args.base ??= targetAtMerge ?? `origin/${target}`;
  args.head = sourceSha;
}

const base = args.base ?? ['origin/develop', 'develop', 'origin/main', 'main'].find((r) => refExists(repoPath, r));
if (!base || !refExists(repoPath, base)) {
  fail(`Base ref ${args.base ?? '(origin/develop|develop|origin/main|main)'} not found in ${repoPath}. Pass --base, or fetch it.`);
}
if (!refExists(repoPath, args.head)) fail(`Head ref "${args.head}" not found in ${repoPath}.`);

const headSha = git(repoPath, 'rev-parse', args.head);
const mergeBase = git(repoPath, 'merge-base', base, headSha);
const diffRange = args['working-tree'] ? [mergeBase] : [mergeBase, headSha];

// --no-renames keeps numstat and name-status line-aligned and simple.
const numstat = git(repoPath, 'diff', '--no-renames', '--numstat', ...diffRange).split('\n').filter(Boolean);
const statuses = new Map(
  git(repoPath, 'diff', '--no-renames', '--name-status', ...diffRange)
    .split('\n').filter(Boolean)
    .map((l) => { const [s, p] = l.split('\t'); return [p, s]; }),
);
const changedFiles = numstat.map((l) => {
  const [a, r, path] = l.split('\t');
  return { path, status: statuses.get(path) ?? 'M', added: Number(a) || 0, removed: Number(r) || 0 };
});
if (args['working-tree']) {
  for (const path of git(repoPath, 'ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean)) {
    const abs = join(repoPath, path);
    const lines = statSync(abs).size < 2_000_000 ? readFileSync(abs, 'utf8').split('\n').length : 0;
    changedFiles.push({ path, status: 'A', added: lines, removed: 0, untracked: true });
  }
}

const detectedStack = existsSync(join(repoPath, 'pom.xml'))
  ? 'java-spring'
  : existsSync(join(repoPath, 'package.json')) && /"(vite|react)"/.test(readFileSync(join(repoPath, 'package.json'), 'utf8'))
    ? 'react-vite'
    : undefined;
const repoConfig = repoConfigFor(repoKey, detectedStack, cfg.repos);

const estateRoot = resolve(args['estate-root'] ?? dirname(repoPath));
const present = new Set(readdirSync(estateRoot).filter((d) => existsSync(join(estateRoot, d, '.git'))));
const listed = Object.keys(cfg.repos.repos ?? {});
const knownRepos = listed.filter((k) => present.has(k));
const missingRepos = listed.filter((k) => !present.has(k) && k !== repoKey);

const plan = planReview(changedFiles, cfg.repos, cfg.review, args.level, repoConfig.stack);

// Regression hints: lines this change removes/modifies that were last written by a fix commit.
let historyHints = [];
let blames = [];
const hcfg = cfg.review.integrations?.history;
const rcfg = cfg.review.integrations?.reviewers;
if ((hcfg?.enabled || rcfg?.enabled) && !plan.skip) {
  try {
    const candidates = changedFiles
      .filter((f) => f.status !== 'A' && f.removed > 0)
      .sort((a, b) => b.removed - a.removed)
      .slice(0, hcfg?.maxFiles ?? 40)
      .map((f) => f.path);
    if (candidates.length) {
      const ranges = parseOldRanges(git(repoPath, 'diff', '--no-renames', '-U0', ...diffRange, '--', ...candidates));
      const perFile = Object.entries(ranges).map(([file, rs]) => ({
        file,
        blame: parseBlamePorcelain(git(repoPath, 'blame', '--porcelain', '-w',
          ...rs.slice(0, 30).flatMap(([a, b]) => ['-L', `${a},${b}`]), mergeBase, '--', file)),
      }));
      blames = perFile;
      if (hcfg?.enabled) historyHints = buildHints(perFile, new RegExp(hcfg.fixPattern, 'i'), hcfg.maxAgeDays ?? 365);
    }
  } catch (e) {
    console.error(`[sfn-review] history hints skipped: ${e.message.split('\n')[0]}`);
  }
}

// Suggested reviewers: who wrote the rewritten lines + who recently changed these files.
let suggestedReviewers = [];
if (rcfg?.enabled && !plan.skip) {
  try {
    const exclude = git(repoPath, 'log', '--format=%an', `${mergeBase}..${headSha}`).split('\n').filter(Boolean);
    if (args['working-tree']) { try { exclude.push(git(repoPath, 'config', 'user.name')); } catch { /* unset */ } }
    const recent = changedFiles
      .filter((f) => f.status !== 'A')
      .slice(0, rcfg.maxFiles ?? 40)
      .map(({ path }) => ({
        file: path,
        authors: git(repoPath, 'log', '-n', '20', `--since=${rcfg.sinceDays ?? 180}.days`, '--format=%an', mergeBase, '--', path).split('\n').filter(Boolean),
      }));
    suggestedReviewers = suggestReviewers({ blames, recent, exclude, max: rcfg.max ?? 3 });
  } catch (e) {
    console.error(`[sfn-review] reviewer suggestions skipped: ${e.message.split('\n')[0]}`);
  }
}

// Dependency changes, parsed from the manifests at merge-base and head (or the working tree).
const showAt = (rev, path) => { try { return git(repoPath, 'show', `${rev}:${path}`); } catch { return ''; } };
const dependencyChanges = changedFiles.flatMap(({ path, status }) => {
  const kind = manifestKind(path);
  if (!kind) return [];
  const before = status === 'A' ? '' : showAt(mergeBase, path);
  const after = status === 'D' ? ''
    : args['working-tree'] ? readFileSync(join(repoPath, path), 'utf8') : showAt(headSha, path);
  const parse = kind === 'pom' ? parsePom : parsePackageJson;
  return diffDeps(path, parse(before), parse(after));
});
const quote = (s) => (/^[\w./@:-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

const scope = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  repoKey,
  repoPath,
  repoConfig,
  estateRoot,
  knownRepos,
  missingRepos,
  base,
  head: args.head,
  headSha,
  mergeBase,
  workingTree: args['working-tree'],
  // Runs from repoPath (the review session's working directory). No `-C`: the CI permission
  // allowlist matches commands that start with `git diff`.
  diffCmd: ['git', 'diff', ...diffRange].join(' '),
  changedFiles,
  rulesDir: cfg.rulesDir,
  dependencyChanges,
  historyHints,
  suggestedReviewers,
  ...(pr ? { pr } : {}),
  ...plan,
};

const out = resolve(args.out ?? join(repoPath, '.sfn-review', 'scope.json'));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(scope, null, 2));

console.error(
  plan.skip
    ? `[sfn-review] ${repoKey}: skip — ${plan.skipReason}`
    : `[sfn-review] ${repoKey}: ${changedFiles.length} files, risk ${plan.risk.score}/10 → ${plan.level}; ` +
      `specialists: ${plan.specialists.join(', ') || 'none (general pass only)'}` +
      (pr ? `; PR ${pr.id} "${pr.title}"` : '') +
      (historyHints.length ? `; ${historyHints.length} fix-history hint(s)` : '') +
      (missingRepos.length ? `; missing repos: ${missingRepos.join(', ')}` : ''),
);
console.log(out);

function fail(msg) {
  console.error(`[sfn-review] ${msg}`);
  process.exit(2);
}
