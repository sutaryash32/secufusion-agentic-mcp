/**
 * Review context discovery: what do we already know before we ask the developer anything?
 *
 * A developer asks for a review and gives no task id, no slug, no requirements, no acceptance criteria. The wrong answer is a
 * questionnaire. The right one is to recover the context from where it already is, say how complete it is, and ask only for
 * what is truly missing. This module does the deterministic half:
 *   discoverReviewContext   inspects the repository (branch, staged, modified and untracked files, the changed modules, commit
 *                           messages), the task folders, specifications, acceptance criteria, decision logs, review history,
 *                           draft contexts from earlier reviews and the project knowledge, and returns a CONTEXT COMPLETENESS
 *                           REPORT with a coverage score, the hints those sources give about the intent (work type, references,
 *                           services), the task folders that may explain the diff (candidates, never adopted silently) and a
 *                           provisional reference for a draft task context.
 *   recordDraftContext      writes the temporary task context: intent, assumptions, constraints, risks, inferred and missing
 *                           requirements, each CONFIRMED (the developer's own words), INFERRED (with its evidence) or UNKNOWN.
 *                           It refuses to store inferred information as confirmed fact.
 * The reasoning (what the developer is trying to do, and why) is the reviewer's; this gives it the evidence and the discipline.
 * Language-neutral. discoverReviewContext is READ-ONLY; recordDraftContext writes only inside .secufusion/tasks/.
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { loadKnowledge, queryKnowledge } from "./project_knowledge.js";
import { routeReview } from "./review_router.js";
import { scanTransitions } from "./feature_model.js";
import { validateEvidence } from "./finding_evidence.js";
import { variantsOf } from "./invariant_enforcement.js";
import { sameTicket, typesConflict } from "./work_item_ref.js";
export const KINDS = ["intent", "assumption", "constraint", "risk", "requirement", "missing", "decision", "acceptance"];
const SKIP_DIR = new Set(["node_modules", "dist", "build", "target", ".git", ".idea", ".vscode", ".secufusion"]);
const MANIFEST = /^(pom\.xml|build\.gradle(\.kts)?|package\.json|go\.mod|pyproject\.toml|requirements\.txt|Gemfile|composer\.json|Cargo\.toml|[^/]+\.csproj)$/;
function git(root, args) {
    try {
        return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    }
    catch {
        return null;
    }
}
const lines = (s) => (s ?? "").split("\n").map((x) => x.trim()).filter(Boolean);
const readJson = (p) => { try {
    return JSON.parse(fs.readFileSync(p, "utf8").replace(/^﻿/, ""));
}
catch {
    return undefined;
} };
function fileStrings(v, out, depth = 0) {
    if (depth > 4 || v === null || v === undefined)
        return;
    if (Array.isArray(v)) {
        for (const x of v)
            fileStrings(x, out, depth + 1);
        return;
    }
    if (typeof v === "object") {
        for (const [k, val] of Object.entries(v)) {
            if (typeof val === "string" && /^(file_path|path|file|filename)$/i.test(k))
                out.add(val.replace(/\\/g, "/"));
            else
                fileStrings(val, out, depth + 1);
        }
    }
}
function classify(files) {
    let fe = 0, be = 0, ext = 0, infra = 0;
    for (const f of files) {
        const p = f.replace(/\\/g, "/");
        if (/(^|\/)(\w*[-_.])?(extn|extension|extensions|browser-ext\w*|chrome-ext\w*)([-_.]\w*)?\//i.test(p) || /(^|\/)manifest\.json$/i.test(p))
            ext++;
        else if (/(^|\/)(Dockerfile[^/]*|docker-compose[^/]*|Jenkinsfile|azure-pipelines[^/]*\.ya?ml)$|\.tf$|(^|\/)(helm|k8s|kubernetes|terraform|\.github\/workflows|ci|deploy)\//i.test(p))
            infra++;
        else if (/\.(jsx|tsx|vue|svelte|css|scss|less|html)$|(^|\/)(web-ui|webui|frontend|front-end|client|ui)\//i.test(p))
            fe++;
        else if (/\.(java|kt|kts|scala|py|go|cs|rb|php|rs|sql|ts|js|mjs|cjs)$/i.test(p))
            be++;
    }
    const parts = [fe && `${fe} frontend`, be && `${be} backend`, ext && `${ext} extension`, infra && `${infra} infrastructure`].filter(Boolean).join(", ");
    if (!fe && !be && !ext && !infra)
        return { prefix: "BE", reason: "no recognisable source files changed: defaulting to backend" };
    if (ext && !fe && !be)
        return { prefix: "EXT", reason: `only extension files changed (${parts})` };
    if (infra && !fe && !be && !ext)
        return { prefix: "INFRA", reason: `only infrastructure files changed (${parts})` };
    if (fe && be)
        return { prefix: "FS", reason: `frontend and backend files changed (${parts})` };
    if (fe && !be)
        return { prefix: "FE", reason: `only frontend files changed (${parts})` };
    return { prefix: "BE", reason: `backend files changed (${parts})` };
}
const TYPE_BRANCH = [[/^hotfix\//i, "Hotfix"], [/^(bugfix|bug|fix)\//i, "Bug Fix"], [/^(feature|feat|story|enhancement)\//i, "Enhancement"], [/^refactor\//i, "Refactor"], [/^(spike|poc|experiment)\//i, "Spike"], [/^(chore|tech-?debt|cleanup)\//i, "Technical Debt"]];
const TYPE_COMMIT = [[/\bhotfix\b/i, "Hotfix"], [/\b(fix|fixes|fixed|bug|regression)\b/i, "Bug Fix"], [/\brefactor\w*\b/i, "Refactor"], [/\b(spike|poc|prototype)\b/i, "Spike"], [/\b(chore|cleanup|tech debt|deprecat\w*|upgrade|bump)\b/i, "Technical Debt"], [/\b(add|adds|added|implement\w*|introduce\w*|support|new|enable\w*)\b/i, "Enhancement"]];
function inferType(branch, subjects) {
    const scores = {};
    const evidence = [];
    if (branch)
        for (const [re, t] of TYPE_BRANCH)
            if (re.test(branch)) {
                scores[t] = (scores[t] ?? 0) + 3;
                evidence.push(`branch ${branch} reads as ${t}`);
                break;
            }
    for (const s of subjects.slice(0, 15))
        for (const [re, t] of TYPE_COMMIT)
            if (re.test(s)) {
                scores[t] = (scores[t] ?? 0) + 1;
                evidence.push(`commit "${s.slice(0, 70)}" reads as ${t}`);
                break;
            }
    const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    return { type: ranked[0]?.[0] ?? null, ambiguous: ranked.length > 1 && ranked[1][1] * 3 >= ranked[0][1], scores, evidence: evidence.slice(0, 8) };
}
function refsIn(text) {
    const out = new Set();
    for (const m of text.matchAll(/\b([A-Z]{2,10})-(\d+)\b/g))
        out.add(`${m[1]}-${m[2]}`);
    for (const m of text.matchAll(/\bWI[ -]?(\d+)\b/gi))
        out.add(`WI-${m[1]}`);
    const b = /^(?:feature|bugfix|bug|hotfix|fix|chore|story|task)\/(\d{3,6})[-_]/i.exec(text);
    if (b)
        out.add(`#${b[1]}`);
    return [...out];
}
function modulesOf(root, files) {
    const mods = new Set();
    for (const f of files) {
        let dir = path.dirname(f).split("/").join(path.sep), found = "";
        while (dir && dir !== ".") {
            if (fs.existsSync(path.join(root, dir, "pom.xml")) || fs.existsSync(path.join(root, dir, "package.json")) || fs.existsSync(path.join(root, dir, "go.mod")) || fs.existsSync(path.join(root, dir, "pyproject.toml"))) {
                found = dir;
                break;
            }
            dir = path.dirname(dir);
        }
        const seg = f.split("/");
        mods.add((found || (seg.length > 1 ? (seg[0] === "src" && seg.length > 2 ? `src/${seg[1]}` : seg[0]) : "(root)")).split(path.sep).join("/"));
    }
    return [...mods].sort();
}
/** Lines the diff adds, with their line numbers in the new file (working tree against the base). */
export function addedLines(root, base) {
    const diff = git(root, ["diff", "--unified=0", "--no-color", "--no-ext-diff", base ?? "HEAD", "--"]) ?? "";
    const out = {};
    let file = "", line = 0;
    for (const raw of diff.split("\n")) {
        const f = /^\+\+\+ (?:b\/(.+)|\/dev\/null)$/.exec(raw);
        if (f) {
            file = f[1] ?? "";
            continue;
        }
        if (raw.startsWith("--- "))
            continue;
        const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
        if (h) {
            line = Number(h[1]);
            continue;
        }
        if (file && raw.startsWith("+")) {
            (out[file] ??= []).length < 400 && out[file].push({ line, text: raw.slice(1) });
            line++;
        }
    }
    return out;
}
const taskRoot = (root) => path.join(root, ".secufusion", "tasks");
const refOfFolder = (f) => /^((?:BE|FE|FS|EXT|INFRA)-TASK-D\d+|[A-Za-z]+-\d+|WI-?\d+)/.exec(f)?.[1] ?? f;
const words = (s) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
/** Mode 1 needs a work item whose task folder holds a specification. Everything else is Mode 2. */
export function selectReviewMode(root, workItem, candidates) {
    const m1 = "Mode 1: Existing Task Review", m2 = "Mode 2: Context Discovery Review";
    const given = (workItem ?? "").trim();
    const tr = taskRoot(root);
    if (given) {
        const folders = fs.existsSync(tr) ? fs.readdirSync(tr).filter((f) => { try {
            return fs.statSync(path.join(tr, f)).isDirectory() && !/^(?:BE|FE|FS|EXT|INFRA)-TASK-D\d+/.test(f);
        }
        catch {
            return false;
        } }) : [];
        const clash = folders.find((f) => typesConflict(refOfFolder(f), given));
        if (clash)
            return { mode: 2, name: "CONTEXT_DISCOVERY", label: m2, ref: given, missing: ["a reference whose type is agreed"], conflict: `you gave ${given} but the task folder is ${clash}: the same number under a different type. Do not choose: ask the developer which one is right`, why: "the reference conflicts with an existing task folder, so no task can be adopted" };
        const folder = folders.find((f) => sameTicket(refOfFolder(f), given));
        if (folder) {
            const files = fs.readdirSync(path.join(tr, folder));
            const spec = readJson(path.join(tr, folder, "spec.json"));
            const ac = Array.isArray(spec?.acceptance_criteria) ? spec.acceptance_criteria.length : 0;
            if (files.includes("spec.md") || files.includes("spec.json")) {
                return { mode: 1, name: "EXISTING_TASK", label: m1, ref: given, task_folder: `.secufusion/tasks/${folder}`, acceptance_criteria: ac, missing: ac ? [] : ["acceptance criteria in the specification"], why: `${given} has a task folder with a specification${ac ? ` and ${ac} acceptance criteria` : ""}: the intent is confirmed and the review is judged against it` };
            }
            return { mode: 2, name: "CONTEXT_DISCOVERY", label: m2, ref: given, task_folder: `.secufusion/tasks/${folder}`, missing: ["specification", "acceptance criteria"], why: `${given} has a task folder but no specification: ${given} is a CONFIRMED reference, everything else is reconstructed and INFERRED` };
        }
        return { mode: 2, name: "CONTEXT_DISCOVERY", label: m2, ref: given, missing: ["task folder", "specification", "acceptance criteria"], why: `${given} names no task folder in this workspace: ${given} is a CONFIRMED reference, everything else is reconstructed and INFERRED` };
    }
    const best = candidates[0];
    const out = { mode: 2, name: "CONTEXT_DISCOVERY", label: m2, missing: ["work item", "specification", "acceptance criteria"], why: "no work item was given: the context is reconstructed from the repository" };
    if (best && best.score >= 40 && best.has_spec)
        out.proposed_switch = { ref: best.ref, folder: best.folder, why: best.reasons.join("; ") };
    return out;
}
export function discoverReviewContext(root, o = {}) {
    const rootAbs = path.resolve(root);
    const notes = [];
    const isGit = git(rootAbs, ["rev-parse", "--is-inside-work-tree"])?.trim() === "true";
    const branch = isGit ? (git(rootAbs, ["branch", "--show-current"])?.trim() || null) : null;
    let base = null;
    if (o.base) {
        if (!/^[\w./~^@{}-]+$/.test(o.base))
            throw new Error(`unsafe base ref: ${o.base}`);
        base = o.base;
    }
    else if (isGit)
        for (const c of ["origin/main", "origin/master", "origin/develop", "main", "master", "develop"]) {
            const mb = git(rootAbs, ["merge-base", "HEAD", c])?.trim();
            if (mb && mb !== git(rootAbs, ["rev-parse", "HEAD"])?.trim()) {
                base = mb;
                break;
            }
        }
    const staged = isGit ? lines(git(rootAbs, ["diff", "--cached", "--name-only", "--no-renames"])) : [];
    const modified = isGit ? lines(git(rootAbs, ["diff", "--name-only", "--no-renames"])) : [];
    const untracked = isGit ? lines(git(rootAbs, ["ls-files", "--others", "--exclude-standard"])) : [];
    const sinceBase = isGit && base ? lines(git(rootAbs, ["diff", "--name-only", "--no-renames", base, "HEAD"])) : [];
    const given = (o.files ?? []).map((f) => f.replace(/\\/g, "/"));
    // the project's own memory and tool state are not the change under review
    const all = [...new Set([...given, ...staged, ...modified, ...untracked, ...sinceBase])].filter((f) => !/^\.(secufusion|mcp|claude|git|idea|vscode)\//.test(f));
    if (!isGit && !given.length)
        notes.push("not a git repository and no files were given: there is nothing to infer the change from");
    const commits = isGit
        ? lines(git(rootAbs, ["log", `-n${Math.min(o.max_commits ?? 30, 100)}`, "--format=%h\x1f%s", ...(base ? [`${base}..HEAD`] : [])])).map((l) => { const [hash, ...s] = l.split("\x1f"); return { hash, subject: s.join(" ") }; })
        : [];
    const subjects = commits.map((c) => c.subject);
    const refs = [];
    for (const r of refsIn(branch ?? ""))
        refs.push({ ref: r, from: "branch" });
    for (const s of subjects)
        for (const r of refsIn(s))
            if (!refs.some((x) => x.ref === r))
                refs.push({ ref: r, from: "commit" });
    const { prefix, reason: prefixReason } = classify(all);
    const workType = inferType(branch, subjects);
    let signals = [];
    try {
        if (all.length)
            signals = routeReview(rootAbs, { files: all }).factors.map((f) => f.signal);
    }
    catch { /* optional */ }
    // ---- task folders: candidates that may explain the diff, and drafts left by earlier reviews
    const candidates = [];
    const drafts = [];
    const tr = taskRoot(rootAbs);
    const intentText = `${branch ?? ""} ${subjects.join(" ")}`;
    const intentWords = new Set(words(intentText));
    let maxDraft = 0;
    if (fs.existsSync(tr)) {
        for (const folder of fs.readdirSync(tr).slice(0, 500)) {
            const dir = path.join(tr, folder);
            let st;
            try {
                st = fs.statSync(dir);
            }
            catch {
                continue;
            }
            if (!st.isDirectory())
                continue;
            const dm = /^(?:BE|FE|FS|EXT|INFRA)-TASK-D(\d+)/.exec(folder);
            if (dm)
                maxDraft = Math.max(maxDraft, Number(dm[1]));
            const touched = new Set();
            const draft = readJson(path.join(dir, "context.draft.json"));
            if (draft)
                (draft.files ?? []).forEach((f) => touched.add(String(f).replace(/\\/g, "/")));
            fileStrings(readJson(path.join(dir, "files-touched.json")), touched);
            const overlap = all.length ? [...touched].filter((t) => all.some((a) => a === t || a.endsWith("/" + t) || t.endsWith("/" + a))).length / Math.max(1, Math.min(all.length, touched.size || all.length)) : 0;
            if (draft) {
                const es = draft.entries ?? [];
                drafts.push({ folder, ref: refOfFolder(folder), title: draft.title ?? folder, overlap: Math.round(overlap * 100) / 100, entries: es.length, confirmed: es.filter((e) => e.status === "CONFIRMED").length, inferred: es.filter((e) => e.status === "INFERRED").length, unknown: es.filter((e) => e.status === "UNKNOWN").length, confidence_log: draft.confidence_log });
                continue;
            }
            const ref = refOfFolder(folder);
            const reasons = [];
            let score = 0;
            if (refs.some((r) => r.ref.toLowerCase() === ref.toLowerCase() || r.ref.replace(/\D/g, "") === ref.replace(/\D/g, "") && /\d{3,}/.test(ref))) {
                score += 50;
                reasons.push(`its reference ${ref} appears in the ${refs.find((r) => r.ref.replace(/\D/g, "") === ref.replace(/\D/g, ""))?.from ?? "branch"} name or commit messages`);
            }
            if (overlap > 0) {
                score += Math.round(30 * overlap);
                reasons.push(`${Math.round(overlap * 100)}% of its recorded files are in this change`);
            }
            const slugHit = words(folder).filter((w) => intentWords.has(w));
            if (slugHit.length) {
                score += Math.min(10, slugHit.length * 4);
                reasons.push(`its name shares ${slugHit.join(", ")} with the branch or commits`);
            }
            const spec = readJson(path.join(dir, "spec.json"));
            const dec = readJson(path.join(dir, "decisions.json"));
            const decCount = Array.isArray(dec) ? dec.length : dec && typeof dec === "object" ? Object.keys(dec).length : 0;
            const files = fs.readdirSync(dir);
            if (score > 0)
                candidates.push({
                    folder, ref, score: Math.min(100, score), reasons, overlap: Math.round(overlap * 100) / 100,
                    has_spec: files.includes("spec.md") || files.includes("spec.json"), acceptance_criteria: Array.isArray(spec?.acceptance_criteria) ? spec.acceptance_criteria.length : 0,
                    decisions: decCount, has_review: files.some((f) => /review/i.test(f)),
                });
        }
    }
    candidates.sort((a, b) => b.score - a.score);
    drafts.sort((a, b) => b.overlap - a.overlap);
    // ---- project knowledge
    const knowledge = [];
    const leads = { knowledge: [], fields_touched: [], entities: [], transitions_touched: [] };
    try {
        const model = loadKnowledge(rootAbs);
        if (model.exists && (all.length || subjects.length)) {
            const terms = [...new Set([...words(intentText), ...modulesOf(rootAbs, all).flatMap(words)])].slice(0, 30);
            for (const s of queryKnowledge(model.entries, { terms, files: all, limit: 12 })) {
                knowledge.push({ id: s.entry.id, category: s.entry.category, status: s.entry.status });
                leads.knowledge.push({ id: s.entry.id, category: s.entry.category, status: s.entry.status, title: s.entry.title, file: s.entry.file, why: s.why, excerpt: s.entry.body.replace(/\s+/g, " ").slice(0, 400) });
            }
            // the authority and invariant fields the project recorded: does this diff write any of them?
            const fieldOwners = new Map();
            for (const e of model.entries) {
                if (e.status === "superseded" || e.status === "deprecated")
                    continue;
                const f = e.extra?.fields;
                const list = Array.isArray(f) ? f : typeof f === "string" ? f.split(/[,\s]+/) : [];
                for (const x of list.filter((y) => y.length >= 3))
                    fieldOwners.set(x, e.id);
            }
            if (fieldOwners.size && all.length) {
                const added = addedLines(rootAbs, base);
                for (const [file, ls] of Object.entries(added)) {
                    for (const [field, inv] of fieldOwners) {
                        const toks = variantsOf(field).map((v) => v.toLowerCase());
                        for (const l of ls)
                            if (leads.fields_touched.length < 40 && toks.some((tk) => l.text.toLowerCase().includes(tk)))
                                leads.fields_touched.push({ field, invariant: inv, file, line: l.line, text: l.text.trim().slice(0, 140) });
                    }
                }
            }
        }
        else if (!model.exists)
            notes.push("no .mcp/ project knowledge exists");
    }
    catch { /* optional */ }
    // ---- the product's view of the diff: entities it touches and the lifecycle paths inside them
    leads.entities = [...new Set(all.filter((f) => /\.(java|kt|scala|cs|py|go|rb|php|ts|js)$/i.test(f)).map((f) => path.basename(f).replace(/\.[^.]+$/, "").replace(/(Service|Controller|Repository|Repo|Dao|Handler|Manager|Impl|Dto|Entity|Mapper|Resolver|Facade|Client|Test|Tests)$/i, "")).filter((n) => n.length >= 3 && /^[A-Z]/.test(n)))].slice(0, 6);
    if (leads.entities.length && all.length <= 400) {
        try {
            const flags = [...new Set(leads.fields_touched.map((f) => f.field))];
            const { rows } = scanTransitions(rootAbs, leads.entities, flags);
            for (const r of rows)
                for (const s of r.sites)
                    if (all.some((f) => f === s.file || f.endsWith("/" + s.file) || s.file.endsWith("/" + f)))
                        leads.transitions_touched.push({ entity: r.entity, transition: r.transition, file: s.file, line: s.line, method: s.method, unguarded: r.unguarded.some((u) => u.file === s.file && u.line === s.line) });
            leads.transitions_touched = leads.transitions_touched.slice(0, 30);
        }
        catch { /* optional */ }
    }
    // ---- coverage
    const best = candidates[0];
    const draftHit = drafts.find((d) => d.overlap >= 0.5);
    const taskFound = !!best && best.score >= 40;
    const hasAc = (taskFound && best.acceptance_criteria > 0) || !!draftHit && draftHit.confirmed > 0;
    const hasDecisions = (taskFound && best.decisions > 0) || knowledge.some((k) => (k.category === "decisions" || k.category === "adr") && k.status === "accepted");
    const sources = [
        { id: "files", label: "Changed files (staged, modified, untracked)", weight: 10, found: all.length > 0, detail: all.length ? `${staged.length} staged, ${modified.length} modified, ${untracked.length} untracked${sinceBase.length ? `, ${sinceBase.length} committed since ${base?.slice(0, 8)}` : ""}` : "nothing changed was found" },
        { id: "branch", label: "Branch name", weight: 5, found: !!branch && (refs.some((r) => r.from === "branch") || TYPE_BRANCH.some(([re]) => re.test(branch)) || words(branch).length >= 2), detail: branch ? `${branch}${refs.some((r) => r.from === "branch") ? ` (reference ${refs.filter((r) => r.from === "branch").map((r) => r.ref).join(", ")})` : ""}` : "no branch (detached or not a git repository)" },
        { id: "commits", label: "Commit messages", weight: 10, found: subjects.some((s) => s.split(/\s+/).length >= 3), detail: commits.length ? `${commits.length} commit(s): "${subjects[0]?.slice(0, 70)}"` : "no commits beyond the base" },
        { id: "task", label: "Task context", weight: 20, found: taskFound || !!draftHit, detail: taskFound ? `${best.folder} (score ${best.score})` : draftHit ? `draft ${draftHit.folder} from an earlier review` : best ? `weak candidate ${best.folder} (score ${best.score}): not adopted` : "no task folder matches this change" },
        { id: "acceptance", label: "Acceptance criteria", weight: 20, found: hasAc, detail: hasAc ? (taskFound ? `${best.acceptance_criteria} in ${best.folder}` : `${draftHit.confirmed} confirmed in ${draftHit.folder}`) : "none found" },
        { id: "requirements", label: "Requirements / specification", weight: 10, found: (taskFound && best.has_spec) || !!draftHit, detail: taskFound && best.has_spec ? `spec in ${best.folder}` : draftHit ? "a draft context records the intent" : "none found" },
        { id: "decisions", label: "Design decisions", weight: 15, found: hasDecisions, detail: hasDecisions ? (taskFound && best.decisions > 0 ? `${best.decisions} in ${best.folder}` : "accepted decisions in .mcp/ apply") : "none found" },
        { id: "review", label: "Review history", weight: 5, found: (taskFound && best.has_review) || !!draftHit, detail: taskFound && best.has_review ? `earlier review in ${best.folder}` : draftHit ? "an earlier review left a draft context" : "no earlier review" },
        { id: "knowledge", label: "Project knowledge (.mcp/)", weight: 5, found: knowledge.length > 0, detail: knowledge.length ? `${knowledge.length} relevant entr${knowledge.length === 1 ? "y" : "ies"}: ${knowledge.slice(0, 3).map((k) => k.id).join(", ")}` : "nothing relevant" },
    ];
    const coverage = sources.filter((s) => s.found).reduce((n, s) => n + s.weight, 0);
    if (candidates.length && !taskFound)
        notes.push(`task folder ${best.folder} is only a weak candidate (${best.reasons.join("; ")}): read it, but do not adopt it as the story unless it explains the diff`);
    if (taskFound)
        notes.push(`task folder ${best.folder} looks like the story for this change (${best.reasons.join("; ")}): confirm that it explains the diff before using its specification`);
    notes.push("a coverage score says how much context EXISTS, not how well the change is understood: the intent is still your inference until the developer confirms it");
    const mode = selectReviewMode(rootAbs, o.work_item, candidates);
    notes.unshift(`${mode.label}: ${mode.why}`);
    return {
        mode, root: rootAbs, is_git: isGit, branch, base,
        files: { staged, modified, untracked, since_base: sinceBase, all },
        modules: modulesOf(rootAbs, all), commits, refs, work_type: workType, signals,
        prefix, prefix_reason: prefixReason, candidates: candidates.slice(0, 5), drafts: drafts.slice(0, 5), knowledge, product: leads, sources, coverage,
        next_draft_ref: `${prefix}-TASK-D${String(maxDraft + 1).padStart(3, "0")}`, notes,
    };
}
export function renderContext(c) {
    const out = [`# ${c.mode.label}`, c.mode.why, ...(c.mode.conflict ? ["", `IDENTITY CONFLICT: ${c.mode.conflict}`] : []), ...(c.mode.proposed_switch ? ["", `Proposed switch to Mode 1: ${c.mode.proposed_switch.ref} (${c.mode.proposed_switch.folder}): ${c.mode.proposed_switch.why}. Never adopted silently: ask the developer to confirm or correct.`] : []), ...(c.mode.missing.length ? ["", `Missing for Mode 1: ${c.mode.missing.join(", ")}`] : []), "", "# Context completeness report", "No question has been asked yet.", "", "Context sources found:"];
    for (const s of c.sources)
        out.push(`  ${s.found ? "✓" : "✗"} ${s.label} (${s.weight}) — ${s.detail}`);
    out.push("", `Coverage score: ${c.coverage}%`, "");
    out.push(`Branch: ${c.branch ?? "(none)"}   Base: ${c.base ? c.base.slice(0, 10) : "(none)"}   Changed modules: ${c.modules.join(", ") || "(none)"}`);
    out.push(`References seen: ${c.refs.map((r) => `${r.ref} (${r.from})`).join(", ") || "none"}`);
    out.push(`Work type hint: ${c.work_type.type ?? "none"}${c.work_type.ambiguous ? " (AMBIGUOUS: " + Object.entries(c.work_type.scores).map(([k, v]) => `${k} ${v}`).join(", ") + ")" : ""}`, ...c.work_type.evidence.slice(0, 4).map((e) => `    ${e}`));
    out.push(`Change signals: ${c.signals.join(", ") || "none"}`);
    out.push(`Task type for a draft: ${c.prefix} — ${c.prefix_reason}`);
    if (c.candidates.length) {
        out.push("", "Task folders that may explain the diff (candidates, NOT adopted):");
        for (const t of c.candidates)
            out.push(`  ${t.ref}  score ${t.score}  ${t.folder}`, ...t.reasons.map((r) => `      ${r}`), `      spec ${t.has_spec ? "yes" : "no"}, acceptance criteria ${t.acceptance_criteria}, decisions ${t.decisions}, review ${t.has_review ? "yes" : "no"}`);
    }
    if (c.drafts.length) {
        out.push("", "Draft contexts from earlier reviews:");
        for (const d of c.drafts)
            out.push(`  ${d.ref}  ${d.title}  overlap ${Math.round(d.overlap * 100)}%  (${d.confirmed} confirmed, ${d.inferred} inferred, ${d.unknown} unknown)  ${d.folder}`);
    }
    if (c.knowledge.length)
        out.push("", "Relevant project knowledge:", ...c.knowledge.map((k) => `  ${k.id} (${k.category}, ${k.status})`));
    const pl = c.product;
    if (pl.fields_touched.length || pl.transitions_touched.length || pl.knowledge.length) {
        out.push("", "What the product says about this diff:");
        for (const k of pl.knowledge.slice(0, 6))
            out.push(`  ${k.category} ${k.id} (${k.status}): ${k.title}  [${k.why.join("; ")}]`);
        for (const f of pl.fields_touched.slice(0, 6))
            out.push(`  writes ${f.field} (invariant ${f.invariant}) at ${f.file}:${f.line}: ${f.text}`);
        for (const x of pl.transitions_touched.slice(0, 8))
            out.push(`  lifecycle ${x.entity}.${x.transition} at ${x.file}:${x.line} (${x.method})${x.unguarded ? " — never mentions the invariant fields" : ""}`);
    }
    for (const d of c.drafts)
        if (d.confidence_log?.length)
            out.push("", `Confidence progression of ${d.ref}: ${d.confidence_log.map((e) => `${e.stage} ${e.intent}%`).join(" → ")}`);
    out.push("", `Provisional reference for a new draft context: ${c.next_draft_ref}`, "", ...c.notes.map((n) => `note: ${n}`));
    return out.join("\n");
}
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "work";
export function validateEntries(entries) {
    const problems = [];
    entries.forEach((e, i) => {
        const at = `entry ${i + 1} (${e.kind}: "${(e.text ?? "").slice(0, 50)}")`;
        if (!KINDS.includes(e.kind))
            problems.push(`${at}: kind must be one of ${KINDS.join(", ")}`);
        if (!e.text || e.text.trim().length < 5)
            problems.push(`${at}: text is required`);
        if (!["CONFIRMED", "INFERRED", "UNKNOWN"].includes(e.status))
            problems.push(`${at}: status must be CONFIRMED, INFERRED or UNKNOWN`);
        if (e.status === "CONFIRMED" && (e.confirmed_by ?? "").trim().length < 3)
            problems.push(`${at}: CONFIRMED needs confirmed_by, the developer's own words. Inferred information is never stored as confirmed fact: mark it INFERRED with its source`);
        if (e.status === "INFERRED" && (e.source ?? "").trim().length < 3)
            problems.push(`${at}: INFERRED needs source, the evidence it was inferred from (file:line, commit, branch, task folder)`);
        if (e.kind === "missing" && e.status !== "UNKNOWN")
            problems.push(`${at}: a missing requirement is UNKNOWN by definition`);
    });
    return problems;
}
function renderDraftMd(d) {
    const list = (xs) => (xs?.length ? xs.map((x) => `- ${x}`).join("\n") : "- (none recorded)");
    const by = (s) => d.entries.filter((e) => e.status === s);
    const fmt = (e) => `- [${e.kind}] ${e.text}${e.status === "CONFIRMED" ? ` — confirmed by: "${e.confirmed_by}"` : e.status === "INFERRED" ? ` — inferred from: ${e.source}` : ""}`;
    return [
        `# ${d.ref}: ${d.title}`, "",
        "> DRAFT task context. The reference is provisional (it is not a work item) and nothing here is confirmed unless it says so." + (d.linked_ref ? ` Linked to the real reference ${d.linked_ref}: use that one.` : ""), "",
        d.branch ? `Branch: ${d.branch}` : "", d.files?.length ? `Files: ${d.files.slice(0, 20).join(", ")}${d.files.length > 20 ? ", …" : ""}` : "", "",
        "## Task Summary", d.summary?.task_summary ?? "(not yet written)", "",
        "## Business Intent", d.summary?.business_intent ?? "(not yet written)", "",
        "## Architecture Impact", d.summary?.architecture_impact ?? "(not yet written)", "",
        "## Known Risks", list(d.summary?.known_risks), "",
        "## Review Findings", list(d.summary?.review_findings), "",
        "## Open Questions", list(d.summary?.open_questions), "",
        "## Follow-up Recommendations", list(d.summary?.follow_ups), "",
        "## Confidence progression", (d.confidence_log?.length ? d.confidence_log.map((e) => `- ${e.at.slice(0, 16)} ${e.stage}: intent ${e.intent}%${e.coverage !== undefined ? `, coverage ${e.coverage}%` : ""}${e.note ? ` (${e.note})` : ""}`).join("\n") + (d.confidence_log.length > 1 ? `\n- change: ${d.confidence_log[d.confidence_log.length - 1].intent - d.confidence_log[0].intent >= 0 ? "+" : ""}${d.confidence_log[d.confidence_log.length - 1].intent - d.confidence_log[0].intent} points from the first estimate` : "") : "- (not recorded)"), "",
        "## Context entries", "", "### CONFIRMED", by("CONFIRMED").map(fmt).join("\n") || "- (none)", "", "### INFERRED", by("INFERRED").map(fmt).join("\n") || "- (none)", "", "### UNKNOWN", by("UNKNOWN").map(fmt).join("\n") || "- (none)", "",
    ].filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}
export function recordDraftContext(root, input, apply) {
    const rootAbs = path.resolve(root);
    const problems = validateEntries(input.entries);
    if (problems.length)
        throw new Error(`the draft was not stored:\n- ${problems.join("\n- ")}`);
    if (!input.title || input.title.trim().length < 3)
        throw new Error("title is required");
    const tr = taskRoot(rootAbs);
    let ref = input.ref;
    if (ref) {
        if (!/^(?:BE|FE|FS|EXT|INFRA)-TASK-D\d{3,}$/.test(ref))
            throw new Error(`a draft reference looks like BE-TASK-D001 (BE, FE, FS, EXT or INFRA), got ${JSON.stringify(ref)}. A real work-item reference is never used for a draft`);
    }
    else {
        if (!input.prefix)
            throw new Error("pass prefix (BE, FE, FS, EXT or INFRA) or an existing draft ref");
        let max = 0;
        if (fs.existsSync(tr))
            for (const f of fs.readdirSync(tr)) {
                const m = /^(?:BE|FE|FS|EXT|INFRA)-TASK-D(\d+)/.exec(f);
                if (m)
                    max = Math.max(max, Number(m[1]));
            }
        ref = `${input.prefix}-TASK-D${String(max + 1).padStart(3, "0")}`;
    }
    // an existing draft with this ref keeps its folder; a new one is named from the ref and the title
    let folder = fs.existsSync(tr) ? fs.readdirSync(tr).find((f) => f === ref || f.startsWith(`${ref}-draft-`)) : undefined;
    folder ??= `${ref}-draft-${slug(input.title)}`;
    const dir = path.join(tr, folder);
    if (!(dir.startsWith(tr + path.sep)))
        throw new Error("the draft folder resolves outside .secufusion/tasks");
    const jsonPath = path.join(dir, "context.draft.json");
    const prev = readJson(jsonPath);
    // merge: the same text keeps its place, and only a stronger status replaces a weaker one
    const rank = { UNKNOWN: 0, INFERRED: 1, CONFIRMED: 2 };
    const merged = new Map();
    for (const e of [...(prev?.entries ?? []), ...input.entries]) {
        const k = `${e.kind}|${e.text.trim().toLowerCase()}`;
        const old = merged.get(k);
        if (!old || rank[e.status] >= rank[old.status])
            merged.set(k, { ...e, text: e.text.trim() });
    }
    const entries = [...merged.values()];
    const counts = { CONFIRMED: 0, INFERRED: 0, UNKNOWN: 0 };
    entries.forEach((e) => counts[e.status]++);
    const confidence_log = [...(prev?.confidence_log ?? [])];
    if (input.confidence) {
        const n = Math.round(input.confidence.intent);
        if (!(n >= 0 && n <= 100))
            throw new Error("confidence.intent must be 0 to 100");
        confidence_log.push({ stage: input.confidence.stage, intent: n, coverage: input.confidence.coverage, note: input.confidence.note, at: new Date().toISOString() });
    }
    const data = {
        schema: 1, synthetic: true, status: "DRAFT", ref, title: input.title.trim(), created: prev?.created ?? new Date().toISOString(), updated: new Date().toISOString(),
        branch: input.branch, base: input.base, files: [...new Set([...(prev?.files ?? []), ...(input.files ?? [])])], linked_ref: input.linked_ref, confidence_log, entries, summary: { ...(prev?.summary ?? {}), ...(input.summary ?? {}) },
    };
    const md = renderDraftMd({ ref, title: data.title, entries, summary: data.summary, linked_ref: input.linked_ref, branch: input.branch, files: data.files, confidence_log });
    const mdPath = path.join(dir, "context.draft.md");
    if (apply) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));
        fs.writeFileSync(mdPath, md);
    }
    return { ref, folder: path.relative(rootAbs, dir).split(path.sep).join("/"), json: path.relative(rootAbs, jsonPath).split(path.sep).join("/"), md: path.relative(rootAbs, mdPath).split(path.sep).join("/"), written: apply, entries: entries.length, counts, preview: md, progression: confidence_log };
}
export function assessIntent(root, v) {
    const notes = [];
    const per = new Map();
    for (const h of v.hypotheses) {
        const sup = h.supports ?? [], con = h.contradicts ?? [];
        const checked = validateEvidence(root, [...sup.map((c, i) => ({ id: `s${i}`, ...c })), ...con.map((c, i) => ({ id: `c${i}`, ...c }))]);
        const ok = (id) => checked.results.find((r) => r.id === id)?.action === "KEEP";
        const vs = sup.filter((_, i) => ok(`s${i}`)).length, vc = con.filter((_, i) => ok(`c${i}`)).length;
        const claimed = Math.max(0, Math.min(100, Math.round(h.confidence)));
        let verified = claimed;
        // a hypothesis nothing in the code supports is a guess, however sure it sounds
        if (vs === 0)
            verified = Math.min(verified, 40);
        verified = Math.max(0, verified - 25 * vc);
        per.set(h.id, { claimed, verified, vs, unsupported: sup.length - vs, vc });
        if (sup.length - vs > 0)
            notes.push(`${h.id}: ${sup.length - vs} cited support(s) are not in the code and were discarded`);
        if (vs === 0)
            notes.push(`${h.id}: no verified supporting evidence, so its confidence is capped at 40`);
    }
    const lead = v.hypotheses.find((h) => h.id === v.leading) ?? v.hypotheses[0];
    const lp = lead ? per.get(lead.id) : undefined;
    const others = v.hypotheses.filter((h) => h !== lead).map((h) => ({ id: h.id, verified: per.get(h.id).verified })).sort((a, b) => b.verified - a.verified);
    const ru = others[0] ?? null;
    const ambiguous = !!lp && !!ru && ru.verified >= lp.verified - 10;
    let confidence = lp ? lp.verified : 0;
    if (ambiguous) {
        confidence = Math.max(0, confidence - 10);
        notes.push(`the runner-up ${ru.id} is within 10 points of the leading hypothesis: the intent is genuinely ambiguous`);
    }
    if (v.hypotheses.length < 2)
        notes.push("only one hypothesis was considered: the first plausible reading is not an investigation");
    if (v.confidence > confidence + 15)
        notes.push(`the model claimed ${Math.round(v.confidence)}% but the evidence supports ${confidence}%: the lower number is used`);
    const level = confidence >= 80 ? "HIGH" : confidence >= 50 ? "MEDIUM" : "LOW";
    const action = level === "HIGH" ? "PROCEED" : level === "MEDIUM" ? "PROCEED_WITH_ASSUMPTIONS" : "ASK_MINIMUM";
    const cap = level === "HIGH" ? 2 : level === "MEDIUM" ? 3 : 5;
    let kept = 0;
    const questions = (v.questions ?? []).map((q) => {
        const reform = !(/\bI believe\b/i.test(q.question) && /confirm|correct/i.test(q.question));
        if ((q.why_not_inferable ?? "").trim().length < 20)
            return { ...q, kept: false, reform, reason: "not shown to be non-inferable: investigate it instead of asking" };
        if (kept >= cap)
            return { ...q, kept: false, reform, reason: `over the limit for ${level} confidence (${cap}): ask the most important ones` };
        kept++;
        return { ...q, kept: true, reform, reason: level === "HIGH" ? "optional: a confirmation of a belief you already hold" : "blocking and not inferable" };
    });
    return {
        leading: lead && lp ? { id: lead.id, statement: lead.statement, claimed: lp.claimed, verified: lp.verified, verified_supports: lp.vs, unsupported_claims: lp.unsupported, verified_contradictions: lp.vc } : null,
        runner_up: ru, ambiguous, confidence, level, action, questions, investigate_next: v.investigate_next ?? [], risks: v.risks ?? [], assumptions: v.assumptions ?? [], notes,
    };
}
export function renderAssessment(a, intent) {
    const out = [`# Intent reasoning: ${a.level} confidence (${a.confidence}%) → ${a.action.replace(/_/g, " ").toLowerCase()}`, ""];
    if (a.leading)
        out.push(`Leading hypothesis ${a.leading.id}: ${a.leading.statement}`, `  claimed ${a.leading.claimed}%, verified ${a.leading.verified}% (${a.leading.verified_supports} verified support, ${a.leading.unsupported_claims} discarded, ${a.leading.verified_contradictions} verified contradiction)`);
    if (a.runner_up)
        out.push(`Runner-up ${a.runner_up.id}: ${a.runner_up.verified}%${a.ambiguous ? "  (AMBIGUOUS)" : ""}`);
    if (intent)
        out.push("", `Intent: ${intent.problem}`, `  work type ${intent.work_type}${intent.domain ? ` · domain ${intent.domain}` : ""}${intent.outcome ? ` · outcome ${intent.outcome}` : ""}${intent.services?.length ? ` · services ${intent.services.join(", ")}` : ""}`);
    if (a.risks.length)
        out.push("", "Risks (each with its source):", ...a.risks.map((r) => `  - ${r.risk}  [${r.source}]`));
    if (a.assumptions.length)
        out.push("", "Assumptions (not facts):", ...a.assumptions.map((x) => `  - ${x}`));
    if (a.investigate_next.length)
        out.push("", "Investigate before asking anyone:", ...a.investigate_next.map((x) => `  - ${x.what} — ${x.why}${x.how ? ` (${x.how})` : ""}`));
    const asked = a.questions.filter((q) => q.kept), dropped = a.questions.filter((q) => !q.kept);
    out.push("", asked.length ? `Questions to ask (${asked.length}):` : "No question needs to be asked.");
    for (const q of asked)
        out.push(`  ? ${q.question}${q.reform ? "  [rephrase as: I believe X because Y; confirm or correct]" : ""}`, `      needed: ${q.why_needed}`, `      not inferable: ${q.why_not_inferable}`, `      effect on confidence: ${q.confidence_impact}`);
    if (dropped.length)
        out.push("", `Questions withheld (${dropped.length}):`, ...dropped.map((q) => `  - ${q.question.slice(0, 90)} — ${q.reason}`));
    out.push("", ...a.notes.map((n) => `note: ${n}`));
    return out.join("\n");
}
// ------------------------------------------------------------ the evidence the model reasons from
export function buildIntentPacket(root, c) {
    const rootAbs = path.resolve(root);
    const numstat = lines(git(rootAbs, ["diff", "--numstat", c.base ?? "HEAD", "--"])).slice(0, 40).map((l) => { const [a, d, f] = l.split("\t"); return { file: f, added: a, removed: d }; });
    const hunks = {};
    for (const l of lines(git(rootAbs, ["diff", "--unified=0", "--no-color", "--no-ext-diff", c.base ?? "HEAD", "--"]))) {
        const m = /^@@ .*? @@\s*(.*)$/.exec(l);
        if (m) {
            const cur = Object.keys(hunks).length ? Object.keys(hunks)[Object.keys(hunks).length - 1] : "";
            if (cur && (hunks[cur].length < 8) && m[1])
                hunks[cur].push(m[1].slice(0, 100));
        }
        const f = /^\+\+\+ b\/(.+)$/.exec(l);
        if (f)
            hunks[f[1]] = [];
    }
    const added = addedLines(rootAbs, c.base);
    const samples = {};
    let budget = 9000;
    for (const [file, ls] of Object.entries(added).slice(0, 10)) {
        const body = ls.slice(0, 40).map((x) => `${x.line}: ${x.text}`).join("\n").slice(0, Math.min(1400, budget));
        budget -= body.length;
        samples[file] = body;
        if (budget <= 0)
            break;
    }
    return {
        note: "this is everything the tool found; investigate beyond it with your own reads (callers, tests, history) before you ask the developer anything",
        branch: c.branch, base: c.base?.slice(0, 10) ?? null,
        commits: c.commits.slice(0, 15), references: c.refs, work_type_hint: c.work_type,
        changed_modules: c.modules, changed_files: c.files.all.slice(0, 60), diff_size: numstat, changed_functions: hunks, added_lines_sample: samples,
        context_completeness: { coverage: c.coverage, found: c.sources.filter((s) => s.found).map((s) => s.label), missing: c.sources.filter((s) => !s.found).map((s) => s.label) },
        task_candidates: c.candidates.map((t) => ({ ref: t.ref, folder: t.folder, score: t.score, reasons: t.reasons, acceptance_criteria: t.acceptance_criteria, decisions: t.decisions })),
        earlier_drafts: c.drafts,
        product: c.product,
        change_signals: c.signals,
    };
}
