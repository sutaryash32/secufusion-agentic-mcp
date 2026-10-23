// Team metrics across many review results. Pure: aggregate + render. Never keyed to a person —
// results carry repos, rules and verdicts, not authors.
const SEV = ['blocker', 'major', 'minor', 'nit'];

export function isoWeek(dateStr) {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return 'unknown';
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${String(Math.ceil(((t - y0) / 86400000 + 1) / 7)).padStart(2, '0')}`;
}

/** @param {Array<{at:string, result:object}>} runs */
export function aggregate(runs) {
  const weeks = new Map();
  const rules = new Map();
  const repos = new Map();
  const categories = new Map();
  const verdicts = { ready: 0, fix_first: 0, needs_discussion: 0 };
  let findings = 0;
  let rejected = 0;
  let candidates = 0;
  let suppressed = 0;
  let fixed = 0;
  let skipped = 0;
  for (const { at, result: r } of runs) {
    if (r.engine?.provider === 'none') { skipped++; continue; }
    const wk = isoWeek(at);
    const w = weeks.get(wk) ?? { week: wk, reviews: 0, blocker: 0, major: 0, minor: 0, nit: 0 };
    w.reviews++;
    for (const f of r.findings ?? []) {
      w[f.severity] = (w[f.severity] ?? 0) + 1;
      const k = f.ruleId;
      const rule = rules.get(k) ?? { ruleId: k, count: 0, blocker: 0, repos: new Set() };
      rule.count++;
      if (f.severity === 'blocker') rule.blocker++;
      rule.repos.add(f.repo ?? r.scope?.repoKey);
      rules.set(k, rule);
      categories.set(f.category, (categories.get(f.category) ?? 0) + 1);
    }
    weeks.set(wk, w);
    const repo = r.scope?.repoKey ?? 'unknown';
    const rp = repos.get(repo) ?? { repo, reviews: 0, findings: 0, fixFirst: 0 };
    rp.reviews++;
    rp.findings += r.findings?.length ?? 0;
    if (r.verdict === 'fix_first') rp.fixFirst++;
    repos.set(repo, rp);
    if (r.verdict in verdicts) verdicts[r.verdict]++;
    findings += r.findings?.length ?? 0;
    rejected += r.rejectedCount ?? 0;
    candidates += (r.findings?.length ?? 0) + (r.rejectedCount ?? 0);
    suppressed += r.suppressed?.length ?? 0;
    fixed += r.delta?.fixed?.length ?? 0;
  }
  const reviews = runs.length - skipped;
  return {
    generatedAt: new Date().toISOString(),
    reviews,
    skipped,
    findings,
    findingsPerReview: reviews ? +(findings / reviews).toFixed(2) : 0,
    verifyRejectRate: candidates ? +(rejected / candidates).toFixed(3) : 0,
    suppressed,
    fixedOnRereview: fixed,
    verdicts,
    weeks: [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week)),
    topRules: [...rules.values()].sort((a, b) => b.count - a.count || a.ruleId.localeCompare(b.ruleId)).slice(0, 12)
      .map((x) => ({ ...x, repos: [...x.repos].sort() })),
    repos: [...repos.values()].sort((a, b) => b.findings - a.findings),
    categories: Object.fromEntries([...categories.entries()].sort((a, b) => b[1] - a[1])),
  };
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function weeklyStack(weeks) {
  if (!weeks.length) return '<p class="muted">No reviews yet.</p>';
  const W = 860, H = 260, padL = 36, padB = 28, padT = 10;
  const max = Math.max(1, ...weeks.map((w) => SEV.reduce((n, s) => n + (w[s] ?? 0), 0)));
  const step = (W - padL) / weeks.length;
  const bw = Math.min(40, step * 0.6);
  const y = (v) => padT + (H - padT - padB) * (1 - v / max);
  const ticks = [0, Math.round(max / 2), max];
  const parts = ticks.map((t) => `<line x1="${padL}" x2="${W}" y1="${y(t)}" y2="${y(t)}" class="grid"/><text x="${padL - 6}" y="${y(t) + 4}" class="axis" text-anchor="end">${t}</text>`);
  weeks.forEach((w, i) => {
    const x = padL + i * step + (step - bw) / 2;
    let acc = 0;
    // bottom-up: nit, minor, major, blocker (most severe on top, nearest the eye)
    const order = [...SEV].reverse();
    order.forEach((s, j) => {
      const v = w[s] ?? 0;
      if (!v) return;
      const y0 = y(acc);
      const y1 = y(acc + v);
      acc += v;
      const isTop = order.slice(j + 1).every((t) => !(w[t] ?? 0));
      const h = Math.max(0, y0 - y1 - 2); // 2px surface gap between segments
      parts.push(`<rect x="${x}" y="${y1}" width="${bw}" height="${h}" rx="${isTop ? 4 : 0}" class="s-${s}"><title>${esc(w.week)} — ${v} ${s}</title></rect>`);
    });
    if (weeks.length <= 16 || i % Math.ceil(weeks.length / 16) === 0) {
      parts.push(`<text x="${x + bw / 2}" y="${H - 8}" class="axis" text-anchor="middle">${esc(w.week.slice(5))}</text>`);
    }
    parts.push(`<rect x="${padL + i * step}" y="${padT}" width="${step}" height="${H - padT - padB}" class="hit"><title>${esc(w.week)}: ${w.reviews} review(s) · ${SEV.map((s) => `${w[s] ?? 0} ${s}`).join(' · ')}</title></rect>`);
  });
  const legend = SEV.map((s) => `<span class="lg"><i class="s-${s}"></i>${s}</span>`).join('');
  return `<div class="legend">${legend}</div><svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Findings per week by severity">${parts.join('')}</svg>`;
}

