import fs from 'fs';
import path from 'path';
import { savePlan, validatePlan } from "./implementation_plan.js";
import { generateTestObligations, aggregateValidation } from "./validation_engine.js";
import { executeTests, ingestTestResults, loadTestResults, correlateTestFailure } from "./test_engine.js";
import { saveRequirement } from "./requirement_manager.js";
import { saveTraceability } from "./traceability_engine.js";
import { performFullExtraction } from "./shared.js";
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
function runPhase5Benchmark() {
    console.log("=== RUNNING PHASE 5 TESTING INTELLIGENCE BENCHMARK ===");
    // Initial Setup
    const stats = performFullExtraction(ecosystemRoot);
    const dnaPath = path.join(ecosystemRoot, ".secufusion", "dna.json");
    const dna = JSON.parse(fs.readFileSync(dnaPath, "utf-8"));
    const graph = dna.graph;
    saveTraceability(ecosystemRoot, []);
    fs.writeFileSync(path.join(ecosystemRoot, '.secufusion', 'tests', 'results.json'), '[]'); // Clear tests
    console.log("\\n--- 1. TEST DISCOVERY & INGESTION (User Deletion) ---");
    setupRequirement("REQ-DEL-5", "User Deletion Tests", "CONFIRMED", ["Authorized to delete user"]);
    // Create Plan
    let planDel = {
        id: "PLAN-DEL-5",
        requirement_id: "REQ-DEL-5",
        status: "DRAFT",
        summary: "Delete user test execution",
        affected_services: ["sfn-iam-api"],
        affected_files: [],
        api_changes: ["DELETE /users/{id}"],
        database_changes: ["DELETE cascade on users table"],
        event_changes: [],
        frontend_changes: [],
        extension_changes: [],
        security_implications: [],
        implementation_steps: ["Perform deletion"],
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
    const obligations = generateTestObligations(planDel);
    planDel.test_obligations = obligations;
    savePlan(ecosystemRoot, planDel);
    // Missing test execution -> Should be UNKNOWN
    let errors = validatePlan(ecosystemRoot, planDel);
    console.log("Validation Errors:", errors);
    let tests = loadTestResults(ecosystemRoot);
    let validation = aggregateValidation("CONFIRMED", errors, planDel.test_obligations, tests, [], false);
    console.log("Validation State with MISSING test executions:", validation.overall); // Should be UNKNOWN
    // Ingest PASS results
    const passResult = {
        id: "TR-1",
        test_name: "testUserDeletionCascade",
        suite_name: "UserDeletionTest",
        repository: "sfn-iam-api",
        file_path: "UNKNOWN",
        status: "PASS",
        duration_ms: 150,
        exit_code: 0,
        timestamp: new Date().toISOString(),
        execution_identity: "EXEC-1"
    };
    ingestTestResults(ecosystemRoot, [passResult]);
    tests = loadTestResults(ecosystemRoot);
    validation = aggregateValidation("CONFIRMED", errors, planDel.test_obligations, tests, [], false);
    console.log("Validation State with PASS tests:", validation.overall, "(tests=", validation.tests, ", planErrors=", errors, ", testResults=", tests, ")"); // Should be PASS
    console.log("\\n--- 2. FAIL NORMALIZATION & CORRELATION (Retention) ---");
    // Ingest FAIL results
    const failResult = {
        id: "TR-2",
        test_name: "testRetentionPolicyCleanup",
        suite_name: "RetentionJobTest",
        repository: "sfn-events-api",
        file_path: "UNKNOWN",
        status: "FAIL",
        duration_ms: 1200,
        exit_code: 1,
        failure_message: "Expected 0 events, found 5",
        failure_type: "ASSERTION_FAILURE",
        timestamp: new Date().toISOString(),
        execution_identity: "EXEC-2"
    };
    // Map traceability to a fake RetentionJob node
    graph.nodes.push({ id: "CLASS:RetentionJob", type: "CLASS", name: "RetentionJob", repository: "sfn-events-api" });
    const edges = [{ source: "TEST:testRetentionPolicyCleanup", target: "CLASS:RetentionJob", relation: "TESTS", confidence: "DIRECT", extractionMethod: "STATIC" }];
    const correlated = correlateTestFailure(graph, edges, failResult);
    console.log("Failure Correlated Artifacts:", correlated);
    ingestTestResults(ecosystemRoot, [failResult]);
    tests = loadTestResults(ecosystemRoot);
    validation = aggregateValidation("CONFIRMED", errors, planDel.test_obligations, tests, [], false);
    console.log("Validation State with FAIL test:", validation.overall); // Should be FAIL
    console.log("\\n--- 3. TEST EXECUTION (Controlled BOUNDARY) ---");
    // Run an echo command
    const execResults = executeTests(ecosystemRoot, "echo 'Testing controlled execution'", ".");
    console.log("Execution Result Status:", execResults[0].status);
    console.log("Execution Output Captured:", execResults.length);
}
try {
    runPhase5Benchmark();
}
catch (e) {
    console.error("Benchmark failed:", e);
    process.exit(1);
}
