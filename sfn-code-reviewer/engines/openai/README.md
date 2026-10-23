# OpenAI engine (phase 2)

Runs the same review as the Anthropic engine using OpenAI models — **OpenAI** or **Azure OpenAI**.
Same inputs (`scope.json`, `prompts/`, `rules/`), same output (`review-result.json` → finalize,
report, SARIF, PR comments, gate). Nothing downstream knows which engine ran, except `engine` in the
result.

## Use it

```bash
# OpenAI
OPENAI_API_KEY=sk-… scripts/run-review.sh --engine openai --repo ../sfn-tenants-api --working-tree

# Azure OpenAI (models in config = your deployment names)
AZURE_OPENAI_API_KEY=… OPENAI_BASE_URL=https://<resource>.openai.azure.com/openai/v1 \
  scripts/run-review.sh --engine openai --repo ../sfn-tenants-api --working-tree
```

CI: pipeline parameter `engine: openai`, plus `OPENAI_API_KEY` (or `AZURE_OPENAI_API_KEY`) in the
`sfn-code-reviewer` variable group. For Azure, set `openai.baseUrl` in `config/review.config.yml`.

`/sfn:review` inside Claude Code always uses Claude; the OpenAI engine is for the terminal and CI.

## How it differs from the Anthropic engine

| | Anthropic | OpenAI |
|---|---|---|
| Orchestration | the model (orchestrator skill) dispatches subagents | **code** (`lib/orchestrate.mjs`) — specialists in parallel, verify in batches of 15, max 4 at once |
| Verdict | model, following `verdict.md` | **deterministic** (`decideVerdict`) — same rules |
| Summary | orchestrator | one tool-less call to `models.orchestrator`, with a fallback |
| Tools | Claude Code Read/Grep/Glob/Bash, restricted by `settings.ci.json` | `lib/tools.mjs`: `read_file`, `grep`, `glob`, `list_dir`, `git` — **confinement in code**: real-path checks against the review roots (symlink-safe), git read-only subcommands, no `--output`/`--no-index`/`-c` |
| Malformed findings | whole result fails validation | each finding validated; bad ones dropped and the verdict can't be `ready` |
| Limits | `--max-budget-usd` | `maxTotalTokens`, `maxTurnsPerAgent`, `maxCompletionTokens` |

## Files

```
engines/openai/
├── runner.mjs            # entry: --scope → --out
├── lib/
│   ├── client.mjs        # Chat Completions over fetch; retries 408/409/429/5xx with retry-after; token budget
│   ├── tools.mjs         # read-only, path-confined tools
│   ├── agent.mjs         # tool loop, JSON extraction, format nudges, turn limit
│   └── orchestrate.mjs   # specialists → verify → dedupe → verdict → summary
└── __tests__/
    ├── engine.test.mjs   # tools confinement, agent loop, client retries, orchestration, verdict
    └── e2e.test.mjs      # run-review.sh --engine openai against a local fake API server
```

## Before relying on it

1. Confirm `openai.models` in `config/review.config.yml` against what your account (or Azure
   deployment list) offers. The default `gpt-5` is a starting point, not a recommendation from evals.
2. Run `evals/run-evals.sh --engine openai` and `--engine anthropic`, then
   `node evals/compare-engines.mjs`.
