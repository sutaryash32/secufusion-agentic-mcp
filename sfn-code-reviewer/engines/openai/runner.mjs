#!/usr/bin/env node
// OpenAI engine entry point. Same inputs and output as the Anthropic engine:
//   scope.json in → review result JSON out (then scripts/finalize.mjs validates it as usual).
//
//   node engines/openai/runner.mjs --scope <scope.json> --out <raw-output.json>
//
// Auth: OPENAI_API_KEY (api.openai.com or any compatible baseUrl), or AZURE_OPENAI_API_KEY with
// openai.baseUrl set to https://<resource>.openai.azure.com/openai/v1 in config/review.config.yml.
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig, readJson } from '../../scripts/lib/paths.mjs';
import { runAgent } from './lib/agent.mjs';
import { createBudget, createClient } from './lib/client.mjs';
import { loadPrompts, orchestrate } from './lib/orchestrate.mjs';
import { createTools } from './lib/tools.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { values: args } = parseArgs({ options: { scope: { type: 'string' }, out: { type: 'string' } } });
if (!args.scope || !args.out) {
  console.error('usage: runner.mjs --scope <scope.json> --out <raw-output.json>');
  process.exit(64);
}

const log = (m) => console.error(`[sfn-review:openai] ${m}`);
const cfg = loadConfig();
const oc = cfg.review.openai;
for (const k of ['orchestrator', 'specialist', 'verify']) {
  if (!oc?.models?.[k]) { log(`config openai.models.${k} is not set (config/review.config.yml)`); process.exit(2); }
}

const scopePath = resolve(args.scope);
const scope = readJson(scopePath);
const client = createClient({
  baseUrl: process.env.OPENAI_BASE_URL || oc.baseUrl,
  apiKey: process.env.OPENAI_API_KEY,
  azureApiKey: process.env.AZURE_OPENAI_API_KEY,
  log,
});
const budget = createBudget(oc.maxTotalTokens);
const tools = createTools({ repoPath: scope.repoPath, roots: [scope.repoPath, scope.estateRoot, scope.rulesDir, dirname(scopePath)] });
const params = {
  ...(oc.maxCompletionTokens ? { max_completion_tokens: oc.maxCompletionTokens } : {}),
  ...(oc.reasoningEffort ? { reasoning_effort: oc.reasoningEffort } : {}),
};

const agent = ({ name, model, system, user, tools: useTools, expectKey }) =>
  runAgent({ client, model, system, user, tools: useTools ? tools : undefined, expectKey, budget, maxTurns: oc.maxTurnsPerAgent, params, log, name });

const started = Date.now();
try {
  const result = await orchestrate({
    scope,
    scopePath,
    prompts: loadPrompts(join(root, 'prompts')),
    agent,
    models: oc.models,
    schemas: [readJson(join(cfg.schemasDir, 'finding.schema.json')), readJson(join(cfg.schemasDir, 'review-result.schema.json'))],
    log,
  });
  writeFileSync(args.out, JSON.stringify(result, null, 2));
  log(`done in ${Math.round((Date.now() - started) / 1000)}s, ${budget.calls} calls, ${budget.used.total} tokens`);
} catch (e) {
  log(`review failed: ${e.message}`);
  process.exit(1);
}
