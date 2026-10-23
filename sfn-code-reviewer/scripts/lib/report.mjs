// review-result -> self-contained HTML report (no external assets; works as a CI artifact). Pure.
import { BLASTMAP_CSS, renderBlastSvg } from './blastmap.mjs';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const VERDICT = {
  ready: { label: 'Ready', cls: 'ok' },
  fix_first: { label: 'Fix first', cls: 'bad' },
  needs_discussion: { label: 'Needs discussion', cls: 'warn' },
};
const SEVERITIES = ['blocker', 'major', 'minor', 'nit'];

function findingCard(f, repoKey) {
  const where = `${f.repo && f.repo !== repoKey ? `${f.repo}/` : ''}${f.file}:${f.line}`;
  const evidence = (f.evidence ?? [])
    .map((e) => `<li><code>${esc(e.repo ? `${e.repo}/` : '')}${esc(e.file)}${e.line ? `:${e.line}` : ''}</code> — ${esc(e.note)}</li>`)
    .join('');
  return `
  <details class="finding sev-${f.severity}" ${f.severity === 'blocker' || f.severity === 'major' ? 'open' : ''}>
    <summary>
      <span class="pill sev-${f.severity}">${esc(f.severity)}</span>
      <span class="pill ${f.confidence === 'confirmed' ? 'conf' : 'poss'}">${esc(f.confidence)}</span>
      <span class="title">${esc(f.title)}</span>
      <code class="where">${esc(where)}</code>
    </summary>
    <dl>
      ${f.ratedSeverity ? `<dt>Severity</dt><dd>raised from ${esc(f.ratedSeverity)} by the ${esc(f.ruleId)} floor</dd>` : ''}
      ${f.consensus ? `<dt>Consensus</dt><dd>reported in ${esc(f.consensus)} runs</dd>` : ''}
      <dt>Rule</dt><dd><code>${esc(f.ruleId)}</code> · ${esc(f.category)}${f.specialist ? ` · ${esc(f.specialist)}` : ''} · <code>${esc(f.anchor)}</code></dd>
      <dt>Problem</dt><dd>${esc(f.problem)}</dd>
      <dt>Fails when</dt><dd>${esc(f.failureScenario)}</dd>
      <dt>Fix</dt><dd>${esc(f.suggestion)}</dd>
      ${evidence ? `<dt>Evidence</dt><dd><ul>${evidence}</ul></dd>` : ''}
      ${f.verification ? `<dt>Verified</dt><dd>${esc(f.verification)}</dd>` : ''}
      ${f.crossVerification ? `<dt>Cross-check</dt><dd>${esc(f.crossVerification)}</dd>` : ''}
      <dt>ID</dt><dd><code>${esc(f.id)}</code></dd>
    </dl>
  </details>`;
}

