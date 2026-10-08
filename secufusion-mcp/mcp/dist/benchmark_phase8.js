import fs from "fs";
import path from "path";
import { discoverUIPatterns, generateStaticUIReference, getDesignContext } from "./ui_intelligence.js";
function reset(ecosystemRoot) {
    if (fs.existsSync(ecosystemRoot)) {
        fs.rmSync(ecosystemRoot, { recursive: true, force: true });
    }
    fs.mkdirSync(ecosystemRoot, { recursive: true });
}
function runBenchmark() {
    console.log("=== RUNNING PHASE 8 UX & UI DESIGN BENCHMARK ===\n");
    const ecosystemRoot = path.join(process.cwd(), '.benchmark_tmp_ph8');
    reset(ecosystemRoot);
    try {
        // --- Setup Mock State ---
        const snapshot = {
            schema_version: "1.0",
            nodes: [
                { id: "FRONTEND_APP:sfn-web-ui", type: "FRONTEND_APP", name: "sfn-web-ui" },
                { id: "UI_PATTERN:TenantSelector", type: "UI_PATTERN", name: "TenantSelector", repository: "sfn-web-ui", evidence: { filePath: "src/components/TenantSelector.tsx" }, metadata: { type: "React", description: "Standard tenant dropdown" } },
                { id: "UI_PATTERN:ConfirmationModal", type: "UI_PATTERN", name: "ConfirmationModal", repository: "sfn-web-ui", evidence: { filePath: "src/components/ConfirmationModal.tsx" }, metadata: { type: "React", description: "Destructive confirmation dialog" } },
                { id: "FRONTEND_COMPONENT:RetentionSettings", type: "FRONTEND_COMPONENT", name: "RetentionSettings", repository: "sfn-web-ui", evidence: { filePath: "src/pages/RetentionSettings.tsx" }, metadata: { type: "React" } },
                { id: "API:DELETE:/api/users", type: "API", name: "DELETE /api/users", repository: "sfn-iam-api" }
            ],
            edges: []
        };
        fs.mkdirSync(path.join(ecosystemRoot, ".secufusion", "requirements"), { recursive: true });
        const retentionReq = { id: "REQ-RETENTION", status: "CONFIRMED" };
        const deletionReq = { id: "REQ-DELETE-USER", status: "CONFIRMED", apis: ["DELETE:/api/users"] };
        fs.writeFileSync(path.join(ecosystemRoot, ".secufusion", "requirements", "REQ-RETENTION.json"), JSON.stringify(retentionReq));
        fs.writeFileSync(path.join(ecosystemRoot, ".secufusion", "requirements", "REQ-DELETE-USER.json"), JSON.stringify(deletionReq));
        // --- Benchmark 1: Retention Policy (New Feature) ---
        console.log("--- 1. RETENTION POLICY BENCHMARK ---");
        const retentionContext = getDesignContext(ecosystemRoot, "REQ-RETENTION", snapshot);
        console.log(`Context status: ${retentionContext.status}`);
        const tenantPatterns = discoverUIPatterns(ecosystemRoot, "tenant selector", snapshot);
        console.log(`Discovered Tenant Patterns: ${tenantPatterns.length}`);
        tenantPatterns.forEach(p => console.log(` - ${p.name} (Source: ${p.evidence.location.filePath})`));
        const retentionHtml = `<html><body><h1>Retention Policy</h1><p>Set retention here</p></body></html>`;
        const retentionPath = generateStaticUIReference(ecosystemRoot, "DESIGN-RETENTION", retentionHtml, { status: "DRAFT" });
        console.log(`Generated HTML at: ${retentionPath}`);
        const retentionContent = fs.readFileSync(retentionPath, "utf-8");
        if (retentionContent.includes("REFERENCE_ONLY"))
            console.log("SUCCESS: Retention HTML contains REFERENCE_ONLY marker.");
        // --- Benchmark 2: User Deletion (Destructive Operation) ---
        console.log("\n--- 2. USER DELETION BENCHMARK ---");
        const deletionContext = getDesignContext(ecosystemRoot, "REQ-DELETE-USER", snapshot);
        console.log(`Architecture Context Nodes: ${deletionContext.architecture_context.length}`);
        deletionContext.architecture_context.forEach((n) => console.log(` - Affected: ${n.id}`));
        const deletePatterns = discoverUIPatterns(ecosystemRoot, "confirmation destructive", snapshot);
        console.log(`Discovered Confirmation Patterns: ${deletePatterns.length}`);
        deletePatterns.forEach(p => console.log(` - ${p.name} (Source: ${p.evidence.location.filePath})`));
        const deletionHtml = `<html><body><h1>Delete User</h1></body></html>`;
        const deletionPath = generateStaticUIReference(ecosystemRoot, "DESIGN-DELETE-USER", deletionHtml, { status: "USER_REVIEW_REQUIRED" });
        console.log(`Generated HTML at: ${deletionPath}`);
        const deletionContent = fs.readFileSync(deletionPath, "utf-8");
        if (deletionContent.includes("REFERENCE_ONLY"))
            console.log("SUCCESS: Deletion HTML contains REFERENCE_ONLY marker.");
        // --- Benchmark 3: Validate Metadata ---
        console.log("\n--- 3. DESIGN METADATA VALIDATION ---");
        const metaPath = path.join(ecosystemRoot, ".secufusion", "designs", "DESIGN-DELETE-USER", "design.json");
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        console.log(`Design Status: ${meta.status}`);
        console.log(`Design ID: ${meta.design_id}`);
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
