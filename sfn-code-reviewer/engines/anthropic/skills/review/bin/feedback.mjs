#!/usr/bin/env node
// Precision from real PR outcomes: reads the reviewer's own threads on recent PRs and how each ended
// (fixed by a later push, resolved, won't fix / by design, closed, ignored). Read-only.
//
//   node feedback.mjs --repo ../sfn-tenants-api [--repo ../sfn-iam-api ...] [--days 30] [--out feedback.json]
//
// Then: node metrics.mjs --in … --feedback feedback.json   (adds a precision section to the dashboard)
// Auth: AZURE_DEVOPS_PAT, `az login`, or SYSTEM_ACCESSTOKEN.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { authHeaders, createAdo, parseRemote } from './lib/ado-api.mjs';
import { aggregateFeedback, classifyThread } from './lib/feedback.mjs';

const { values: args } = parseArgs({
  options: {
    repo: { type: 'string', multiple: true, default: [] },
    days: { type: 'string', default: '30' },
    out: { type: 'string', default: 'sfn-feedback.json' },
  },
});
const log = (m) => console.error(`[sfn-feedback] ${m}`);
if (!args.repo.length) { log('usage: feedback.mjs --repo <path> [--repo …] [--days 30] [--out file]'); process.exit(64); }

const since = new Date(Date.now() - Number(args.days) * 86400000).toISOString();
const headers = authHeaders();
const items = [];
for (const r of args.repo) {
  const remote = parseRemote(execFileSync('git', ['-C', resolve(r), 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim());
  if (!remote) { log(`${r}: origin is not an Azure Repos URL, skipped`); continue; }
  const ado = createAdo({ ...remote, headers });
  const prs = (await ado.call('GET', `git/repositories/${encodeURIComponent(remote.repo)}/pullrequests?searchCriteria.status=all&$top=300`)).value ?? [];
  const recent = prs.filter((p) => (p.closedDate ?? p.creationDate) >= since);
  let seen = 0;
  for (const p of recent) {
    const threads = (await ado.call('GET', `git/repositories/${encodeURIComponent(remote.repo)}/pullRequests/${p.pullRequestId}/threads`)).value ?? [];
    for (const t of threads) {
      const outcome = classifyThread(t, p.status);
      if (!outcome) continue;
      seen++;
      items.push({ repo: remote.repo, pr: p.pullRequestId, url: `${remote.collectionUri}${encodeURIComponent(remote.project)}/_git/${encodeURIComponent(remote.repo)}/pullrequest/${p.pullRequestId}`, outcome });
    }
  }
  log(`${remote.repo}: ${recent.length} PRs in ${args.days} days, ${seen} reviewer threads`);
}

const fb = { generatedAt: new Date().toISOString(), days: Number(args.days), ...aggregateFeedback(items) };
writeFileSync(args.out, JSON.stringify(fb, null, 2));
const t = fb.totals;
log(`${t.posted} findings posted · fixed by code ${t.fixed_by_code} · resolved ${t.resolved} · dismissed ${t.dismissed} · ignored ${t.ignored} · open ${t.open} · precision ${t.precision ?? 'n/a'}`);
for (const s of fb.suggestions) log(`suggestion: ${s.ruleId} — ${s.why}`);
log(`→ ${args.out}`);
