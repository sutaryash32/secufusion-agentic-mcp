import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { authHeaders, parseRemote } from '../lib/ado-api.mjs';
import { bugFields, existingBugsQuery, selectFindings, toPatch } from '../lib/boards.mjs';
import { shapeSnapshot, snapshotSql } from '../lib/dbschema.mjs';
import { assignIds } from '../lib/findings.mjs';
import { buildHints, parseBlamePorcelain, parseOldRanges } from '../lib/history.mjs';
import { auditWithOsv, buildQueries, fixedVersions, lockVersions, severityOf } from '../lib/osv.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const run = promisify(execFile);
const GIT = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];
const F = (over = {}) => ({
  ruleId: 'DB-001', severity: 'blocker', confidence: 'confirmed', category: 'db', file: 'src/A.java', line: 3,
  anchor: 'A#x', title: 'Column <x> without migration', problem: 'p'.repeat(12), failureScenario: 'f'.repeat(12),
  suggestion: 'add migration', ...over,
});

test('ado: parse Azure Repos remotes', () => {
  assert.deepEqual(parseRemote('https://secufusion@dev.azure.com/secufusion/SFCloud-MSSP/_git/sfn-iam-api'),
    { org: 'secufusion', project: 'SFCloud-MSSP', repo: 'sfn-iam-api', collectionUri: 'https://dev.azure.com/secufusion/' });
  assert.equal(parseRemote('git@ssh.dev.azure.com:v3/secufusion/SFCloud-MSSP/sfn-web-ui').repo, 'sfn-web-ui');
  assert.equal(parseRemote('https://secufusion.visualstudio.com/DefaultCollection/SFCloud%20MSSP/_git/x').project, 'SFCloud MSSP');
  assert.equal(parseRemote('https://github.com/a/b.git'), undefined);
});

test('ado: auth precedence — pipeline token, PAT, az login, else a clear error', () => {
  const noAz = () => { throw new Error('no az'); };
  assert.equal(authHeaders({ SYSTEM_ACCESSTOKEN: 'tok' }, noAz).Authorization, 'Bearer tok');
  assert.equal(authHeaders({ SYSTEM_ACCESSTOKEN: '$(System.AccessToken)', AZURE_DEVOPS_PAT: 'p' }, noAz).Authorization, `Basic ${Buffer.from(':p').toString('base64')}`);
  assert.equal(authHeaders({}, () => 'aztoken\n').Authorization, 'Bearer aztoken');
  assert.throws(() => authHeaders({}, noAz), /az login/);
});

test('history: -U0 ranges, blame porcelain, fix-only and age-limited hints', () => {
  const diff = ['diff --git a/x.java b/x.java', '--- a/x.java', '+++ b/x.java', '@@ -10,2 +10,0 @@', '-a', '-b', '@@ -20 +18 @@', '-c', '+d', '@@ -30,0 +29,2 @@', '+e', '+f'].join('\n');
  assert.deepEqual(parseOldRanges(diff), { 'x.java': [[10, 11], [20, 20]] });
  const sha1 = 'a'.repeat(40);
  const sha2 = 'b'.repeat(40);
  const now = 1_800_000_000;
  const porcelain = [
    `${sha1} 10 10 2`, 'author Dev', `author-time ${now - 86400}`, 'summary fix(tenant-delete): delete incident links first', '\tline',
    `${sha1} 11 11`, '\tline',
    `${sha2} 20 20 1`, 'author Dev', `author-time ${now - 86400}`, 'summary refactor: rename', '\tline',
  ].join('\n');
  const blame = parseBlamePorcelain(porcelain);
  assert.equal(blame.lines.length, 3);
  const hints = buildHints([{ file: 'x.java', blame }], /\bfix\b/i, 365, now);
  assert.equal(hints.length, 1);
  assert.deepEqual(hints[0].oldLines, ['10-11']);
  assert.equal(hints[0].commit, 'aaaaaaaaaa');
  assert.equal(buildHints([{ file: 'x.java', blame }], /\bfix\b/i, 0, now).length, 0); // too old
});

