import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { parseJsonWithKey, runAgent } from '../lib/agent.mjs';
import { createBudget, createClient } from '../lib/client.mjs';
import { decideVerdict, orchestrate } from '../lib/orchestrate.mjs';
import { createTools } from '../lib/tools.mjs';
import { readFileSync } from 'node:fs';
import { bundleDir } from '../../../scripts/lib/paths.mjs';

const schemas = ['finding.schema.json', 'review-result.schema.json'].map((f) => JSON.parse(readFileSync(join(bundleDir(), 'schemas', f), 'utf8')));
const F = (over = {}) => ({
  ruleId: 'DB-001', severity: 'blocker', confidence: 'possible', category: 'db', file: 'src/A.java', line: 3,
  anchor: 'A#x', title: 'Column without migration', problem: 'Mapped column has no DDL.',
  failureScenario: 'Deploy then first query fails.', suggestion: 'Add a migration.', ...over,
});

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'sfn-tools-'));
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'A.java'), 'class A {\n  int x;\n}\n');
  writeFileSync(join(root, 'secret.txt'), 'top secret');
  symlinkSync(join(root, 'secret.txt'), join(repo, 'link.txt'));
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'x']);
  return { root, repo, tools: createTools({ repoPath: repo, roots: [repo] }) };
}

