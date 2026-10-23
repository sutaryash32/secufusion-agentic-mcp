// Known-vulnerability lookup for CHANGED dependencies via OSV (https://osv.dev, no key).
// Only names + exact versions of added/changed dependencies are sent. Pure helpers + one fetcher.

/** Exact versions for npm packages from package-lock.json (lockfileVersion 2/3). */
export function lockVersions(lockText) {
  const out = {};
  try {
    const lock = JSON.parse(lockText);
    for (const [path, meta] of Object.entries(lock.packages ?? {})) {
      const m = path.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/);
      if (m && meta?.version && path === `node_modules/${m[1]}`) out[m[1]] = meta.version;
    }
  } catch { /* no/invalid lock */ }
  return out;
}

const EXACT = /^\d+\.\d+(\.\d+)?([.-][\w.]+)?$/;

/** @returns {{queries: object[], skipped: object[]}} */
export function buildQueries(dependencyChanges, npmLock = {}) {
  const queries = [];
  const skipped = [];
  for (const d of dependencyChanges) {
    if (d.change === 'removed' || d.name.startsWith('managed:')) continue;
    const pom = /(^|\/)pom\.xml$/.test(d.manifest);
    const name = pom ? d.name.replace(/^parent:/, '') : d.name;
    let version = pom ? d.to : npmLock[d.name] ?? String(d.to ?? '').replace(/^[~^=v]/, '');
    if (!version || !EXACT.test(version)) { skipped.push({ name, version: d.to, reason: 'no exact version (managed, range or property)' }); continue; }
    queries.push({ package: { name, ecosystem: pom ? 'Maven' : 'npm' }, version, dep: d });
  }
  return { queries, skipped };
}

export function severityOf(vuln) {
  const db = String(vuln.database_specific?.severity ?? '').toUpperCase();
  if (['CRITICAL', 'HIGH', 'MODERATE', 'MEDIUM', 'LOW'].includes(db)) return db === 'MODERATE' ? 'MEDIUM' : db;
  return 'UNKNOWN';
}

export function fixedVersions(vuln, name) {
  const out = new Set();
  for (const a of vuln.affected ?? []) {
    if (a.package?.name !== name) continue;
    for (const r of a.ranges ?? []) for (const e of r.events ?? []) if (e.fixed) out.add(e.fixed);
  }
  return [...out];
}

/** Queries OSV and returns one entry per vulnerable dependency. */
export async function auditWithOsv({ queries, baseUrl = 'https://api.osv.dev', fetchImpl = fetch }) {
  if (!queries.length) return [];
  const res = await fetchImpl(`${baseUrl}/v1/querybatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ queries: queries.map(({ package: p, version }) => ({ package: p, version })) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`OSV querybatch -> ${res.status}`);
  const { results = [] } = await res.json();
  const out = [];
  for (let i = 0; i < queries.length; i++) {
    const ids = (results[i]?.vulns ?? []).map((v) => v.id);
    if (!ids.length) continue;
    const vulns = [];
    for (const id of ids.slice(0, 10)) {
      const r = await fetchImpl(`${baseUrl}/v1/vulns/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(30_000) });
      if (!r.ok) { vulns.push({ id }); continue; }
      const v = await r.json();
      vulns.push({ id: v.id, aliases: v.aliases ?? [], summary: v.summary ?? '', severity: severityOf(v), fixed: fixedVersions(v, queries[i].package.name) });
    }
    const q = queries[i];
    out.push({ manifest: q.dep.manifest, name: q.package.name, ecosystem: q.package.ecosystem, version: q.version, change: q.dep.change, vulns, more: Math.max(0, ids.length - 10) });
  }
  return out;
}