test('history: collect-scope flags a change that rewrites a fix', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sfn-hist-'));
  const repo = join(dir, 'sfn-x');
  mkdirSync(join(repo, 'src'), { recursive: true });
  const g = (...a) => execFileSync('git', ['-C', repo, ...GIT, ...a]);
  execFileSync('git', ['init', '-q', '-b', 'develop', repo]);
  writeFileSync(join(repo, 'src/Purge.java'), 'class Purge {\n  void run() {\n    deleteEvents();\n  }\n}\n');
  g('add', '-A'); g('commit', '-qm', 'initial');
  writeFileSync(join(repo, 'src/Purge.java'), 'class Purge {\n  void run() {\n    deleteIncidentLinks();\n    deleteEvents();\n  }\n}\n');
  g('add', '-A'); g('commit', '-qm', 'fix(BUG-1140): delete incident links before events');
  g('checkout', '-qb', 'feature');
  writeFileSync(join(repo, 'src/Purge.java'), 'class Purge {\n  void run() {\n    deleteEvents();\n  }\n}\n');
  g('add', '-A'); g('commit', '-qm', 'simplify purge');
  const out = join(dir, 'scope.json');
  await run('node', [join(root, 'scripts/collect-scope.mjs'), '--repo', repo, '--base', 'develop', '--out', out]);
  const scope = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(scope.historyHints.length, 1);
  assert.match(scope.historyHints[0].subject, /BUG-1140/);
  assert.deepEqual(scope.historyHints[0].oldLines, ['3']);
});

test('osv: lockfile versions, query building, severity and fixed versions', async () => {
  const lock = lockVersions(JSON.stringify({ packages: { '': {}, 'node_modules/axios': { version: '1.7.2' }, 'node_modules/@mui/material': { version: '7.3.4' }, 'node_modules/a/node_modules/axios': { version: '0.1.0' } } }));
  assert.deepEqual(lock, { axios: '1.7.2', '@mui/material': '7.3.4' });
  const { queries, skipped } = buildQueries([
    { manifest: 'package.json', name: 'axios', change: 'changed', to: '^1.7.0' },
    { manifest: 'pom.xml', name: 'com.x:lib', change: 'added', to: '2.1.0' },
    { manifest: 'pom.xml', name: 'com.x:managed', change: 'added', to: 'managed' },
    { manifest: 'pom.xml', name: 'com.x:gone', change: 'removed', from: '1.0' },
    { manifest: 'package.json', name: 'left-pad', change: 'added', to: '*' },
  ], lock);
  assert.deepEqual(queries.map((q) => [q.package.ecosystem, q.package.name, q.version]), [['npm', 'axios', '1.7.2'], ['Maven', 'com.x:lib', '2.1.0']]);
  assert.equal(skipped.length, 2);
  const vuln = { id: 'GHSA-1', database_specific: { severity: 'MODERATE' }, affected: [{ package: { name: 'axios' }, ranges: [{ events: [{ introduced: '0' }, { fixed: '1.7.4' }] }] }] };
  assert.equal(severityOf(vuln), 'MEDIUM');
  assert.deepEqual(fixedVersions(vuln, 'axios'), ['1.7.4']);

  const fetchImpl = async (url, init) => {
    if (url.endsWith('/v1/querybatch')) {
      const body = JSON.parse(init.body);
      return { ok: true, json: async () => ({ results: body.queries.map((q) => (q.package.name === 'axios' ? { vulns: [{ id: 'GHSA-1' }] } : {})) }) };
    }
    return { ok: true, json: async () => ({ ...vuln, aliases: ['CVE-2026-0001'], summary: 'SSRF' }) };
  };
  const res = await auditWithOsv({ queries, fetchImpl });
  assert.equal(res.length, 1);
  assert.equal(res[0].name, 'axios');
  assert.deepEqual(res[0].vulns[0].aliases, ['CVE-2026-0001']);
});

