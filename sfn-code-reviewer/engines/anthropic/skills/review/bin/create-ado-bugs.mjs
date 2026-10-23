#!/usr/bin/env node
// Azure Boards Bugs from review findings — preview by default, create only with --confirm.
// Idempotent: a finding that already has an sfn-review bug is skipped.
//
//   node create-ado-bugs.mjs --in review-result.json [--repo <path>] [--confirm]
//        [--min-severity blocker|major|minor] [--all-confidence] [--iteration backlog|current|<path>]
//        [--area <path>] [--max <n>] [--json]
//
// Auth: AZURE_DEVOPS_PAT, `az login`, or SYSTEM_ACCESSTOKEN in a pipeline (the build service then
// needs "Create work items" on the area). Org/project come from the repo's origin remote.
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { authHeaders, createAdo, parseRemote } from './lib/ado-api.mjs';
import { bugFields, existingBugsQuery, selectFindings, toPatch } from './lib/boards.mjs';
import { loadConfig, readJson } from './lib/paths.mjs';

const { values: args } = parseArgs({
  options: {
    in: { type: 'string' },
    repo: { type: 'string', default: '.' },
    confirm: { type: 'boolean', default: false },
    'min-severity': { type: 'string' },
    'all-confidence': { type: 'boolean', default: false },
    iteration: { type: 'string' },
    area: { type: 'string' },
    max: { type: 'string' },
    json: { type: 'boolean', default: false },
  },
});
const log = (m) => console.error(`[sfn-review:boards] ${m}`);
if (!args.in) { log('usage: create-ado-bugs.mjs --in <review-result.json> [--confirm]'); process.exit(64); }

const bc = loadConfig().review.integrations?.boards ?? {};
const result = readJson(args.in);
const remote = parseRemote(execFileSync('git', ['-C', args.repo, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim());
if (!remote) { log('origin is not an Azure Repos URL'); process.exit(2); }

const selected = selectFindings(result, {
  minSeverity: args['min-severity'] ?? bc.minSeverity ?? 'blocker',
  confirmedOnly: args['all-confidence'] ? false : bc.confirmedOnly ?? true,
  max: Number(args.max ?? bc.maxPerRun ?? 10),
});
if (!selected.length) { log('no findings meet the threshold — nothing to file'); process.exit(0); }

const ado = createAdo({ ...remote, headers: authHeaders() });

// Skip findings that already have a bug.
const existing = new Map();
const wiql = await ado.wiql(existingBugsQuery(remote.project, selected.map((f) => f.id)));
const ids = (wiql.workItems ?? []).map((w) => w.id);
if (ids.length) {
  const items = await ado.call('GET', `wit/workitems?ids=${ids.slice(0, 200).join(',')}&fields=System.Id,System.Tags`);
  for (const wi of items.value ?? []) {
    const tags = String(wi.fields['System.Tags'] ?? '').split(';').map((t) => t.trim().toLowerCase());
    for (const f of selected) if (tags.includes(`sfn-finding-${f.id}`)) existing.set(f.id, wi.id);
  }
}

// Iteration: backlog (area's default) | current sprint | explicit path.
const iterationChoice = args.iteration ?? bc.iteration ?? 'backlog';
let iterationPath;
if (iterationChoice === 'current') {
  const cur = await ado.currentIteration(bc.team ?? `${remote.project} Team`);
  iterationPath = cur.value?.[0]?.path;
  if (!iterationPath) { log('no current iteration for the team — use --iteration backlog or a path'); process.exit(2); }
} else if (iterationChoice !== 'backlog') {
  iterationPath = iterationChoice;
}
const areaPath = args.area ?? bc.areaPath;
const reportUrl = process.env.BUILD_BUILDID && process.env.SYSTEM_COLLECTIONURI
  ? `${process.env.SYSTEM_COLLECTIONURI}${encodeURIComponent(process.env.SYSTEM_TEAMPROJECT ?? remote.project)}/_build/results?buildId=${process.env.BUILD_BUILDID}&view=artifacts`
  : undefined;

const plan = selected.map((f) => ({
  finding: f,
  existing: existing.get(f.id),
  fields: bugFields(f, { repoKey: result.scope?.repoKey, headSha: result.scope?.headSha, reportUrl }),
}));

const toCreate = plan.filter((p) => !p.existing);
const summary = {
  project: remote.project,
  workItemType: bc.workItemType ?? 'Bug',
  areaPath: areaPath ?? '(project default)',
  iteration: iterationPath ?? '(backlog — area default iteration)',
  create: toCreate.map((p) => ({ findingId: p.finding.id, title: p.fields.title, priority: p.fields.priority, severity: p.fields.severity, tags: p.fields.tags })),
  alreadyFiled: plan.filter((p) => p.existing).map((p) => ({ findingId: p.finding.id, workItem: p.existing })),
};

if (!args.confirm) {
  if (args.json) console.log(JSON.stringify({ preview: true, ...summary }, null, 2));
  else {
    console.log(`PREVIEW — nothing created. ${summary.create.length} ${summary.workItemType}(s) in ${summary.project}`);
    console.log(`  area: ${summary.areaPath} · iteration: ${summary.iteration}`);
    for (const c of summary.create) console.log(`  + P${c.priority} ${c.title}  [${c.tags.join(', ')}]`);
    for (const a of summary.alreadyFiled) console.log(`  = finding ${a.findingId} already filed as #${a.workItem}`);
    console.log('Re-run with --confirm to create them.');
  }
  process.exit(0);
}

const created = [];
for (const p of toCreate) {
  const wi = await ado.createWorkItem(summary.workItemType, toPatch(p.fields, { areaPath, iterationPath }));
  const url = wi._links?.html?.href ?? `${ado.projectUrl}/_workitems/edit/${wi.id}`;
  created.push({ findingId: p.finding.id, id: wi.id, url });
  log(`created #${wi.id} ${p.fields.title} — ${url}`);
}
if (args.json) console.log(JSON.stringify({ created, alreadyFiled: summary.alreadyFiled }, null, 2));
else console.log(`Created ${created.length} work item(s); ${summary.alreadyFiled.length} already filed.`);
