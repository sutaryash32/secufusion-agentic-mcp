#!/usr/bin/env node
// Posts the review to the Azure DevOps PR: one inline thread per new finding, one summary thread
// (updated in place on re-runs), and resolves our threads whose finding is gone.
// The model never sees the token — this plain script does all the posting.
//
//   node post-ado-pr.mjs --in review-result.json [--max-inline 25] [--min-inline-severity minor] [--dry-run]
//
// In Azure Pipelines (map SYSTEM_ACCESSTOKEN explicitly): SYSTEM_COLLECTIONURI, SYSTEM_TEAMPROJECT,
//   BUILD_REPOSITORY_ID, SYSTEM_PULLREQUEST_PULLREQUESTID, BUILD_BUILDID (report link).
// Locally: after `run-review.sh --pr <id>` the PR is in the result; auth via AZURE_DEVOPS_PAT or `az login`.
import { parseArgs } from 'node:util';
import { formatFindingComment, formatSummary, planThreads } from './lib/ado.mjs';
import { authHeaders } from './lib/ado-api.mjs';
import { loadConfig, readJson } from './lib/paths.mjs';

const { values: args } = parseArgs({
  options: {
    in: { type: 'string' },
    'max-inline': { type: 'string' },
    'min-inline-severity': { type: 'string', default: 'minor' },
    'dry-run': { type: 'boolean', default: false },
  },
});
if (!args.in) {
  console.error('usage: post-ado-pr.mjs --in <review-result.json> [--dry-run]');
  process.exit(64);
}

const env = process.env;
const result = readJson(args.in);
const maxInline = Number(args['max-inline'] ?? loadConfig().review.limits.maxCommentsPosted);

// In a pipeline the PR comes from the build; locally from a review run with --pr <id>.
const local = result.scope?.pr;
const prId = env.SYSTEM_PULLREQUEST_PULLREQUESTID || local?.id;
if (!prId) {
  console.log('[sfn-review] not a PR review — nothing to post.');
  process.exit(0);
}
const collectionUri = (env.SYSTEM_PULLREQUEST_PULLREQUESTID ? env.SYSTEM_COLLECTIONURI : local?.collectionUri) ?? env.SYSTEM_COLLECTIONURI;
const project = (env.SYSTEM_PULLREQUEST_PULLREQUESTID ? env.SYSTEM_TEAMPROJECT : local?.project) ?? env.SYSTEM_TEAMPROJECT;
const repositoryId = (env.SYSTEM_PULLREQUEST_PULLREQUESTID ? env.BUILD_REPOSITORY_ID : local?.repositoryId) ?? env.BUILD_REPOSITORY_ID;
if (!collectionUri || !project || !repositoryId) fail('cannot determine the PR location (collection, project, repository).');

let headers = {};
if (!args['dry-run']) {
  try { headers = authHeaders(); } catch (e) { fail(e.message); }
}
const base = `${(env.SFN_ADO_BASE_URL || collectionUri).replace(/\/?$/, '/')}${encodeURIComponent(project)}/_apis/git/repositories/${repositoryId}/pullRequests/${prId}/threads`;
const api = '?api-version=7.1';
const reportUrl = env.BUILD_BUILDID
  ? `${collectionUri.replace(/\/?$/, '/')}${encodeURIComponent(project)}/_build/results?buildId=${env.BUILD_BUILDID}&view=artifacts`
  : undefined;

const threads = args['dry-run'] ? [] : (await call('GET', `${base}${api}`)).value ?? [];
const plan = planThreads(result, threads, { maxInline, minInlineSeverity: args['min-inline-severity'] });

for (const f of plan.toCreate) {
  await call('POST', `${base}${api}`, {
    comments: [{ parentCommentId: 0, content: formatFindingComment(f), commentType: 1 }],
    status: 'active',
    threadContext: {
      filePath: `/${f.file}`,
      rightFileStart: { line: f.line, offset: 1 },
      rightFileEnd: { line: f.endLine ?? f.line, offset: 1 },
    },
  });
}

for (const { threadId } of plan.toResolve) {
  await call('POST', `${base}/${threadId}/comments${api}`, {
    parentCommentId: 1,
    content: `No longer detected by sfn-code-reviewer at ${result.scope?.headSha?.slice(0, 10) ?? 'the latest commit'}.`,
    commentType: 1,
  });
  await call('PATCH', `${base}/${threadId}${api}`, { status: 'fixed' });
}

const summary = formatSummary(result, { notInline: plan.notInline, reportUrl });
if (plan.summaryThread) {
  const c = plan.summaryThread.comments[0];
  await call('PATCH', `${base}/${plan.summaryThread.id}/comments/${c.id}${api}`, { content: summary });
  // Re-open the summary if the verdict now needs attention.
  if (result.verdict !== 'ready' && plan.summaryThread.status !== 'active') {
    await call('PATCH', `${base}/${plan.summaryThread.id}${api}`, { status: 'active' });
  }
} else {
  await call('POST', `${base}${api}`, {
    comments: [{ parentCommentId: 0, content: summary, commentType: 1 }],
    status: result.verdict === 'ready' ? 'closed' : 'active',
  });
}

console.log(
  `[sfn-review] PR ${prId}: ${plan.toCreate.length} new inline, ${plan.toResolve.length} resolved, ` +
    `${plan.notInline.length} summary-only, summary ${plan.summaryThread ? 'updated' : 'created'}${args['dry-run'] ? ' (dry run)' : ''}.`,
);

async function call(method, url, body) {
  if (args['dry-run']) {
    console.log(`[dry-run] ${method} ${url}${body ? `\n${JSON.stringify(body, null, 2).slice(0, 1500)}` : ''}`);
    return { value: [] };
  }
  const res = await fetch(url, {
    method,
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    // 401/403 almost always = the build service lacks "Contribute to pull requests" on the repo.
    fail(`${method} ${url.split('?')[0]} -> ${res.status}: ${text.slice(0, 500)}`);
  }
  return res.status === 204 ? {} : res.json();
}

function fail(msg) {
  console.error(`[sfn-review] ${msg}`);
  process.exit(1);
}
