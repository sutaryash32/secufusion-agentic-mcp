import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { planThreads, SUMMARY_MARKER, findingMarker } from '../lib/ado.mjs';
import { applySuppressions, assignIds, findingId, gateDecision, sortFindings } from '../lib/findings.mjs';
import { globToRegExp, matchesAny } from '../lib/glob.mjs';
import { bundleDir, loadConfig } from '../lib/paths.mjs';
import { toSarif } from '../lib/sarif.mjs';
import { planReview, repoConfigFor } from '../lib/scope.mjs';
import { createValidator, extractResult } from '../lib/validate.mjs';

const cfg = loadConfig();
const file = (path, added = 10, removed = 0) => ({ path, added, removed });
const finding = (over = {}) => ({
  ruleId: 'DB-001', severity: 'blocker', confidence: 'confirmed', category: 'db',
  file: 'src/main/java/x/entity/Device.java', line: 42, anchor: 'Device#lastSeenAt',
  title: 'New column has no migration', problem: 'Column mapped but never created.',
  failureScenario: 'Deploy -> first query fails with missing column.', suggestion: 'Add V43 migration.',
  ...over,
});
const result = (findings, over = {}) => ({
  schemaVersion: 1, summary: 'Adds a column to devices.', blastRadius: {}, findings,
  rejectedCount: 0, verdict: 'fix_first', verdictReason: 'Blocker DB-001.', scope: { repoKey: 'sfn-events-api' }, ...over,
});

test('glob: ** and * semantics', () => {
  assert.ok(matchesAny('docs/a/b.md', ['docs/**']));
  assert.ok(matchesAny('README.md', ['**/*.md']));
  assert.ok(matchesAny('a/b/README.md', ['**/*.md']));
  assert.ok(!matchesAny('src/a.java', ['docs/**', '**/*.md']));
  assert.ok(globToRegExp('src/*/x.sql').test('src/db/x.sql'));
  assert.ok(!globToRegExp('src/*/x.sql').test('src/a/b/x.sql'));
});

test('scope: docs-only change is skipped', () => {
  const p = planReview([file('docs/a.md'), file('README.md')], cfg.repos, cfg.review);
  assert.equal(p.skip, true);
});

test('scope: migration + entity -> db, contracts, + security & tests at standard', () => {
  const p = planReview(
    [file('src/main/resources/db/migration/V43__x.sql'), file('src/main/java/com/secufusion/events/entity/Device.java')],
    cfg.repos, cfg.review,
  );
  assert.equal(p.skip, false);
  assert.equal(p.risk.score, 5); // migration 3 + entity 2
  assert.equal(p.level, 'standard');
  assert.deepEqual(p.specialists, ['db', 'security', 'contracts', 'tests']); // entity -> contracts; standard + code -> security; prod code -> tests
  assert.equal(p.verify, true);
});

test('scope: plain service change is quick with general pass only', () => {
  const p = planReview([file('src/main/java/com/secufusion/tenant/service/FooService.java')], cfg.repos, cfg.review);
  assert.equal(p.level, 'quick');
  assert.deepEqual(p.specialists, []);
  assert.equal(p.generalPass, true);
  assert.equal(p.verify, false);
});

test('scope: explicit deep runs every specialist that fits the stack', () => {
  const java = planReview([file('src/main/java/A.java')], cfg.repos, cfg.review, 'deep', 'java-spring');
  assert.deepEqual(java.specialists, ['db', 'security', 'contracts', 'runtime', 'tests', 'deps']);
  const ui = planReview([file('src/modules/X.jsx')], cfg.repos, cfg.review, 'deep', 'react-vite');
  assert.deepEqual(ui.specialists, ['security', 'contracts', 'webui', 'tests', 'deps']);
});

test('scope: risk capped at 10 and size tier counted once', () => {
  const files = [
    file('src/main/java/a/security/X.java', 1000, 900),
    file('src/main/resources/db/migration/V1__a.sql'),
    file('src/main/java/a/controller/C.java'),
    file('src/main/java/a/kafka/P.java'),
  ];
  const p = planReview(files, cfg.repos, cfg.review);
  assert.equal(p.risk.score, 10);
  assert.equal(p.risk.factors.filter((f) => f.id.startsWith('size')).length, 1);
});

test('repo config: unknown repo falls back to stack defaults', () => {
  const c = repoConfigFor('sfn-new-api', 'java-spring', cfg.repos);
  assert.equal(c.known, false);
  assert.equal(c.migrations, 'src/main/resources/db/migration');
  assert.equal(repoConfigFor('sfn-iam-api', undefined, cfg.repos).known, true);
});

test('finding id is stable across wording and line changes', () => {
  const a = findingId(finding(), 'sfn-events-api');
  const b = findingId(finding({ line: 99, title: 'Different words here' }), 'sfn-events-api');
  const c = findingId(finding({ anchor: 'Device#other' }), 'sfn-events-api');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[a-f0-9]{12}$/);
});

test('suppressions: by rule+path, by id, and expiry', () => {
  const [f] = assignIds([finding()], 'sfn-events-api');
  const byPath = applySuppressions([f], [{ ruleId: 'DB-001', path: 'src/main/java/**/entity/*.java', reason: 'x', expires: '2099-01-01' }]);
  assert.equal(byPath.suppressed.length, 1);
  const byId = applySuppressions([f], [{ id: f.id, reason: 'x', expires: '2099-01-01' }]);
  assert.equal(byId.kept.length, 0);
  const expired = applySuppressions([f], [{ id: f.id, reason: 'x', expires: '2000-01-01' }], '2026-10-21');
  assert.equal(expired.kept.length, 1);
  assert.equal(expired.expired.length, 1);
  const otherRule = applySuppressions([f], [{ ruleId: 'SEC-001', reason: 'x', expires: '2099-01-01' }]);
  assert.equal(otherRule.kept.length, 1);
});

