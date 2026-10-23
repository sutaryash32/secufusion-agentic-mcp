#!/usr/bin/env node
// Known-vulnerability lookup (OSV) for dependencies the change adds or re-versions.
//   node dep-audit.mjs --scope scope.json --out dep-audit.json
// Adds `depAuditFile` to the scope file. Never fails the review.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { auditWithOsv, buildQueries, lockVersions } from './lib/osv.mjs';
import { loadConfig } from './lib/paths.mjs';

const { values: args } = parseArgs({ options: { scope: { type: 'string' }, out: { type: 'string' } } });
const log = (m) => console.error(`[sfn-review:osv] ${m}`);
if (!args.scope || !args.out) { log('usage: dep-audit.mjs --scope <scope.json> --out <dep-audit.json>'); process.exit(64); }

const c = loadConfig().review.integrations?.osv;
if (!c?.enabled && !process.env.SFN_FORCE_OSV) process.exit(0);
const scope = JSON.parse(readFileSync(args.scope, 'utf8'));
const changes = scope.dependencyChanges ?? [];
if (!changes.length) process.exit(0);

// Exact npm versions from the lockfile next to each package.json.
let npmLock = {};
for (const manifest of new Set(changes.map((d) => d.manifest).filter((m) => m.endsWith('package.json')))) {
  const lock = join(scope.repoPath, dirname(manifest), 'package-lock.json');
  if (existsSync(lock)) npmLock = { ...npmLock, ...lockVersions(readFileSync(lock, 'utf8')) };
}

try {
  const { queries, skipped } = buildQueries(changes, npmLock);
  const vulnerable = await auditWithOsv({ queries, baseUrl: process.env.SFN_OSV_BASE_URL || c.baseUrl });
  writeFileSync(args.out, JSON.stringify({ source: 'osv.dev', checkedAt: new Date().toISOString(), checked: queries.length, skipped, vulnerable }, null, 2));
  scope.depAuditFile = resolve(args.out);
  writeFileSync(args.scope, JSON.stringify(scope, null, 2));
  log(`checked ${queries.length} dependency version(s): ${vulnerable.length} with known vulnerabilities${skipped.length ? `, ${skipped.length} skipped (no exact version)` : ''}`);
} catch (e) {
  log(`skipped: ${e.message}`);
}
