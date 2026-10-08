import { savePlan, validatePlan } from "./implementation_plan.js";
import { generateTestObligations, aggregateValidation } from "./validation_engine.js";
import { recordExperience, loadExperience } from "./experience_manager.js";
import { saveRequirement } from "./requirement_manager.js";
import { saveTraceability } from "./traceability_engine.js";
import { performFullExtraction } from "./shared.js";
import fs from 'fs';
import path from 'path';
const ecosystemRoot = "c:\\Users\\Yash\\Desktop\\mcp";
function setupRequirement(id, title, status, decisions = []) {
    const req = {
        id,
        title,
        status,
        raw_request: title,
        clarification_questions: [],
        decisions
    };
    saveRequirement(ecosystemRoot, req);
}
function runPhase4Benchmark() {
    console.log("=== RUNNING PHASE 4 VALIDATION BENCHMARK ===");
    // 1. Initial State Setup
    const stats = performFullExtraction(ecosystemRoot);
    const dnaPath = path.join(ecosystemRoot, ".secufusion", "dna.json");
    const dna = JSON.parse(fs.readFileSync(dnaPath, "utf-8"));
    const graph = dna.graph;
    saveTraceability(ecosystemRoot, []);
    // 2. Retention Benchmark (Destructive Operation without Explicit Decision)
    console.log("\\n--- RETENTION: Destructive Operation Guardrails ---");
    setupRequirement("REQ-RET-2", "Implement retention policy cleanup", "CONFIRMED"); // No decisions array has "cleanup"
    let planRet = {
        id: "PLAN-RET",
        requirement_id: "REQ-RET-2",
        status: "DRAFT",
        summary: "Delete old events",
        affected_services: ["sfn-events-api"],
        affected_files: [],
        api_changes: [],
        database_changes: [],
        event_changes: [],
        frontend_changes: [],
        extension_changes: [],
        security_implications: [],
        implementation_steps: ["cleanup events older than 30 days"], // destructive keyword
        test_obligations: ["Test deletion limits"],
        validation_requirements: [],
        traceability_requirements: [],
        risks: [],
        assumptions: [],
        unknowns: [],
        blockers: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        snapshot_id: "LATEST"
    };
    savePlan(ecosystemRoot, planRet);
    let errorsRet = validatePlan(ecosystemRoot, planRet);
    console.log("Validation Errors (No Decision):", errorsRet);
    let validationRet = aggregateValidation("CONFIRMED", errorsRet, [], [], [], false);
    console.log("Overall State (No Decision):", validationRet.overall);
    // Now with explicit decision
    setupRequirement("REQ-RET-2", "Implement retention policy cleanup", "CONFIRMED", ["Authorized to cleanup old events"]);
    errorsRet = validatePlan(ecosystemRoot, planRet);
    console.log("Validation Errors (With Decision):", errorsRet);
    validationRet = aggregateValidation("CONFIRMED", errorsRet, [], [], [], false);
    console.log("Overall State (With Decision):", validationRet.overall);
    // 3. User Deletion Benchmark (Test Obligations)
    console.log("\\n--- USER DELETION: Test Intelligence ---");
    setupRequirement("REQ-DEL-2", "User Deletion Feature", "CONFIRMED");
    let planDel = {
        id: "PLAN-DEL",
        requirement_id: "REQ-DEL-2",
        status: "DRAFT",
        summary: "Delete user via API",
        affected_services: ["sfn-iam-api"],
        affected_files: [],
        api_changes: ["DELETE /users/{id}"],
        database_changes: ["DELETE cascade on users table"],
        event_changes: ["Produce user-deleted event"],
        frontend_changes: [],
        extension_changes: [],
        security_implications: ["Requires admin scope"],
        implementation_steps: ["Perform deletion"],
        test_obligations: [],
        validation_requirements: [],
        traceability_requirements: [],
        risks: [],
        assumptions: [],
        unknowns: [],
        blockers: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        snapshot_id: "LATEST"
    };
    const generatedTests = generateTestObligations(planDel);
    console.log("Auto-Generated Test Obligations:");
    generatedTests.forEach(t => console.log("-", t));
    // Missing test obligations validation check
    let errorsDel = validatePlan(ecosystemRoot, planDel);
    console.log("Validation Errors (Missing Tests in Plan):", errorsDel);
    let validationDel = aggregateValidation("CONFIRMED", errorsDel, [], [], [], false);
    console.log("Overall State (Missing Tests):", validationDel.overall);
    // 4. Stale Evidence Check
    console.log("\\n--- STALE EVIDENCE ---");
    planDel.test_obligations = generatedTests;
    planDel.created_at = new Date(Date.now() - 100000).toISOString(); // Make it older than last extraction
    savePlan(ecosystemRoot, planDel);
    let errorsStale = validatePlan(ecosystemRoot, planDel);
    console.log("Validation Errors (Stale Plan):", errorsStale);
    let validationStale = aggregateValidation("CONFIRMED", errorsStale, [], [], [], false);
    console.log("Overall State (Stale):", validationStale.overall);
    // 5. Experience Persistence
    console.log("\\n--- EXPERIENCE PERSISTENCE ---");
    const exp = recordExperience(ecosystemRoot, {
        id: "EXP-1",
        category: "ANTI_PATTERN",
        title: "Silent Deletion",
        summary: "Never delete users without producing a user-deleted event.",
        lesson: "Never delete users without producing a user-deleted event.",
        context: "Discovered during User Deletion Phase 4 benchmark",
        related_artifacts: []
    });
    console.log("Recorded Experience ID:", exp.id);
    const loadedExp = loadExperience(ecosystemRoot);
    console.log("Loaded Experiences:", loadedExp.length);
    console.log("Experience Title:", loadedExp[0].title);
}
try {
    runPhase4Benchmark();
}
catch (e) {
    console.error("Benchmark failed:", e);
    process.exit(1);
}
