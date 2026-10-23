import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { branchHasKey, extractKeys, findDeployOrder } from '../lib/deployorder.mjs';
import { parseAddedLines, quickCheck } from '../lib/quickcheck.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const run = promisify(execFile);
const GIT = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];
const g = (repo, ...a) => execFileSync('git', ['-C', repo, ...GIT, ...a], { encoding: 'utf8' }).trim();

test('quick-check: added-line parsing keeps new-file line numbers', () => {
  const diff = ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -3,0 +4,2 @@', '+one', '+two', '@@ -10 +12 @@', '-old', '+new'].join('\n');
  assert.deepEqual(parseAddedLines(diff), { x: [{ line: 4, text: 'one' }, { line: 5, text: 'two' }, { line: 12, text: 'new' }] });
});

test('quick-check: migrations, columns, endpoints, secrets, flags, events-api deletes', () => {
  const ctrl = 'src/main/java/a/controller/ThingController.java';
  const files = {
    [ctrl]: [
      'public class ThingController {',
      '    @PutMapping("/{id}/x")',
      '    @Operation(',
      '            summary = "multi-line",',
      '            description = "spans lines")',
      '    @PreAuthorize("hasAuthority(\'x.update\')")',
      '    public ResponseEntity<Void> guarded(@PathVariable String id) { return null; }',
      '',
      '    @DeleteMapping("/{id}")',
      '    public ResponseEntity<Void> open(@PathVariable String id) { return null; }',
      '',
      '    @PostMapping("/login")',
      '    public ResponseEntity<Void> login() { return null; }',
      '}',
    ].join('\n'),
  };
  const added = {
    [ctrl]: [{ line: 2, text: '    @PutMapping("/{id}/x")' }, { line: 9, text: '    @DeleteMapping("/{id}")' }, { line: 12, text: '    @PostMapping("/login")' }],
    'src/main/java/a/entity/Device.java': [{ line: 20, text: '    @Column(name = "last_seen_ip")' }, { line: 22, text: '    @Column(name = "mac_id")' }],
    'src/main/resources/application.properties': [{ line: 3, text: 'feature.x=${X_ENABLED:true}' }, { line: 4, text: 'db.password=Sup3rS3cretValue' }, { line: 5, text: 'db.password=${DB_PASSWORD}' }],
    'src/main/java/a/repository/R.java': [{ line: 7, text: '    deviceRepository.deleteById(id);' }, { line: 8, text: '  @Query("DELETE FROM events e WHERE e.x = 1")' }],
    'src/main/resources/db/migration/V9__dedupe.sql': [{ line: 2, text: 'DELETE FROM devices WHERE dup = true;' }],
  };
  const base = { repoKey: 'sfn-events-api', stack: 'java-spring', added, read: (p) => files[p] ?? '', allowlist: 'Set.of("ThingController#login")',
    columnKnownElsewhere: (c) => c === 'mac_id',
    baseMigrations: ['src/main/resources/db/migration/V1__a.sql', 'src/main/resources/db/migration/V8__b.sql'],
    changedFiles: [
      { path: ctrl, status: 'M' }, { path: 'src/main/resources/db/migration/V1__a.sql', status: 'M' },
      { path: 'src/main/resources/db/migration/V7__late.sql', status: 'A' }, { path: 'src/main/resources/db/migration/V8__dup.sql', status: 'A' },
      { path: 'src/main/resources/db/migration/bad_name.sql', status: 'A' }, { path: 'src/main/resources/db/migration/V9__dedupe.sql', status: 'A' },
    ] };
  const f = quickCheck(base);
  const by = (rule) => f.filter((x) => x.ruleId === rule);
  assert.equal(by('DB-002').length, 1);
  assert.deepEqual(by('DB-003').map((x) => x.file.split('/').pop()).sort(), ['V7__late.sql', 'V8__dup.sql', 'bad_name.sql']);
  assert.deepEqual(by('DB-001').map((x) => x.anchor), ['Device#last_seen_ip']);           // mac_id exists in a sibling repo
  assert.deepEqual(by('SEC-001').map((x) => x.anchor), ['ThingController#open']);          // guarded below a multi-line @Operation; login allowlisted
  assert.equal(by('SEC-016').length, 1);
  assert.equal(by('SEC-008').length, 1);                                                    // ${DB_PASSWORD} placeholder is fine
  const del = by('DB-007');
  assert.equal(del.length, 1);                                                             // grouped per file, migrations excluded
  assert.equal(del[0].evidence.length, 2);
});

test('quick-check: web-ui axios / inline URL / currentUser.tenantId / misplaced tests', () => {
  const f = quickCheck({ repoKey: 'sfn-web-ui', stack: 'react-vite', read: () => '', baseMigrations: [],
    changedFiles: [{ path: 'src/modules/X/X.test.jsx', status: 'A' }, { path: 'src/__tests__/Y.test.jsx', status: 'A' }],
    added: { 'src/modules/X/X.jsx': [{ line: 1, text: "import axios from 'axios';" }, { line: 9, text: "  api.get(`/api/events/devices`)" }, { line: 12, text: 'list(currentUser.tenantId)' }],
      'src/utils/axiosConfig.js': [{ line: 1, text: "import axios from 'axios';" }] } });
  assert.deepEqual(f.map((x) => x.ruleId).sort(), ['CON-007', 'CON-007', 'SEC-014', 'TST-008']);
});

