// @ts-nocheck
import fs from "fs";
import path from "path";
import { z } from "zod";
import { judge, judgmentParam, hashOf } from "./judge.js";
import { createEngine } from "./engine.js";
import { runQuickCheck, renderQuickCheck } from "./quick_check.js";
import { loadCatalog, renderCatalog, repoNotes, knownRepos } from "./rule_catalog.js";
import { DEFAULT_SEVERITY_FLOORS, applyDecisions, applySeverityFloors, applySuppressions, assignIds, computeDelta, decideVerdict, gateDecision, mergeRuns, sortFindings, toSarif, trimNoise } from "./review_findings.js";
import { renderHtmlReport, suggestReviewers, recordRun, latestRun, loadRuns, aggregate, renderMetrics, renderMetricsHtml } from "./review_report.js";
import { corpusDir, loadCases, runQuickCorpus, draftCaseFromFix } from "./eval_corpus.js";
import { renderEval } from "./review_eval.js";
import { takeSnapshot, saveSnapshot, loadSnapshot, renderLookup } from "./db_schema.js";
import { auditDependencies, renderDepAudit } from "./dependency_audit.js";
import { checkRelease, renderRelease } from "./release_readiness.js";
import { defaultBase } from "./quick_check.js";
const ok = (text) => ({ content: [{ type: "text", text }] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: `Error: ${e?.message ?? e}` }] });
const json = (o) => ok(JSON.stringify(o, null, 2));
const inside = (root, p) => {
    const r = fs.realpathSync(root);
    const a = path.resolve(r, p);
    if (!(a === r || a.startsWith(r + path.sep)))
        throw new Error(`${p} is outside workspace_root`);
    return a;
};
const sev = z.enum(["blocker", "major", "minor", "nit"]);
const findingIn = z.object({
    id: z.string().optional(), repo: z.string().optional(),
    ruleId: z.string().describe("Rule id from get_rule_catalog (SEC-003, DB-001, ...) or GEN for a finding no rule covers"),
    severity: sev, confidence: z.enum(["confirmed", "possible"]),
    category: z.string().optional(), specialist: z.string().optional(),
    file: z.string(), line: z.number().int(), endLine: z.number().int().optional(),
    anchor: z.string().describe("A stable name for what the finding is about (Class#method, table.column), NOT a line number: it is what keeps the id stable across re-reviews"),
    title: z.string(), problem: z.string(), failureScenario: z.string(), suggestion: z.string(),
    evidence: z.array(z.object({ repo: z.string().optional(), file: z.string(), line: z.number().int().optional(), note: z.string() })).optional(),
}).passthrough();
function excerpt(root, file, line, radius = 6) {
    try {
        const abs = inside(root, file);
        const lines = fs.readFileSync(abs, "utf8").split(/\r?\n/);
        const a = Math.max(0, line - 1 - radius), b = Math.min(lines.length, line + radius);
        return lines.slice(a, b).map((l, i) => `${a + i + 1}: ${l}`).join("\n");
    }
    catch {
        return "";
    }
}
export function registerDeliveryTools(server) {
    server.tool("run_quick_check", "Quick check: the mechanical half of the rule catalog, with NO model, in about a second. Reads what the change adds (against the base branch, plus uncommitted and untracked files) and reports leads for: an applied migration edited/renamed/deleted or a reused or low version (any framework), a mapped column with no migration, a committed credential, SQL built by concatenation, a mutating endpoint with no @PreAuthorize, a flag that defaults on, scope enforcement turned off, a hard delete in a soft-delete repo, NOT NULL with no default, a non-concurrent index, a DROP, floating or snapshot versions, an unpinned Dockerfile base, a pipeline that skips tests, a test that cannot fail, and the web-ui rules (axios outside the shared client, inlined URLs, currentUser.tenantId, token storage, raw HTML). " +
        "Exact findings are `confirmed`; pattern leads are `possible`. It is not a review: it does not read your logic. Run it first (it is what the pre-push hook and CI run), then /sfn-review. READ-ONLY.", {
        workspace_root: z.string().describe("The repository root"),
        base: z.string().optional().describe("Base ref to compare with (default: merge-base with origin/develop, origin/main or origin/master)"),
        repo_key: z.string().optional().describe("Repository name for repo-specific rules (default: the folder name, e.g. sfn-events-api)"),
        fail_on: z.enum(["blocker", "major", "minor", "nit", "none"]).optional().describe("Severity at which the gate line says FAIL (default blocker)"),
        format: z.enum(["blocks", "json"]).optional(),
    }, async ({ workspace_root, base, repo_key, fail_on, format }) => {
        try {
            const r = runQuickCheck(workspace_root, { base, repoKey: repo_key });
            if (format === "json")
                return json({ ...r, gate: gateDecision({ findings: r.findings }, { failOn: fail_on ?? "blocker", blockOnPossible: false }) });
            return ok(renderQuickCheck(r, fail_on ?? "blocker"));
        }
        catch (e) {
            return fail(e);
        }
    });
    server.tool("get_rule_catalog", "The SecuFusion rule catalog: the rules a review checks (security and tenancy, database and migrations, contracts and Kafka, runtime, tests, dependencies, web-ui, regression history), each with a severity and the question it asks. Loaded from rules/shared/*.md plus the workspace's own .secufusion/rules/*.md (same IDs override). With `repo` it also returns that repository's notes (layering, delete style, scheduler facts). " +
        "A rule is a question to answer from the code, not a verdict: cite file:line and apply the evidence rule. Rules tagged quick-check are also run by run_quick_check. READ-ONLY.", {
        workspace_root: z.string().optional().describe("Include this workspace's own rules and repo notes"),
        area: z.enum(["security", "database", "contracts", "runtime", "tests", "dependencies", "web-ui", "history"]).optional(),
        ids: z.array(z.string()).max(100).optional().describe("Only these rule ids"),
        severity: sev.optional(),
        repo: z.string().optional().describe(`Also return the notes for this repository (bundled: ${knownRepos().join(", ") || "none"})`),
    }, async ({ workspace_root, area, ids, severity, repo }) => {
        try {
            const cat = loadCatalog(workspace_root);
            const out = [renderCatalog(cat, { area, ids, severity })];
            if (repo) {
                const notes = repoNotes(repo, workspace_root);
                out.push("", notes.length ? notes.map((n) => `## Repository notes (${n.source})\n${n.text}`).join("\n\n") : `No notes for "${repo}". Bundled notes exist for: ${knownRepos().join(", ")}.`);
            }
            return ok(out.join("\n"));
        }
        catch (e) {
            return fail(e);
        }
    });
    server.tool("verify_findings", "Adversarial verification. Hands candidate findings (with the real code around each) to a model whose job is to REFUTE them: find the guard, test, caller or constraint that makes the finding wrong, or the fact that makes it worse. Each finding gets confirm, downgrade or reject; a finding with no decision stays but is marked unverified and possible. " +
        "mode=same: the reviewing model checks itself. mode=cross: a second, independent opinion supplied by you as `judgment` (for example from another model); a cross check may lower a severity, never raise one, and its reasons are kept separate so a human sees both opinions. Up to 40 findings per call. READ-ONLY: nothing is stored.", {
        workspace_root: z.string().describe("The repository root the findings' file paths are relative to"),
        findings: z.array(findingIn).min(1).max(40),
        mode: z.enum(["same", "cross"]).optional(),
        judgment: judgmentParam,
    }, async ({ workspace_root, findings, mode, judgment }) => {
        try {
            const m = mode ?? "same";
            const numbered = findings.map((f, n) => ({ n, ruleId: f.ruleId, severity: f.severity, confidence: f.confidence, title: f.title, file: f.file, line: f.line, problem: f.problem, failureScenario: f.failureScenario, suggestion: f.suggestion, evidence: f.evidence, code_around_the_cited_line: excerpt(workspace_root, f.file, f.line) }));
            const outcome = await judge(server, workspace_root, {
                kind: "verify-findings",
                subject: hashOf(numbered.map((f) => [f.ruleId, f.file, f.line])),
                role: m === "cross" ? "independent second reviewer who did not write these findings" : "adversarial verifier of a reviewer's own findings",
                rubric: [
                    "Your job is to REFUTE each finding. Look for the guard, test, caller, constraint, transaction or configuration that makes it wrong. Read the code around the cited line and follow the call path if you can.",
                    "reject: the finding is wrong, or describes something that cannot happen. Give the reason, naming the code that refutes it.",
                    "downgrade: real but less severe than rated (a narrower scenario, a guard that covers most paths). Give the new severity and why.",
                    "confirm: you tried to refute it and could not. Say what you checked.",
                    "Judge only from the finding and the code shown. If the code shown is not enough to decide, confirm with confidence \"possible\" and say what is missing: silence is not confirmation.",
                    m === "cross" ? "You may lower a severity, never raise one." : "You may raise confidence to confirmed only if you can name the exact line that proves it.",
                ],
                evidence: { findings: numbered },
                schema: z.object({ decisions: z.array(z.object({ n: z.number().int(), decision: z.enum(["confirm", "downgrade", "reject"]), severity: sev.optional(), confidence: z.enum(["confirmed", "possible"]).optional(), verification: z.string() })) }),
                schemaHint: '{"decisions":[{"n":0,"decision":"confirm|downgrade|reject","severity":"blocker|major|minor|nit (when downgrading)","confidence":"confirmed|possible","verification":"what you checked and found"}]}',
                supplied: judgment,
                reinvoke: "verify_findings",
                persist: false,
            });
            if (outcome.status !== "ok")
                return ok(outcome.text);
            const r = applyDecisions(findings, outcome.verdict.decisions, m);
            return json({ mode: m, answered_by: outcome.source, ...r, note: m === "cross" && outcome.source === "sampling" ? "Cross mode was answered by the model you are logged into, the same one that reviewed: that is a second look, not an independent one. For an independent check, supply `judgment` from another model." : undefined });
        }
        catch (e) {
            return fail(e);
        }
    });
    server.tool("merge_review_runs", "Consensus across several independent runs of the same review (models vary from run to run). A finding is kept when at least min_agree runs reported it (same repo, file, rule, and the same anchor or within 15 lines), or when any run reported a CONFIRMED major-or-worse for a critical rule; the rest are listed as seen-once and hidden. Returns the merged findings, a verdict and the seen-once list. Pure and READ-ONLY.", {
        runs: z.array(z.object({ findings: z.array(findingIn), summary: z.string().optional(), specialistsRun: z.array(z.string()).optional() }).passthrough()).min(1).max(8),
        min_agree: z.number().int().min(1).max(8).optional(),
        missing_repos: z.array(z.string()).optional(),
        critical_rules: z.array(z.string()).optional().describe(`Rules a single confirmed major-or-worse catch is kept for (default: the severity-floor rules: ${Object.keys(DEFAULT_SEVERITY_FLOORS).join(", ")})`),
    }, async ({ runs, min_agree, missing_repos, critical_rules }) => {
        try {
            return json(mergeRuns(runs, { minAgree: min_agree, missingRepos: missing_repos, criticalRules: critical_rules ?? Object.keys(DEFAULT_SEVERITY_FLOORS) }));
        }
        catch (e) {
            return fail(e);
        }
    });
    server.tool("finalize_review_findings", "Makes the findings of a review deterministic: assigns stable ids (repo + file + anchor + rule, never line numbers), lifts CONFIRMED findings of critical rules to their severity floor, applies suppressions (a suppression past its date stops applying and is reported), sorts, applies the noise cap (every blocker and major stays), decides the verdict, computes what was FIXED / NEW / STILL OPEN since the previous review of the same repo, and evaluates the CI gate. " +
        "The same findings always give the same result. Pass previous=\"auto\" to compare with the last stored run. Set record=true to store the result so the next review and the metrics can use it. READ-ONLY unless record=true.", {
        workspace_root: z.string().describe("The repository root (for suppressions and stored runs)"),
        findings: z.array(findingIn).max(300),
        repo_key: z.string().optional(),
        level: z.enum(["quick", "standard", "deep"]).optional(),
        summary: z.string().optional(), mode: z.string().optional().describe("Review mode label for the report and metrics"),
        floors: z.record(sev).optional().describe("Override the default severity floors"),
        suppressions: z.array(z.object({ id: z.string().optional(), ruleId: z.string().optional(), repo: z.string().optional(), anchor: z.string().optional(), path: z.string().optional(), reason: z.string(), owner: z.string().optional(), expires: z.string().describe("YYYY-MM-DD; required: a suppression without an end date is a permanent blind spot") })).optional().describe("Default: .secufusion/suppressions.json"),
        previous: z.union([z.literal("auto"), z.object({ findings: z.array(z.any()) }).passthrough()]).optional(),
        gate: z.object({ fail_on: z.enum(["blocker", "major", "minor", "nit", "none"]), block_on_possible: z.boolean().optional() }).optional(),
        max_minor: z.number().int().min(0).optional(), max_nit: z.number().int().min(0).optional(),
        missing_repos: z.array(z.string()).optional(), contracts_ran: z.boolean().optional(),
        record: z.boolean().optional(),
    }, async (a) => {
        try {
            const repo = a.repo_key ?? path.basename(path.resolve(a.workspace_root));
            let supp = a.suppressions;
            if (!supp) {
                try {
                    supp = JSON.parse(fs.readFileSync(path.join(a.workspace_root, ".secufusion", "suppressions.json"), "utf8")).suppressions ?? [];
                }
                catch {
                    supp = [];
                }
            }
            const noDate = (supp ?? []).filter((s) => !s.expires);
            const withIds = applySeverityFloors(assignIds(a.findings, repo), a.floors ?? DEFAULT_SEVERITY_FLOORS);
            const { kept, suppressed, expired } = applySuppressions(withIds, (supp ?? []).filter((s) => s.expires));
            const { kept: shown, trimmed } = trimNoise(sortFindings(kept), { maxMinor: a.max_minor, maxNit: a.max_nit }, a.level);
            const v = decideVerdict(shown, { missingRepos: a.missing_repos, contractsRan: a.contracts_ran });
            const prev = a.previous === "auto" ? latestRun(a.workspace_root, repo) : a.previous;
            const result = {
                summary: a.summary, mode: a.mode, verdict: v.verdict, verdictReason: shown.some((f) => f.ratedSeverity) ? `${v.reason} (severity floor applied)` : v.reason,
                findings: shown, trimmed, suppressed, scope: { repoKey: repo, level: a.level, missingRepos: a.missing_repos ?? [], expiredSuppressions: expired.length },
            };
            const delta = computeDelta(prev, shown, repo);
            if (delta)
                result.delta = delta;
            const gate = a.gate ? gateDecision(result, { failOn: a.gate.fail_on, blockOnPossible: a.gate.block_on_possible }) : undefined;
            if (a.record)
                result.recorded_at = recordRun(a.workspace_root, result);
            const notes = [];
            if (expired.length)
                notes.push(`${expired.length} suppression(s) expired and no longer apply: ${expired.map((s) => s.ruleId ?? s.id ?? s.path).join(", ")}`);
            if (noDate.length)
                notes.push(`${noDate.length} suppression(s) ignored because they have no expires date`);
            return json({ result, gate, notes });
        }
        catch (e) {
            return fail(e);
        }
    });
    server.tool("findings_to_sarif", "Converts a finalized review result into SARIF 2.1.0, the format GitHub code scanning, Azure DevOps and IDEs show as annotations on the changed lines. blocker and major map to error, minor to warning, nit to note; each result carries the stable finding id as a fingerprint so a re-review does not duplicate alerts. Optionally writes the file inside the workspace. Pure.", {
        workspace_root: z.string(), result: z.object({ findings: z.array(findingIn) }).passthrough(),
        out_path: z.string().optional().describe("Workspace-relative path to write, for example .secufusion/review.sarif"),
    }, async ({ workspace_root, result, out_path }) => {
        try {
            const sarif = toSarif(result);
            if (out_path) {
                const p = inside(workspace_root, out_path);
                fs.mkdirSync(path.dirname(p), { recursive: true });
                fs.writeFileSync(p, JSON.stringify(sarif, null, 2));
                return ok(`Wrote ${out_path}: ${sarif.runs[0].results.length} result(s), ${sarif.runs[0].tool.driver.rules.length} rule(s).`);
            }
            return json(sarif);
        }
        catch (e) {
            return fail(e);
        }
    });
    server.tool("render_review_report", "Writes the review as ONE self-contained HTML file (no external assets, light and dark, works at phone width, safe to attach to a ticket or keep as a CI artifact): verdict and reason, severity counts, walkthrough, suggested test plan, findings as cards (problem, fails-when, fix, evidence, verification), what changed since the last review, blast radius, suggested reviewers and the run details. Every value is escaped. Set record=true to store the result for metrics and the next delta.", {
        workspace_root: z.string(), out_path: z.string().describe("Workspace-relative HTML path, for example .secufusion/review.html"),
        result: z.object({ findings: z.array(findingIn) }).passthrough().describe("A finalized result (from finalize_review_findings), optionally with walkthrough [{area,change,files}], testPlan [string] and blastRadius {endpoints:[],tables:[],kafkaTopics:[],...}"),
        reviewers_base: z.string().optional().describe("If set, suggested reviewers are computed from git history against this base"),
        record: z.boolean().optional(),
    }, async ({ workspace_root, out_path, result, reviewers_base, record }) => {
        try {
            const r = { ...result };
            if (reviewers_base) {
                r.scope = { ...(r.scope ?? {}), suggestedReviewers: suggestReviewers(workspace_root, reviewers_base) };
            }
            const p = inside(workspace_root, out_path);
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, renderHtmlReport(r));
            const rec = record ? recordRun(workspace_root, r) : null;
            return ok(`Wrote ${out_path} (${r.findings.length} finding(s)).${rec ? ` Stored the run at ${path.relative(workspace_root, rec)}.` : ""}`);
        }
        catch (e) {
            return fail(e);
        }
    });
    server.tool("suggest_reviewers", "Who should review this change: the authors of the lines it rewrites (git blame on the base, weight 2 per line) and of recent commits to the changed files (weight 1 per commit). The change's own authors and bots are excluded. Names and reasons only, never email addresses. Deterministic and READ-ONLY.", { workspace_root: z.string(), base: z.string().optional(), max: z.number().int().min(1).max(10).optional() }, async ({ workspace_root, base, max }) => {
        try {
            const b = base ?? defaultBase(workspace_root);
            if (!b)
                return ok("No base branch found (origin/develop, origin/main, ...). Pass base.");
            const r = suggestReviewers(workspace_root, b, { max });
            return ok(r.length ? r.map((x) => `${x.name}: ${x.why} (${x.files.join(", ")})`).join("\n") : "No reviewer could be suggested from history (no earlier authors besides the change's own).");
        }
        catch (e) {
            return fail(e);
        }
    });
    server.tool("run_quick_eval", "Measures the reviewer against known answers. Builds each case of the eval corpus (a base repository, a head change, the findings a correct review must produce) as a real git repository, runs the quick check on it and scores recall, precision and per-rule hits. Cases that need reasoning (cross-repo contracts, tenant leaks, locks) are listed as needs_model: score those from a real review's findings with score_review_run, using load_eval_cases. Run it after any change to the rules or the quick check: a reviewer that misses a known bug is a regression. No model, READ-ONLY.", { corpus_dir: z.string().optional().describe("Default: the bundled corpus"), format: z.enum(["blocks", "json"]).optional() }, async ({ corpus_dir, format }) => {
        try {
            const r = runQuickCorpus(corpus_dir ?? corpusDir());
            return format === "json" ? json(r) : ok(renderEval(r.report) + (r.needs_model.length ? `\n\nNeed a model to judge (${r.needs_model.length}): ${r.needs_model.map((c) => c.name).join(", ")}. Review them for real, then score the findings with score_review_run.` : ""));
        }
        catch (e) {
            return fail(e);
        }
    });
    server.tool("load_eval_cases", "Loads the eval corpus (bundled, plus a workspace's own .secufusion/evals/cases) as case specs ready for score_review_run, with each case's description and whether the quick check can judge it. READ-ONLY.", { workspace_root: z.string().optional() }, async ({ workspace_root }) => {
        try {
            const cases = loadCases();
            if (workspace_root)
                cases.push(...loadCases(path.join(workspace_root, ".secufusion", "evals", "cases")));
            return json(cases.map((c) => ({ ...c.spec, description: c.raw.description, repo_key: c.raw.repoKey, quick_check: !!c.raw.quick_check })));
        }
        catch (e) {
            return fail(e);
        }
    });
    server.tool("draft_eval_case_from_fix", "Learn from a bug the reviewer missed: turn its fix commit into a permanent regression case skeleton. Finds the commit that introduced the bug (the last change to the lines the fix touched), records the fix and its subject, and writes .secufusion/evals/cases/history-<name>/case.json expecting a major-or-worse finding in the files the fix changed. Review the draft, tighten `expect`, and commit it. Writes only inside the workspace.", { workspace_root: z.string(), fix_sha: z.string().describe("The commit that fixed the bug"), name: z.string().optional() }, async ({ workspace_root, fix_sha, name }) => {
        try {
            const r = draftCaseFromFix(workspace_root, fix_sha, name);
            return ok(`Wrote ${path.relative(workspace_root, r.path)}/case.json\nIntroduced by: ${(r.case.source.introducedBy ?? []).map((s) => s.slice(0, 10)).join(", ") || "not found (new file)"}\nExpects a major-or-worse finding in: ${r.case.source.files.slice(0, 3).join(", ")}\nTighten expect (rule ids, lines) before committing.`);
        }
        catch (e) {
            return fail(e);
        }
    });
    server.tool("snapshot_db_schema", "Takes a READ-ONLY snapshot of the live PostgreSQL schema (tables, columns, foreign keys with their ON DELETE behaviour, indexes) into .secufusion/db-schema.json. Metadata only, never row data; runs inside a read-only transaction with a statement timeout. The connection string is read from the environment variable you NAME (url_env, for example SFN_REVIEW_DB_URL), never accepted as an argument and never stored. Needs psql on the PATH. Use lookup_db_schema afterwards for DB-004/005/006/009.", { workspace_root: z.string(), url_env: z.string().describe("The NAME of the environment variable that holds the connection string"), schemas: z.array(z.string()).max(10).optional() }, async ({ workspace_root, url_env, schemas }) => {
        try {
            const s = takeSnapshot({ urlEnv: url_env, schemas });
            const p = saveSnapshot(workspace_root, s);
            return ok(`Snapshot saved to ${path.relative(workspace_root, p)}: ${Object.keys(s.tables).length} table(s) in ${s.schemas.join(", ")}.`);
        }
        catch (e) {
            return fail(e);
        }
    });
    server.tool("lookup_db_schema", "Reads the stored live-schema snapshot for the tables a change touches: columns, foreign keys with ON DELETE behaviour, which tables reference it (what a delete runs into), indexes, and FK columns with no index. Answers what a migration alone cannot: the join tables no migration creates, RESTRICT versus CASCADE, an index that really exists. READ-ONLY.", { workspace_root: z.string(), tables: z.array(z.string()).min(1).max(40) }, async ({ workspace_root, tables }) => {
        try {
            const s = loadSnapshot(workspace_root);
            if (!s)
                return fail(new Error("no snapshot yet: run snapshot_db_schema first (needs a read-only connection string in an environment variable)"));
            return ok(renderLookup(s, tables));
        }
        catch (e) {
            return fail(e);
        }
    });
    server.tool("audit_dependencies", "Dependency audit for a change: which dependencies were added, removed or re-versioned (pom.xml and package.json, against the base), which are major upgrades or downgrades, and, if allow_network=true, which exact versions have known vulnerabilities according to OSV (osv.dev, no key). The lookup sends package names and versions to osv.dev and nothing else, so it is off unless you allow it. A version that cannot be pinned (managed, a range) is reported as NOT CHECKED, never as clean; an OSV failure is reported as a failure, never as safe.", {
        workspace_root: z.string(), base: z.string().optional(),
        allow_network: z.boolean().optional().describe("Allow sending package names and exact versions to osv.dev"),
        format: z.enum(["blocks", "json"]).optional(),
    }, async ({ workspace_root, base, allow_network, format }) => {
        try {
            const b = base ?? defaultBase(workspace_root);
            if (!b)
                return fail(new Error("no base branch found; pass base"));
            const a = await auditDependencies(workspace_root, { base: b, allowNetwork: allow_network });
            return format === "json" ? json(a) : ok(renderDepAudit(a));
        }
        catch (e) {
            return fail(e);
        }
    });
    server.tool("check_release_readiness", "Release readiness for a range (from a tag or commit to a ref): the pull requests and work items in it, the migrations to apply in order (and any edited, deleted, duplicated or numbered below the head), new configuration and environment variables (flagging those with NO default, where startup fails), new feature flags and whether they default on, dependency changes and major upgrades, and endpoints and Kafka topics added or removed. Ends with a checklist for operations. Deterministic (git only); it does not read logic, so run /sfn-review on the range too. READ-ONLY.", { workspace_root: z.string(), from: z.string().optional().describe("Tag or commit to start from (default: the latest tag reachable from `to`)"), to: z.string().optional().describe("Default: origin/develop, else HEAD"), format: z.enum(["blocks", "json"]).optional() }, async ({ workspace_root, from, to, format }) => {
        try {
            const r = checkRelease(workspace_root, { from, to });
            return format === "json" ? json(r) : ok(renderRelease(r));
        }
        catch (e) {
            return fail(e);
        }
    });
    server.tool("get_review_metrics", "Team metrics across the stored review runs (.secufusion/review-runs): reviews, findings per review, verdict mix, findings per week by severity, the most frequent rules and which repos they come from, how many candidates verification rejected, how many findings were fixed on re-review. Never attributed to a person. Optionally writes a self-contained HTML dashboard. READ-ONLY apart from that file.", { workspace_root: z.string(), html_path: z.string().optional().describe("Workspace-relative path for the HTML dashboard"), format: z.enum(["blocks", "json"]).optional() }, async ({ workspace_root, html_path, format }) => {
        try {
            const runs = loadRuns(workspace_root);
            if (!runs.length)
                return ok("No stored review runs yet. Use finalize_review_findings or render_review_report with record=true to start collecting them.");
            const m = aggregate(runs);
            if (html_path) {
                const p = inside(workspace_root, html_path);
                fs.mkdirSync(path.dirname(p), { recursive: true });
                fs.writeFileSync(p, renderMetricsHtml(m));
            }
            return format === "json" ? json(m) : ok(renderMetrics(m) + (html_path ? `\n\nWrote ${html_path}` : ""));
        }
        catch (e) {
            return fail(e);
        }
    });
    server.tool("get_engine_status", "Shows which LLM engines are configured for headless use (CI, pre-push, command line): the primary engine (SFN_ENGINE) and the verification engine (SFN_VERIFY_ENGINE), their models and whether the API key is present. Never prints a key. This is for the command line only (sfn-ci); inside an editor the review ALWAYS uses the model you are logged into and these settings are ignored. A cross-model check needs the verify engine to be the OTHER provider. READ-ONLY.", {}, async () => {
        const line = (role) => { const r = createEngine({ role }); return r.engine ? `${role}: ${r.engine.provider} / ${r.engine.model}` : `${role}: off (${r.reason})`; };
        const p = createEngine({ role: "primary" }), v = createEngine({ role: "verify" });
        return ok([line("primary"), line("verify"), p.engine && v.engine && p.engine.provider === v.engine.provider ? "note: both engines are the same provider, so the verification is not independent." : p.engine && v.engine ? "cross-model verification is available." : "", "Prompts are sent to the provider you configure; an engine is off until you set it on purpose."].filter(Boolean).join("\n"));
    });
}
