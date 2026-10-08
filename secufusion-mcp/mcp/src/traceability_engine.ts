import fs from 'fs';
import path from 'path';
import { GraphNode, GraphEdge, GraphSnapshot } from './graph_builder.js';

export interface TraceabilityEdge extends GraphEdge {
    provenance: "DIRECT" | "INFERRED" | "USER_CONFIRMED" | "HISTORICAL" | "UNKNOWN";
    confidence: "CONFIRMED" | "SUPPORTED" | "INFERRED" | "CONFLICT" | "UNKNOWN" | "STALE";
}

export function loadTraceability(ecosystemRoot: string): TraceabilityEdge[] {
    const p = path.join(ecosystemRoot, '.secufusion', 'traceability.json');
    if (!fs.existsSync(p)) return [];
    try {
        return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch {
        return [];
    }
}

export function saveTraceability(ecosystemRoot: string, edges: TraceabilityEdge[]) {
    const dir = path.join(ecosystemRoot, '.secufusion');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'traceability.json'), JSON.stringify(edges, null, 2));
}

export function addTraceabilityLink(ecosystemRoot: string, source: string, target: string, type: string, provenance: TraceabilityEdge["provenance"], confidence: TraceabilityEdge["confidence"]): TraceabilityEdge {
    const edges = loadTraceability(ecosystemRoot);
    const id = `${source}-${type}-${target}`;
    let edge = edges.find(e => e.id === id);
    if (!edge) {
        edge = { id, source, target, type, provenance, confidence };
        edges.push(edge);
    } else {
        edge.provenance = provenance;
        edge.confidence = confidence;
    }
    saveTraceability(ecosystemRoot, edges);
    return edge;
}

export function traceForward(graph: GraphSnapshot, traceabilityEdges: TraceabilityEdge[], sourceId: string, depth = 3) {
    const allEdges = [...graph.edges, ...traceabilityEdges];
    const resultNodes = new Set<string>();
    const resultEdges = new Set<string>();
    
    let currentLevel = [sourceId];
    resultNodes.add(sourceId);

    for (let i = 0; i < depth; i++) {
        let nextLevel: string[] = [];
        for (const nodeId of currentLevel) {
            const outgoing = allEdges.filter(e => e.source === nodeId);
            for (const out of outgoing) {
                if (!resultNodes.has(out.target)) {
                    resultNodes.add(out.target);
                    nextLevel.push(out.target);
                }
                resultEdges.add(out.id);
            }
        }
        currentLevel = nextLevel;
    }
    
    return {
        nodes: Array.from(resultNodes).map(id => graph.nodes.find(n => n.id === id) || { id, type: "UNKNOWN", name: id }),
        edges: Array.from(resultEdges).map(id => allEdges.find(e => e.id === id))
    };
}

export function traceReverse(graph: GraphSnapshot, traceabilityEdges: TraceabilityEdge[], targetId: string, depth = 3) {
    const allEdges = [...graph.edges, ...traceabilityEdges];
    const resultNodes = new Set<string>();
    const resultEdges = new Set<string>();
    
    let currentLevel = [targetId];
    resultNodes.add(targetId);

    for (let i = 0; i < depth; i++) {
        let nextLevel: string[] = [];
        for (const nodeId of currentLevel) {
            const incoming = allEdges.filter(e => e.target === nodeId);
            for (const inc of incoming) {
                if (!resultNodes.has(inc.source)) {
                    resultNodes.add(inc.source);
                    nextLevel.push(inc.source);
                }
                resultEdges.add(inc.id);
            }
        }
        currentLevel = nextLevel;
    }
    
    return {
        nodes: Array.from(resultNodes).map(id => graph.nodes.find(n => n.id === id) || { id, type: "UNKNOWN", name: id }),
        edges: Array.from(resultEdges).map(id => allEdges.find(e => e.id === id))
    };
}

export function findTraceabilityGaps(ecosystemRoot: string, graph: GraphSnapshot, traceabilityEdges: TraceabilityEdge[]) {
    const gaps: any[] = [];
    
    // 1. Find all active requirements
    const reqDir = path.join(ecosystemRoot, '.secufusion', 'requirements');
    if (fs.existsSync(reqDir)) {
        const reqFiles = fs.readdirSync(reqDir).filter(f => f.endsWith('.json'));
        for (const file of reqFiles) {
            try {
                const reqData = JSON.parse(fs.readFileSync(path.join(reqDir, file), 'utf-8'));
                if (reqData.status === "CONFIRMED") {
                    const reqIdStr = "REQUIREMENT:" + reqData.id;
                    const implementsEdges = traceabilityEdges.filter(e => e.source === reqIdStr && (e.type === "IMPLEMENTED_BY" || e.type === "AFFECTS"));
                    if (implementsEdges.length === 0) {
                        gaps.push({ type: "REQUIREMENT_WITHOUT_IMPLEMENTATION", id: reqIdStr });
                    }
                }
            } catch(e) {}
        }
    }
    
    return gaps;
}