test('tools: read_file numbers lines and stays inside the roots', async () => {
  const { root, tools } = sandbox();
  assert.match(await tools.exec('read_file', { path: 'src/A.java' }), /^1\tclass A \{\n2\t  int x;/);
  assert.match(await tools.exec('read_file', { path: join(root, 'secret.txt') }), /access denied/);
  assert.match(await tools.exec('read_file', { path: 'link.txt' }), /access denied/); // symlink escape
  assert.match(await tools.exec('read_file', { path: '../secret.txt' }), /access denied/);
});

test('tools: git is read-only', async () => {
  const { repo, tools } = sandbox();
  assert.match(await tools.exec('git', { args: ['log', '--oneline'] }), /x/);
  assert.match(await tools.exec('git', { args: ['push'] }), /not allowed/);
  assert.match(await tools.exec('git', { args: ['commit', '-m', 'y'] }), /not allowed/);
  assert.match(await tools.exec('git', { args: ['diff', '--output=/tmp/pwn', 'HEAD'] }), /argument not allowed/);
  assert.match(await tools.exec('git', { args: ['diff', '--no-index', '/etc/hosts', 'x'] }), /argument not allowed/);
  assert.match(await tools.exec('git', { repo: '/', args: ['log'] }), /access denied/);
  assert.ok(repo);
});

test('tools: grep, glob, list_dir, bad args', async () => {
  const { tools } = sandbox();
  assert.match(await tools.exec('grep', { pattern: 'int x' }), /A\.java:2:/);
  assert.equal(await tools.exec('grep', { pattern: 'nothing-here-zzz' }), '(no matches)');
  assert.equal(await tools.exec('glob', { pattern: '**/*.java' }), 'src/A.java');
  assert.match(await tools.exec('list_dir', { path: '.' }), /src\//);
  assert.match(await tools.exec('nope', {}), /unknown tool/);
  assert.match(await tools.exec('read_file', '{bad json'), /not valid JSON/);
});

test('parseJsonWithKey prefers the last fenced block with the key', () => {
  const t = 'thinking {"x":1}\n```json\n{"findings":[1]}\n```\n```json\n{"findings":[2]}\n```';
  assert.deepEqual(parseJsonWithKey(t, 'findings'), { findings: [2] });
  assert.equal(parseJsonWithKey('no json', 'findings'), undefined);
});

function fakeClient(script) {
  const calls = [];
  return { calls, chat: async (body) => { calls.push(structuredClone(body)); return script(body, calls.length); } };
}
const reply = (message, usage = { total_tokens: 10 }) => ({ choices: [{ message }], usage });

test('agent: runs tools, then returns the final JSON', async () => {
  const { tools } = sandbox();
  const client = fakeClient((body, n) =>
    n === 1
      ? reply({ content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/A.java"}' } }] })
      : reply({ content: '```json\n{"findings":[]}\n```' }));
  const out = await runAgent({ client, model: 'm', system: 's', user: 'u', tools, expectKey: 'findings', budget: createBudget(1e6) });
  assert.deepEqual(out, { findings: [] });
  const second = client.calls[1].messages;
  assert.equal(second.at(-1).role, 'tool');
  assert.match(second.at(-1).content, /class A/);
  assert.match(second[0].content, /read-only tools/); // adapter note appended
});

test('agent: nudges for format, then gives up; turn limit forces a final answer', async () => {
  const nudged = fakeClient((b, n) => reply({ content: n < 2 ? 'I think it is fine.' : '```json\n{"findings":[]}\n```' }));
  assert.deepEqual(await runAgent({ client: nudged, model: 'm', system: 's', user: 'u', expectKey: 'findings', budget: createBudget(1e6) }), { findings: [] });

  const never = fakeClient(() => reply({ content: 'prose only' }));
  await assert.rejects(runAgent({ client: never, model: 'm', system: 's', user: 'u', expectKey: 'findings', budget: createBudget(1e6) }), /no JSON/);

  const { tools } = sandbox();
  const loops = fakeClient((body) => body.tool_choice === 'none'
    ? reply({ content: '```json\n{"findings":[]}\n```' })
    : reply({ content: null, tool_calls: [{ id: 'x', type: 'function', function: { name: 'list_dir', arguments: '{"path":"."}' } }] }));
  assert.deepEqual(await runAgent({ client: loops, model: 'm', system: 's', user: 'u', tools, expectKey: 'findings', budget: createBudget(1e6), maxTurns: 3 }), { findings: [] });
  assert.equal(loops.calls.length, 4);
});

test('agent: budget is enforced', async () => {
  const client = fakeClient(() => reply({ content: null, tool_calls: [{ id: 'x', type: 'function', function: { name: 'nope', arguments: '{}' } }] }, { total_tokens: 600 }));
  const { tools } = sandbox();
  await assert.rejects(runAgent({ client, model: 'm', system: 's', user: 'u', tools, expectKey: 'findings', budget: createBudget(1000) }), /budget exceeded/);
});

test('client: retries 429 with retry-after, fails fast on 400, azure header', async () => {
  const seen = [];
  const responses = [
    { ok: false, status: 429, headers: { get: () => '0.01' }, text: async () => 'slow down' },
    { ok: true, status: 200, json: async () => reply({ content: 'ok' }) },
  ];
  const fetchImpl = async (url, init) => { seen.push({ url, init }); return responses.shift(); };
  const c = createClient({ baseUrl: 'https://x.openai.azure.com/openai/v1/', azureApiKey: 'k', fetchImpl });
  assert.equal((await c.chat({})).choices[0].message.content, 'ok');
  assert.equal(seen.length, 2);
  assert.equal(seen[0].url, 'https://x.openai.azure.com/openai/v1/chat/completions');
  assert.equal(seen[0].init.headers['api-key'], 'k');

  const bad = createClient({ baseUrl: 'https://api.openai.com/v1', apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 400, text: async () => 'bad model' }) });
  await assert.rejects(bad.chat({}), /OpenAI 400: bad model/);
  assert.throws(() => createClient({ baseUrl: 'x' }), /OPENAI_API_KEY/);
});

test('verdict rules', () => {
  assert.equal(decideVerdict([F()], {}).verdict, 'fix_first');
  assert.equal(decideVerdict([F({ severity: 'major', confidence: 'confirmed' })], {}).verdict, 'fix_first');
  assert.equal(decideVerdict([F({ severity: 'major' })], {}).verdict, 'needs_discussion');
  assert.equal(decideVerdict([], { failed: ['db'] }).verdict, 'needs_discussion');
  assert.equal(decideVerdict([], { contractsRan: true, missingRepos: ['sfn-web-ui'] }).verdict, 'needs_discussion');
  assert.equal(decideVerdict([F({ severity: 'minor' })], {}).verdict, 'ready');
});

test('orchestrate: verify rejects/confirms/downgrades, drops malformed, dedupes, retries a failed specialist', async () => {
  const prompts = { specialists: { db: 'DB', security: 'SEC', general: 'GEN' }, verify: 'VERIFY' };
  const attempts = {};
  const agent = async ({ name, expectKey, user }) => {
    attempts[name] = (attempts[name] ?? 0) + 1;
    if (name === 'security' && attempts[name] === 1) throw new Error('transient');
    if (name === 'db') return { findings: [F(), F({ anchor: 'A#y', title: 'Second finding x' }), { title: 'malformed' }], blastRadius: { tables: ['devices'] } };
    if (name === 'security') return { findings: [F({ ruleId: 'SEC-003', category: 'security', anchor: 'Repo#q', severity: 'major' })], blastRadius: { endpoints: ['GET /x'] } };
    if (name === 'general') return { findings: [] };
    if (name === 'verify:db') {
      const batch = JSON.parse(user.split('```json\n')[1].split('\n```')[0]);
      assert.equal(batch.length, 2);
      return { decisions: [{ n: 0, decision: 'confirm', severity: 'blocker', verification: 'traced' }, { n: 1, decision: 'reject', verification: 'migration exists' }] };
    }
    if (name === 'verify:security') return { decisions: [{ n: 0, decision: 'downgrade', severity: 'minor', confidence: 'possible', verification: 'internal only' }] };
    if (expectKey === 'summary') return { summary: 'Adds a column and a query.' };
    throw new Error(`unexpected ${name}`);
  };
  const r = await orchestrate({
    scope: { repoKey: 'sfn-events-api', specialists: ['db', 'security'], generalPass: true, verify: true, changedFiles: [], missingRepos: [] },
    scopePath: '/tmp/scope.json', prompts, agent, models: { orchestrator: 'o', specialist: 's', verify: 'v' }, schemas,
  });
  assert.equal(attempts.security, 2);
  assert.equal(r.rejectedCount, 1);
  assert.deepEqual(r.findings.map((f) => [f.ruleId, f.severity, f.confidence]), [['DB-001', 'blocker', 'confirmed'], ['SEC-003', 'minor', 'possible']]);
  assert.equal(r.verdict, 'fix_first');
  assert.deepEqual(r.blastRadius, { tables: ['devices'], endpoints: ['GET /x'] });
  assert.deepEqual(r.specialistsRun, ['db', 'security', 'general']);
  assert.equal(r.summary, 'Adds a column and a query.');
});

test('orchestrate: quick level skips verify; failed specialist → needs_discussion', async () => {
  const agent = async ({ name, expectKey }) => {
    if (name === 'db') throw new Error('down');
    if (expectKey === 'summary') throw new Error('also down');
    return { findings: [] };
  };
  const r = await orchestrate({
    scope: { repoKey: 'x', specialists: ['db'], generalPass: true, verify: false, changedFiles: [{ path: 'a' }], missingRepos: [] },
    scopePath: '/tmp/s.json', prompts: { specialists: { db: 'DB', general: 'G' }, verify: 'V' }, agent,
    models: { orchestrator: 'o', specialist: 's', verify: 'v' }, schemas,
  });
  assert.equal(r.verdict, 'needs_discussion');
  assert.match(r.verdictReason, /db/);
  assert.match(r.summary, /1 file/); // fallback summary
});
