import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeDelta } from '../lib/delta.mjs';
import { diffDeps, parsePackageJson, parsePom, semverBump } from '../lib/deps.mjs';
import { assignIds } from '../lib/findings.mjs';
import { loadConfig } from '../lib/paths.mjs';
import { planReview } from '../lib/scope.mjs';
import { decideVerdict } from '../lib/verdict.mjs';
import { applyDecisions, verifyFindings } from '../lib/verify.mjs';

const cfg = loadConfig();
const F = (over = {}) => ({
  ruleId: 'DB-001', severity: 'blocker', confidence: 'confirmed', category: 'db', specialist: 'db',
  file: 'src/A.java', line: 3, anchor: 'A#x', title: 'Column without migration', problem: 'p'.repeat(12),
  failureScenario: 'f'.repeat(12), suggestion: 'add migration', ...over,
});

test('scope: web-ui component change selects webui, never db/runtime', () => {
  const p = planReview([{ path: 'src/modules/Devices/DeviceList.jsx', added: 30, removed: 2 }], cfg.repos, cfg.review, 'auto', 'react-vite');
  assert.ok(p.specialists.includes('webui'));
  assert.ok(!p.specialists.includes('db'));
  assert.ok(!p.specialists.includes('runtime'));
});

test('scope: scheduler selects runtime; pom selects deps; test-only change adds no tests specialist', () => {
  const s = planReview([{ path: 'src/main/java/a/scheduler/PurgeScheduler.java', added: 40, removed: 0 }], cfg.repos, cfg.review, 'auto', 'java-spring');
  assert.ok(s.specialists.includes('runtime'));
  const d = planReview([{ path: 'pom.xml', added: 5, removed: 0 }], cfg.repos, cfg.review, 'auto', 'java-spring');
  assert.deepEqual(d.specialists, ['deps']);
  const t = planReview([{ path: 'src/test/java/a/FooTest.java', added: 40, removed: 0 }], cfg.repos, cfg.review, 'standard', 'java-spring');
  assert.ok(!t.specialists.includes('tests'));
});

test('deps: pom with properties, scopes, managed and parent', () => {
  const before = parsePom(`<project><parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>3.3.1</version></parent>
    <properties><jjwt.version>0.11.5</jjwt.version></properties>
    <dependencies>
      <dependency><groupId>io.jsonwebtoken</groupId><artifactId>jjwt-api</artifactId><version>\${jjwt.version}</version></dependency>
      <dependency><groupId>org.projectlombok</groupId><artifactId>lombok</artifactId></dependency>
      <!-- <dependency><groupId>x</groupId><artifactId>commented</artifactId></dependency> -->
    </dependencies></project>`);
  const after = parsePom(`<project><parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>4.0.0</version></parent>
    <properties><jjwt.version>0.12.6</jjwt.version></properties>
    <dependencies>
      <dependency><groupId>io.jsonwebtoken</groupId><artifactId>jjwt-api</artifactId><version>\${jjwt.version}</version></dependency>
      <dependency><groupId>org.mapstruct</groupId><artifactId>mapstruct</artifactId><version>1.6.3</version></dependency>
      <dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId><version>5.11.0</version><scope>test</scope></dependency>
    </dependencies></project>`);
  assert.equal(before['io.jsonwebtoken:jjwt-api'].version, '0.11.5');
  assert.equal(before['org.projectlombok:lombok'].version, 'managed');
  assert.ok(!before['x:commented']);
  const d = Object.fromEntries(diffDeps('pom.xml', before, after).map((x) => [x.name, x]));
  assert.equal(d['io.jsonwebtoken:jjwt-api'].bump, 'minor');
  assert.equal(d['org.mapstruct:mapstruct'].change, 'added');
  assert.equal(d['org.junit.jupiter:junit-jupiter'].scope, 'test');
  assert.equal(d['org.projectlombok:lombok'].change, 'removed');
  assert.equal(d['parent:org.springframework.boot:spring-boot-starter-parent'].bump, 'major');
});

