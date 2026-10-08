// @ts-nocheck
import fs from "fs";
import { z } from "zod";
import { getEcosystemRoot, getDnaPath } from "./shared.js";
import { loadRequirement } from "./requirement_manager.js";
import { discoverUIPatterns, getDesignContext } from "./ui_intelligence.js";
import {
  ExplorationError, DECISION_CATEGORIES, suggestUiImpact, setUiImpact, askUserDecision, answerUserDecision,
  formatUserDecision, createUiReference, recordUiFeedback, explorationStatus,
} from "./exploration.js";

const ok = (text: string) => ({ content: [{ type: "text", text }] });
const fail = (text: string) => ({ isError: true, content: [{ type: "text", text }] });

function loadGraph(ecosystemRoot: string) {
  const dnaPath = getDnaPath(ecosystemRoot);
  if (!fs.existsSync(dnaPath)) return null;
  try { return JSON.parse(fs.readFileSync(dnaPath, "utf-8")).graph ?? null; } catch { return null; }
}

const wrap = (fn: () => string) => {
  try { return ok(fn()); }
  catch (e: any) { return fail(e instanceof ExplorationError ? `⛔ ${e.message}` : `Error: ${e.message}`); }
};

export function registerExploreTools(server: any): void {
  server.tool(
    "get_design_context",
    "Gathers the architecture, requirement and existing-frontend facts needed to design a UI change. Read-only evidence; call before discover_ui_patterns.",
    {
      workspace_root: z.string().describe("Root directory of the workspace"),
      requirement_id: z.string().describe("Requirement being explored"),
    },
    async ({ workspace_root, requirement_id }) => wrap(() => {
      const root = getEcosystemRoot(workspace_root);
      const graph = loadGraph(root);
      if (!graph) throw new ExplorationError("No DNA graph found. Run /sfn-init (or refresh_repository_knowledge) first.");
      return JSON.stringify(getDesignContext(root, requirement_id, graph), null, 2);
    })
  );

  server.tool(
    "discover_ui_patterns",
    "Finds existing frontend components and UI patterns (dialogs, tables, confirmations, labels) in the evidence graph that match a query. Prefer extending what exists over inventing a design.",
    {
      workspace_root: z.string().describe("Root directory of the workspace"),
      query: z.string().describe("Keywords, e.g. 'delete user confirmation dialog browsers'"),
    },
    async ({ workspace_root, query }) => wrap(() => {
      const root = getEcosystemRoot(workspace_root);
      const graph = loadGraph(root);
      if (!graph) throw new ExplorationError("No DNA graph found. Run /sfn-init (or refresh_repository_knowledge) first.");
      const patterns = discoverUIPatterns(root, query, graph);
      return JSON.stringify({ query, count: patterns.length, patterns, note: "Open the cited files and read them before claiming how a component behaves." }, null, 2);
    })
  );

  server.tool(
    "generate_static_ui_reference",
    "Writes a bounded, self-contained STATIC HTML reference of a proposed UI under .secufusion/designs/<id>/ (index.html + metadata.json + revisions). " +
    "REFERENCE_ONLY, NOT_PRODUCTION_CODE: it never touches repository source. No network, storage or external assets are allowed; unsafe HTML is rejected. " +
    "Requires ui_impact=YES and evidence of the existing UI you inspected. Calling it again with the same design_id creates a new revision. The reference is NOT approved until the user says so (manage_exploration record_ui_feedback).",
    {
      workspace_root: z.string().describe("Root directory of the workspace"),
      requirement_id: z.string(),
      title: z.string().describe("Short title of the screen/dialog being proposed"),
      html: z.string().describe("Complete self-contained HTML (inline <style>, optional inline <script> for demo interaction only). Mirror the existing SecuFusion/MUI patterns you inspected."),
      purpose: z.string().optional(),
      design_id: z.string().optional().describe("Defaults to DESIGN-<requirement_id>; reuse it to revise."),
      affected_components: z.array(z.string()).optional().describe("Production components this design would change, e.g. 'DeleteDeviceUserDialog'"),
      evidence: z.array(z.string()).optional().describe("Files/components you actually read, e.g. 'sfn-web-ui/src/components/DeleteDeviceUserDialog.jsx:42'"),
      novelty_reason: z.string().optional().describe("Only if no existing pattern applies: why."),
    },
    async ({ workspace_root, requirement_id, ...rest }) => wrap(() => {
      const root = getEcosystemRoot(workspace_root);
      const r = createUiReference(root, requirement_id, rest);
      return [
        `🎨 UI reference ${r.metadata.designId} r${r.metadata.revision} created (REFERENCE_ONLY · NOT_IMPLEMENTED).`,
        `File: ${r.index_path}`,
        ...r.warnings.map((w) => `⚠️ ${w}`),
        ``,
        `Requirement status: ${r.status}`,
        ``,
        `Show this to the user and ask:`,
        `  - Is the layout correct?`,
        `  - Is the terminology correct?`,
        `  - Is anything missing, or should anything be removed?`,
        `  - Should an existing SecuFusion pattern be used instead?`,
        ``,
        `USER_FEEDBACK_REQUIRED — STOP and wait. Do not treat this design as approved. Do not modify production UI.`,
      ].join("\n");
    })
  );

  server.tool(
    "manage_exploration",
    "Interactive-exploration bookkeeping for /sfn-explore. Records UI impact, questions only the USER can answer, the user's replies, and UI-reference feedback, and reports whether the requirement may be CONFIRMED. " +
    "It never decides anything: answers and approvals require the user's verbatim words (user_statement).",
    {
      workspace_root: z.string().describe("Root directory of the workspace"),
      requirement_id: z.string(),
      action: z.enum(["status", "detect_ui_impact", "set_ui_impact", "ask_user_decision", "answer_user_decision", "record_ui_feedback"]),
      // set_ui_impact
      impact: z.enum(["YES", "NO"]).optional(),
      rationale: z.string().optional(),
      affected_components: z.array(z.string()).optional(),
      evidence: z.array(z.string()).optional(),
      // ask_user_decision
      category: z.enum(DECISION_CATEGORIES).optional(),
      question: z.string().optional(),
      options: z.array(z.string()).optional(),
      // answer_user_decision
      decision_id: z.string().optional(),
      answer: z.string().optional(),
      // answer_user_decision / record_ui_feedback
      user_statement: z.string().optional().describe("The user's own reply, verbatim. Required for answers and approvals."),
      // record_ui_feedback
      outcome: z.enum(["APPROVED", "CHANGES_REQUESTED", "NO_UI_REQUIRED"]).optional(),
      feedback: z.string().optional(),
    },
    async (a) => wrap(() => {
      const root = getEcosystemRoot(a.workspace_root);
      const id = a.requirement_id;
      const need = (...keys: string[]) => {
        const missing = keys.filter((k) => a[k] === undefined || a[k] === "");
        if (missing.length) throw new ExplorationError(`${a.action} requires: ${missing.join(", ")}`);
      };

      switch (a.action) {
        case "status":
          return JSON.stringify(explorationStatus(root, id), null, 2);

        case "detect_ui_impact": {
          const req = loadRequirement(root, id);
          if (!req) throw new ExplorationError(`Requirement ${id} not found.`);
          return JSON.stringify(suggestUiImpact(req, loadGraph(root) ?? undefined), null, 2);
        }

        case "set_ui_impact": {
          need("impact", "rationale");
          const r = setUiImpact(root, id, { impact: a.impact, rationale: a.rationale, affected_components: a.affected_components, evidence: a.evidence });
          return `UI impact recorded: ${r.ui_impact.status}. Requirement status: ${r.status}.\n` +
            r.warnings.map((w) => `⚠️ ${w}`).join("\n") +
            (r.ui_impact.status === "YES"
              ? `\nNext: get_design_context + discover_ui_patterns, read the existing components, then generate_static_ui_reference.`
              : `\nNo UI reference is needed. Continue investigating, then resolve decisions and assess.`);
        }

        case "ask_user_decision": {
          need("category", "question", "options");
          const r = askUserDecision(root, id, { category: a.category, question: a.question, options: a.options, evidence: a.evidence });
          return formatUserDecision(r.decision, id) + (r.warnings.length ? `\n\n${r.warnings.map((w) => `⚠️ ${w}`).join("\n")}` : "") + `\n\n(Requirement status: ${r.status})`;
        }

        case "answer_user_decision": {
          need("decision_id", "answer", "user_statement");
          const r = answerUserDecision(root, id, { decision_id: a.decision_id, answer: a.answer, user_statement: a.user_statement });
          return `Recorded ${r.decision.id}: "${r.decision.answer}". Requirement status: ${r.status}.\n` +
            `Run manage_exploration action=status to see what is still outstanding.`;
        }

        case "record_ui_feedback": {
          need("outcome", "user_statement");
          const r = recordUiFeedback(root, id, { outcome: a.outcome, feedback: a.feedback, user_statement: a.user_statement });
          const next =
            a.outcome === "CHANGES_REQUESTED" ? `Regenerate the reference applying the feedback (generate_static_ui_reference, same design_id), then ask the user again.`
            : `UI reference ${a.outcome === "APPROVED" ? "CONFIRMED (UI_REFERENCE_CONFIRMED)" : "not required"}. Run action=status for remaining work.`;
          return `Feedback recorded. Requirement status: ${r.status}.\n${next}`;
        }
      }
    })
  );
}
