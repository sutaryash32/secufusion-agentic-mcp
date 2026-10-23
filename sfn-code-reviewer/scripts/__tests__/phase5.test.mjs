import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { linkBlastRadius, renderBlastSvg } from '../lib/blastmap.mjs';
import { assignIds } from '../lib/findings.mjs';
import { aggregate, isoWeek, renderDashboard } from '../lib/metrics.mjs';
import { loadConfig } from '../lib/paths.mjs';
import {
  analyseMigrations, diffConfig, envVars, featureFlags, flattenYaml, parseIncluded, parseProperties, releaseVerdict, surfaceChanges,
} from '../lib/release.mjs';
import { suggestReviewers } from '../lib/reviewers.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const run = promisify(execFile);
const cfg = loadConfig();
const GIT = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];
const F = (over = {}) => ({
  ruleId: 'DB-001', severity: 'blocker', confidence: 'confirmed', category: 'db', file: 'src/A.java', line: 3,
  anchor: 'A#x', title: 'Column without migration', problem: 'p'.repeat(12), failureScenario: 'f'.repeat(12), suggestion: 's', ...over,
});

test('reviewers: blame lines outweigh commits; excludes self and bots', () => {
  const blames = [{ file: 'a.java', blame: { lines: [{ sha: 'x' }, { sha: 'x' }, { sha: 'y' }, { sha: 'z' }], commits: { x: { author: 'Asha' }, y: { author: 'Me' }, z: { author: 'Azure Pipelines Bot' } } } }];
  const recent = [{ file: 'a.java', authors: ['Ravi', 'Ravi', 'Ravi', 'Me', 'Asha'] }];
  const r = suggestReviewers({ blames, recent, exclude: ['me'] });
  assert.deepEqual(r.map((x) => x.name), ['Asha', 'Ravi']);
  assert.match(r[0].why, /wrote 2 of the lines.*1 recent commit/);
  assert.equal(suggestReviewers({ blames, recent, exclude: [], max: 1 }).length, 1);
});

test('blast map: Kafka consumers, UI callers and shared tenant table become links; SVG renders', () => {
  const blast = { kafkaTopics: ['device-registration'], endpoints: ['GET /api/iam/users'], tables: ['tenant'] };
  const links = linkBlastRadius(blast, 'sfn-iam-api', cfg.repos);
  const has = (repo, group) => links.some((l) => l.repo === repo && l.group === group);
  assert.ok(has('sfn-events-api', 'kafkaTopics'));
  assert.ok(has('sfn-web-ui', 'endpoints'));
  assert.ok(has('sfn-tenants-api', 'tables') && has('sfn-events-api', 'tables'));
  assert.ok(!links.some((l) => l.repo === 'sfn-iam-api'));
  const svg = renderBlastSvg(blast, links, 'sfn-iam-api');
  assert.match(svg, /^<svg class="blastmap"/);
  assert.match(svg, /role="img"/);
  assert.equal(renderBlastSvg({}, [], 'x'), '');
  assert.ok(!renderBlastSvg({ endpoints: ['<script>'] }, [], 'x').includes('<script>'));
});

test('metrics: weekly severity buckets, rule ranking, reject rate; skipped runs excluded', () => {
  assert.equal(isoWeek('2026-10-21T10:00:00Z'), '2026-W43');
  const r1 = { verdict: 'fix_first', rejectedCount: 1, findings: assignIds([F(), F({ anchor: 'b', severity: 'minor', ruleId: 'SEC-003', category: 'security' })], 'sfn-iam-api'), scope: { repoKey: 'sfn-iam-api' }, engine: { provider: 'anthropic' } };
  const r2 = { verdict: 'ready', rejectedCount: 0, findings: [], scope: { repoKey: 'sfn-web-ui' }, engine: { provider: 'openai' }, delta: { fixed: [{ id: 'a' }] } };
  const skipped = { verdict: 'ready', findings: [], engine: { provider: 'none' }, scope: { repoKey: 'x' } };
  const m = aggregate([{ at: '2026-10-20T00:00:00Z', result: r1 }, { at: '2026-10-28T00:00:00Z', result: r2 }, { at: '2026-10-28T00:00:00Z', result: skipped }]);
  assert.equal(m.reviews, 2);
  assert.equal(m.skipped, 1);
  assert.deepEqual(m.weeks.map((w) => [w.week, w.blocker, w.minor]), [['2026-W43', 1, 1], ['2026-W44', 0, 0]]);
  assert.equal(m.topRules[0].ruleId, 'DB-001');
  assert.equal(m.verifyRejectRate, +(1 / 3).toFixed(3));
  assert.equal(m.fixedOnRereview, 1);
  const html = renderDashboard(m);
  assert.match(html, /Findings per week, by severity/);
  assert.match(html, /<details><summary>Table/);  // table view for every chart
  assert.match(html, /not attributed to people/);
});

