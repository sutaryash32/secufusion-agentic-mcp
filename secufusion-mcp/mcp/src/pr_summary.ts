/**
 * The PR summary as an ENGINEERING CHANGE SUMMARY, not a file-change summary.
 *
 * A reviewer who has never seen the work item should understand: the problem, how it was investigated, the root cause,
 * the options weighed and why one was chosen, how the final design works, what was resolved, how behavior differs before
 * and after, what was tested, and what risk remains. Everything is assembled from recorded state (requirement, plan,
 * decisions, scenarios, test results, gate ledger). What the record does not hold is stated as "Not recorded", never
 * invented. Things only the author knows (the options weighed, behavior before/after, business impact) are supplied as a
 * narrative, stored beside the task, and shown under "Author notes".
 */
import fs from "fs";
import path from "path";
import { Requirement, loadRequirement } from "./requirement_manager.js";
import { ImplementationPlan, loadPlan } from "./implementation_plan.js";
import { Ledger, readLedger } from "./gates.js";
import { TestResult, loadTestResults } from "./test_engine.js";
import { displayRef } from "./work_item_ref.js";

export interface PrNarrative {
    problem?: string;
    investigation?: string[];
    root_cause?: string;
    options?: Array<{ option: string; verdict: "selected" | "rejected" | "deferred"; why: string }>;
    why_selected?: string;
    how_it_works?: string;
    issues_resolved?: string[];
    behavior_before?: string;
    behavior_after?: string;
    tests_run?: Array<{ what: string; result: string }>;
    risks?: string[];
    release_considerations?: string[];
    business_impact?: string;
}

export const NARRATIVE_FILE = "pr-narrative.json";
const NOT = "_Not recorded._";

const readJson = (p: string): any => { try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; } };
const bullets = (items?: string[]): string => (items && items.length ? items.map((i) => `- ${i}`).join("\n") : "");
const cell = (s: string) => String(s ?? "").replace(/\|/g, "/").replace(/\n+/g, " ").trim();

/** A section: what the record holds, then what the author added, then a plain statement if neither exists. */
function section(n: number, title: string, recorded: string[], author: string[]): string {
    const rec = recorded.filter(Boolean).join("\n\n");
    const aut = author.filter(Boolean).join("\n\n");
    const body = [rec, aut ? `**Author notes**\n${aut}` : ""].filter(Boolean).join("\n\n");
    return `## ${n}. ${title}\n${body || NOT}\n`;
}

export function loadNarrative(dir: string): PrNarrative {
    return readJson(path.join(dir, NARRATIVE_FILE)) ?? {};
}

export function mergeNarrative(old: PrNarrative, add: PrNarrative): PrNarrative {
    const out: any = { ...old };
    for (const [k, v] of Object.entries(add)) if (v !== undefined && !(Array.isArray(v) && v.length === 0)) out[k] = v;
    return out;
}

export function findPlanFor(ecosystemRoot: string, requirementId: string): ImplementationPlan | null {
    const dir = path.join(ecosystemRoot, ".secufusion", "plans");
    if (!fs.existsSync(dir)) return null;
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".json"))) {
        const p = loadPlan(ecosystemRoot, f.replace(/\.json$/, ""));
        if (p && p.requirement_id === requirementId) return p;
    }
    return null;
}

export interface PrSummaryInput {
    id: string;
    spec: any;
    progress: any;
    decisions: any[];
    files: any[];
    scenarios: any[];
    requirement: Requirement | null;
    plan: ImplementationPlan | null;
    ledger: Ledger | null;
    tests: TestResult[];
    narrative: PrNarrative;
    completedAt?: string;
}

