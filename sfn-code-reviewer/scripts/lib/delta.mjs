// Re-review delta: what changed since the previous review of the same repo. Pure; unit-tested.
// Works because finding ids are stable (repo|file|anchor|ruleId), not tied to line numbers or wording.

const brief = (f) => ({ id: f.id, ruleId: f.ruleId, severity: f.severity, title: f.title, file: f.file, line: f.line });

/**
 * @param {object|undefined} previous finalized review-result of an earlier run
 * @param {object[]} findings current findings (with ids, after suppressions)
 * @param {string} repoKey
 * @returns {object|undefined} undefined when there's nothing comparable
 */
export function computeDelta(previous, findings, repoKey) {
  if (!previous?.findings || previous.scope?.repoKey !== repoKey) return undefined;
  const before = new Map(previous.findings.map((f) => [f.id, f]));
  const now = new Map(findings.map((f) => [f.id, f]));
  return {
    previousHeadSha: previous.scope?.headSha ?? null,
    previousVerdict: previous.verdict ?? null,
    fixed: [...before.values()].filter((f) => !now.has(f.id)).map(brief),
    new: [...now.values()].filter((f) => !before.has(f.id)).map(brief),
    stillOpen: [...now.values()].filter((f) => before.has(f.id)).map(brief),
  };
}
