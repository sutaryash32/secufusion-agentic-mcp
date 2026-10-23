// One tool-using agent: chat → tool calls → results → … → final fenced JSON.

export const TOOL_ADAPTER_NOTE = `
## Tools in this environment

You have these read-only tools: \`read_file\`, \`grep\`, \`glob\`, \`list_dir\`, \`git\`.
Where your procedure says to run a shell or git command (e.g. the scope's \`diffCmd\`, which runs in
\`repoPath\`), call the \`git\` tool instead: \`repo\` = the directory, \`args\` = everything after \`git\`.
Example for diffCmd \`git diff A B\` → {"repo":"<repoPath>","args":["diff","A","B"]}.
Make several tool calls at once when they're independent.`;

/**
 * Pull a JSON object containing `key` out of model text (fenced block preferred).
 * @returns {object|undefined}
 */
export function parseJsonWithKey(text, key) {
  if (!text) return undefined;
  const tryParse = (s) => { try { return JSON.parse(s); } catch { return undefined; } };
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)].map((m) => m[1]).reverse();
  for (const body of [...fences, text.trim(), text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)]) {
    const o = tryParse(body);
    if (o && typeof o === 'object' && key in o) return o;
  }
  return undefined;
}

/**
 * @param {object} o
 * @param {{chat:Function}} o.client
 * @param {string} o.model
 * @param {string} o.system
 * @param {string} o.user
 * @param {{definitions:object[], exec:Function}} [o.tools]
 * @param {string} o.expectKey   key the final JSON must contain (findings | decisions | summary)
 * @param {{add:Function, check:Function}} o.budget
 * @param {number} [o.maxTurns]
 * @param {object} [o.params]    extra request params (max_completion_tokens, reasoning_effort)
 * @param {Function} [o.log]
 */
export async function runAgent({ client, model, system, user, tools, expectKey, budget, maxTurns = 40, params = {}, log = () => {}, name = 'agent' }) {
  const messages = [
    { role: 'system', content: tools ? `${system}\n${TOOL_ADAPTER_NOTE}` : system },
    { role: 'user', content: user },
  ];
  let formatNudges = 0;

  const ask = async (extra = {}) => {
    budget.check();
    const res = await client.chat({
      model,
      messages,
      ...(tools ? { tools: tools.definitions, tool_choice: 'auto', parallel_tool_calls: true } : {}),
      ...params,
      ...extra,
    });
    budget.add(res.usage);
    const msg = res.choices?.[0]?.message;
    if (!msg) throw new Error(`${name}: empty response`);
    messages.push({ role: 'assistant', content: msg.content ?? '', ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) });
    return msg;
  };

  for (let turn = 1; turn <= maxTurns; turn++) {
    const msg = await ask();
    if (msg.tool_calls?.length) {
      const results = await Promise.all(
        msg.tool_calls.map(async (c) => ({ id: c.id, out: await tools.exec(c.function?.name, c.function?.arguments) })),
      );
      for (const r of results) messages.push({ role: 'tool', tool_call_id: r.id, content: r.out });
      log(`${name}: turn ${turn}, ${msg.tool_calls.map((c) => c.function?.name).join(', ')}`);
      continue;
    }
    const out = parseJsonWithKey(msg.content, expectKey);
    if (out) return out;
    if (formatNudges++ >= 2) throw new Error(`${name}: final answer had no JSON with "${expectKey}"`);
    messages.push({ role: 'user', content: `Your final message must be exactly one fenced \`\`\`json block containing "${expectKey}", and nothing after it. Send it now.` });
  }

  // Out of turns: one last answer, tools disabled.
  messages.push({ role: 'user', content: `Turn limit reached. Stop investigating and return your JSON (with "${expectKey}") now, based on what you have. Mark anything you could not finish as confidence "possible".` });
  const last = await ask(tools ? { tool_choice: 'none' } : {});
  const out = parseJsonWithKey(last.content, expectKey);
  if (!out) throw new Error(`${name}: no JSON after the turn limit`);
  return out;
}
