#!/usr/bin/env node
// Scores eval runs against each case's expectations; writes evals/results/<timestamp>-<engine>.json.
//   node score.mjs --work evals/.work --cases evals/cases --engine anthropic <case>...
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { SEVERITY_RANK } from '../scripts/lib/findings.mjs';

const { values: args, positionals } = parseArgs({
  options: { work: { type: 'string' }, cases: { type: 'string' }, engine: { type: 'string', default: 'config' } },
  allowPositionals: true,
});

const read = (f) => JSON.parse(readFileSync(f, 'utf8'));
const atLeast = (f, sev) => !sev || SEVERITY_RANK[f.severity] >= SEVERITY_RANK[sev];
const NEAR = 15;
const matches = (f, e) =>
  (!e.nearLines || (f.line >= e.nearLines[0] - NEAR && f.line <= e.nearLines[1] + NEAR)) &&
  (!e.ruleId || f.ruleId === e.ruleId) &&
  (!e.ruleIdAnyOf || e.ruleIdAnyOf.includes(f.ruleId)) &&
  (!e.file || f.file === e.file) &&
  atLeast(f, e.minSeverity);

const rows = [];
for (const name of positionals) {
  const kase = read(join(args.cases, name, 'case.json'));
  const resultFile = join(args.work, name, 'out', 'review-result.json');
  if (!existsSync(resultFile)) {
    rows.push({ name, pass: false, checks: [{ ok: false, what: 'review produced a valid result' }] });
    continue;
  }
  const r = read(resultFile);
  const checks = [];
  for (const e of kase.expect.mustFind ?? []) {
    const ok = e.anyOf ? r.findings.some((f) => e.anyOf.some((x) => matches(f, x))) : r.findings.some((f) => matches(f, e));
    checks.push({ ok, what: `finds ${JSON.stringify(e)}` });
  }
  for (const e of kase.expect.mustNotFind ?? []) {
    const hits = r.findings.filter((f) => matches(f, e));
    checks.push({ ok: hits.length === 0, what: `no finding ${JSON.stringify(e)}`, got: hits.map((f) => `${f.severity} ${f.ruleId} ${f.title}`) });
  }
  if (kase.expect.verdictIn) {
    checks.push({ ok: kase.expect.verdictIn.includes(r.verdict), what: `verdict in ${kase.expect.verdictIn.join('|')}`, got: r.verdict });
  }
  rows.push({
    name,
    pass: checks.every((c) => c.ok),
    checks,
    verdict: r.verdict,
    findings: r.findings.map((f) => `${f.severity}/${f.confidence} ${f.ruleId} ${f.file}:${f.line} ${f.title}`),
    rejected: r.rejectedCount,
    level: r.scope?.level,
  });
}

// Known gaps (case.json "knownGap": "<why>") are reported but don't fail the suite.
for (const r of rows) {
  const k = read(join(args.cases, r.name, 'case.json'));
  if (k.knownGap) { r.knownGap = k.knownGap; if (!r.pass) r.pass = true, r.gapMissed = true; }
}
const passed = rows.filter((r) => r.pass).length;
for (const r of rows) {
  console.log(`${r.gapMissed ? 'GAP ' : r.pass ? 'PASS' : 'FAIL'}  ${r.name}  (verdict=${r.verdict ?? '–'}, level=${r.level ?? '–'}, findings=${r.findings?.length ?? 0}, rejected=${r.rejected ?? 0})`);
  for (const c of r.checks.filter((c) => !c.ok)) console.log(`      ✗ ${c.what}${c.got ? ` — got ${JSON.stringify(c.got)}` : ''}`);
}
console.log(`\n${passed}/${rows.length} cases passed`);

const outDir = join(dirname(fileURLToPath(import.meta.url)), 'results');
mkdirSync(outDir, { recursive: true });
const file = join(outDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${args.engine}.json`);
writeFileSync(file, JSON.stringify({ engine: args.engine, passed, total: rows.length, rows }, null, 2));
console.log(`details: ${file}`);
process.exit(passed === rows.length ? 0 : 1);
