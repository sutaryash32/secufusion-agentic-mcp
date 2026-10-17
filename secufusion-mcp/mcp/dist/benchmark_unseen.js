import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { prepareUnseenPack, checkPack } from "./unseen.js";
import { seal, reveal, blindness } from "./calibration.js";
/** The unseen-story process: what the reviewer may read, and what makes a run blind. */
let failures = 0;
function check(name, cond, detail = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + detail}`);
    if (!cond)
        failures++;
}
const GIT = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", "-c", "commit.gpgsign=false"];
const g = (cwd, ...a) => execFileSync("git", [...GIT, ...a], { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_COMMITTER_DATE: process.env.TEST_COMMIT_DATE ?? "", GIT_AUTHOR_DATE: process.env.TEST_COMMIT_DATE ?? "" } }).toString().trim();
const put = (root, rel, text) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "unseen-"));
// the source workspace: requirements, decisions (before and after the client review), post-work documents
const src = tmp();
const BEFORE = "2026-10-10T10:00:00.000Z", CUTOFF = "2026-10-12T00:00:00.000Z", AFTER = "2026-10-14T10:00:00.000Z";
put(src, ".secufusion/requirements/TASK-5.json", JSON.stringify({
    id: "TASK-5", title: "Transfer ownership", raw_request: "Let an admin hand the tenant to another user.", scope: "one tenant", acceptance_criteria: ["AC1 swap in one transaction"],
    decisions: ["Added after review: the tenant email must follow the owner"], facts: ["F1 found while fixing review finding 6"], root_cause: "race", assumptions: ["a2"],
    user_decisions: [
        { id: "UD-1", state: "ANSWERED", question: "Delete semantics?", answer: "A", user_statement: "Deleting the owner is not allowed", answered_at: BEFORE },
        { id: "UD-9", state: "ANSWERED", question: "Domain?", answer: "A", user_statement: "No domain change", answered_at: AFTER },
        { id: "UD-3", state: "OPEN", question: "Open?" },
    ],
}));
put(src, ".secufusion/tasks/TASK-5-transfer/decisions.json", JSON.stringify([
    { id: 1, decision: "Contract: POST transfer-ownership", rationale: "why", logged_at: BEFORE },
    { id: 2, decision: "Code-review finding 6 (REAL DEFECT, fixed): a race", rationale: "approved", logged_at: AFTER },
    { id: 3, decision: "Undated decision", rationale: "?" },
]));
put(src, ".secufusion/tasks/TASK-5-transfer/spec.json", JSON.stringify({ work_item_id: "TASK-5", title: "Transfer", description: "d", acceptance_criteria: ["AC1"], tags: ["split-from-BUG-1"], status: "active" }));
for (const f of ["pr-summary.md", "pr-narrative.json", "ado-comment.md", "investigation.md", "retrospective.json", "progress.json", "files-touched.json", "scenarios.json"])
    put(src, `.secufusion/tasks/TASK-5-transfer/${f}`, "post-work content mentioning review fixes");
// the code under review: a commit the client reviewed, then a later commit with the fix
const repo = tmp();
g(repo, "init", "-q", "-b", "main");
put(repo, "src/Transfer.java", "class Transfer { void go() { /* no lock */ } }\n");
process.env.TEST_COMMIT_DATE = "2026-10-11T10:00:00Z";
g(repo, "add", "-A");
g(repo, "commit", "-q", "-m", "reviewed");
const reviewed = g(repo, "rev-parse", "HEAD");
put(repo, "src/Transfer.java", "class Transfer { void go() { lockTenant(); } }\n");
process.env.TEST_COMMIT_DATE = "2026-10-15T10:00:00Z";
g(repo, "add", "-A");
g(repo, "commit", "-q", "-m", "fix after review");
process.env.TEST_COMMIT_DATE = "";
// ── building the pack ────────────────────────────────────────────────────────
{
    let noRef = "";
    try {
        prepareUnseenPack({ source_root: src, out_dir: path.join(tmp(), "p"), cutoff: CUTOFF, work_items: ["TASK-5"], repos: [{ path: repo }] });
    }
    catch (e) {
        noRef = e.message;
    }
    check("a repo without the reviewed commit is refused: HEAD already contains the fixes", /has no ref/.test(noRef) && /already contains the fixes/.test(noRef), noRef);
    let badCut = "";
    try {
        prepareUnseenPack({ source_root: src, out_dir: path.join(tmp(), "p"), cutoff: "yesterday-ish", work_items: ["TASK-5"], repos: [{ path: repo, ref: reviewed }] });
    }
    catch (e) {
        badCut = e.message;
    }
    check("a cutoff that is not a date is refused", /not a date/.test(badCut));
    const out = path.join(tmp(), "pack");
    const p = prepareUnseenPack({ source_root: src, out_dir: out, cutoff: CUTOFF, work_items: ["TASK-5"], repos: [{ path: repo, ref: reviewed, name: "svc" }] });
    const read = (rel) => JSON.parse(fs.readFileSync(path.join(out, rel), "utf-8"));
    check("the code is the commit the client reviewed, not HEAD", fs.readFileSync(path.join(out, "code/svc/src/Transfer.java"), "utf-8").includes("no lock") && !fs.readFileSync(path.join(out, "code/svc/src/Transfer.java"), "utf-8").includes("lockTenant"));
    const req = read("requirements/TASK-5.json");
    check("the requirement keeps the fields that state the work", req.title === "Transfer ownership" && req.acceptance_criteria.length === 1 && req.raw_request);
    check("reasoning state written during the work is not in the pack", !("decisions" in req) && !("facts" in req) && !("root_cause" in req) && !("assumptions" in req));
    check("only user decisions answered before the cutoff are kept; later and unanswered ones are dropped", req.user_decisions.length === 1 && req.user_decisions[0].id === "UD-1", JSON.stringify(req.user_decisions));
    const dec = read("tasks/TASK-5-transfer/decisions.json");
    check("decisions logged before the cutoff are kept without their rationale; later and undated ones are dropped", dec.length === 1 && dec[0].id === 1 && !("rationale" in dec[0]), JSON.stringify(dec));
    check("the spec keeps the title, description and acceptance criteria only", Object.keys(read("tasks/TASK-5-transfer/spec.json")).sort().join() === "acceptance_criteria,description,title,work_item_id");
    for (const f of ["pr-summary.md", "pr-narrative.json", "ado-comment.md", "investigation.md", "retrospective.json", "progress.json", "files-touched.json", "scenarios.json"]) {
        check(`${f} is excluded, with a reason`, !fs.existsSync(path.join(out, "tasks/TASK-5-transfer", f)) && p.excluded.some((e) => e.path.endsWith(f) && e.reason.length > 10));
    }
    check("the exclusions of dated records are recorded with counts", p.excluded.some((e) => /2 decision record\(s\) logged after the cutoff or undated/.test(e.reason)));
    check("the pack warns that undated requirement fields may carry post-review amendments", p.warnings.some((w) => /undated and may include amendments/.test(w)));
    check("the pack is unseen-ready: pre-review code, nothing newer than the cutoff", p.unseen_ready && p.repos[0].commit === reviewed && p.repos[0].pre_review);
    check("a read-me names the only folders the reviewer may read", /Review ONLY what is in this folder/.test(fs.readFileSync(path.join(out, "READ-ME-FIRST.txt"), "utf-8")));
    let nonEmpty = "";
    try {
        prepareUnseenPack({ source_root: src, out_dir: out, cutoff: CUTOFF, work_items: ["TASK-5"], repos: [{ path: repo, ref: reviewed }] });
    }
    catch (e) {
        nonEmpty = e.message;
    }
    check("a pack is built into a fresh folder, so nothing else can sit beside it", /not empty/.test(nonEmpty));
    check("an intact pack validates", checkPack(out).ok);
    const m = JSON.parse(fs.readFileSync(path.join(out, "UNSEEN-PACK.json"), "utf-8"));
    m.excluded = [];
    fs.writeFileSync(path.join(out, "UNSEEN-PACK.json"), JSON.stringify(m));
    check("a pack whose manifest was edited fails validation", !checkPack(out).ok && /changed after it was built/.test(checkPack(out).reasons.join()));
}
// ── HEAD and late commits make the pack not unseen-ready ─────────────────────
{
    const head = prepareUnseenPack({ source_root: src, out_dir: path.join(tmp(), "h"), cutoff: CUTOFF, work_items: ["TASK-5"], repos: [{ path: repo }], allow_head: true });
    check("allow_head builds a pack, marked not unseen-ready, with the fix in the code", !head.unseen_ready && head.repos[0].pre_review === false);
    const late = prepareUnseenPack({ source_root: src, out_dir: path.join(tmp(), "l"), cutoff: "2026-10-01T00:00:00.000Z", work_items: ["TASK-5"], repos: [{ path: repo, ref: reviewed }] });
    check("a commit dated after the cutoff is flagged: it may already contain the fixes", !late.unseen_ready && late.warnings.some((w) => /after the cutoff/.test(w)));
}
// ── blindness comes from the attestation AND a valid pack ────────────────────
{
    const out = path.join(tmp(), "pack2");
    prepareUnseenPack({ source_root: src, out_dir: out, cutoff: CUTOFF, work_items: ["TASK-5"], repos: [{ path: repo, ref: reviewed }] });
    const ws = tmp();
    const f = [{ title: "race", category: "BLOCKING", text: "two IT admins" }];
    check("no attestation: not blind", !blindness(undefined).blind);
    check("attesting the comments were seen: not blind, with the reason", /had seen the client comments/.test(blindness({ attestation: { saw_client_comments: true, saw_post_review_findings: false }, input_pack: out }).reasons.join()));
    check("attesting post-review findings were seen: not blind", !blindness({ attestation: { saw_client_comments: false, saw_post_review_findings: true }, input_pack: out }).blind);
    check("a clean attestation without a pack: not blind", /no unseen input pack/.test(blindness({ attestation: { saw_client_comments: false, saw_post_review_findings: false } }).reasons.join()));
    check("a clean attestation with a valid unseen pack: blind", blindness({ attestation: { saw_client_comments: false, saw_post_review_findings: false }, input_pack: out }).blind);
    const s = seal(ws, "S", f, { attestation: { saw_client_comments: false, saw_post_review_findings: false }, input_pack: out });
    check("sealing records the blindness", s.blind);
    const r = reveal(ws, "S", [{ text: "Concurrent transfers could leave two IT admins", category: "BLOCKING" }]);
    check("reveal reports the run as blind and uses MATCH / PARTIAL / MISS", r.blind && r.pairings[0].verdict === "MATCH");
    const ws2 = tmp();
    seal(ws2, "S", f);
    const r2 = reveal(ws2, "S", [{ text: "x" }]);
    check("a run sealed without an attestation is revealed as NOT blind", !r2.blind && r2.blind_reasons.length > 0);
}
process.exit(failures ? 1 : 0);
