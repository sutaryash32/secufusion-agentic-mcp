import { GraphSnapshot, GraphNode, GraphEdge } from "./graph_builder.js";

export type InvestigationResultState = "FOUND" | "NOT_FOUND" | "UNKNOWN" | "CONFLICT";

export interface InvestigationResult {
    state: InvestigationResultState;
    evidence: string[];
    nodes_found: GraphNode[];
    edges_found: GraphEdge[];
    summary: string;
}

export function investigateEntity(graph: GraphSnapshot, entityName: string): InvestigationResult {
    const targetLower = entityName.toLowerCase();
    const nodes = graph.nodes.filter(n => n.id.toLowerCase().includes(targetLower) || n.name?.toLowerCase().includes(targetLower));
    
    if (nodes.length === 0) {
        return {
            state: "NOT_FOUND",
            evidence: [],
            nodes_found: [],
            edges_found: [],
            summary: `No nodes matching '${entityName}' were found in the current evidence graph.`
        };
    }
    
    const edges = graph.edges.filter(e => nodes.some(n => n.id === e.source || n.id === e.target));
    const evidenceSet = new Set<string>();
    nodes.forEach(n => n.evidence?.filePath && evidenceSet.add(n.evidence.filePath));
    edges.forEach(e => e.evidence?.filePath && evidenceSet.add(e.evidence.filePath));

    return {
        state: "FOUND",
        evidence: Array.from(evidenceSet),
        nodes_found: nodes,
        edges_found: edges,
        summary: `Found ${nodes.length} nodes and ${edges.length} relationships for '${entityName}'.`
    };
}

export function investigateRelationship(graph: GraphSnapshot, sourceEntity: string, targetEntity: string): InvestigationResult {
    const sourceLower = sourceEntity.toLowerCase();
    const targetLower = targetEntity.toLowerCase();
    
    const sourceNodes = graph.nodes.filter(n => n.id.toLowerCase().includes(sourceLower) || n.name?.toLowerCase().includes(sourceLower));
    const targetNodes = graph.nodes.filter(n => n.id.toLowerCase().includes(targetLower) || n.name?.toLowerCase().includes(targetLower));
    
    if (sourceNodes.length === 0 || targetNodes.length === 0) {
        return {
            state: "NOT_FOUND",
            evidence: [],
            nodes_found: [],
            edges_found: [],
            summary: `Could not establish relationship because one or both entities were not found.`
        };
    }
    
    const edges = graph.edges.filter(e => 
        sourceNodes.some(s => s.id === e.source) && targetNodes.some(t => t.id === e.target) ||
        sourceNodes.some(s => s.id === e.target) && targetNodes.some(t => t.id === e.source)
    );
    
    if (edges.length === 0) {
        return {
            state: "NOT_FOUND",
            evidence: [],
            nodes_found: [...sourceNodes, ...targetNodes],
            edges_found: [],
            summary: `Both entities exist, but no direct relationship was found between them in the evidence graph.`
        };
    }
    
    const evidenceSet = new Set<string>();
    edges.forEach(e => e.evidence?.filePath && evidenceSet.add(e.evidence.filePath));

    return {
        state: "FOUND",
        evidence: Array.from(evidenceSet),
        nodes_found: [...sourceNodes, ...targetNodes],
        edges_found: edges,
        summary: `Found ${edges.length} direct relationships between '${sourceEntity}' and '${targetEntity}'.`
    };
}
