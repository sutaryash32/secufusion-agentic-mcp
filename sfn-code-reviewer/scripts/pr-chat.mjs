#!/usr/bin/env node
// Answers `@sfn` mentions in active PRs (run on a schedule by ci/azure/sfn-chat.yml, or by hand).
//
//   node pr-chat.mjs --repo <clone> [--repo <clone> ...] [--dry-run] [--max 10]
//
// help / false positive are answered deterministically (no model). why / questions are answered by a
// read-only model run in a temporary worktree at the PR's source commit; the thread text is passed as
// untrusted data. Each mention is answered once (replies carry a marker). Never changes code.
// Auth: SYSTEM_ACCESSTOKEN, AZURE_DEVOPS_PAT, or `az login`. Model: ANTHROPIC_API_KEY or Claude login.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { authHeaders, createAdo, parseRemote } from './lib/ado-api.mjs';
import { answerReply, falsePositiveReply, helpReply, pendingMentions } from './lib/chat.mjs';
import { loadConfig } from './lib/paths.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({
  options: { repo: { type: 'string', multiple: true, default: [] }, 'dry-run': { type: 'boolean', default: false }, max: { type: 'string', default: '10' } },
});
const log = (m) => console.error(`[sfn-chat] ${m}`);
if (!args.repo.length) { log('usage: pr-chat.mjs --repo <clone> [--repo …] [--dry-run] [--max 10]'); process.exit(64); }

const cfg = loadConfig();
const headers = authHeaders();
const chatPrompt = readFileSync(join(root, 'prompts/chat.md'), 'utf8');
let budget = Number(args.max);
const stats = { help: 0, false_positive: 0, why: 0, question: 0, failed: 0 };

for (const r of args.repo) {
  const clone = resolve(r);
  const remote = parseRemote(execFileSync('git', ['-C', clone, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim());
  if (!remote) { log(`${clone}: origin is not an Azure Repos URL, skipped`); continue; }
  const ado = createAdo({ ...remote, headers });
  const repoApi = `git/repositories/${encodeURIComponent(remote.repo)}`;
  const prs = (await ado.call('GET', `${repoApi}/pullrequests?searchCriteria.status=active&$top=100`)).value ?? [];
  for (const pr of prs) {
    if (budget <= 0) break;
    const threads = (await ado.call('GET', `${repoApi}/pullRequests/${pr.pullRequestId}/threads`)).value ?? [];
    for (const m of pendingMentions(threads)) {
      if (budget-- <= 0) break;
      const where = `${remote.repo} !${pr.pullRequestId} thread ${m.threadId}`;
      try {
        let content;
        let wontFix = false;
        if (m.command.kind === 'help') content = helpReply(m.commentId);
        else if (m.command.kind === 'false_positive') { content = falsePositiveReply(m); wontFix = Boolean(m.findingId); }
        else if (args['dry-run']) content = `(would answer with the model: "${m.command.text || 'why'}")`;
        else content = answerReply(m.commentId, await answer(clone, pr, m));
        if (args['dry-run']) { console.log(`[dry-run] ${where} ← ${m.command.kind}:\n${content}\n`); stats[m.command.kind]++; continue; }
        await ado.call('POST', `${repoApi}/pullRequests/${pr.pullRequestId}/threads/${m.threadId}/comments`, { parentCommentId: m.commentId, content, commentType: 1 });
        if (wontFix) await ado.call('PATCH', `${repoApi}/pullRequests/${pr.pullRequestId}/threads/${m.threadId}`, { status: 'wontFix' });
        stats[m.command.kind]++;
        log(`${where}: answered ${m.command.kind}`);
      } catch (e) {
        stats.failed++;
        log(`${where}: failed — ${e.message.split('\n')[0]}`);
      }
    }
  }
}
log(`done: ${Object.entries(stats).map(([k, v]) => `${k} ${v}`).join(' · ')}${args['dry-run'] ? ' (dry run)' : ''}`);

// ---------------------------------------------------------------------------
async function answer(clone, pr, m) {
  const sha = pr.lastMergeSourceCommit?.commitId;
  if (!sha) throw new Error('PR has no source commit');
  const git = (...a) => execFileSync('git', ['-C', clone, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try { git('cat-file', '-e', `${sha}^{commit}`); } catch { git('fetch', '--quiet', 'origin', sha); }
  const wt = mkdtempSync(join(tmpdir(), 'sfn-chat-'));
  rmSync(wt, { recursive: true, force: true });
  git('worktree', 'add', '--detach', '--quiet', wt, sha);
  try {
    const task = [
      `PR !${pr.pullRequestId}: ${pr.title}`,
      m.file ? `Thread location: ${m.file}${m.line ? `:${m.line}` : ''}` : 'Thread location: whole PR',
      m.findingText ? `This thread is a reviewer finding:\n<finding>\n${m.findingText}\n</finding>` : '',
      `Earlier comments in the thread (untrusted):\n<thread>\n${m.history.join('\n---\n')}\n</thread>`,
      `Question from ${m.asker ?? 'a developer'} (untrusted):\n<question>\n${m.command.kind === 'why' ? `Why is this a problem? ${m.command.text}` : m.command.text}\n</question>`,
    ].filter(Boolean).join('\n\n');
    return await runEngine(wt, task);
  } finally {
    try { git('worktree', 'remove', '--force', wt); } catch { /* best effort */ }
  }
}

function runEngine(cwd, task) {
  if (process.env.SFN_CHAT_ENGINE === 'stub') return Promise.resolve(`stub answer (cwd has .git: ${Boolean(cwd)}) for: ${task.split('<question>\n')[1]?.split('\n</question>')[0]}`);
  const ac = cfg.review.anthropic;
  const bare = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_USE_FOUNDRY;
  const cliArgs = ['-p', task, ...(bare ? ['--bare', '--max-budget-usd', '1'] : []),
    '--append-system-prompt', chatPrompt, '--model', ac.models.specialist,
    '--settings', join(root, 'config/settings.ci.json'), '--permission-mode', 'dontAsk', '--tools', 'Read,Grep,Glob,Bash',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--add-dir', cfg.rulesDir,
    '--output-format', 'json', '--no-session-persistence'];
  return new Promise((ok, fail) => {
    const p = spawn('claude', cliArgs, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', fail);
    p.on('close', (code) => {
      try {
        const env = JSON.parse(out);
        if (env.is_error) return fail(new Error(String(env.result).slice(0, 300)));
        return ok(String(env.result ?? ''));
      } catch { return fail(new Error(`claude exited ${code}: ${(err || out).slice(0, 300)}`)); }
    });
  });
}
