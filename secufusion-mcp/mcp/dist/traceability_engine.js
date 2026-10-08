import fs from 'fs';
import path from 'path';
export function loadTraceability(ecosystemRoot) {
    const p = path.join(ecosystemRoot, '.secufusion', 'traceability.json');
    if (!fs.existsSync(p))
        return [];
    try {
        return JSON.parse(fs.readFileSync(p, 'utf-8'));
    }
    catch {
        return [];
    }
}
export function saveTraceability(ecosystemRoot, edges) {
    const dir = path.join(ecosystemRoot, '.secufusion');
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'traceability.json'), JSON.stringify(edges, null, 2));
}
export function addTraceabilityLink(ecosystemRoot, source, target, type, provenance, confidence) {
    const edges = loadTraceability(ecosystemRoot);
    const id = `${source}-${type}-${target}`;
    let edge = edges.find(e => e.id === id);
    if (!edge) {
        edge = { id, source, target, type, provenance, confidence };
        edges.push(edge);
    }
    else {
        edge.provenance = provenance;
        edge.confidence = confidence;
    }
    saveTraceability(ecosystemRoot, edges);
    return edge;
}
export function traceForward(graph, traceabilityEdges, sourceId, depth = 3) {
    const allEdges = [...graph.edges, ...traceabilityEdges];
    const resultNodes = new Set();
    const resultEdges = new Set();
    let currentLevel = [sourceId];
    resultNodes.add(sourceId);
    for (let i = 0; i < depth; i++) {
        let nextLevel = [];
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
export function traceReverse(graph, traceabilityEdges, targetId, depth = 3) {
    const allEdges = [...graph.edges, ...traceabilityEdges];
    const resultNodes = new Set();
    const resultEdges = new Set();
    let currentLevel = [targetId];
    resultNodes.add(targetId);
    for (let i = 0; i < depth; i++) {
        let nextLevel = [];
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
export function findTraceabilityGaps(ecosystemRoot, graph, traceabilityEdges) {
    const gaps = [];
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
                    if (reqData.ui_impact?.status === "YES") {
                        const ref = reqData.ui_reference;
                        const linked = traceabilityEdges.some(e => e.source === reqIdStr && e.type === "HAS_UI_REFERENCE");
                        if (!ref || (ref.status !== "CONFIRMED" && ref.status !== "NOT_REQUIRED")) {
                            gaps.push({ type: "UI_REFERENCE_NOT_CONFIRMED", id: reqIdStr });
                        }
                        else if (ref.status === "CONFIRMED" && !linked) {
                            gaps.push({ type: "UI_REFERENCE_NOT_LINKED", id: reqIdStr });
                        }
                    }
                }
            }
            catch (e) { }
        }
    }
    return gaps;
}
