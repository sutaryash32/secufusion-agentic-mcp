// @ts-nocheck
import { z } from "zod";
import { analyzeDiffQuality, renderFindingBlocks, THRESHOLDS } from "./diff_quality.js";
import { fixLineEndings } from "./line_ending_fix.js";
export function registerReviewTools(server) {
    server.tool("normalize_line_endings", "Converts files back to ONE line-ending style (e.g. a CRLF file that picked up LF insertions goes back to CRLF). Changes only line terminators: content, BOM, indentation and final-newline state are preserved, and the result is verified. " +
        "The target defaults to the file's OWN convention (repo config, else its style at the base commit); it refuses to guess. Preview is the default: writing needs apply=true AND user_statement (the user's own words asking for the conversion). " +
        "Run check_diff_quality first; do not run this on your own initiative.", {
        workspace_root: z.string().describe("A directory inside the git repository"),
        files: z.array(z.string()).min(1).max(50).describe("Repo-relative paths, e.g. the files named in a MIXED_LINE_ENDINGS finding"),
        target: z.enum(["lf", "crlf"]).optional().describe("Override. Omit to use the file's own convention."),
        apply: z.boolean().optional().describe("false/omitted = preview only. true = write the files."),
        user_statement: z.string().optional().describe("Required with apply=true: the user's own words asking for this conversion."),
    }, async ({ workspace_root, files, target, apply, user_statement }) => {
        try {
            if (apply && !user_statement?.trim()) {
                return { isError: true, content: [{ type: "text", text: "⛔ apply=true needs user_statement: quote the user's request to convert these files. Preview first, show the user, then apply." }] };
            }
            const results = files.map((f) => fixLineEndings(workspace_root, f, { target, apply: !!apply }));
            const lines = results.map((r) => {
                if (!r.ok)
                    return `⛔ ${r.file}: not converted — ${r.reason}`;
                const eol = (i) => i ? (i.state === "MIXED" ? `MIXED (${i.crlf} CRLF, ${i.lf} LF)` : i.state) : "?";
                if (r.lines_changed === 0)
                    return `✓ ${r.file}: ${r.reason} (${eol(r.before)})`;
                return `${r.applied ? "✅ converted" : "👁 would convert"} ${r.file}: ${eol(r.before)} → ${eol(r.after)} · ${r.lines_changed} line ending(s) · target ${r.target.toUpperCase()} from ${r.target_source}`;
            });
            const anyPreview = results.some((r) => r.ok && !r.applied && r.lines_changed > 0);
            return { content: [{ type: "text", text: lines.join("\n") + (anyPreview ? "\n\nPreview only. Show this to the user; to write, call again with apply=true and their user_statement." : "") + (apply && results.some((r) => r.applied) ? "\n\nRe-run check_diff_quality to confirm the findings are gone." : "") }] };
        }
        catch (e) {
            return { isError: true, content: [{ type: "text", text: `Error: ${e.message}` }] };
        }
    });
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
