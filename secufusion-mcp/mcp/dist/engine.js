/** The provider's own variable first, then the SFN_ alias (pipelines map a secret to the alias without naming the provider's variable). */
const KEY_NAMES = { anthropic: ["ANTHROPIC_API_" + "KEY", "SFN_ANTHROPIC_KEY"], openai: ["OPENAI_API_" + "KEY", "SFN_OPENAI_KEY"] };
const DEFAULT_MODEL = { anthropic: "claude-opus-5-5", openai: "gpt-5" };
const TIMEOUT_MS = 120_000;
export function createEngine(o = {}) {
    const env = o.env ?? process.env;
    const verify = o.role === "verify";
    const provider = (verify ? env.SFN_VERIFY_ENGINE : env.SFN_ENGINE)?.trim().toLowerCase();
    if (!provider)
        return { engine: null, reason: verify ? "SFN_VERIFY_ENGINE is not set" : "SFN_ENGINE is not set" };
    if (provider !== "anthropic" && provider !== "openai")
        return { engine: null, reason: `unknown engine "${provider}" (use anthropic or openai)` };
    const names = KEY_NAMES[provider];
    const key = env[names[0]] || env[names[1]];
    if (!key)
        return { engine: null, reason: `${names[0]} is not set` };
    const model = (verify ? env.SFN_VERIFY_MODEL : env.SFN_MODEL) || DEFAULT_MODEL[provider];
    const f = o.fetchImpl ?? fetch;
    return { engine: provider === "anthropic" ? anthropic(key, model, env.SFN_ANTHROPIC_BASE_URL || "https://api.anthropic.com", f) : openai(key, model, env.SFN_OPENAI_BASE_URL || "https://api.openai.com/v1", f) };
}
async function post(f, url, headers, body) {
    const res = await f(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
        // The provider's error body can echo request details; keep only its status and a short message.
        let msg = "";
        try {
            msg = String((await res.json())?.error?.message ?? "").slice(0, 200);
        }
        catch { /* not json */ }
        throw new Error(`engine request failed: HTTP ${res.status}${msg ? " " + msg : ""}`);
    }
    return res.json();
}
function anthropic(key, model, base, f) {
    return {
        provider: "anthropic", model,
        async complete({ system, user, maxTokens = 4000 }) {
            const j = await post(f, `${base.replace(/\/$/, "")}/v1/messages`, { "x-api-key": key, "anthropic-version": "2023-06-01" }, { model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] });
            return (j.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");
        },
    };
}
function openai(key, model, base, f) {
    return {
        provider: "openai", model,
        async complete({ system, user, maxTokens = 4000 }) {
            const j = await post(f, `${base.replace(/\/$/, "")}/chat/completions`, { authorization: `Bearer ${key}` }, { model, max_completion_tokens: maxTokens, messages: [{ role: "system", content: system }, { role: "user", content: user }] });
            return j.choices?.[0]?.message?.content ?? "";
        },
    };
}
