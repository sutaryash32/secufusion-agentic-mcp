// @ts-nocheck
import { z } from "zod";
import { discoverReviewContext, renderContext, recordDraftContext, buildIntentPacket, assessIntent, renderAssessment } from "./review_context.js";
import { judge, judgmentParam, hashOf } from "./judge.js";
const ok = (text) => ({ content: [{ type: "text", text }] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: `Error: ${e?.message ?? e}` }] });
const json = (o) => ok(JSON.stringify(o, null, 2));
const cite = z.object({ file: z.string(), line: z.number().int().optional(), quote: z.string().optional() });
const intentSchema = z.object({
    hypotheses: z.array(z.object({
        id: z.string(), statement: z.string().min(15), work_type: z.string().optional(), confidence: z.number().min(0).max(100),
        supports: z.array(cite).optional(), contradicts: z.array(cite).optional(), would_confirm: z.string().optional(),
    })).min(1),
    leading: z.string(),
    intent: z.object({ problem: z.string().min(10), work_type: z.string(), domain: z.string().optional(), outcome: z.string().optional(), services: z.array(z.string()).optional() }),
    confidence: z.number().min(0).max(100),
    investigated: z.array(z.string()).optional(),
    investigate_next: z.array(z.object({ what: z.string(), why: z.string(), how: z.string().optional() })).optional(),
    questions: z.array(z.object({ question: z.string().min(10), why_needed: z.string(), why_not_inferable: z.string(), confidence_impact: z.string() })).optional(),
    risks: z.array(z.object({ risk: z.string(), source: z.string() })).optional(),
    assumptions: z.array(z.string()).optional(),
});
export function registerContextTools(server) {
    server.tool("reason_about_intent", "Intent reasoning for a review with no task. The server gathers the evidence a senior engineer would start from (the diff's changed functions and added lines, the commits and branch, candidate task folders, the project's invariants, decisions and lessons that apply, the authority fields the diff writes, the lifecycle paths it touches) and asks the model to INVESTIGATE: at least two competing hypotheses of what the developer is doing and why, the evidence that tells them apart, what it read, what it would read next, risks tied to the product's own rules, and questions only for what is critical, not inferable and not discoverable. " +
        "Uses the server's sampling when the client supports it, otherwise returns a JUDGMENT REQUEST to answer and pass back as `judgment`. The tool then VERIFIES every cited line against the code, caps a hypothesis nothing supports at 40%, penalises a contradiction, treats a runner-up within 10 points as ambiguity, sets the confidence level (HIGH >= 80, MEDIUM 50-79, LOW < 50) and applies the context protocol to the questions: none at HIGH beyond optional confirmations, at most 3 at MEDIUM, at most 5 at LOW, and a question that is not shown to be non-inferable is withheld. Any language. READ-ONLY: judgments are not stored.", {
        workspace_root: z.string().describe("The repository root"),
        base: z.string().optional().describe("Git ref the change is compared with (default: merge-base with origin/main, main, develop)"),
        files: z.array(z.string()).max(2000).optional().describe("Changed files, in addition to what git reports"),
        judgment: judgmentParam,
        format: z.enum(["blocks", "json"]).optional(),
    }, async ({ workspace_root, base, files, judgment, format }) => {
        try {
            const c = discoverReviewContext(workspace_root, { base, files });
            const packet = buildIntentPacket(workspace_root, c);
            const outcome = await judge(server, workspace_root, {
                kind: "intent-reasoning",
                subject: hashOf({ files: c.files.all, commits: c.commits.map((x) => x.hash), branch: c.branch }),
                role: "senior reviewer who has just inherited this pull request, knows this product, and does their own investigation before asking anyone anything",
                rubric: [
                    "Do not stop at the first plausible reading. State at least two competing hypotheses of what the developer is doing and why (work type, problem, outcome), and the evidence that would distinguish them.",
                    "Ground every hypothesis: cite file, line and a quote copied from the code, the commits or the task folder. A citation that is not in the files is discarded by the server and lowers your confidence; a hypothesis with no verified support is capped at 40.",
                    "Read the diff as THIS product would. Which accepted invariants, decisions and lessons in the packet does it touch? Which authority or ownership fields does it write, which lifecycle paths does it change, who else reads those fields? Intent that conflicts with a recorded rule is the most important thing you can find: say so.",
                    "Investigate before you ask. List what you read (`investigated`) and what you would read next and why (`investigate_next`: callers, tests, history, the other service). Ask the developer only what is critical, not inferable, not discoverable and blocking.",
                    "Every question carries why_needed, why_not_inferable (specifically: what you looked at and why it did not answer it) and confidence_impact, and is phrased 'I believe X because Y; confirm or correct'. If your confidence is 80 or more there should be nothing to ask.",
                    "Estimate confidence honestly, 0 to 100. Name risks with their source (a rule, an entry, a consumer, a line). State assumptions as assumptions, never as facts.",
                ],
                evidence: packet,
                schema: intentSchema,
                schemaHint: '{"hypotheses":[{"id":"H1","statement":"...","work_type":"Bug Fix|Enhancement|Refactor|Spike|Technical Debt|Hotfix","confidence":0-100,"supports":[{"file":"path","line":12,"quote":"code copied from the file"}],"contradicts":[],"would_confirm":"what would settle it"}],"leading":"H1","intent":{"problem":"...","work_type":"...","domain":"...","outcome":"...","services":["..."]},"confidence":0-100,"investigated":["what you read"],"investigate_next":[{"what":"...","why":"...","how":"..."}],"questions":[{"question":"I believe X because Y; confirm or correct","why_needed":"...","why_not_inferable":"...","confidence_impact":"..."}],"risks":[{"risk":"...","source":"..."}],"assumptions":["..."]}',
                supplied: judgment,
                reinvoke: "reason_about_intent",
                persist: false,
            });
            if (outcome.status !== "ok")
                return ok(outcome.text);
            const a = assessIntent(workspace_root, outcome.verdict);
            if (format === "json")
                return json({ assessment: a, intent: outcome.verdict.intent, coverage: c.coverage, source: outcome.source });
            return ok(`Coverage ${c.coverage}% · reasoning by the ${outcome.source === "sampling" ? "client's model (sampling)" : "calling model"}, citations verified against the code\n\n` + renderAssessment(a, outcome.verdict.intent) + `\n\nRecord the confidence so its progression can be measured: record_draft_task_context with confidence {stage: "inferred", intent: ${a.confidence}, coverage: ${c.coverage}}, and again with stage "confirmed" after the developer answers.`);
        }
        catch (e) {
            return fail(e);
        }
    });
    server.tool("discover_review_context", "Chooses the review mode and discovers the context. /sfn-review has two modes: Mode 1, Existing Task Review (a work item whose task folder holds a specification: the intent is confirmed) and Mode 2, Context Discovery Review (no task id, no specification or no acceptance criteria: the intent is reconstructed and stays INFERRED until confirmed). Pass `work_item` as the user wrote it and the mode is decided deterministically, with the reason, what Mode 1 would be missing, and a task folder that may explain the diff (proposed, never adopted silently). A reference whose type conflicts with an existing folder is an IDENTITY CONFLICT, not a choice. For Mode 2, before anyone is asked anything it inspects what already exists: the branch, staged, modified and untracked files, the changed modules, commit messages, task folders and their specifications, acceptance criteria, decision logs and review history, draft contexts left by earlier reviews, and the project knowledge in .mcp/. " +
        "It returns the CONTEXT COMPLETENESS REPORT (each source found or missing, and a coverage score), hints about the intent (work type with its evidence and any ambiguity, references seen in the branch and commits, change signals, whether a draft task is backend, frontend, full stack, extension or infrastructure), task folders that may explain the diff (candidates, never adopted silently), and a provisional reference for a draft context. " +
        "The intent itself is for you to infer from this evidence. Any language. READ-ONLY.", {
        workspace_root: z.string().describe("The repository root"),
        base: z.string().optional().describe("Git ref the change is compared with (default: merge-base with origin/main, main, develop)"),
        files: z.array(z.string()).max(2000).optional().describe("Changed files, in addition to what git reports"),
        max_commits: z.number().int().min(1).max(100).optional(),
        work_item: z.string().optional().describe("The work item reference exactly as the user gave it, if any: it decides the review mode"),
        format: z.enum(["blocks", "json"]).optional(),
    }, async ({ workspace_root, base, files, max_commits, work_item, format }) => {
        try {
            const c = discoverReviewContext(workspace_root, { base, files, max_commits, work_item });
            return format === "json" ? json(c) : ok(renderContext(c));
        }
        catch (e) {
            return fail(e);
        }
    });
    server.tool("record_draft_task_context", "Creates or updates the temporary task context for a review that has no task: a provisional reference (BE-TASK-Dnnn backend, FE-TASK-Dnnn frontend, FS-TASK-Dnnn full stack, EXT-TASK-Dnnn extension, INFRA-TASK-Dnnn infrastructure) and a draft in .secufusion/tasks/<ref>-draft-<title>/ holding the intent, assumptions, constraints, risks, inferred requirements and missing requirements, each marked CONFIRMED, INFERRED or UNKNOWN. " +
        "It refuses to store inferred information as confirmed fact: CONFIRMED needs `confirmed_by` (the developer's own words), INFERRED needs `source` (the evidence), a missing requirement must be UNKNOWN. `summary` carries the knowledge captured at the end of the review (task summary, business intent, architecture impact, known risks, findings, open questions, follow-ups) so the next review starts from it. " +
        "A provisional reference is NOT a work item: never use it in a branch, commit, pull request or Azure Boards entry; pass `linked_ref` once the real reference is known. Preview by default; writes only context.draft.json and context.draft.md, only with apply=true. Does not touch the task registry.", {
        workspace_root: z.string().describe("The repository root"),
        ref: z.string().optional().describe("An existing draft reference (BE-TASK-D001) to update; omit to create a new one with `prefix`"),
        prefix: z.enum(["BE", "FE", "FS", "EXT", "INFRA"]).optional().describe("Task type for a new draft (discover_review_context proposes it)"),
        title: z.string().min(3).max(120),
        entries: z.array(z.object({
            kind: z.enum(["intent", "assumption", "constraint", "risk", "requirement", "missing", "decision", "acceptance"]),
            text: z.string().min(5).max(600),
            status: z.enum(["CONFIRMED", "INFERRED", "UNKNOWN"]),
            source: z.string().max(300).optional().describe("Required for INFERRED: file:line, commit, branch or task folder it was inferred from"),
            confirmed_by: z.string().max(400).optional().describe("Required for CONFIRMED: the developer's own words"),
        })).max(120),
        summary: z.object({
            task_summary: z.string().max(3000).optional(), business_intent: z.string().max(3000).optional(), architecture_impact: z.string().max(3000).optional(),
            known_risks: z.array(z.string().max(500)).max(30).optional(), review_findings: z.array(z.string().max(500)).max(60).optional(),
            open_questions: z.array(z.string().max(500)).max(30).optional(), follow_ups: z.array(z.string().max(500)).max(30).optional(),
        }).optional(),
        files: z.array(z.string()).max(2000).optional().describe("The changed files this context explains: lets the next review find it again"),
        branch: z.string().optional(), base: z.string().optional(),
        linked_ref: z.string().optional().describe("The real work-item reference, once it is known"),
        confidence: z.object({ stage: z.enum(["inferred", "confirmed", "final"]), intent: z.number().min(0).max(100), coverage: z.number().min(0).max(100).optional(), note: z.string().max(200).optional() }).optional().describe("How well the intent is understood now (reason_about_intent gives the number). Recorded as a progression: before and after the developer confirms."),
        apply: z.boolean().optional().describe("false/omitted = preview only. true = write the two draft files."),
        format: z.enum(["blocks", "json"]).optional(),
    }, async ({ workspace_root, apply, format, ...input }) => {
        try {
            const r = recordDraftContext(workspace_root, input, !!apply);
            if (format === "json")
                return json({ ...r, preview: undefined });
            return ok(`${r.written ? "✅ Draft task context written" : "👁 Preview only: nothing was written"}\n${r.ref}  ${r.folder}\n${r.json}\n${r.md}\n${r.entries} entr${r.entries === 1 ? "y" : "ies"}: ${r.counts.CONFIRMED} confirmed, ${r.counts.INFERRED} inferred, ${r.counts.UNKNOWN} unknown${r.progression.length ? `\nConfidence: ${r.progression.map((e) => `${e.stage} ${e.intent}%`).join(" → ")}` : ""}\n\nThe reference ${r.ref} is provisional: it is not a work item. Do not use it in a branch, commit, pull request or Azure Boards entry.${r.written ? "" : "\n\nTo write it, call again with apply=true."}\n\n---\n${r.preview}`);
        }
        catch (e) {
            return fail(e);
        }
    });
}