test('release: included PRs/work items, migrations, config, env, flags, surface, verdict', () => {
  const inc = parseIncluded(['Merged PR 1498: WI 1140: make tenant hard delete async', 'fix BUG-1206 rollup', 'chore']);
  assert.deepEqual(inc.prs, [{ id: 1498, title: 'WI 1140: make tenant hard delete async' }]);
  assert.deepEqual(inc.workItems, [1140, 1206]);

  const mig = analyseMigrations(
    [{ status: 'A', path: 'db/V71__b.sql' }, { status: 'A', path: 'db/V70__a.sql' }, { status: 'M', path: 'db/V12__old.sql' }, { status: 'A', path: 'db/bad.sql' }],
    ['db/V12__old.sql', 'db/V42__x.sql', 'db/V42__y.sql', 'db/V70__a.sql', 'db/V71__b.sql'],
  );
  assert.deepEqual(mig.added.map((m) => m.version), [70, 71]);
  assert.deepEqual(mig.modified, ['db/V12__old.sql']);
  assert.deepEqual(mig.duplicates.map((d) => d.version), [42]);
  assert.deepEqual(mig.malformed, ['db/bad.sql']);

  assert.deepEqual(parseProperties('# c\na.b=1\nc.d = ${X:2}\n'), { 'a.b': '1', 'c.d': '${X:2}' });
  assert.deepEqual(flattenYaml('spring:\n  kafka:\n    bootstrap: "${KAFKA}"\nai-policy:\n  enabled: ${AI_POLICY_ENABLED:true}\n'),
    { 'spring.kafka.bootstrap': '${KAFKA}', 'ai-policy.enabled': '${AI_POLICY_ENABLED:true}' });
  const d = diffConfig('application.yml', { 'a': '1', 'gone': 'x' }, { 'a': '2', 'spring.kafka.bootstrap': '${KAFKA}', 'ai-policy.enabled': '${AI_POLICY_ENABLED:true}' });
  assert.deepEqual([d.added.length, d.removed.length, d.changed.length], [2, 1, 1]);
  const env = envVars([d]);
  assert.deepEqual(env.map((v) => [v.name, v.required]).sort(), [['AI_POLICY_ENABLED', false], ['KAFKA', true]]);
  const flags = featureFlags([d]);
  assert.equal(flags[0].onByDefault, true);

  const surface = surfaceChanges(['+    @PostMapping("/tenants/{id}/purge")', '-    @DeleteMapping("/tenants/{id}")', '+  public static final String TOPIC = "tenant-deleted";', '+    @GetMapping(value = "/x")', '-    @GetMapping(value = "/x")'].join('\n'));
  assert.deepEqual(surface.endpoints, { added: ['POST /tenants/{id}/purge'], removed: ['DELETE /tenants/{id}'] });
  assert.deepEqual(surface.topics.added, ['tenant-deleted']);

  const v = releaseVerdict({ migrations: mig, envVars: env, flags, dependencyChanges: [{ bump: 'major' }], surface });
  assert.equal(v.verdict, 'attention');
  assert.equal(v.attention.length, 7); // none of V70/V71 is below the prior head (V42)
});

