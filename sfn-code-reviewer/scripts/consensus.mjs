#!/usr/bin/env node
// Merge N raw engine outputs of the same review into one (see lib/consensus.mjs).
//   node consensus.mjs --scope scope.json --out raw-output.json raw-run-1.json raw-run-2.json [...]
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { mergeRuns } from './lib/consensus.mjs';
import { loadConfig } from './lib/paths.mjs';
import { extractResult } from './lib/validate.mjs';

const { values: args, positionals } = parseArgs({ options: { scope: { type: 'string' }, out: { type: 'string' } }, allowPositionals: true });
if (!args.scope || !args.out || positionals.length < 2) {
  console.error('usage: consensus.mjs --scope <scope.json> --out <raw-output.json> <run1> <run2> [...]');
  process.exit(64);
}
const scope = JSON.parse(readFileSync(args.scope, 'utf8'));
const results = positionals.map((p) => { try { return extractResult(readFileSync(p, 'utf8')); } catch { return undefined; } });
try {
  const review = loadConfig().review;
  const merged = mergeRuns(results, {
    minAgree: review.consensus?.minAgree ?? 2,
    missingRepos: scope.missingRepos ?? [],
    criticalRules: Object.keys(review.severityFloors ?? {}),
  });
  writeFileSync(args.out, JSON.stringify(merged, null, 2));
  console.error(`[sfn-review] consensus of ${merged.consensus.runs} run(s)${merged.consensus.failedRuns ? ` (${merged.consensus.failedRuns} failed)` : ''}: kept ${merged.consensus.kept}, hid ${merged.consensus.seenOnce.length} seen once`);
} catch (e) {
  console.error(`[sfn-review] consensus failed: ${e.message}`);
  process.exit(3);
}
