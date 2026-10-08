// @ts-nocheck
import { z } from "zod";
import { analyzeDiffQuality, renderFindingBlocks, THRESHOLDS } from "./diff_quality.js";
export function registerReviewTools(server) {
    server.tool("check_diff_quality", "Deterministic diff-quality check for /sfn-review (PASS 10). Measures the diff that WOULD BE COMMITTED against the real change, and explains the gap: CRLF/LF conversion, mixed line endings, whitespace rewrites, re-wrapped code, BOM/encoding, end-of-file newline, file mode. " +
        "Follows the repo's existing convention (.gitattributes, .editorconfig, prettier/eslint, the file's own history); consistent CRLF or LF is never a defect by itself. Reports configuration conflicts instead of picking a side. No LLM involved: every finding cites file evidence.", {
        workspace_root: z.string().describe("A directory inside the git repository being reviewed"),
        base: z.string().optional().describe("Git ref to diff against. Default: merge-base with the default branch, else HEAD."),
        files: z.array(z.string()).optional().describe("Restrict to these repo-relative paths. Default: everything changed vs base plus untracked files."),
        format: z.enum(["blocks", "json"]).optional().describe("blocks (default): ready-to-paste FINDING 10x blocks plus a summary. json: the full structured report."),
    }, async ({ workspace_root, base, files, format }) => {
        try {
            const report = analyzeDiffQuality(workspace_root, { base, files });
            if (format === "json")
                return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
            const classes = new Map();
            for (const f of report.files)
                for (const c of f.classifications)
                    classes.set(c, (classes.get(c) ?? 0) + 1);
            const header = `## PASS 10 — Diff quality & line endings\n` +
                `Base: ${report.base ?? "n/a"} (${report.base_reason}) · files analyzed: ${report.files_analyzed}` +
                `${report.truncated ? " (truncated)" : ""} · max severity: ${report.max_severity ?? "none"}\n` +
                `Files by class: ${[...classes].map(([k, v]) => `${k}=${v}`).join(", ") || "none"}\n` +
                `Skipped: ${report.files.filter((f) => f.status === "SKIPPED").map((f) => `${f.file} (${f.skip_reason})`).join("; ") || "none"}\n` +
                (report.notes.length ? report.notes.map((n) => `Note: ${n}`).join("\n") + "\n" : "") +
                `Thresholds: disproportionate when ≥${THRESHOLDS.MIN_CHURN} committed lines and ≤${THRESHOLDS.SEMANTIC_RATIO * 100}% are real changes.\n\n`;
            return { content: [{ type: "text", text: header + renderFindingBlocks(report) }] };
        }
        catch (e) {
            return { isError: true, content: [{ type: "text", text: `Error: ${e.message}` }] };
        }
    });
}
