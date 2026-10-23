// PR description from a review result. Pure; unit-tested.
// The reviewer's text lives between markers, so re-runs replace only its own section and human text is
// never touched. Azure DevOps caps PR descriptions at 4000 characters.
export const START = '<!-- sfn-description:start -->';
export const END = '<!-- sfn-description:end -->';
export const ADO_LIMIT = 4000;

export function buildSection(r) {
  const s = r.scope ?? {};
  const parts = [START, '### What this PR does', '', r.summary ?? ''];
  if (r.walkthrough?.length) {
    parts.push('', '### Changes', ...r.walkthrough.map((w) => `- **${w.area}** — ${w.change}`));
  }
  const blast = Object.entries(r.blastRadius ?? {}).filter(([, l]) => l?.length);
  if (blast.length) parts.push('', '### Impact', ...blast.map(([k, l]) => `- ${k}: ${l.map((x) => `\`${x}\``).join(', ')}`));
  if (r.testPlan?.length) parts.push('', '### Test plan', ...r.testPlan.map((t) => `- [ ] ${t}`));
  parts.push('', `<sub>Drafted by sfn-code-reviewer${s.headSha ? ` at ${s.headSha.slice(0, 10)}` : ''} — edit freely; text outside this block is never changed.</sub>`, END);
  return fit(parts.join('\n'));
}

function fit(text, limit = ADO_LIMIT - 200) {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit - END.length - 40);
  return `${cut.slice(0, cut.lastIndexOf('\n'))}\n- …(truncated)\n${END}`;
}

/**
 * @param {string} current  the PR's description now
 * @param {string} section  output of buildSection
 * @param {'empty-only'|'append'} mode
 * @returns {{action:'write'|'skip', description?:string, reason:string}}
 */
export function planDescription(current = '', section, mode = 'empty-only') {
  const text = current ?? '';
  const hasOurs = text.includes(START) && text.includes(END);
  const human = hasOurs ? text.slice(0, text.indexOf(START)) + text.slice(text.indexOf(END) + END.length) : text;
  const humanIsEmpty = !human.replace(/<!--[\s\S]*?-->/g, '').trim();
  if (hasOurs) {
    const next = text.slice(0, text.indexOf(START)) + section + text.slice(text.indexOf(END) + END.length);
    if (next === text) return { action: 'skip', reason: 'description already up to date' };
    if (next.length > ADO_LIMIT) return { action: 'skip', reason: `would exceed ${ADO_LIMIT} characters` };
    return { action: 'write', description: next, reason: 'updating the reviewer section' };
  }
  if (humanIsEmpty) return { action: 'write', description: section, reason: 'description was empty' };
  if (mode !== 'append') return { action: 'skip', reason: 'author wrote a description (mode empty-only)' };
  const next = `${text.trimEnd()}\n\n${section}`;
  if (next.length > ADO_LIMIT) return { action: 'skip', reason: `appending would exceed ${ADO_LIMIT} characters` };
  return { action: 'write', description: next, reason: 'appended below the author text' };
}
