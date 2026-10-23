#!/usr/bin/env node
// Writes the PR description from a review result: summary, changes, impact, test plan.
// Preview by default; --confirm writes. Default mode only fills an EMPTY description; re-runs update the
// reviewer's own marked section; text the author wrote is never changed.
//
//   node pr-description.mjs --in review-result.json [--mode empty-only|append] [--confirm]
//
// PR location: the pipeline's PR variables, or result.scope.pr (from run-review.sh --pr <id>).
// Auth: SYSTEM_ACCESSTOKEN, AZURE_DEVOPS_PAT, or `az login`.
import { parseArgs } from 'node:util';
import { authHeaders } from './lib/ado-api.mjs';
import { readJson } from './lib/paths.mjs';
import { buildSection, planDescription } from './lib/prdescription.mjs';

const { values: args } = parseArgs({
  options: { in: { type: 'string' }, mode: { type: 'string', default: 'empty-only' }, confirm: { type: 'boolean', default: false } },
});
const log = (m) => console.error(`[sfn-review:description] ${m}`);
if (!args.in || !['empty-only', 'append'].includes(args.mode)) { log('usage: pr-description.mjs --in <review-result.json> [--mode empty-only|append] [--confirm]'); process.exit(64); }

const env = process.env;
const r = readJson(args.in);
const inPipeline = Boolean(env.SYSTEM_PULLREQUEST_PULLREQUESTID);
const prId = env.SYSTEM_PULLREQUEST_PULLREQUESTID || r.scope?.pr?.id;
if (!prId) { log('not a PR review — nothing to do'); process.exit(0); }
const collectionUri = (inPipeline ? env.SYSTEM_COLLECTIONURI : r.scope?.pr?.collectionUri) ?? env.SYSTEM_COLLECTIONURI;
const project = (inPipeline ? env.SYSTEM_TEAMPROJECT : r.scope?.pr?.project) ?? env.SYSTEM_TEAMPROJECT;
const repositoryId = (inPipeline ? env.BUILD_REPOSITORY_ID : r.scope?.pr?.repositoryId) ?? env.BUILD_REPOSITORY_ID;
if (!collectionUri || !project || !repositoryId) { log('cannot determine the PR location'); process.exit(2); }

const headers = { ...authHeaders(), 'Content-Type': 'application/json' };
const url = `${(env.SFN_ADO_BASE_URL || collectionUri).replace(/\/?$/, '/')}${encodeURIComponent(project)}/_apis/git/repositories/${repositoryId}/pullrequests/${prId}?api-version=7.1`;
const res = await fetch(url, { headers });
if (!res.ok) { log(`GET PR ${prId} -> ${res.status}`); process.exit(1); }
const pr = await res.json();

const plan = planDescription(pr.description ?? '', buildSection(r), args.mode);
if (plan.action === 'skip') { log(`PR ${prId}: skipped — ${plan.reason}`); process.exit(0); }
if (!args.confirm) {
  console.log(`PREVIEW — PR ${prId} description would be written (${plan.reason}):\n\n${plan.description}\n\nRe-run with --confirm to write it.`);
  process.exit(0);
}
const upd = await fetch(url, { method: 'PATCH', headers, body: JSON.stringify({ description: plan.description }) });
if (!upd.ok) { log(`PATCH PR ${prId} -> ${upd.status}: ${(await upd.text()).slice(0, 300)}`); process.exit(1); }
log(`PR ${prId}: description written (${plan.reason})`);
