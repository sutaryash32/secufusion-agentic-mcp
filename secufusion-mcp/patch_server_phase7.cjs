const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, 'mcp', 'src', 'server.ts');
let content = fs.readFileSync(serverPath, 'utf8');

if (!content.includes('import { loadSnapshot, saveSnapshot, getRegressionContext, recordRegressionObservation')) {
    // Add imports
    const importStatement = `import { loadSnapshot, saveSnapshot, getRegressionContext, recordRegressionObservation, compareRepositorySnapshots, detectArchitectureDrift, detectRequirementDrift, detectTraceabilityDrift, getChangeHistoryContext, findRegressionTests, analyzeRegressionRisk } from "./regression_engine.js";\n`;
    content = content.replace(
        'import { buildGraph } from "./graph_builder.js";',
        importStatement + 'import { buildGraph } from "./graph_builder.js";'
    );

    // Add tools
    const tools = `
server.tool(
  "compare_repository_snapshots",
  "Compare two repository snapshots to detect deterministic artifact changes.",
  { base_snapshot: z.string(), current_snapshot: z.string() },
  async ({ base_snapshot, current_snapshot }) => {
    const ws = getWorkspaceRoot();
    const b = loadSnapshot(ws, base_snapshot);
    const c = loadSnapshot(ws, current_snapshot);
    if (!b || !c) return { content: [{ type: "text", text: "SNAPSHOT_IDENTITY_UNKNOWN" }] };
    return { content: [{ type: "text", text: JSON.stringify(compareRepositorySnapshots(b, c), null, 2) }] };
  }
);

server.tool(
  "detect_architecture_drift",
  "Compare recorded architecture against current repository evidence.",
  { base_snapshot: z.string(), current_snapshot: z.string() },
  async ({ base_snapshot, current_snapshot }) => {
    const ws = getWorkspaceRoot();
    const b = loadSnapshot(ws, base_snapshot);
    const c = loadSnapshot(ws, current_snapshot);
    if (!b || !c) return { content: [{ type: "text", text: "SNAPSHOT_IDENTITY_UNKNOWN" }] };
    return { content: [{ type: "text", text: JSON.stringify(detectArchitectureDrift(b, c), null, 2) }] };
  }
);

server.tool(
  "detect_requirement_drift",
  "Compare confirmed requirements and current implementation.",
  { requirement_id: z.string(), current_snapshot: z.string() },
  async ({ requirement_id, current_snapshot }) => {
    const ws = getWorkspaceRoot();
    const req = loadRequirement(ws, requirement_id);
    const c = loadSnapshot(ws, current_snapshot);
    if (!req || !c) return { content: [{ type: "text", text: "UNKNOWN" }] };
    return { content: [{ type: "text", text: JSON.stringify(detectRequirementDrift([req], c), null, 2) }] };
  }
);

server.tool(
  "detect_traceability_drift",
  "Identify stale or broken traceability relationships.",
  { current_snapshot: z.string() },
  async ({ current_snapshot }) => {
    const ws = getWorkspaceRoot();
    const links = loadTraceability(ws);
    const c = loadSnapshot(ws, current_snapshot);
    if (!c) return { content: [{ type: "text", text: "UNKNOWN" }] };
    return { content: [{ type: "text", text: JSON.stringify(detectTraceabilityDrift(links, c), null, 2) }] };
  }
);

server.tool(
  "get_regression_context",
  "Return bounded package of current changes, drift, gaps, tests and history.",
  { base_snapshot: z.string(), current_snapshot: z.string(), requirement_id: z.string().optional() },
  async ({ base_snapshot, current_snapshot, requirement_id }) => {
    const ws = getWorkspaceRoot();
    const b = loadSnapshot(ws, base_snapshot);
    const c = loadSnapshot(ws, current_snapshot);
    if (!b || !c) return { content: [{ type: "text", text: "SNAPSHOT_IDENTITY_UNKNOWN" }] };
    
    const reqs = requirement_id ? [loadRequirement(ws, requirement_id)].filter(x => x) : [];
    const links = loadTraceability(ws);
    // Dummy test list for integration
    const allTests = []; 
    
    const context = getRegressionContext(ws, b, c, reqs, links, allTests);
    return { content: [{ type: "text", text: JSON.stringify(context, null, 2) }] };
  }
);

server.tool(
  "record_regression_observation",
  "Store an evidence-backed regression observation.",
  { observation: z.any() },
  async ({ observation }) => {
    const ws = getWorkspaceRoot();
    recordRegressionObservation(ws, observation);
    return { content: [{ type: "text", text: "OBSERVATION_RECORDED" }] };
  }
);
`;
    // Insert tools before `async function run()`
    content = content.replace(
        'async function run() {',
        tools + '\nasync function run() {'
    );

    fs.writeFileSync(serverPath, content, 'utf8');
    console.log("Patched server.ts with Phase 7 tools");
}
