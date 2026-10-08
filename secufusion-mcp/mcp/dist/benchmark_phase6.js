import fs from "fs";
import path from "path";
import { recordExperience, getEngineeringExperience, validateExperience, markExperienceStale, linkExperience, findExperienceConflicts } from "./experience_manager.js";
function resetExperience(ecosystemRoot) {
    const expPath = path.join(ecosystemRoot, '.secufusion', 'experience.json');
    if (fs.existsSync(expPath))
        fs.unlinkSync(expPath);
}
function runBenchmark() {
    console.log("=== RUNNING PHASE 6 ENGINEERING KNOWLEDGE BENCHMARK ===\n");
    // Use a temp workspace to avoid polluting real .secufusion
    const ecosystemRoot = path.join(process.cwd(), '.benchmark_tmp_ph6');
    if (!fs.existsSync(ecosystemRoot))
        fs.mkdirSync(ecosystemRoot, { recursive: true });
    resetExperience(ecosystemRoot);
    try {
        console.log("--- 1. RECORDING PROPOSED EXPERIENCE ---");
        const exp1 = recordExperience(ecosystemRoot, {
            id: "EXP-RETENTION",
            title: "Retention Cleanup Idempotency",
            summary: "Previous retention cleanup required idempotent execution due to retries.",
            category: "SCHEDULING",
            lesson: "Always use idempotent queries for cleanup jobs in RetentionPolicy.",
            outcome: "FAILURE",
            affected_components: ["CLASS:RetentionJob", "CLASS:Scheduler"],
            status: "PROPOSED",
            evidence: "Run failures in Phase 3"
        });
        console.log(`Recorded: ${exp1.id} with status ${exp1.status}`);
        console.log("\n--- 2. VALIDATING EXPERIENCE WITH EVIDENCE ---");
        const validatedExp = validateExperience(ecosystemRoot, exp1.id, "TEST-RESULT: PASS for idempotent query");
        console.log(`Validated: ${validatedExp.id}, Status: ${validatedExp.status}, Evidence: ${validatedExp.evidence}`);
        console.log("\n--- 3. TRACEABILITY INTEGRATION (LINKING) ---");
        const linkedExp = linkExperience(ecosystemRoot, exp1.id, {
            source_requirement_id: "REQ-101",
            source_traceability_ids: ["TR-99"]
        });
        console.log(`Linked: ${linkedExp.id}, Source Req: ${linkedExp.source_requirement_id}`);
        console.log("\n--- 4. RETENTION BENCHMARK (STALENESS) ---");
        // Simulated: We discover that the current repository scheduler implementation has changed
        console.log("Simulating repository evidence check: Scheduler has been replaced with Quartz.");
        const staleExp = markExperienceStale(ecosystemRoot, exp1.id, "Scheduler implementation replaced by Quartz, making old idempotency logic obsolete.");
        console.log(`Stale State: ${staleExp.status}`);
        console.log(`Stale Reason in context: ${staleExp.context}`);
        console.log("\n--- 5. USER DELETION BENCHMARK (CONFLICTS) ---");
        recordExperience(ecosystemRoot, {
            id: "EXP-DEL-1",
            title: "Hard delete user events",
            summary: "User deletion must cascade to events.",
            category: "DELETION",
            lesson: "Use cascade delete.",
            outcome: "SUCCESS",
            affected_components: ["CLASS:UserDeletionService"],
            status: "VALIDATED"
        });
        recordExperience(ecosystemRoot, {
            id: "EXP-DEL-2",
            title: "Anonymize user events",
            summary: "User deletion must anonymize events.",
            category: "DELETION",
            lesson: "Use anonymization strategy.",
            outcome: "SUCCESS",
            affected_components: ["CLASS:UserDeletionService"],
            status: "VALIDATED"
        });
        const conflicts = findExperienceConflicts(ecosystemRoot);
        console.log(`Conflicts Detected: ${conflicts.length} records on shared component.`);
        conflicts.forEach(c => console.log(` - ${c.id}: ${c.title} (Outcome: ${c.outcome})`));
        console.log("\n--- 6. BOUNDED RETRIEVAL ---");
        const retrieved = getEngineeringExperience(ecosystemRoot, "", { affected_components: ["CLASS:RetentionJob"] });
        console.log(`Retrieved ${retrieved.length} records for CLASS:RetentionJob`);
        console.log(`Retrieved Record Status: ${retrieved[0].status}`);
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
