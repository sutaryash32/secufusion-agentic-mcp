// Pure scope logic: risk score, level, specialists, skip. No git, no I/O — unit-tested.
import { matchesAny } from './glob.mjs';

export const ALL_SPECIALISTS = ['db', 'security', 'contracts', 'runtime', 'webui', 'tests', 'deps'];
// Which specialists make sense for a stack (deep level runs all of these).
export const STACK_SPECIALISTS = {
  'java-spring': ['db', 'security', 'contracts', 'runtime', 'tests', 'deps'],
  'react-vite': ['security', 'contracts', 'webui', 'tests', 'deps'],
  unknown: ['db', 'security', 'contracts', 'runtime', 'tests', 'deps'],
};
const CODE_FILE = /\.(java|kt|sql|js|jsx|mjs|ts|tsx|properties|ya?ml|xml)$/;
const TEST_FILE = /(^|\/)(src\/test\/|__tests__\/|test\/)|\.(test|spec)\.[jt]sx?$|Test\.java$/;
const PROD_CODE = /\.(java|kt|js|jsx|mjs|ts|tsx)$/;

/**
 * @param {Array<{path:string,added:number,removed:number}>} files
 * @param {object} reposCfg  config/repos.json
 * @param {object} reviewCfg config/review.json
 * @param {string} requestedLevel auto | quick | standard | deep
 * @param {string} [stack] java-spring | react-vite | unknown — limits specialists to those that apply
 */
export function planReview(files, reposCfg, reviewCfg, requestedLevel = 'auto', stack = 'unknown') {
  if (files.length === 0) {
    return { skip: true, skipReason: 'No changes between base and head.', risk: { score: 0, factors: [] } };
  }
  if (files.every((f) => matchesAny(f.path, reviewCfg.skipWhenOnly))) {
    return {
      skip: true,
      skipReason: 'Only docs/specs/lockfiles changed (skipWhenOnly).',
      risk: { score: 0, factors: [] },
    };
  }

  const factors = [];
  const specialists = new Set();
  let score = 0;

  for (const rule of reposCfg.riskRules ?? []) {
    const re = new RegExp(rule.match);
    const hits = files.filter((f) => re.test(f.path)).map((f) => f.path);
    if (hits.length === 0) continue;
    score += rule.weight;
    rule.specialists.forEach((s) => specialists.add(s));
    factors.push({ id: rule.id, weight: rule.weight, files: hits.slice(0, 10), fileCount: hits.length });
  }

  const lines = files.reduce((n, f) => n + (f.added || 0) + (f.removed || 0), 0);
  const tier = [...(reposCfg.sizeRisk ?? [])].sort((a, b) => b.over - a.over).find((t) => lines > t.over);
  if (tier) {
    score += tier.weight;
    factors.push({ id: `size>${tier.over}`, weight: tier.weight, lines });
  }
  score = Math.min(score, 10);

  const { quickMaxScore, deepMinScore } = reviewCfg.autoLevel;
  const autoLevel = score <= quickMaxScore ? 'quick' : score >= deepMinScore ? 'deep' : 'standard';
  const level = requestedLevel === 'auto' ? autoLevel : requestedLevel;
  if (!reviewCfg.levels[level]) throw new Error(`Unknown level "${level}"`);

  const applicable = STACK_SPECIALISTS[stack] ?? STACK_SPECIALISTS.unknown;
  const hasCode = files.some((f) => CODE_FILE.test(f.path));
  const hasProdCode = files.some((f) => PROD_CODE.test(f.path) && !TEST_FILE.test(f.path));
  if (level !== 'quick' && hasCode) specialists.add('security');
  if (level !== 'quick' && hasProdCode) specialists.add('tests');
  if (level === 'deep') applicable.forEach((s) => specialists.add(s));

  return {
    skip: false,
    risk: { score, factors, linesChanged: lines },
    level,
    autoLevel,
    specialists: ALL_SPECIALISTS.filter((s) => specialists.has(s) && applicable.includes(s)),
    notYetAvailable: [...specialists].filter((s) => !ALL_SPECIALISTS.includes(s)),
    verify: reviewCfg.levels[level].verify,
    generalPass: reviewCfg.levels[level].generalPass,
  };
}

/** Repo config for a key, falling back to stack defaults for repos not in repos.json. */
export function repoConfigFor(repoKey, detectedStack, reposCfg) {
  const known = reposCfg.repos?.[repoKey];
  if (known) return { known: true, ...known };
  const stack = detectedStack ?? 'unknown';
  return { known: false, stack, ...(reposCfg.defaults?.[stack] ?? {}) };
}
