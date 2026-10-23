import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const run = promisify(execFile);
const GIT = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];

test('learn-from-fix: blames the fix back to the PR that introduced the bug and writes a history case', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sfn-learn-'));
  const repo = join(dir, 'sfn-tenants-api');
  mkdirSync(join(repo, 'src/main/java/x'), { recursive: true });
  const g = (...a) => execFileSync('git', ['-C', repo, ...GIT, ...a], { encoding: 'utf8' }).trim();
  const file = 'src/main/java/x/Purge.java';
  execFileSync('git', ['init', '-q', '-b', 'develop', repo]);
  writeFileSync(join(repo, file), ['class Purge {', '  void run() {', '    deleteIncidentLinks();', '    deleteEvents();', '  }', '}', ''].join('\n'));
  g('add', '-A'); g('commit', '-qm', 'initial');
  // PR !77 on a feature branch drops the incident-link delete (the bug), merged with a merge commit
  g('checkout', '-qb', 'feature/speedup');
  writeFileSync(join(repo, file), ['class Purge {', '  // faster purge', '  void run() {', '    deleteEvents();', '  }', '}', ''].join('\n'));
  g('commit', '-qam', 'speed up purge');
  g('checkout', '-q', 'develop');
  g('merge', '--no-ff', '-q', '-m', 'Merged PR 77: Speed up purge', 'feature/speedup');
  const merge = g('rev-parse', 'HEAD');
  // later fix puts the delete back by rewriting the line the PR wrote
  writeFileSync(join(repo, file), ['class Purge {', '  // faster purge', '  void run() {', '    deleteIncidentLinks(); deleteEvents();', '  }', '}', ''].join('\n'));
  g('commit', '-qam', 'fix(BUG-1140): delete incident links before events');
  const fix = g('rev-parse', 'HEAD');

  const out = join(dir, 'evals');
  await run('node', [join(root, 'evals/learn-from-fix.mjs'), '--repo', repo, '--fix', fix, '--develop', 'develop', '--out-dir', out, '--name', 'history-test']);
  const kase = JSON.parse(readFileSync(join(out, 'cases/history-test/case.json'), 'utf8'));
  assert.equal(kase.type, 'history');
  assert.equal(kase.head, merge);                                   // the PR merge, not the feature commit
  assert.equal(kase.base, g('rev-parse', `${merge}^1`));
  assert.equal(kase.source.pr, 77);
  // the bug is a DELETED line, so the target is the code the PR wrote right next to it
  const [target] = kase.expect.mustFind[0].anyOf;
  assert.equal(target.file, file);
  assert.equal(target.minSeverity, 'major');
  assert.ok(target.nearLines[0] >= 1 && target.nearLines[1] <= 7, JSON.stringify(target));
  assert.match(readFileSync(join(out, 'drafts/history-test.md'), 'utf8'), /fix\(BUG-1140\)/);

  // --bug resolves fix commits from messages when no work item link exists (no ADO here)
  await run('node', [join(root, 'evals/learn-from-fix.mjs'), '--repo', repo, '--bug', '1140', '--develop', 'develop', '--out-dir', out, '--name', 'history-test-bug'], { env: { ...process.env, AZURE_DEVOPS_PAT: '', SYSTEM_ACCESSTOKEN: '' } });
  assert.equal(JSON.parse(readFileSync(join(out, 'cases/history-test-bug/case.json'), 'utf8')).source.fixes[0], fix);
});

test('history-case: prepare makes worktrees at the change, cleanup removes them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sfn-hcase-'));
  const repo = join(dir, 'estate', 'sfn-iam-api');
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'develop', repo]);
  writeFileSync(join(repo, 'a.txt'), 'a');
  execFileSync('git', ['-C', repo, ...GIT, 'add', '-A']);
  execFileSync('git', ['-C', repo, ...GIT, 'commit', '-qm', 'a']);
  const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const caseDir = join(dir, 'case');
  mkdirSync(caseDir);
  writeFileSync(join(caseDir, 'case.json'), JSON.stringify({ type: 'history', repoKey: 'sfn-iam-api', estate: join(dir, 'estate'), base: head, head }));
  const work = join(dir, 'work');
  const { stdout } = await run('node', [join(root, 'evals/history-case.mjs'), 'prepare', caseDir, work]);
  const info = JSON.parse(stdout);
  assert.equal(execFileSync('git', ['-C', info.repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), head);
  assert.match(execFileSync('git', ['-C', repo, 'worktree', 'list'], { encoding: 'utf8' }), /work\/sfn-iam-api/);
  await run('node', [join(root, 'evals/history-case.mjs'), 'cleanup', work]);
  assert.doesNotMatch(execFileSync('git', ['-C', repo, 'worktree', 'list'], { encoding: 'utf8' }), /work\/sfn-iam-api/);
});