test('deps: package.json sections and semver bumps', () => {
  const d = diffDeps('package.json',
    parsePackageJson('{"dependencies":{"react":"^18.3.1","axios":"1.7.0"},"devDependencies":{"vitest":"^2.0.0"}}'),
    parsePackageJson('{"dependencies":{"react":"^19.1.0","axios":"1.7.0","left-pad":"*"},"devDependencies":{"vitest":"^2.1.0"}}'));
  const m = Object.fromEntries(d.map((x) => [x.name, x]));
  assert.equal(m.react.bump, 'major');
  assert.equal(m.vitest.bump, 'minor');
  assert.equal(m['left-pad'].change, 'added');
  assert.ok(!m.axios);
  assert.equal(semverBump('1.2.3', '1.2.2'), 'downgrade');
  assert.deepEqual(parsePackageJson('not json'), {});
});

test('delta: fixed / new / still open by stable id', () => {
  const [a, b, c] = assignIds([F(), F({ anchor: 'A#y' }), F({ anchor: 'A#z' })], 'sfn-events-api');
  const prev = { scope: { repoKey: 'sfn-events-api', headSha: 'abc' }, verdict: 'fix_first', findings: [a, b] };
  const d = computeDelta(prev, [{ ...b, line: 99, title: 'reworded' }, c], 'sfn-events-api');
  assert.deepEqual(d.fixed.map((f) => f.id), [a.id]);
  assert.deepEqual(d.new.map((f) => f.id), [c.id]);
  assert.deepEqual(d.stillOpen.map((f) => f.id), [b.id]);
  assert.equal(computeDelta(prev, [], 'sfn-iam-api'), undefined);
});

test('verify (cross): may lower severity, never raise; reject drops; missing decision keeps', () => {
  const stats = { confirmed: 0, downgraded: 0, rejected: 0, unverified: 0 };
  const items = [F({ severity: 'major' }), F({ anchor: 'b' }), F({ anchor: 'c', confidence: 'possible' }), F({ anchor: 'd' })];
  const { kept, rejected } = applyDecisions(items, [
    { n: 0, decision: 'confirm', severity: 'blocker', verification: 'ok' },          // raise ignored
    { n: 1, decision: 'reject', verification: 'guard at X:12' },
    { n: 2, decision: 'downgrade', severity: 'minor', confidence: 'possible' },
  ], 'cross', stats);
  assert.equal(kept[0].severity, 'major');
  assert.equal(kept[0].crossVerification, 'ok');
  assert.equal(rejected[0].crossVerification, 'guard at X:12');
  assert.deepEqual([kept[1].severity, kept[1].confidence], ['minor', 'possible']);
  assert.equal(kept[2].crossVerification, 'no decision returned');
  assert.equal(kept[2].confidence, 'confirmed'); // cross never silently weakens an unanswered finding
  assert.deepEqual(stats, { confirmed: 1, downgraded: 1, rejected: 1, unverified: 1 });
});

test('verify (same): batches per specialist and survives a failing verifier', async () => {
  const findings = [...Array.from({ length: 17 }, (_, i) => F({ anchor: `A#${i}` })), F({ specialist: 'security', category: 'security', anchor: 'S' })];
  const seen = [];
  const { kept, rejected, stats } = await verifyFindings({
    findings, scopePath: '/s.json',
    ask: async ({ name, user }) => {
      seen.push(name);
      if (name === 'verify:security') throw new Error('boom');
      const batch = JSON.parse(user.split('```json\n')[1].split('\n```')[0]);
      return { decisions: batch.map((f) => ({ n: f.n, decision: f.n === 0 ? 'reject' : 'confirm' })) };
    },
  });
  assert.deepEqual(seen.sort(), ['verify:db', 'verify:db', 'verify:security']); // 17 db → batches of 15 + 2
  assert.equal(rejected.length, 2);
  assert.equal(kept.length, 16);
  assert.equal(kept.find((f) => f.anchor === 'S').confidence, 'possible');
  assert.equal(stats.unverified, 1);
});

test('verdict lib', () => {
  assert.equal(decideVerdict([F()]).verdict, 'fix_first');
  assert.equal(decideVerdict([]).verdict, 'ready');
});

