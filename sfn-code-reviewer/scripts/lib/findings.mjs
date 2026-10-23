// Finding identity, suppressions and the CI gate. Pure functions — unit-tested.
import { createHash } from 'node:crypto';
import { globToRegExp } from './glob.mjs';

export const SEVERITY_RANK = { nit: 1, minor: 2, major: 3, blocker: 4 };

/** Stable across runs: does not include line numbers or wording, only what the finding is about. */
export function findingId(f, defaultRepo) {
  const key = [f.repo ?? defaultRepo, f.file, f.anchor, f.ruleId].join('|');
  return createHash('sha1').update(key).digest('hex').slice(0, 12);
}

export function assignIds(findings, defaultRepo) {
  return findings.map((f) => ({ ...f, repo: f.repo ?? defaultRepo, id: findingId(f, defaultRepo) }));
}

/**
 * @returns {{kept: object[], suppressed: object[], expired: object[]}}
 * `expired` = suppression entries past their date (they no longer apply — surfaced so someone renews or deletes them).
 */
export function applySuppressions(findings, suppressions, today = new Date().toISOString().slice(0, 10)) {
  const active = [];
  const expired = [];
  for (const s of suppressions) (s.expires && s.expires < today ? expired : active).push(s);

  const kept = [];
  const suppressed = [];
  for (const f of findings) {
    const hit = active.find((s) => {
      if (s.id) return s.id === f.id;
      if (s.ruleId && s.ruleId !== f.ruleId) return false;
      if (s.repo && s.repo !== f.repo) return false;
      if (s.anchor && s.anchor !== f.anchor) return false;
      if (s.path && !globToRegExp(s.path).test(f.file)) return false;
      return Boolean(s.ruleId || s.path);
    });
    if (hit) suppressed.push({ ...f, suppressedBy: { reason: hit.reason, expires: hit.expires, owner: hit.owner } });
    else kept.push(f);
  }
  return { kept, suppressed, expired };
}

/**
 * @param {object|undefined} result finalized review result, or undefined if the review failed
 * @param {{failOn:string, blockOnPossible:boolean, onReviewError:string}} gate
 */
export function gateDecision(result, gate) {
  if (!result) {
    return gate.onReviewError === 'warn'
      ? { exitCode: 0, status: 'warn', message: 'Review failed to produce a valid result (onReviewError=warn).' }
      : { exitCode: 2, status: 'error', message: 'Review failed to produce a valid result (onReviewError=fail).' };
  }
  if (gate.failOn === 'none') {
    return { exitCode: 0, status: 'pass', message: `Verdict ${result.verdict}; gate disabled.`, blocking: [] };
  }
  const threshold = SEVERITY_RANK[gate.failOn];
  if (!threshold) throw new Error(`Unknown gate.failOn "${gate.failOn}"`);
  const blocking = result.findings.filter(
    (f) => SEVERITY_RANK[f.severity] >= threshold && (gate.blockOnPossible || f.confidence === 'confirmed'),
  );
  return blocking.length
    ? { exitCode: 1, status: 'fail', message: `${blocking.length} finding(s) at or above "${gate.failOn}".`, blocking }
    : { exitCode: 0, status: 'pass', message: `Verdict ${result.verdict}; nothing at or above "${gate.failOn}".`, blocking };
}

/** Raises findings of critical rules to their floor severity; records the model's original rating. */
export function applySeverityFloors(findings, floors = {}) {
  return findings.map((f) => {
    const floor = floors[f.ruleId];
    if (!floor || SEVERITY_RANK[f.severity] >= SEVERITY_RANK[floor]) return f;
    return { ...f, severity: floor, ratedSeverity: f.severity };
  });
}

/**
 * Noise cap: keeps every blocker/major; keeps the best `maxMinor` minors and `maxNit` nits (confirmed
 * first); no nits at quick level unless allowed. Returns { kept, trimmed }. Input must be sorted.
 */
export function trimNoise(sorted, { maxMinor = 5, maxNit = 3, nitsAtQuick = false } = {}, level) {
  const kept = [];
  const trimmed = [];
  let minors = 0;
  let nits = 0;
  for (const f of sorted) {
    if (f.severity === 'minor' && minors++ >= maxMinor) trimmed.push(f);
    else if (f.severity === 'nit' && ((level === 'quick' && !nitsAtQuick) || nits++ >= maxNit)) trimmed.push(f);
    else kept.push(f);
  }
  return { kept, trimmed };
}

export function sortFindings(findings) {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      (a.confidence === b.confidence ? 0 : a.confidence === 'confirmed' ? -1 : 1) ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  );
}