test('release-check.mjs on a temp repo: migrations in order, env var without default', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sfn-rel-'));
  const repo = join(dir, 'sfn-iam-api');
  const mig = join(repo, 'src/main/resources/db/migration');
  mkdirSync(mig, { recursive: true });
  const g = (...a) => execFileSync('git', ['-C', repo, ...GIT, ...a]);
  execFileSync('git', ['init', '-q', '-b', 'develop', repo]);
  writeFileSync(join(mig, 'V1__init.sql'), 'create table t(id int);');
  writeFileSync(join(repo, 'src/main/resources/application.properties'), 'a=1\n');
  g('add', '-A'); g('commit', '-qm', 'init'); g('tag', '1.0.0');
  writeFileSync(join(mig, 'V3__c.sql'), 'select 1;');
  writeFileSync(join(mig, 'V2__b.sql'), 'select 1;');
  writeFileSync(join(repo, 'src/main/resources/application.properties'), 'a=1\nsync.url=${SYNC_URL}\n');
  g('add', '-A'); g('commit', '-qm', 'Merged PR 12: WI 345 add sync');
  const out = join(dir, 'out');
  await run('node', [join(root, 'scripts/release-check.mjs'), '--repo', repo, '--to', 'HEAD', '--out', out]);
  const r = JSON.parse(readFileSync(join(out, 'release-readiness.json'), 'utf8'));
  assert.equal(r.repos[0].from, '1.0.0');
  assert.deepEqual(r.repos[0].migrations.added.map((m) => m.version), [2, 3]);
  assert.deepEqual(r.repos[0].prs, [{ id: 12, title: 'WI 345 add sync' }]);
  assert.equal(r.verdict, 'attention');
  const md = readFileSync(join(out, 'release-readiness.md'), 'utf8');
  assert.ok(md.indexOf('V2__b.sql') < md.indexOf('V3__c.sql'));
  assert.match(md, /SYNC_URL.*no default/);
  assert.ok(existsSync(join(out, 'release-readiness.html')));
});

test('pre-push hook: install, chain an existing hook, block on a confirmed blocker, skip, uninstall', async () => {
  // A copy of the reviewer whose run-review.sh is a stub that writes a result with one confirmed blocker.
  const sandbox = mkdtempSync(join(tmpdir(), 'sfn-hook-'));
  const rev = join(sandbox, 'reviewer');
  for (const p of ['scripts', 'engines', 'config', 'package.json']) cpSync(join(root, p), join(rev, p), { recursive: true });
  const result = { summary: 'x'.repeat(12), verdict: 'fix_first', verdictReason: 'blocker', rejectedCount: 0, blastRadius: {}, findings: assignIds([F()], 'repo') };
  writeFileSync(join(rev, 'scripts/run-review.sh'), `#!/usr/bin/env bash
out=""; while [[ $# -gt 0 ]]; do [[ "$1" == --out ]] && out="$2"; shift; done
mkdir -p "$out"; echo '${JSON.stringify(result)}' > "$out/review-result.json"
`);
  const repo = join(sandbox, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, '.git/hooks/pre-push'), '#!/usr/bin/env bash\necho prev-ran >> "$(git rev-parse --show-toplevel)/prev.log"\n', { mode: 0o755 });
  writeFileSync(join(repo, 'a.txt'), 'a');
  execFileSync('git', ['-C', repo, ...GIT, 'add', '-A']);
  execFileSync('git', ['-C', repo, ...GIT, 'commit', '-qm', 'a']);
  const sha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  const { stdout } = await run('bash', [join(rev, 'scripts/install-hook.sh'), repo]);
  assert.match(stdout, /existing pre-push hook kept/);
  const hook = join(repo, '.git/hooks/pre-push');
  const stdin = `refs/heads/main ${sha} refs/heads/main ${'0'.repeat(40)}\n`;
  const runHook = (env = {}) => new Promise((ok) => {
    const p = execFile('bash', [hook, 'origin', 'url'], { cwd: repo, env: { ...process.env, ...env } }, (err, out, errOut) => ok({ code: err ? err.code : 0, err: errOut }));
    p.stdin.end(stdin);
  });
  const blocked = await runHook();
  assert.equal(blocked.code, 1);
  assert.match(blocked.err, /push blocked/);
  assert.match(readFileSync(join(repo, 'prev.log'), 'utf8'), /prev-ran/);
  assert.equal((await runHook({ SFN_SKIP_REVIEW: '1' })).code, 0);

  await run('bash', [join(rev, 'scripts/install-hook.sh'), repo, '--uninstall']);
  assert.match(readFileSync(hook, 'utf8'), /prev-ran/); // original hook restored
});

