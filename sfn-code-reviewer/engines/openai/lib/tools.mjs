// Read-only tools for the OpenAI engine. Confinement is enforced HERE, in code — not in the prompt:
// every path must resolve (after symlinks) inside an allowed root, and git runs only read-only
// subcommands without flags that write files or read outside the repo.
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { globToRegExp } from '../../../scripts/lib/glob.mjs';

const run = promisify(execFile);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'target', 'dist', 'build', '.sfn-review', '.idea']);
const GIT_SUBCOMMANDS = new Set(['diff', 'log', 'show', 'blame', 'ls-tree', 'ls-files', 'merge-base', 'rev-parse', 'cat-file']);
const GIT_BANNED_ARG = /^(--output|--no-index|--ext-diff|--textconv|--exec|--upload-pack|--receive-pack|--git-dir|--work-tree|-o$|-c$|--config)/;
const MAX_CHARS = 60_000;

export const TOOL_DEFINITIONS = [
  fn('read_file', 'Read a text file with line numbers. Relative paths resolve against the reviewed repo.', {
    path: { type: 'string', description: 'File path (absolute, or relative to the reviewed repo).' },
    offset: { type: 'integer', description: '1-based first line (default 1).' },
    limit: { type: 'integer', description: 'Max lines (default 400, max 2000).' },
  }, ['path']),
  fn('grep', 'Search file contents with an extended regex (grep -rnE). Returns path:line:text.', {
    pattern: { type: 'string' },
    path: { type: 'string', description: 'Directory or file to search (default: the reviewed repo).' },
    include: { type: 'string', description: 'Filename glob, e.g. *.java' },
    ignore_case: { type: 'boolean' },
  }, ['pattern']),
  fn('glob', 'Find files by glob pattern (supports **, *, ?), relative to a directory.', {
    pattern: { type: 'string', description: 'e.g. src/main/**/*Controller.java' },
    path: { type: 'string', description: 'Base directory (default: the reviewed repo).' },
  }, ['pattern']),
  fn('list_dir', 'List a directory (directories end with /).', {
    path: { type: 'string' },
  }, ['path']),
  fn('git', `Run a read-only git command in a repo. Allowed subcommands: ${[...GIT_SUBCOMMANDS].join(', ')}. Example: {"repo":"<repoPath>","args":["diff","<mergeBase>","<headSha>","--stat"]}.`, {
    repo: { type: 'string', description: 'Repo directory (default: the reviewed repo).' },
    args: { type: 'array', items: { type: 'string' }, description: 'Arguments after `git`, starting with the subcommand.' },
  }, ['args']),
];

/**
 * @param {{repoPath:string, roots:string[]}} ctx  roots = every directory the agent may read
 */
export function createTools({ repoPath, roots }) {
  const realRoots = roots.filter(existsSync).map((r) => realpathSync(r));

  function confine(p, { mustExist = true } = {}) {
    if (typeof p !== 'string' || !p) throw new Error('path is required');
    const abs = isAbsolute(p) ? p : resolve(repoPath, p);
    if (mustExist && !existsSync(abs)) throw new Error(`not found: ${p}`);
    const real = existsSync(abs) ? realpathSync(abs) : abs;
    if (!realRoots.some((r) => real === r || real.startsWith(r + sep))) {
      throw new Error(`access denied: ${p} is outside the review roots`);
    }
    return real;
  }

  const impl = {
    read_file({ path, offset = 1, limit = 400 }) {
      const file = confine(path);
      if (statSync(file).isDirectory()) throw new Error(`${path} is a directory — use list_dir`);
      const buf = readFileSync(file);
      if (buf.includes(0)) throw new Error(`${path} is binary`);
      const lines = buf.toString('utf8').split('\n');
      const start = Math.max(1, offset);
      const n = Math.min(Math.max(1, limit), 2000);
      const slice = lines.slice(start - 1, start - 1 + n).map((l, i) => `${start + i}\t${l}`);
      const more = start - 1 + n < lines.length ? `\n… (${lines.length} lines total; continue with offset ${start + n})` : '';
      return slice.join('\n') + more;
    },

    async grep({ pattern, path = repoPath, include, ignore_case = false }) {
      const target = confine(path);
      const args = ['-rnE', '-I', ...(ignore_case ? ['-i'] : []), ...[...SKIP_DIRS].map((d) => `--exclude-dir=${d}`)];
      if (include) args.push(`--include=${include}`);
      args.push('-e', pattern, target);
      try {
        const { stdout } = await run('grep', args, { maxBuffer: 32 * 1024 * 1024 });
        const lines = stdout.split('\n').filter(Boolean).map((l) => (l.length > 300 ? `${l.slice(0, 300)}…` : l));
        return lines.slice(0, 300).join('\n') + (lines.length > 300 ? `\n… ${lines.length - 300} more matches — narrow the search` : '');
      } catch (e) {
        if (e.code === 1) return '(no matches)';
        throw new Error(`grep failed: ${e.stderr || e.message}`);
      }
    },

    glob({ pattern, path = repoPath }) {
      const base = confine(path);
      const re = globToRegExp(pattern);
      const out = [];
      (function walk(dir) {
        for (const name of readdirSync(dir)) {
          if (out.length >= 300) return;
          const p = join(dir, name);
          const st = statSync(p, { throwIfNoEntry: false });
          if (!st) continue;
          if (st.isDirectory()) { if (!SKIP_DIRS.has(name)) walk(p); }
          else if (re.test(relative(base, p).split(sep).join('/'))) out.push(relative(base, p));
        }
      })(base);
      return out.length ? out.join('\n') + (out.length >= 300 ? '\n… (truncated at 300)' : '') : '(no files)';
    },

    list_dir({ path }) {
      const dir = confine(path);
      return readdirSync(dir, { withFileTypes: true })
        .filter((d) => !SKIP_DIRS.has(d.name))
        .map((d) => (d.isDirectory() ? `${d.name}/` : d.name))
        .sort()
        .join('\n');
    },

    async git({ repo = repoPath, args }) {
      if (!Array.isArray(args) || args.length === 0) throw new Error('args must be a non-empty array');
      const dir = confine(repo);
      const [sub, ...rest] = args;
      if (!GIT_SUBCOMMANDS.has(sub)) throw new Error(`git ${sub} is not allowed (read-only subcommands only)`);
      const bad = rest.find((a) => GIT_BANNED_ARG.test(a));
      if (bad) throw new Error(`git argument not allowed: ${bad}`);
      try {
        const { stdout } = await run('git', ['-C', dir, '--no-pager', sub, ...rest], {
          maxBuffer: 64 * 1024 * 1024,
          env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_NOSYSTEM: '1' },
        });
        return stdout || '(empty)';
      } catch (e) {
        throw new Error(`git failed: ${(e.stderr || e.message).slice(0, 500)}`);
      }
    },
  };

  return {
    definitions: TOOL_DEFINITIONS,
    async exec(name, rawArgs) {
      const fnImpl = impl[name];
      if (!fnImpl) return `Error: unknown tool ${name}`;
      let parsed;
      try { parsed = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : rawArgs ?? {}; }
      catch { return 'Error: arguments are not valid JSON'; }
      try {
        const out = String(await fnImpl(parsed));
        return out.length > MAX_CHARS ? `${out.slice(0, MAX_CHARS)}\n… (output truncated at ${MAX_CHARS} chars — narrow the request)` : out;
      } catch (e) {
        return `Error: ${e.message}`;
      }
    },
  };
}

function fn(name, description, properties, required) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } };
}
