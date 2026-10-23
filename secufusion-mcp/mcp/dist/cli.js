#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { parseArgs } from "util";
import { execFileSync } from "child_process";
import { runQuickCheck, renderQuickCheck } from "./quick_check.js";
import { gateDecision, toSarif } from "./review_findings.js";
import { createEngine } from "./engine.js";
import { headlessReview } from "./headless_review.js";
import { renderHtmlReport, recordRun, loadRuns, aggregate, renderMetrics, renderMetricsHtml, suggestReviewers } from "./review_report.js";
import { checkRelease, renderRelease } from "./release_readiness.js";
import { auditDependencies, renderDepAudit } from "./dependency_audit.js";
import { defaultBase } from "./quick_check.js";
/**
 * sfn-ci: the same checks as the MCP tools, for a terminal, a git hook and a pipeline.
 *
 *   sfn-ci quick-check   no model, about a second; --sarif <file>; exit 1 when the gate fails
 *   sfn-ci pre-push      quick check for a git hook: fails only on a CONFIRMED blocker, fails OPEN on any internal problem
 *   sfn-ci review        headless review with the configured engine (SFN_ENGINE), verify, SARIF, HTML, gate
 *   sfn-ci gate          evaluate the gate on a stored result
 *   sfn-ci release-check readiness for a range
 *   sfn-ci dep-audit     dependency changes (+ OSV with --network)
 *   sfn-ci metrics       team metrics from stored runs
 *   sfn-ci install-hook  install the pre-push hook (never overwrites a hook that is not ours)
 *
 * Exit codes: 0 pass, 1 gate failed, 2 error (the review could not run: a CI gate must not read that as green).
 */