test('deploy-order: keys from branch and messages; branch matching is token-exact', () => {
  assert.deepEqual(extractKeys('feature/1093-dedicated-retention', ['Merged PR 1381: Feature/1093 x', 'WI 1288: y', 'bump to 1.0.10']).sort(), ['1093', '1288']);
  assert.deepEqual(extractKeys('fix/BUG-1140-async', []), ['1140']);
  assert.ok(branchHasKey('origin/feature/1093-global-retention-cleanup', '1093'));
  assert.ok(!branchHasKey('origin/feature/10930-other', '1093'));
});

test('deploy-order: flags an unmerged counterpart branch in a sibling repo, not a merged one', () => {
  const estate = mkdtempSync(join(tmpdir(), 'sfn-deploy-'));
  const other = join(estate, 'sfn-events-api');
  mkdirSync(other);
  execFileSync('git', ['init', '-q', '-b', 'develop', other]);
  writeFileSync(join(other, 'a'), 'a'); g(other, 'add', '-A'); g(other, 'commit', '-qm', 'base');
  g(other, 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
  g(other, 'checkout', '-qb', 'feature/1093-cleanup'); writeFileSync(join(other, 'b'), 'b'); g(other, 'add', '-A'); g(other, 'commit', '-qm', 'cleanup');
  g(other, 'update-ref', 'refs/remotes/origin/feature/1093-cleanup', 'HEAD');
  g(other, 'update-ref', 'refs/remotes/origin/feature/1093-merged-part', 'develop');          // already in develop
  const f = findDeployOrder({ repoKey: 'sfn-tenants-api', estateRoot: estate, branch: 'feature/1093-retention', subjects: [], repoKeys: ['sfn-tenants-api', 'sfn-events-api'] });
  assert.equal(f.length, 1);
  assert.equal(f[0].ruleId, 'CON-011');
  assert.equal(f[0].repo, 'sfn-events-api');
  assert.match(f[0].title, /#1093 in sfn-events-api \(feature\/1093-cleanup\) is not merged/);
  assert.equal(findDeployOrder({ repoKey: 'sfn-tenants-api', estateRoot: estate, branch: 'feature/2000-x', subjects: [], repoKeys: ['sfn-events-api'] }).length, 0);
});

test('auto-learn: closed bugs from Boards become history cases + a report', async () => {
  const estate = mkdtempSync(join(tmpdir(), 'sfn-autolearn-'));
  const repo = join(estate, 'sfn-tenants-api');
  mkdirSync(join(repo, 'src/main/java/x'), { recursive: true });
  const file = 'src/main/java/x/Purge.java';
  execFileSync('git', ['init', '-q', '-b', 'develop', repo]);
  writeFileSync(join(repo, file), 'class Purge {\n  void run() {\n    deleteIncidentLinks();\n    deleteEvents();\n  }\n}\n');
  g(repo, 'add', '-A'); g(repo, 'commit', '-qm', 'initial');
  g(repo, 'checkout', '-qb', 'feature/speedup');
  writeFileSync(join(repo, file), 'class Purge {\n  // faster\n  void run() {\n    deleteEvents();\n  }\n}\n');
  g(repo, 'commit', '-qam', 'speed up'); g(repo, 'checkout', '-q', 'develop');
  g(repo, 'merge', '--no-ff', '-q', '-m', 'Merged PR 77: Speed up purge', 'feature/speedup');
  writeFileSync(join(repo, file), 'class Purge {\n  // faster\n  void run() {\n    deleteIncidentLinks(); deleteEvents();\n  }\n}\n');
  g(repo, 'commit', '-qam', 'WI 1140: delete incident links first');
  g(repo, 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
  g(repo, 'remote', 'add', 'origin', 'https://dev.azure.com/acme/Proj/_git/sfn-tenants-api');
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.includes('/_apis/wit/wiql')) return res.end(JSON.stringify({ workItems: [{ id: 1140 }, { id: 4242 }] }));
    if (req.url.includes('/_apis/wit/workitems?ids=')) return res.end(JSON.stringify({ value: [{ id: 1140, fields: { 'System.Title': 'Delete fails' } }, { id: 4242, fields: { 'System.Title': 'Unrelated' } }] }));
    if (req.url.includes('/_apis/wit/workitems/')) return res.end(JSON.stringify({ relations: [] }));
    res.statusCode = 404; res.end('{}');
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const out = join(estate, 'evals');
  try {
    const { stdout } = await run('node', [join(root, 'evals/auto-learn.mjs'), '--estate', estate, '--out-dir', out],
      { env: { ...process.env, SFN_ADO_BASE_URL: `http://127.0.0.1:${server.address().port}/`, AZURE_DEVOPS_PAT: 'p', SYSTEM_ACCESSTOKEN: '' } });
    assert.match(stdout, /\| #1140 Delete fails \| sfn-tenants-api \| case created \|/);
    assert.match(stdout, /\| #4242 Unrelated \| – \| skipped \|/);
    assert.ok(existsSync(join(out, 'cases/history-tenants-api-bug1140/case.json')));
    assert.equal(JSON.parse(readFileSync(join(out, 'cases/history-tenants-api-bug1140/case.json'), 'utf8')).source.pr, 77);
    const again = await run('node', [join(root, 'evals/auto-learn.mjs'), '--estate', estate, '--out-dir', out, '--bug', '1140']);
    assert.match(again.stdout, /already learned 1/);
  } finally {
    server.close();
  }
});
