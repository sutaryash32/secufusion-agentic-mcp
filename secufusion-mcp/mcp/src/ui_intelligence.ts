import fs from "fs";
import path from "path";
import { GraphSnapshot, GraphNode } from "./graph_builder.js";
import { Requirement, loadRequirement } from "./requirement_manager.js";

export interface UIPattern {
    name: string;
    description?: string;
    sourceNodeId: string;
    confidence: "HIGH" | "MEDIUM" | "LOW";
    evidence: any;
}

export function discoverUIPatterns(ecosystemRoot: string, query: string, snapshot: GraphSnapshot): UIPattern[] {
    // This looks through the current snapshot for nodes that represent UI_PATTERN or FRONTEND_COMPONENT
    // and matches the query keywords.
    const patterns: UIPattern[] = [];
    const keywords = query.toLowerCase().split(/\s+/);
    
    for (const node of snapshot.nodes) {
        if (node.type === "FRONTEND_COMPONENT" || node.type === "UI_PATTERN") {
            const searchableText = `${node.name} ${JSON.stringify(node.metadata || {})}`.toLowerCase();
            const matches = keywords.some(kw => searchableText.includes(kw));
            if (matches) {
                patterns.push({
                    name: node.name,
                    sourceNodeId: node.id,
                    confidence: "HIGH",
                    evidence: {
                        repository: node.repository,
                        metadata: node.metadata,
                        location: node.evidence
                    }
                });
            }
        }
    }
    return patterns;
}

export function generateStaticUIReference(ecosystemRoot: string, designId: string, htmlContent: string, metadata: any): string {
    const designsDir = path.join(ecosystemRoot, ".secufusion", "designs", designId);
    fs.mkdirSync(designsDir, { recursive: true });
    
    // Safety check - force reference identifier
    let safeHtml = htmlContent;
    if (!safeHtml.includes("REFERENCE_ONLY")) {
        safeHtml = `<!-- REFERENCE_ONLY: Static UI Prototype -->\n${safeHtml}`;
    }
    
    const indexPath = path.join(designsDir, "index.html");
    const metaPath = path.join(designsDir, "design.json");
    
    fs.writeFileSync(indexPath, safeHtml, "utf-8");
    fs.writeFileSync(metaPath, JSON.stringify({
        design_id: designId,
        created_at: new Date().toISOString(),
        status: metadata.status || "DRAFT",
        ...metadata
    }, null, 2), "utf-8");
    
    return indexPath;
}

export function getDesignContext(ecosystemRoot: string, requirementId: string, snapshot: GraphSnapshot): any {
    const req = loadRequirement(ecosystemRoot, requirementId);
    if (!req) return { error: "REQUIREMENT_NOT_FOUND" };
    
    // Gather related architecture
    const affectedNodes: GraphNode[] = [];
    if (req.apis) {
        for (const api of req.apis) {
            const node = snapshot.nodes.find(n => n.id === `API:${api}`);
            if (node) affectedNodes.push(node);
        }
    }
    if (req.events) {
        for (const ev of req.events) {
            const node = snapshot.nodes.find(n => n.id === `TOPIC:${ev}`);
            if (node) affectedNodes.push(node);
        }
    }
    
    return {
        requirement: req,
        architecture_context: affectedNodes,
        existing_frontend_patterns: snapshot.nodes.filter(n => n.type === "UI_PATTERN" || n.type === "FRONTEND_COMPONENT").slice(0, 50),
        status: "READY_FOR_DESIGN"
    };
}
