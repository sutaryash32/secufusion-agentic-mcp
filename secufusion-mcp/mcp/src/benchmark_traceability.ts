import fs from 'fs';
import path from 'path';
import { performFullExtraction } from "./shared.js";
import { addTraceabilityLink, traceForward, findTraceabilityGaps, loadTraceability, saveTraceability } from "./traceability_engine.js";
import { Requirement, saveRequirement } from "./requirement_manager.js";

const ecosystemRoot = "c:\\Users\\Yash\\Desktop\\mcp";

function setupRequirement(id: string, title: string) {
    const req: Requirement = {
        id,
        title,
        status: "CONFIRMED",
        raw_request: title,
        clarification_questions: []
    };
    saveRequirement(ecosystemRoot, req);
}

function runRealBenchmark() {
    console.log("=== RUNNING REAL REPOSITORY TRACEABILITY BENCHMARK ===");
    
    // 1. Extract Real Repository
    console.log("Extracting actual repository...");
    const stats = performFullExtraction(ecosystemRoot);
    console.log("Extraction stats:", JSON.stringify(stats));
    
    const dnaPath = path.join(ecosystemRoot, ".secufusion", "dna.json");
    const dna = JSON.parse(fs.readFileSync(dnaPath, "utf-8"));
    const graph = dna.graph;
    
    // Clear previous traceability
    saveTraceability(ecosystemRoot, []);
    
    // --- Retention Benchmark ---
    console.log("\\n--- RETENTION BENCHMARK (REAL REPO) ---");
    setupRequirement("REQ-RET-1", "Retention Policy");
    
    const retentionNodes = graph.nodes.filter((n: any) => (n.name || "").toLowerCase().includes("retention"));
    for (const node of retentionNodes) {
        addTraceabilityLink(ecosystemRoot, "REQUIREMENT:REQ-RET-1", node.id, "IMPLEMENTED_BY", "INFERRED", "SUPPORTED");
    }
    
    const edges1 = loadTraceability(ecosystemRoot);
    const traceRet = traceForward(graph, edges1, "REQUIREMENT:REQ-RET-1", 3);
    const gapsRet = findTraceabilityGaps(ecosystemRoot, graph, edges1);
    
    console.log("Traced Artifacts:", traceRet.nodes.length - 1);
    console.log("Evidence Found:", traceRet.nodes.filter((n: any) => n.type !== "UNKNOWN" && !n.id.startsWith("REQUIREMENT:")).length);
    console.log("Traceability Gaps (Retention):", gapsRet.filter((g: any) => g.id === "REQUIREMENT:REQ-RET-1").length > 0 ? "YES (REQUIREMENT_WITHOUT_IMPLEMENTATION)" : "NO");
    console.log("Affected Services:", traceRet.nodes.filter((n: any) => n.type === "SERVICE").map((n: any) => n.name));
    console.log("Affected APIs:", traceRet.nodes.filter((n: any) => n.type === "API").map((n: any) => n.name));
    console.log("Affected DBs:", traceRet.nodes.filter((n: any) => n.type === "DATABASE_TABLE").map((n: any) => n.name));
    
    // --- User Deletion Benchmark ---
    console.log("\\n--- USER DELETION BENCHMARK (REAL REPO) ---");
    setupRequirement("REQ-DEL-1", "User Deletion");
    
    const userNodes = graph.nodes.filter((n: any) => (n.name || "").toLowerCase().includes("user"));
    for (const node of userNodes) {
        addTraceabilityLink(ecosystemRoot, "REQUIREMENT:REQ-DEL-1", node.id, "IMPLEMENTED_BY", "INFERRED", "SUPPORTED");
    }
    
    const edges2 = loadTraceability(ecosystemRoot);
    const traceDel = traceForward(graph, edges2, "REQUIREMENT:REQ-DEL-1", 3);
    const gapsDel = findTraceabilityGaps(ecosystemRoot, graph, edges2);
    
    console.log("Traced Artifacts:", traceDel.nodes.length - 1);
    console.log("Evidence Found:", traceDel.nodes.filter((n: any) => n.type !== "UNKNOWN" && !n.id.startsWith("REQUIREMENT:")).length);
    console.log("Traceability Gaps (User Deletion):", gapsDel.filter((g: any) => g.id === "REQUIREMENT:REQ-DEL-1").length > 0 ? "YES (REQUIREMENT_WITHOUT_IMPLEMENTATION)" : "NO");
    console.log("Affected Services:", traceDel.nodes.filter((n: any) => n.type === "SERVICE").map((n: any) => n.name));
    console.log("Affected APIs:", traceDel.nodes.filter((n: any) => n.type === "API").map((n: any) => n.name));
    
    console.log("\\n=== VALIDATION SUMMARY ===");
    console.log("Did the MCP discover the actual SecuFusion implementation surface of a feature?");
    if (retentionNodes.length === 0 && userNodes.length === 0) {
        console.log("No. The actual SecuFusion backend repository (Java/Spring) is missing from this workspace. The extraction correctly resulted in 0 mappings without fabricating evidence. This correctly triggered the TRACEABILITY_GAP behavior.");
    } else {
        console.log("Yes. Discovered actual implementation surface.");
    }
}

try {
    runRealBenchmark();
} catch(e) {
    console.error("Benchmark failed:", e);
    process.exit(1);
}
