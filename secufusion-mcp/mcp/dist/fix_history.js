/**
 * Fix history: was this area fixed before? (the deterministic half of the regression check)
 *
 * For a file (and optionally a line range) this asks git for the commits that touched it, keeps the ones that look like
 * bug fixes or guard changes, and also searches the team's own memory (.rejected-patterns.json and the task decisions) for
 * entries about the same file or keywords. Language-neutral: it only needs git. READ-ONLY, and git is run with an
 * argument array, never through a shell.
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
const FIX = /\b(fix(?:es|ed)?|guard|resolve[sd]?|block(?:s|ed)?|prevent(?:s|ed)?|revert(?:s|ed)?|hotfix|regression|bug|leak|security|patch(?:es|ed)?)\b/gi;
const WI = /\b(?:WI|TASK|BUG|STORY|FEATURE|EPIC)[- ]?\d+\b|\b[A-Z]{2,10}-\d+\b/g;
const RS = "\x1e", US = "\x1f";
export function getFixHistory(root, file, o = {}) {
    const rootAbs = path.resolve(root);
    const abs = path.resolve(rootAbs, file);
    if (!(abs === rootAbs || abs.startsWith(rootAbs + path.sep)))
        throw new Error("file is outside the workspace root");
    const rel = path.relative(rootAbs, abs).split(path.sep).join("/");
    const since = o.since ?? "18.months.ago";
    if (!/^[\w. -]{1,40}$/.test(since))
        throw new Error(`unsafe since value: ${since}`);
    const max = Math.max(1, Math.min(o.max_commits ?? 200, 1000));
    const notes = [];
    const fmt = `--format=${RS}%H${US}%aI${US}%s`;
    const args = ["-C", rootAbs, "log", "--no-color", `--since=${since}`, `-n${max}`, fmt];
    if (o.line_range) {
        const [a, b] = o.line_range;
        if (!(Number.isInteger(a) && Number.isInteger(b) && a >= 1 && b >= a))
            throw new Error("line_range must be [start, end] with 1 <= start <= end");
        args.push(`-L${a},${b}:${rel}`);
    }
    else
        args.push("--follow", "--", rel);
    let raw = "";
    try {
        raw = execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    }
    catch (e) {
        notes.push(`git log failed: ${String(e.message).split("\n")[0].slice(0, 160)}. If git is unavailable, fall back to smart_search with the file path and a keyword.`);
    }
    const commits = [];
    let scanned = 0;
    for (const ln of raw.split("\n")) {
        if (!ln.startsWith(RS))
            continue;
        scanned++;
        const [hash, date, ...rest] = ln.slice(1).split(US);
        const subject = rest.join(US);
        const kw = [...new Set([...subject.matchAll(FIX)].map((m) => m[1].toLowerCase()))];
        const wi = [...new Set(subject.match(WI) ?? [])];
        if (kw.length || wi.length)
            commits.push({ hash: hash.slice(0, 10), date: date.slice(0, 10), subject: subject.slice(0, 160), keywords: kw, work_items: wi });
    }
    const needles = [path.basename(rel), ...(o.keywords ?? [])].map((s) => s.toLowerCase()).filter((s) => s.length >= 3);
    const memory = [];
    const scan = (source, data) => {
        const items = Array.isArray(data) ? data : data && typeof data === "object" ? Object.values(data) : [];
        for (const it of items) {
            const s = JSON.stringify(it);
            const l = s.toLowerCase();
            if (needles.some((n) => l.includes(n)) && memory.length < 15)
                memory.push({ source, excerpt: s.slice(0, 220) });
        }
    };
    const readJson = (p) => { try {
        return JSON.parse(fs.readFileSync(p, "utf8"));
    }
    catch {
        return undefined;
    } };
    const rp = readJson(path.join(rootAbs, ".rejected-patterns.json"));
    if (rp)
        scan(".rejected-patterns.json", rp);
    const tasks = path.join(rootAbs, ".secufusion", "tasks");
    if (fs.existsSync(tasks)) {
        for (const d of fs.readdirSync(tasks).slice(0, 400)) {
            const dec = readJson(path.join(tasks, d, "decisions.json"));
            if (dec)
                scan(`.secufusion/tasks/${d}/decisions.json`, dec);
        }
    }
    if (!commits.length && !notes.length)
        notes.push(`no fix-like commit touched ${rel}${o.line_range ? ` lines ${o.line_range.join("-")}` : ""} since ${since}`);
    notes.push("a matching subject is a hint, not proof: read the commit (git show <hash> -- <file>) and check the change still does what the fix made it do");
    return { file: rel, since, line_range: o.line_range, commits_scanned: scanned, fix_commits: commits, memory_matches: memory, notes };
}
export function renderFixHistory(h) {
    const out = [`# Fix history: ${h.file}${h.line_range ? ` lines ${h.line_range.join("-")}` : ""} since ${h.since}`, `${h.commits_scanned} commit(s) scanned · ${h.fix_commits.length} look like fixes`, ""];
    for (const c of h.fix_commits)
        out.push(`${c.hash}  ${c.date}  ${c.subject}${c.work_items.length ? `  [${c.work_items.join(", ")}]` : ""}  (${c.keywords.join(", ") || "work item"})`);
    if (h.memory_matches.length)
        out.push("", "Team memory that mentions this file or the keywords:", ...h.memory_matches.map((m) => `  ${m.source}: ${m.excerpt}`));
    out.push("", ...h.notes.map((n) => `note: ${n}`));
    return out.join("\n");
}
