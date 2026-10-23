// End to end without a real key: run-review.sh --engine openai against a local fake
// Chat Completions server, on the missing-migration eval fixture. Proves the whole chain:
// scope → runner (tools, agents, verify) → finalize → report → SARIF → gate.
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { cpSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const GIT = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];

function fixture() {
  const estate = mkdtempSync(join(tmpdir(), 'sfn-e2e-'));
  const repo = join(estate, 'sfn-events-api');
  const kase = join(root, 'evals/cases/missing-migration');
  cpSync(join(kase, 'base'), repo, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'develop', repo]);
  execFileSync('git', ['-C', repo, ...GIT, 'add', '-A']);
  execFileSync('git', ['-C', repo, ...GIT, 'commit', '-qm', 'base']);
  execFileSync('git', ['-C', repo, 'checkout', '-qb', 'feature']);
  cpSync(join(kase, 'head'), repo, { recursive: true });
  execFileSync('git', ['-C', repo, ...GIT, 'add', '-A']);
  execFileSync('git', ['-C', repo, ...GIT, 'commit', '-qm', 'change']);
  return { estate, repo };
}

// Scripted model: each specialist reads the diff once via the git tool, then answers.
function fakeOpenAI({ verifyDecision = 'confirm' } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c)).on('end', () => {
      const b = JSON.parse(body);
      requests.push(b);
      const sys = b.messages[0].content;
      const last = b.messages.at(-1);
      const scopePath = (b.messages[1].content.match(/(\/\S+scope\.json)/) || [])[1];
      const answer = (obj) => ({ content: '```json\n' + JSON.stringify(obj) + '\n```' });
      let message;
      if (sys.includes('adversarial verifier')) {
        message = verifyDecision === 'reject'
          ? answer({ decisions: [{ n: 0, decision: 'reject', verification: 'V2 migration exists in another module.' }] })
          : answer({ decisions: [{ n: 0, decision: 'confirm', severity: 'blocker', confidence: 'confirmed', verification: 'No V2 migration in the diff; ddl-auto none.' }] });
      } else if (sys.includes('summary of a code review')) {
        message = answer({ summary: 'Adds a last_seen_ip column to Device and a touch() method that writes it.' });
      } else if (last.role === 'user') {
        const scope = JSON.parse(readFileSync(scopePath, 'utf8'));
        message = { content: null, tool_calls: [{ id: 'd1', type: 'function', function: { name: 'git', arguments: JSON.stringify({ repo: scope.repoPath, args: ['diff', scope.mergeBase, scope.headSha] }) } }] };
      } else if (sys.includes('database specialist')) {
        assert.match(last.content, /last_seen_ip/); // the tool really returned the diff
        message = answer({
          specialist: 'db',
          findings: [{
            ruleId: 'DB-001', severity: 'blocker', confidence: 'possible', category: 'db',
            file: 'src/main/java/com/secufusion/events/entity/Device.java', line: 19, anchor: 'Device#lastSeenIp',
            title: 'New column last_seen_ip has no migration', problem: 'Device maps last_seen_ip but no V2 migration adds it.',
            failureScenario: 'Deploy; DeviceService.touch() saves Device → SQL error: column last_seen_ip does not exist.',
            suggestion: 'Add V2__add_devices_last_seen_ip.sql: ALTER TABLE devices ADD COLUMN last_seen_ip VARCHAR(45);',
          }],
          blastRadius: { tables: ['devices'] },
        });
      } else {
        message = answer({ findings: [] });
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
    });
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, requests, url: `http://127.0.0.1:${server.address().port}/v1` })));
}