function ruleBars(rules) {
  if (!rules.length) return '<p class="muted">No findings yet.</p>';
  const W = 860, rowH = 26, labelW = 120;
  const max = Math.max(...rules.map((r) => r.count));
  const H = rules.length * rowH + 6;
  const parts = rules.map((r, i) => {
    const y = i * rowH + 4;
    const w = Math.max(4, ((W - labelW - 60) * r.count) / max);
    return `<text x="0" y="${y + 15}" class="lbl">${esc(r.ruleId)}</text>`
      + `<rect x="${labelW}" y="${y + 3}" width="${w}" height="16" rx="4" class="s-bar"><title>${esc(r.ruleId)}: ${r.count} finding(s), ${r.blocker} blocker(s) — ${esc(r.repos.join(', '))}</title></rect>`
      + `<text x="${labelW + w + 8}" y="${y + 15}" class="val">${r.count}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Most frequent rules">${parts.join('')}</svg>`;
}

function feedbackSection(fb) {
  if (!fb) return '';
  const t = fb.totals;
  const pct = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);
  return `<h2>Precision from PR outcomes (last ${esc(fb.days)} days)</h2><div class="panel">
<p style="margin:0 0 8px"><b>${pct(t.precision)}</b> of judged findings were acted on — ${t.fixed_by_code} fixed by a later push, ${t.resolved} resolved, ${t.dismissed} dismissed (won't fix / by design); ${t.ignored} left open on merged PRs, ${t.open} still open.</p>
<table><tr><th>Rule</th><th class="n">Posted</th><th class="n">Fixed</th><th class="n">Resolved</th><th class="n">Dismissed</th><th class="n">Ignored</th><th class="n">Precision</th></tr>
${fb.rules.map((r) => `<tr><td>${esc(r.ruleId)}</td><td class="n">${r.posted}</td><td class="n">${r.fixed_by_code}</td><td class="n">${r.resolved}</td><td class="n">${r.dismissed}</td><td class="n">${r.ignored}</td><td class="n">${pct(r.precision)}</td></tr>`).join('')}</table>
${fb.suggestions.length ? `<p style="margin:12px 0 4px"><b>Suggested tuning</b></p>${fb.suggestions.map((s) => `<div><code>${esc(s.ruleId)}</code> — ${esc(s.why)}. ${esc(s.action)} ${s.examples.map((e) => `<a href="${esc(e.url)}">!${esc(e.pr)}</a>`).join(' ')}</div>`).join('')}` : ''}
</div>`;
}

export function renderDashboard(m, { title = 'sfn review metrics', source = '', feedback } = {}) {
  const pct = (x) => `${Math.round(x * 100)}%`;
  const tile = (v, label) => `<div class="tile"><b>${esc(v)}</b><span>${esc(label)}</span></div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Review metrics</title>
<style>
:root{--bg:#fcfcfb;--panel:#fff;--text:#0b0b0b;--muted:#52514e;--line:#e6e5e0;--grid:#ecebe7;
  --s-blocker:#0d366b;--s-major:#1c5cab;--s-minor:#3987e5;--s-nit:#86b6ef;--s-bar:#2a78d6}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#121211;--panel:#1a1a19;--text:#f0efec;--muted:#c3c2b7;--line:#2e2d2a;--grid:#262624;
  --s-blocker:#b7d3f6;--s-major:#6da7ec;--s-minor:#2a78d6;--s-nit:#184f95;--s-bar:#3987e5}}
:root[data-theme="dark"]{--bg:#121211;--panel:#1a1a19;--text:#f0efec;--muted:#c3c2b7;--line:#2e2d2a;--grid:#262624;
  --s-blocker:#b7d3f6;--s-major:#6da7ec;--s-minor:#2a78d6;--s-nit:#184f95;--s-bar:#3987e5}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:960px;margin:0 auto;padding:28px 16px 64px}h1{font-size:22px;margin:0}h2{font-size:16px;margin:32px 0 10px}
.muted{color:var(--muted)}.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-top:16px}
.tile{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px}.tile b{display:block;font-size:24px}.tile span{color:var(--muted);font-size:13px}
.chart{width:100%;height:auto;display:block}.chart .grid{stroke:var(--grid)}.chart .axis{font-size:11px;fill:var(--muted)}
.chart .lbl{font:12px ui-monospace,Menlo,monospace;fill:var(--text)}.chart .val{font-size:12px;fill:var(--muted)}
.chart .hit{fill:transparent}.chart .hit:hover{fill:var(--grid);fill-opacity:.35}
.s-blocker{fill:var(--s-blocker);background:var(--s-blocker)}.s-major{fill:var(--s-major);background:var(--s-major)}
.s-minor{fill:var(--s-minor);background:var(--s-minor)}.s-nit{fill:var(--s-nit);background:var(--s-nit)}.s-bar{fill:var(--s-bar)}
.legend{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:6px;color:var(--muted);font-size:13px}.lg i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:6px 8px;border-top:1px solid var(--line)}th{color:var(--muted);font-weight:500}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}details summary{cursor:pointer;color:var(--muted);margin-top:8px}
</style></head><body><main>
<h1>${esc(title)}</h1><div class="muted">${esc(m.reviews)} reviews${source ? ` · ${esc(source)}` : ''} · generated ${esc(m.generatedAt.slice(0, 10))} · not attributed to people</div>
<div class="tiles">
${tile(m.reviews, 'reviews')}${tile(m.findingsPerReview, 'findings / review')}${tile(m.verdicts.fix_first, 'fix-first verdicts')}
${tile(pct(m.verifyRejectRate), 'candidates rejected by verify')}${tile(m.fixedOnRereview, 'fixed on re-review')}${tile(m.suppressed, 'suppressed')}
</div>
${feedbackSection(feedback)}
<h2>Findings per week, by severity</h2><div class="panel">${weeklyStack(m.weeks)}
<details><summary>Table</summary><table><tr><th>Week</th><th class="n">Reviews</th>${SEV.map((s) => `<th class="n">${s}</th>`).join('')}</tr>
${m.weeks.map((w) => `<tr><td>${esc(w.week)}</td><td class="n">${w.reviews}</td>${SEV.map((s) => `<td class="n">${w[s] ?? 0}</td>`).join('')}</tr>`).join('')}</table></details></div>
<h2>Most frequent rules</h2><div class="panel">${ruleBars(m.topRules)}
<details><summary>Table</summary><table><tr><th>Rule</th><th class="n">Findings</th><th class="n">Blockers</th><th>Repos</th></tr>
${m.topRules.map((r) => `<tr><td>${esc(r.ruleId)}</td><td class="n">${r.count}</td><td class="n">${r.blocker}</td><td>${esc(r.repos.join(', '))}</td></tr>`).join('')}</table></details></div>
<h2>By repo</h2><div class="panel"><table><tr><th>Repo</th><th class="n">Reviews</th><th class="n">Findings</th><th class="n">Fix-first</th></tr>
${m.repos.map((r) => `<tr><td>${esc(r.repo)}</td><td class="n">${r.reviews}</td><td class="n">${r.findings}</td><td class="n">${r.fixFirst}</td></tr>`).join('')}</table></div>
<h2>By category</h2><div class="panel"><table><tr><th>Category</th><th class="n">Findings</th></tr>
${Object.entries(m.categories).map(([c, n]) => `<tr><td>${esc(c)}</td><td class="n">${n}</td></tr>`).join('')}</table></div>
</main></body></html>`;
}
