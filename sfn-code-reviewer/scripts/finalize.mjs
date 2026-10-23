#!/usr/bin/env node
// Turns raw engine output into the final, validated review-result.json:
//   extract JSON -> validate against the schema -> assign stable ids -> apply suppressions -> sort
//   -> attach scope + engine metadata.
// Fails closed: invalid output writes <out>.error.json and exits 3 — it never becomes a "pass".
//
//   node finalize.mjs --scope scope.json (--raw raw.txt | --skipped) --out review-result.json
//                     [--engine '{"provider":"anthropic",...}']
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { linkBlastRadius } from './lib/blastmap.mjs';
import { computeDelta } from './lib/delta.mjs';
import { decideVerdict } from './lib/verdict.mjs';
import { applySeverityFloors, assignIds, applySuppressions, sortFindings, trimNoise } from './lib/findings.mjs';
import { loadConfig, readJson } from './lib/paths.mjs';
import { createValidator, extractResult } from './lib/validate.mjs';

const { values: args } = parseArgs({
  options: {
    scope: { type: 'string' },
    raw: { type: 'string' },
    skipped: { type: 'boolean', default: false },
    out: { type: 'string' },
    engine: { type: 'string' },
    previous: { type: 'string' },
  },
});
if (!args.scope || !args.out || (!args.raw && !args.skipped)) {
  console.error('usage: finalize.mjs --scope <scope.json> (--raw <file> | --skipped) --out <file> [--engine <json>]');
  process.exit(64);
}

const cfg = loadConfig();
const scope = readJson(args.scope);
const engine = args.engine ? JSON.parse(args.engine) : { provider: 'unknown' };

let result;
if (args.skipped) {
  result = {
    schemaVersion: 1,
    summary: `Not reviewed: ${scope.skipReason ?? 'nothing to review.'}`,
    blastRadius: {},
    findings: [],
    rejectedCount: 0,
    specialistsRun: [],
    verdict: 'ready',
    verdictReason: scope.skipReason ?? 'Nothing to review.',
  };
} else {
  if (!existsSync(args.raw)) failClosed([`Engine produced no output file (${args.raw}).`], '');
  const raw = readFileSync(args.raw, 'utf8');
  result = extractResult(raw);
  if (!result) failClosed([engineError(raw) ?? 'No JSON result found in the engine output.'], raw);
}

// Deterministic findings (quick-check / deploy-order) join the model's, unless the model already reported
// the same issue (same rule + file, within 15 lines).
if (scope.quickCheckFile && existsSync(scope.quickCheckFile)) {
  try {
    const qc = JSON.parse(readFileSync(scope.quickCheckFile, 'utf8')).findings ?? [];
    const dup = (q) => (result.findings ?? []).some((f) => f.ruleId === q.ruleId && f.file === q.file && Math.abs((f.line ?? 0) - (q.line ?? 0)) <= 15);
    result.findings = [...(result.findings ?? []), ...qc.filter((q) => !dup(q))];
  } catch (e) { console.error(`[sfn-review] quick-check findings ignored: ${e.message}`); }
}

const validate = createValidator([
  readJson(join(cfg.schemasDir, 'finding.schema.json')),
  readJson(join(cfg.schemasDir, 'review-result.schema.json')),
]);
// Models sometimes add ids or omit schemaVersion; normalise before validating.
result.schemaVersion = 1;
result.findings = (result.findings ?? []).map(({ id, ...f }) => f);
const errors = validate('review-result.schema.json', result);
if (errors.length) failClosed(errors, JSON.stringify(result, null, 2));

const withIds = applySeverityFloors(assignIds(result.findings, scope.repoKey), cfg.review.severityFloors);
const { kept, suppressed, expired } = applySuppressions(withIds, cfg.suppressions);

const { kept: shown, trimmed } = trimNoise(sortFindings(kept), cfg.review.limits, scope.level);
// A floor can turn a "ready" into a blocker/major — the verdict must follow the floored severities.
if (shown.some((f) => f.ratedSeverity) && result.verdict !== 'fix_first') {
  const v = decideVerdict(shown, { missingRepos: scope.missingRepos ?? [], contractsRan: (result.specialistsRun ?? []).includes('contracts') });
  if (v.verdict !== 'ready' || result.verdict === 'ready') {
    result.verdict = v.verdict === 'ready' ? result.verdict : v.verdict;
    result.verdictReason = `${v.reason} (severity floor applied)`;
  }
}
const final = {
  ...result,
  blastLinks: linkBlastRadius(result.blastRadius, scope.repoKey, cfg.repos),
  findings: shown,
  trimmed,
  suppressed,
  engine,
  scope: {
    repoKey: scope.repoKey,
    base: scope.base,
    head: scope.head,
    headSha: scope.headSha,
    mergeBase: scope.mergeBase,
    workingTree: scope.workingTree,
    filesChanged: scope.changedFiles?.length ?? 0,
    linesChanged: scope.risk?.linesChanged ?? 0,
    level: scope.level ?? null,
    risk: scope.risk,
    specialistsPlanned: scope.specialists ?? [],
    notYetAvailable: scope.notYetAvailable ?? [],
    missingRepos: scope.missingRepos ?? [],
    ...(scope.pr ? { pr: scope.pr } : {}),
    historyHints: scope.historyHints?.length ?? 0,
    suggestedReviewers: scope.suggestedReviewers ?? [],
    liveDb: Boolean(scope.dbSchemaFile),
    depAudit: Boolean(scope.depAuditFile),
    expiredSuppressions: expired.length,
  },
};

if (args.previous && existsSync(args.previous)) {
  try {
    const delta = computeDelta(readJson(args.previous), final.findings, scope.repoKey);
    if (delta) final.delta = delta;
  } catch (e) {
    console.error(`[sfn-review] previous result unreadable, no delta: ${e.message}`);
  }
}

writeFileSync(args.out, JSON.stringify(final, null, 2));
const counts = Object.fromEntries(['blocker', 'major', 'minor', 'nit'].map((s) => [s, final.findings.filter((f) => f.severity === s).length]));
console.error(
  `[sfn-review] verdict=${final.verdict} blocker=${counts.blocker} major=${counts.major} minor=${counts.minor} nit=${counts.nit} ` +
    `suppressed=${suppressed.length} rejected=${final.rejectedCount}${trimmed.length ? ` trimmed=${trimmed.length}` : ''}` +
    (final.delta ? ` | since last review: fixed=${final.delta.fixed.length} new=${final.delta.new.length} open=${final.delta.stillOpen.length}` : '') +
    (expired.length ? ` (warning: ${expired.length} expired suppression(s) in rules/suppressions.yml)` : ''),
);

/** The engine's own error message, when its CLI envelope reports a failure. */
function engineError(raw) {
  try {
    const env = JSON.parse(raw);
    if (env?.type === 'result' && env.is_error) return `Engine error: ${String(env.result ?? env.subtype).slice(0, 600)}`;
  } catch { /* not an envelope */ }
  return undefined;
}

function failClosed(errs, rawExcerpt) {
  const file = args.out.replace(/\.json$/, '') + '.error.json';
  writeFileSync(file, JSON.stringify({ error: 'invalid_review_output', errors: errs.slice(0, 50), rawExcerpt: rawExcerpt.slice(0, 20000) }, null, 2));
  console.error(`[sfn-review] review output invalid (${errs.length} error(s)); details in ${file}`);
  errs.slice(0, 10).forEach((e) => console.error(`  - ${e}`));
  process.exit(3);
}