export function renderReport(r) {
  const v = VERDICT[r.verdict] ?? { label: r.verdict, cls: 'warn' };
  const s = r.scope ?? {};
  const counts = SEVERITIES.map((sev) => [sev, r.findings.filter((f) => f.severity === sev).length]);
  const blast = Object.entries(r.blastRadius ?? {}).filter(([, list]) => list?.length);
  const blastLabels = { endpoints: 'Endpoints', kafkaTopics: 'Kafka topics', tables: 'Tables', scheduledJobs: 'Scheduled jobs', uiRoutes: 'UI routes', otherRepos: 'Other repos' };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>sfn review — ${esc(s.repoKey)}</title>
<style>
:root{--accent:#2a78d6;--on-accent:#fff;--bg:#fbfbfa;--panel:#fff;--text:#1d1d1f;--muted:#6b6b70;--line:#e4e4e7;--ok:#1a7f4b;--warn:#a15c00;--bad:#b42318;--blocker:#b42318;--major:#c2410c;--minor:#a16207;--nit:#52525b;--code:#f4f4f5}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--accent:#3987e5;--on-accent:#fff;--bg:#111113;--panel:#1a1a1d;--text:#ececef;--muted:#9d9da3;--line:#2c2c31;--ok:#4ade80;--warn:#fbbf24;--bad:#f87171;--blocker:#f87171;--major:#fb923c;--minor:#facc15;--nit:#a1a1aa;--code:#232327}}
:root[data-theme="dark"]{--accent:#3987e5;--on-accent:#fff;--bg:#111113;--panel:#1a1a1d;--text:#ececef;--muted:#9d9da3;--line:#2c2c31;--ok:#4ade80;--warn:#fbbf24;--bad:#f87171;--blocker:#f87171;--major:#fb923c;--minor:#facc15;--nit:#a1a1aa;--code:#232327}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:980px;margin:0 auto;padding:28px 16px 64px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:32px 0 10px}
.muted{color:var(--muted)}code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--code);padding:1px 5px;border-radius:4px;word-break:break-all}
.head{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between}
.verdict{font-weight:600;padding:6px 14px;border-radius:999px;border:1.5px solid currentColor}
.verdict.ok{color:var(--ok)}.verdict.warn{color:var(--warn)}.verdict.bad{color:var(--bad)}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-top:16px}
.stat b{display:block;font-size:22px}.stat span{color:var(--muted);font-size:13px}
.pill{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.03em;padding:1px 8px;border-radius:999px;border:1px solid currentColor;white-space:nowrap}
.sev-blocker{color:var(--blocker)}.sev-major{color:var(--major)}.sev-minor{color:var(--minor)}.sev-nit{color:var(--nit)}
.conf{color:var(--ok)}.poss{color:var(--muted)}
details.finding{background:var(--panel);border:1px solid var(--line);border-left:4px solid currentColor;border-radius:8px;margin:10px 0;padding:10px 14px;color:var(--text)}
details.finding.sev-blocker{border-left-color:var(--blocker)}details.finding.sev-major{border-left-color:var(--major)}details.finding.sev-minor{border-left-color:var(--minor)}details.finding.sev-nit{border-left-color:var(--nit)}
summary{cursor:pointer;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
summary .title{font-weight:600;flex:1 1 280px}summary .where{font-size:12px}
dl{display:grid;grid-template-columns:110px 1fr;gap:6px 12px;margin:12px 0 2px}dt{color:var(--muted);font-size:13px}dd{margin:0}
dd ul{margin:0;padding-left:18px}
@media (max-width:600px){dl{grid-template-columns:1fr}dt{margin-top:6px}}
table{width:100%;border-collapse:collapse}${BLASTMAP_CSS}td{padding:6px 0;border-top:1px solid var(--line);vertical-align:top}td:first-child{color:var(--muted);width:140px}
</style>
</head>
<body><main>
<div class="head">
  <div>
    <h1>${esc(s.repoKey)} review</h1>
    <div class="muted"><code>${esc(s.base)}</code> → <code>${esc(s.workingTree ? 'working tree' : s.head)}</code>${s.headSha ? ` · ${esc(s.headSha.slice(0, 10))}` : ''} · ${esc(s.filesChanged)} files · ${esc(s.linesChanged)} lines</div>
  </div>
  <div class="verdict ${v.cls}">${esc(v.label)}</div>
</div>

<div class="panel" style="margin-top:16px">
  <p style="margin:0 0 8px">${esc(r.summary)}</p>
  <p class="muted" style="margin:0"><b>Why this verdict:</b> ${esc(r.verdictReason)}</p>
</div>

<div class="stats">
  ${counts.map(([sev, n]) => `<div class="panel stat"><b class="sev-${sev}">${n}</b><span>${sev}</span></div>`).join('')}
  <div class="panel stat"><b>${esc(s.risk?.score ?? '–')}/10</b><span>risk · ${esc(s.level ?? '')}</span></div>
  <div class="panel stat"><b>${esc(r.rejectedCount)}</b><span>rejected by verify</span></div>
</div>

${r.walkthrough?.length ? `<h2>Walkthrough</h2><div class="panel"><table>${r.walkthrough.map((w) => `<tr><td>${esc(w.area)}</td><td>${esc(w.change)}${w.files?.length ? `<div class="muted" style="margin-top:4px">${w.files.map((f) => `<code>${esc(f)}</code>`).join(' ')}</div>` : ''}</td></tr>`).join('')}</table></div>` : ''}
${r.testPlan?.length ? `<h2>Suggested test plan</h2><div class="panel">${r.testPlan.map((t) => `<label style="display:block;margin:4px 0"><input type="checkbox"> ${esc(t)}</label>`).join('')}</div>` : ''}

<h2>Findings</h2>
${r.findings.length ? r.findings.map((f) => findingCard(f, s.repoKey)).join('') : '<p class="muted">No findings.</p>'}

${r.delta ? `<h2>Since the last review</h2><div class="panel"><table>
  <tr><td>Fixed</td><td>${r.delta.fixed.length ? r.delta.fixed.map((f) => `<div><span class="pill conf">fixed</span> <code>${esc(f.ruleId)}</code> ${esc(f.title)}</div>`).join('') : '–'}</td></tr>
  <tr><td>New</td><td>${r.delta.new.length ? r.delta.new.map((f) => `<div><span class="pill sev-${esc(f.severity)}">${esc(f.severity)}</span> <code>${esc(f.ruleId)}</code> ${esc(f.title)}</div>`).join('') : '–'}</td></tr>
  <tr><td>Still open</td><td>${r.delta.stillOpen.length}</td></tr>
  <tr><td>Previous</td><td><code>${esc((r.delta.previousHeadSha ?? '').slice(0, 10))}</code> · ${esc(r.delta.previousVerdict ?? '')}</td></tr>
</table></div>` : ''}

${r.crossVerify ? `<h2>Cross-model check</h2><div class="panel"><p style="margin:0 0 6px">Re-checked by <b>${esc(r.crossVerify.verifier)}</b>${r.crossVerify.model ? ` (${esc(r.crossVerify.model)})` : ''}: ${esc(r.crossVerify.confirmed)} confirmed · ${esc(r.crossVerify.downgraded)} downgraded · ${esc(r.crossVerify.rejected)} rejected · ${esc(r.crossVerify.unverified)} unverified</p>${(r.crossVerify.rejectedFindings ?? []).map((f) => `<div class="muted"><code>${esc(f.ruleId)}</code> ${esc(f.title)} — ${esc(f.reason)}</div>`).join('')}</div>` : ''}

${r.consensus?.seenOnce?.length ? `<details style="margin-top:8px"><summary class="muted">${r.consensus.seenOnce.length} finding(s) seen in only 1 of ${r.consensus.runs} runs (hidden by consensus)</summary>${r.consensus.seenOnce.map((f) => findingCard({ ...f, id: f.id ?? '—' }, s.repoKey)).join('')}</details>` : ''}
${r.trimmed?.length ? `<details style="margin-top:8px"><summary class="muted">${r.trimmed.length} lower-priority finding(s) hidden by the noise cap</summary>${r.trimmed.map((f) => findingCard(f, s.repoKey)).join('')}</details>` : ''}

${blast.length ? `<h2>Blast radius</h2>${(() => { const svg = renderBlastSvg(r.blastRadius, r.blastLinks ?? [], s.repoKey, r.blastRadius?.otherRepos ?? []); return svg ? `<div class="panel" style="margin-bottom:10px">${svg}</div>` : ''; })()}<div class="panel"><table>${blast.map(([k, list]) => `<tr><td>${esc(blastLabels[k] ?? k)}</td><td>${list.map((x) => `<code>${esc(x)}</code>`).join(' ')}</td></tr>`).join('')}</table></div>` : ''}

${r.suppressed?.length ? `<h2>Suppressed (${r.suppressed.length})</h2>${r.suppressed.map((f) => `<div class="panel" style="margin:8px 0"><code>${esc(f.ruleId)}</code> ${esc(f.title)} — <code>${esc(f.file)}:${esc(f.line)}</code><div class="muted">${esc(f.suppressedBy?.reason)} (until ${esc(f.suppressedBy?.expires)})</div></div>`).join('')}` : ''}

<h2>Run</h2>
<div class="panel"><table>
  <tr><td>Engine</td><td>${esc(r.engine?.provider)} ${r.engine?.models ? `· ${esc(Object.entries(r.engine.models).map(([k, m]) => `${k}: ${m}`).join(', '))}` : ''}</td></tr>
  <tr><td>Specialists</td><td>${esc((r.specialistsRun ?? []).join(', ') || 'none')}${s.notYetAvailable?.length ? ` <span class="muted">(not yet available: ${esc(s.notYetAvailable.join(', '))})</span>` : ''}</td></tr>
  ${s.pr ? `<tr><td>Pull request</td><td><a href="${esc(s.pr.url)}">PR ${esc(s.pr.id)}</a> — ${esc(s.pr.title)} (${esc(s.pr.status)})</td></tr>` : ''}
  ${s.suggestedReviewers?.length ? `<tr><td>Suggested reviewers</td><td>${s.suggestedReviewers.map((x) => `<div><b>${esc(x.name)}</b> <span class="muted">— ${esc(x.why)}</span></div>`).join('')}</td></tr>` : ''}
  <tr><td>Integrations</td><td>fix-history hints: ${esc(s.historyHints ?? 0)} · live DB schema: ${s.liveDb ? 'yes' : 'no'} · OSV audit: ${s.depAudit ? 'yes' : 'no'}</td></tr>
  <tr><td>Risk factors</td><td>${(s.risk?.factors ?? []).map((f) => `<code>${esc(f.id)} +${esc(f.weight)}</code>`).join(' ') || '–'}</td></tr>
  ${s.missingRepos?.length ? `<tr><td>Missing repos</td><td>${esc(s.missingRepos.join(', '))} — cross-repo checks for these were not possible</td></tr>` : ''}
</table></div>
</main></body></html>
`;
}
