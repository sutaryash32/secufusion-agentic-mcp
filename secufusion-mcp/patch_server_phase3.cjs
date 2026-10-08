const fs = require('fs');

let content = fs.readFileSync('mcp/src/server.ts', 'utf8');

const importsToAdd = `import { loadTraceability, addTraceabilityLink, traceForward, traceReverse, findTraceabilityGaps } from "./traceability_engine.js";\n`;

if (!content.includes('import { loadTraceability')) {
    content = content.replace('import { investigateEntity', importsToAdd + 'import { investigateEntity');
}

const traceTools = `
server.tool(
  "create_traceability_link",
  "Explicitly creates a traceability link between two nodes in the graph.",
  {
    workspace_root: z.string().describe("Root directory of the workspace"),
    source: z.string().describe("Source node ID (e.g. 'REQUIREMENT:BM-RET-1')"),
    target: z.string().describe("Target node ID (e.g. 'CLASS:RetentionPolicy')"),
    type: z.string().describe("Relationship type (e.g. 'IMPLEMENTED_BY', 'AFFECTS')"),
    provenance: z.enum(["DIRECT", "INFERRED", "USER_CONFIRMED", "HISTORICAL", "UNKNOWN"]),
    confidence: z.enum(["CONFIRMED", "SUPPORTED", "INFERRED", "CONFLICT", "UNKNOWN", "STALE"])
  },
  async ({ workspace_root, source, target, type, provenance, confidence }) => {
    try {
        const ecosystemRoot = getEcosystemRoot(workspace_root);
        const link = addTraceabilityLink(ecosystemRoot, source, target, type, provenance, confidence);
        return { content: [{ type: "text", text: \`Traceability link created: \${JSON.stringify(link)}\` }] };
    } catch (e) {
        return { content: [{ type: "text", text: \`Error: \${e.message}\` }], isError: true };
    }
  }
);

server.tool(
  "trace_requirement",
  "Traces a requirement forward or an implementation backward to find linked artifacts.",
  {
    workspace_root: z.string().describe("Root directory of the workspace"),
    node_id: z.string().describe("The node ID to start tracing from (e.g. 'REQUIREMENT:BM-RET-1' or 'CLASS:EventEntity')"),
    direction: z.enum(["FORWARD", "REVERSE"]).describe("Direction to trace"),
    depth: z.number().optional().describe("Maximum traversal depth")
  },
  async ({ workspace_root, node_id, direction, depth }) => {
    try {
        const ecosystemRoot = getEcosystemRoot(workspace_root);
        const dnaPath = getDnaPath(ecosystemRoot);
        if (!fs.existsSync(dnaPath)) return { content: [{ type: "text", text: "No DNA graph found." }] };
        const dna = JSON.parse(fs.readFileSync(dnaPath, "utf-8"));
        if (!dna.graph) return { content: [{ type: "text", text: "No graph in DNA." }] };
        
        const edges = loadTraceability(ecosystemRoot);
        const res = direction === "FORWARD" 
            ? traceForward(dna.graph, edges, node_id, depth || 3)
            : traceReverse(dna.graph, edges, node_id, depth || 3);
            
        return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    } catch (e) {
        return { content: [{ type: "text", text: \`Error: \${e.message}\` }], isError: true };
    }
  }
);

server.tool(
  "find_traceability_gaps",
  "Finds gaps in traceability mapping (e.g. requirements without implementation).",
  {
    workspace_root: z.string().describe("Root directory of the workspace")
  },
  async ({ workspace_root }) => {
    try {
        const ecosystemRoot = getEcosystemRoot(workspace_root);
        const dnaPath = getDnaPath(ecosystemRoot);
        if (!fs.existsSync(dnaPath)) return { content: [{ type: "text", text: "No DNA graph found." }] };
        const dna = JSON.parse(fs.readFileSync(dnaPath, "utf-8"));
        
        const edges = loadTraceability(ecosystemRoot);
        const gaps = findTraceabilityGaps(dna.graph || { nodes: [], edges: [] }, edges);
        
        return { content: [{ type: "text", text: JSON.stringify(gaps, null, 2) }] };
    } catch (e) {
        return { content: [{ type: "text", text: \`Error: \${e.message}\` }], isError: true };
    }
  }
);
`;

if (!content.includes('server.tool(\n  "create_traceability_link"')) {
    const qkgIndex = content.indexOf('server.tool(\n  "query_knowledge_graph"');
    if (qkgIndex !== -1) {
        content = content.slice(0, qkgIndex) + traceTools + "\n" + content.slice(qkgIndex);
        fs.writeFileSync('mcp/src/server.ts', content);
        console.log("Patched server.ts with Phase 3 tools.");
    }
} else {
    console.log("Phase 3 tools already present.");
}
