import fs from 'fs';
import path from 'path';
import { buildGraph } from './graph_builder.js';
import { fileURLToPath } from 'url';
export function createFixture(ecosystemRoot) {
    const spec = {
        microservices: {
            "sfn-iam-api": { calls_services: ["sfn-events-api"], owns_tables: ["users", "tenant_mapping", "user_groups"], kafka_consumes: [] },
            "sfn-events-api": { calls_services: [], owns_tables: ["events", "audit_records"], kafka_consumes: ["user-deleted"] }
        }
    };
    const dna = {
        domains: [
            { name: "UserEntity", type: "Entity", repository: "sfn-iam-api", filePath: "src/main/UserEntity.java", violations: [] },
            { name: "TenantEntity", type: "Entity", repository: "sfn-iam-api", filePath: "src/main/TenantEntity.java", violations: [] },
            { name: "EventEntity", type: "Entity", repository: "sfn-events-api", filePath: "src/main/EventEntity.java", violations: [] },
            { name: "RetentionPolicy", type: "Entity", repository: "sfn-events-api", filePath: "src/main/RetentionPolicy.java", violations: [] }
        ],
        events: [
            { className: "UserDeletedListener", repository: "sfn-events-api", filePath: "src/main/UserDeletedListener.java", topicsConsumed: ["user-deleted"], topicsProduced: [] },
            { className: "RetentionCleanupJob", repository: "sfn-events-api", filePath: "src/main/RetentionCleanupJob.java", topicsConsumed: [], topicsProduced: [] }
        ],
        apis: [
            { method: "DELETE", path: "/api/users/{id}", repository: "sfn-iam-api", controllerName: "UserController", filePath: "src/main/UserController.java" },
            { method: "PUT", path: "/api/tenants/{id}/retention", repository: "sfn-events-api", controllerName: "RetentionController", filePath: "src/main/RetentionController.java" }
        ],
        databases: [
            { table: "users", repository: "sfn-iam-api", filePath: "src/main/resources/db/migration/V1__users.sql" },
            { table: "events", repository: "sfn-events-api", filePath: "src/main/resources/db/migration/V1__events.sql" }
        ]
    };
    // Write spec
    fs.writeFileSync(path.join(ecosystemRoot, ".secufusion-project-spec.json"), JSON.stringify(spec, null, 2));
    // Generate graph
    const graph = buildGraph(dna, spec);
    dna.graph = graph;
    const secDir = path.join(ecosystemRoot, ".secufusion");
    if (!fs.existsSync(secDir))
        fs.mkdirSync(secDir, { recursive: true });
    fs.writeFileSync(path.join(secDir, "dna.json"), JSON.stringify(dna, null, 2));
    console.log("Mock fixture generated successfully.");
}
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
    createFixture("c:\\Users\\Yash\\Desktop\\mcp");
}
