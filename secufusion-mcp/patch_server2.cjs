const fs = require('fs');

let content = fs.readFileSync('mcp/src/server.ts', 'utf8');

// 1. Add import
if (!content.includes('buildGraph')) {
    content = content.replace('import { parseDomainModels', 'import { buildGraph } from "./graph_builder.js";\nimport { parseDomainModels');
}

// 2. Patch performFullExtraction
const oldExtractionStr = `dna.inferred_patterns = inferPatterns(dna);\r\n    writeDna(ecosystemRoot, dna);`;
const oldExtractionStrN = `dna.inferred_patterns = inferPatterns(dna);\n    writeDna(ecosystemRoot, dna);`;
    
const newExtraction = `dna.inferred_patterns = inferPatterns(dna);

    // Build Graph
    const specPath = path.join(ecosystemRoot, ".secufusion-project-spec.json");
    let spec = null;
    try { spec = JSON.parse(fs.readFileSync(specPath, "utf-8")); } catch(e){}
    dna.graph = buildGraph(dna, spec);

    writeDna(ecosystemRoot, dna);`;

if (content.includes(oldExtractionStr)) {
    content = content.replace(oldExtractionStr, newExtraction);
    console.log("Patched performFullExtraction.");
} else if (content.includes(oldExtractionStrN)) {
    content = content.replace(oldExtractionStrN, newExtraction);
    console.log("Patched performFullExtraction.");
} else {
    console.log("Could not find performFullExtraction to patch.");
}

// 3. Patch query_knowledge_graph
const qkgReplacement = `server.tool(
  "query_knowledge_graph",
  "Targeted querying against the SecuFusion knowledge graph.",
  {
    workspace_root: z.string().describe("Root directory of the workspace"),
    query: z.string().describe("What to search for (e.g., 'User', 'tenantId', 'DeviceEntity'). Matches against name, id, and properties."),
    node_type: z.string().optional().describe("Optional filter by node type (e.g., 'SERVICE', 'CLASS', 'TOPIC')."),
    max_depth: z.number().optional().describe("Max relationship traversal depth (default 1).")
  },
  async ({ workspace_root, query, node_type, max_depth }) => {
    try {
        const ecosystemRoot = getEcosystemRoot(workspace_root);
        const dnaPath = getDnaPath(ecosystemRoot);
        if (!fs.existsSync(dnaPath)) return { content: [{ type: "text", text: \`No DNA found at \${dnaPath}.\` }] };
        const dna = JSON.parse(fs.readFileSync(dnaPath, "utf-8"));
        const graph = dna.graph;
        if (!graph) return { content: [{ type: "text", text: "Graph snapshot not found in DNA. Run an extraction first." }] };

        const queryLower = query.toLowerCase();
        const depth = max_depth || 1;
        
        let startNodes = graph.nodes.filter(n => 
            (n.id.toLowerCase().includes(queryLower) || n.name.toLowerCase().includes(queryLower)) &&
            (!node_type || n.type === node_type)
        );

        const resultNodes = new Map();
        const resultEdges = new Map();

        let currentLayer = startNodes;
        for (let d = 0; d <= depth; d++) {
            const nextLayer = [];
            for (const n of currentLayer) {
                if (!resultNodes.has(n.id)) resultNodes.set(n.id, n);
            }
            if (d < depth) {
                for (const edge of graph.edges) {
                    if (resultNodes.has(edge.source) || resultNodes.has(edge.target)) {
                        if (!resultEdges.has(edge.id)) {
                            resultEdges.set(edge.id, edge);
                            const sourceNode = graph.nodes.find(n => n.id === edge.source);
                            const targetNode = graph.nodes.find(n => n.id === edge.target);
                            if (sourceNode && !resultNodes.has(sourceNode.id)) nextLayer.push(sourceNode);
                            if (targetNode && !resultNodes.has(targetNode.id)) nextLayer.push(targetNode);
                        }
                    }
                }
            }
            currentLayer = nextLayer;
        }

        const result = {
            query,
            depth_searched: depth,
            nodes_found: resultNodes.size,
            edges_found: resultEdges.size,
            nodes: Array.from(resultNodes.values()),
            edges: Array.from(resultEdges.values())
        };

        return { content: [{ type: "text", text: \`EVIDENCE_GRAPH:\\n\${JSON.stringify(result, null, 2)}\` }] };
    } catch (e) {
        return { content: [{ type: "text", text: \`Error: \${e.message}\` }], isError: true };
    }
  }
);`;

const qRegex = /server\.tool\(\s*"query_knowledge_graph"[\s\S]*?\n\);\s*\n/m;
if (qRegex.test(content)) {
    content = content.replace(qRegex, qkgReplacement + '\n\n');
    console.log("Patched query_knowledge_graph.");
} else {
    console.log("Could not find query_knowledge_graph to patch.");
}

// 4. Patch calculate_blast_radius
const cbrReplacement = `server.tool(
  "calculate_blast_radius",
  "Calculates the impact of changing a specific component, entity, or API using graph relationships",
  {
    workspace_root: z.string().describe("Root directory of the workspace"),
    component_name: z.string().describe("Name of the component, entity, or API to analyze")
  },
  async ({ workspace_root, component_name }) => {
    try {
        const ecosystemRoot = getEcosystemRoot(workspace_root);
        const dnaPath = getDnaPath(ecosystemRoot);
        if (!fs.existsSync(dnaPath)) return { content: [{ type: "text", text: \`No DNA found at \${dnaPath}.\` }] };
        const dna = JSON.parse(fs.readFileSync(dnaPath, "utf-8"));
        const graph = dna.graph;
        if (!graph) return { content: [{ type: "text", text: "Graph snapshot not found in DNA. Run an extraction first." }] };
        
        const compLower = component_name.toLowerCase();
        const startNodes = graph.nodes.filter(n => n.id.toLowerCase().includes(compLower) || n.name.toLowerCase().includes(compLower));
        
        const impacts = [];
        for (const node of startNodes) {
           impacts.push(\`Impacts for \${node.id}:\`);
           const relatedEdges = graph.edges.filter(e => e.source === node.id || e.target === node.id);
           for (const edge of relatedEdges) {
              const otherId = edge.source === node.id ? edge.target : edge.source;
              const direction = edge.source === node.id ? \`-> \${edge.type} ->\` : \`<- \${edge.type} <-\`;
              impacts.push(\`  \${node.id} \${direction} \${otherId} (Evidence: \${edge.evidence?.filePath || 'Project Spec'})\`);
           }
        }
        
        if (impacts.length === 0) impacts.push("No direct impacts found in graph.");
        
        return { content: [{ type: "text", text: \`Blast Radius for '\${component_name}':\\n\${impacts.join('\\n')}\` }] };
    } catch (e) {
        return { content: [{ type: "text", text: \`Error: \${e.message}\` }], isError: true };
    }
  }
);`;

const cRegex = /server\.tool\(\s*"calculate_blast_radius"[\s\S]*?\n\);\s*\n/m;
if (cRegex.test(content)) {
    content = content.replace(cRegex, cbrReplacement + '\n\n');
    console.log("Patched calculate_blast_radius.");
} else {
    console.log("Could not find calculate_blast_radius to patch.");
}


fs.writeFileSync('mcp/src/server.ts', content);
console.log("Done");
