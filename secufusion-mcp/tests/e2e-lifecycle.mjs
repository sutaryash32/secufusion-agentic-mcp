import { fileURLToPath } from "url";
import nodePath from "path";
const PKG = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "..").split(nodePath.sep).join("/");
import fs from "fs";
import { execFileSync } from "child_process";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";

const SDK = `${PKG}/node_modules/@modelcontextprotocol/sdk/dist/esm`;
const { Client } = await import(pathToFileURL(`${SDK}/client/index.js`).href);
const { StdioClientTransport } = await import(pathToFileURL(`${SDK}/client/stdio.js`).href);
const { CreateMessageRequestSchema } = await import(pathToFileURL(`${SDK}/types.js`).href);

const SERVER = `${PKG}/mcp/dist/server.js`;
let failures = 0;
const check = (name, cond, detail = "") => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + detail}`);
    if (!cond) failures++;
};

function makeWorkspace() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2etmp-"));
    fs.writeFileSync(path.join(dir, ".secufusion-project-spec.json"), JSON.stringify({
        microservices: { "sfn-iam-api": { calls_services: [], owns_tables: ["users"], kafka_consumes: [] } },
        golden_rules: ["tenantId on every query"],
    }));
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    // A real git repo with a CRLF source file, so the diff-quality gate has something to measure.
    fs.writeFileSync(path.join(dir, "big.ts"), bigFile(CRLF, -1));
    const g = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    g("init", "-q", "-b", "main"); g("config", "user.name", "t"); g("config", "user.email", "t@t"); g("config", "core.autocrlf", "false");
    g("add", "-A"); g("commit", "-q", "-m", "base");
    return dir;
}
const CRLF = String.fromCharCode(13, 10);
const LF = String.fromCharCode(10);
const bigFile = (eol, editedLine) => Array.from({ length: 300 }, (_, i) => `const v${i} = ${i === editedLine ? "'changed'" : i};`).join(eol) + eol;

async function connect(dir, { sampling } = {}) {
    const client = new Client({ name: "e2e", version: "1" }, { capabilities: sampling ? { sampling: {} } : {} });
    if (sampling) client.setRequestHandler(CreateMessageRequestSchema, async (req) => {
        const prompt = req.params.messages[0].content.text;
        const kind = /## Judgment: (\w+)/.exec(prompt)?.[1];
        return { model: "fake", role: "assistant", content: { type: "text", text: "```json\n" + JSON.stringify(SAMPLING[kind]) + "\n```" } };
    });
    await client.connect(new StdioClientTransport({ command: "node", args: [SERVER, "--root", dir], cwd: dir }));
    return client;
}
const call = async (c, name, args) => {
    const r = await c.callTool({ name, arguments: args });
    return { err: !!r.isError, text: r.content.map((x) => x.text).join("\n") };
};

const V = {
    philosophy: { verdict: "PASS", why: "w", who: "PM", what: "s", risk: "r", questions_for_user: [] },
    classification: { classification: "BACKEND_ONLY", confidence: "HIGH", root_cause_location: "sfn-iam-api", reasoning: "q", services_in_scope: ["sfn-iam-api"], breaking_change_risks: [], needs_user_confirmation: false },
    requirement: { verdict: "READY", summary: "clear", missing: [], acceptance_criteria_testable: true },
    plan: { verdict: "APPROVED", summary: "ok", ac_coverage: [{ criterion: "AC1", covered_by: ["step1"], covered: true }], scope_creep: [], destructive_operations: [], required_changes: [] },
    review: { verdict: "APPROVED", summary: "ok", criteria: [{ criterion: "AC1", status: "MET", evidence: ["Svc.java:10"] }], out_of_scope_changes: [], guardrail_violations: [] },
};
const SAMPLING = V;

// ── Mode 1: no sampling; the caller supplies judgments ─────────────────────
{
    const dir = makeWorkspace();
    const c = await connect(dir);
    const id = "WI-1";

    let r = await call(c, "manage_task", { action: "initialize", work_item_id: id, title: "T" });
    check("initialize blocked before philosophy", r.err && r.text.includes("SPEC GATE"), r.text);

    r = await call(c, "spec_create_intent", { work_item_id: id, title: "T", business_goal: "g", acceptance_criteria: ["AC1"] });
    check("intent blocked before philosophy", r.err && r.text.includes("SPEC GATE"), r.text);

    r = await call(c, "philosophy_check", { work_item_id: id, title: "T", description: "d", task_type: "feature" });
    check("philosophy returns needs_judgment (no sampling)", !r.err && r.text.includes("JUDGMENT REQUIRED"), r.text);
    check("nothing recorded yet", !fs.existsSync(path.join(dir, ".secufusion", "gates", "WI-1.json")));

    r = await call(c, "philosophy_check", { work_item_id: id, title: "T", description: "d", task_type: "feature", judgment: { verdict: "FAIL", why: "w", who: "w", what: "w", risk: "w", questions_for_user: [] } });
    check("FAIL without questions is rejected by schema", r.err && r.text.includes("schema"), r.text);

    r = await call(c, "philosophy_check", { work_item_id: id, title: "T", description: "d", task_type: "feature", judgment: JSON.stringify(V.philosophy) });
    check("philosophy PASS recorded (JSON-string judgment)", r.text.includes("PHILOSOPHY_PASS"), r.text);

    r = await call(c, "classify_task", { work_item_id: id, title: "T", description: "d", task_type: "feature" });
    check("classify blocked before intent", r.err && r.text.includes("intent"), r.text);

    r = await call(c, "spec_create_intent", { work_item_id: id, title: "T", business_goal: "g", acceptance_criteria: ["AC1"] });
    check("intent created after philosophy", !r.err && r.text.includes("Intent spec created"), r.text);

    r = await call(c, "classify_task", { work_item_id: id, title: "T", description: "d", task_type: "feature" });
    check("classify returns needs_judgment with heuristic prior", r.text.includes("JUDGMENT REQUIRED") && r.text.includes("heuristic_prior"), r.text.slice(0, 300));
    r = await call(c, "classify_task", { work_item_id: id, title: "T", description: "d", task_type: "feature", judgment: V.classification });
    check("classify decided by caller", r.text.includes("Classified by caller"), r.text.slice(0, 300));

    r = await call(c, "manage_task", { action: "initialize", work_item_id: id, title: "T", acceptance_criteria: ["AC1"] });
    check("task initialize allowed after philosophy+intent", !r.err, r.text.slice(0, 300));

    r = await call(c, "manage_requirement", { workspace_root: dir, id, action: "create", title: "T", raw_request: "do T" });
    r = await call(c, "manage_requirement", { workspace_root: dir, id, action: "update", status: "INVESTIGATING", acceptance_criteria: ["AC1"], scope: "s" });
    check("requirement -> INVESTIGATING", !r.err, r.text);
    r = await call(c, "manage_exploration", { workspace_root: dir, requirement_id: id, action: "set_ui_impact", impact: "NO", rationale: "backend only" });
    check("UI impact assessed", !r.err, r.text);
    r = await call(c, "manage_requirement", { workspace_root: dir, id, action: "update", status: "CONFIRMED" });
    check("CONFIRMED refused without assessment", r.err && r.text.includes("READY assessment"), r.text);
    r = await call(c, "manage_requirement", { workspace_root: dir, id, action: "assess", judgment: V.requirement });
    check("assess READY", r.text.includes("READY"), r.text);
    r = await call(c, "manage_requirement", { workspace_root: dir, id, action: "update", scope: "changed after assessment" });
    r = await call(c, "manage_requirement", { workspace_root: dir, id, action: "update", status: "CONFIRMED" });
    check("CONFIRMED refused when requirement changed after assessment", r.err && r.text.includes("changed after"), r.text);
    r = await call(c, "manage_requirement", { workspace_root: dir, id, action: "assess", judgment: V.requirement });
    r = await call(c, "manage_requirement", { workspace_root: dir, id, action: "update", status: "CONFIRMED" });
    check("CONFIRMED accepted after fresh assessment", !r.err, r.text);

    r = await call(c, "manage_implementation_plan", { workspace_root: dir, id: "PLAN-1", action: "create", requirement_id: id, summary: "s", implementation_steps: ["step1"], test_obligations: ["t1"] });
    check("plan created", !r.err, r.text);
    r = await call(c, "manage_task", { action: "complete", work_item_id: id });
    check("complete blocked before plan/review", r.err && r.text.includes("plan") && r.text.includes("review"), r.text);

    r = await call(c, "validate_implementation_plan", { workspace_root: dir, plan_id: "PLAN-1", judgment: V.plan });
    check("plan validated + gate recorded", r.text.includes('"plan_gate": "PASSED"'), r.text.slice(-400));

    r = await call(c, "verify_against_spec", { workspace_root: dir, work_item_id: id, judgment: { ...V.review, criteria: [{ criterion: "AC1", status: "MET", evidence: [] }] } });
    check("MET without evidence rejected", r.err && r.text.includes("evidence"), r.text);
    r = await call(c, "verify_against_spec", { workspace_root: dir, work_item_id: id, judgment: { ...V.review, criteria: [{ criterion: "something else", status: "MET", evidence: ["x"] }] } });
    check("review must cover every criterion", r.text.includes("CHANGES REQUIRED") && r.text.includes("AC1"), r.text);
    // The client's scenario: a small change that is committed as a whole-file CRLF -> LF rewrite.
    fs.writeFileSync(path.join(dir, "big.ts"), bigFile(LF, 5));
    r = await call(c, "verify_against_spec", { workspace_root: dir, work_item_id: id, judgment: V.review });
    check("model APPROVED is overridden by deterministic HIGH diff noise", r.text.includes("CHANGES REQUIRED") && r.text.includes("DIFF QUALITY") && r.text.includes("LINE_ENDING_CHANGE"), r.text.slice(0, 500));
    r = await call(c, "verify_against_spec", { workspace_root: dir, work_item_id: id, judgment: V.review, acknowledge_diff_quality: [{ file: "big.ts", finding: "LINE_ENDING_CHANGE", user_statement: " " }] });
    check("acknowledgement without the user's words is ignored", r.text.includes("CHANGES REQUIRED"), r.text.slice(0, 300));
    r = await call(c, "manage_task", { action: "complete", work_item_id: id });
    check("task cannot complete while the review gate is failed", r.err && r.text.includes("review"), r.text.slice(0, 300));
    r = await call(c, "verify_against_spec", { workspace_root: dir, work_item_id: id, judgment: V.review, acknowledge_diff_quality: [{ file: "big.ts", finding: "LINE_ENDING_CHANGE", user_statement: "Yes, we are deliberately normalizing this file to LF" }] });
    check("review approved once the user accepts the noise", r.text.includes("APPROVED") && !r.text.includes("CHANGES REQUIRED"), r.text.slice(0, 400));

    // normalize_line_endings: the file was CRLF at base and is now LF; the helper restores its own style.
    r = await call(c, "normalize_line_endings", { workspace_root: dir, files: ["big.ts"] });
    check("normalize preview names the file's own style and writes nothing", r.text.includes("would convert") && r.text.includes("CRLF") && fs.readFileSync(path.join(dir, "big.ts"), "utf8").indexOf(CRLF) === -1, r.text);
    r = await call(c, "normalize_line_endings", { workspace_root: dir, files: ["big.ts"], apply: true });
    check("normalize apply without the user's words is refused", r.err && r.text.includes("user_statement"), r.text);
    r = await call(c, "normalize_line_endings", { workspace_root: dir, files: ["big.ts"], apply: true, user_statement: "yes, put big.ts back to CRLF" });
    check("normalize apply with the user's words converts the file", r.text.includes("converted") && fs.readFileSync(path.join(dir, "big.ts"), "utf8").includes(CRLF), r.text);
    r = await call(c, "check_diff_quality", { workspace_root: dir });
    check("after the fix the diff is clean", r.text.includes("no diff-quality findings") || !r.text.includes("LINE_ENDING_CHANGE"), r.text.slice(0, 400));

    r = await call(c, "spec_status", { work_item_id: id });
    check("spec_status: all gates passed", r.text.includes("All gates passed"), r.text);
    r = await call(c, "manage_task", { action: "complete", work_item_id: id });
    check("task complete allowed", !r.err, r.text.slice(0, 300));
    await c.close();
}

// ── Mode 2: client supports sampling; no judgment params needed ────────────
{
    const dir = makeWorkspace();
    const c = await connect(dir, { sampling: true });
    const id = "WI-2";
    let r = await call(c, "philosophy_check", { work_item_id: id, title: "T", description: "d", task_type: "feature" });
    check("sampling: philosophy judged by sampling", r.text.includes("PHILOSOPHY_PASS") && r.text.includes("sampling"), r.text);
    r = await call(c, "spec_create_intent", { work_item_id: id, title: "T", business_goal: "g", acceptance_criteria: ["AC1"] });
    r = await call(c, "classify_task", { work_item_id: id, title: "T", description: "d", task_type: "feature" });
    check("sampling: classify judged by sampling", r.text.includes("Classified by sampling"), r.text.slice(0, 300));
    const stored = JSON.parse(fs.readFileSync(path.join(dir, ".secufusion", "judgments", id, "classification.json"), "utf-8"));
    check("sampling: judgment audit file written", stored.source === "sampling" && stored.verdict.classification === "BACKEND_ONLY");
    await c.close();
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures ? 1 : 0);
