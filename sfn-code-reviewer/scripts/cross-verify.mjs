#!/usr/bin/env node
// Cross-model verification: the OTHER provider re-checks every finding of a finished review and may
// reject or downgrade it (never raise severity). Then the verdict is recomputed deterministically.
//
//   node cross-verify.mjs --scope scope.json --in raw-output.json --out raw-crossverified.json \
//                         --verifier openai|anthropic
//
// Verifier "openai": OPENAI_API_KEY / AZURE_OPENAI_API_KEY, same read-only tools as the OpenAI engine.
// Verifier "anthropic": the Claude Code CLI (login locally, ANTHROPIC_API_KEY / Foundry in CI), with the
// verify prompt as system prompt and the CI read-only settings.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseJsonWithKey, runAgent } from '../engines/openai/lib/agent.mjs';
import { createBudget, createClient } from '../engines/openai/lib/client.mjs';
import { createTools } from '../engines/openai/lib/tools.mjs';
import { loadConfig, readJson } from './lib/paths.mjs';
import { decideVerdict } from './lib/verdict.mjs';
import { extractResult } from './lib/validate.mjs';
import { verifyFindings } from './lib/verify.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({
  options: { scope: { type: 'string' }, in: { type: 'string' }, out: { type: 'string' }, verifier: { type: 'string' } },
});
if (!args.scope || !args.in || !args.out || !['openai', 'anthropic'].includes(args.verifier)) {
  console.error('usage: cross-verify.mjs --scope <scope.json> --in <raw> --out <raw> --verifier openai|anthropic');
  process.exit(64);
}
const log = (m) => console.error(`[sfn-review:cross-verify] ${m}`);

const cfg = loadConfig();
const scopePath = resolve(args.scope);
const scope = readJson(scopePath);
const result = extractResult(readFileSync(args.in, 'utf8'));
if (!result) { log('no review result to verify'); process.exit(3); }

let model; // set by the verifier factory below
const verifyPrompt = readFileSync(join(root, 'prompts/verify.md'), 'utf8').replace(/^---\n[\s\S]*?\n---\n+/, '');
const ask = args.verifier === 'openai' ? openaiAsk() : anthropicAsk();

const findings = (result.findings ?? []).map((f) => ({ ...f }));
if (findings.length === 0) {
  log('no findings — nothing to cross-verify');
} else {
  const { kept, rejected, stats } = await verifyFindings({ findings, scopePath, ask, mode: 'cross', log });
  const { verdict, reason } = decideVerdict(kept, {
    missingRepos: scope.missingRepos ?? [], contractsRan: (result.specialistsRun ?? []).includes('contracts'),
  });
  result.findings = kept;
  result.rejectedCount = (result.rejectedCount ?? 0) + rejected.length;
  result.verdict = verdict;
  result.verdictReason = rejected.length
    ? `${reason} Cross-check by ${args.verifier} rejected ${rejected.length}: ${rejected.map((f) => `${f.ruleId} ${f.title} (${f.crossVerification})`).join('; ').slice(0, 600)}`
    : reason;
  result.crossVerify = { verifier: args.verifier, model, ...stats, rejectedFindings: rejected.map((f) => ({ ruleId: f.ruleId, title: f.title, file: f.file, line: f.line, reason: f.crossVerification })) };
  log(`${args.verifier}: confirmed ${stats.confirmed}, downgraded ${stats.downgraded}, rejected ${stats.rejected}, unverified ${stats.unverified}`);
}
result.crossVerify ??= { verifier: args.verifier, model, confirmed: 0, downgraded: 0, rejected: 0, unverified: 0 };
writeFileSync(args.out, JSON.stringify(result, null, 2));

// ---------------------------------------------------------------------------
function openaiAsk() {
  const oc = cfg.review.openai;
  model = oc.models.verify;
  const client = createClient({
    baseUrl: process.env.OPENAI_BASE_URL || oc.baseUrl,
    apiKey: process.env.OPENAI_API_KEY,
    azureApiKey: process.env.AZURE_OPENAI_API_KEY,
    log,
  });
  const tools = createTools({ repoPath: scope.repoPath, roots: [scope.repoPath, scope.estateRoot, scope.rulesDir, dirname(scopePath)] });
  const budget = createBudget(oc.maxTotalTokens);
  const params = {
    ...(oc.maxCompletionTokens ? { max_completion_tokens: oc.maxCompletionTokens } : {}),
    ...(oc.reasoningEffort ? { reasoning_effort: oc.reasoningEffort } : {}),
  };
  return ({ name, user }) => runAgent({
    client, model, system: verifyPrompt, user, tools, expectKey: 'decisions', budget,
    maxTurns: oc.maxTurnsPerAgent, params, log, name,
  });
}

function anthropicAsk() {
  const ac = cfg.review.anthropic;
  model = ac.models.verify;
  const bare = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_USE_FOUNDRY || process.env.CLAUDE_CODE_USE_BEDROCK || process.env.CLAUDE_CODE_USE_VERTEX;
  return ({ user }) => new Promise((ok, fail) => {
    const cliArgs = [
      '-p', `${user}\n\nFollow your instructions and return the decisions JSON.`,
      ...(bare ? ['--bare', '--max-budget-usd', String(ac.verifyBudgetUsd ?? 2)] : []),
      '--append-system-prompt', verifyPrompt,
      '--model', model,
      '--settings', join(root, 'config/settings.ci.json'),
      '--permission-mode', 'dontAsk',
      '--tools', 'Read,Grep,Glob,Bash',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--add-dir', scope.estateRoot, '--add-dir', scope.rulesDir, '--add-dir', dirname(scopePath),
      '--output-format', 'json', '--no-session-persistence',
    ];
    const p = spawn('claude', cliArgs, { cwd: scope.repoPath, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', fail);
    p.on('close', (code) => {
      let env;
      try { env = JSON.parse(out); } catch { return fail(new Error(`claude exited ${code}: ${(err || out).slice(0, 400)}`)); }
      if (env.is_error) return fail(new Error(`claude: ${String(env.result).slice(0, 400)}`));
      const decided = parseJsonWithKey(String(env.result ?? ''), 'decisions');
      return decided ? ok(decided) : fail(new Error('claude returned no decisions JSON'));
    });
  });
}

