// @ts-nocheck
import { z } from "zod";
import { analyzeDiffQuality, renderFindingBlocks, THRESHOLDS } from "./diff_quality.js";
import { fixLineEndings } from "./line_ending_fix.js";
import { analyzeMergeRegressions, renderMergeReport } from "./merge_regression.js";
import { analyzeBehaviorChanges, renderBehaviorReport } from "./behavior_change.js";
import { analyzeScopeDrift, renderScopeDrift } from "./scope_drift.js";
import { getEcosystemRoot } from "./shared.js";
import { loadRequirement } from "./requirement_manager.js";
import { findPlanFor } from "./pr_summary.js";

export function registerReviewTools(server: any): void {
  server.tool(
    "normalize_line_endings",
    "Converts files back to ONE line-ending style (e.g. a CRLF file that picked up LF insertions goes back to CRLF). Changes only line terminators: content, BOM, indentation and final-newline state are preserved, and the result is verified. " +
    "The target defaults to the file's OWN convention (repo config, else its style at the base commit); it refuses to guess. Preview is the default: writing needs apply=true AND user_statement (the user's own words asking for the conversion). " +
    "Run check_diff_quality first; do not run this on your own initiative.",
    {
      workspace_root: z.string().describe("A directory inside the git repository"),
      files: z.array(z.string()).min(1).max(50).describe("Repo-relative paths, e.g. the files named in a MIXED_LINE_ENDINGS finding"),
      target: z.enum(["lf", "crlf"]).optional().describe("Override. Omit to use the file's own convention."),
      apply: z.boolean().optional().describe("false/omitted = preview only. true = write the files."),
      user_statement: z.string().optional().describe("Required with apply=true: the user's own words asking for this conversion."),
    },
    async ({ workspace_root, files, target, apply, user_statement }) => {
      try {
        if (apply && !user_statement?.trim()) {
          return { isError: true, content: [{ type: "text", text: "⛔ apply=true needs user_statement: quote the user's request to convert these files. Preview first, show the user, then apply." }] };
        }
        const results = files.map((f) => fixLineEndings(workspace_root, f, { target, apply: !!apply }));
        const lines = results.map((r) => {
          if (!r.ok) return `⛔ ${r.file}: not converted — ${r.reason}`;
          const eol = (i) => i ? (i.state === "MIXED" ? `MIXED (${i.crlf} CRLF, ${i.lf} LF)` : i.state) : "?";
          if (r.lines_changed === 0) return `✓ ${r.file}: ${r.reason} (${eol(r.before)})`;
          return `${r.applied ? "✅ converted" : "👁 would convert"} ${r.file}: ${eol(r.before)} → ${eol(r.after)} · ${r.lines_changed} line ending(s) · target ${r.target.toUpperCase()} from ${r.target_source}`;
        });
        const anyPreview = results.some((r) => r.ok && !r.applied && r.lines_changed > 0);
        return { content: [{ type: "text", text: lines.join("\n") + (anyPreview ? "\n\nPreview only. Show this to the user; to write, call again with apply=true and their user_statement." : "") + (apply && results.some((r) => r.applied) ? "\n\nRe-run check_diff_quality to confirm the findings are gone." : "") }] };
      } catch (e: any) {
        return { isError: true, content: [{ type: "text", text: `Error: ${e.message}` }] };
      }
    }
  );

  server.tool(
    "check_scope_drift",
    "Deterministic first pass for /sfn-review's PR SCOPE DRIFT REVIEW: changes unrelated to the story. Takes the story (work_item_id: its requirement, acceptance criteria and plan), and the files changed (git diff against base plus untracked files), " +
    "and classifies each file as CORE STORY FILE (in the plan or named in the story), INDIRECTLY RELATED (a test of a core file, a lock file, configuration, a migration or documentation of the same service, a neighbour of a core file) or UNRELATED. " +
    "Each UNRELATED file becomes a SCOPE DRIFT block: it does not contribute directly to an acceptance criterion, an architecture decision, a bug fix or a product requirement; recommendation: move to a separate story or explain why it is included. " +
    "REPORT ONLY: scope drift never fails a review. Without a story it cannot classify and says so. It is a first pass from names, the plan and file relationships; confirm or adjust by reading the files. READ-ONLY.",
    {
      workspace_root: z.string().describe("A directory inside the git repository being reviewed"),
      work_item_id: z.string().optional().describe("The story: its requirement, acceptance criteria and plan are loaded from the recorded state. Pass it exactly as given (e.g. STORY-1093)."),
      core_files: z.array(z.string()).optional().describe("Repo-relative files you know are the story's own, in addition to the plan's affected files."),
      base: z.string().optional().describe("Git ref to diff against. Default: merge-base with the default branch, else HEAD (uncommitted changes only)."),
      format: z.enum(["blocks", "json"]).optional().describe("blocks (default): the classification plus SCOPE DRIFT blocks. json: the full structured report."),
    },
    async ({ workspace_root, work_item_id, core_files, base, format }) => {
      try {
        let acceptance_criteria: string[] = [], story_text = "", planned_files: string[] = [];
        const notes: string[] = [];
        if (work_item_id) {
          const eco = getEcosystemRoot(workspace_root);
          const req = loadRequirement(eco, work_item_id);
          const plan = findPlanFor(eco, work_item_id);
          if (req) { acceptance_criteria = req.acceptance_criteria ?? []; story_text += [req.title, req.raw_request, req.scope, ...(req.facts ?? [])].filter(Boolean).join("\n"); }
          if (plan) { planned_files = plan.affected_files ?? []; story_text += "\n" + [plan.summary, ...(plan.implementation_steps ?? []), ...(plan.affected_services ?? [])].filter(Boolean).join("\n"); }
          if (!req && !plan) notes.push(`No requirement or plan is recorded for ${work_item_id}, so the story could not be loaded.`);
        }
        const report = analyzeScopeDrift(workspace_root, { base, acceptance_criteria, story_text, planned_files, core_files });
        report.notes.unshift(...notes);
        if (format === "json") return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
        return { content: [{ type: "text", text: renderScopeDrift(report) }] };
      } catch (e: any) {
        return { isError: true, content: [{ type: "text", text: `Error: ${e.message}` }] };
      }
    }
  );

  server.tool(
    "check_behavior_changes",
    "Deterministic evidence for /sfn-review's SILENT BEHAVIOR CHANGE REVIEW: business behavior that changed even though the code compiles and the tests pass. " +
    "Reads the diff (base to working tree) and surfaces every changed line that carries behavior: authorization checks, validation logic, query predicates, filtering logic, default values, feature flags, conditional statements and time calculations, " +
    "with signals for HOW each changed (a comparison flipped, a number changed, a predicate or reference dropped, a negation appeared, a line removed) and a baseline risk. " +
    "It cannot know what a change means for users or whether anyone intended it: YOU judge that and write the BEHAVIOR CHANGE blocks (Old Behavior, New Behavior, Affected Users, Acceptance Criteria Impact, Risk, Intent Explicitly Confirmed). " +
    "Pattern-based: it surfaces candidates and cannot prove a behavior change or its absence. Test files are not scanned but are listed. READ-ONLY.",
    {
      workspace_root: z.string().describe("A directory inside the git repository being reviewed"),
      base: z.string().optional().describe("Git ref to diff against. Default: merge-base with the default branch, else HEAD (uncommitted changes only)."),
      format: z.enum(["blocks", "json"]).optional().describe("blocks (default): readable candidates. json: the full structured report."),
    },
    async ({ workspace_root, base, format }) => {
      try {
        const report = analyzeBehaviorChanges(workspace_root, { base });
        if (format === "json") return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
        return { content: [{ type: "text", text: renderBehaviorReport(report) }] };
      } catch (e: any) {
        return { isError: true, content: [{ type: "text", text: `Error: ${e.message}` }] };
      }
    }
  );

  server.tool(
    "check_merge_regressions",
    "Deterministic merge-regression scan for /sfn-review (MERGE REGRESSION FINDINGS, a lane separate from story, product and architecture findings). Detects functionality accidentally LOST while a merge was resolved: " +
    "methods, controller endpoints, repository methods and query predicates, security and authorization checks, tests, configuration keys, translation keys, OpenAPI annotations and documentation headings that exist in a parent of a merge commit but are absent in the merge result, " +
    "with the merge commit, each parent and the merge base as evidence. It uses git's three-way logic: a deletion one parent made deliberately and the merge honoured is not reported, and a symbol that moved to another file is not reported. " +
    "Severity: HIGH (security/authorization check, endpoint, repository query lost), MEDIUM (methods, tests, config keys, changed public signatures), LOW (translation keys, OpenAPI annotations, documentation). " +
    "READ-ONLY and advisory: it never deletes, restores or modifies code, and a missing symbol is a POSSIBLE MERGE REGRESSION, not dead code. The developer decides whether each difference is intentional. " +
    "Also works on a merge in progress (MERGE_HEAD). A branch that was rebased or squashed leaves no merge commit and cannot be scanned.",
    {
      workspace_root: z.string().describe("A directory inside the git repository being reviewed"),
      base: z.string().optional().describe("Scan merge commits in <merge-base with this ref>..HEAD. Default: the repository's default branch (develop, main or master)."),
      merge_commit: z.string().optional().describe("Scan exactly this merge commit instead."),
      max_merges: z.number().int().min(1).max(50).optional().describe("At most this many merge commits (default 10)."),
      format: z.enum(["blocks", "json"]).optional().describe("blocks (default): ready-to-paste MERGE REGRESSION REVIEW blocks. json: the full structured report."),
    },
    async ({ workspace_root, base, merge_commit, max_merges, format }) => {
      try {
        const report = analyzeMergeRegressions(workspace_root, { base, merge_commit, max_merges });
        if (format === "json") return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
        return { content: [{ type: "text", text: renderMergeReport(report) }] };
      } catch (e: any) {
        return { isError: true, content: [{ type: "text", text: `Error: ${e.message}` }] };
      }
    }
  );

  server.tool(
    "check_diff_quality",
    "Deterministic diff-quality check for /sfn-review (PASS 10). Measures the diff that WOULD BE COMMITTED against the real change, and explains the gap: CRLF/LF conversion, mixed line endings, whitespace rewrites, re-wrapped code, BOM/encoding, end-of-file newline, file mode. " +
    "Follows the repo's existing convention (.gitattributes, .editorconfig, prettier/eslint, the file's own history); consistent CRLF or LF is never a defect by itself. Reports configuration conflicts instead of picking a side. No LLM involved: every finding cites file evidence.",
    {
      workspace_root: z.string().describe("A directory inside the git repository being reviewed"),
      base: z.string().optional().describe("Git ref to diff against. Default: merge-base with the default branch, else HEAD."),
      files: z.array(z.string()).optional().describe("Restrict to these repo-relative paths. Default: everything changed vs base plus untracked files."),
      format: z.enum(["blocks", "json"]).optional().describe("blocks (default): ready-to-paste FINDING 10x blocks plus a summary. json: the full structured report."),
    },
    async ({ workspace_root, base, files, format }) => {
      try {
        const report = analyzeDiffQuality(workspace_root, { base, files });
        if (format === "json") return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
        const classes = new Map<string, number>();
        for (const f of report.files) for (const c of f.classifications) classes.set(c, (classes.get(c) ?? 0) + 1);
        const header =
          `## PASS 10 — Diff quality & line endings\n` +
          `Base: ${report.base ?? "n/a"} (${report.base_reason}) · files analyzed: ${report.files_analyzed}` +
          `${report.truncated ? " (truncated)" : ""} · max severity: ${report.max_severity ?? "none"}\n` +
          `Files by class: ${[...classes].map(([k, v]) => `${k}=${v}`).join(", ") || "none"}\n` +
          `Skipped: ${report.files.filter((f) => f.status === "SKIPPED").map((f) => `${f.file} (${f.skip_reason})`).join("; ") || "none"}\n` +
          (report.notes.length ? report.notes.map((n) => `Note: ${n}`).join("\n") + "\n" : "") +
          `Thresholds: disproportionate when ≥${THRESHOLDS.MIN_CHURN} committed lines and ≤${THRESHOLDS.SEMANTIC_RATIO * 100}% are real changes.\n\n`;
        return { content: [{ type: "text", text: header + renderFindingBlocks(report) }] };
      } catch (e: any) {
        return { isError: true, content: [{ type: "text", text: `Error: ${e.message}` }] };
      }
    }
  );
}
