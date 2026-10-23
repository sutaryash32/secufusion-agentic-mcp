// Azure DevOps REST helpers shared by PR resolution, PR comments and Boards. No SDK.
// Auth, first match wins:
//   SYSTEM_ACCESSTOKEN (Azure Pipelines)                    -> Bearer
//   AZURE_DEVOPS_PAT / AZURE_DEVOPS_EXT_PAT (personal token) -> Basic
//   `az account get-access-token` (local Azure CLI login)    -> Bearer
// SFN_ADO_BASE_URL overrides the collection URL (tests, proxies).
import { execFileSync } from 'node:child_process';

const ADO_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798'; // Azure DevOps AAD resource id

/** Parses an Azure Repos remote URL. @returns {{org, project, repo, collectionUri}|undefined} */
export function parseRemote(url) {
  if (!url) return undefined;
  let m = url.match(/^https:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+?)(?:\.git)?\/?$/);
  if (m) return { org: m[1], project: decodeURIComponent(m[2]), repo: decodeURIComponent(m[3]), collectionUri: `https://dev.azure.com/${m[1]}/` };
  m = url.match(/^https:\/\/(?:[^@/]+@)?([^.]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/?#]+?)(?:\.git)?\/?$/);
  if (m) return { org: m[1], project: decodeURIComponent(m[2]), repo: decodeURIComponent(m[3]), collectionUri: `https://${m[1]}.visualstudio.com/` };
  m = url.match(/^(?:ssh:\/\/)?git@ssh\.dev\.azure\.com:(?:22\/)?v3\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (m) return { org: m[1], project: decodeURIComponent(m[2]), repo: decodeURIComponent(m[3]), collectionUri: `https://dev.azure.com/${m[1]}/` };
  return undefined;
}

export function authHeaders(env = process.env, run = execFileSync) {
  if (env.SYSTEM_ACCESSTOKEN && !env.SYSTEM_ACCESSTOKEN.startsWith('$(')) return { Authorization: `Bearer ${env.SYSTEM_ACCESSTOKEN}` };
  const pat = env.AZURE_DEVOPS_PAT || env.AZURE_DEVOPS_EXT_PAT;
  if (pat) return { Authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}` };
  try {
    const token = run('az', ['account', 'get-access-token', '--resource', ADO_RESOURCE, '--query', 'accessToken', '-o', 'tsv'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000,
    }).trim();
    if (token) return { Authorization: `Bearer ${token}` };
  } catch { /* az missing or not logged in */ }
  throw new Error('No Azure DevOps credentials: set AZURE_DEVOPS_PAT, run `az login`, or run in Azure Pipelines (SYSTEM_ACCESSTOKEN).');
}

export function createAdo({ collectionUri, project, headers, fetchImpl = fetch, env = process.env }) {
  const base = (env.SFN_ADO_BASE_URL || collectionUri).replace(/\/?$/, '/');
  const projectUrl = `${base}${encodeURIComponent(project)}`;
  async function request(method, url, body, contentType = 'application/json') {
    const res = await fetchImpl(url, { method, headers: { ...headers, 'Content-Type': contentType }, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) {
      const text = await res.text();
      const hint = res.status === 401 || res.status === 403 ? ' (check the token has access to this project/repo)' : '';
      throw new Error(`ADO ${method} ${url.split('?')[0].replace(base, '')} -> ${res.status}${hint}: ${text.slice(0, 400)}`);
    }
    return res.status === 204 ? {} : res.json();
  }
  const withVersion = (u) => `${u}${u.includes('?') ? '&' : '?'}api-version=7.1`;
  const call = (method, path, body, contentType) => request(method, withVersion(`${projectUrl}/_apis/${path}`), body, contentType);
  return {
    base,
    projectUrl,
    call,
    getPullRequest: (repo, id) => call('GET', `git/repositories/${encodeURIComponent(repo)}/pullrequests/${id}`),
    wiql: (query) => call('POST', 'wit/wiql', { query }),
    createWorkItem: (type, patch) => call('POST', `wit/workitems/$${encodeURIComponent(type)}`, patch, 'application/json-patch+json'),
    // team-scoped: {project}/{team}/_apis/...
    currentIteration: (team) => request('GET', withVersion(`${projectUrl}/${encodeURIComponent(team)}/_apis/work/teamsettings/iterations?$timeframe=current`)),
  };
}