function runReview(extraArgs, env) {
  return new Promise((ok) => {
    const p = spawn('bash', [join(root, 'scripts/run-review.sh'), ...extraArgs], { env: { ...process.env, ANTHROPIC_API_KEY: '', ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (c) => ok({ code: c, err }));
  });
}

test('run-review.sh --engine openai produces a validated, gated result', async () => {
  const { estate, repo } = fixture();
  const { server, requests, url } = await fakeOpenAI();
  const out = join(estate, 'out');
  try {
    const code = await new Promise((ok) => {
      const p = spawn('bash', [join(root, 'scripts/run-review.sh'), '--ci', '--engine', 'openai', '--repo', repo,
        '--base', 'develop', '--estate-root', estate, '--out', out, '--level', 'standard'], {
        env: { ...process.env, OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: url, ANTHROPIC_API_KEY: '' },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let err = '';
      p.stderr.on('data', (d) => (err += d));
      p.on('close', (c) => { if (c !== 0) console.error(err); ok(c); });
    });
    assert.equal(code, 0);
    const r = JSON.parse(readFileSync(join(out, 'review-result.json'), 'utf8'));
    assert.equal(r.verdict, 'fix_first');
    assert.equal(r.engine.provider, 'openai');
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].ruleId, 'DB-001');
    assert.equal(r.findings[0].confidence, 'confirmed');
    assert.match(r.findings[0].id, /^[a-f0-9]{12}$/);
    assert.ok(existsSync(join(out, 'report.html')));
    assert.ok(existsSync(join(out, 'sfn-review.sarif')));
    // standard level → db + security (+contracts via entity rule) + general, then verify + summary
    const specialistsAsked = new Set(requests.map((b) => b.messages[0].content.split('\n')[0]));
    assert.ok(specialistsAsked.size >= 4);

    let gate = 0;
    try { execFileSync('node', [join(root, 'scripts/gate.mjs'), '--in', join(out, 'review-result.json')]); } catch (e) { gate = e.status; }
    assert.equal(gate, 1); // confirmed blocker fails the build
  } finally {
    server.close();
  }
});

test('second run reports the delta against the previous result', async () => {
  const { estate, repo } = fixture();
  const { server, url } = await fakeOpenAI();
  const out = join(estate, 'out');
  const args = ['--ci', '--engine', 'openai', '--repo', repo, '--base', 'develop', '--estate-root', estate, '--out', out, '--level', 'quick'];
  const env = { OPENAI_API_KEY: 'k', OPENAI_BASE_URL: url };
  try {
    assert.equal((await runReview(args, env)).code, 0);
    const first = JSON.parse(readFileSync(join(out, 'review-result.json'), 'utf8'));
    assert.equal(first.delta, undefined);
    assert.equal((await runReview(args, env)).code, 0);
    const second = JSON.parse(readFileSync(join(out, 'review-result.json'), 'utf8'));
    assert.ok(existsSync(join(out, 'previous-result.json')));
    assert.equal(second.delta.stillOpen.length, 1);
    assert.equal(second.delta.fixed.length, 0);
    assert.equal(second.delta.new.length, 0);
  } finally {
    server.close();
  }
});

test('cross-verify: the other provider rejects the finding and the verdict is recomputed', async () => {
  const { estate, repo } = fixture();
  const primary = await fakeOpenAI();
  const out = join(estate, 'out');
  try {
    const r1 = await runReview(['--ci', '--engine', 'openai', '--repo', repo, '--base', 'develop', '--estate-root', estate, '--out', out, '--level', 'quick'],
      { OPENAI_API_KEY: 'k', OPENAI_BASE_URL: primary.url });
    assert.equal(r1.code, 0);
  } finally {
    primary.server.close();
  }
  const verifier = await fakeOpenAI({ verifyDecision: 'reject' });
  try {
    // async: the fake server lives in this process, so a sync child would deadlock it
    await promisify(execFile)('node', [join(root, 'scripts/cross-verify.mjs'), '--scope', join(out, 'scope.json'), '--in', join(out, 'raw-output.json'),
      '--out', join(out, 'raw-x.json'), '--verifier', 'openai'], { env: { ...process.env, OPENAI_API_KEY: 'k', OPENAI_BASE_URL: verifier.url } });
    const x = JSON.parse(readFileSync(join(out, 'raw-x.json'), 'utf8'));
    assert.equal(x.findings.length, 0);
    assert.equal(x.crossVerify.rejected, 1);
    assert.equal(x.crossVerify.verifier, 'openai');
    // no blockers left, but contracts ran with the other repos missing from this estate
    assert.equal(x.verdict, 'needs_discussion');
    assert.match(x.verdictReason, /not checked/);
    assert.match(x.verdictReason, /rejected 1/);
    execFileSync('node', [join(root, 'scripts/finalize.mjs'), '--scope', join(out, 'scope.json'), '--raw', join(out, 'raw-x.json'), '--out', join(out, 'final-x.json')], { stdio: 'pipe' });
    assert.equal(JSON.parse(readFileSync(join(out, 'final-x.json'), 'utf8')).crossVerify.rejected, 1);
  } finally {
    verifier.server.close();
  }
});

test('consensus: --consensus 2 runs the engine twice and keeps the finding both runs report', async () => {
  const { estate, repo } = fixture();
  const { server, requests, url } = await fakeOpenAI();
  const out = join(estate, 'out');
  try {
    const r = await runReview(['--ci', '--engine', 'openai', '--repo', repo, '--base', 'develop', '--estate-root', estate, '--out', out, '--level', 'quick', '--consensus', '2'],
      { OPENAI_API_KEY: 'k', OPENAI_BASE_URL: url });
    assert.equal(r.code, 0, r.err);
    assert.ok(existsSync(join(out, 'raw-run-1.json')) && existsSync(join(out, 'raw-run-2.json')));
    const res = JSON.parse(readFileSync(join(out, 'review-result.json'), 'utf8'));
    assert.equal(res.consensus.runs, 2);
    assert.equal(res.findings.length, 1);
    assert.equal(res.findings[0].consensus, '2/2');
    assert.equal(requests.filter((b) => b.messages[0].content.includes('database specialist') && b.messages.at(-1).role === 'user').length, 2);
  } finally {
    server.close();
  }
});
