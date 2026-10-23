// Azure DevOps PR comment planning. Pure: decides WHAT to post from (findings, existing threads);
// scripts/post-ado-pr.mjs does the HTTP. Every thread we own carries a hidden marker, which is how
// re-runs update instead of duplicating.
import { SEVERITY_RANK } from './findings.mjs';

export const SUMMARY_MARKER = '<!-- sfn-review:summary -->';
export const findingMarker = (id) => `<!-- sfn-review:finding:${id} -->`;
const FINDING_MARKER_RE = /<!-- sfn-review:finding:([a-f0-9]{12}) -->/;

const ICON = { blocker: '🛑', major: '🟠', minor: '🟡', nit: '⚪' };
const VERDICT = { ready: '✅ Ready', fix_first: '🛑 Fix first', needs_discussion: '💬 Needs discussion' };

export function formatFindingComment(f) {
  const ev = (f.evidence ?? [])
    .map((e) => `- \`${e.repo ? `${e.repo}/` : ''}${e.file}${e.line ? `:${e.line}` : ''}\` — ${e.note}`)
    .join('\n');
  return [
    findingMarker(f.id),
    `${ICON[f.severity]} **${f.severity.toUpperCase()}** · ${f.confidence} · \`${f.ruleId}\` — **${f.title}**`,
    '',
    f.problem,
    '',
    `**Fails when:** ${f.failureScenario}`,
    '',
    `**Fix:** ${f.suggestion}`,
    ev ? `\n<details><summary>Evidence</summary>\n\n${ev}\n</details>` : '',
    f.verification ? `\n_Verified:_ ${f.verification}` : '',
    f.crossVerification ? `\n_Cross-check:_ ${f.crossVerification}` : '',
    '',
    `<sub>sfn-code-reviewer · finding \`${f.id}\` · to accept this risk, add it to \`rules/suppressions.yml\`</sub>`,
  ].join('\n');
}

export function formatSummary(r, { notInline = [], reportUrl } = {}) {
  const s = r.scope ?? {};
  const count = (sev) => r.findings.filter((f) => f.severity === sev).length;
  const blast = Object.entries(r.blastRadius ?? {})
    .filter(([, l]) => l?.length)
    .map(([k, l]) => `- **${k}:** ${l.map((x) => `\`${x}\``).join(', ')}`)
    .join('\n');
  const extra = notInline
    .map((f) => `- ${ICON[f.severity]} \`${f.ruleId}\` **${f.title}** — \`${f.repo !== s.repoKey ? `${f.repo}/` : ''}${f.file}:${f.line}\``)
    .join('\n');
  return [
    SUMMARY_MARKER,
    `## sfn-code-reviewer — ${VERDICT[r.verdict] ?? r.verdict}`,
    '',
    r.summary,
    '',
    `**Why:** ${r.verdictReason}`,
    '',
    `| Blocker | Major | Minor | Nit | Suppressed | Rejected by verify | Risk |`,
    `|---|---|---|---|---|---|---|`,
    `| ${count('blocker')} | ${count('major')} | ${count('minor')} | ${count('nit')} | ${r.suppressed?.length ?? 0} | ${r.rejectedCount} | ${s.risk?.score ?? '–'}/10 (${s.level ?? '–'}) |`,
    r.walkthrough?.length ? `\n<details><summary><b>Walkthrough</b> — ${r.walkthrough.length} area(s)</summary>\n\n${r.walkthrough.map((w) => `- **${w.area}** — ${w.change}${w.files?.length ? ` <sub>${w.files.map((f) => `\`${f}\``).join(', ')}</sub>` : ''}`).join('\n')}\n</details>` : '',
    r.testPlan?.length ? `\n<details><summary><b>Suggested test plan</b></summary>\n\n${r.testPlan.map((t) => `- [ ] ${t}`).join('\n')}\n</details>` : '',
    r.delta ? `\n**Since last review** (\`${(r.delta.previousHeadSha ?? '').slice(0, 10)}\`): ✅ ${r.delta.fixed.length} fixed · 🆕 ${r.delta.new.length} new · ⏳ ${r.delta.stillOpen.length} still open` : '',
    r.crossVerify ? `\n**Cross-checked by ${r.crossVerify.verifier}:** ${r.crossVerify.confirmed} confirmed · ${r.crossVerify.downgraded} downgraded · ${r.crossVerify.rejected} rejected` : '',
    extra ? `\n**Not posted inline** (other repo, nit, or over the comment cap):\n${extra}` : '',
    blast ? `\n**Blast radius**\n${blast}` : '',
    s.suggestedReviewers?.length ? `\n**Suggested reviewers:** ${s.suggestedReviewers.map((x) => `${x.name} (${x.why})`).join(' · ')}` : '',
    s.missingRepos?.length ? `\n⚠️ Not checked — repos missing from the estate: ${s.missingRepos.join(', ')}` : '',
    reportUrl ? `\n[Full report and SARIF](${reportUrl})` : '',
    '',
    `<sub>${r.engine?.provider ?? ''} · ${s.headSha ? `commit ${s.headSha.slice(0, 10)}` : ''} · re-runs update this comment</sub>`,
  ].join('\n');
}

/**
 * @param {object} r finalized review result
 * @param {Array<{id:number,status:string,comments:Array<{id:number,content:string}>}>} threads existing PR threads
 * @param {{maxInline:number, minInlineSeverity:string}} opts
 */
export function planThreads(r, threads, { maxInline = 25, minInlineSeverity = 'minor' } = {}) {
  const ours = new Map();
  let summaryThread;
  for (const t of threads) {
    const first = t.comments?.[0]?.content ?? '';
    if (first.includes(SUMMARY_MARKER)) summaryThread = t;
    const m = first.match(FINDING_MARKER_RE);
    if (m) ours.set(m[1], t);
  }

  const repoKey = r.scope?.repoKey;
  const inlineable = r.findings.filter(
    (f) => f.repo === repoKey && SEVERITY_RANK[f.severity] >= SEVERITY_RANK[minInlineSeverity],
  );
  const toCreate = [];
  const notInline = r.findings.filter((f) => !inlineable.includes(f));
  let budget = maxInline;
  for (const f of inlineable) {
    if (ours.has(f.id)) continue; // already posted on an earlier run; leave the conversation alone
    if (budget-- > 0) toCreate.push(f);
    else notInline.push(f);
  }

  const current = new Set(r.findings.map((f) => f.id));
  const toResolve = [...ours.entries()]
    .filter(([id, t]) => !current.has(id) && t.status === 'active')
    .map(([id, t]) => ({ id, threadId: t.id }));

  return { toCreate, toResolve, notInline, summaryThread };
}
