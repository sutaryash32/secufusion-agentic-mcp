// `@sfn` chat in PR threads — parsing, deciding what to answer, and the deterministic replies.
// Pure; unit-tested. The model is only used to answer questions (scripts/pr-chat.mjs).

export const REPLY_MARKER = (commentId) => `<!-- sfn-chat:reply-to:${commentId} -->`;
const REPLY_RE = /<!-- sfn-chat:reply-to:(\d+) -->/;
const FINDING_RE = /<!-- sfn-review:finding:([a-f0-9]{12}) -->/;
const ANY_OURS = /<!-- sfn-(review|chat|description)[:-]/;
const MENTION = /(^|[\s(>])@sfn\b/i;

/** @returns {undefined | {kind:'help'|'why'|'false_positive'|'question', text:string}} */
export function parseCommand(content = '') {
  if (ANY_OURS.test(content) || !MENTION.test(content)) return undefined;
  const text = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const after = text.slice(text.search(/@sfn\b/i) + 4).trim();
  if (/^(help|\?)?$/i.test(after)) return { kind: 'help', text: '' };
  if (/^(false[- ]?positive|fp|not a bug|wrong)\b/i.test(after)) {
    return { kind: 'false_positive', text: after.replace(/^(false[- ]?positive|fp|not a bug|wrong)\b[:\s-]*/i, '').trim() };
  }
  if (/^(why|explain)\b/i.test(after)) return { kind: 'why', text: after.replace(/^(why|explain)\b[?:\s-]*/i, '').trim() };
  return { kind: 'question', text: after };
}

/**
 * Comments that mention @sfn and have no reply from us yet.
 * @param {Array<{id:number, status:string, threadContext?:object, comments:Array<{id:number, content:string, isDeleted?:boolean, author?:{displayName?:string}}>}>} threads
 */
export function pendingMentions(threads) {
  const out = [];
  for (const t of threads) {
    const comments = (t.comments ?? []).filter((c) => !c.isDeleted);
    const answered = new Set(comments.map((c) => c.content?.match(REPLY_RE)?.[1]).filter(Boolean).map(Number));
    const findingId = comments[0]?.content?.match(FINDING_RE)?.[1];
    for (const c of comments) {
      const cmd = parseCommand(c.content);
      if (!cmd || answered.has(c.id)) continue;
      out.push({
        threadId: t.id,
        commentId: c.id,
        command: cmd,
        findingId,
        findingText: findingId ? comments[0].content : undefined,
        file: t.threadContext?.filePath?.replace(/^\//, ''),
        line: t.threadContext?.rightFileStart?.line,
        asker: c.author?.displayName,
        history: comments.filter((x) => x.id < c.id).map((x) => x.content).slice(-6),
      });
    }
  }
  return out;
}

export function helpReply(commentId) {
  return `${REPLY_MARKER(commentId)}
**sfn-code-reviewer** — mention \`@sfn\` in a comment:

| Command | What happens |
|---|---|
| \`@sfn why\` | (on a finding) explains the finding against this PR's code |
| \`@sfn false positive <reason>\` | (on a finding) marks it won't-fix and counts it against the rule's precision; replies with a suppression entry if it should be silenced for good |
| \`@sfn <question>\` | answers a question about this PR's code (read-only) — e.g. *is this endpoint tenant-safe?* |
| \`@sfn help\` | this message |

Replies arrive within ~10 minutes. The bot never changes code.`;
}

export function falsePositiveReply(m, today = new Date()) {
  const expires = new Date(today.getTime() + 90 * 86400000).toISOString().slice(0, 10);
  if (!m.findingId) {
    return `${REPLY_MARKER(m.commentId)}\n\`@sfn false positive\` only works on a reviewer finding thread. Reply on the finding you want to dismiss.`;
  }
  const reason = m.command.text || '<why it is not a problem>';
  return `${REPLY_MARKER(m.commentId)}
Marked as **false positive** — this thread is set to *Won't fix* and counts against the rule's precision (thanks, it tunes the reviewer).

If it should never be raised again for this code, add to \`rules/suppressions.yml\` in sfn-code-reviewer:

\`\`\`yaml
- id: ${m.findingId}
  reason: "${reason.replace(/"/g, "'").slice(0, 200)}"
  expires: ${expires}
\`\`\``;
}

export function answerReply(commentId, answer) {
  const body = String(answer ?? '').trim().slice(0, 3500) || '_No answer — the question could not be resolved from the code._';
  return `${REPLY_MARKER(commentId)}\n${body}\n\n<sub>sfn-code-reviewer · read-only answer from this PR's code; may be wrong — verify before acting.</sub>`;
}
