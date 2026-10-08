export interface SourceLocation {
    repository?: string;
    filePath: string;
}

export interface GraphNode {
    id: string;
    type: string;
    name: string;
    repository?: string;
    metadata?: any;
    evidence?: SourceLocation;
}

export interface GraphEdge {
    id: string;
    source: string;
    target: string;
    type: string;
    evidence?: SourceLocation;
}

export interface GraphSnapshot {
    schema_version: string;
    nodes: GraphNode[];
    edges: GraphEdge[];
}

export function buildGraph(dna: any, spec: any): GraphSnapshot {
    const nodes: Map<string, GraphNode> = new Map();
    const edges: Map<string, GraphEdge> = new Map();

    function addNode(node: GraphNode) {
        if (!nodes.has(node.id)) {
            nodes.set(node.id, node);
        }
    }

    function addEdge(edge: GraphEdge) {
        if (!edges.has(edge.id)) {
            edges.set(edge.id, edge);
        }
    }

    // 1. Spec Services
    if (spec && spec.microservices) {
        for (const [svcName, svcData] of Object.entries(spec.microservices)) {
            const svcId = `SERVICE:${svcName}`;
            addNode({ id: svcId, type: "SERVICE", name: svcName, metadata: svcData });
            
            // Calls Services
            if (Array.isArray((svcData as any).calls_services)) {
                for (const targetSvc of (svcData as any).calls_services) {
                    const targetId = `SERVICE:${targetSvc}`;
                    addNode({ id: targetId, type: "SERVICE", name: targetSvc });
                    addEdge({ id: `${svcId}-CALLS-${targetId}`, source: svcId, target: targetId, type: "CALLS" });
                }
            }

            // Owns Tables
            if (Array.isArray((svcData as any).owns_tables)) {
                for (const table of (svcData as any).owns_tables) {
                    const tableId = `DATABASE_TABLE:${table}`;
                    addNode({ id: tableId, type: "DATABASE_TABLE", name: table });
                    addEdge({ id: `${svcId}-OWNS-${tableId}`, source: svcId, target: tableId, type: "OWNS" });
                }
            }

            // Kafka Consumes
            if (Array.isArray((svcData as any).kafka_consumes)) {
                for (const topic of (svcData as any).kafka_consumes) {
                    const topicId = `TOPIC:${topic}`;
                    addNode({ id: topicId, type: "TOPIC", name: topic });
                    addEdge({ id: `${svcId}-CONSUMES-${topicId}`, source: svcId, target: topicId, type: "CONSUMES" });
                }
            }
        }
    }

    // 2. Parsed Domains
    if (Array.isArray(dna.domains)) {
        for (const domain of dna.domains) {
            const classId = `CLASS:${domain.name}`;
            const svcId = `SERVICE:${domain.repository}`;
            addNode({
                id: classId,
                type: "CLASS",
                name: domain.name,
                repository: domain.repository,
                metadata: { type: domain.type, violations: domain.violations },
                evidence: { repository: domain.repository, filePath: domain.filePath }
            });
            addNode({ id: svcId, type: "SERVICE", name: domain.repository });
            addEdge({ id: `${svcId}-CONTAINS-${classId}`, source: svcId, target: classId, type: "CONTAINS", evidence: { repository: domain.repository, filePath: domain.filePath } });
        }
    }

    // 3. Parsed Events
    if (Array.isArray(dna.events)) {
        for (const event of dna.events) {
            const classId = `CLASS:${event.className}`;
            const svcId = `SERVICE:${event.repository}`;
            addNode({
                id: classId,
                type: "CLASS",
                name: event.className,
                repository: event.repository,
                evidence: { repository: event.repository, filePath: event.filePath }
            });
            
            if (Array.isArray(event.topicsConsumed)) {
                for (const topic of event.topicsConsumed) {
                    const topicId = `TOPIC:${topic}`;
                    addNode({ id: topicId, type: "TOPIC", name: topic });
                    addEdge({ id: `${classId}-CONSUMES-${topicId}`, source: classId, target: topicId, type: "CONSUMES", evidence: { repository: event.repository, filePath: event.filePath } });
                }
            }

            if (Array.isArray(event.topicsProduced)) {
                for (const topic of event.topicsProduced) {
                    const topicId = `TOPIC:${topic}`;
                    addNode({ id: topicId, type: "TOPIC", name: topic });
                    addEdge({ id: `${classId}-PRODUCES-${topicId}`, source: classId, target: topicId, type: "PRODUCES", evidence: { repository: event.repository, filePath: event.filePath } });
                }
            }
        }
    }

    // 4. Parsed APIs
    if (Array.isArray(dna.apis)) {
        for (const api of dna.apis) {
            const apiId = `API:${api.controllerName}:${api.method}:${api.path}`;
            const svcId = `SERVICE:${api.repository}`;
            addNode({
                id: apiId,
                type: "API",
                name: `${api.method} ${api.path}`,
                repository: api.repository,
                metadata: { controller: api.controllerName },
                evidence: { repository: api.repository, filePath: api.filePath }
            });
            addEdge({ id: `${svcId}-EXPOSES-${apiId}`, source: svcId, target: apiId, type: "EXPOSES", evidence: { repository: api.repository, filePath: api.filePath } });
        }
    }

    // 5. Parsed Databases
    if (Array.isArray(dna.databases)) {
        for (const db of dna.databases) {
            const tableId = `DATABASE_TABLE:${db.table}`;
            addNode({
                id: tableId,
                type: "DATABASE_TABLE",
                name: db.table,
                repository: db.repository,
                evidence: { repository: db.repository, filePath: db.filePath }
            });
        }
    }

    // 6. Parsed Frontend
    if (Array.isArray(dna.frontend)) {
        for (const fe of dna.frontend) {
            const compId = `FRONTEND_COMPONENT:${fe.componentName || fe.name}`;
            const svcId = `FRONTEND_APP:${fe.repository}`;
            
            addNode({ id: svcId, type: "FRONTEND_APP", name: fe.repository });
            addNode({
                id: compId,
                type: fe.isPattern ? "UI_PATTERN" : "FRONTEND_COMPONENT",
                name: fe.componentName || fe.name,
                repository: fe.repository,
                metadata: { type: fe.type, ...fe },
                evidence: { repository: fe.repository, filePath: fe.filePath }
            });
            addEdge({ id: `${svcId}-CONTAINS-${compId}`, source: svcId, target: compId, type: "CONTAINS" });
            
            if (fe.routes_to) {
                for (const route of fe.routes_to) {
                    const routeId = `FRONTEND_ROUTE:${route}`;
                    addNode({ id: routeId, type: "FRONTEND_ROUTE", name: route });
                    addEdge({ id: `${compId}-ROUTES_TO-${routeId}`, source: compId, target: routeId, type: "ROUTES_TO" });
                }
            }
        }
    }

    return {
        schema_version: "1.0",
        nodes: Array.from(nodes.values()),
        edges: Array.from(edges.values())
    };
}