const MARK = "# sfn-ci pre-push hook";
const HOOK = `#!/bin/sh\n${MARK} (installed by sfn-ci install-hook; remove with sfn-ci uninstall-hook)\n# Fails open: if sfn-ci is not installed the push is never blocked.\ncommand -v sfn-ci >/dev/null 2>&1 || exit 0\n[ -n "$SFN_SKIP_PREPUSH" ] && exit 0\nsfn-ci pre-push || exit $?\nexit 0\n`;
const SEV = ["blocker", "major", "minor", "nit", "none"];
function failOn(v) { const f = (v ?? "blocker"); if (!SEV.includes(f)) {
    console.error(`--fail-on must be one of ${SEV.join(", ")}`);
    process.exit(2);
} return f; }
const out = (s) => process.stdout.write(s + "\n");
async function main() {
    const [cmd, ...rest] = process.argv.slice(2);
    const { values: a } = parseArgs({
        args: rest, allowPositionals: true, strict: false,
        options: {
            root: { type: "string" }, base: { type: "string" }, "repo-key": { type: "string" }, "fail-on": { type: "string" }, sarif: { type: "string" }, json: { type: "boolean" },
            level: { type: "string" }, "out-dir": { type: "string" }, result: { type: "string" }, from: { type: "string" }, to: { type: "string" }, network: { type: "boolean" }, html: { type: "string" }, force: { type: "boolean" },
        },
    });
    const root = path.resolve(a.root ?? process.cwd());
    switch (cmd) {
        case "quick-check": {
            const r = runQuickCheck(root, { base: a.base, repoKey: a["repo-key"] });
            const fo = failOn(a["fail-on"]);
            if (a.sarif) {
                fs.mkdirSync(path.dirname(path.resolve(a.sarif)), { recursive: true });
                fs.writeFileSync(a.sarif, JSON.stringify(toSarif({ findings: r.findings, scope: { repoKey: r.repo_key } }), null, 2));
            }
            out(a.json ? JSON.stringify(r, null, 2) : renderQuickCheck(r, fo));
            return gateDecision({ findings: r.findings }, { failOn: fo, blockOnPossible: false }).exitCode;
        }
        case "pre-push": {
            if (process.env.SFN_SKIP_PREPUSH)
                return 0;
            try {
                const r = runQuickCheck(root, { base: a.base });
                const g = gateDecision({ findings: r.findings }, { failOn: "blocker", blockOnPossible: false });
                if (!r.findings.length)
                    return 0;
                out(renderQuickCheck(r, "blocker"));
                if (g.exitCode)
                    out("\nPush blocked: a confirmed blocker. Fix it, or bypass once with SFN_SKIP_PREPUSH=1 git push.");
                return g.exitCode ? 1 : 0;
            }
            catch (e) {
                console.error(`sfn-ci pre-push skipped: ${e?.message ?? e}`);
                return 0;
            }
        }
        case "review": {
            const p = createEngine({ role: "primary" });
            if (!p.engine) {
                console.error(`No engine: ${p.reason}. Set SFN_ENGINE=anthropic|openai and its API key. (Prompts are sent to that provider.)`);
                return 2;
            }
            const v = createEngine({ role: "verify" });
            const outDir = path.resolve(root, a["out-dir"] ?? path.join(".secufusion", "ci"));
            fs.mkdirSync(outDir, { recursive: true });
            const r = await headlessReview(root, { base: a.base, repoKey: a["repo-key"], level: a.level, engine: p.engine, verifyEngine: v.engine ?? undefined });
            const { qc, ...result } = r;
            fs.writeFileSync(path.join(outDir, "review.json"), JSON.stringify(result, null, 2));
            fs.writeFileSync(path.join(outDir, "review.sarif"), JSON.stringify(toSarif(result), null, 2));
            fs.writeFileSync(path.join(outDir, "review.html"), renderHtmlReport(result));
            recordRun(root, result);
            const g = r.error ? { exitCode: 2, message: `The review could not run: ${r.error}` } : gateDecision(result, { failOn: failOn(a["fail-on"]), blockOnPossible: false });
            const c = (s) => result.findings.filter((f) => f.severity === s).length;
            out(`Review (${p.engine.provider}/${p.engine.model}${v.engine ? `, verified by ${v.engine.provider}/${v.engine.model}` : ""}): ${result.verdict} — ${c("blocker")} blocker, ${c("major")} major, ${c("minor")} minor, ${c("nit")} nit. ${g.message}\nWrote ${path.join(outDir, "review.html")}, review.sarif, review.json`);
            return g.exitCode;
        }
        case "gate": {
            if (!a.result) {
                console.error("--result <review.json> is required");
                return 2;
            }
            const g = gateDecision(JSON.parse(fs.readFileSync(a.result, "utf8")), { failOn: failOn(a["fail-on"]), blockOnPossible: false });
            out(`${g.status.toUpperCase()}: ${g.message}`);
            for (const f of g.blocking)
                out(`  ${f.severity} ${f.ruleId} ${f.file}:${f.line} ${f.title}`);
            return g.exitCode;
        }
        case "release-check": {
            const r = checkRelease(root, { from: a.from, to: a.to });
            out(a.json ? JSON.stringify(r, null, 2) : renderRelease(r));
            return "error" in r ? 2 : 0;
        }
        case "dep-audit": {
            const b = a.base ?? defaultBase(root);
            if (!b) {
                console.error("no base branch; pass --base");
                return 2;
            }
            const r = await auditDependencies(root, { base: b, allowNetwork: !!a.network });
            out(a.json ? JSON.stringify(r, null, 2) : renderDepAudit(r));
            return r.osv === "failed" ? 2 : r.vulnerable.length ? 1 : 0;
        }
        case "metrics": {
            const runs = loadRuns(root);
            if (!runs.length) {
                out("No stored review runs yet.");
                return 0;
            }
            const m = aggregate(runs);
            out(renderMetrics(m));
            if (a.html) {
                fs.mkdirSync(path.dirname(path.resolve(a.html)), { recursive: true });
                fs.writeFileSync(a.html, renderMetricsHtml(m));
                out(`Wrote ${a.html}`);
            }
            return 0;
        }
        case "reviewers": {
            const b = a.base ?? defaultBase(root);
            if (!b)
                return 2;
            out(suggestReviewers(root, b).map((x) => `${x.name}: ${x.why}`).join("\n") || "none");
            return 0;
        }
        case "install-hook":
        case "uninstall-hook": {
            const gitDir = execFileSync("git", ["-C", root, "rev-parse", "--git-path", "hooks"], { encoding: "utf8" }).trim();
            const dir = path.resolve(root, gitDir);
            const file = path.join(dir, "pre-push");
            const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
            if (cmd === "uninstall-hook") {
                if (existing.includes(MARK)) {
                    fs.rmSync(file);
                    out("Removed the sfn-ci pre-push hook.");
                }
                else
                    out("No sfn-ci hook installed.");
                return 0;
            }
            if (existing && !existing.includes(MARK) && !a.force) {
                console.error(`${file} already exists and is not ours. Not touching it (use --force to replace).`);
                return 2;
            }
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(file, HOOK, { mode: 0o755 });
            out(`Installed ${file}. It runs the quick check on push and blocks only a confirmed blocker. Bypass once: SFN_SKIP_PREPUSH=1 git push.`);
            return 0;
        }
        default:
            out("usage: sfn-ci <quick-check|pre-push|review|gate|release-check|dep-audit|metrics|reviewers|install-hook|uninstall-hook> [--root dir] [--base ref] [--fail-on blocker|major|minor|nit|none] [--json]");
            return cmd ? 2 : 0;
    }
}
main().then((code) => { process.exitCode = code ?? 0; }, (e) => { console.error(`sfn-ci error: ${e?.message ?? e}`); process.exitCode = 2; });
