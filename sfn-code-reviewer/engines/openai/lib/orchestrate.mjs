// The review pipeline for the OpenAI engine, orchestrated in code (not by a model):
//   specialists (parallel) → verify (parallel batches) → dedupe → deterministic verdict → summary.
// `agent` is injected so the whole flow is testable without an API.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SEVERITY_RANK } from '../../../scripts/lib/findings.mjs';
import { createValidator } from '../../../scripts/lib/validate.mjs';
import { decideVerdict } from '../../../scripts/lib/verdict.mjs';
import { verifyFindings } from '../../../scripts/lib/verify.mjs';

export { decideVerdict };

/** Loads provider-neutral prompts from prompts/, keyed by category. */
export function loadPrompts(promptsDir) {
  const strip = (t) => t.replace(/^---\n[\s\S]*?\n---\n+/, '');
  const meta = (t, k) => t.match(new RegExp(`^${k}:\\s*(.+)$`, 'm'))?.[1]?.trim();
  const shared = ['severity-guide.md', 'output-contract.md'].map((f) => readFileSync(join(promptsDir, 'shared', f), 'utf8')).join('\n');
  const specialists = {};
  for (const f of readdirSync(join(promptsDir, 'specialists')).filter((x) => x.endsWith('.md'))) {
    const t = readFileSync(join(promptsDir, 'specialists', f), 'utf8');
    specialists[meta(t, 'category')] = `${strip(t)}\n${shared}`;
  }
  const general = readFileSync(join(promptsDir, 'general.md'), 'utf8');
  specialists.general = `${strip(general)}\n${shared}`;
  return { specialists, verify: strip(readFileSync(join(promptsDir, 'verify.md'), 'utf8')) };
}

/**
 * @param {object} o
 * @param {object} o.scope        parsed scope.json
 * @param {string} o.scopePath
 * @param {object} o.prompts      from loadPrompts()
 * @param {Function} o.agent      ({name, model, system, user, tools:boolean, expectKey}) => Promise<object>
 * @param {{orchestrator:string, specialist:string, verify:string}} o.models
 * @param {object[]} o.schemas    [finding.schema.json, review-result.schema.json]
 * @param {Function} [o.log]
 */
export async function orchestrate({ scope, scopePath, prompts, agent, models, schemas, log = () => {} }) {
  const validate = createValidator(schemas);
  const task = `Review the change described by the scope file ${scopePath}. Follow your procedure and return your JSON.`;

  // 1. specialists (+ general pass), in parallel, one retry each
  const keys = [...scope.specialists, ...(scope.generalPass ? ['general'] : [])].filter((k) => prompts.specialists[k]);
  const runSpecialist = (key) =>
    agent({ name: key, model: models.specialist, system: prompts.specialists[key], user: task, tools: true, expectKey: 'findings' });
  const settled = await Promise.allSettled(keys.map((k) => runSpecialist(k).catch((e) => {
    log(`${k} failed (${e.message}); retrying once`);
    return runSpecialist(k);
  })));

  const failed = [];
  const blast = {};
  let candidates = [];
  let dropped = 0;
  settled.forEach((s, i) => {
    const key = keys[i];
    if (s.status === 'rejected') { failed.push(key); log(`${key} failed: ${s.reason?.message}`); return; }
    for (const [k, list] of Object.entries(s.value.blastRadius ?? {})) {
      if (Array.isArray(list)) blast[k] = [...new Set([...(blast[k] ?? []), ...list.map(String)])];
    }
    for (const raw of s.value.findings ?? []) {
      const f = normalise(raw, key, scope.repoKey);
      const errs = validate('finding.schema.json', f);
      if (errs.length) { dropped++; log(`${key}: dropped malformed finding (${errs.slice(0, 3).join('; ')})`); continue; }
      candidates.push(f);
    }
  });

  // 2. verify (batched per specialist, parallel) — shared with cross-model verification
  let rejectedCount = 0;
  if (scope.verify && candidates.length) {
    const v = await verifyFindings({
      findings: candidates,
      scopePath,
      ask: ({ name, user }) => agent({ name, model: models.verify, system: prompts.verify, user, tools: true, expectKey: 'decisions' }),
      log,
    });
    candidates = v.kept;
    rejectedCount = v.rejected.length;
  }

  // 3. dedupe (same repo/file/anchor/rule → keep the more severe)
  const byKey = new Map();
  for (const f of candidates) {
    const k = [f.repo, f.file, f.anchor, f.ruleId].join('|');
    const prev = byKey.get(k);
    if (!prev || SEVERITY_RANK[f.severity] > SEVERITY_RANK[prev.severity]) byKey.set(k, f);
  }
  const findings = [...byKey.values()];

  // 4. verdict (deterministic) + summary (model, with a fallback)
  const { verdict, reason } = decideVerdict(findings, {
    failed, dropped, missingRepos: scope.missingRepos ?? [], contractsRan: keys.includes('contracts'),
  });
  let summary;
  let walkthrough;
  let testPlan;
  try {
    const out = await agent({
      name: 'summary',
      model: models.orchestrator,
      system: 'You write the summary of a code review for a reviewer who has not read the diff. Return one fenced JSON block: {"summary": "2-5 plain sentences: what the change does and where its risk is", "walkthrough": [{"area": "behavioural area", "files": ["path"], "change": "1-2 sentences"}] (max 8, grouped by behaviour), "testPlan": ["concrete check before merge"] (max 6, driven by this change\'s risk, no generic advice)}.',
      user: JSON.stringify({
        repo: scope.repoKey,
        files: (scope.changedFiles ?? []).slice(0, 80).map((f) => `${f.status} ${f.path} (+${f.added}/-${f.removed})`),
        findings: findings.map((f) => `${f.severity} ${f.ruleId} ${f.title}`),
        verdict,
      }),
      tools: false,
      expectKey: 'summary',
    });
    summary = String(out.summary);
    if (Array.isArray(out.walkthrough)) walkthrough = out.walkthrough.slice(0, 8).filter((w) => w && w.area && w.change).map((w) => ({ area: String(w.area).slice(0, 80), files: Array.isArray(w.files) ? w.files.map(String) : [], change: String(w.change).slice(0, 400) }));
    if (Array.isArray(out.testPlan)) testPlan = out.testPlan.slice(0, 6).map(String).filter((t) => t.length >= 5).map((t) => t.slice(0, 300));
  } catch (e) {
    log(`summary failed: ${e.message}`);
  }
  if (!summary || summary.length < 10) {
    summary = `${scope.changedFiles?.length ?? 0} file(s) changed in ${scope.repoKey}; ${findings.length} finding(s) after verification.`;
  }

  return {
    schemaVersion: 1,
    summary,
    blastRadius: blast,
    ...(walkthrough?.length ? { walkthrough } : {}),
    ...(testPlan?.length ? { testPlan } : {}),
    findings,
    rejectedCount,
    specialistsRun: keys.filter((k) => !failed.includes(k)),
    verdict,
    verdictReason: reason,
  };
}

function normalise(raw, specialist, repoKey) {
  const f = { ...raw, specialist };
  delete f.id;
  delete f.n;
  if (!f.category) f.category = specialist === 'general' ? 'general' : specialist;
  if (f.repo === repoKey || f.repo === '' || f.repo == null) delete f.repo;
  if (typeof f.line === 'string') f.line = Number.parseInt(f.line, 10);
  if (typeof f.endLine === 'string') f.endLine = Number.parseInt(f.endLine, 10);
  if (!Number.isInteger(f.endLine)) delete f.endLine;
  if (!f.ruleId) f.ruleId = 'GEN';
  return f;
}
