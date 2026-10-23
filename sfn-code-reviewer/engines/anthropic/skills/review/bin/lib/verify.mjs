// Engine-neutral adversarial verification: batches candidate findings, asks a verifier agent for
// confirm / downgrade / reject decisions, applies them. Used by the OpenAI engine (same-model verify)
// and by scripts/cross-verify.mjs (the other provider checks the first one's findings).
import { SEVERITY_RANK } from './findings.mjs';

const BATCH = 15;
const PARALLEL = 4;

/**
 * @param {object} o
 * @param {object[]} o.findings
 * @param {string} o.scopePath
 * @param {(batch:{name:string,user:string}) => Promise<{decisions:object[]}>} o.ask
 * @param {'same'|'cross'} [o.mode]  cross: never raise severity; reasons go to `crossVerification`
 * @param {Function} [o.log]
 * @returns {Promise<{kept:object[], rejected:object[], stats:{confirmed:number, downgraded:number, rejected:number, unverified:number}}>}
 */
export async function verifyFindings({ findings, scopePath, ask, mode = 'same', log = () => {} }) {
  const groups = new Map();
  for (const f of findings) {
    const k = f.specialist ?? f.category ?? 'general';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(f);
  }
  const batches = [];
  for (const [k, list] of groups) for (let i = 0; i < list.length; i += BATCH) batches.push({ key: k, items: list.slice(i, i + BATCH) });

  const stats = { confirmed: 0, downgraded: 0, rejected: 0, unverified: 0 };
  const results = await pool(batches, PARALLEL, async ({ key, items }) => {
    const numbered = items.map((f, n) => ({ n, ...stripInternal(f) }));
    try {
      const out = await ask({
        name: `verify:${key}`,
        user: `Scope file: ${scopePath}\n\nCandidate findings:\n\`\`\`json\n${JSON.stringify(numbered, null, 2)}\n\`\`\``,
      });
      return applyDecisions(items, out?.decisions ?? [], mode, stats);
    } catch (e) {
      log(`verify failed for ${key}: ${e.message} — keeping its findings unverified`);
      stats.unverified += items.length;
      const note = 'not verified (verifier failed)';
      return { kept: items.map((f) => (mode === 'cross' ? { ...f, crossVerification: note } : { ...f, confidence: 'possible', verification: note })), rejected: [] };
    }
  });
  return { kept: results.flatMap((r) => r.kept), rejected: results.flatMap((r) => r.rejected), stats };
}

export function applyDecisions(items, decisions, mode, stats) {
  const byN = new Map(decisions.map((d) => [Number(d.n), d]));
  const kept = [];
  const rejected = [];
  items.forEach((f, n) => {
    const d = byN.get(n);
    const note = d?.verification ? String(d.verification) : undefined;
    const field = mode === 'cross' ? 'crossVerification' : 'verification';
    if (!d) {
      stats.unverified++;
      kept.push(mode === 'cross' ? { ...f, crossVerification: 'no decision returned' } : { ...f, confidence: 'possible', verification: 'not verified (no decision returned)' });
      return;
    }
    if (d.decision === 'reject') {
      stats.rejected++;
      rejected.push({ ...f, [field]: note ?? 'rejected' });
      return;
    }
    let severity = SEVERITY_RANK[d.severity] ? d.severity : f.severity;
    // A second opinion may lower severity, never raise it.
    if (mode === 'cross' && SEVERITY_RANK[severity] > SEVERITY_RANK[f.severity]) severity = f.severity;
    const confirmed = d.decision === 'confirm' || d.confidence === 'confirmed';
    const confidence = mode === 'cross'
      ? (confirmed && f.confidence === 'confirmed') || (d.decision === 'confirm') ? 'confirmed' : 'possible'
      : confirmed ? 'confirmed' : 'possible';
    if (d.decision === 'downgrade') stats.downgraded++;
    else stats.confirmed++;
    kept.push({ ...f, severity, confidence, ...(note ? { [field]: note } : {}) });
  });
  return { kept, rejected };
}

function stripInternal(f) {
  const { id, verification, crossVerification, ...rest } = f;
  return verification ? { ...rest, firstVerification: verification } : rest;
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}
