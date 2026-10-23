// Blast-radius map: links from what the change touches to the other repos it can affect.
// `linkBlastRadius` is deterministic (repos.json Kafka hints + UI→API call map); `renderBlastSvg` draws
// it as an inline SVG (three columns: this repo → touched surface → affected repos). Pure; unit-tested.

const GROUPS = [
  ['endpoints', 'Endpoints'],
  ['kafkaTopics', 'Kafka topics'],
  ['tables', 'Tables'],
  ['scheduledJobs', 'Scheduled jobs'],
  ['uiRoutes', 'UI routes'],
];
const MAX_PER_GROUP = 6;

/** @returns {Array<{group, item, repo, how}>} */
export function linkBlastRadius(blast = {}, repoKey, reposCfg = {}) {
  const repos = reposCfg.repos ?? {};
  const links = [];
  for (const topic of blast.kafkaTopics ?? []) {
    for (const [name, r] of Object.entries(repos)) {
      if (name === repoKey) continue;
      if (r.kafka?.consumes?.includes(topic)) links.push({ group: 'kafkaTopics', item: topic, repo: name, how: 'consumes' });
      else if (r.kafka?.produces?.includes(topic)) links.push({ group: 'kafkaTopics', item: topic, repo: name, how: 'produces' });
    }
  }
  const callers = Object.entries(repos).filter(([name, r]) => name !== repoKey && r.calls?.includes(repoKey)).map(([name]) => name);
  for (const ep of blast.endpoints ?? []) for (const repo of callers) links.push({ group: 'endpoints', item: ep, repo, how: 'calls' });
  // Shared tables: the three APIs share one database; `tenant` is mapped by all of them.
  for (const t of blast.tables ?? []) {
    if (/^(public\.)?tenant$/i.test(t)) {
      for (const [name, r] of Object.entries(repos)) {
        if (name !== repoKey && r.stack === 'java-spring') links.push({ group: 'tables', item: t, repo: name, how: 'maps' });
      }
    }
  }
  return links;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function renderBlastSvg(blast = {}, links = [], repoKey = 'repo', otherRepos = []) {
  const rows = [];
  for (const [key, label] of GROUPS) {
    const items = blast[key] ?? [];
    if (!items.length) continue;
    rows.push({ header: label });
    items.slice(0, MAX_PER_GROUP).forEach((item) => rows.push({ key, item }));
    if (items.length > MAX_PER_GROUP) rows.push({ more: items.length - MAX_PER_GROUP });
  }
  if (!rows.length) return '';
  const targets = [...new Set([...links.map((l) => l.repo), ...otherRepos])];

  const W = 860;
  const rowH = 26;
  const top = 16;
  const H = Math.max(rows.length, targets.length * 2, 3) * rowH + top * 2;
  const colRepo = { x: 16, w: 170 };
  const colItem = { x: 300, w: 300 };
  const colTarget = { x: 680, w: 164 };
  const repoY = H / 2;
  const itemY = new Map();
  const parts = [];

  // middle column
  rows.forEach((r, i) => {
    const y = top + i * rowH + rowH / 2;
    if (r.header) parts.push(`<text x="${colItem.x}" y="${y + 4}" class="bm-h">${esc(r.header)}</text>`);
    else if (r.more) parts.push(`<text x="${colItem.x + 12}" y="${y + 4}" class="bm-m">+${r.more} more</text>`);
    else {
      itemY.set(`${r.key}|${r.item}`, y);
      parts.push(`<path d="M${colRepo.x + colRepo.w} ${repoY} C ${colRepo.x + colRepo.w + 60} ${repoY}, ${colItem.x - 60} ${y}, ${colItem.x} ${y}" class="bm-e"/>`);
      parts.push(`<g class="bm-i"><title>${esc(r.item)}</title><rect x="${colItem.x}" y="${y - 10}" width="${colItem.w}" height="20" rx="4"/><text x="${colItem.x + 8}" y="${y + 4}">${esc(clip(r.item, 40))}</text></g>`);
    }
  });

  // right column
  const tGap = (H - top * 2) / Math.max(targets.length, 1);
  const targetY = new Map(targets.map((t, i) => [t, top + tGap * i + tGap / 2]));
  for (const l of links) {
    const y1 = itemY.get(`${l.group}|${l.item}`);
    const y2 = targetY.get(l.repo);
    if (y1 == null || y2 == null) continue;
    const x1 = colItem.x + colItem.w;
    parts.push(`<path d="M${x1} ${y1} C ${x1 + 50} ${y1}, ${colTarget.x - 50} ${y2}, ${colTarget.x} ${y2}" class="bm-e bm-x"><title>${esc(l.repo)} ${esc(l.how)} ${esc(l.item)}</title></path>`);
  }
  for (const [t, y] of targetY) {
    parts.push(`<g class="bm-t"><title>${esc(t)}</title><rect x="${colTarget.x}" y="${y - 13}" width="${colTarget.w}" height="26" rx="6"/><text x="${colTarget.x + 10}" y="${y + 4}">${esc(clip(t, 20))}</text></g>`);
  }
  // left node
  parts.push(`<g class="bm-r"><rect x="${colRepo.x}" y="${repoY - 18}" width="${colRepo.w}" height="36" rx="8"/><text x="${colRepo.x + 12}" y="${repoY + 5}">${esc(clip(repoKey, 20))}</text></g>`);

  return `<svg class="blastmap" viewBox="0 0 ${W} ${H}" role="img" aria-label="Blast radius: what ${esc(repoKey)} changes and which repos it can affect">${parts.join('')}</svg>`;
}

export const BLASTMAP_CSS = `
.blastmap{width:100%;height:auto;display:block}
.blastmap text{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;fill:var(--text)}
.blastmap .bm-h{font:600 12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.blastmap .bm-m{fill:var(--muted)}
.blastmap .bm-e{fill:none;stroke:var(--line);stroke-width:1.5}
.blastmap .bm-x{stroke:var(--accent);stroke-width:2}
.blastmap .bm-i rect{fill:var(--panel);stroke:var(--line)}
.blastmap .bm-t rect{fill:var(--panel);stroke:var(--accent);stroke-width:1.5}
.blastmap .bm-r rect{fill:var(--accent)}
.blastmap .bm-r text{fill:var(--on-accent);font-weight:600}
.blastmap g:hover rect{stroke-width:2.5}
`;