test('PR description: fills empty, updates its own block, never touches author text unless append', async () => {
  const { buildSection, planDescription, START, END } = await import('../lib/prdescription.mjs');
  const r = { summary: 'Adds a retention endpoint.', walkthrough: [{ area: 'Endpoint', change: 'New PUT.' }], testPlan: ['PUT as child admin → 403'], blastRadius: { endpoints: ['PUT /x'] }, scope: { headSha: 'abcdef1234' } };
  const section = buildSection(r);
  assert.ok(section.startsWith(START) && section.endsWith(END));
  assert.match(section, /### Test plan\n- \[ \] PUT as child admin/);
  assert.equal(planDescription('', section).action, 'write');
  assert.equal(planDescription('  <!-- template -->  ', section).action, 'write');          // template comment only = empty
  assert.equal(planDescription('Author wrote this.', section).action, 'skip');               // empty-only default
  const appended = planDescription('Author wrote this.', section, 'append');
  assert.ok(appended.description.startsWith('Author wrote this.') && appended.description.includes(START));
  const updated = planDescription(`Intro.\n${START}\nold\n${END}\nOutro.`, section);
  assert.equal(updated.action, 'write');
  assert.ok(updated.description.startsWith('Intro.\n') && updated.description.endsWith('\nOutro.'));
  assert.equal(planDescription(updated.description, section).action, 'skip');               // idempotent
  const long = buildSection({ ...r, walkthrough: Array.from({ length: 200 }, (_, i) => ({ area: `A${i}`, change: 'x'.repeat(60) })) });
  assert.ok(long.length <= 4000 && long.endsWith(END));
});

test('pr-description.mjs: preview by default, PATCH only with --confirm', async () => {
  const { createServer } = await import('node:http');
  const calls = [];
  let description = '';
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c)).on('end', () => {
      calls.push({ method: req.method, url: req.url });
      if (req.method === 'PATCH') description = JSON.parse(body).description;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ pullRequestId: 9, description }));
    });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const dir = mkdtempSync(join(tmpdir(), 'sfn-desc-'));
  const resultPath = join(dir, 'r.json');
  writeFileSync(resultPath, JSON.stringify({ summary: 'Adds X.', findings: [], verdict: 'ready', scope: { pr: { id: 9, collectionUri: 'https://dev.azure.com/acme/', project: 'P', repositoryId: 'rid' } } }));
  const env = { ...process.env, SFN_ADO_BASE_URL: `http://127.0.0.1:${server.address().port}/`, AZURE_DEVOPS_PAT: 'p', SYSTEM_ACCESSTOKEN: '', SYSTEM_PULLREQUEST_PULLREQUESTID: '' };
  try {
    const preview = await run('node', [join(root, 'scripts/pr-description.mjs'), '--in', resultPath], { env });
    assert.match(preview.stdout, /PREVIEW — PR 9 description would be written/);
    assert.ok(!calls.some((c) => c.method === 'PATCH'));
    await run('node', [join(root, 'scripts/pr-description.mjs'), '--in', resultPath, '--confirm'], { env });
    assert.ok(calls.some((c) => c.method === 'PATCH' && c.url.startsWith('/P/_apis/git/repositories/rid/pullrequests/9')));
    assert.match(description, /### What this PR does\n\nAdds X\./);
  } finally {
    server.close();
  }
});

