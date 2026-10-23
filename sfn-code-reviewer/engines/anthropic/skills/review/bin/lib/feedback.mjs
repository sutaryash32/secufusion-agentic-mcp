// Precision from real PR outcomes. Every inline thread the reviewer posts carries a marker; how the
// thread ended up tells us whether the finding was useful. Pure; unit-tested.
import { findingMarker } from './ado.mjs';

const MARKER = /<!-- sfn-review:finding:([a-f0-9]{12}) -->/;
const HEADER = /\*\*(BLOCKER|MAJOR|MINOR|NIT)\*\* · (confirmed|possible) · `([A-Z]+-\d{3}|GEN)`/;
const AUTO_RESOLVED = /No longer detected by sfn-code-reviewer/;

/**
 * @param {{status:string, comments:Array<{content:string}>}} thread
 * @param {string} prStatus active | completed | abandoned
 * @returns {undefined | {id, ruleId, severity, confidence, outcome}}
 *   outcome: fixed_by_code | resolved | dismissed | closed | ignored | open
 */
export function classifyThread(thread, prStatus) {
  const first = thread.comments?.[0]?.content ?? '';
  const m = first.match(MARKER);
  if (!m) return undefined;
  const h = first.match(HEADER);
  const replies = (thread.comments ?? []).slice(1).map((c) => c.content ?? '');
  const status = String(thread.status ?? '').toLowerCase();
  let outcome;
  if (status === 'fixed') outcome = replies.some((r) => AUTO_RESOLVED.test(r)) ? 'fixed_by_code' : 'resolved';
  else if (status === 'wontfix' || status === 'bydesign') outcome = 'dismissed';
  else if (status === 'closed') outcome = 'closed';
  else outcome = prStatus === 'completed' || prStatus === 'abandoned' ? 'ignored' : 'open';
  return { id: m[1], ruleId: h?.[3] ?? 'unknown', severity: h?.[1]?.toLowerCase() ?? 'unknown', confidence: h?.[2] ?? 'unknown', outcome };
}

/**
 * @param {Array<{pr:number, repo:string, url?:string, outcome:object}>} items
 * @param {{minDismissed:number, maxDismissRate:number}} opts
 */
export function aggregateFeedback(items, { minDismissed = 3, maxDismissRate = 0.5 } = {}) {
  const byRule = new Map();
  const totals = { posted: 0, fixed_by_code: 0, resolved: 0, dismissed: 0, closed: 0, ignored: 0, open: 0 };
  for (const it of items) {
    const o = it.outcome;
    totals.posted++;
    totals[o.outcome]++;
    const r = byRule.get(o.ruleId) ?? { ruleId: o.ruleId, posted: 0, fixed_by_code: 0, resolved: 0, dismissed: 0, closed: 0, ignored: 0, open: 0, dismissedExamples: [] };
    r.posted++;
    r[o.outcome]++;
    if (o.outcome === 'dismissed' && r.dismissedExamples.length < 5) r.dismissedExamples.push({ repo: it.repo, pr: it.pr, url: it.url, finding: o.id });
    byRule.set(o.ruleId, r);
  }
  const precision = (x) => {
    const useful = x.fixed_by_code + x.resolved;
    const judged = useful + x.dismissed;
    return judged ? +(useful / judged).toFixed(3) : null;
  };
  const rules = [...byRule.values()].map((r) => ({ ...r, precision: precision(r) })).sort((a, b) => b.posted - a.posted);
  const suggestions = rules
    .filter((r) => r.dismissed >= minDismissed && r.dismissed / (r.fixed_by_code + r.resolved + r.dismissed) > maxDismissRate)
    .map((r) => ({
      ruleId: r.ruleId,
      why: `${r.dismissed} of ${r.fixed_by_code + r.resolved + r.dismissed} judged findings were dismissed (precision ${r.precision})`,
      action: 'Review the dismissed examples: tighten the rule text or its default severity, or add a scoped suppression in rules/suppressions.yml.',
      examples: r.dismissedExamples,
    }));
  return { totals: { ...totals, precision: precision(totals) }, rules, suggestions };
}

export { findingMarker };
