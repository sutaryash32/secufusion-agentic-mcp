// Cross-repo deploy-order check (deterministic): work split across repos (same work-item / feature id in
// branch names) where the counterpart in another repo is NOT merged into develop yet. Backtest PR !1381:
// tenants-api retention shipped while events-api's feature/1093-global-retention-cleanup was unmerged.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ITEM_IN_TEXT = /(?:^|[^0-9A-Za-z])(?:WI|BUG|US|TASK|AB#|Feature\/)[- #]?(\d{3,6})(?=[^0-9]|$)/gi;
const ITEM_IN_BRANCH = /(?:^|\/)(?:(?:WI|BUG|US|TASK)-?)?(\d{3,6})(?=[-_/]|$)/gi;

/** Work-item / feature ids from a branch name and commit subjects. */
export function extractKeys(branch = '', subjects = []) {
  const keys = new Set();
  for (const m of String(branch).matchAll(ITEM_IN_BRANCH)) keys.add(m[1]);
  for (const s of subjects) for (const m of String(s).matchAll(ITEM_IN_TEXT)) keys.add(m[1]);
  return [...keys];
}

export const branchHasKey = (branch, key) => new RegExp(`(^|[^0-9])${key}([^0-9]|$)`).test(branch.replace(/^origin\//, ''));

/**
 * @param {object} o
 * @param {string} o.repoKey  the reviewed repo
 * @param {string} o.estateRoot
 * @param {string} [o.branch] source branch of the change (local branch or PR source ref)
 * @param {string[]} [o.subjects] commit subjects/bodies of the change
 * @param {string[]} o.repoKeys repos to look in
 * @param {number} [o.maxAgeDays] ignore counterpart branches older than this
 * @param {Function} [o.run] git runner (tests)
 */
export function findDeployOrder({ repoKey, estateRoot, branch = '', subjects = [], repoKeys = [], maxAgeDays = 180, run }) {
  const keys = extractKeys(branch.replace(/^refs\/heads\//, ''), subjects);
  if (!keys.length) return [];
  const git = run ?? ((dir, ...a) => { try { return execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } });
  const cutoff = new Date(Date.now() - maxAgeDays * 86400000).toISOString().slice(0, 10);
  const out = [];
  for (const other of repoKeys) {
    if (other === repoKey) continue;
    const dir = join(estateRoot, other);
    if (!existsSync(join(dir, '.git'))) continue;
    const develop = git(dir, 'rev-parse', '--verify', '--quiet', 'origin/develop') ? 'origin/develop' : '';
    if (!develop) continue;
    const refs = git(dir, 'for-each-ref', 'refs/remotes/origin', '--format=%(refname:short)\t%(objectname)\t%(committerdate:short)\t%(subject)')
      .split('\n').filter(Boolean).map((l) => { const [name, sha, date, subject] = l.split('\t'); return { name, sha, date, subject }; })
      .filter((r) => !/^origin\/(HEAD|develop|main|master|release)/.test(r.name) && r.date >= cutoff);
    for (const key of keys) {
      for (const r of refs.filter((x) => branchHasKey(x.name, key))) {
        if (isMerged(git, dir, r.sha, develop)) continue;
        const short = r.name.replace(/^origin\//, '');
        out.push({
          ruleId: 'CON-011', severity: 'major', confidence: 'possible', category: 'contracts', specialist: 'quick-check',
          repo: other, file: `branch:${short}`, line: 1, anchor: `${other}:${short}`,
          title: `Related work for #${key} in ${other} (${short}) is not merged into develop`,
          problem: `${repoKey} and ${other} both have work for #${key}, but ${other}'s branch ${short} (last commit ${r.date}: "${(r.subject ?? '').slice(0, 80)}") is not in develop.`,
          failureScenario: `If ${repoKey} is released first, the feature is half-deployed: the ${other} side it depends on (or that depends on it) is missing in that environment.`,
          suggestion: `Merge and release ${other}'s ${short} together with or before this change, or confirm the two halves are independent; note the deploy order in the release notes.`,
          evidence: [{ repo: other, file: `branch:${short}`, note: `tip ${r.sha.slice(0, 10)} (${r.date}) not an ancestor of ${develop}` }],
        });
      }
    }
  }
  return out;
}

// merged ⇔ the branch tip is an ancestor of develop ⇔ merge-base(tip, develop) == tip
function isMerged(git, dir, sha, develop) {
  return git(dir, 'merge-base', sha, develop) === sha;
}
