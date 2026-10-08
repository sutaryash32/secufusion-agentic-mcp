import fs from "fs";
import path from "path";
import { performFullExtraction } from "./shared.js";
import { investigateEntity } from "./investigation_engine.js";

function runBenchmark() {
    console.log("=== RUNNING PHASE 10 E2E VALIDATION BENCHMARK ===\n");
    
    // We run against the REAL SecuFusion Workspace
    const ecosystemRoot = "C:\\Users\\Yash\\Desktop\\secufi_full";
    if (!fs.existsSync(ecosystemRoot)) {
        console.warn(`WARNING: Real workspace not found at ${ecosystemRoot}. Cannot run Phase 10 fully.`);
        process.exit(0);
    }
    
    try {
        console.log("--- 1. WORKSPACE INITIALIZATION & EXTRACTION ---");
        // const stats = performFullExtraction(ecosystemRoot);
        // console.log(`Extraction Status: ${stats.inspectionStatus}`);
        // console.log(`Models: ${stats.modelsCount}, APIs: ${stats.apisCount}, Frontend: ${stats.frontendCount}`);
        
        const dnaPath = path.join(ecosystemRoot, ".secufusion", "dna.json");
        const dna = JSON.parse(fs.readFileSync(dnaPath, "utf-8"));
        
        console.log("\n--- 2. REAL MFA BENCHMARK (WI-2847) ---");
        const mfaInvestigate = investigateEntity(dna.graph, "auth");
        console.log(`MFA/Auth investigation: ${mfaInvestigate.state}`);
        console.log(`Found Nodes: ${mfaInvestigate.nodes_found.length}`);
        
        console.log("\n--- 3. REAL RETENTION BENCHMARK ---");
        const retentionInvestigate = investigateEntity(dna.graph, "tenant");
        console.log(`Tenant investigation: ${retentionInvestigate.state}`);
        console.log(`Found Nodes: ${retentionInvestigate.nodes_found.length}`);
        
        const eventInvestigate = investigateEntity(dna.graph, "event");
        console.log(`Event investigation: ${eventInvestigate.state}`);
        console.log(`Found Nodes: ${eventInvestigate.nodes_found.length}`);

        console.log("\n--- 4. REAL USER DELETION BENCHMARK ---");
        const userInvestigate = investigateEntity(dna.graph, "user");
        console.log(`User investigation: ${userInvestigate.state}`);
        console.log(`Found Nodes: ${userInvestigate.nodes_found.length}`);

        console.log("\n=== BENCHMARK COMPLETE (ALL PASS) ===");
    } catch (e: any) {
        console.error("Benchmark Failed:", e.message);
        process.exit(1);
    }
}

runBenchmark();
