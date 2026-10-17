/**
 * Unseen-story calibration: the reviewer's input, and nothing else.
 *
 * A review can only be measured against a client's comments if it was produced without them. This builds the INPUT PACK a
 * calibration review is allowed to read: the requirements, the decisions recorded before the client review, and the code AT
 * THE COMMIT THE CLIENT REVIEWED. It leaves out, with a recorded reason, everything that can carry the answer: PR summaries
 * and narratives, ADO comments, investigations, retrospectives, progress logs, files-touched summaries ("review fixes: ..."),
 * decisions logged after the cutoff, undated reasoning state, and any code newer than the reviewed commit.
 *
 * The pack cannot make a model forget what it has read; it can make the allowed input explicit and checkable, and the seal
 * records the reviewer's attestation that the comments and post-review findings were not seen. A story the reviewer already
 * knows is not an unseen story.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execFileSync } from "child_process";
const REQ_KEYS = ["id", "title", "raw_request", "scope", "actors", "tenancy", "authorization", "business_rules", "data_lifecycle", "apis", "events", "frontend", "persistence", "acceptance_criteria", "constraints"];
const readJson = (p) => { try {
    return JSON.parse(fs.readFileSync(p, "utf-8").replace(/^﻿/, ""));
}
catch {
    return null;
} };
const WHY_EXCLUDED = {
    "pr-summary.md": "written after the work: describes what was changed and why, including review fixes",
    "pr-narrative.json": "written after the work: the PR narrative",
    "ado-comment.md": "written after the work: the work-item comment",
    "investigation.md": "written during and after the work: records defects found in review and what was not verified",
    "retrospective.json": "written after the work",
    "progress.json": "work log, may name review fixes",
    "files-touched.json": "change summaries written while fixing review findings",
    "scenarios.json": "test scenarios written with the implementation",
    "spec.md": "generated from the plan after the work started; the requirement and spec.json are the input",
};
function git(cwd, args) { return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28 }).toString().trim(); }
export function prepareUnseenPack(o) {
    const cutoff = Date.parse(o.cutoff);
    if (Number.isNaN(cutoff))
        throw new Error(`cutoff '${o.cutoff}' is not a date. Give the moment the client review was received (ISO 8601).`);
    if (!o.work_items.length)
        throw new Error("work_items is required: the story family whose requirements and decisions are the input.");
    if (!o.repos.length)
        throw new Error("repos is required: the code under review, each with the commit the client reviewed.");
    if (fs.existsSync(o.out_dir) && fs.readdirSync(o.out_dir).length)
        throw new Error(`out_dir ${o.out_dir} is not empty. A pack is built into a fresh folder so nothing else can sit beside it.`);
    for (const r of o.repos)
        if (!r.ref && !o.allow_head)
            throw new Error(`Refused: ${r.path} has no ref. Give the commit the client reviewed. Using the current HEAD would hand the reviewer code that already contains the fixes (set allow_head to accept that; the pack is then marked not unseen-ready).`);
    fs.mkdirSync(o.out_dir, { recursive: true });
    const included = [], excluded = [], warnings = [];
    const secu = path.join(o.source_root, ".secufusion");
    const ids = o.work_items.map((x) => x.toUpperCase());
    // requirements: a whitelist of the fields that state the work, plus user decisions answered before the cutoff
    for (const id of ids) {
        const rp = path.join(secu, "requirements", `${id}.json`);
        const req = readJson(rp);
        if (!req) {
            excluded.push({ path: `requirements/${id}.json`, reason: "no requirement record for this work item" });
            continue;
        }
        const out = {};
        for (const k of REQ_KEYS)
            if (req[k] !== undefined)
                out[k] = req[k];
        out.user_decisions = (req.user_decisions ?? []).filter((d) => d.state === "ANSWERED" && d.answered_at && Date.parse(d.answered_at) <= cutoff).map((d) => ({ id: d.id, question: d.question, answer: d.answer, user_statement: d.user_statement, answered_at: d.answered_at }));
        const dropped = (req.user_decisions ?? []).length - out.user_decisions.length;
        fs.mkdirSync(path.join(o.out_dir, "requirements"), { recursive: true });
        fs.writeFileSync(path.join(o.out_dir, "requirements", `${id}.json`), JSON.stringify(out, null, 2));
        included.push({ path: `requirements/${id}.json`, kind: "requirement", note: `${out.user_decisions.length} user decision(s) answered before the cutoff${dropped ? `; ${dropped} later or unanswered dropped` : ""}` });
        for (const k of ["decisions", "facts", "assumptions", "unknowns", "conflicts", "root_cause", "inferences", "blockers", "traceability", "ui_impact", "ui_reference", "clarification_questions"])
            if (req[k] !== undefined)
                excluded.push({ path: `requirements/${id}.json#${k}`, reason: "reasoning state written during the work, undated: it may contain post-review findings" });
        warnings.push(`requirements/${id}.json: business_rules, constraints and acceptance_criteria are undated and may include amendments made after the client review. Check the history of ${id} before treating the pack as unseen.`);
    }
    // task folders: dated decisions only
    const tasks = path.join(secu, "tasks");
    if (fs.existsSync(tasks)) {
        for (const d of fs.readdirSync(tasks, { withFileTypes: true }).filter((x) => x.isDirectory() && ids.some((i) => x_startsWith(x.name, i)))) {
            for (const f of fs.readdirSync(path.join(tasks, d.name))) {
                const rel = `tasks/${d.name}/${f}`;
                if (f === "decisions.json") {
                    const list = readJson(path.join(tasks, d.name, f)) ?? [];
                    const keep = list.filter((r) => r.logged_at && Date.parse(r.logged_at) <= cutoff);
                    if (keep.length) {
                        fs.mkdirSync(path.join(o.out_dir, "tasks", d.name), { recursive: true });
                        fs.writeFileSync(path.join(o.out_dir, rel), JSON.stringify(keep.map((r) => ({ id: r.id, decision: r.decision, logged_at: r.logged_at })), null, 2));
                        included.push({ path: rel, kind: "decisions", note: `${keep.length} of ${list.length} logged before the cutoff (rationales omitted)` });
                    }
                    if (list.length - keep.length)
                        excluded.push({ path: rel, reason: `${list.length - keep.length} decision record(s) logged after the cutoff or undated` });
                }
                else if (f === "spec.json") {
                    const s = readJson(path.join(tasks, d.name, f));
                    if (s) {
                        fs.mkdirSync(path.join(o.out_dir, "tasks", d.name), { recursive: true });
                        fs.writeFileSync(path.join(o.out_dir, rel), JSON.stringify({ work_item_id: s.work_item_id, title: s.title, description: s.description, acceptance_criteria: s.acceptance_criteria }, null, 2));
                        included.push({ path: rel, kind: "spec" });
                    }
                }
                else
                    excluded.push({ path: rel, reason: WHY_EXCLUDED[f] ?? "not a requirement, a dated decision or code" });
            }
        }
    }
    // code at the reviewed commit
    const repos = [];
    for (const r of o.repos) {
        const name = r.name ?? path.basename(path.resolve(r.path));
        const ref = r.ref ?? null;
        const commit = git(r.path, ["rev-parse", `${ref ?? "HEAD"}^{commit}`]);
        const dest = path.join(o.out_dir, "code", name);
        fs.mkdirSync(dest, { recursive: true });
        const tar = path.join(o.out_dir, `.${name}.tar`);
        git(r.path, ["archive", "--format=tar", "-o", tar, commit]);
        // relative paths from out_dir: GNU tar on Windows reads "C:" in an absolute path as a remote host
        execFileSync("tar", ["-xf", path.basename(tar), "-C", path.relative(o.out_dir, dest).split(path.sep).join("/")], { cwd: o.out_dir, stdio: "ignore" });
        fs.rmSync(tar, { force: true });
        const when = git(r.path, ["show", "-s", "--format=%cI", commit]);
        if (Date.parse(when) > cutoff)
            warnings.push(`code/${name}: commit ${commit.slice(0, 10)} is dated ${when}, after the cutoff ${o.cutoff}. It may already contain fixes for the client's comments.`);
        repos.push({ name, ref, commit, pre_review: !!ref });
        included.push({ path: `code/${name}`, kind: "code", note: `${commit.slice(0, 10)} (${ref ?? "HEAD: not a pre-review commit"})` });
    }
    const unseen_ready = repos.every((r) => r.pre_review) && !warnings.some((w) => /after the cutoff/.test(w));
    const body = { cutoff: o.cutoff, work_items: ids, included, excluded, repos };
    const pack = { created_at: new Date().toISOString(), cutoff: o.cutoff, work_items: ids, included, excluded, repos, warnings, pack_sha256: crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex"), unseen_ready };
    fs.writeFileSync(path.join(o.out_dir, "UNSEEN-PACK.json"), JSON.stringify(pack, null, 2));
    fs.writeFileSync(path.join(o.out_dir, "READ-ME-FIRST.txt"), [
        "UNSEEN-STORY CALIBRATION PACK", "",
        "Review ONLY what is in this folder: requirements/, tasks/*/decisions.json, tasks/*/spec.json and code/.",
        "Do not open the source workspace, the PR, the ADO item, the investigation, or any client comment.",
        "Derive the findings, then seal them with calibrate_review action=seal, passing this folder as input_pack and the attestation.",
        "Only after sealing may the client comments be revealed.", "",
        `Code is at the commit the client reviewed (${repos.map((r) => `${r.name} ${r.commit.slice(0, 10)}`).join(", ")}).`,
        pack.unseen_ready ? "" : "NOT UNSEEN-READY: see the warnings in UNSEEN-PACK.json. Results from this pack are design validation only.",
    ].join("\n"));
    return pack;
}
function x_startsWith(name, id) { return name.toUpperCase().startsWith(id); }
/** Is a sealed run's input a valid unseen pack? */
export function checkPack(packDir) {
    const mp = path.join(packDir, "UNSEEN-PACK.json");
    if (!fs.existsSync(mp))
        return { ok: false, reasons: ["no UNSEEN-PACK.json in the input pack"] };
    const p = JSON.parse(fs.readFileSync(mp, "utf-8"));
    const body = { cutoff: p.cutoff, work_items: p.work_items, included: p.included, excluded: p.excluded, repos: p.repos };
    const reasons = [];
    if (crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex") !== p.pack_sha256)
        reasons.push("the pack manifest was changed after it was built");
    if (!p.unseen_ready)
        reasons.push("the pack is not unseen-ready (code is not a pre-review commit, or is newer than the cutoff)");
    return { ok: reasons.length === 0, reasons };
}