test('chat: parses commands, ignores our own comments, answers each mention once', async () => {
  const { parseCommand, pendingMentions, falsePositiveReply, REPLY_MARKER } = await import('../lib/chat.mjs');
  assert.deepEqual(parseCommand('@sfn help'), { kind: 'help', text: '' });
  assert.deepEqual(parseCommand('@sfn'), { kind: 'help', text: '' });
  assert.deepEqual(parseCommand('@SFN false positive: guarded by the interceptor'), { kind: 'false_positive', text: 'guarded by the interceptor' });
  assert.equal(parseCommand('hey @sfn fp').kind, 'false_positive');
  assert.deepEqual(parseCommand('@sfn why?'), { kind: 'why', text: '' });
  assert.deepEqual(parseCommand('<p>@sfn is this tenant-safe?</p>'), { kind: 'question', text: 'is this tenant-safe?' });
  assert.equal(parseCommand('email me at a@sfnx.com'), undefined);
  assert.equal(parseCommand(`${REPLY_MARKER(5)} see @sfn help`), undefined);       // our own reply
  assert.equal(parseCommand('<!-- sfn-review:finding:0123456789ab --> @sfn'), undefined);

  const finding = { id: 1, content: '<!-- sfn-review:finding:0123456789ab -->\n🛑 **BLOCKER** · confirmed · `SEC-003` — **x**' };
  const threads = [
    { id: 10, threadContext: { filePath: '/src/A.java', rightFileStart: { line: 7 } }, comments: [finding, { id: 2, content: '@sfn why' }, { id: 3, content: `${REPLY_MARKER(2)} because…` }, { id: 4, content: '@sfn false positive covered by guard' }] },
    { id: 11, comments: [{ id: 1, content: '@sfn does this break iam-api?' }] },
    { id: 12, comments: [{ id: 1, content: 'normal review comment' }, { id: 2, content: '@sfn help', isDeleted: true }] },
  ];
  const p = pendingMentions(threads);
  assert.deepEqual(p.map((m) => [m.threadId, m.commentId, m.command.kind]), [[10, 4, 'false_positive'], [11, 1, 'question']]);
  assert.equal(p[0].findingId, '0123456789ab');
  assert.equal(p[0].file, 'src/A.java');
  const fp = falsePositiveReply(p[0], new Date('2026-10-22T00:00:00Z'));
  assert.match(fp, /- id: 0123456789ab\n  reason: "covered by guard"\n  expires: 2027-01-20/);
  assert.match(falsePositiveReply(p[1]), /only works on a reviewer finding thread/);
});

test('pr-chat.mjs: replies once per mention, sets wontFix on false positives, answers questions from a worktree', async () => {
  const { createServer } = await import('node:http');
  const dir = mkdtempSync(join(tmpdir(), 'sfn-chat-'));
  const repo = join(dir, 'sfn-iam-api');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'develop', repo]);
  writeFileSync(join(repo, 'A.java'), 'class A {}');
  execFileSync('git', ['-C', repo, ...GIT, 'add', '-A']);
  execFileSync('git', ['-C', repo, ...GIT, 'commit', '-qm', 'a']);
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://dev.azure.com/acme/Proj/_git/sfn-iam-api']);
  const sha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const posted = [];
  const patched = [];
  const threads = [
    { id: 10, status: 'active', comments: [{ id: 1, content: '<!-- sfn-review:finding:0123456789ab -->\n🛑 **BLOCKER** · confirmed · `SEC-003` — **x**' }, { id: 2, content: '@sfn false positive guarded' }] },
    { id: 11, status: 'active', comments: [{ id: 1, content: '@sfn is A tenant-safe?' }] },
  ];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c)).on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url.includes('/pullrequests?')) return res.end(JSON.stringify({ value: [{ pullRequestId: 5, title: 'T', lastMergeSourceCommit: { commitId: sha } }] }));
      if (req.method === 'GET' && req.url.includes('/threads')) return res.end(JSON.stringify({ value: threads }));
      if (req.method === 'POST') {
        const b = JSON.parse(body);
        posted.push({ url: req.url, ...b });
        const tid = Number(req.url.match(/threads\/(\d+)\/comments/)[1]);
        threads.find((t) => t.id === tid).comments.push({ id: 99, content: b.content });   // so a re-run sees the reply
        return res.end('{}');
      }
      if (req.method === 'PATCH') { patched.push({ url: req.url, ...JSON.parse(body) }); return res.end('{}'); }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const env = { ...process.env, SFN_ADO_BASE_URL: `http://127.0.0.1:${server.address().port}/`, AZURE_DEVOPS_PAT: 'p', SYSTEM_ACCESSTOKEN: '', SFN_CHAT_ENGINE: 'stub' };
  try {
    await run('node', [join(root, 'scripts/pr-chat.mjs'), '--repo', repo], { env });
    assert.equal(posted.length, 2);
    assert.ok(posted.every((p) => p.parentCommentId && p.content.includes('<!-- sfn-chat:reply-to:')));
    assert.match(posted.find((p) => p.url.includes('/threads/11/')).content, /stub answer .* for: is A tenant-safe\?/);
    assert.deepEqual(patched.map((p) => [p.url.match(/threads\/(\d+)/)[1], p.status]), [['10', 'wontFix']]);
    assert.equal(execFileSync('git', ['-C', repo, 'worktree', 'list'], { encoding: 'utf8' }).trim().split('\n').length, 1); // answer worktree removed
    await run('node', [join(root, 'scripts/pr-chat.mjs'), '--repo', repo], { env });
    assert.equal(posted.length, 2);                                                                                 // nothing answered twice
  } finally {
    server.close();
  }
});
