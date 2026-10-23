// @ts-nocheck
import fs from "fs";
import path from "path";
import { z } from "zod";
import { validateEvidence, renderEvidence } from "./finding_evidence.js";
import { analyzeTenantFlow, renderTenantFlow } from "./tenant_flow.js";
import { checkModel, renderCheck } from "./lifecycle_model.js";
import { generateInvariantChecks, renderInvariantChecks } from "./invariant_checks.js";
import { parseMutationReport, reviewMutants, renderMutationReview, changedRanges } from "./mutation_review.js";
import { scoreRuns, renderEval } from "./review_eval.js";
import { routeReview, renderRoute } from "./review_router.js";
import { getFixHistory, renderFixHistory } from "./fix_history.js";
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
export function registerSharperTools(server) {
    server.tool("validate_finding_evidence", "Evidence gate for review findings, any language. For each finding checks that the file exists inside the workspace, the line exists, and the quoted code is really there (whitespace-insensitive; a quote found at another line is reported with the corrected line). " +
        "Findings whose citation is not supported are DROP: remove or re-investigate them before the report. A finding can also carry a proof by test (test_file, test_name, head_result FAIL|PASS|NOT_RUN): FAIL on the change = PROVEN, PASS = REFUTED (downgrade). " +
        "READ-ONLY. Run it on every BLOCKER and WARNING before PASS 22 filters the findings.", {
        workspace_root: z.string().describe("The repository or workspace root the citations are relative to"),
        findings: z.array(z.object({
            id: z.string().optional(),
            file: z.string(),
            line: z.number().int().optional(),
            quote: z.string().optional().describe("The code the finding is about, copied from the file"),
            severity: z.string().optional(),
            proof: z.object({
                test_file: z.string().optional(), test_name: z.string().optional(),
                head_result: z.enum(["FAIL", "PASS", "NOT_RUN"]).optional(), base_result: z.enum(["FAIL", "PASS", "NOT_RUN"]).optional(),
            }).optional(),
        })).min(1).max(200),
        window: z.number().int().min(0).max(25).optional().describe("Lines around the cited line to search (default 3)"),
        format: z.enum(["blocks", "json"]).optional(),
    }, async ({ workspace_root, findings, window, format }) => {
        try {
            const r = validateEvidence(workspace_root, findings, { window });
            return format === "json" ? json(r) : ok(renderEvidence(r));
        }
        catch (e) {
            return fail(e);
        }
    });
    server.tool("check_tenant_flow", "Tenant-flow analysis for multi-tenant code in Java, Kotlin, JavaScript, TypeScript, Python, C#, Go, Ruby, PHP and SQL. Finds (1) data access (queries, ORM calls, raw SQL) with no tenant predicate, (2) lookups by id alone (the IDOR shape), and (3) tenant ids taken from a request body, header or query with no access guard in the function. " +
        "It learns which entities are tenant-owned from their definitions, lowers confidence when a global scoping mechanism exists (Hibernate filters, EF query filters, Prisma extensions, row-level security, Django managers), and rates each lead HIGH / MEDIUM / LOW. " +
        "Pattern-based and READ-ONLY: a lead is not a verdict, read the function and cite file:line. Use it for PASS 1 and PASS 15.", {
        workspace_root: z.string().describe("A directory to scan (a service, or the folder that holds several)"),
        files: z.array(z.string()).max(500).optional().describe("Limit to these workspace-relative files (e.g. the changed files)"),
        include_tests: z.boolean().optional(),
        exempt_entities: z.array(z.string()).max(50).optional().describe("Entities that are not tenant-owned by design (default: Tenant)"),
        allow_path_tenant: z.boolean().optional().describe("Treat a tenant id in the URL path as guarded by an interceptor (default false: report it)"),
        min_confidence: z.enum(["LOW", "MEDIUM", "HIGH"]).optional().describe("Default MEDIUM"),
        max_findings: z.number().int().min(1).max(2000).optional(),
        format: z.enum(["blocks", "json"]).optional(),
    }, async ({ workspace_root, format, ...opts }) => {
        try {
            const r = analyzeTenantFlow(workspace_root, opts);
            return format === "json" ? json(r) : ok(renderTenantFlow(r));
        }
        catch (e) {
            return fail(e);
        }
    });
    server.tool("check_lifecycle_model", "Bounded lifecycle model checker for pessimistic review, for a service in ANY language. You model an entity from the code (variables, operations with a guard and effects, invariants such as 'exactly one active owner'); this explores every operation order, and for concurrent actors every interleaving of check-then-act steps, and returns the SHORTEST sequence that violates an invariant. " +
        "A non-atomic operation checks its guard in one step and applies its effects in a later step, so a race is found, not argued; a `lock` makes the two steps exclusive. Expressions: variables, true/false, numbers, strings, ! && || == != < <= > >= + - * ( ) and count(a,b,...). " +
        "The result is only as true as the model: cite file:line for every guard and effect before reporting a finding. Pure computation: reads and writes nothing.", {
        model: z.object({
            name: z.string().optional(),
            variables: z.record(z.string(), z.union([
                z.object({ type: z.literal("bool"), init: z.boolean() }),
                z.object({ type: z.literal("int"), init: z.number(), min: z.number().optional(), max: z.number().optional() }),
                z.object({ type: z.literal("enum"), init: z.string(), values: z.array(z.string()).min(1) }),
            ])),
            operations: z.array(z.object({
                name: z.string(), requires: z.string().optional(), effects: z.array(z.string()),
                atomic: z.boolean().optional(), lock: z.string().optional(),
            })).min(1).max(40),
            invariants: z.array(z.object({ name: z.string(), expr: z.string() })).min(1).max(20),
            mode: z.enum(["sequential", "concurrent"]).optional(),
            max_depth: z.number().int().min(1).max(12).optional(),
            actors: z.number().int().min(2).max(3).optional(),
            ops_per_actor: z.number().int().min(1).max(3).optional(),
            max_states: z.number().int().min(1000).max(2000000).optional(),
        }),
        format: z.enum(["blocks", "json"]).optional(),
    }, async ({ model, format }) => {
        try {
            const r = checkModel(model);
            return format === "json" ? json(r) : ok(renderCheck(model.name, r));
        }
        catch (e) {
            return fail(e);
        }
    });
    server.tool("generate_invariant_checks", "Turns invariants such as 'exactly one IT Admin per tenant' into enforcement that lasts: a read-only violation query (SELECT only), the database DDL that enforces it (partial or filtered unique index, unique, NOT NULL, FK) as a manual-migration draft, and a test skeleton in the service's language (Java, Kotlin, TypeScript, Python, C#, Go, Ruby, PHP) that asserts the violation query is empty and a cross-tenant request is refused. " +
        "Dialects: postgres, mysql, sqlserver. Identifiers and predicates are validated. NOTHING is executed and no file is written: review the output, then run the SELECT against a read-only snapshot.", {
        invariants: z.array(z.object({
            id: z.string(), description: z.string().optional(),
            kind: z.enum(["exactly_one", "at_most_one", "at_least_one", "unique", "not_null", "references"]),
            table: z.string(), columns: z.array(z.string()).optional(), scope_column: z.string().optional(),
            scope_table: z.string().optional(), scope_table_key: z.string().optional(), where: z.string().optional(),
            ref_table: z.string().optional(), ref_column: z.string().optional(),
        })).min(1).max(20),
        dialect: z.enum(["postgres", "mysql", "sqlserver"]).optional(),
        language: z.enum(["java", "kotlin", "typescript", "python", "csharp", "go", "ruby", "php"]).optional(),
        format: z.enum(["blocks", "json"]).optional(),
    }, async ({ invariants, dialect, language, format }) => {
        try {
            const r = generateInvariantChecks(invariants, { dialect, language });
            return format === "json" ? json(r) : ok(renderInvariantChecks(r, dialect ?? "postgres", language ?? "java"));
        }
        catch (e) {
            return fail(e);
        }
    });
    server.tool("analyze_mutation_report", "Reads a mutation-testing report and shows which CHANGED lines would not be noticed if their logic were wrong: surviving and uncovered mutants, with guard-like mutators (conditions, comparisons, removed calls) first. Formats: PIT XML (Java, Kotlin), Stryker JSON (JavaScript, TypeScript, C#), Infection JSON (PHP) and a generic JSON ([{file, line, mutator, status}]) for Python (mutmut), Go, Rust, Ruby. " +
        "Changed lines come from `git diff` against `base`, or from `changed` ranges you pass. It does not run the mutation tool; the output lists the command per language. READ-ONLY.", {
        workspace_root: z.string().describe("The git repository root"),
        report_path: z.string().optional().describe("Workspace-relative path of the mutation report"),
        report_content: z.string().optional().describe("The report text, instead of report_path"),
        base: z.string().optional().describe("Git ref the change is compared with (default HEAD: uncommitted changes)"),
        changed: z.record(z.string(), z.array(z.tuple([z.number().int(), z.number().int()]))).optional().describe("Changed line ranges per file, instead of git"),
        format: z.enum(["blocks", "json"]).optional(),
    }, async ({ workspace_root, report_path, report_content, base, changed, format }) => {
        try {
            const content = report_content ?? (report_path ? fs.readFileSync(inside(workspace_root, report_path), "utf8") : null);
            if (content === null)
                return fail(new Error("pass report_path or report_content"));
            const ranges = changed ?? changedRanges(workspace_root, base ?? "HEAD");
            const r = reviewMutants(parseMutationReport(content), ranges);
            return format === "json" ? json(r) : ok(renderMutationReview(r));
        }
        catch (e) {
            return fail(e);
        }
    });
    server.tool("score_review_run", "Eval scorer for the reviewer itself, language-neutral and offline. Give it eval cases (findings a correct review must produce, and findings that would be wrong) and the findings real reviews produced (optionally tagged with the pass that produced each), and it returns recall, precision and a per-pass table with advice (KEEP, REVIEW_COST, DEMOTE). " +
        "Use it to find which passes earn their cost and which only add noise, and to catch a regression when the review's instructions change. Pass cases and runs inline, or eval_dir containing <case>/case.json and <case>/findings.json. READ-ONLY.", {
        cases: z.array(z.object({
            name: z.string(),
            expected: z.array(z.object({ id: z.string().optional(), file: z.string().optional(), line: z.number().int().optional(), near: z.number().int().optional(), category: z.string().optional(), rule: z.string().optional(), min_severity: z.string().optional() })),
            must_not: z.array(z.object({ id: z.string().optional(), file: z.string().optional(), line: z.number().int().optional(), near: z.number().int().optional(), category: z.string().optional(), rule: z.string().optional(), min_severity: z.string().optional() })).optional(),
            verdict_in: z.array(z.string()).optional(),
        })).optional(),
        runs: z.array(z.object({
            case: z.string(),
            verdict: z.string().optional(),
            findings: z.array(z.object({ severity: z.string(), file: z.string().optional(), line: z.number().int().optional(), category: z.string().optional(), rule: z.string().optional(), pass: z.union([z.string(), z.number()]).optional(), title: z.string().optional() })),
        })).optional(),
        workspace_root: z.string().optional().describe("Needed with eval_dir"),
        eval_dir: z.string().optional().describe("Workspace-relative folder of <case>/case.json + <case>/findings.json"),
        format: z.enum(["blocks", "json"]).optional(),
    }, async ({ cases, runs, workspace_root, eval_dir, format }) => {
        try {
            let cs = cases ?? [], rs = runs ?? [];
            if (eval_dir) {
                if (!workspace_root)
                    return fail(new Error("eval_dir needs workspace_root"));
                const dir = inside(workspace_root, eval_dir);
                for (const name of fs.readdirSync(dir)) {
                    const cf = path.join(dir, name, "case.json"), ff = path.join(dir, name, "findings.json");
                    if (!fs.existsSync(cf))
                        continue;
                    const c = JSON.parse(fs.readFileSync(cf, "utf8"));
                    cs.push({ name, expected: c.expected ?? c.expect?.mustFind ?? [], must_not: c.must_not ?? c.expect?.mustNotFind, verdict_in: c.verdict_in ?? c.expect?.verdictIn });
                    if (fs.existsSync(ff)) {
                        const f = JSON.parse(fs.readFileSync(ff, "utf8"));
                        rs.push({ case: name, findings: f.findings ?? f, verdict: f.verdict });
                    }
                }
            }
            if (!cs.length || !rs.length)
                return fail(new Error("need at least one case and one run"));
            const r = scoreRuns(cs, rs);
            return format === "json" ? json(r) : ok(renderEval(r));
        }
        catch (e) {
            return fail(e);
        }
    });
    server.tool("route_review_passes", "Decides which of /sfn-review's passes THIS change needs, in any language. Scores the change from the paths it touches and signals in its code (migrations, entities, data access, HTTP surface, security, messaging, schedulers, config, dependencies, UI, invariant flags such as defaultUser) and returns a level (quick, standard, deep), the passes to run with the reason for each, the passes to skip with the reason, and the passes grouped for parallel specialists. " +
        "Changed files come from git (against `base`, plus working-tree and untracked files) or from `files`. Pass has_spec=true when a specification exists so the spec passes are selected. READ-ONLY.", {
        workspace_root: z.string().describe("The git repository root"),
        files: z.array(z.string()).max(2000).optional().describe("Changed files, instead of asking git"),
        base: z.string().optional().describe("Git ref the change is compared with (default: merge-base with origin/main)"),
        level: z.enum(["quick", "standard", "deep"]).optional().describe("Override the automatic level"),
        has_spec: z.boolean().optional(),
        lines_changed: z.number().int().min(0).optional(),
        format: z.enum(["blocks", "json"]).optional(),
    }, async ({ workspace_root, format, ...opts }) => {
        try {
            const r = routeReview(workspace_root, opts);
            return format === "json" ? json(r) : ok(renderRoute(r));
        }
        catch (e) {
            return fail(e);
        }
    });
    server.tool("get_fix_history", "Fix history of a file (and optionally a line range), in any language, for PASS 27: asks git for the commits that touched it, keeps the ones that look like fixes or guards (fix, guard, resolve, block, prevent, revert, hotfix, regression, work-item ids), and searches .rejected-patterns.json and the task decisions for entries about the same file or keywords. " +
        "A matching subject is a hint, not proof: read the commit and check the change still does what the fix made it do. Git runs read-only and without a shell.", {
        workspace_root: z.string().describe("The git repository root"),
        file: z.string().describe("Workspace-relative file path"),
        line_range: z.tuple([z.number().int(), z.number().int()]).optional().describe("[start, end]: history of just these lines (git log -L)"),
        since: z.string().optional().describe("Default 18.months.ago"),
        keywords: z.array(z.string()).max(10).optional().describe("Terms to look for in the team's memory, e.g. tenant, defaultUser"),
        max_commits: z.number().int().min(1).max(1000).optional(),
        format: z.enum(["blocks", "json"]).optional(),
    }, async ({ workspace_root, file, format, ...opts }) => {
        try {
            const r = getFixHistory(workspace_root, file, opts);
            return format === "json" ? json(r) : ok(renderFixHistory(r));
        }
        catch (e) {
            return fail(e);
        }
    });
}