test('noise cap: keeps blockers/majors, caps minors and nits, no nits at quick', async () => {
  const { trimNoise, sortFindings } = await import('../lib/findings.mjs');
  const mk = (severity, i, confidence = 'possible') => F({ severity, anchor: `${severity}${i}`, confidence });
  const list = sortFindings([mk('blocker', 1), ...Array.from({ length: 4 }, (_, i) => mk('major', i)),
    ...Array.from({ length: 8 }, (_, i) => mk('minor', i, i === 7 ? 'confirmed' : 'possible')), ...Array.from({ length: 5 }, (_, i) => mk('nit', i))]);
  const std = trimNoise(list, { maxMinor: 5, maxNit: 3 }, 'standard');
  assert.equal(std.kept.filter((f) => f.severity === 'major').length, 4);
  assert.equal(std.kept.filter((f) => f.severity === 'minor').length, 5);
  assert.ok(std.kept.some((f) => f.anchor === 'minor7')); // confirmed minor sorts first and survives
  assert.equal(std.kept.filter((f) => f.severity === 'nit').length, 3);
  assert.equal(std.trimmed.length, 5);
  const quick = trimNoise(list, { maxMinor: 5, maxNit: 3, nitsAtQuick: false }, 'quick');
  assert.equal(quick.kept.filter((f) => f.severity === 'nit').length, 0);
});

test('severity floors: critical rules never below their floor; original kept', async () => {
  const { applySeverityFloors } = await import('../lib/findings.mjs');
  const out = applySeverityFloors([F({ ruleId: 'SEC-003', severity: 'nit' }), F({ ruleId: 'SEC-003', severity: 'blocker' }), F({ ruleId: 'TST-001', severity: 'minor' })], { 'SEC-003': 'major' });
  assert.deepEqual(out.map((f) => [f.severity, f.ratedSeverity]), [['major', 'nit'], ['blocker', undefined], ['minor', undefined]]);
});

test('scope: Keycloak/IdP changes always get the security specialist', () => {
  const p = planReview([{ path: 'src/main/java/com/secufusion/tenant/util/KeycloakAdminUtil.java', added: 20, removed: 5 }], cfg.repos, cfg.review, 'auto', 'java-spring');
  assert.ok(p.specialists.includes('security'));
});

test('consensus: keeps repeated or verified-strong findings, hides one-off noise, fuzzy-matches across runs', async () => {
  const { mergeRuns } = await import('../lib/consensus.mjs');
  const run = (findings, extra = {}) => ({ summary: 'summary text', verdict: 'fix_first', verdictReason: 'r', rejectedCount: 1, blastRadius: { tables: ['t1'] }, specialistsRun: ['db'], findings, ...extra });
  const repeated = (line, anchor) => F({ ruleId: 'DB-006', severity: 'major', confidence: 'possible', file: 'src/P.java', line, anchor });
  const r = mergeRuns([
    run([repeated(40, 'P#purge'), F({ ruleId: 'GEN', severity: 'minor', confidence: 'possible', anchor: 'X#y', file: 'src/X.java' }), F({ ruleId: 'SEC-003', severity: 'major', confidence: 'confirmed', anchor: 'R#q', file: 'src/R.java' }),
      F({ ruleId: 'TST-003', severity: 'major', confidence: 'confirmed', anchor: 'T#t', file: 'src/T.java' })]),
    run([repeated(48, 'P#purgeAll'), F({ ruleId: 'TST-001', severity: 'minor', confidence: 'possible', anchor: 'Z#z', file: 'src/Z.java' })], { blastRadius: { tables: ['t2'] }, specialistsRun: ['security'] }),
  ], { criticalRules: ['SEC-003', 'DB-006'] });
  const by = Object.fromEntries(r.findings.map((f) => [f.ruleId, f.consensus]));
  assert.ok(!by['TST-003']);                  // confirmed major but not a critical rule: needs agreement
  assert.equal(by['DB-006'], '2/2');          // same file+rule, lines within 15, different anchor wording
  assert.equal(by['SEC-003'], '1/2');         // one run, but a confirmed major — kept
  assert.ok(!by.GEN && !by['TST-001']);       // one-off unconfirmed minors hidden
  assert.equal(r.consensus.seenOnce.length, 3);
  assert.deepEqual(r.blastRadius.tables, ['t1', 't2']);
  assert.deepEqual(r.specialistsRun.sort(), ['db', 'security']);
  assert.equal(r.rejectedCount, 2);
  assert.equal(r.verdict, 'fix_first');       // SEC-003 confirmed major
  assert.match(r.verdictReason, /consensus of 2 runs/);
  // a failed run is tolerated
  const one = mergeRuns([undefined, run([repeated(40, 'P#purge')])]);
  assert.equal(one.consensus.runs, 1);
  assert.equal(one.consensus.failedRuns, 1);
  assert.throws(() => mergeRuns([undefined, undefined]), /no usable run/);
});
