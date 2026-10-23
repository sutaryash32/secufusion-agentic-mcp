import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { discoverReviewContext, recordDraftContext, validateEntries, assessIntent, buildIntentPacket, renderContext } from "./review_context.js";
import { createEntry } from "./project_knowledge.js";
/** Context discovery: recover before asking, say how complete it is, never store a guess as a fact. Real git repositories. */
let failures = 0;
function check(name, cond, detail = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + detail}`);
    if (!cond)
        failures++;
}
const mk = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const write = (root, rel, content) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };
function repo() {
    const ws = mk("ctx-");
    const git = (...a) => execFileSync("git", ["-C", ws, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    git("init", "-q");
    git("symbolic-ref", "HEAD", "refs/heads/main");
    return { ws, git };
}
// ============================================================ 1. a rich context: everything exists, nothing needs asking
{
    const { ws, git } = repo();
    write(ws, "sfn-iam-api/pom.xml", "<project/>");
    write(ws, "sfn-iam-api/src/main/java/UserService.java", "class UserService { void a() {} }\n");
    write(ws, "sfn-web-ui/package.json", "{}");
    write(ws, "sfn-web-ui/src/Dialog.jsx", "export const Dialog = () => null;\n");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "bugfix/BUG-1230-owner-transfer");
    write(ws, "sfn-iam-api/src/main/java/UserService.java", "class UserService { void a() {} void guard() { requireOwner(); } }\n");
    git("add", ".");
    git("commit", "-q", "-m", "BUG-1230: fix the owner guard missing on transfer");
    write(ws, "sfn-web-ui/src/Dialog.jsx", "export const Dialog = () => 'transfer';\n");
    git("add", "sfn-web-ui/src/Dialog.jsx"); // staged
    write(ws, "sfn-iam-api/src/main/java/UserService.java", "class UserService { void a() {} void guard() { requireOwner(); } void b() {} }\n"); // modified
    write(ws, "sfn-iam-api/src/main/java/New.java", "class New {}\n"); // untracked
    write(ws, ".secufusion/tasks/BUG-1230-owner-transfer/spec.json", JSON.stringify({ title: "owner transfer", acceptance_criteria: ["a", "b", "c"] }));
    write(ws, ".secufusion/tasks/BUG-1230-owner-transfer/spec.md", "# spec\n");
    write(ws, ".secufusion/tasks/BUG-1230-owner-transfer/decisions.json", JSON.stringify([{ id: 1, decision: "previous owner keeps groups" }]));
    write(ws, ".secufusion/tasks/BUG-1230-owner-transfer/files-touched.json", JSON.stringify([{ file_path: "sfn-iam-api/src/main/java/UserService.java", change_summary: "guard" }]));
    write(ws, ".secufusion/tasks/BUG-1230-owner-transfer/review.draft.md", "# earlier review\n");
    write(ws, ".secufusion/tasks/STORY-9999-unrelated/spec.json", JSON.stringify({ acceptance_criteria: ["x"] }));
    createEntry(ws, { category: "decisions", title: "Owner transfer keeps groups", body: "Decided.", tags: ["owner", "transfer"], source: "UD-8", status: "accepted" });
    const c = discoverReviewContext(ws);
    const src = Object.fromEntries(c.sources.map((s) => [s.id, s.found]));
    check("rich: staged, modified and untracked files are separated, and committed work since the base is included", c.files.staged.includes("sfn-web-ui/src/Dialog.jsx") && c.files.modified.includes("sfn-iam-api/src/main/java/UserService.java") && c.files.untracked.includes("sfn-iam-api/src/main/java/New.java") && c.files.since_base.includes("sfn-iam-api/src/main/java/UserService.java"), JSON.stringify(c.files));
    check("rich: the changed modules are the services, not folders", c.modules.join() === "sfn-iam-api,sfn-web-ui", c.modules.join());
    check("rich: the reference is found in the branch name and in the commit message", c.refs.some((r) => r.ref === "BUG-1230" && r.from === "branch") && c.branch === "bugfix/BUG-1230-owner-transfer");
    check("rich: the work type is read from the branch and the commit, with its evidence", c.work_type.type === "Bug Fix" && !c.work_type.ambiguous && c.work_type.evidence.length >= 2, JSON.stringify(c.work_type));
    check("rich: the matching task folder is a candidate with its reasons; the unrelated one is not", c.candidates[0]?.ref === "BUG-1230" && c.candidates[0].score >= 50 && c.candidates[0].reasons.length >= 2 && !c.candidates.some((t) => t.ref === "STORY-9999"), JSON.stringify(c.candidates));
    check("rich: every source it could find is found, and the coverage score says so", ["files", "branch", "commits", "task", "acceptance", "requirements", "decisions", "review", "knowledge"].every((k) => src[k]) && c.coverage === 100, `${c.coverage} ${JSON.stringify(src)}`);
    check("rich: a change in both services is a full-stack draft with a provisional reference", c.prefix === "FS" && c.next_draft_ref === "FS-TASK-D001", `${c.prefix} ${c.next_draft_ref}`);
    check("rich: nothing is written to the workspace by discovery", !fs.existsSync(path.join(ws, ".secufusion", "registry.json")) && !fs.readdirSync(path.join(ws, ".secufusion", "tasks")).some((f) => /draft/.test(f)));
}
// ============================================================ 2. a poor context: say so, do not pretend
{
    const { ws, git } = repo();
    write(ws, "svc/pom.xml", "<project/>");
    write(ws, "svc/A.java", "class A {}\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    write(ws, "svc/A.java", "class A { int x; }\n");
    const c = discoverReviewContext(ws);
    check("poor: with only an uncommitted change the coverage is low and the missing sources are named", c.coverage <= 20 && c.sources.filter((s) => !s.found).map((s) => s.id).join() === "branch,commits,task,acceptance,requirements,decisions,review,knowledge", `${c.coverage} ${c.sources.filter((s) => !s.found).map((s) => s.id)}`);
    check("poor: no candidate is invented, and the first draft reference is D001", c.candidates.length === 0 && c.next_draft_ref === "BE-TASK-D001" && c.work_type.type === null);
    // the same change but only a stale, weakly related task: a weak candidate is reported and NOT adopted
    write(ws, ".secufusion/tasks/TASK-77-account-export/spec.json", JSON.stringify({ acceptance_criteria: ["exports"] }));
    write(ws, ".secufusion/tasks/TASK-77-account-export/files-touched.json", JSON.stringify([{ file_path: "other/Z.java" }]));
    const w = discoverReviewContext(ws);
    check("poor: a task that shares nothing with the change is not a candidate at all", w.candidates.length === 0);
    // a draft context makes the next review start from where this one ended
    const bad = [
        { kind: "intent", text: "Expose the tenant administrator on retrieval", status: "CONFIRMED" },
        { kind: "assumption", text: "The new field is additive for old clients", status: "INFERRED" },
        { kind: "missing", text: "Acceptance criteria", status: "INFERRED", source: "somewhere" },
    ];
    check("draft: inferred information stored as confirmed, an inference with no evidence and a 'missing' that is not UNKNOWN are all refused", validateEntries([...bad]).length === 3 && validateEntries([...bad]).every((p) => /needs confirmed_by|needs source|UNKNOWN by definition/.test(p)), validateEntries([...bad]).join(" | "));
    let threw = false;
    try {
        recordDraftContext(ws, { prefix: "BE", title: "Expose tenant admin", entries: [...bad] }, true);
    }
    catch {
        threw = true;
    }
    check("draft: a draft with a refused entry is not written at all", threw && !fs.existsSync(path.join(ws, ".secufusion", "tasks", "BE-TASK-D001-draft-expose-tenant-admin")));
    const entries = [
        { kind: "intent", text: "Expose the initial tenant administrator during tenant retrieval", status: "INFERRED", source: "svc/A.java:1 and the branch name" },
        { kind: "risk", text: "User counts may change for existing consumers", status: "INFERRED", source: "svc/A.java: a field is added to a list response" },
        { kind: "acceptance", text: "Retrieval returns the administrator", status: "CONFIRMED", confirmed_by: "yes, that is the goal" },
        { kind: "missing", text: "Acceptance criteria for the empty-tenant case", status: "UNKNOWN" },
    ];
    const preview = recordDraftContext(ws, { prefix: "BE", title: "Expose tenant admin", entries: [...entries], files: ["svc/A.java"], branch: "main" }, false);
    check("draft: a preview writes nothing", !preview.written && !fs.existsSync(path.join(ws, ".secufusion", "tasks", preview.folder.split("/").pop())) && /DRAFT task context/.test(preview.preview));
    const done = recordDraftContext(ws, { prefix: "BE", title: "Expose tenant admin", entries: [...entries], files: ["svc/A.java"], branch: "main", summary: { business_intent: "Show the first tenant administrator.", open_questions: ["What happens for a tenant with no admin?"] } }, true);
    const j = JSON.parse(fs.readFileSync(path.join(ws, done.json), "utf8"));
    check("draft: applied, it writes a machine file and a readable one, marked synthetic and DRAFT, with the three statuses kept apart", done.written && done.ref === "BE-TASK-D001" && j.synthetic === true && j.status === "DRAFT" && done.counts.CONFIRMED === 1 && done.counts.INFERRED === 2 && done.counts.UNKNOWN === 1 && /### CONFIRMED[\s\S]*### INFERRED[\s\S]*### UNKNOWN/.test(fs.readFileSync(path.join(ws, done.md), "utf8")), JSON.stringify(done.counts));
    check("draft: the readable file says the reference is not a work item and shows each entry's evidence", /provisional \(it is not a work item\)/.test(fs.readFileSync(path.join(ws, done.md), "utf8")) && /inferred from: svc\/A\.java:1/.test(fs.readFileSync(path.join(ws, done.md), "utf8")) && /confirmed by: "yes, that is the goal"/.test(fs.readFileSync(path.join(ws, done.md), "utf8")));
    check("draft: it does not touch the task registry, so it cannot create an identity conflict", !fs.existsSync(path.join(ws, ".secufusion", "registry.json")));
    const again = recordDraftContext(ws, { ref: done.ref, title: "Expose tenant admin", entries: [{ kind: "intent", text: "Expose the initial tenant administrator during tenant retrieval", status: "CONFIRMED", confirmed_by: "correct, that is it" }, { kind: "risk", text: "A second new risk", status: "INFERRED", source: "svc/A.java:2" }] }, true);
    check("draft: updating merges by text, and a confirmation strengthens an inference, never the other way", again.ref === "BE-TASK-D001" && again.entries === 5 && again.counts.CONFIRMED === 2 && again.counts.INFERRED === 2, JSON.stringify(again.counts));
    const keep = recordDraftContext(ws, { ref: done.ref, title: "Expose tenant admin", entries: [{ kind: "acceptance", text: "Retrieval returns the administrator", status: "INFERRED", source: "svc/A.java:1" }] }, true);
    check("draft: an inference cannot demote or overwrite what the developer confirmed", keep.counts.CONFIRMED === 2, JSON.stringify(keep.counts));
    const next = discoverReviewContext(ws);
    check("next review: the draft is found again by the files it explains, counts as task context, and the next draft reference moves on", next.drafts[0]?.ref === "BE-TASK-D001" && next.drafts[0].overlap >= 0.5 && next.sources.find((s) => s.id === "task").found && next.next_draft_ref === "BE-TASK-D002" && next.coverage > c.coverage, `${JSON.stringify(next.drafts)} ${next.coverage}`);
    let refused = 0;
    for (const f of [() => recordDraftContext(ws, { ref: "BUG-1230", title: "x y z", entries: [] }, true), () => recordDraftContext(ws, { ref: "../../x", title: "x y z", entries: [] }, true), () => recordDraftContext(ws, { title: "no prefix here", entries: [] }, true)]) {
        try {
            f();
        }
        catch {
            refused++;
        }
    }
    check("draft: a real work-item reference, a path and a missing prefix are all refused", refused === 3, String(refused));
    const trav = recordDraftContext(ws, { prefix: "FE", title: "../../../evil name", entries: [] }, true);
    check("draft: a title cannot move the folder outside .secufusion/tasks", trav.folder.startsWith(".secufusion/tasks/FE-TASK-D") && !trav.folder.includes(".."), trav.folder);
}
// ============================================================ 3. task types and ambiguity
{
    const cls = (files) => { const { ws, git } = repo(); write(ws, "x.txt", "x"); git("add", "."); git("commit", "-q", "-m", "init"); return discoverReviewContext(ws, { files }).prefix; };
    check("task type: backend only is BE, frontend only is FE, both is FS", cls(["svc/A.java", "svc/b.py"]) === "BE" && cls(["web/App.tsx", "web/a.css"]) === "FE" && cls(["svc/A.java", "web/App.tsx"]) === "FS");
    check("task type: an extension is EXT and infrastructure is INFRA, in any layout", cls(["snf-browser-extn/background.js", "snf-browser-extn/manifest.json"]) === "EXT" && cls(["Dockerfile", "deploy/k8s/app.yaml", ".github/workflows/ci.yml"]) === "INFRA");
    const { ws, git } = repo();
    write(ws, "a/pom.xml", "<project/>");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    git("checkout", "-q", "-b", "feature/1093-export");
    write(ws, "a/B.java", "class B {}\n");
    git("add", ".");
    git("commit", "-q", "-m", "fix the export of inactive users");
    const amb = discoverReviewContext(ws);
    check("intent: a feature branch whose commit says 'fix' is reported as AMBIGUOUS with both readings, not decided silently", amb.work_type.ambiguous && amb.work_type.scores["Enhancement"] === 3 && amb.work_type.scores["Bug Fix"] === 1, JSON.stringify(amb.work_type));
    check("intent: a bare number in the branch name is recorded as a reference hint", amb.refs.some((r) => r.ref === "#1093" && r.from === "branch"), JSON.stringify(amb.refs));
    const nogit = discoverReviewContext(mk("nogit-"), { files: ["a/B.java"] });
    check("no git: it still reports what it can and says it cannot infer the change", !nogit.is_git && nogit.files.all.length === 1 && nogit.coverage <= 10);
}
// ============================================================ 4. product-aware: what the project says about THIS diff
{
    const { ws, git } = repo();
    write(ws, "svc/pom.xml", "<project/>");
    write(ws, "svc/src/UserService.java", `package x;
