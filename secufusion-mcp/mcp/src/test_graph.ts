import { buildGraph, GraphSnapshot } from "./graph_builder.js";
import assert from "assert";

function runTests() {
    console.log("Running Graph Knowledge Base Tests...");
    
    const sampleSpec = {
        microservices: {
            "sfn-iam-api": {
                calls_services: ["sfn-events-api"],
                owns_tables: ["users", "tenant_mapping"],
                kafka_consumes: ["device-events"]
            }
        }
    };

    const sampleDna = {
        domains: [
            { name: "UserEntity", type: "Entity", repository: "sfn-iam-api", filePath: "src/main/UserEntity.java", violations: [] }
        ],
        events: [
            { className: "DeviceEventListener", repository: "sfn-iam-api", filePath: "src/main/Listener.java", topicsConsumed: ["device-events"], topicsProduced: ["user-updated"] }
        ],
        apis: [
            { method: "GET", path: "/api/users", repository: "sfn-iam-api", controllerName: "UserController", filePath: "src/main/UserController.java" }
        ],
        databases: [
            { table: "users", repository: "sfn-iam-api", filePath: "src/main/resources/db/migration/V1__users.sql" }
        ]
    };

    const graph: GraphSnapshot = buildGraph(sampleDna, sampleSpec);
    
    // Test 1: Node Creation
    const svcNode = graph.nodes.find(n => n.id === "SERVICE:sfn-iam-api");
    assert(svcNode, "Service node should exist");
    assert.strictEqual(svcNode.type, "SERVICE");

    const entityNode = graph.nodes.find(n => n.id === "CLASS:UserEntity");
    assert(entityNode, "Entity node should exist");
    assert.strictEqual(entityNode.evidence?.filePath, "src/main/UserEntity.java", "Evidence should be preserved");

    const apiNode = graph.nodes.find(n => n.id === "API:UserController:GET:/api/users");
    assert(apiNode, "API node should exist");

    // Test 2: Edge Creation
    const containsEdge = graph.edges.find(e => e.source === "SERVICE:sfn-iam-api" && e.target === "CLASS:UserEntity" && e.type === "CONTAINS");
    assert(containsEdge, "Service should CONTAIN Entity");
    
    const exposesEdge = graph.edges.find(e => e.source === "SERVICE:sfn-iam-api" && e.target === "API:UserController:GET:/api/users" && e.type === "EXPOSES");
    assert(exposesEdge, "Service should EXPOSE API");

    const callsEdge = graph.edges.find(e => e.source === "SERVICE:sfn-iam-api" && e.target === "SERVICE:sfn-events-api" && e.type === "CALLS");
    assert(callsEdge, "Service should CALL Service (from spec)");

    const consumesEdge = graph.edges.find(e => e.source === "CLASS:DeviceEventListener" && e.target === "TOPIC:device-events" && e.type === "CONSUMES");
    assert(consumesEdge, "Listener should CONSUME Topic");

    const producesEdge = graph.edges.find(e => e.source === "CLASS:DeviceEventListener" && e.target === "TOPIC:user-updated" && e.type === "PRODUCES");
    assert(producesEdge, "Listener should PRODUCE Topic");

    // Test 3: Missing/Unknown Relationships
    const unknownEdge = graph.edges.find(e => e.source === "CLASS:UserEntity" && e.target === "TOPIC:unknown");
    assert(!unknownEdge, "Unknown relationships should not be fabricated");

    console.log("All graph tests passed successfully!");
}

try {
    runTests();
} catch(e) {
    console.error("Test failed:", e);
    process.exit(1);
}
