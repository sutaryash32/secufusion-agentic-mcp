// Consensus across N independent review runs of the same change. Pure; unit-tested.
// Models vary run to run (backtest !1111 reported a different major each time). A finding is kept when
//   - at least `minAgree` runs reported it, or
//   - any run reported it as a CONFIRMED blocker/major of a CRITICAL rule (those with a severity floor:
//     cross-tenant, auth, migrations/deletes, contract breaks) — a verified catch there is not thrown
//     away. Other categories (e.g. "missing test", trivially "confirmed") need agreement (backtest !1111).
// and the rest are listed under `consensus.seenOnce` (shown hidden in the report, never posted).
import { SEVERITY_RANK } from './findings.mjs';
import { decideVerdict } from './verdict.mjs';

const NEAR = 15;

function sameIssue(a, b) {
  if ((a.repo ?? '') !== (b.repo ?? '') || a.file !== b.file || a.ruleId !== b.ruleId) return false;
  return a.anchor === b.anchor || Math.abs((a.line ?? 0) - (b.line ?? 0)) <= NEAR;
}

const better = (a, b) =>
  SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
  (a.confidence === b.confidence ? 0 : a.confidence === 'confirmed' ? -1 : 1);

/**
 * @param {object[]} results  N raw review results (same schema the engines emit)
 * @param {{minAgree?:number, missingRepos?:string[], criticalRules?:string[]}} opts
 */
export function mergeRuns(results, { minAgree = 2, missingRepos = [], criticalRules = [] } = {}) {
  const critical = new Set(criticalRules);
  const ok = results.filter((r) => r && Array.isArray(r.findings));
  if (!ok.length) throw new Error('no usable run to merge');
  const n = ok.length;
  const clusters = [];
  ok.forEach((r, run) => {
    for (const f of r.findings) {
      const c = clusters.find((x) => sameIssue(x.items[0].f, f));
      if (c) c.items.push({ run, f });
      else clusters.push({ items: [{ run, f }] });
    }
  });

  const kept = [];
  const seenOnce = [];
  for (const c of clusters) {
    const runs = new Set(c.items.map((i) => i.run)).size;
    const best = c.items.map((i) => i.f).sort(better)[0];
    const strongConfirmed = c.items.some((i) => critical.has(i.f.ruleId) && SEVERITY_RANK[i.f.severity] >= SEVERITY_RANK.major && i.f.confidence === 'confirmed');
    const out = { ...best, consensus: `${runs}/${n}` };
    if (runs >= Math.min(minAgree, n) || strongConfirmed) kept.push(out);
    else seenOnce.push(out);
  }

  const union = (key) => {
    const o = {};
    for (const r of ok) for (const [k, v] of Object.entries(r[key] ?? {})) o[k] = [...new Set([...(o[k] ?? []), ...(v ?? [])])];
    return o;
  };
  const specialistsRun = [...new Set(ok.flatMap((r) => r.specialistsRun ?? []))];
  const { verdict, reason } = decideVerdict(kept, { missingRepos, contractsRan: specialistsRun.includes('contracts') });
  return {
    schemaVersion: 1,
    summary: ok[0].summary,
    ...(ok[0].walkthrough ? { walkthrough: ok[0].walkthrough } : {}),
    ...(ok[0].testPlan ? { testPlan: ok[0].testPlan } : {}),
    blastRadius: union('blastRadius'),
    findings: kept,
    rejectedCount: ok.reduce((s, r) => s + (r.rejectedCount ?? 0), 0),
    specialistsRun,
    verdict,
    verdictReason: `${reason} (consensus of ${n} runs; ${seenOnce.length} finding(s) seen in only one run are hidden)`,
    consensus: { runs: n, failedRuns: results.length - n, kept: kept.length, seenOnce },
  };
}
