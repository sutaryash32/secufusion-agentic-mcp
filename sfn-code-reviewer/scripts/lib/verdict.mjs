// Deterministic verdict — used by the OpenAI engine and after cross-model verification.
// Mirrors engines/anthropic/skills/review/reference/verdict.md.

export function decideVerdict(findings, { failed = [], dropped = 0, missingRepos = [], contractsRan = false } = {}) {
  const blockers = findings.filter((f) => f.severity === 'blocker');
  const confirmedMajors = findings.filter((f) => f.severity === 'major' && f.confidence === 'confirmed');
  if (blockers.length || confirmedMajors.length) {
    const top = [...blockers, ...confirmedMajors].slice(0, 3).map((f) => `${f.ruleId} ${f.title}`).join('; ');
    return { verdict: 'fix_first', reason: `${blockers.length} blocker(s), ${confirmedMajors.length} confirmed major(s): ${top}.` };
  }
  const open = [];
  if (failed.length) open.push(`specialist(s) failed: ${failed.join(', ')}`);
  if (dropped) open.push(`${dropped} finding(s) dropped as malformed`);
  const possibleMajors = findings.filter((f) => f.severity === 'major');
  if (possibleMajors.length) open.push(`${possibleMajors.length} unconfirmed major(s) need a human check`);
  if (contractsRan && missingRepos.length) open.push(`consumers in ${missingRepos.join(', ')} not checked`);
  if (open.length) return { verdict: 'needs_discussion', reason: `${open.join('; ')}.` };
  return { verdict: 'ready', reason: findings.length ? 'Only minor findings remain.' : 'No findings.' };
}
