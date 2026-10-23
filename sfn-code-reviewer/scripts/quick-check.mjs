#!/usr/bin/env node
// Fast deterministic check (no model, seconds): migrations numbering/edits, entity columns without a
// migration, endpoints without @PreAuthorize, secrets, flags on by default, lb://, hard deletes in
// events-api, web-ui axios/URL/tenant-id misuse, tests outside src/__tests__, and cross-repo
// deploy-order dependencies (lib/deployorder.mjs).
//
//   node quick-check.mjs [--repo <path>] [--base <ref>] [--head <ref>] [--working-tree]
//                        [--estate-root <dir>] [--out findings.json] [--fail-on blocker|major|none] [--scope scope.json]
//
// With --scope it reuses a scope.json from collect-scope (run-review.sh does this and merges the findings
// into the review). Exit 1 when a CONFIRMED finding is at/above --fail-on (default none = advisory).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { findDeployOrder } from './lib/deployorder.mjs';
import { SEVERITY_RANK } from './lib/findings.mjs';
import { loadConfig } from './lib/paths.mjs';
import { parseAddedLines, quickCheck } from './lib/quickcheck.mjs';

const { values: args } = parseArgs({
  options: {
    repo: { type: 'string' }, base: { type: 'string' }, head: { type: 'string', default: 'HEAD' }, 'working-tree': { type: 'boolean', default: false },
    'estate-root': { type: 'string' }, out: { type: 'string' }, 'fail-on': { type: 'string', default: 'none' }, scope: { type: 'string' }, quiet: { type: 'boolean', default: false },
  },
});
const cfg = loadConfig();
const started = Date.now();

let repo; let base; let head; let workingTree; let estateRoot; let repoKey; let stack; let migrationsDir;
if (args.scope) {
  const s = JSON.parse(readFileSync(args.scope, 'utf8'));
  ({ repoPath: repo, mergeBase: base, headSha: head, workingTree, estateRoot, repoKey } = s);
  stack = s.repoConfig?.stack; migrationsDir = s.repoConfig?.migrations;
} else {
  repo = resolve(args.repo ?? execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim());
  repoKey = basename(repo);
  const rc = cfg.repos.repos?.[repoKey] ?? {};
  stack = rc.stack ?? (existsSync(join(repo, 'pom.xml')) ? 'java-spring' : existsSync(join(repo, 'package.json')) ? 'react-vite' : 'unknown');
  migrationsDir = rc.migrations;
  const ref = (r) => { try { execFileSync('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `${r}^{commit}`]); return true; } catch { return false; } };
  const b = args.base ?? ['origin/develop', 'develop', 'origin/main', 'main'].find(ref);
  head = execFileSync('git', ['-C', repo, 'rev-parse', args.head], { encoding: 'utf8' }).trim();
  base = execFileSync('git', ['-C', repo, 'merge-base', b, head], { encoding: 'utf8' }).trim();
  workingTree = args['working-tree'];
  estateRoot = resolve(args['estate-root'] ?? dirname(repo));
}

const git = (...a) => { try { return execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }); } catch { return ''; } };
const range = workingTree ? [base] : [base, head];
const changedFiles = git('diff', '--no-renames', '--name-status', ...range).split('\n').filter(Boolean).map((l) => { const [status, path] = l.split('\t'); return { status, path }; });
const added = parseAddedLines(git('diff', '--no-renames', '-U0', ...range));
const read = (p) => (workingTree ? (existsSync(join(repo, p)) ? readFileSync(join(repo, p), 'utf8') : '') : git('show', `${head}:${p}`));
const migDir = migrationsDir ?? 'src/main/resources/db/migration';
const baseMigrations = git('ls-tree', '--name-only', base, `${migDir}/`).split('\n').filter(Boolean);

// Shared database: a column may be created by this repo's earlier migrations or by a sibling API's.
const migrationCorpus = [
  git('grep', '-h', '-i', '-o', '-E', '[a-z_][a-z0-9_]*', base, '--', `${migDir}/*.sql`),
  ...Object.entries(cfg.repos.repos ?? {}).filter(([k, r]) => k !== repoKey && r.migrations).map(([k, r]) => {
    const d = join(estateRoot, k);
    if (!existsSync(join(d, '.git'))) return '';
    try { return execFileSync('git', ['-C', d, 'grep', '-h', '-i', '-o', '-E', '[a-z_][a-z0-9_]*', 'HEAD', '--', `${r.migrations}/*.sql`], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }); } catch { return ''; }
  }),
].join('\n').toLowerCase();
const knownColumns = new Set(migrationCorpus.split('\n'));
const allowlistPath = git('ls-tree', '-r', '--name-only', workingTree ? 'HEAD' : head).split('\n').find((p) => p.endsWith('/MutatingEndpointAllowlist.java'));

const findings = [
  ...quickCheck({ repoKey, stack, changedFiles, added, read, baseMigrations, migrationsDir: migDir,
    columnKnownElsewhere: (c) => knownColumns.has(c.toLowerCase()), allowlist: allowlistPath ? read(allowlistPath) : '' }),
  ...findDeployOrderFindings(),
];

const result = { generatedAt: new Date().toISOString(), repoKey, base, head: workingTree ? 'working tree' : head, ms: Date.now() - started, findings };
if (args.out) writeFileSync(args.out, JSON.stringify(result, null, 2));
if (!args.quiet) {
  console.error(`[sfn-quick] ${repoKey}: ${changedFiles.length} files, ${findings.length} finding(s) in ${result.ms} ms`);
  for (const f of findings) console.error(`  ${f.severity.toUpperCase().padEnd(7)} ${f.confidence.padEnd(9)} ${f.ruleId.padEnd(7)} ${f.file}:${f.line}  ${f.title}`);
}
const t = SEVERITY_RANK[args['fail-on']];
process.exit(t && findings.some((f) => f.confidence === 'confirmed' && SEVERITY_RANK[f.severity] >= t) ? 1 : 0);

function findDeployOrderFindings() {
  try {
    const subjects = git('log', '--format=%s%n%b', ...(workingTree ? [`${base}..HEAD`] : [`${base}..${head}`])).split('\n');
    const branch = (git('rev-parse', '--abbrev-ref', 'HEAD').trim() || '').replace(/^HEAD$/, '');
    return findDeployOrder({ repoKey, repo, estateRoot, branch, subjects, repoKeys: Object.keys(cfg.repos.repos ?? {}) });
  } catch (e) {
    if (!args.quiet) console.error(`[sfn-quick] deploy-order check skipped: ${e.message.split('\n')[0]}`);
    return [];
  }
}
