#!/usr/bin/env node
// review-result.json -> SARIF 2.1.0 (Azure DevOps "Scans" tab via the SARIF SAST Scans Tab
// extension, which reads the CodeAnalysisLogs artifact).
//
//   node to-sarif.mjs --in review-result.json --out sfn-review.sarif
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { readJson } from './lib/paths.mjs';
import { toSarif } from './lib/sarif.mjs';

const { values: args } = parseArgs({ options: { in: { type: 'string' }, out: { type: 'string' } } });
if (!args.in || !args.out) {
  console.error('usage: to-sarif.mjs --in <review-result.json> --out <file.sarif>');
  process.exit(64);
}

writeFileSync(args.out, JSON.stringify(toSarif(readJson(args.in)), null, 2));
