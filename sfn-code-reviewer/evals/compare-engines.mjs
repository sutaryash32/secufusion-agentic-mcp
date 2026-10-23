#!/usr/bin/env node
// Side-by-side comparison of the latest eval run per engine (from evals/results/).
//   node evals/compare-engines.mjs [anthropic] [openai]
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'results');
const engines = process.argv.slice(2).length ? process.argv.slice(2) : ['anthropic', 'openai'];

let files = [];
try { files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch { /* none yet */ }
const latest = Object.fromEntries(engines.map((e) => {
  const f = files.filter((x) => x.endsWith(`-${e}.json`)).at(-1);
  return [e, f ? JSON.parse(readFileSync(join(dir, f), 'utf8')) : undefined];
}));

const missing = engines.filter((e) => !latest[e]);
if (missing.length) {
  console.error(`No eval results for: ${missing.join(', ')}. Run: evals/run-evals.sh --engine <name>`);
  process.exit(1);
}

const cases = [...new Set(engines.flatMap((e) => latest[e].rows.map((r) => r.name)))].sort();
const pad = (s, n) => String(s).padEnd(n);
console.log(pad('case', 30) + engines.map((e) => pad(e, 34)).join(''));
for (const c of cases) {
  console.log(pad(c, 30) + engines.map((e) => {
    const r = latest[e].rows.find((x) => x.name === c);
    return pad(r ? `${r.pass ? 'PASS' : 'FAIL'} ${r.verdict ?? '–'} f=${r.findings?.length ?? 0} rej=${r.rejected ?? 0}` : '–', 34);
  }).join(''));
}
console.log(pad('total', 30) + engines.map((e) => pad(`${latest[e].passed}/${latest[e].total}`, 34)).join(''));
