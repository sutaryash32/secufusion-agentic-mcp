// Minimal OpenAI-compatible Chat Completions client (OpenAI or Azure OpenAI v1 endpoint).
// No SDK dependency; `fetchImpl` is injectable for tests.

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);

/**
 * @param {{baseUrl:string, apiKey?:string, azureApiKey?:string, timeoutMs?:number, maxRetries?:number, fetchImpl?:typeof fetch, log?:Function}} opts
 */
export function createClient({ baseUrl, apiKey, azureApiKey, timeoutMs = 300_000, maxRetries = 4, fetchImpl = fetch, log = () => {} }) {
  if (!apiKey && !azureApiKey) throw new Error('OpenAI engine needs OPENAI_API_KEY (or AZURE_OPENAI_API_KEY for Azure OpenAI).');
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const headers = { 'Content-Type': 'application/json', ...(azureApiKey ? { 'api-key': azureApiKey } : { Authorization: `Bearer ${apiKey}` }) };

  return {
    async chat(body) {
      for (let attempt = 0; ; attempt++) {
        let res;
        try {
          res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
        } catch (e) {
          if (attempt >= maxRetries) throw new Error(`OpenAI request failed: ${e.message}`);
          await sleep(backoff(attempt));
          continue;
        }
        if (res.ok) return res.json();
        const text = await res.text();
        if (!RETRYABLE.has(res.status) || attempt >= maxRetries) {
          throw new Error(`OpenAI ${res.status}: ${text.slice(0, 600)}`);
        }
        const retryAfter = Number(res.headers?.get?.('retry-after'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt);
        log(`OpenAI ${res.status}, retry ${attempt + 1}/${maxRetries} in ${Math.round(wait / 1000)}s`);
        await sleep(wait);
      }
    },
  };
}

const backoff = (attempt) => Math.min(30_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Shared token budget across all agents of one review. */
export function createBudget(maxTotalTokens) {
  const b = {
    used: { prompt: 0, completion: 0, total: 0 },
    calls: 0,
    add(usage = {}) {
      b.calls++;
      b.used.prompt += usage.prompt_tokens ?? 0;
      b.used.completion += usage.completion_tokens ?? 0;
      b.used.total += usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
    },
    check() {
      if (maxTotalTokens && b.used.total > maxTotalTokens) {
        throw new Error(`Token budget exceeded (${b.used.total} > ${maxTotalTokens}).`);
      }
    },
  };
  return b;
}
