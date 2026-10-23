// Regression hints from git history — deterministic, no model.
// "This change rewrites lines that were last written by a bug-fix commit." For every line the change
// removes or modifies, `git blame` on the base version tells us which commit wrote it; if that commit
// looks like a fix (message pattern), the reviewer is told to check the fix isn't being undone.

/** Old-file line ranges touched by a `git diff -U0` (removed or modified lines), per file. */
export function parseOldRanges(diffU0) {
  const out = {};
  let file;
  for (const line of diffU0.split('\n')) {
    const f = line.match(/^--- (?:a\/(.+)|\/dev\/null)$/);
    if (f) { file = f[1]; continue; }
    const h = line.match(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/);
    if (h && file) {
      const start = Number(h[1]);
      const count = h[2] === undefined ? 1 : Number(h[2]);
      if (count > 0) (out[file] ??= []).push([start, start + count - 1]);
    }
  }
  return out;
}

/** `git blame --porcelain` → [{line, sha}] plus commit metadata. */
export function parseBlamePorcelain(text) {
  const lines = [];
  const commits = {};
  let current;
  for (const l of text.split('\n')) {
    const header = l.match(/^([0-9a-f]{40}) (\d+) (\d+)/);
    if (header) {
      current = header[1];
      // origLine = line number in the commit that wrote it; line = line in the blamed revision
      lines.push({ sha: current, line: Number(header[3]), origLine: Number(header[2]) });
      commits[current] ??= {};
      continue;
    }
    if (!current) continue;
    if (l.startsWith('summary ')) commits[current].summary = l.slice(8);
    else if (l.startsWith('author-time ')) commits[current].time = Number(l.slice(12));
    else if (l.startsWith('author ')) commits[current].author = l.slice(7);
  }
  return { lines, commits };
}

/**
 * @param {Array<{file, ranges, blame:{lines, commits}}>} perFile
 * @param {RegExp} fixPattern
 * @param {number} maxAgeDays only fixes this recent count
 * @param {number} now unix seconds
 */
export function buildHints(perFile, fixPattern, maxAgeDays, now = Math.floor(Date.now() / 1000)) {
  const hints = [];
  for (const { file, blame } of perFile) {
    const bySha = new Map();
    for (const { sha, line } of blame.lines) {
      const c = blame.commits[sha];
      if (!c?.summary || !fixPattern.test(c.summary)) continue;
      if (c.time && now - c.time > maxAgeDays * 86400) continue;
      if (!bySha.has(sha)) bySha.set(sha, { file, commit: sha.slice(0, 10), subject: c.summary, date: c.time ? new Date(c.time * 1000).toISOString().slice(0, 10) : null, oldLines: [] });
      bySha.get(sha).oldLines.push(line);
    }
    for (const h of bySha.values()) {
      h.oldLines = compress(h.oldLines.sort((a, b) => a - b));
      hints.push(h);
    }
  }
  return hints;
}

function compress(nums) {
  const out = [];
  for (const n of nums) {
    const last = out.at(-1);
    if (last && n === last[1] + 1) last[1] = n;
    else out.push([n, n]);
  }
  return out.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`));
}