export function renderPrSummary(i: PrSummaryInput): string {
    const { spec, progress, decisions, files, scenarios, requirement: req, plan, ledger, narrative: nar } = i;
    const ref = displayRef(i.id);
    const completed: string[] = progress?.completed_acs || [];
    const pending: string[] = progress?.pending_acs || [];
    const status = spec?.status === "complete" ? "Complete" : (spec?.status ?? "In progress");

    const review = ledger?.phases?.review;
    const gates = ledger
        ? ["philosophy", "intent", "classification", "requirement", "plan", "review"].map((p) => `${p} ${ledger.phases[p as keyof Ledger["phases"]]?.status === "PASSED" ? "✅" : "·"}`).join("  ")
        : "gate ledger not recorded";

    // ── 1 Problem
    const s1 = section(1, "What problem existed",
        [req?.raw_request ?? spec?.description ?? ""],
        [nar.problem ?? ""]);

    // ── 2 Investigation
    const answered = (req?.clarification_questions || []).filter((c) => c.answer || c.decision);
    const s2 = section(2, "How it was investigated",
        [
            req?.facts?.length ? `**Findings recorded during investigation**\n${bullets(req.facts)}` : "",
            answered.length ? `**Questions raised and how they were settled**\n${answered.map((c: any) => `- ${c.question || c.issue}: ${c.answer ?? c.decision}`).join("\n")}` : "",
            req?.inferences?.length ? `**Inferences** (reasoned, not verified)\n${bullets(req.inferences)}` : "",
        ],
        [bullets(nar.investigation)]);

    // ── 3 Root cause
    const s3 = section(3, "Root cause", [req?.root_cause ?? ""], [nar.root_cause ?? ""]);

    // ── 4 Options
    const userDecs = (req?.user_decisions || []).filter((d: any) => d.state === "ANSWERED");
    const optionTable = nar.options?.length
        ? `| Option | Verdict | Why |\n|---|---|---|\n${nar.options.map((o) => `| ${cell(o.option)} | ${o.verdict} | ${cell(o.why)} |`).join("\n")}`
        : "";
    const s4 = section(4, "Architectural options evaluated",
        [userDecs.length
            ? `**Decisions put to the user, with the options they chose between**\n${userDecs.map((d: any) => `- ${d.question}\n  - options: ${(d.options || []).join("; ") || "n/a"}\n  - chosen: **${d.answer}**`).join("\n")}`
            : ""],
        [optionTable]);

    // ── 5 Why selected
    const s5 = section(5, "Why this design was selected",
        [decisions.length ? decisions.map((d: any) => `- **${d.decision}**${d.rationale ? `: ${d.rationale}` : ""}`).join("\n") : ""],
        [nar.why_selected ?? ""]);

    // ── 6 How it works
    const steps = (plan?.implementation_steps || []).map((s, k) => `${k + 1}. ${s}`).join("\n");
    const impact = plan ? [
        ["Services", plan.affected_services], ["API", plan.api_changes], ["Database", plan.database_changes],
        ["Events", plan.event_changes], ["Frontend", plan.frontend_changes],
    ].filter(([, v]) => (v as string[])?.length).map(([k, v]) => `- **${k}:** ${(v as string[]).join("; ")}`).join("\n") : "";
    const s6 = section(6, "How the final design works",
        [plan?.summary ?? "", steps ? `**Steps**\n${steps}` : "", impact ? `**What it touches**\n${impact}` : ""],
        [nar.how_it_works ?? ""]);

    // ── 7 Resolved
    const s7 = section(7, "Issues resolved (acceptance criteria)",
        [[...completed.map((a) => `- ✅ ${a}`), ...pending.map((a) => `- ⚠️ not completed: ${a}`)].join("\n")],
        [bullets(nar.issues_resolved)]);

    // ── 8 Before / after
    const ba = nar.behavior_before || nar.behavior_after
        ? `| | Behavior |\n|---|---|\n| **Before** | ${cell(nar.behavior_before ?? "not recorded")} |\n| **After** | ${cell(nar.behavior_after ?? "not recorded")} |`
        : "";
    const s8 = section(8, "Behavior before and after (including multi-instance behavior where relevant)", [], [ba]);

    // ── 9 Tests
    const since = spec?.created_at ?? "";
    const recent = i.tests.filter((t) => !since || (t.timestamp ?? "") >= since);
    const count = (st: string) => recent.filter((t) => t.status === st).length;
    const failures = recent.filter((t) => t.status === "FAIL" || t.status === "ERROR" || t.status === "TIMEOUT");
    const testRec: string[] = [];
    if (recent.length) {
        testRec.push(`**Recorded test runs since this task began:** ${recent.length} total, ${count("PASS")} passed, ${failures.length} failed or errored, ${count("SKIPPED")} skipped.`);
        if (failures.length) testRec.push(`**Failing**\n${bullets(failures.slice(0, 15).map((t) => `${t.test_name} (${t.status}${t.failure_message ? `: ${t.failure_message.split("\n")[0].slice(0, 140)}` : ""})`))}`);
    }
    if (scenarios.length) testRec.push(`**Scenarios defined (${scenarios.length})**\n${scenarios.map((s: any) => `- [${s.type}] ${s.scenario}`).join("\n")}`);
    if (plan?.test_obligations?.length) testRec.push(`**Test obligations in the plan**\n${bullets(plan.test_obligations)}`);
    const ranTable = nar.tests_run?.length ? `| Executed | Result |\n|---|---|\n${nar.tests_run.map((t) => `| ${cell(t.what)} | ${cell(t.result)} |`).join("\n")}` : "";
    const s9 = section(9, "Tests executed and results", testRec, [ranTable]);

    // ── 10 Risks and release
    const migrations = [...(plan?.database_changes || []), ...(plan?.event_changes || [])];
    const s10 = section(10, "Remaining risks and release considerations",
        [
            review ? `**Review verdict:** ${review.status}${review.summary ? `: ${review.summary}` : ""}` : "**Review verdict:** not recorded.",
            plan?.risks?.length ? `**Risks identified in the plan**\n${bullets(plan.risks)}` : "",
            plan?.blockers?.length ? `**Blockers**\n${bullets(plan.blockers)}` : "",
            [...(req?.unknowns || []), ...(plan?.unknowns || [])].length ? `**Open unknowns**\n${bullets([...(req?.unknowns || []), ...(plan?.unknowns || [])])}` : "",
            [...(req?.assumptions || []), ...(plan?.assumptions || [])].length ? `**Assumptions carried**\n${bullets([...(req?.assumptions || []), ...(plan?.assumptions || [])])}` : "",
            migrations.length ? `**Needs attention at release** (database and event changes)\n${bullets(migrations)}` : "",
        ],
        [nar.risks?.length ? `**Remaining risks**\n${bullets(nar.risks)}` : "", nar.release_considerations?.length ? `**Release considerations**\n${bullets(nar.release_considerations)}` : ""]);

    // ── 11 Business impact
    const s11 = section(11, "Business impact",
        [req?.scope ? `**Scope:** ${req.scope}` : ""],
        [nar.business_impact ?? ""]);

    // ── 12 Files (reference only, last)
    const s12 = `## 12. Files changed (reference)\n${files.length ? files.map((f: any) => `- \`${f.file_path}\`${f.change_summary ? `: ${f.change_summary}` : ""}`).join("\n") : NOT}\n_${files.length} file(s) logged. This list is a reference; the sections above are the summary._\n`;

    return [
        `# ${ref}: ${spec?.title ?? ""}: engineering change summary`,
        `**Status:** ${status}${i.completedAt ? `  ·  **Completed:** ${i.completedAt}` : ""}  \n**Gates:** ${gates}`,
        `> Written for a reviewer who has not seen ${ref}. Recorded state is shown as is; **Author notes** were supplied by the author; "Not recorded" means the record holds nothing, not that nothing happened.\n`,
        s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, s11, s12,
    ].join("\n");
}

/** Load everything recorded for a work item and render. */
export function buildPrSummary(opts: { workspaceRoot: string; ecosystemRoot: string; id: string; taskDir: string; narrative?: PrNarrative; completedAt?: string }): string {
    const d = (n: string) => path.join(opts.taskDir, n);
    const requirement = loadRequirement(opts.ecosystemRoot, opts.id);
    let ledger: Ledger | null = null;
    try { ledger = readLedger(opts.workspaceRoot, opts.id); } catch { /* no ledger */ }
    let tests: TestResult[] = [];
    try { tests = loadTestResults(opts.ecosystemRoot); } catch { /* none */ }
    return renderPrSummary({
        id: opts.id,
        spec: readJson(d("spec.json")) ?? {},
        progress: readJson(d("progress.json")) ?? {},
        decisions: readJson(d("decisions.json")) ?? [],
        files: readJson(d("files-touched.json")) ?? [],
        scenarios: readJson(d("scenarios.json")) ?? [],
        requirement,
        plan: findPlanFor(opts.ecosystemRoot, opts.id),
        ledger,
        tests,
        narrative: opts.narrative ?? loadNarrative(opts.taskDir),
        completedAt: opts.completedAt,
    });
}
