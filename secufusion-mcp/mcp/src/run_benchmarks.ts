import fs from 'fs';
import path from 'path';

function runQuery(graph: any, query: string, depth: number) {
    const queryLower = query.toLowerCase();
    let startNodes = graph.nodes.filter((n: any) => 
        (n.id.toLowerCase().includes(queryLower) || n.name.toLowerCase().includes(queryLower))
    );

    const resultNodes = new Map();
    const resultEdges = new Map();
    let currentLayer = startNodes;
    
    for (let d = 0; d <= depth; d++) {
        const nextLayer: any[] = [];
        for (const n of currentLayer) {
            if (!resultNodes.has(n.id)) resultNodes.set(n.id, n);
        }
        if (d < depth) {
            for (const edge of graph.edges) {
                if (resultNodes.has(edge.source) || resultNodes.has(edge.target)) {
                    if (!resultEdges.has(edge.id)) {
                        resultEdges.set(edge.id, edge);
                        const sourceNode = graph.nodes.find((n: any) => n.id === edge.source);
                        const targetNode = graph.nodes.find((n: any) => n.id === edge.target);
                        if (sourceNode && !resultNodes.has(sourceNode.id)) nextLayer.push(sourceNode);
                        if (targetNode && !resultNodes.has(targetNode.id)) nextLayer.push(targetNode);
                    }
                }
            }
        }
        currentLayer = nextLayer;
    }

    return {
        query,
        nodes: Array.from(resultNodes.values()),
        edges: Array.from(resultEdges.values())
    };
}

const ecosystemRoot = "c:\\Users\\Yash\\Desktop\\mcp";
const dnaPath = path.join(ecosystemRoot, ".secufusion", "dna.json");

if (!fs.existsSync(dnaPath)) {
    console.error("No dna.json found at", dnaPath);
    process.exit(1);
}

const dna = JSON.parse(fs.readFileSync(dnaPath, 'utf8'));
const graph = dna.graph;

if (!graph) {
    console.error("No graph in dna.json");
    process.exit(1);
}

console.log("--- User Deletion Benchmark ---");
const userRes = runQuery(graph, "User", 2);
console.log(`Found ${userRes.nodes.length} nodes and ${userRes.edges.length} edges for 'User'.`);
// Print paths
userRes.edges.slice(0, 10).forEach(e => {
    console.log(`  ${e.source} --[${e.type}]--> ${e.target}`);
});

console.log("\n--- Retention Policy Benchmark ---");
const retRes = runQuery(graph, "retention", 2);
console.log(`Found ${retRes.nodes.length} nodes and ${retRes.edges.length} edges for 'retention'.`);
retRes.edges.slice(0, 10).forEach(e => {
    console.log(`  ${e.source} --[${e.type}]--> ${e.target}`);
});
