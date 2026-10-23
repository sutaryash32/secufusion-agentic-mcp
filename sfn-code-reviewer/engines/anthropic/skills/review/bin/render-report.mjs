#!/usr/bin/env node
//   node render-report.mjs --in review-result.json --out report.html
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { readJson } from './lib/paths.mjs';
import { renderReport } from './lib/report.mjs';

const { values: args } = parseArgs({ options: { in: { type: 'string' }, out: { type: 'string' } } });
if (!args.in || !args.out) {
  console.error('usage: render-report.mjs --in <review-result.json> --out <report.html>');
  process.exit(64);
}
writeFileSync(args.out, renderReport(readJson(args.in)));
console.error(`[sfn-review] report: ${args.out}`);
