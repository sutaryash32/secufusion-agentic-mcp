// Azure Boards: plan Bug work items from review findings. Pure; the script does the HTTP.
// Idempotent: every bug carries the tags `sfn-review` and `sfn-finding-<id>`, so a finding never gets
// two bugs. (Tags, not description text: WIQL can't CONTAINS-match HTML fields reliably.)
import { SEVERITY_RANK } from './findings.mjs';

export const bugMarker = (id) => `sfn-finding-${id}`;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const PRIORITY = { blocker: 1, major: 2, minor: 3, nit: 4 };
const SEVERITY_FIELD = { blocker: '1 - Critical', major: '2 - High', minor: '3 - Medium', nit: '4 - Low' };

/** WIQL that finds bugs we already created for these finding ids. */
export function existingBugsQuery(project, ids) {
  const clauses = ids.map((id) => `[System.Tags] CONTAINS '${bugMarker(id)}'`);
  return `SELECT [System.Id], [System.Tags] FROM WorkItems WHERE [System.TeamProject] = '${project.replace(/'/g, "''")}' AND (${clauses.join(' OR ')})`;
}

/**
 * @param {object} result finalized review result
 * @param {{minSeverity:string, confirmedOnly:boolean, max:number}} opts
 */
export function selectFindings(result, { minSeverity = 'blocker', confirmedOnly = true, max = 10 } = {}) {
  return result.findings
    .filter((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[minSeverity] && (!confirmedOnly || f.confidence === 'confirmed'))
    .slice(0, max);
}

export function bugFields(f, { repoKey, headSha, reportUrl }) {
  const repo = f.repo ?? repoKey;
  const evidence = (f.evidence ?? []).map((e) => `<li><code>${esc(e.repo ? `${e.repo}/` : '')}${esc(e.file)}${e.line ? `:${e.line}` : ''}</code> — ${esc(e.note)}</li>`).join('');
  const repro = [
    `<p><b>${esc(f.severity.toUpperCase())}</b> · ${esc(f.confidence)} · rule <code>${esc(f.ruleId)}</code> · <code>${esc(repo)}/${esc(f.file)}:${esc(f.line)}</code></p>`,
    `<p>${esc(f.problem)}</p>`,
    `<p><b>Fails when:</b> ${esc(f.failureScenario)}</p>`,
    `<p><b>Suggested fix:</b> ${esc(f.suggestion)}</p>`,
    evidence ? `<p><b>Evidence</b></p><ul>${evidence}</ul>` : '',
    f.verification ? `<p><i>Verified:</i> ${esc(f.verification)}</p>` : '',
    `<p><small>Found by sfn-code-reviewer${headSha ? ` at commit ${esc(headSha.slice(0, 10))}` : ''}${reportUrl ? ` · <a href="${esc(reportUrl)}">report</a>` : ''} · ${bugMarker(f.id)}</small></p>`,
  ].join('');
  return {
    title: `[sfn-review] ${f.ruleId}: ${f.title}`.slice(0, 250),
    reproSteps: repro,
    priority: PRIORITY[f.severity],
    severity: SEVERITY_FIELD[f.severity],
    tags: ['sfn-review', bugMarker(f.id), repo, f.category, f.ruleId],
  };
}

export function toPatch(fields, { areaPath, iterationPath, extraTags = [] }) {
  const ops = [
    { op: 'add', path: '/fields/System.Title', value: fields.title },
    { op: 'add', path: '/fields/Microsoft.VSTS.TCM.ReproSteps', value: fields.reproSteps },
    { op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: fields.priority },
    { op: 'add', path: '/fields/Microsoft.VSTS.Common.Severity', value: fields.severity },
    { op: 'add', path: '/fields/System.Tags', value: [...new Set([...fields.tags, ...extraTags])].join('; ') },
  ];
  if (areaPath) ops.push({ op: 'add', path: '/fields/System.AreaPath', value: areaPath });
  if (iterationPath) ops.push({ op: 'add', path: '/fields/System.IterationPath', value: iterationPath });
  return ops;
}
