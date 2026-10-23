// Reviewer suggestions from git history — deterministic. Who knows the code this change touches:
//   - authorship of the lines the change rewrites (git blame on the base version), weight 2 per line;
//   - recent commits to the changed files, weight 1 per commit.
// The change's own authors and bots are excluded. Names only, never emails.

const BOT = /\b(bot|build service|azure pipelines|project collection|dependabot|renovate|github-actions)\b/i;

/**
 * @param {object} o
 * @param {Array<{file:string, blame:{lines:Array<{sha:string}>, commits:Object<string,{author?:string}>}}>} o.blames
 * @param {Array<{file:string, authors:string[]}>} o.recent   one entry per changed file, one author per recent commit
 * @param {string[]} o.exclude  authors of the change itself
 * @param {number} [o.max]
 */
export function suggestReviewers({ blames = [], recent = [], exclude = [], max = 3 }) {
  const skip = new Set(exclude.map((n) => n.trim().toLowerCase()));
  const score = new Map();
  const bump = (name, file, w, kind) => {
    if (!name || BOT.test(name) || skip.has(name.trim().toLowerCase())) return;
    const s = score.get(name) ?? { name, score: 0, files: new Set(), lines: 0, commits: 0 };
    s.score += w;
    s.files.add(file);
    if (kind === 'line') s.lines++;
    else s.commits++;
    score.set(name, s);
  };
  for (const { file, blame } of blames) {
    for (const { sha } of blame.lines) bump(blame.commits[sha]?.author, file, 2, 'line');
  }
  for (const { file, authors } of recent) for (const a of authors) bump(a, file, 1, 'commit');
  return [...score.values()]
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, max)
    .map((s) => ({
      name: s.name,
      why: [s.lines ? `wrote ${s.lines} of the lines this change rewrites` : '', s.commits ? `${s.commits} recent commit(s) to these files` : ''].filter(Boolean).join('; '),
      files: [...s.files].slice(0, 5),
    }));
}
