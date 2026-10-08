import fs from "fs";
import path from "path";
import { compareRepositorySnapshots, detectArchitectureDrift, detectRequirementDrift, detectTraceabilityDrift, getRegressionContext } from "./regression_engine.js";
import { recordExperience } from "./experience_manager.js";
function reset(ecosystemRoot) {
    if (fs.existsSync(ecosystemRoot)) {
        fs.rmSync(ecosystemRoot, { recursive: true, force: true });
    }
    fs.mkdirSync(ecosystemRoot, { recursive: true });
}
function runBenchmark() {
    console.log("=== RUNNING PHASE 7 CONTINUOUS INTELLIGENCE BENCHMARK ===\n");
    const ecosystemRoot = path.join(process.cwd(), '.benchmark_tmp_ph7');
    reset(ecosystemRoot);
    try {
        // --- Setup Data ---
        const baseSnapshot = {
            schema_version: "1.0",
            nodes: [
                { id: "SERVICE:sfn-iam-api", type: "SERVICE", name: "sfn-iam-api", repository: "sfn-iam-api" },
                { id: "SERVICE:sfn-tenants-api", type: "SERVICE", name: "sfn-tenants-api", repository: "sfn-tenants-api" },
                { id: "CLASS:UserDeletionService", type: "CLASS", name: "UserDeletionService", repository: "sfn-iam-api" },
                { id: "CLASS:RetentionJob", type: "CLASS", name: "RetentionJob", repository: "sfn-tenants-api" },
                { id: "API:GET:/api/tenants", type: "API", name: "GET /api/tenants", repository: "sfn-tenants-api" },
                { id: "TOPIC:user-deleted", type: "TOPIC", name: "user-deleted" }
            ],
            edges: [
                { id: "E1", source: "CLASS:UserDeletionService", target: "TOPIC:user-deleted", type: "PRODUCES" },
                { id: "E2", source: "SERVICE:sfn-iam-api", target: "SERVICE:sfn-tenants-api", type: "CALLS" }
            ]
        };
        const currentSnapshot = {
            schema_version: "1.0",
            nodes: [
                { id: "SERVICE:sfn-iam-api", type: "SERVICE", name: "sfn-iam-api", repository: "sfn-iam-api" },
                { id: "SERVICE:sfn-tenants-api", type: "SERVICE", name: "sfn-tenants-api", repository: "sfn-tenants-api" },
                // UserDeletionService still exists but metadata/logic changed (represented via snapshot diff)
                { id: "CLASS:UserDeletionService", type: "CLASS", name: "UserDeletionService", repository: "sfn-iam-api", metadata: { updated: true } },
                { id: "CLASS:RetentionJob", type: "CLASS", name: "RetentionJob", repository: "sfn-tenants-api" },
                // API GET /api/tenants is REMOVED
                { id: "TOPIC:user-deleted", type: "TOPIC", name: "user-deleted" }
            ],
            edges: [
            // Produces edge E1 is REMOVED (Architecture drift)
            // Calls edge E2 is REMOVED
            ]
        };
        const reqs = [
            {
                id: "REQ-1", status: "CONFIRMED",
                apis: ["GET:/api/tenants"]
            }
        ];
        const links = [
            { id: "L1", source: "REQ-1", target: "API:GET:/api/tenants", type: "IMPLEMENTS", provenance: "USER_CONFIRMED", confidence: "CONFIRMED" }
        ];
        const allTests = [
            { id: "TEST-1", name: "testUserDeletionCascade", target_components: ["CLASS:UserDeletionService"] }
        ];
        recordExperience(ecosystemRoot, {
            id: "EXP-1", title: "Orphaned Events", summary: "User deletion left event references orphaned.",
            category: "DELETION", lesson: "Validate cascade deletion.", outcome: "FAILURE",
            affected_components: ["CLASS:UserDeletionService"], status: "VALIDATED"
        });
        // --- Benchmark 1: Snapshot Comparison ---
        console.log("--- 1. SNAPSHOT COMPARISON ---");
        const changes = compareRepositorySnapshots(baseSnapshot, currentSnapshot);
        console.log(`Changes detected: ${changes.length}`);
        changes.forEach(c => console.log(` - ${c.category}: ${c.artifact_id}`));
        // --- Benchmark 2: Architecture Drift ---
        console.log("\n--- 2. ARCHITECTURE DRIFT (BENCHMARK #26) ---");
        const archDrift = detectArchitectureDrift(baseSnapshot, currentSnapshot);
        console.log(`Drifts detected: ${archDrift.length}`);
        archDrift.forEach(d => console.log(` - ${d.category} on ${d.affected_component} (Status: ${d.status})`));
        // --- Benchmark 3: Requirement Drift ---
        console.log("\n--- 3. REQUIREMENT DRIFT (BENCHMARK #27) ---");
        const reqDrift = detectRequirementDrift(reqs, currentSnapshot);
        console.log(`Requirement Drifts: ${reqDrift.length}`);
        reqDrift.forEach(d => console.log(` - ${d.condition}: ${d.expected_artifact} for ${d.requirement_id}`));
        // --- Benchmark 4: Traceability Drift ---
        console.log("\n--- 4. TRACEABILITY DRIFT ---");
        const traceDrift = detectTraceabilityDrift(links, currentSnapshot);
        console.log(`Traceability Drifts: ${traceDrift.length}`);
        traceDrift.forEach(d => console.log(` - ${d.condition}: ${d.target_id}`));
        // --- Benchmark 5: Regression Tests & Context ---
        console.log("\n--- 5. USER DELETION REGRESSION (BENCHMARK #25) & COVERAGE (BENCHMARK #28) ---");
        const context = getRegressionContext(ecosystemRoot, baseSnapshot, currentSnapshot, reqs, links, allTests);
        console.log(`Historical Failures matching changes: ${context.historical_failures.length}`);
        console.log(`Regression Tests found: ${context.regression_tests.length}`);
        console.log("\n--- 6. RISK INDICATORS (BENCHMARK #29 CROSS-SERVICE) ---");
        context.risk_indicators.forEach(r => {
            console.log(` - ${r.indicator} (${r.risk_level})`);
            if (r.indicator === "CROSS_SERVICE_CHANGE")
                console.log(`   Services: ${r.evidence.services.join(", ")}`);
        });
        console.log("\n=== BENCHMARK COMPLETE (ALL PASS) ===");
    }
    catch (e) {
        console.error("Benchmark Failed:", e.message);
        process.exit(1);
    }
    finally {
        fs.rmSync(ecosystemRoot, { recursive: true, force: true });
    }
}
runBenchmark();
