import fs from "fs";
import path from "path";
import { GraphSnapshot, GraphNode, GraphEdge } from "./graph_builder.js";
import { TraceabilityEdge } from "./traceability_engine.js";
import { Requirement } from "./requirement_manager.js";
import { loadExperience, EngineeringExperience } from "./experience_manager.js";

// --- Types ---
export interface SnapshotIdentity {
    repository?: string;
    branch?: string;
    git_sha?: string;
    timestamp: string;
    schema_version: string;
    graph_version?: string;
}

export interface ArtifactChange {
    category: string;
    artifact_id: string;
    base_evidence?: any;
    current_evidence?: any;
}

export interface DriftObservation {
    category: string;
    affected_component: string;
    base_evidence?: any;
    current_evidence?: any;
    status: string;
}

export interface TraceabilityDrift {
    condition: string;
    source_id: string;
    target_id?: string;
}

export interface RiskIndicator {
    indicator: string;
    evidence: any;
    risk_level: "LOW_EVIDENCE_RISK" | "MODERATE_EVIDENCE_RISK" | "HIGH_EVIDENCE_RISK" | "CRITICAL_EVIDENCE_RISK";
}

export interface RegressionObservation {
    id: string;
    timestamp: string;
    changes: ArtifactChange[];
    risk_indicators: RiskIndicator[];
}

export interface RegressionContext {
    current_changes: ArtifactChange[];
    architecture_drift: DriftObservation[];
    requirement_drift: any[];
    traceability_drift: TraceabilityDrift[];
    historical_experience: any[];
    historical_failures: any[];
    regression_tests: any[];
    risk_indicators: RiskIndicator[];
}

// --- Snapshot Management ---
export function loadSnapshot(ecosystemRoot: string, name: string): GraphSnapshot | null {
    const p = path.join(ecosystemRoot, '.secufusion', `graph.${name}.json`);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf-8"));
}

export function saveSnapshot(ecosystemRoot: string, name: string, snap: GraphSnapshot) {
    const p = path.join(ecosystemRoot, '.secufusion', `graph.${name}.json`);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(snap, null, 2), "utf-8");
}

export function compareRepositorySnapshots(base: GraphSnapshot, current: GraphSnapshot): ArtifactChange[] {
    const changes: ArtifactChange[] = [];
    const baseNodes = new Map(base.nodes.map(n => [n.id, n]));
    const currNodes = new Map(current.nodes.map(n => [n.id, n]));

    for (const [id, curr] of currNodes.entries()) {
        if (!baseNodes.has(id)) {
            changes.push({ category: `${curr.type}_ADDED`, artifact_id: id, current_evidence: curr });
        } else {
            // Assume modified if it exists. A real diff would check metadata.
            const b = baseNodes.get(id);
            if (JSON.stringify(curr.metadata) !== JSON.stringify(b?.metadata)) {
                changes.push({ category: `${curr.type}_MODIFIED`, artifact_id: id, base_evidence: b, current_evidence: curr });
            }
        }
    }
    for (const [id, b] of baseNodes.entries()) {
        if (!currNodes.has(id)) {
            changes.push({ category: `${b.type}_REMOVED`, artifact_id: id, base_evidence: b });
        }
    }
    
    // Edges
    const baseEdges = new Map(base.edges.map(e => [e.id, e]));
    const currEdges = new Map(current.edges.map(e => [e.id, e]));
    
    for (const [id, curr] of currEdges.entries()) {
        if (!baseEdges.has(id)) {
            changes.push({ category: `RELATIONSHIP_ADDED`, artifact_id: id, current_evidence: curr });
        }
    }
    for (const [id, b] of baseEdges.entries()) {
        if (!currEdges.has(id)) {
            changes.push({ category: `RELATIONSHIP_REMOVED`, artifact_id: id, base_evidence: b });
        }
    }

    return changes;
}

// --- Architecture Drift ---
export function detectArchitectureDrift(base: GraphSnapshot, current: GraphSnapshot): DriftObservation[] {
    const drift: DriftObservation[] = [];
    const changes = compareRepositorySnapshots(base, current);
    
    for (const ch of changes) {
        if (ch.category === "RELATIONSHIP_REMOVED" || ch.category === "RELATIONSHIP_ADDED") {
            const edge = ch.current_evidence || ch.base_evidence;
            if (edge.type === "CONSUMES" || edge.type === "PRODUCES") {
                drift.push({ category: "EVENT_DRIFT", affected_component: edge.source, base_evidence: ch.base_evidence, current_evidence: ch.current_evidence, status: "DRIFT_DETECTED" });
            } else if (edge.type === "CALLS") {
                drift.push({ category: "DEPENDENCY_DRIFT", affected_component: edge.source, base_evidence: ch.base_evidence, current_evidence: ch.current_evidence, status: "DRIFT_DETECTED" });
            } else if (edge.type === "OWNS") {
                drift.push({ category: "DATABASE_DRIFT", affected_component: edge.source, base_evidence: ch.base_evidence, current_evidence: ch.current_evidence, status: "DRIFT_DETECTED" });
            } else if (edge.type === "EXPOSES") {
                drift.push({ category: "API_DRIFT", affected_component: edge.source, base_evidence: ch.base_evidence, current_evidence: ch.current_evidence, status: "DRIFT_DETECTED" });
            }
        }
    }
    return drift;
}

// --- Requirement Drift ---
export function detectRequirementDrift(reqs: Requirement[], current: GraphSnapshot): any[] {
    const drift: any[] = [];
    const currNodes = new Map(current.nodes.map(n => [n.id, n]));
    
    for (const req of reqs) {
        if (req.status !== "CONFIRMED") continue;
        if (req.apis) {
            for (const api of req.apis) {
                if (!currNodes.has(`API:${api}`)) {
                    drift.push({ state: "DRIFT_DETECTED", condition: "API_NOT_IN_IMPLEMENTATION", requirement_id: req.id, expected_artifact: api });
                }
            }
        }
    }
    return drift;
}

