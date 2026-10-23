#!/usr/bin/env node
// History eval cases: a real change from git history (base..head), reviewed as it was — the repo and its
// siblings as detached worktrees at that date. Used by run-evals.sh for case.json with "type": "history".
//
//   node evals/history-case.mjs prepare <caseDir> <workDir>   → prints {repo, repoKey, base, head, estate}
//   node evals/history-case.mjs cleanup <workDir>
//
// Source repos: case.json "estate" (absolute path when the case was created), or $SFN_ESTATE.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from '../scripts/lib/paths.mjs';

const [cmd, a, b] = process.argv.slice(2);
const git = (repo, ...x) => execFileSync('git', ['-C', repo, ...x], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (repo, ...x) => { try { return git(repo, ...x); } catch { return ''; } };

if (cmd === 'prepare') {
  const kase = JSON.parse(readFileSync(join(a, 'case.json'), 'utf8'));
  const estateSrc = resolve(process.env.SFN_ESTATE || kase.estate);
  const work = resolve(b);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const added = [];
  const src = join(estateSrc, kase.repoKey);
  if (!existsSync(join(src, '.git'))) { console.error(`history case: ${src} not found (set SFN_ESTATE)`); process.exit(2); }
  if (!tryGit(src, 'cat-file', '-e', `${kase.head}^{commit}`)) tryGit(src, 'fetch', '--quiet', 'origin', kase.head);
  const date = git(src, 'show', '-s', '--format=%cI', kase.head).slice(0, 10);
  for (const key of Object.keys(loadConfig().repos.repos)) {
    const s = join(estateSrc, key);
    if (!existsSync(join(s, '.git'))) continue;
    const at = key === kase.repoKey ? kase.head : tryGit(s, 'rev-list', '-1', `--before=${date}T23:59:59`, 'origin/develop') || tryGit(s, 'rev-parse', 'origin/develop');
    if (!at) continue;
    git(s, 'worktree', 'add', '--detach', '--quiet', join(work, key), at);
    added.push([s, join(work, key)]);
  }
  writeFileSync(join(work, '.worktrees.json'), JSON.stringify(added));
  console.log(JSON.stringify({ repo: join(work, kase.repoKey), repoKey: kase.repoKey, base: kase.base, head: kase.head, estate: work }));
} else if (cmd === 'cleanup') {
  const work = resolve(a);
  const f = join(work, '.worktrees.json');
  if (existsSync(f)) for (const [s, wt] of JSON.parse(readFileSync(f, 'utf8')).reverse()) tryGit(s, 'worktree', 'remove', '--force', wt);
  // keep <work>/out for diagnosis; drop the rest
  for (const n of existsSync(work) ? readdirSync(work) : []) if (n !== 'out') rmSync(join(work, n), { recursive: true, force: true });
} else {
  console.error('usage: history-case.mjs prepare <caseDir> <workDir> | cleanup <workDir>');
  process.exit(64);
}
