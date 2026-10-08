import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
/**
 * Diff quality & repository consistency. Deterministic, no LLM.
 *
 * Question answered: "is the diff that would be committed bigger than the change the
 * developer meant to make, and if so why?" Causes covered: CRLF/LF conversion, mixed
 * line endings, whitespace rewrites, re-wrapping/reformatting, BOM/encoding changes,
 * end-of-file newline, file mode.
 *
 * Principle ("When in Rome"): the file's and repository's existing convention is the
 * default expectation. Consistent CRLF and consistent LF are both fine. Nothing here
 * demands normalization to a preferred style; it reports deviation from what was there.
 */
export const THRESHOLDS = {
    /** A diff must touch at least this many lines before it can count as "disproportionate". */
    MIN_CHURN: 50,
    /** ...and the real (semantic) change must be at most this share of it. */
    SEMANTIC_RATIO: 0.2,
    /** Files larger than this are skipped and reported, never silently passed. */
    MAX_BYTES: 2 * 1024 * 1024,
    /** Config-explained mismatches across this many files collapse into one finding. */
    DEDUP_MIN: 3,
    MAX_FILES: 300,
    /** Lower bound for reporting minor noise. */
    MINOR_NOISE: 10,
    /** Token delta below this share means "same code, different layout". */
    FORMAT_TOKEN_DELTA: 0.05,
};
export const REVIEW_SEVERITY = { INFO: "NOTE", LOW: "SUGGESTION", MEDIUM: "WARNING", HIGH: "BLOCKER" };
const SEV_RANK = { INFO: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };
// ── git plumbing (execFile only; no shell) ──────────────────────────────────
function git(cwd, args, asBuffer = false) {
    try {
        const out = execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 });
        return asBuffer ? out : out.toString("utf-8");
    }
    catch {
        return null;
    }
}
function gitTop(cwd) {
    const out = git(cwd, ["rev-parse", "--show-toplevel"]);
    return out ? path.resolve(out.trim()) : null;
}
// ── file state ──────────────────────────────────────────────────────────────
export function detectLineEndings(buf) {
    const probe = buf.subarray(0, 8000);
    if (probe.includes(0))
        return { state: "N/A", crlf: 0, lf: 0, cr: 0, minority_lines: [], reason: "binary (NUL byte)" };
    const kinds = [];
    for (let i = 0; i < buf.length; i++) {
        const b = buf[i];
        if (b === 13) {
            if (buf[i + 1] === 10) {
                kinds.push("CRLF");
                i++;
            }
            else
                kinds.push("CR");
        }
        else if (b === 10)
            kinds.push("LF");
    }
    const crlf = kinds.filter((k) => k === "CRLF").length;
    const lf = kinds.filter((k) => k === "LF").length;
    const cr = kinds.filter((k) => k === "CR").length;
    const present = [crlf, lf, cr].filter((n) => n > 0).length;
    if (present === 0)
        return { state: "NONE", crlf, lf, cr, minority_lines: [] };
    if (present === 1)
        return { state: crlf ? "CRLF" : lf ? "LF" : "CR", crlf, lf, cr, minority_lines: [] };
    const counts = [["CRLF", crlf], ["LF", lf], ["CR", cr]];
    const minority = counts.filter(([, n]) => n > 0).sort((a, b) => a[1] - b[1])[0][0];
    const lines = [];
    kinds.forEach((k, i) => { if (k === minority && lines.length < 5)
        lines.push(i + 1); });
    return { state: "MIXED", crlf, lf, cr, minority_lines: lines, minority_kind: minority };
}
const VENDOR_RE = /(^|\/)(node_modules|dist|build|target|vendor|coverage|out|\.next|__pycache__|\.git|\.secufusion)\//;
const GENERATED_NAME_RE = /(\.min\.(js|css)|\.map|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|\.lock)$/;
const BINARY_EXT_RE = /\.(png|jpe?g|gif|ico|pdf|zip|gz|tgz|jar|class|woff2?|ttf|eot|so|dll|exe|bin|mp4|webp|psd|keystore)$/i;
/** Why line-ending analysis does not apply to this file, or null if it does. */
export function exclusionReason(root, rel, buf) {
    const norm = rel.replace(/\\/g, "/");
    if (VENDOR_RE.test(norm))
        return "generated/vendor directory";
    if (GENERATED_NAME_RE.test(norm))
        return "generated/lock file";
    if (BINARY_EXT_RE.test(norm))
        return "binary file type";
    const attrs = checkAttr(root, norm, ["text", "binary", "linguist-generated", "linguist-vendored", "eol"]);
    if (attrs["binary"] === "set" || attrs["text"] === "unset")
        return ".gitattributes marks it binary / -text";
    if (attrs["linguist-generated"] === "set" || attrs["linguist-generated"] === "true")
        return ".gitattributes: linguist-generated";
    if (attrs["linguist-vendored"] === "set" || attrs["linguist-vendored"] === "true")
        return ".gitattributes: linguist-vendored";
    if (buf) {
        if (buf.length > THRESHOLDS.MAX_BYTES)
            return `larger than ${THRESHOLDS.MAX_BYTES} bytes (skipped, not verified)`;
        const head = buf.subarray(0, 512).toString("latin1");
        if (/@generated|DO NOT EDIT|Code generated .* DO NOT EDIT/i.test(head))
            return "generated-file header";
        if (buf.subarray(0, 8000).includes(0))
            return "binary (NUL byte)";
    }
    return null;
}
function checkAttr(root, rel, names) {
    const out = git(root, ["check-attr", ...names, "--", rel]);
    const res = {};
    if (!out)
        return res;
    for (const line of out.split(/\r?\n/)) {
        const m = /^.*?: ([^:]+): (.*)$/.exec(line);
        if (m)
            res[m[1].trim()] = m[2].trim();
    }
    return res;
}
// ── convention resolution ───────────────────────────────────────────────────
function globToRe(g) {
    let re = "";
    let brace = 0;
    for (let i = 0; i < g.length; i++) {
        const c = g[i];
        if (c === "*") {
            if (g[i + 1] === "*") {
                re += ".*";
                i++;
            }
            else
                re += "[^/]*";
        }
        else if (c === "?")
            re += "[^/]";
        else if (c === "{") {
            brace++;
            re += "(?:";
        }
        else if (c === "}" && brace > 0) {
            brace--;
            re += ")";
        }
        else if (c === "," && brace > 0)
            re += "|";
        else if (c === "[") {
            const j = g.indexOf("]", i);
            if (j > i) {
                re += g.slice(i, j + 1).replace("[!", "[^");
                i = j;
            }
            else
                re += "\\[";
        }
        else if (".+^$()|\\".includes(c))
            re += "\\" + c;
        else
            re += c;
    }
    return new RegExp(g.includes("/") ? `^${re.replace(/^\\?\//, "")}$` : `(^|.*/)${re}$`);
}
function parseEditorConfig(text) {
    const cfg = { root: false, sections: [] };
    let cur = null;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#") || line.startsWith(";"))
            continue;
        const sec = /^\[(.+)\]$/.exec(line);
        if (sec) {
            cur = { glob: sec[1], props: {} };
            cfg.sections.push(cur);
            continue;
        }
        const kv = /^([^=:]+?)\s*[=:]\s*(.*)$/.exec(line);
        if (!kv)
            continue;
        const key = kv[1].trim().toLowerCase();
        const val = kv[2].trim().toLowerCase();
        if (!cur) {
            if (key === "root" && val === "true")
                cfg.root = true;
        }
        else
            cur.props[key] = val;
    }
    return cfg;
}
function editorConfigEol(top, rel) {
    const dirs = [];
    let d = path.dirname(path.join(top, rel));
    while (d.startsWith(top)) {
        dirs.push(d);
        if (d === top)
            break;
        d = path.dirname(d);
    }
    const chain = [];
    for (const dir of dirs) {
        const p = path.join(dir, ".editorconfig");
        if (!fs.existsSync(p))
            continue;
        const cfg = parseEditorConfig(fs.readFileSync(p, "utf-8"));
        chain.push({ dir, cfg });
        if (cfg.root)
            break;
    }
    let eol = null;
    for (const { dir, cfg } of chain.reverse()) {
        const relToCfg = path.relative(dir, path.join(top, rel)).replace(/\\/g, "/");
        for (const s of cfg.sections) {
            if (globToRe(s.glob).test(relToCfg) && s.props["end_of_line"])
                eol = s.props["end_of_line"];
        }
    }
    return eol === "lf" || eol === "crlf" ? eol : null;
}
function nearestUp(top, rel, probe) {
    let d = path.dirname(path.join(top, rel));
    while (d.startsWith(top)) {
        const hit = probe(d);
        if (hit)
            return hit;
        if (d === top)
            break;
        d = path.dirname(d);
    }
    return null;
}
function prettierEol(top, rel) {
    const names = [".prettierrc", ".prettierrc.json", ".prettierrc.yaml", ".prettierrc.yml", ".prettierrc.js", ".prettierrc.cjs", ".prettierrc.mjs", "prettier.config.js", "prettier.config.cjs", "prettier.config.mjs"];
    return nearestUp(top, rel, (dir) => {
        for (const n of names) {
            const p = path.join(dir, n);
            if (!fs.existsSync(p))
                continue;
            const m = /endOfLine["']?\s*[:=]\s*["']?(lf|crlf|cr|auto)/i.exec(fs.readFileSync(p, "utf-8"));
            if (m && (m[1].toLowerCase() === "lf" || m[1].toLowerCase() === "crlf"))
                return { eol: m[1].toLowerCase(), source: path.relative(top, p).replace(/\\/g, "/") + " (prettier endOfLine)" };
            return null;
        }
        const pj = path.join(dir, "package.json");
        if (fs.existsSync(pj)) {
            try {
                const eol = JSON.parse(fs.readFileSync(pj, "utf-8"))?.prettier?.endOfLine;
                if (eol === "lf" || eol === "crlf")
                    return { eol, source: path.relative(top, pj).replace(/\\/g, "/") + " (prettier endOfLine)" };
            }
            catch { /* ignore */ }
        }
        return null;
    });
}
function eslintEol(top, rel) {
    const names = [".eslintrc", ".eslintrc.json", ".eslintrc.js", ".eslintrc.cjs", "eslint.config.js", "eslint.config.mjs", "eslint.config.cjs"];
    return nearestUp(top, rel, (dir) => {
        for (const n of names) {
            const p = path.join(dir, n);
            if (!fs.existsSync(p))
                continue;
            const m = /linebreak-style["']?\s*:\s*\[\s*["']?(?:error|warn|2|1)["']?\s*,\s*["'](unix|windows)["']/.exec(fs.readFileSync(p, "utf-8"));
            if (m)
                return { eol: m[1] === "unix" ? "lf" : "crlf", source: n + " (eslint linebreak-style)" };
        }
        return null;
    });
}
export function resolveConvention(top, rel) {
    const explicit = [];
    const attrs = checkAttr(top, rel, ["eol"]);
    if (attrs["eol"] === "lf" || attrs["eol"] === "crlf")
        explicit.push({ source: ".gitattributes (eol=" + attrs["eol"] + ")", eol: attrs["eol"] });
    const ec = editorConfigEol(top, rel);
    if (ec)
        explicit.push({ source: ".editorconfig (end_of_line=" + ec + ")", eol: ec });
    const pr = prettierEol(top, rel);
    if (pr)
        explicit.push(pr);
    const es = eslintEol(top, rel);
    if (es)
        explicit.push(es);
    const distinct = new Set(explicit.map((e) => e.eol));
    if (distinct.size > 1)
        return { explicit, conflict: true, expected: null, expected_source: null };
    if (explicit.length === 0)
        return { explicit, conflict: false, expected: null, expected_source: null };
    return { explicit, conflict: false, expected: explicit[0].eol, expected_source: explicit.map((e) => e.source).join(" + ") };
}
/** Majority line ending of tracked siblings (same directory, same extension). Weakest evidence. */
function siblingConvention(top, rel) {
    const dir = path.posix.dirname(rel.replace(/\\/g, "/"));
    const ext = path.posix.extname(rel);
    const out = git(top, ["ls-files", "--eol", "--", dir === "." ? "." : dir]);
    if (!out)
        return null;
    let lf = 0, crlf = 0;
    for (const line of out.split(/\r?\n/)) {
        const m = /^i\/(\S+)\s+w\/(\S+)\s+attr\/\S*\s+(.*)$/.exec(line);
        if (!m)
            continue;
        const p = m[3].trim();
        if (p === rel || path.posix.extname(p) !== ext || path.posix.dirname(p) !== dir)
            continue;
        if (m[2] === "lf")
            lf++;
        else if (m[2] === "crlf")
            crlf++;
    }
    if (lf + crlf < 3)
        return null;
    if (lf / (lf + crlf) >= 0.75)
        return "lf";
    if (crlf / (lf + crlf) >= 0.75)
        return "crlf";
    return null;
}
// ── base selection ──────────────────────────────────────────────────────────
export function pickBase(top, explicitBase) {
    if (explicitBase)
        return { base: explicitBase, reason: "explicit" };
    const candidates = [];
    const head = git(top, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
    if (head)
        candidates.push(head.trim().replace("refs/remotes/", ""));
    candidates.push("origin/main", "origin/master", "main", "master", "develop");
    for (const c of candidates) {
        if (!git(top, ["rev-parse", "--verify", "--quiet", c]))
            continue;
        const mb = git(top, ["merge-base", "HEAD", c]);
        const headSha = git(top, ["rev-parse", "HEAD"]);
        if (mb && headSha && mb.trim() !== headSha.trim())
            return { base: mb.trim(), reason: `merge-base with ${c}` };
    }
    return { base: "HEAD", reason: "HEAD (on the default branch or no default branch found; working-tree changes only)" };
}
// ── numstat cascade ─────────────────────────────────────────────────────────
function numstat(top, base, paths, flags) {
    const out = git(top, ["diff", "-M", "--numstat", ...flags, base, "--", ...paths]);
    if (out === null)
        return null;
    let a = 0, d = 0;
    for (const line of out.split(/\r?\n/)) {
        const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);
        if (!m)
            continue;
        if (m[1] === "-")
            return -1; // binary
        a += Number(m[1]);
        d += Number(m[2]);
    }
    return Math.max(a, d);
}
const TOKEN_RE = /[A-Za-z0-9_$]+|[^\sA-Za-z0-9_$]/g;
function tokenDelta(a, b) {
    const count = (s) => {
        const m = new Map();
        for (const t of s.match(TOKEN_RE) ?? [])
            m.set(t, (m.get(t) ?? 0) + 1);
        return m;
    };
    const ca = count(a), cb = count(b);
    let delta = 0, total = 0;
    for (const [t, n] of ca) {
        delta += Math.abs(n - (cb.get(t) ?? 0));
        total += n;
    }
    for (const [t, n] of cb) {
        if (!ca.has(t))
            delta += n;
        total += n;
    }
    return total === 0 ? 0 : delta / total;
}
function bomOf(buf) {
    if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf)
        return "utf8";
    if (buf[0] === 0xff && buf[1] === 0xfe)
        return "utf16le";
    if (buf[0] === 0xfe && buf[1] === 0xff)
        return "utf16be";
    return null;
}
function validUtf8(buf) {
    try {
        new TextDecoder("utf-8", { fatal: true }).decode(buf);
        return true;
    }
    catch {
        return false;
    }
}
const CONFIG_FILE_RE = /(^|\/)(\.gitattributes|\.editorconfig|\.prettierrc[^/]*|prettier\.config\.[^/]+|\.eslintrc[^/]*|eslint\.config\.[^/]+)$/;
function describeEol(i) {
    if (!i)
        return "n/a (new file)";
    if (i.state === "MIXED")
        return `MIXED (${i.crlf} CRLF, ${i.lf} LF${i.cr ? `, ${i.cr} CR` : ""})`;
    if (i.state === "NONE")
        return "no line terminators";
    return i.state;
}
export function analyzeDiffQuality(workspaceRoot, opts = {}) {
    const top = gitTop(workspaceRoot);
    const notes = [];
    const report = {
        git: !!top, root: top ?? path.resolve(workspaceRoot), base: null, base_reason: "no git repository",
        conversion: { autocrlf: null, core_eol: null }, files_analyzed: 0, truncated: false,
        files: [], findings: [], max_severity: null, notes,
    };
    const root = report.root;
    let changed = [];
    let base = "HEAD";
    if (top) {
        const b = pickBase(top, opts.base);
        base = b.base;
        report.base = base;
        report.base_reason = b.reason;
        report.conversion.autocrlf = (git(top, ["config", "--get", "core.autocrlf"]) ?? "").trim() || null;
        report.conversion.core_eol = (git(top, ["config", "--get", "core.eol"]) ?? "").trim() || null;
        const ns = git(top, ["diff", "-M", "--name-status", "--diff-filter=ACMRT", base]) ?? "";
        for (const line of ns.split(/\r?\n/).filter(Boolean)) {
            const parts = line.split("\t");
            if (parts[0].startsWith("R"))
                changed.push({ file: parts[2], old: parts[1] });
            else
                changed.push({ file: parts[1] });
        }
        const untracked = (git(top, ["ls-files", "--others", "--exclude-standard"]) ?? "").split(/\r?\n/).filter(Boolean);
        for (const u of untracked)
            changed.push({ file: u, untracked: true });
        if (report.conversion.autocrlf === "true" || report.conversion.autocrlf === "input") {
            notes.push(`core.autocrlf=${report.conversion.autocrlf}: git normalizes line endings on commit, so on-disk CRLF/LF does not by itself change the committed diff. Churn below is measured on what would be committed.`);
        }
    }
    else {
        notes.push("Not a git repository: diff-noise analysis is unavailable. Only file state and configured conventions were checked.");
        const files = opts.files ?? [];
        changed = files.map((f) => ({ file: f }));
    }
    if (opts.files) {
        const want = new Set(opts.files.map((f) => f.replace(/\\/g, "/")));
        changed = changed.filter((c) => want.has(c.file.replace(/\\/g, "/")));
        for (const f of want)
            if (!changed.some((c) => c.file.replace(/\\/g, "/") === f))
                changed.push({ file: f });
    }
    if (changed.length > THRESHOLDS.MAX_FILES) {
        report.truncated = true;
        notes.push(`${changed.length} changed files; only the first ${THRESHOLDS.MAX_FILES} were analyzed.`);
        changed = changed.slice(0, THRESHOLDS.MAX_FILES);
    }
    const configChanged = changed.some((c) => CONFIG_FILE_RE.test(c.file.replace(/\\/g, "/")));
    const findings = [];
    const add = (f) => findings.push({ ...f, id: "", review_severity: REVIEW_SEVERITY[f.severity] });
    for (const c of changed) {
        const rel = c.file.replace(/\\/g, "/");
        const abs = path.join(root, rel);
        const fr = { file: rel, old_file: c.old, status: "ANALYZED", classifications: [] };
        report.files.push(fr);
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
            fr.status = "SKIPPED";
            fr.skip_reason = "not a regular file on disk";
            continue;
        }
        const stat = fs.statSync(abs);
        const buf = stat.size > THRESHOLDS.MAX_BYTES ? null : fs.readFileSync(abs);
        const skip = stat.size > THRESHOLDS.MAX_BYTES
            ? `larger than ${THRESHOLDS.MAX_BYTES} bytes (skipped, not verified)`
            : top ? exclusionReason(top, rel, buf) : exclusionReason(root, rel, buf);
        if (skip || !buf) {
            fr.status = "SKIPPED";
            fr.skip_reason = skip ?? "unreadable";
            continue;
        }
        report.files_analyzed++;
        const disk = detectLineEndings(buf);
        fr.disk = disk;
        if (disk.state === "N/A") {
            fr.status = "SKIPPED";
            fr.skip_reason = disk.reason;
            continue;
        }
        const baseBuf = top && !c.untracked ? git(top, ["show", `${base}:${c.old ?? rel}`], true) : null;
        const baseEol = baseBuf ? detectLineEndings(baseBuf) : null;
        fr.base = baseEol;
        const conv = top ? resolveConvention(top, rel) : resolveConvention(root, rel);
        fr.expected_eol = conv.expected;
        fr.expected_source = conv.expected_source;
        const established = baseEol && (baseEol.state === "LF" || baseEol.state === "CRLF") ? baseEol.state.toLowerCase()
            : top && !baseBuf ? siblingConvention(top, rel) : null;
        fr.established_eol = established;
        // churn cascade (what would be committed)
        let churn;
        if (top && baseBuf) {
            const paths = c.old ? [c.old, rel] : [rel];
            const raw = numstat(top, base, paths, []);
            if (raw !== null && raw >= 0) {
                const noCr = numstat(top, base, paths, ["--ignore-cr-at-eol"]) ?? raw;
                const noTrail = numstat(top, base, paths, ["--ignore-cr-at-eol", "--ignore-space-at-eol"]) ?? noCr;
                const noWs = numstat(top, base, paths, ["--ignore-cr-at-eol", "-w"]) ?? noTrail;
                const sem = numstat(top, base, paths, ["--ignore-cr-at-eol", "-w", "--ignore-blank-lines"]) ?? noWs;
                churn = {
                    raw, semantic: sem,
                    eol: Math.max(0, raw - noCr), trailing_ws: Math.max(0, noCr - noTrail),
                    whitespace: Math.max(0, noTrail - noWs), blank_lines: Math.max(0, noWs - sem),
                };
                fr.churn = churn;
            }
        }
        if (churn && churn.semantic > 0)
            fr.classifications.push("CODE_CHANGE");
        const fileFindings = [];
        // 1. shebang scripts must be LF
        const firstLine = buf.subarray(0, 200).toString("latin1").split("\n")[0];
        if (/^#!/.test(firstLine) && firstLine.endsWith("\r")) {
            fileFindings.push({
                file: rel, category: "LINE_ENDING", finding: "SHEBANG_WITH_CRLF", classification: "LINE_ENDING_CHANGE", severity: "HIGH",
                evidence: `${rel}: first line "${firstLine.replace(/\r/g, "\\r")}" ends in CR`,
                expected: "LF in a script with a shebang (the interpreter name includes the CR otherwise)",
                actual: describeEol(disk),
                recommendation: "Convert this script to LF; scripts with a shebang fail to execute with CRLF.",
            });
        }
        // 2. mixed line endings
        if (disk.state === "MIXED") {
            const introduced = !baseEol || baseEol.state !== "MIXED";
            const noisy = !!churn && churn.eol >= THRESHOLDS.MINOR_NOISE;
            const sev = introduced ? (noisy ? "HIGH" : "MEDIUM") : "LOW";
            fr.classifications.push("MIXED_LINE_ENDINGS");
            fileFindings.push({
                file: rel, category: "LINE_ENDING", finding: "MIXED_LINE_ENDINGS", classification: "MIXED_LINE_ENDINGS", severity: sev,
                evidence: `${rel}: ${describeEol(disk)}; minority ${disk.minority_kind} at line(s) ${disk.minority_lines.join(", ")}` +
                    (baseEol ? `; base was ${describeEol(baseEol)}` : "; new file"),
                expected: conv.expected ? `consistent ${conv.expected.toUpperCase()} (${conv.expected_source})` : `consistent ${established ? established.toUpperCase() : "line endings"} (the file's existing style)`,
                actual: describeEol(disk),
                recommendation: introduced
                    ? "Restore the file's original line endings and reapply only the intended changes (or normalize this file to its convention)."
                    : "Pre-existing in this file. Do not normalize in this PR unless asked; keep your own lines in the file's dominant style.",
            });
        }
        // 3. convention mismatch for a consistent file
        if ((disk.state === "LF" || disk.state === "CRLF") && !conv.conflict && conv.expected && disk.state.toLowerCase() !== conv.expected) {
            const histAgreesConfig = established === conv.expected;
            const histAgreesFile = established === disk.state.toLowerCase();
            if (histAgreesFile && baseEol) {
                fileFindings.push({
                    file: rel, category: "REPOSITORY_CONFIGURATION", finding: "CONFIG_DISAGREES_WITH_FILE_HISTORY", classification: "REPOSITORY_CONFIGURATION_ISSUE", severity: "MEDIUM",
                    evidence: `${rel} is consistently ${disk.state} and was ${baseEol.state} at base, but ${conv.expected_source} expects ${conv.expected.toUpperCase()}`,
                    expected: `${conv.expected.toUpperCase()} (${conv.expected_source})`, actual: `${disk.state} (unchanged by this PR)`,
                    recommendation: "Repository configuration and existing files disagree. Reported, not resolved: decide the convention (and normalize in its own commit), do not change it as a side effect of this PR.",
                });
            }
            else {
                if (!fr.classifications.includes("LINE_ENDING_CHANGE") && histAgreesConfig && churn && churn.eol > 0)
                    fr.classifications.push("LINE_ENDING_CHANGE");
                fileFindings.push({
                    file: rel, category: "LINE_ENDING", finding: "LINE_ENDING_CONVENTION_MISMATCH", classification: "LINE_ENDING_CHANGE", severity: "MEDIUM",
                    evidence: `${rel} is ${disk.state}; ${conv.expected_source} expects ${conv.expected.toUpperCase()}` + (baseEol ? `; base was ${baseEol.state}` : "; new file"),
                    expected: `${conv.expected.toUpperCase()} (${conv.expected_source})`, actual: disk.state,
                    recommendation: `Use ${conv.expected.toUpperCase()} for this file, as configured.`,
                });
            }
        }
        if (conv.conflict) {
            fileFindings.push({
                file: rel, category: "REPOSITORY_CONFIGURATION", finding: "CONVENTION_SOURCES_DISAGREE", classification: "REPOSITORY_CONFIGURATION_ISSUE", severity: "MEDIUM",
                evidence: conv.explicit.map((e) => `${e.source} → ${e.eol.toUpperCase()}`).join("; "),
                expected: "one agreed line-ending convention", actual: `conflicting configuration for ${rel}`,
                recommendation: "Reported, not resolved: reconcile these settings. Until then keep the file in its existing style.",
            });
        }
        // 4. diff noise
        if (churn && churn.raw > 0) {
            const noise = churn.raw - churn.semantic;
            const disproportionate = churn.raw >= THRESHOLDS.MIN_CHURN && churn.semantic <= THRESHOLDS.SEMANTIC_RATIO * churn.raw;
            const comps = [["eol", churn.eol], ["trailing", churn.trailing_ws], ["whitespace", churn.whitespace], ["blank", churn.blank_lines]];
            comps.sort((a, b) => b[1] - a[1]);
            const cause = comps[0][1] > 0 ? comps[0][0] : null;
            const summary = `${rel}: ${churn.raw} lines changed in the committed diff, ${churn.semantic} after ignoring line endings/whitespace` +
                ` (line endings ${churn.eol}, trailing whitespace ${churn.trailing_ws}, other whitespace ${churn.whitespace}, blank lines ${churn.blank_lines})`;
            const restore = "Restore the original file style/line endings and reapply only the intended changes.";
            if (cause && (disproportionate || (noise >= THRESHOLDS.MINOR_NOISE && noise >= churn.semantic) || churn.semantic === 0)) {
                const pure = churn.semantic === 0;
                const isEol = cause === "eol";
                let sev = disproportionate ? "HIGH" : pure ? "MEDIUM" : "LOW";
                let name = isEol ? "LINE_ENDING_CHANGE" : "WHITESPACE_CHURN";
                let rec = restore;
                if (configChanged && (isEol || pure)) {
                    sev = "INFO";
                    name = isEol ? "LINE_ENDING_NORMALIZATION" : "WHITESPACE_NORMALIZATION";
                    rec = "This PR also changes formatting configuration, so this looks intentional. Put normalization in its own commit, apart from functional changes.";
                }
                fr.classifications.push(isEol ? "LINE_ENDING_CHANGE" : "WHITESPACE_CHANGE");
                const before = baseEol ? describeEol(baseEol) : "n/a";
                fileFindings.push({
                    file: rel, category: isEol ? "LINE_ENDING" : "WHITESPACE", finding: name, classification: isEol ? "LINE_ENDING_CHANGE" : "WHITESPACE_CHANGE", severity: sev,
                    evidence: summary + (isEol ? `; base ${before} → now ${describeEol(disk)}` : ""),
                    expected: `a diff limited to the intended change (${churn.semantic} line${churn.semantic === 1 ? "" : "s"})`,
                    actual: `${churn.raw} changed lines${pure ? ", none of them functional" : ""}`,
                    recommendation: rec,
                });
            }
            else if (!cause && baseBuf && churn.semantic >= THRESHOLDS.MIN_CHURN && baseBuf.length <= THRESHOLDS.MAX_BYTES) {
                const delta = tokenDelta(baseBuf.toString("utf-8"), buf.toString("utf-8"));
                if (delta <= THRESHOLDS.FORMAT_TOKEN_DELTA) {
                    fr.classifications.push("FORMAT_REWRITE");
                    fileFindings.push({
                        file: rel, category: "FORMATTING", finding: "FORMAT_REWRITE", classification: "FORMAT_REWRITE", severity: configChanged ? "INFO" : "HIGH",
                        evidence: `${rel}: ${churn.semantic} lines changed but only ${(delta * 100).toFixed(1)}% of tokens differ (code re-wrapped/re-laid-out, not changed)`,
                        expected: "only the intended change", actual: "formatter-style rewrite of existing code",
                        recommendation: configChanged ? "Looks tied to a formatting-config change; keep it in a separate commit." : restore,
                    });
                }
            }
        }
        // 5. encoding, EOF newline, mode
        if (baseBuf) {
            const b0 = bomOf(baseBuf), b1 = bomOf(buf);
            const u8old = validUtf8(baseBuf), u8new = validUtf8(buf);
            if (b0 !== b1 || (u8old && !u8new)) {
                fr.classifications.push("ENCODING_CHANGE");
                fileFindings.push({
                    file: rel, category: "ENCODING", finding: "ENCODING_CHANGE", classification: "ENCODING_CHANGE", severity: !u8new && u8old ? "HIGH" : "MEDIUM",
                    evidence: `${rel}: BOM ${b0 ?? "none"} → ${b1 ?? "none"}; valid UTF-8 ${u8old} → ${u8new}`,
                    expected: "same encoding/BOM as before", actual: "encoding changed",
                    recommendation: "Restore the original encoding/BOM unless this change is deliberate.",
                });
            }
            const endNl = (x) => x.length > 0 && x[x.length - 1] === 10;
            if (baseBuf.length > 0 && buf.length > 0 && endNl(baseBuf) !== endNl(buf)) {
                fileFindings.push({
                    file: rel, category: "WHITESPACE", finding: "EOF_NEWLINE_CHANGE", classification: "WHITESPACE_CHANGE", severity: "LOW",
                    evidence: `${rel}: final newline ${endNl(baseBuf) ? "present" : "absent"} → ${endNl(buf) ? "present" : "absent"}`,
                    expected: "end-of-file newline unchanged", actual: "changed",
                    recommendation: "Keep the file's original end-of-file convention unless asked to change it.",
                });
            }
        }
        if (top && baseBuf) {
            const raw = git(top, ["diff", "-M", "--raw", base, "--", ...(c.old ? [c.old, rel] : [rel])]) ?? "";
            const m = /^:(\d{6}) (\d{6}) /m.exec(raw);
            if (m && m[1] !== m[2]) {
                fr.classifications.push("FILE_MODE_CHANGE");
                const lostExec = m[1] === "100755" && m[2] === "100644";
                fileFindings.push({
                    file: rel, category: "FILE_MODE", finding: "FILE_MODE_CHANGE", classification: "FILE_MODE_CHANGE", severity: lostExec && /\.(sh|bash)$/.test(rel) ? "MEDIUM" : "LOW",
                    evidence: `${rel}: mode ${m[1]} → ${m[2]}`, expected: "mode unchanged", actual: `${m[2]}`,
                    recommendation: "Revert the mode change unless deliberate (common on Windows checkouts).",
                });
            }
        }
        const onlyCode = !fr.classifications.some((x) => x !== "CODE_CHANGE");
        if (fileFindings.length === 0 && onlyCode)
            fr.classifications.push("NORMAL");
        if (fr.classifications.length === 0)
            fr.classifications.push("NORMAL");
        for (const f of fileFindings)
            add(f);
    }
    // dedupe repository-wide configuration problems
    const dedupKinds = new Set(["CONFIG_DISAGREES_WITH_FILE_HISTORY", "LINE_ENDING_CONVENTION_MISMATCH", "CONVENTION_SOURCES_DISAGREE"]);
    const groups = new Map();
    const kept = [];
    for (const f of findings) {
        if (!dedupKinds.has(f.finding)) {
            kept.push(f);
            continue;
        }
        const key = [f.finding, f.expected, f.actual.replace(/ \(unchanged by this PR\)/, "")].join("|");
        groups.set(key, [...(groups.get(key) ?? []), f]);
    }
    for (const g of groups.values()) {
        if (g.length >= THRESHOLDS.DEDUP_MIN) {
            const first = g[0];
            kept.push({
                ...first, file: `(${g.length} files)`, files: g.map((x) => x.file),
                evidence: `${g.length} files share this: ${first.evidence.replace(/^[^:]+: ?/, "")}. Files: ${g.slice(0, 10).map((x) => x.file).join(", ")}${g.length > 10 ? ", ..." : ""}`,
                recommendation: first.recommendation + " (Reported once for all affected files.)",
            });
        }
        else
            kept.push(...g);
    }
    kept.sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || a.file.localeCompare(b.file));
    kept.forEach((f, i) => { f.id = `DQ-${i + 1}`; });
    report.findings = kept;
    report.max_severity = kept.length ? kept[0].severity : null;
    return report;
}
/** Marks findings the user has explicitly accepted. Requires the user's own words. */
export function applyAcknowledgements(findings, acks = []) {
    for (const f of findings) {
        const hit = acks.find((a) => a.finding === f.finding && a.user_statement?.trim() &&
            (a.file === f.file || (f.files ?? []).includes(a.file) || a.file === "*"));
        if (hit)
            f.acknowledged = true;
    }
    return findings;
}
export function blockingFindings(findings) {
    return findings.filter((f) => f.severity === "HIGH" && !f.acknowledged);
}
/** Findings in the same block shape /sfn-review uses for every other pass. */
export function renderFindingBlocks(report) {
    if (report.findings.length === 0) {
        return `PASS 10 — no diff-quality findings. ${report.files_analyzed} file(s) analyzed against base ${report.base ?? "n/a"}.`;
    }
    return report.findings.map((f, i) => {
        const letter = String.fromCharCode(65 + (i % 26));
        return [
            `FINDING 10${letter} — ${f.category}: ${f.finding}${f.acknowledged ? " (acknowledged by user)" : ""}`,
            `   File: ${f.file}`,
            `   Evidence: ${f.evidence}`,
            `   Expected: ${f.expected}`,
            `   Actual: ${f.actual}`,
            `   Fix: ${f.recommendation}`,
            `   Severity: ${f.review_severity} (${f.severity})`,
        ].join("\n");
    }).join("\n\n");
}
