const fs = require('fs');

let content = fs.readFileSync('mcp/src/server.ts', 'utf8');

const importsToAdd = `
import { loadPlan, savePlan, validatePlan, ImplementationPlan } from "./implementation_plan.js";
import { generateTestObligations, aggregateValidation } from "./validation_engine.js";
import { recordExperience, loadExperience } from "./experience_manager.js";
import { loadRequirement } from "./requirement_manager.js";
`;

if (!content.includes('import { loadPlan')) {
    content = content.replace('import { loadTraceability', importsToAdd + 'import { loadTraceability');
}

const phase4Tools = `
server.tool(
  "manage_implementation_plan",
  "Creates, retrieves, or updates an implementation plan.",
  {
    workspace_root: z.string().describe("Root directory of the workspace"),
    id: z.string().describe("Plan ID"),
    requirement_id: z.string().optional().describe("Associated requirement ID"),
    action: z.enum(["create", "get", "update"]),
    status: z.enum(["DRAFT", "VALIDATED", "IMPLEMENTING", "VALIDATING", "REVIEWED", "COMPLETED", "BLOCKED"]).optional(),
    summary: z.string().optional(),
    affected_services: z.array(z.string()).optional(),
    affected_files: z.array(z.string()).optional(),
    api_changes: z.array(z.string()).optional(),
    database_changes: z.array(z.string()).optional(),
    event_changes: z.array(z.string()).optional(),
    frontend_changes: z.array(z.string()).optional(),
    extension_changes: z.array(z.string()).optional(),
    security_implications: z.array(z.string()).optional(),
    implementation_steps: z.array(z.string()).optional(),
    test_obligations: z.array(z.string()).optional(),
    validation_requirements: z.array(z.string()).optional(),
    traceability_requirements: z.array(z.string()).optional(),
    risks: z.array(z.string()).optional(),
    assumptions: z.array(z.string()).optional(),
    unknowns: z.array(z.string()).optional(),
    blockers: z.array(z.string()).optional()
  },
  async (args) => {
    try {
        const ecosystemRoot = getEcosystemRoot(args.workspace_root);
        let plan = loadPlan(ecosystemRoot, args.id);
        
        if (args.action === "get") {
            if (!plan) return { content: [{ type: "text", text: "Plan not found." }], isError: true };
            return { content: [{ type: "text", text: JSON.stringify(plan, null, 2) }] };
        }
        
        if (args.action === "create") {
            if (plan) return { content: [{ type: "text", text: "Plan already exists." }], isError: true };
            plan = {
                id: args.id,
                requirement_id: args.requirement_id || "",
                status: args.status || "DRAFT",
                summary: args.summary || "",
                affected_services: args.affected_services || [],
                affected_files: args.affected_files || [],
                api_changes: args.api_changes || [],
                database_changes: args.database_changes || [],
                event_changes: args.event_changes || [],
                frontend_changes: args.frontend_changes || [],
                extension_changes: args.extension_changes || [],
                security_implications: args.security_implications || [],
                implementation_steps: args.implementation_steps || [],
                test_obligations: args.test_obligations || [],
                validation_requirements: args.validation_requirements || [],
                traceability_requirements: args.traceability_requirements || [],
                risks: args.risks || [],
                assumptions: args.assumptions || [],
                unknowns: args.unknowns || [],
                blockers: args.blockers || [],
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                snapshot_id: "LATEST"
            };
            savePlan(ecosystemRoot, plan);
            return { content: [{ type: "text", text: "Plan created." }] };
        }
        
        if (args.action === "update") {
            if (!plan) return { content: [{ type: "text", text: "Plan not found." }], isError: true };
            if (args.status) plan.status = args.status as any;
            if (args.summary) plan.summary = args.summary;
            if (args.affected_services) plan.affected_services = args.affected_services;
            if (args.affected_files) plan.affected_files = args.affected_files;
            if (args.api_changes) plan.api_changes = args.api_changes;
            if (args.database_changes) plan.database_changes = args.database_changes;
            if (args.event_changes) plan.event_changes = args.event_changes;
            if (args.frontend_changes) plan.frontend_changes = args.frontend_changes;
            if (args.extension_changes) plan.extension_changes = args.extension_changes;
            if (args.security_implications) plan.security_implications = args.security_implications;
            if (args.implementation_steps) plan.implementation_steps = args.implementation_steps;
            if (args.test_obligations) plan.test_obligations = args.test_obligations;
            if (args.validation_requirements) plan.validation_requirements = args.validation_requirements;
            if (args.traceability_requirements) plan.traceability_requirements = args.traceability_requirements;
            if (args.risks) plan.risks = args.risks;
            if (args.assumptions) plan.assumptions = args.assumptions;
            if (args.unknowns) plan.unknowns = args.unknowns;
            if (args.blockers) plan.blockers = args.blockers;
            
            savePlan(ecosystemRoot, plan);
            return { content: [{ type: "text", text: "Plan updated." }] };
        }
        
        return { content: [{ type: "text", text: "Unknown action." }], isError: true };
    } catch (e) {
        return { content: [{ type: "text", text: \`Error: \${e.message}\` }], isError: true };
    }
  }
);

server.tool(
  "validate_implementation_plan",
  "Validates a plan before execution, generating the deterministic validation state (PASS, FAIL, BLOCKED, etc).",
  {
    workspace_root: z.string().describe("Root directory of the workspace"),
    plan_id: z.string().describe("Plan ID")
  },
  async ({ workspace_root, plan_id }) => {
    try {
        const ecosystemRoot = getEcosystemRoot(workspace_root);
        const plan = loadPlan(ecosystemRoot, plan_id);
        if (!plan) return { content: [{ type: "text", text: "Plan not found." }], isError: true };
        
        const errors = validatePlan(ecosystemRoot, plan);
        
        // Aggregate Validation
        let reqStatus = "UNKNOWN";
        const req = loadRequirement(ecosystemRoot, plan.requirement_id);
        if (req) reqStatus = req.status;

        const dnaPath = getDnaPath(ecosystemRoot);
        let graph = { nodes: [], edges: [] };
        if (fs.existsSync(dnaPath)) {
            graph = JSON.parse(fs.readFileSync(dnaPath, "utf-8")).graph || graph;
        }

        const edges = loadTraceability(ecosystemRoot);
        const gaps = findTraceabilityGaps(ecosystemRoot, graph as any, edges);
        
        const hasTests = plan.test_obligations.length > 0;
        const hasSecurityUnknowns = plan.unknowns.some(u => u.toLowerCase().includes("security") || u.toLowerCase().includes("auth"));

        const validation = aggregateValidation(reqStatus, errors, hasTests, gaps, hasSecurityUnknowns);
        
        return { content: [{ type: "text", text: JSON.stringify(validation, null, 2) }] };
    } catch (e) {
        return { content: [{ type: "text", text: \`Error: \${e.message}\` }], isError: true };
    }
  }
);

server.tool(
  "get_change_context",
  "Retrieves the consolidated deterministic change context for the host LLM before it writes code.",
  {
    workspace_root: z.string().describe("Root directory of the workspace"),
    plan_id: z.string().describe("Plan ID")
  },
  async ({ workspace_root, plan_id }) => {
    try {
        const ecosystemRoot = getEcosystemRoot(workspace_root);
        const plan = loadPlan(ecosystemRoot, plan_id);
        if (!plan) return { content: [{ type: "text", text: "Plan not found." }], isError: true };
        
        const req = loadRequirement(ecosystemRoot, plan.requirement_id);
        
        const context = {
            requirement: req ? { id: req.id, status: req.status, decisions: req.decisions } : null,
            plan_summary: plan.summary,
            affected_services: plan.affected_services,
            affected_files: plan.affected_files,
            blockers: plan.blockers,
            unknowns: plan.unknowns,
            test_obligations: plan.test_obligations
        };
        
        return { content: [{ type: "text", text: JSON.stringify(context, null, 2) }] };
    } catch (e) {
        return { content: [{ type: "text", text: \`Error: \${e.message}\` }], isError: true };
    }
  }
);

server.tool(
  "generate_test_obligations",
  "Generates test obligations based on the plan changes.",
  {
    workspace_root: z.string().describe("Root directory of the workspace"),
    plan_id: z.string().describe("Plan ID")
  },
  async ({ workspace_root, plan_id }) => {
    try {
        const ecosystemRoot = getEcosystemRoot(workspace_root);
        const plan = loadPlan(ecosystemRoot, plan_id);
        if (!plan) return { content: [{ type: "text", text: "Plan not found." }], isError: true };
        
        const obligations = generateTestObligations(plan);
        return { content: [{ type: "text", text: JSON.stringify(obligations, null, 2) }] };
    } catch (e) {
        return { content: [{ type: "text", text: \`Error: \${e.message}\` }], isError: true };
    }
  }
);

server.tool(
  "record_engineering_experience",
  "Persists explicit engineering decisions or lessons learned to avoid repeating mistakes.",
  {
    workspace_root: z.string().describe("Root directory of the workspace"),
    category: z.enum(["DECISION", "PATTERN", "ANTI_PATTERN", "LESSON", "REJECTED_APPROACH", "ARCHITECTURAL_CONSTRAINT"]),
    title: z.string(),
    description: z.string(),
    context: z.string(),
    related_artifacts: z.array(z.string()).optional()
  },
  async (args) => {
    try {
        const ecosystemRoot = getEcosystemRoot(args.workspace_root);
        const exp = recordExperience(ecosystemRoot, {
            id: \`EXP-\${Date.now()}\`,
            category: args.category as any,
            title: args.title,
            description: args.description,
            context: args.context,
            related_artifacts: args.related_artifacts || []
        });
        return { content: [{ type: "text", text: \`Experience recorded: \${exp.id}\` }] };
    } catch (e) {
        return { content: [{ type: "text", text: \`Error: \${e.message}\` }], isError: true };
    }
  }
);

server.tool(
  "get_engineering_experience",
  "Retrieves past engineering experiences and decisions.",
  {
    workspace_root: z.string().describe("Root directory of the workspace")
  },
  async ({ workspace_root }) => {
    try {
        const ecosystemRoot = getEcosystemRoot(workspace_root);
        const exp = loadExperience(ecosystemRoot);
        return { content: [{ type: "text", text: JSON.stringify(exp, null, 2) }] };
    } catch (e) {
        return { content: [{ type: "text", text: \`Error: \${e.message}\` }], isError: true };
    }
  }
);
`;

if (!content.includes('server.tool(\n  "manage_implementation_plan"')) {
    const qkgIndex = content.indexOf('server.tool(\n  "query_knowledge_graph"');
    if (qkgIndex !== -1) {
        content = content.slice(0, qkgIndex) + phase4Tools + "\n" + content.slice(qkgIndex);
        fs.writeFileSync('mcp/src/server.ts', content);
        console.log("Patched server.ts with Phase 4 tools.");
    }
}