test('gate: blocker fails, possible does not by default, review error fails closed', () => {
  const gate = { failOn: 'blocker', blockOnPossible: false, onReviewError: 'fail' };
  assert.equal(gateDecision(result([finding()]), gate).exitCode, 1);
  assert.equal(gateDecision(result([finding({ confidence: 'possible' })]), gate).exitCode, 0);
  assert.equal(gateDecision(result([finding({ confidence: 'possible' })]), { ...gate, blockOnPossible: true }).exitCode, 1);
  assert.equal(gateDecision(result([finding({ severity: 'major' })]), gate).exitCode, 0);
  assert.equal(gateDecision(result([finding({ severity: 'major' })]), { ...gate, failOn: 'major' }).exitCode, 1);
  assert.equal(gateDecision(undefined, gate).exitCode, 2);
  assert.equal(gateDecision(undefined, { ...gate, onReviewError: 'warn' }).exitCode, 0);
  assert.equal(gateDecision(result([finding()]), { ...gate, failOn: 'none' }).exitCode, 0);
});

test('sort: severity, then confirmed first', () => {
  const s = sortFindings([finding({ severity: 'minor' }), finding({ confidence: 'possible' }), finding()]);
  assert.deepEqual(s.map((f) => [f.severity, f.confidence]), [['blocker', 'confirmed'], ['blocker', 'possible'], ['minor', 'confirmed']]);
});

test('validator: accepts a good result, rejects bad enums and extra fields', () => {
  const dir = join(bundleDir(), 'schemas');
  const v = createValidator([
    JSON.parse(readFileSync(join(dir, 'finding.schema.json'), 'utf8')),
    JSON.parse(readFileSync(join(dir, 'review-result.schema.json'), 'utf8')),
  ]);
  const { scope, ...good } = result([finding()]);
  assert.deepEqual(v('review-result.schema.json', good), []);
  const bad = { ...good, verdict: 'ok', extra: 1, findings: [finding({ severity: 'critical', line: 0 })] };
  const errs = v('review-result.schema.json', bad);
  assert.ok(errs.some((e) => e.includes('verdict')));
  assert.ok(errs.some((e) => e.includes('unexpected "extra"')));
  assert.ok(errs.some((e) => e.includes('severity')));
  assert.ok(errs.some((e) => e.includes('line')));
});

test('extractResult: CLI envelope, structured_output, fenced block', () => {
  const r = { verdict: 'ready', findings: [] };
  assert.deepEqual(extractResult(JSON.stringify({ type: 'result', structured_output: r })), r);
  assert.deepEqual(extractResult(JSON.stringify({ type: 'result', result: 'Done.\n```json\n' + JSON.stringify(r) + '\n```' })), r);
  assert.deepEqual(extractResult('noise {"verdict":"ready","findings":[]} trailing'), r);
  assert.equal(extractResult('no json here'), undefined);
});

test('ado: posts new findings once, resolves vanished ones, keeps cross-repo in summary', () => {
  const [a, b] = assignIds([finding(), finding({ anchor: 'Device#b', ruleId: 'SEC-003', category: 'security' })], 'sfn-events-api');
  const [x] = assignIds([finding({ repo: 'sfn-web-ui', anchor: 'deviceService#list', ruleId: 'CON-001' })], 'sfn-events-api');
  const r = result([a, b, x]);
  const threads = [
    { id: 1, status: 'active', comments: [{ id: 1, content: `${findingMarker(a.id)}\n…` }] },
    { id: 2, status: 'active', comments: [{ id: 1, content: `${findingMarker('0123456789ab')}\n…` }] },
    { id: 3, status: 'active', comments: [{ id: 1, content: `${SUMMARY_MARKER}\n…` }] },
  ];
  const plan = planThreads(r, threads, { maxInline: 25 });
  assert.deepEqual(plan.toCreate.map((f) => f.id), [b.id]);
  assert.deepEqual(plan.toResolve.map((t) => t.threadId), [2]);
  assert.deepEqual(plan.notInline.map((f) => f.id), [x.id]);
  assert.equal(plan.summaryThread.id, 3);
});

test('ado: comment cap pushes overflow to summary', () => {
  const fs = assignIds([1, 2, 3].map((i) => finding({ anchor: `A#${i}` })), 'sfn-events-api');
  const plan = planThreads(result(fs), [], { maxInline: 2 });
  assert.equal(plan.toCreate.length, 2);
  assert.equal(plan.notInline.length, 1);
});

test('sarif: one result per finding with fingerprint', () => {
  const fs = assignIds([finding()], 'sfn-events-api');
  const s = toSarif(result(fs));
  assert.equal(s.runs[0].results.length, 1);
  assert.equal(s.runs[0].results[0].level, 'error');
  assert.equal(s.runs[0].results[0].partialFingerprints.sfnFindingId, fs[0].id);
});

test('extractResult: CLI error envelope is not a result, and stray JSON objects are ignored', () => {
  const env = { type: 'result', is_error: true, result: 'API Error: 400 {"type":"error","error":{"message":"too old"}}' };
  assert.equal(extractResult(JSON.stringify(env)), undefined);
  assert.equal(extractResult('log line {"type":"error","request_id":"x"}'), undefined);
});
