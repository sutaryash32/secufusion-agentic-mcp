import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { Requirement, RequirementStatus, saveRequirement, loadRequirement, validateStateTransition, explorationReadiness } from "./requirement_manager.js";
import {
    setUiImpact, askUserDecision, answerUserDecision, createUiReference, recordUiFeedback, explorationStatus,
    explorationSummary, ExplorationError, verifyEvidence,
} from "./exploration.js";
import { loadTraceability, findTraceabilityGaps } from "./traceability_engine.js";
import { loadDesignMetadata } from "./ui_intelligence.js";

/**
 * Phase 12: interactive exploration. Deterministic scenarios A-F.
 * The fixture is a synthetic repo used only to exercise the state machine; it is not repository evidence.
 */

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + detail}`);
    if (!cond) failures++;
}
function throws(fn: () => unknown, includes: string): boolean {
    try { fn(); return false; } catch (e: any) { return String(e.message).includes(includes); }
}
function canConfirm(root: string, id: string): { ok: boolean; why: string } {
    const req = loadRequirement(root, id)!;
    try { validateStateTransition(req.status, "CONFIRMED", req); return { ok: true, why: "" }; }
    catch (e: any) { return { ok: false, why: e.message }; }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "phase12-"));
const SRC = {
    "sfn-web-ui/src/components/DeleteDeviceUserDialog.jsx": "export const Dialog = () => 'Devices';\n",
    "sfn-iam-api/src/DeviceUserDeletionSummary.java": "class DeviceUserDeletionSummary { int devices; }\n",
};
for (const [rel, body] of Object.entries(SRC)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
}
function productionHash(): string {
    const h = crypto.createHash("sha256");
    const walk = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            if (e.name === ".secufusion") continue;
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p); else h.update(p + fs.readFileSync(p));
        }
    };
    walk(root);
    return h.digest("hex");
}
function newReq(id: string, status: RequirementStatus = "INVESTIGATING"): void {
    saveRequirement(root, { id, title: id, raw_request: id, status, clarification_questions: [] } as Requirement);
}
const html = (label: string) => `<html><head><style>body{font-family:sans-serif}</style></head><body><h2>Delete User</h2><ul><li>${label} 3</li></ul><button onclick="this.textContent='clicked'">Delete</button></body></html>`;
const before = productionHash();

// ── Scenario A: backend-only bug, no UI, no decisions ──────────────────────
{
    newReq("A", "RAW");
    check("A: RAW cannot jump to CONFIRMED", throws(() => validateStateTransition("RAW", "CONFIRMED", loadRequirement(root, "A")!), "Invalid transition"));
    check("A: cannot assess UI impact before investigating", throws(() => setUiImpact(root, "A", { impact: "NO", rationale: "x" }), "Investigate the repository first"));
    newReq("A");
    check("A: CONFIRMED blocked while UI impact unassessed", !canConfirm(root, "A").ok && canConfirm(root, "A").why.includes("UI impact has not been assessed"));
    const r = setUiImpact(root, "A", { impact: "NO", rationale: "Pure Kafka consumer fix; no screen reads it", evidence: ["sfn-iam-api/src/DeviceUserDeletionSummary.java"] });
    check("A: no-UI keeps INVESTIGATING, no warnings", r.status === "INVESTIGATING" && r.warnings.length === 0);
    check("A: confirmable with no UI design", canConfirm(root, "A").ok, canConfirm(root, "A").why);
    check("A: no design directory created", !fs.existsSync(path.join(root, ".secufusion", "designs")));
}

// ── Scenario B: UI bug, reference, user approves ───────────────────────────
{
    newReq("B");
    check("B: UI reference refused before UI impact is assessed", throws(() => createUiReference(root, "B", { title: "t", html: html("Browsers") , evidence: ["x"] }), "Assess UI impact first"));
    const imp = setUiImpact(root, "B", { impact: "YES", rationale: "Dialog label wrong", affected_components: ["DeleteDeviceUserDialog"], evidence: ["sfn-web-ui/src/components/DeleteDeviceUserDialog.jsx", "does/not/exist.jsx"] });
    check("B: YES moves to UI_DESIGN_REQUIRED", imp.status === "UI_DESIGN_REQUIRED");
    check("B: nonexistent evidence path flagged, real one not", imp.warnings.length === 1 && imp.warnings[0].includes("does/not/exist.jsx") && !imp.warnings[0].includes("DeleteDeviceUserDialog"));
    check("B: cannot confirm without a reference", !canConfirm(root, "B").ok);
    check("B: must cite existing UI or give novelty_reason", throws(() => createUiReference(root, "B", { title: "t", html: html("Browsers") }), "Inspect existing UI first"));
    const ref = createUiReference(root, "B", { title: "Delete user", html: html("Browsers"), evidence: ["sfn-web-ui/src/components/DeleteDeviceUserDialog.jsx"] });
    check("B: reference moves to USER_FEEDBACK_REQUIRED", ref.status === "USER_FEEDBACK_REQUIRED");
    const meta = loadDesignMetadata(root, "DESIGN-B")!;
    check("B: metadata is REFERENCE_ONLY / NOT_IMPLEMENTED and linked to the requirement", meta.status === "REFERENCE_ONLY" && meta.implementationStatus === "NOT_IMPLEMENTED" && meta.requirementId === "B" && meta.revision === 1);
    const page = fs.readFileSync(ref.index_path, "utf-8");
    check("B: page shows REFERENCE_ONLY banner and a CSP", page.includes("REFERENCE_ONLY") && page.includes("NOT_PRODUCTION_CODE") && page.includes("Content-Security-Policy"));
    check("B: not confirmable before the user reviews it", !canConfirm(root, "B").ok && canConfirm(root, "B").why.includes("not been reviewed"));
    check("B: approval without the user's words is refused", throws(() => recordUiFeedback(root, "B", { outcome: "APPROVED", user_statement: "  " }), "user_statement is required"));
    const fb = recordUiFeedback(root, "B", { outcome: "APPROVED", user_statement: "Yes, that's right, ship that wording" });
    check("B: approval leaves nothing outstanding", fb.status === "INVESTIGATING" && canConfirm(root, "B").ok, canConfirm(root, "B").why);
    const edges = loadTraceability(root);
    check("B: traceability links requirement -> design (user confirmed) -> component", edges.some(e => e.source === "REQUIREMENT:B" && e.target === "DESIGN:DESIGN-B" && e.provenance === "USER_CONFIRMED" && e.confidence === "CONFIRMED") && edges.some(e => e.source === "DESIGN:DESIGN-B" && e.target === "FRONTEND_COMPONENT:DeleteDeviceUserDialog"));
    check("B: reviewer/planner summary exposes the design as NOT_IMPLEMENTED", explorationSummary(root, "B")!.ui_reference!.implementation_status === "NOT_IMPLEMENTED");
}

// ── Scenario C: ambiguity -> USER_DECISION_REQUIRED -> STOP ────────────────
{
    newReq("C");
    setUiImpact(root, "C", { impact: "NO", rationale: "label is server-side" });
    const q = askUserDecision(root, "C", { category: "ux", question: "devices means browser installs. Which wording?", options: ["Browser / Browsers", "Device / Devices", "Both"] });
    check("C: status becomes USER_DECISION_REQUIRED", q.status === "USER_DECISION_REQUIRED");
    check("C: needs at least two options", throws(() => askUserDecision(root, "C", { category: "ux", question: "q", options: ["only one"] }), "at least two"));
    check("C: CONFIRMED refused with the decision named", canConfirm(root, "C").why.includes("USER_DECISION_REQUIRED") && canConfirm(root, "C").why.includes("UD-1"));
    check("C: answering without the user's words is refused", throws(() => answerUserDecision(root, "C", { decision_id: "UD-1", answer: "Browser / Browsers", user_statement: "" }), "user_statement is required"));
    check("C: still unresolved after the refused answer", loadRequirement(root, "C")!.status === "USER_DECISION_REQUIRED");
    const a = answerUserDecision(root, "C", { decision_id: "UD-1", answer: "Browser / Browsers", user_statement: "Use Browser/Browsers" });
    check("C: answer recorded and exploration continues", a.status === "INVESTIGATING" && (loadRequirement(root, "C")!.decisions || []).some(d => d.includes("Browser / Browsers")));
    check("C: decision is traced as user confirmed", loadTraceability(root).some(e => e.target === "DECISION:C:UD-1" && e.provenance === "USER_CONFIRMED"));
    check("C: answering twice is refused", throws(() => answerUserDecision(root, "C", { decision_id: "UD-1", answer: "x", user_statement: "y" }), "already answered"));
    check("C: confirmable once answered", canConfirm(root, "C").ok, canConfirm(root, "C").why);
}

// ── Scenario D: destructive semantics unresolved -> must not confirm ───────
{
    newReq("D");
    setUiImpact(root, "D", { impact: "NO", rationale: "API only" });
    askUserDecision(root, "D", { category: "deletion-retention", question: "Should user deletion cascade to audit records?", options: ["Hard delete audit records", "Keep audit records, anonymize user", "Block deletion if audit exists"], evidence: ["sfn-iam-api/src/DeviceUserDeletionSummary.java"] });
    check("D: cannot confirm with deletion semantics open", !canConfirm(root, "D").ok);
    check("D: the manage_requirement path cannot bypass it (status change)", throws(() => validateStateTransition("USER_DECISION_REQUIRED", "CONFIRMED", loadRequirement(root, "D")!), "USER_DECISION_REQUIRED"));
    check("D: readiness names the next action", explorationReadiness(loadRequirement(root, "D")!).next_action.includes("STOP"));
    answerUserDecision(root, "D", { decision_id: "UD-1", answer: "Keep audit records, anonymize user", user_statement: "Anonymize, never delete audit" });
    check("D: confirmable only after the user answered", canConfirm(root, "D").ok);
}

// ── Scenario E: user rejects the design, regenerate, confirm ───────────────
{
    newReq("E");
    setUiImpact(root, "E", { impact: "YES", rationale: "dialog", affected_components: ["DeleteDeviceUserDialog"] });
    createUiReference(root, "E", { title: "v1", html: html("Devices"), evidence: ["sfn-web-ui/src/components/DeleteDeviceUserDialog.jsx"] });
    check("E: changes need the feedback text", throws(() => recordUiFeedback(root, "E", { outcome: "CHANGES_REQUESTED", user_statement: "no" }), "needs the feedback"));
    const fb = recordUiFeedback(root, "E", { outcome: "CHANGES_REQUESTED", feedback: "Say Browsers, add Extensions row", user_statement: "Change it to Browsers and add extensions" });
    check("E: rejection returns to UI_DESIGN_REQUIRED and blocks confirmation", fb.status === "UI_DESIGN_REQUIRED" && !canConfirm(root, "E").ok);
    check("E: cannot approve a revision that was never regenerated", throws(() => recordUiFeedback(root, "E", { outcome: "APPROVED", user_statement: "ok" }), "no UI reference awaiting feedback"));
    const r2 = createUiReference(root, "E", { title: "v2", html: html("Browsers"), evidence: ["sfn-web-ui/src/components/DeleteDeviceUserDialog.jsx"] });
    check("E: regeneration bumps revision and keeps history", r2.metadata.revision === 2 && fs.existsSync(path.join(root, ".secufusion/designs/DESIGN-E/revisions/r1.html")) && fs.existsSync(path.join(root, ".secufusion/designs/DESIGN-E/revisions/r2.html")));
    check("E: feedback is carried in the design decisions", (loadDesignMetadata(root, "DESIGN-E")!.decisions || []).some(d => d.includes("Say Browsers")));
    recordUiFeedback(root, "E", { outcome: "APPROVED", user_statement: "That's it" });
    check("E: confirmable after approving the revision", canConfirm(root, "E").ok, canConfirm(root, "E").why);

    newReq("E2");
    setUiImpact(root, "E2", { impact: "YES", rationale: "dialog", affected_components: ["X"] });
    recordUiFeedback(root, "E2", { outcome: "NO_UI_REQUIRED", user_statement: "No mockup needed, just fix the text" });
    check("E: user can explicitly waive the reference", canConfirm(root, "E2").ok, canConfirm(root, "E2").why);
    newReq("E3");
    setUiImpact(root, "E3", { impact: "NO", rationale: "r" });
    check("E: NO_UI_REQUIRED only valid when UI impact is YES", throws(() => recordUiFeedback(root, "E3", { outcome: "NO_UI_REQUIRED", user_statement: "x" }), "only applies when ui_impact is YES"));
}

// ── Scenario F: production code is never touched; references are safe ──────
{
    check("F: no production file changed by any scenario", productionHash() === before);
    const dirs = fs.readdirSync(root).filter(n => n !== ".secufusion").sort();
    check("F: nothing created outside .secufusion", JSON.stringify(dirs) === JSON.stringify(["sfn-iam-api", "sfn-web-ui"]), dirs.join(","));
    newReq("F");
    setUiImpact(root, "F", { impact: "YES", rationale: "r", affected_components: ["X"] });
    const bad: Array<[string, string]> = [
        ["fetch", `<html><body><script>fetch('/api/users')</script></body></html>`],
        ["external script", `<html><body><script src="https://evil.example/x.js"></script></body></html>`],
        ["external image", `<html><body><img src="https://evil.example/p.png"></body></html>`],
        ["css url", `<html><body style="background:url(http://evil.example/a.png)"></body></html>`],
        ["iframe", `<html><body><iframe src="a.html"></iframe></body></html>`],
        ["storage", `<html><body><script>localStorage.setItem('a','b')</script></body></html>`],
        ["javascript url", `<html><body><a href="javascript:alert(1)">x</a></body></html>`],
        ["oversized", `<html><body>${"x".repeat(250_000)}</body></html>`],
    ];
    for (const [name, h] of bad) {
        check(`F: unsafe reference rejected (${name})`, throws(() => createUiReference(root, "F", { title: "t", html: h, evidence: ["a/b.jsx"] }), "Unsafe or oversized"));
    }
    check("F: path-traversal design id rejected", throws(() => createUiReference(root, "F", { title: "t", html: html("x"), evidence: ["a/b.jsx"], design_id: "../../sfn-web-ui/src/x" }), "Invalid design id"));
    check("F: rejected references wrote nothing and did not register", !fs.existsSync(path.join(root, ".secufusion/designs/DESIGN-F")) && !loadRequirement(root, "F")!.ui_reference);
    check("F: still no production change after the attack attempts", productionHash() === before);
    check("F: evidence verification distinguishes real, missing and non-path", JSON.stringify(verifyEvidence(root, ["sfn-web-ui/src/components/DeleteDeviceUserDialog.jsx:12", "nope/missing.java", "FACT: counts browsers"]).map(e => e.exists)) === "[true,false,null]");
}

// ── Traceability gaps ──────────────────────────────────────────────────────
{
    newReq("G");
    setUiImpact(root, "G", { impact: "YES", rationale: "r", affected_components: ["X"] });
    // force a CONFIRMED record with an unreviewed reference to prove the gap detector notices it
    const g = loadRequirement(root, "G")!;
    g.status = "CONFIRMED"; g.ui_reference = { design_id: "DESIGN-G", status: "AWAITING_FEEDBACK", revision: 1, updated_at: "" };
    saveRequirement(root, g);
    const gaps = findTraceabilityGaps(root, { nodes: [], edges: [] } as any, loadTraceability(root));
    check("G: CONFIRMED requirement with unreviewed UI reference is a traceability gap", gaps.some((x: any) => x.type === "UI_REFERENCE_NOT_CONFIRMED" && x.id === "REQUIREMENT:G"));
    const st = explorationStatus(root, "B");
    check("status: reports readiness and design for the handoff", st.readiness.ready === true && st.design?.designId === "DESIGN-B");
}

fs.rmSync(root, { recursive: true, force: true });
console.log(failures === 0 ? "\nPHASE 12 BENCHMARK: ALL PASS" : `\nPHASE 12 BENCHMARK: ${failures} FAILED`);
process.exit(failures ? 1 : 0);
