#!/usr/bin/env node
// CI gate: exit code from the finalized result + gate config.
//   0 pass/warn · 1 blocking findings · 2 review failed (onReviewError=fail)
//
//   node gate.mjs --in review-result.json [--fail-on blocker|major|minor|none]
//                 [--block-on-possible] [--on-review-error fail|warn]
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { gateDecision } from './lib/findings.mjs';
import { loadConfig, readJson } from './lib/paths.mjs';

const { values: args } = parseArgs({
  options: {
    in: { type: 'string' },
    'fail-on': { type: 'string' },
    'block-on-possible': { type: 'boolean' },
    'on-review-error': { type: 'string' },
  },
});

const gate = { ...loadConfig().review.gate };
if (args['fail-on']) gate.failOn = args['fail-on'];
if (args['block-on-possible'] !== undefined) gate.blockOnPossible = args['block-on-possible'];
if (args['on-review-error']) gate.onReviewError = args['on-review-error'];

const result = args.in && existsSync(args.in) ? readJson(args.in) : undefined;
const decision = gateDecision(result, gate);

console.log(`[sfn-review gate] ${decision.status.toUpperCase()}: ${decision.message}`);
for (const f of decision.blocking ?? []) {
  console.log(`  ${f.severity.toUpperCase()} ${f.ruleId} ${f.repo}/${f.file}:${f.line} — ${f.title}`);
}
process.exit(decision.exitCode);