test('boards: selection, escaping, tags, patch, idempotency query', () => {
  const fs = assignIds([F(), F({ anchor: 'b', severity: 'major' }), F({ anchor: 'c', confidence: 'possible' })], 'sfn-iam-api');
  const r = { findings: fs, scope: { repoKey: 'sfn-iam-api', headSha: '0123456789abcdef' } };
  assert.equal(selectFindings(r).length, 1);
  assert.equal(selectFindings(r, { minSeverity: 'major' }).length, 2);
  assert.equal(selectFindings(r, { minSeverity: 'major', confirmedOnly: false }).length, 3);
  const b = bugFields(fs[0], { repoKey: 'sfn-iam-api', headSha: '0123456789abcdef' });
  assert.match(b.title, /^\[sfn-review\] DB-001: Column <x>/);
  assert.match(b.reproSteps, /Column &lt;x&gt;|0123456789/);
  assert.ok(!b.reproSteps.includes('<x>'));
  assert.ok(b.tags.includes(`sfn-finding-${fs[0].id}`));
  const patch = toPatch(b, { areaPath: 'SFCloud-MSSP', iterationPath: undefined });
  assert.ok(patch.some((o) => o.path === '/fields/System.AreaPath'));
  assert.ok(!patch.some((o) => o.path === '/fields/System.IterationPath'));
  assert.match(existingBugsQuery("O'Brien", [fs[0].id]), /'O''Brien'.*sfn-finding-/);
});

test('dbschema: rejects unsafe schema names; shapes FKs both ways', () => {
  assert.throws(() => snapshotSql(['public; drop table x']), /invalid schema/);
  assert.match(snapshotSql(['public']), /information_schema\.columns/);
  const t = shapeSnapshot({
    columns: [{ t: 'public.events', c: 'id', type: 'uuid', nullable: false, default: null }],
    fks: [{ t: 'public.incident_events', name: 'fk_ev', def: 'FOREIGN KEY (fk_event_id) REFERENCES events(id)', refTable: 'public.events', onDelete: 'a' }],
    indexes: [{ t: 'public.events', name: 'events_pkey', def: 'CREATE UNIQUE INDEX events_pkey ON public.events USING btree (id)' }],
  });
  assert.deepEqual(t['public.events'].columns, ['id uuid NOT NULL']);
  assert.match(t['public.incident_events'].foreignKeys[0], /ON DELETE NO ACTION/);
  assert.match(t['public.events'].referencedBy[0], /public\.incident_events via fk_ev/);
});

test('db-snapshot.mjs: uses psql read-only, patches the scope, never leaks the URL', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sfn-db-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  // Stub psql: asserts the read-only options, then prints a snapshot.
  writeFileSync(join(bin, 'psql'), `#!/usr/bin/env bash
[[ "$PGOPTIONS" == *default_transaction_read_only=on* ]] || { echo "not read-only" >&2; exit 9; }
[[ "\${@: -1}" == postgres://* ]] || exit 8
echo '{"columns":[{"t":"public.devices","c":"id","type":"text","nullable":false,"default":null}],"fks":[],"indexes":[]}'
`);
  chmodSync(join(bin, 'psql'), 0o755);
  const scopePath = join(dir, 'scope.json');
  writeFileSync(scopePath, JSON.stringify({ repoConfig: { stack: 'java-spring' } }));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, SFN_FORCE_LIVEDB: '1', SFN_REVIEW_DB_URL: 'postgres://ro:secret@db/x' };
  const { stderr } = await run('node', [join(root, 'scripts/db-snapshot.mjs'), '--scope', scopePath, '--out', join(dir, 'db.json')], { env });
  assert.match(stderr, /1 tables/);
  const scope = JSON.parse(readFileSync(scopePath, 'utf8'));
  assert.equal(scope.dbSchemaFile, join(dir, 'db.json'));
  assert.ok(JSON.parse(readFileSync(join(dir, 'db.json'), 'utf8')).tables['public.devices']);

  writeFileSync(join(bin, 'psql'), '#!/usr/bin/env bash\necho "could not connect to postgres://ro:secret@db/x" >&2; exit 2\n');
  writeFileSync(scopePath, JSON.stringify({ repoConfig: { stack: 'java-spring' } }));
  const failed = await run('node', [join(root, 'scripts/db-snapshot.mjs'), '--scope', scopePath, '--out', join(dir, 'db2.json')], { env });
  assert.ok(!failed.stderr.includes('secret'));
  assert.match(failed.stderr, /<db-url>/);
  assert.equal(JSON.parse(readFileSync(scopePath, 'utf8')).dbSchemaFile, undefined);
});

