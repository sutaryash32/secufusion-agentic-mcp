#!/usr/bin/env node
// Team metrics dashboard from many review results.
//
//   node metrics.mjs --in <dir-or-file>... [--out metrics.html] [--json metrics.json]
//   node metrics.mjs --ado-definition <pipelineId> --repo <sfn repo path> [--days 90] [--out ...]
//
// Local: point --in at <repo>/.sfn-review/history (every run is archived there) or several repos'.
// CI: --ado-definition downloads the `sfn-review` artifact of each build of that pipeline
// (auth: AZURE_DEVOPS_PAT, `az login`, or SYSTEM_ACCESSTOKEN).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { authHeaders, createAdo, parseRemote } from './lib/ado-api.mjs';
import { aggregate, renderDashboard } from './lib/metrics.mjs';

const { values: args } = parseArgs({
  options: {
    in: { type: 'string', multiple: true, default: [] },
    out: { type: 'string', default: 'sfn-metrics.html' },
    json: { type: 'string' },
    'ado-definition': { type: 'string' },
    repo: { type: 'string', default: '.' },
    days: { type: 'string', default: '90' },
    feedback: { type: 'string' },
  },
});
const log = (m) => console.error(`[sfn-metrics] ${m}`);

const runs = [];
const addResult = (result, at) => {
  if (result?.findings && result.verdict) runs.push({ at: at ?? result.scope?.generatedAt ?? new Date().toISOString(), result });
};

for (const p of args.in) {
  if (!existsSync(p)) { log(`not found: ${p}`); continue; }
  const files = statSync(p).isDirectory()
    ? readdirSync(p).filter((f) => f.endsWith('.json')).map((f) => join(p, f))
    : [p];
  for (const f of files) {
    try { addResult(JSON.parse(readFileSync(f, 'utf8')), statSync(f).mtime.toISOString()); } catch { /* not a result */ }
  }
}

let source = args.in.length ? `${args.in.length} local path(s)` : '';
if (args['ado-definition']) {
  const remote = parseRemote(execFileSync('git', ['-C', args.repo, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim());
  if (!remote) { log('origin is not an Azure Repos URL'); process.exit(2); }
  const headers = authHeaders();
  const ado = createAdo({ ...remote, headers });
  const since = new Date(Date.now() - Number(args.days) * 86400000).toISOString();
  const builds = (await ado.call('GET', `build/builds?definitions=${encodeURIComponent(args['ado-definition'])}&minTime=${since}&$top=500&statusFilter=completed`)).value ?? [];
  const tmp = mkdtempSync(join(tmpdir(), 'sfn-metrics-'));
  let got = 0;
  for (const b of builds) {
    try {
      const art = await ado.call('GET', `build/builds/${b.id}/artifacts?artifactName=sfn-review`);
      const url = art.resource?.downloadUrl;
      if (!url) continue;
      const res = await fetch(url, { headers });
      if (!res.ok) continue;
      const zip = join(tmp, `${b.id}.zip`);
      writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
      const json = execFileSync('unzip', ['-p', zip, 'sfn-review/review-result.json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      addResult(JSON.parse(json), b.finishTime ?? b.queueTime);
      got++;
    } catch { /* build without a usable artifact */ }
  }
  log(`${builds.length} builds in ${args.days} days, ${got} with a review result`);
  source = `${source ? `${source} + ` : ''}pipeline ${args['ado-definition']} (${args.days} days)`;
}

const m = aggregate(runs);
const feedback = args.feedback && existsSync(args.feedback) ? JSON.parse(readFileSync(args.feedback, 'utf8')) : undefined;
writeFileSync(args.out, renderDashboard(m, { source, feedback }));
if (args.json) writeFileSync(args.json, JSON.stringify(m, null, 2));
log(`${m.reviews} reviews → ${args.out}`);
