import fs from "fs";
import path from "path";
import { inspectWorkspaceRepositories, getEvidenceCompleteness } from "./workspace_intelligence.js";
import { performFullExtraction } from "./server.js";

function reset(ecosystemRoot: string) {
    if (fs.existsSync(ecosystemRoot)) {
        fs.rmSync(ecosystemRoot, { recursive: true, force: true });
    }
    fs.mkdirSync(ecosystemRoot, { recursive: true });
}

function runBenchmark() {
    console.log("=== RUNNING PHASE 9 WORKSPACE INTELLIGENCE BENCHMARK ===\n");
    const ecosystemRoot = path.join(process.cwd(), '.benchmark_tmp_ph9');
    reset(ecosystemRoot);

    try {
        // --- Setup Mock Workspace ---
        const coreRepos = ["sfn-iam-api", "sfn-events-api", "sfn-tenants-api", "sfn-web-ui"];
        const optionalRepos = ["sfn-auth-api", "sfn-browser-ext"];
        
        [...coreRepos, ...optionalRepos].forEach(repo => {
            fs.mkdirSync(path.join(ecosystemRoot, repo), { recursive: true });
            fs.writeFileSync(path.join(ecosystemRoot, repo, "index.ts"), "console.log('test');");
        });

        // --- Benchmark 1: All Available ---
        console.log("--- 1. FULL WORKSPACE BENCHMARK ---");
        let inspection = inspectWorkspaceRepositories(ecosystemRoot);
        console.log(`Status: ${inspection.status}`);
        if (inspection.status !== "READY") throw new Error("Status should be READY");
        if (inspection.core_found.length !== 4) throw new Error("Should find 4 core repos");
        
        let completeness = getEvidenceCompleteness(ecosystemRoot);
        console.log(`Completeness Status: ${completeness.completeness_status}`);

        // --- Benchmark 2: Missing Optional Repository ---
        console.log("\n--- 2. MISSING OPTIONAL BENCHMARK ---");
        fs.rmSync(path.join(ecosystemRoot, "sfn-browser-ext"), { recursive: true, force: true });
        inspection = inspectWorkspaceRepositories(ecosystemRoot);
        console.log(`Status after missing optional: ${inspection.status}`);
        if (inspection.status !== "READY") throw new Error("Status should still be READY");
        if (inspection.optional_missing.includes("sfn-browser-ext") === false) throw new Error("Missing optional should be tracked");

        // --- Benchmark 3: Missing Core Repository ---
        console.log("\n--- 3. MISSING CORE BENCHMARK ---");
        fs.rmSync(path.join(ecosystemRoot, "sfn-iam-api"), { recursive: true, force: true });
        inspection = inspectWorkspaceRepositories(ecosystemRoot);
        console.log(`Status after missing core: ${inspection.status}`);
        if (inspection.status !== "PARTIAL") throw new Error("Status should be PARTIAL (some core found, some missing)");
        if (inspection.core_missing.includes("sfn-iam-api") === false) throw new Error("Missing core should be tracked");

        completeness = getEvidenceCompleteness(ecosystemRoot);
        console.log(`Completeness Message: ${completeness.message}`);

        // --- Benchmark 4: Extraction Respects Boundaries ---
        console.log("\n--- 4. EXTRACTION BOUNDARY BENCHMARK ---");
        const stats = performFullExtraction(ecosystemRoot);
        console.log(`Extraction Status: ${stats.inspectionStatus}`);
        if (stats.inspectionStatus !== "PARTIAL") throw new Error("Extraction should bubble up PARTIAL status");

        console.log("\n=== BENCHMARK COMPLETE (ALL PASS) ===");
    } catch (e: any) {
        console.error("Benchmark Failed:", e.message);
        process.exit(1);
    } finally {
        fs.rmSync(ecosystemRoot, { recursive: true, force: true });
    }
}

runBenchmark();
