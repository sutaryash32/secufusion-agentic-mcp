const fs = require('fs');

let content = fs.readFileSync('mcp/src/server.ts', 'utf8');

// 1. Add imports
const importsToAdd = `import { Requirement, loadRequirement, saveRequirement, validateStateTransition, generateConfirmedSpecification } from "./requirement_manager.js";
import { investigateEntity, investigateRelationship } from "./investigation_engine.js";
`;

if (!content.includes('import { Requirement')) {
    content = content.replace('import { buildGraph }', importsToAdd + 'import { buildGraph }');
}

// 2. Add manage_requirement tool
const manageReqTool = `
server.tool(
  "manage_requirement",
  "Manages the structured lifecycle of a requirement, including clarification state and confirmation.",
  {
    workspace_root: z.string().describe("Root directory of the workspace"),
    id: z.string().describe("Stable requirement identifier (e.g. '2847' or 'req-123')."),
    action: z.enum(["create", "update", "read", "add_clarification", "resolve_clarification", "confirm", "generate_spec"]).describe("Action to perform on the requirement."),
    raw_request: z.string().optional(),
    title: z.string().optional(),
    status: z.enum(["RAW", "UNDERSTOOD", "INVESTIGATING", "CLARIFICATION_REQUIRED", "CONFIRMED", "BLOCKED", "SUPERSEDED"]).optional(),
    // Clarification specifics
    clarification_id: z.string().optional(),
    topic: z.string().optional(),
    issue: z.string().optional(),
    severity: z.enum(["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
    blocking: z.boolean().optional(),
    question: z.string().optional(),
    answer: z.string().optional(),
    decision: z.string().optional(),
    // Arrays and updates
    facts: z.array(z.string()).optional(),
    unknowns: z.array(z.string()).optional(),
    blockers: z.array(z.string()).optional()
  },
  async (args) => {
    try {
        const ecosystemRoot = getEcosystemRoot(args.workspace_root);
        let req = loadRequirement(ecosystemRoot, args.id);
        
        if (args.action === "create") {
            if (req) return { content: [{ type: "text", text: \`Requirement \${args.id} already exists.\` }] };
            req = {
                id: args.id,
                title: args.title || "Untitled",
                raw_request: args.raw_request,
                status: args.status || "RAW",
                clarification_questions: []
            };
            saveRequirement(ecosystemRoot, req);
            return { content: [{ type: "text", text: \`Requirement \${args.id} created successfully.\` }] };
        }
        
        if (!req) return { content: [{ type: "text", text: \`Requirement \${args.id} not found.\` }], isError: true };

        if (args.action === "read") {
            return { content: [{ type: "text", text: JSON.stringify(req, null, 2) }] };
        }

        if (args.action === "update") {
            if (args.status) {
                validateStateTransition(req.status, args.status as any, req);
                req.status = args.status as any;
            }
            if (args.title) req.title = args.title;
            if (args.facts) req.facts = args.facts;
            if (args.unknowns) req.unknowns = args.unknowns;
            if (args.blockers) req.blockers = args.blockers;
            
            saveRequirement(ecosystemRoot, req);
            return { content: [{ type: "text", text: \`Requirement \${args.id} updated.\` }] };
        }

        if (args.action === "add_clarification") {
            if (!args.clarification_id || !args.topic || !args.issue || !args.question) {
                return { content: [{ type: "text", text: "Missing clarification fields." }], isError: true };
            }
            req.clarification_questions.push({
                id: args.clarification_id,
                topic: args.topic,
                issue: args.issue,
                state: "OPEN",
                evidence: [],
                severity: (args.severity as any) || "MEDIUM",
                blocking: args.blocking || false,
                question: args.question,
                created_at: new Date().toISOString()
            });
            saveRequirement(ecosystemRoot, req);
            return { content: [{ type: "text", text: \`Clarification \${args.clarification_id} added.\` }] };
        }

        if (args.action === "resolve_clarification") {
            const c = req.clarification_questions.find(q => q.id === args.clarification_id);
            if (!c) return { content: [{ type: "text", text: \`Clarification not found.\` }], isError: true };
            c.state = "RESOLVED";
            c.answer = args.answer;
            c.decision = args.decision;
            c.resolved_at = new Date().toISOString();
            if (args.decision) {
                if (!req.decisions) req.decisions = [];
                req.decisions.push(args.decision);
            }
            saveRequirement(ecosystemRoot, req);
            return { content: [{ type: "text", text: \`Clarification \${args.clarification_id} resolved.\` }] };
        }

        if (args.action === "generate_spec") {
            const spec = generateConfirmedSpecification(req);
            return { content: [{ type: "text", text: spec }] };
        }

        return { content: [{ type: "text", text: \`Unknown action \${args.action}\` }], isError: true };
    } catch (e) {
        return { content: [{ type: "text", text: \`Error: \${e.message}\` }], isError: true };
    }
  }
);
`;

// 3. Add investigate_entity tool
const investigateEntityTool = `
server.tool(
  "investigate_entity",
  "Deterministically searches the repository evidence graph for a specific entity.",
  {
    workspace_root: z.string().describe("Root directory of the workspace"),
    entity_name: z.string().describe("Name of the entity to investigate (e.g. 'User', 'Tenant')")
  },
  async ({ workspace_root, entity_name }) => {
    try {
        const ecosystemRoot = getEcosystemRoot(workspace_root);
        const dnaPath = getDnaPath(ecosystemRoot);
        if (!fs.existsSync(dnaPath)) return { content: [{ type: "text", text: \`No DNA found. Run extraction first.\` }] };
        const dna = JSON.parse(fs.readFileSync(dnaPath, "utf-8"));
        const graph = dna.graph;
        if (!graph) return { content: [{ type: "text", text: "No graph in DNA." }] };
        
        const res = investigateEntity(graph, entity_name);
        return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    } catch (e) {
        return { content: [{ type: "text", text: \`Error: \${e.message}\` }], isError: true };
    }
  }
);
`;

// 4. Add investigate_relationship tool
const investigateRelTool = `
server.tool(
  "investigate_relationship",
  "Deterministically searches the repository evidence graph for relationships between two entities.",
  {
    workspace_root: z.string().describe("Root directory of the workspace"),
    source_entity: z.string().describe("First entity"),
    target_entity: z.string().describe("Second entity")
  },
  async ({ workspace_root, source_entity, target_entity }) => {
    try {
        const ecosystemRoot = getEcosystemRoot(workspace_root);
        const dnaPath = getDnaPath(ecosystemRoot);
        if (!fs.existsSync(dnaPath)) return { content: [{ type: "text", text: \`No DNA found. Run extraction first.\` }] };
        const dna = JSON.parse(fs.readFileSync(dnaPath, "utf-8"));
        const graph = dna.graph;
        if (!graph) return { content: [{ type: "text", text: "No graph in DNA." }] };
        
        const res = investigateRelationship(graph, source_entity, target_entity);
        return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    } catch (e) {
        return { content: [{ type: "text", text: \`Error: \${e.message}\` }], isError: true };
    }
  }
);
`;

if (!content.includes('server.tool(\n  "manage_requirement"')) {
    const qkgIndex = content.indexOf('server.tool(\n  "query_knowledge_graph"');
    if (qkgIndex !== -1) {
        content = content.slice(0, qkgIndex) + manageReqTool + investigateEntityTool + investigateRelTool + "\n" + content.slice(qkgIndex);
    }
}

fs.writeFileSync('mcp/src/server.ts', content);
console.log("Patched server.ts with Phase 2 tools.");