// --- Traceability Drift ---
export function detectTraceabilityDrift(links: TraceabilityEdge[], current: GraphSnapshot): TraceabilityDrift[] {
    const drift: TraceabilityDrift[] = [];
    const currNodes = new Map(current.nodes.map(n => [n.id, n]));
    
    for (const link of links) {
        if (link.target && ["API", "CLASS", "SERVICE", "DATABASE_TABLE", "TOPIC"].includes(link.type) || link.target.startsWith("API:") || link.target.startsWith("CLASS:")) {
            if (!currNodes.has(link.target)) {
                drift.push({ condition: "CODE_WITHOUT_TRACEABILITY", source_id: link.source, target_id: link.target }); // Target disappeared
            }
        }
    }
    return drift;
}

// --- Historical Matching ---
export function getChangeHistoryContext(ecosystemRoot: string, changes: ArtifactChange[]): any[] {
    const list = loadExperience(ecosystemRoot);
    const affected = new Set(changes.map(c => {
        if (c.current_evidence && c.current_evidence.source) return c.current_evidence.source;
        if (c.base_evidence && c.base_evidence.source) return c.base_evidence.source;
        return c.artifact_id;
    }));
    
    const results = [];
    for (const exp of list) {
        if (exp.status === "RETIRED") continue;
        if (exp.affected_components && exp.affected_components.some(c => affected.has(c))) {
            results.push(exp);
        }
        if (results.length >= 10) break; // Bounded
    }
    return results;
}

export function findRegressionTests(ecosystemRoot: string, changes: ArtifactChange[], tests: any[]): any[] {
    const affected = new Set(changes.map(c => c.artifact_id));
    return tests.filter(t => t.target_components && t.target_components.some((c: string) => affected.has(c)));
}

// --- Risk Indicators ---
export function analyzeRegressionRisk(changes: ArtifactChange[], history: any[], drift: any[], reqDrift: any[], traceDrift: any[], regressionTests: any[]): RiskIndicator[] {
    const risks: RiskIndicator[] = [];
    
    if (history.length > 0) {
        const failures = history.filter(h => h.outcome === "FAILURE" || h.outcome === "BLOCKED");
        if (failures.length > 0) {
            risks.push({ indicator: "HISTORICAL_FAILURE_MATCH", evidence: { matching_history: failures.map(f => f.id) }, risk_level: "HIGH_EVIDENCE_RISK" });
        }
        const experiences = history.filter(h => h.status === "VALIDATED");
        if (experiences.length > 0) {
            risks.push({ indicator: "HISTORICAL_VALIDATED_EXPERIENCE_MATCH", evidence: { matching_experience: experiences.map(e => e.id) }, risk_level: "MODERATE_EVIDENCE_RISK" });
        }
    }
    
    if (drift.length > 0) {
        risks.push({ indicator: "ARCHITECTURE_DRIFT", evidence: { drift_count: drift.length }, risk_level: "MODERATE_EVIDENCE_RISK" });
    }
    
    if (traceDrift.length > 0) {
        risks.push({ indicator: "TRACEABILITY_GAP", evidence: { gaps: traceDrift }, risk_level: "MODERATE_EVIDENCE_RISK" });
    }
    
    // Cross-service
    const services = new Set<string>();
    changes.forEach(c => {
        const node = c.current_evidence || c.base_evidence;
        if (node?.repository) services.add(node.repository);
        if (node?.id?.startsWith("SERVICE:")) services.add(node.id);
    });
    if (services.size > 1) {
        risks.push({ indicator: "CROSS_SERVICE_CHANGE", evidence: { services: Array.from(services) }, risk_level: "HIGH_EVIDENCE_RISK" });
    }
    
    return risks;
}

export function getRegressionContext(ecosystemRoot: string, base: GraphSnapshot, current: GraphSnapshot, reqs: Requirement[], links: TraceabilityEdge[], allTests: any[]): RegressionContext {
    const changes = compareRepositorySnapshots(base, current);
    const archDrift = detectArchitectureDrift(base, current);
    const reqDrift = detectRequirementDrift(reqs, current);
    const traceDrift = detectTraceabilityDrift(links, current);
    
    const history = getChangeHistoryContext(ecosystemRoot, changes);
    const regTests = findRegressionTests(ecosystemRoot, changes, allTests);
    
    // Check regression test gaps
    if (history.some(h => h.outcome === "FAILURE") && regTests.length === 0) {
        traceDrift.push({ condition: "REQUIRED_REGRESSION_TEST_MISSING", source_id: "MULTIPLE" });
    }

    const risks = analyzeRegressionRisk(changes, history, archDrift, reqDrift, traceDrift, regTests);

    return {
        current_changes: changes.slice(0, 50), // Bounded
        architecture_drift: archDrift.slice(0, 20),
        requirement_drift: reqDrift.slice(0, 20),
        traceability_drift: traceDrift.slice(0, 20),
        historical_experience: history.filter(h => h.status === "VALIDATED"),
        historical_failures: history.filter(h => h.outcome === "FAILURE" || h.outcome === "BLOCKED"),
        regression_tests: regTests,
        risk_indicators: risks
    };
}

export function recordRegressionObservation(ecosystemRoot: string, observation: any) {
    const p = path.join(ecosystemRoot, '.secufusion', 'regressions.json');
    let list = [];
    if (fs.existsSync(p)) {
        list = JSON.parse(fs.readFileSync(p, "utf-8"));
    }
    list.push({ ...observation, id: `OBS-${Date.now()}` });
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(list, null, 2), "utf-8");
}