public class UserService {
    public void transferOwnership(String t, Long n) {
        log.info("x");
    }
    public void deleteUser(Long id) {
        repo.deleteById(id);
    }
}
`);
    git("add", ".");
    git("commit", "-q", "-m", "init");
    createEntry(ws, { category: "invariants", title: "Exactly one IT Admin per tenant", body: "A tenant always has exactly one active IT Admin.", tags: ["owner", "transfer", "tenant", "it-admin"], source: "BUG-1288", status: "accepted", extra: { fields: "defaultUser", enforcement: "code check only" } });
    createEntry(ws, { category: "invariants", title: "Unrelated billing invariant", body: "Invoices are immutable once sent.", tags: ["billing"], source: "x", status: "accepted", extra: { fields: "invoiceSent" } });
    git("checkout", "-q", "-b", "feature/owner-transfer");
    write(ws, "svc/src/UserService.java", `package x;
public class UserService {
    public void transferOwnership(String t, Long n) {
        owner.setDefaultUser(false);
        next.setDefaultUser(true);
    }
    public void deleteUser(Long id) {
        repo.deleteById(id);
    }
}
`);
    const c = discoverReviewContext(ws);
    const pl = c.product;
    check("product: the recorded invariant that applies is surfaced with WHY it applies; the unrelated one is not", pl.knowledge.some((k) => k.category === "invariants" && /Exactly one IT Admin/.test(k.title) && k.why.length > 0 && /A tenant always has/.test(k.excerpt)) && !pl.knowledge.some((k) => /billing/i.test(k.title)), JSON.stringify(pl.knowledge.map((k) => [k.id, k.why])));
    check("product: the diff writing an authority field the project recorded is found, with the invariant it belongs to and the line", pl.fields_touched.some((f) => f.field === "defaultUser" && /exactly-one/.test(f.invariant) && /UserService\.java$/.test(f.file) && /setDefaultUser/.test(f.text)) && !pl.fields_touched.some((f) => f.field === "invoiceSent"), JSON.stringify(pl.fields_touched));
    check("product: the entity is derived from the changed class, and the lifecycle paths inside the changed file are listed, flagging the one that never mentions the field", pl.entities.includes("User") && pl.transitions_touched.some((x) => x.transition === "transfer" && !x.unguarded) && pl.transitions_touched.some((x) => x.transition === "delete" && x.unguarded), JSON.stringify([pl.entities, pl.transitions_touched]));
    check("product: the report shows what the product says about the diff", /What the product says about this diff/.test(renderContext(c)) && /writes defaultUser/.test(renderContext(c)));
    const packet = buildIntentPacket(ws, c);
    check("packet: the model is handed the diff, the product leads and the gaps, not a summary of them", /setDefaultUser/.test(JSON.stringify(packet.added_lines_sample)) && packet.product.fields_touched.length > 0 && packet.context_completeness.missing.length > 0 && /investigate beyond it/.test(packet.note) && packet.branch === "feature/owner-transfer");
}
// ============================================================ 5. the model's reasoning, verified
{
    const ws = mk("intent-");
    write(ws, "svc/Guard.java", "class Guard {\n  void check(Tenant t) { requireSingleActiveOwner(t); }\n}\n");
    const real = { file: "svc/Guard.java", line: 2, quote: "requireSingleActiveOwner(t)" };
    const fake = { file: "svc/Guard.java", line: 2, quote: "preventTwoOwners(t)" };
    const q = (text, whyNot = "I read the callers and the task folder and neither says what happens for a tenant with no admin") => ({ question: text, why_needed: "decides the empty-tenant behaviour", why_not_inferable: whyNot, confidence_impact: "+10" });
    const base = {
        hypotheses: [
            { id: "H1", statement: "The developer is closing a gap in the owner guard on the transfer path", work_type: "Bug Fix", confidence: 90, supports: [real] },
            { id: "H2", statement: "The developer is adding a new feature to hand over ownership", work_type: "Enhancement", confidence: 85, supports: [fake] },
        ],
        leading: "H1", intent: { problem: "owner guard missing on transfer", work_type: "Bug Fix", services: ["svc"] }, confidence: 95,
        questions: [q("I believe the empty-tenant case should be refused; confirm or correct."), q("Why?", "short"), q("I believe the audit log is out of scope; confirm or correct."), q("I believe groups are kept; confirm or correct.")],
        investigate_next: [{ what: "read the delete path", why: "it may bypass the guard" }], risks: [{ risk: "delete path bypasses the guard", source: "svc/Guard.java:2" }], assumptions: ["the guard is called from transfer"],
    };
    const a = assessIntent(ws, base);
    check("intent: a hypothesis whose cited evidence is in the code keeps its confidence; one whose citation is fake is capped at 40", a.leading.verified === 90 && a.runner_up.verified === 40 && !a.ambiguous, JSON.stringify([a.leading, a.runner_up]));
    check("intent: the confidence used is what the evidence supports, not the model's own claim of 95%", a.confidence === 90 && a.leading.claimed === 90);
    check("intent: HIGH confidence means proceed, and the questions shrink to at most two optional confirmations", a.level === "HIGH" && a.action === "PROCEED" && a.questions.filter((x) => x.kept).length === 2 && a.questions.filter((x) => x.kept).every((x) => /optional/.test(x.reason)));
    check("intent: a question not shown to be non-inferable is withheld with the reason, and one past the limit is withheld too", a.questions.find((x) => x.question === "Why?").kept === false && /non-inferable/.test(a.questions.find((x) => x.question === "Why?").reason) && /over the limit/.test(a.questions[3].reason));
    check("intent: a discarded citation is reported by name", a.notes.some((n) => /H2: 1 cited support\(s\) are not in the code/.test(n)) && a.notes.some((n) => /H2: no verified supporting evidence/.test(n)));
    const close = assessIntent(ws, { ...base, hypotheses: [{ id: "H1", statement: "close the owner guard gap on transfer", confidence: 75, supports: [real] }, { id: "H2", statement: "a new handover feature for owners", confidence: 70, supports: [real] }], confidence: 75 });
    check("intent: two hypotheses within ten points are ambiguity, which costs ten points and lands at MEDIUM", close.ambiguous && close.confidence === 65 && close.level === "MEDIUM" && close.action === "PROCEED_WITH_ASSUMPTIONS" && close.questions.filter((x) => x.kept).length <= 3);
    const contra = assessIntent(ws, { ...base, hypotheses: [{ id: "H1", statement: "close the owner guard gap on transfer", confidence: 90, supports: [real], contradicts: [real] }, { id: "H2", statement: "something else entirely here", confidence: 10, supports: [real] }], confidence: 90 });
    check("intent: a verified contradiction costs 25 points", contra.leading.verified === 65 && contra.leading.verified_contradictions === 1);
    const guess = assessIntent(ws, { ...base, hypotheses: [{ id: "H1", statement: "the developer is probably refactoring", confidence: 92 }], confidence: 92 });
    check("intent: a single confident guess with no evidence is LOW, asks the minimum, and is called out as not an investigation", guess.level === "LOW" && guess.action === "ASK_MINIMUM" && guess.confidence === 40 && guess.notes.some((n) => /only one hypothesis/.test(n)) && guess.notes.some((n) => /claimed 92% but the evidence supports 40%/.test(n)) && guess.questions.filter((x) => x.kept).length === 3);
    check("intent: a question that is not a confirm-or-correct is flagged for rephrasing, not dropped", assessIntent(ws, { ...base, questions: [q("What are you building here exactly?")] }).questions[0].reform === true);
}
// ============================================================ 6. does discovery improve understanding? confidence before and after
{
    const { ws, git } = repo();
    write(ws, "svc/A.java", "class A {}\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    write(ws, "svc/A.java", "class A { int x; }\n");
    const first = recordDraftContext(ws, { prefix: "BE", title: "Add field to A", entries: [{ kind: "intent", text: "Add a counter field to A for reporting", status: "INFERRED", source: "svc/A.java:1" }], files: ["svc/A.java"], confidence: { stage: "inferred", intent: 62, coverage: 20, note: "from the diff alone" } }, true);
    const second = recordDraftContext(ws, { ref: first.ref, title: "Add field to A", entries: [{ kind: "intent", text: "Add a counter field to A for reporting", status: "CONFIRMED", confirmed_by: "yes, for the usage report" }], confidence: { stage: "confirmed", intent: 91, note: "the developer confirmed" } }, true);
    check("progression: confidence is logged at each stage with its coverage and note", second.progression.length === 2 && second.progression[0].stage === "inferred" && second.progression[0].intent === 62 && second.progression[1].stage === "confirmed" && second.progression[1].intent === 91);
    check("progression: the readable draft shows the change from the first estimate", /inferred: intent 62%, coverage 20%/.test(fs.readFileSync(path.join(ws, second.md), "utf8")) && /\+29 points from the first estimate/.test(fs.readFileSync(path.join(ws, second.md), "utf8")));
    const d = discoverReviewContext(ws);
    check("progression: the next review sees the progression of the earlier draft, so it can tell whether discovery improved understanding", d.drafts[0]?.confidence_log?.length === 2 && /inferred 62% → confirmed 91%/.test(renderContext(d)));
    let bad = false;
    try {
        recordDraftContext(ws, { ref: first.ref, title: "x y z", entries: [], confidence: { stage: "final", intent: 150 } }, true);
    }
    catch {
        bad = true;
    }
    check("progression: a confidence outside 0 to 100 is refused", bad);
}
// ============================================================ 7. the two modes
{
    const { ws, git } = repo();
    write(ws, "svc/pom.xml", "<project/>");
    write(ws, "svc/A.java", "class A {}\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    git("checkout", "-q", "-b", "bugfix/BUG-1230-owner-transfer");
    write(ws, "svc/A.java", "class A { int x; }\n");
    write(ws, ".secufusion/tasks/BUG-1230-owner-transfer/spec.json", JSON.stringify({ acceptance_criteria: ["a", "b"] }));
    write(ws, ".secufusion/tasks/BUG-1230-owner-transfer/files-touched.json", JSON.stringify([{ file_path: "svc/A.java" }]));
    write(ws, ".secufusion/tasks/STORY-5-no-spec/notes.md", "# notes\n");
    write(ws, ".secufusion/tasks/BE-TASK-D001-draft-old/context.draft.json", JSON.stringify({ title: "old", files: [], entries: [] }));
    const m1 = discoverReviewContext(ws, { work_item: "BUG-1230" }).mode;
    check("mode 1: a work item whose task folder holds a specification is an Existing Task Review, with the folder and the criteria count", m1.mode === 1 && m1.name === "EXISTING_TASK" && m1.task_folder === ".secufusion/tasks/BUG-1230-owner-transfer" && m1.acceptance_criteria === 2 && m1.missing.length === 0 && /Mode 1: Existing Task Review/.test(m1.label), JSON.stringify(m1));
    check("mode 1: a bare number still finds the task (the number is the identity), and the reference is kept as given", discoverReviewContext(ws, { work_item: "1230" }).mode.mode === 1);
    const noSpec = discoverReviewContext(ws, { work_item: "STORY-5" }).mode;
    check("mode 2: a task folder with no specification is a Context Discovery Review: the reference is confirmed, the rest is not", noSpec.mode === 2 && noSpec.ref === "STORY-5" && noSpec.missing.includes("specification") && /CONFIRMED reference/.test(noSpec.why) && /STORY-5/.test(noSpec.task_folder ?? ""), JSON.stringify(noSpec));
    const none = discoverReviewContext(ws, { work_item: "BUG-9999" }).mode;
    check("mode 2: a reference that names no task here is a Context Discovery Review, never an invented specification", none.mode === 2 && none.missing.includes("task folder") && none.ref === "BUG-9999");
    const clash = discoverReviewContext(ws, { work_item: "TASK-1230" }).mode;
    check("identity: the same number under a different type is an IDENTITY CONFLICT, not a choice and not Mode 1", clash.mode === 2 && /same number under a different type/.test(clash.conflict ?? "") && /Do not choose/.test(clash.conflict ?? "") && clash.task_folder === undefined, JSON.stringify(clash));
    const dflt = discoverReviewContext(ws);
    check("mode 2: with no work item the review is a Context Discovery Review, and a task that explains the diff is PROPOSED, never adopted", dflt.mode.mode === 2 && dflt.mode.proposed_switch?.ref === "BUG-1230" && /files are in this change|reference BUG-1230/.test(dflt.mode.proposed_switch?.why ?? "") && dflt.mode.ref === undefined, JSON.stringify(dflt.mode));
    check("modes: the report opens with the mode and why, and a draft folder is never mistaken for a task", /^# Mode 2: Context Discovery Review/.test(renderContext(dflt)) && /Proposed switch to Mode 1: BUG-1230/.test(renderContext(dflt)) && /^# Mode 1: Existing Task Review/.test(renderContext(discoverReviewContext(ws, { work_item: "BUG-1230" }))) && discoverReviewContext(ws, { work_item: "D001" }).mode.mode === 2);
}
console.log(failures === 0 ? "\nAll context-discovery checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