function fakeAdo() {
  const calls = [];
  const created = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c)).on('end', () => {
      calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : undefined, type: req.headers['content-type'] });
      res.setHeader('content-type', 'application/json');
      if (req.url.includes('/_apis/wit/wiql')) return res.end(JSON.stringify({ workItems: created.length ? [{ id: 501 }] : [] }));
      if (req.url.includes('/_apis/wit/workitems?ids=')) return res.end(JSON.stringify({ value: [{ id: 501, fields: { 'System.Tags': created[0] } }] }));
      if (req.url.includes('/_apis/wit/workitems/$Bug')) {
        created.push(JSON.parse(body).find((o) => o.path === '/fields/System.Tags').value);
        return res.end(JSON.stringify({ id: 501, _links: { html: { href: 'https://ado/501' } } }));
      }
      if (req.url.includes('/pullRequests/77/threads') && req.method === 'GET') return res.end(JSON.stringify({ value: [] }));
      if (req.url.includes('/pullRequests/77/threads')) return res.end(JSON.stringify({ id: 1 }));
      res.statusCode = 404;
      res.end('{}');
    });
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, calls, url: `http://127.0.0.1:${server.address().port}/` })));
}

test('create-ado-bugs.mjs: preview creates nothing; confirm creates once; re-run skips', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sfn-bugs-'));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://dev.azure.com/acme/Proj/_git/sfn-iam-api']);
  const resultPath = join(dir, 'result.json');
  writeFileSync(resultPath, JSON.stringify({ findings: assignIds([F()], 'sfn-iam-api'), scope: { repoKey: 'sfn-iam-api', headSha: 'abc' } }));
  const { server, calls, url } = await fakeAdo();
  const env = { ...process.env, SFN_ADO_BASE_URL: url, AZURE_DEVOPS_PAT: 'pat', SYSTEM_ACCESSTOKEN: '' };
  const args = [join(root, 'scripts/create-ado-bugs.mjs'), '--in', resultPath, '--repo', dir, '--iteration', 'backlog'];
  try {
    const preview = await run('node', args, { env });
    assert.match(preview.stdout, /PREVIEW — nothing created\. 1 Bug/);
    assert.ok(!calls.some((c) => c.method === 'POST' && c.url.includes('$Bug')));

    await run('node', [...args, '--confirm'], { env });
    const post = calls.find((c) => c.url.includes('$Bug'));
    assert.equal(post.type, 'application/json-patch+json');
    assert.match(post.auth, /^Basic /);
    assert.ok(post.url.startsWith('/Proj/_apis/wit/workitems/$Bug?api-version=7.1'));

    const again = await run('node', [...args, '--confirm'], { env });
    assert.match(again.stdout, /Created 0 work item\(s\); 1 already filed/);
    assert.equal(calls.filter((c) => c.url.includes('$Bug')).length, 1);
  } finally {
    server.close();
  }
});

test('post-ado-pr.mjs: posts to a PR reviewed locally with --pr (no pipeline env)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sfn-post-'));
  const resultPath = join(dir, 'result.json');
  writeFileSync(resultPath, JSON.stringify({
    summary: 'Adds a column.', verdict: 'fix_first', verdictReason: 'blocker', rejectedCount: 0, blastRadius: {},
    findings: assignIds([F()], 'sfn-iam-api'),
    scope: { repoKey: 'sfn-iam-api', headSha: 'abc', pr: { id: 77, collectionUri: 'https://dev.azure.com/acme/', project: 'Proj', repositoryId: 'repo-guid' } },
  }));
  const { server, calls, url } = await fakeAdo();
  const env = { ...process.env, SFN_ADO_BASE_URL: url, AZURE_DEVOPS_PAT: 'pat', SYSTEM_ACCESSTOKEN: '', SYSTEM_PULLREQUEST_PULLREQUESTID: '' };
  try {
    const { stdout } = await run('node', [join(root, 'scripts/post-ado-pr.mjs'), '--in', resultPath], { env });
    assert.match(stdout, /PR 77: 1 new inline/);
    const posts = calls.filter((c) => c.method === 'POST');
    assert.equal(posts.length, 2); // one inline thread + summary
    assert.ok(posts.every((c) => c.url.startsWith('/Proj/_apis/git/repositories/repo-guid/pullRequests/77/threads')));
    assert.equal(posts[0].body.threadContext.filePath, '/src/A.java');
  } finally {
    server.close();
  }
});
