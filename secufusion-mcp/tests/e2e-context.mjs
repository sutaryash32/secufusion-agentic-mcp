import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";

/**
 * Context discovery through the real server, on a real git repository: the model is asked to INVESTIGATE (competing
 * hypotheses, evidence, what it would read next), its citations are verified against the code, the confidence is set by
 * the evidence and not by the claim, the questions are cut to what the protocol allows, and the confidence progression is
 * recorded so it can be measured whether discovery actually improved understanding.
 */
const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..").split(path.sep).join("/");
const SDK = `${PKG}/node_modules/@modelcontextprotocol/sdk/dist/esm`;
const { Client } = await import(pathToFileURL(`${SDK}/client/index.js`).href);
const { StdioClientTransport } = await import(pathToFileURL(`${SDK}/client/stdio.js`).href);
const { createEntry } = await import(pathToFileURL(`${PKG}/mcp/dist/project_knowledge.js`).href);

let failures = 0;
const check = (name, cond, detail = "") => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + String(detail).slice(0, 500)}`);
    if (!cond) failures++;
};
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ctxe2e-"));
const git = (...a) => execFileSync("git", ["-C", ws, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const write = (rel, content) => { const p = path.join(ws, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };

git("init", "-q"); git("symbolic-ref", "HEAD", "refs/heads/main");
write("svc/pom.xml", "<project/>");
write("svc/src/UserService.java", "package x;\npublic class UserService {\n    public void transferOwnership(String t, Long n) {\n        log.info(\"x\");\n    }\n}\n");
git("add", "."); git("commit", "-q", "-m", "init");
createEntry(ws, { category: "invariants", title: "Exactly one IT Admin per tenant", body: "A tenant always has exactly one active IT Admin.", tags: ["owner", "transfer", "tenant"], source: "BUG-1288", status: "accepted", extra: { fields: "defaultUser", enforcement: "code check only" } });
git("checkout", "-q", "-b", "bugfix/owner-transfer-guard");
write("svc/src/UserService.java", "package x;\npublic class UserService {\n    public void transferOwnership(String t, Long n) {\n        requireSingleActiveOwner(t);\n        owner.setDefaultUser(false);\n        next.setDefaultUser(true);\n    }\n}\n");

const c = new Client({ name: "ctx", version: "1" }, { capabilities: {} });
await c.connect(new StdioClientTransport({ command: "node", args: [`${PKG}/mcp/dist/server.js`, "--root", ws], cwd: PKG }));
const call = async (name, args) => { const r = await c.callTool({ name, arguments: args }); return { text: r.content[0].text, error: !!r.isError }; };

// 1. discovery shows what the product says about the diff
const disc = await call("discover_review_context", { workspace_root: ws });
check("discovery: the report lists the sources, the coverage score, and what the product says about this diff", /Context completeness report/.test(disc.text) && /Coverage score: \d+%/.test(disc.text) && /What the product says about this diff/.test(disc.text) && /writes defaultUser/.test(disc.text) && /No question has been asked yet/.test(disc.text), disc.text.slice(0, 400));

// 2. the model is asked to investigate, with the evidence it needs
const ask = await call("reason_about_intent", { workspace_root: ws });
check("reasoning: the model is asked for competing hypotheses and an investigation, not a form", /JUDGMENT REQUIRED/.test(ask.text) && /intent-reasoning/.test(ask.text) && /at least two competing hypotheses/.test(ask.text) && /Investigate before you ask/.test(ask.text) && /"hypotheses"/.test(ask.text), ask.text.slice(0, 300));
check("reasoning: the evidence carries the diff, the product's invariant and the authority field the diff writes", /setDefaultUser/.test(ask.text) && /Exactly one IT Admin per tenant/.test(ask.text) && /investigate beyond it/.test(ask.text) && /requireSingleActiveOwner/.test(ask.text));
check("reasoning: asking writes nothing", !fs.existsSync(path.join(ws, ".secufusion")));

// 3. the model answers; the tool verifies and applies the protocol
const real = { file: "svc/src/UserService.java", line: 4, quote: "requireSingleActiveOwner(t)" };
const judgment = JSON.stringify({
    hypotheses: [
        { id: "H1", statement: "The developer is closing a gap: the transfer path did not check that the tenant keeps exactly one active owner", work_type: "Bug Fix", confidence: 88, supports: [real, { file: "svc/src/UserService.java", line: 5, quote: "owner.setDefaultUser(false)" }], would_confirm: "a test that transfers with no active target" },
        { id: "H2", statement: "The developer is adding a new handover feature for owners", work_type: "Enhancement", confidence: 80, supports: [{ file: "svc/src/UserService.java", line: 9, quote: "handoverFeature()" }] },
    ],
    leading: "H1",
    intent: { problem: "transfer could leave the tenant without exactly one active owner", work_type: "Bug Fix", domain: "ownership", outcome: "an owner transfer keeps the invariant", services: ["svc"] },
    confidence: 97,
    investigated: ["svc/src/UserService.java", "the branch name", "the recorded invariant"],
    investigate_next: [{ what: "read deleteUser", why: "it may bypass the same guard", how: "grep for deleteUser callers" }],
    questions: [
        { question: "I believe a transfer to an inactive user must be refused; confirm or correct.", why_needed: "decides the guard's condition", why_not_inferable: "I read the guard and the invariant, neither says what status the new owner must have", confidence_impact: "+8 points" },
        { question: "What about audit logs?", why_needed: "scope", why_not_inferable: "unsure", confidence_impact: "small" },
        { question: "I believe groups are kept after a transfer; confirm or correct.", why_needed: "membership", why_not_inferable: "I searched the decisions and found nothing about group membership after a transfer", confidence_impact: "+5 points" },
        { question: "I believe the Keycloak side is unchanged; confirm or correct.", why_needed: "sync", why_not_inferable: "I did not find a Keycloak call in the diff, and the service has several", confidence_impact: "+4 points" },
    ],
    risks: [{ risk: "deleteUser may bypass the guard the transfer now has", source: "recorded invariant exactly-one-it-admin-per-tenant (code check only)" }],
    assumptions: ["requireSingleActiveOwner throws when the target is inactive"],
});
const done = await call("reason_about_intent", { workspace_root: ws, judgment, format: "json" });
const r = JSON.parse(done.text);
check("verified: the leading hypothesis is verified against the code, the fabricated runner-up is capped at 40", r.assessment.leading.verified === 88 && r.assessment.leading.verified_supports === 2 && r.assessment.runner_up.verified === 40, JSON.stringify(r.assessment.leading));
check("verified: the confidence comes from the evidence (88), not from the model's claim (97), and the level is HIGH", r.assessment.confidence === 88 && r.assessment.level === "HIGH" && r.assessment.action === "PROCEED", JSON.stringify([r.assessment.confidence, r.assessment.level]));
check("protocol: at HIGH confidence only optional confirmations survive; a vague question and one over the limit are withheld",
    r.assessment.questions.filter((q) => q.kept).length === 2 && r.assessment.questions.find((q) => q.question === "What about audit logs?").kept === false && r.assessment.questions[3].kept === false, JSON.stringify(r.assessment.questions.map((q) => [q.kept, q.reason])));
check("reasoning: the investigation list and the risks with their source are carried through", r.assessment.investigate_next[0].what === "read deleteUser" && r.assessment.risks[0].source.includes("exactly-one-it-admin"));
check("reasoning: judging writes nothing to the workspace", !fs.existsSync(path.join(ws, ".secufusion")));

const text = (await call("reason_about_intent", { workspace_root: ws, judgment })).text;
check("reasoning: the readable report says who reasoned, shows the questions to ask and the ones withheld, and points at recording the confidence", /Intent reasoning: HIGH confidence \(88%\)/.test(text) && /Questions to ask \(2\)/.test(text) && /Questions withheld \(2\)/.test(text) && /citations verified against the code/.test(text) && /record_draft_task_context/.test(text), text.slice(0, 300));
const bad = await call("reason_about_intent", { workspace_root: ws, judgment: JSON.stringify({ hypotheses: [{ id: "H1", statement: "short", confidence: 200 }] }) });
check("reasoning: a verdict that does not match the schema is refused with the shape", /does not match the required schema/.test(bad.text));

// 4. the progression: before and after the developer answers
const first = await call("record_draft_task_context", { workspace_root: ws, prefix: "BE", title: "Owner transfer guard", entries: [{ kind: "intent", text: "Close the gap in the owner guard on the transfer path", status: "INFERRED", source: "svc/src/UserService.java:4" }], files: ["svc/src/UserService.java"], confidence: { stage: "inferred", intent: r.assessment.confidence, coverage: r.coverage }, apply: true, format: "json" });
const ref = JSON.parse(first.text).ref;
await call("record_draft_task_context", { workspace_root: ws, ref, title: "Owner transfer guard", entries: [{ kind: "intent", text: "Close the gap in the owner guard on the transfer path", status: "CONFIRMED", confirmed_by: "yes, that is exactly the bug" }], confidence: { stage: "confirmed", intent: 96, note: "the developer confirmed" }, apply: true });
const again = await call("discover_review_context", { workspace_root: ws });
check("progression: the next review sees how confidence moved when the developer confirmed (inferred, then confirmed)", /Confidence progression of BE-TASK-D001: inferred 88% → confirmed 96%/.test(again.text), again.text.slice(-600));

await c.close();
console.log(failures === 0 ? "\nAll context e2e checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
