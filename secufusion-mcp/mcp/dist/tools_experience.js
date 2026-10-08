import { z } from "zod";
import { recordExperience, getEngineeringExperience, validateExperience, getExperienceContext, findExperienceConflicts, findRepeatedOutcomes, markExperienceStale, retireExperience, linkExperience, getLearningFeedback } from "./experience_manager.js";
import { getEcosystemRoot } from "./shared.js";
export function registerExperienceTools(server) {
    server.tool("record_engineering_experience", "Create or update an experience record.", {
        workspace_root: z.string().describe("Root directory of the workspace"),
        id: z.string().optional(),
        title: z.string(),
        summary: z.string(),
        category: z.string(),
        lesson: z.string(),
        context: z.string(),
        trigger: z.string().optional(),
        outcome: z.string().optional(),
        confidence: z.string().optional(),
        status: z.enum(["PROPOSED", "VALIDATED", "STALE", "CONFLICTING", "RETIRED"]).optional(),
        evidence: z.string().optional()
    }, async (args) => {
        try {
            const ecosystemRoot = getEcosystemRoot(args.workspace_root);
            const exp = recordExperience(ecosystemRoot, {
                id: args.id,
                title: args.title,
                summary: args.summary,
                category: args.category,
                lesson: args.lesson,
                context: args.context,
                trigger: args.trigger,
                outcome: args.outcome,
                confidence: args.confidence,
                status: args.status,
                evidence: args.evidence
            });
            return { content: [{ type: "text", text: `Experience recorded: ${exp.id}
${JSON.stringify(exp, null, 2)}` }] };
        }
        catch (e) {
            return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
        }
    });
    server.tool("get_engineering_experience", "Retrieve bounded experience relevant to supplied context.", {
        workspace_root: z.string(),
        query: z.string().describe("Search query for title, summary, or category"),
        affected_components: z.array(z.string()).optional(),
        affected_services: z.array(z.string()).optional(),
        source_requirement_id: z.string().optional()
    }, async (args) => {
        try {
            const ecosystemRoot = getEcosystemRoot(args.workspace_root);
            const res = getEngineeringExperience(ecosystemRoot, args.query, {
                affected_components: args.affected_components,
                affected_services: args.affected_services,
                source_requirement_id: args.source_requirement_id
            });
            return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
        }
        catch (e) {
            return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
        }
    });
    server.tool("validate_experience", "Validate whether an experience record has sufficient evidence to become durable validated knowledge.", {
        workspace_root: z.string(),
        id: z.string(),
        validation_evidence: z.string()
    }, async (args) => {
        try {
            const ecosystemRoot = getEcosystemRoot(args.workspace_root);
            const exp = validateExperience(ecosystemRoot, args.id, args.validation_evidence);
            return { content: [{ type: "text", text: `Experience validated: ${exp.id}` }] };
        }
        catch (e) {
            return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
        }
    });
    server.tool("get_experience_context", "Return experience plus its evidence, provenance, and traceability.", {
        workspace_root: z.string(),
        id: z.string()
    }, async (args) => {
        try {
            const ecosystemRoot = getEcosystemRoot(args.workspace_root);
            const exp = getExperienceContext(ecosystemRoot, args.id);
            return { content: [{ type: "text", text: JSON.stringify(exp, null, 2) }] };
        }
        catch (e) {
            return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
        }
    });
    server.tool("find_experience_conflicts", "Detect conflicting experience records without resolving them.", {
        workspace_root: z.string()
    }, async (args) => {
        try {
            const ecosystemRoot = getEcosystemRoot(args.workspace_root);
            const res = findExperienceConflicts(ecosystemRoot);
            return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
        }
        catch (e) {
            return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
        }
    });
    server.tool("find_repeated_outcomes", "Find repeated validated outcomes across historical work.", {
        workspace_root: z.string()
    }, async (args) => {
        try {
            const ecosystemRoot = getEcosystemRoot(args.workspace_root);
            const res = findRepeatedOutcomes(ecosystemRoot);
            return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
        }
        catch (e) {
            return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
        }
    });
    server.tool("mark_experience_stale", "Mark experience as stale based on repository/evidence changes.", {
        workspace_root: z.string(),
        id: z.string(),
        reason: z.string()
    }, async (args) => {
        try {
            const ecosystemRoot = getEcosystemRoot(args.workspace_root);
            const exp = markExperienceStale(ecosystemRoot, args.id, args.reason);
            return { content: [{ type: "text", text: `Experience marked stale: ${exp.id}` }] };
        }
        catch (e) {
            return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
        }
    });
    server.tool("retire_experience", "Retire an experience record while preserving history.", {
        workspace_root: z.string(),
        id: z.string(),
        reason: z.string()
    }, async (args) => {
        try {
            const ecosystemRoot = getEcosystemRoot(args.workspace_root);
            const exp = retireExperience(ecosystemRoot, args.id, args.reason);
            return { content: [{ type: "text", text: `Experience retired: ${exp.id}` }] };
        }
        catch (e) {
            return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
        }
    });
    server.tool("link_experience", "Create a provenance-backed relationship between experience and requirements/plans/tests.", {
        workspace_root: z.string(),
        id: z.string(),
        source_requirement_id: z.string().optional(),
        source_plan_id: z.string().optional(),
        source_validation_id: z.string().optional(),
        source_test_result_ids: z.array(z.string()).optional(),
        source_traceability_ids: z.array(z.string()).optional()
    }, async (args) => {
        try {
            const ecosystemRoot = getEcosystemRoot(args.workspace_root);
            const exp = linkExperience(ecosystemRoot, args.id, {
                source_requirement_id: args.source_requirement_id,
                source_plan_id: args.source_plan_id,
                source_validation_id: args.source_validation_id,
                source_test_result_ids: args.source_test_result_ids,
                source_traceability_ids: args.source_traceability_ids
            });
            return { content: [{ type: "text", text: `Experience linked: ${exp.id}` }] };
        }
        catch (e) {
            return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
        }
    });
    server.tool("get_learning_feedback", "Return bounded historical feedback relevant to a current requirement or implementation plan.", {
        workspace_root: z.string(),
        requirement_id: z.string(),
        plan_id: z.string().optional()
    }, async (args) => {
        try {
            const ecosystemRoot = getEcosystemRoot(args.workspace_root);
            const res = getLearningFeedback(ecosystemRoot, args.requirement_id, args.plan_id);
            return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
        }
        catch (e) {
            return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
        }
    });
}