test('feedback: classifies thread outcomes and computes precision + tuning suggestions', async () => {
  const { classifyThread, aggregateFeedback } = await import('../lib/feedback.mjs');
  const { formatFindingComment } = await import('../lib/ado.mjs');
  const [f] = assignIds([F({ ruleId: 'SEC-004', severity: 'major' })], 'sfn-iam-api');
  const first = { content: formatFindingComment(f) };
  const auto = { content: 'No longer detected by sfn-code-reviewer at abc.' };
  assert.equal(classifyThread({ status: 'fixed', comments: [first, auto] }, 'active').outcome, 'fixed_by_code');
  assert.equal(classifyThread({ status: 'fixed', comments: [first] }, 'active').outcome, 'resolved');
  assert.equal(classifyThread({ status: 'wontFix', comments: [first] }, 'completed').outcome, 'dismissed');
  assert.equal(classifyThread({ status: 'byDesign', comments: [first] }, 'completed').outcome, 'dismissed');
  assert.equal(classifyThread({ status: 'active', comments: [first] }, 'completed').outcome, 'ignored');
  assert.equal(classifyThread({ status: 'active', comments: [first] }, 'active').outcome, 'open');
  assert.equal(classifyThread({ status: 'active', comments: [{ content: 'human comment' }] }, 'active'), undefined);
  const c = classifyThread({ status: 'fixed', comments: [first] }, 'active');
  assert.deepEqual([c.ruleId, c.severity, c.confidence], ['SEC-004', 'major', 'confirmed']);

  const mk = (outcome, ruleId = 'SEC-004') => ({ repo: 'r', pr: 1, url: 'u', outcome: { id: 'x', ruleId, severity: 'major', confidence: 'confirmed', outcome } });
  const fb = aggregateFeedback([mk('dismissed'), mk('dismissed'), mk('dismissed'), mk('resolved'), mk('fixed_by_code', 'DB-001'), mk('ignored', 'DB-001')]);
  assert.equal(fb.totals.precision, +(2 / 5).toFixed(3));
  assert.equal(fb.rules.find((r) => r.ruleId === 'SEC-004').precision, 0.25);
  assert.equal(fb.rules.find((r) => r.ruleId === 'DB-001').precision, 1);
  assert.deepEqual(fb.suggestions.map((s) => s.ruleId), ['SEC-004']);
  assert.match(renderDashboard(aggregate([]), { feedback: { days: 30, ...fb } }), /Precision from PR outcomes/);
});

test('walkthrough + test plan: schema accepts, PR summary and report render them', async () => {
  const { createValidator } = await import('../lib/validate.mjs');
  const { formatSummary } = await import('../lib/ado.mjs');
  const { renderReport } = await import('../lib/report.mjs');
  const dir = join(root, 'engines/anthropic/skills/review/schemas');
  const v = createValidator(['finding.schema.json', 'review-result.schema.json'].map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8'))));
  const r = {
    schemaVersion: 1, summary: 'Adds a retention endpoint.', blastRadius: {}, findings: [], rejectedCount: 0, verdict: 'ready', verdictReason: 'No findings.',
    walkthrough: [{ area: 'Retention endpoint', files: ['TenantController.java'], change: 'New PUT /api/tenants/{id}/retention with three authorization checks.' }],
    testPlan: ["As a child-tenant admin, PUT another tenant's retention and expect 403."],
  };
  assert.deepEqual(v('review-result.schema.json', r), []);
  assert.ok(v('review-result.schema.json', { ...r, walkthrough: [{ area: 'x' }] }).length > 0);
  const md = formatSummary({ ...r, scope: { repoKey: 'sfn-tenants-api' } });
  assert.match(md, /<b>Walkthrough<\/b> — 1 area/);
  assert.match(md, /- \[ \] As a child-tenant admin/);
  const html = renderReport({ ...r, scope: { repoKey: 'sfn-tenants-api', risk: {} }, engine: {} });
  assert.match(html, /<h2>Walkthrough<\/h2>/);
  assert.match(html, /type="checkbox"> As a child-tenant admin, PUT another tenant&#39;s retention/);
});
