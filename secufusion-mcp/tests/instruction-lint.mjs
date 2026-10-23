import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

/**
 * The review's instructions are code too. This lints them the way a compiler lints code: contradictions, dangling
 * references and drift between a document and the implementation it describes. Each check here exists because the
 * corresponding mistake was actually made once.
 */
const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..").split(path.sep).join("/");
let failures = 0;
const check = (name, cond, detail = "") => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + detail}`);
    if (!cond) failures++;
};
const read = (rel) => fs.readFileSync(path.join(PKG, rel), "utf8").replace(/\r\n/g, "\n");

const review = read("commands/sfn-review.md");
const code = read("commands/sfn-code.md");
const agents = read("agents/AGENTS.md");
const docs = [...fs.readdirSync(path.join(PKG, "commands")).map((f) => `commands/${f}`), ...fs.readdirSync(path.join(PKG, "agents")).map((f) => `agents/${f}`)];

// ---- passes: numbered once each, in order, no dangling references, and the router knows exactly the same passes
const headings = [...review.matchAll(/^### PASS (\d+) /gm)].map((m) => Number(m[1]));
check("review: pass headings are 0..N, each once, in order", JSON.stringify(headings) === JSON.stringify(headings.map((_, i) => i)), headings.join());
const max = Math.max(...headings);
const refs = [...new Set([...review.matchAll(/\bPASS (\d+)\b/g)].map((m) => Number(m[1])))];
check("review: every 'PASS n' it mentions exists", refs.every((n) => n <= max), refs.filter((n) => n > max).join());
const { PASSES } = await import(pathToFileURL(path.join(PKG, "mcp/dist/review_router.js")).href);
check("router: the pass catalog in code lists exactly the passes the review document defines", Object.keys(PASSES).length === headings.length && headings.every((n) => PASSES[n]), `${Object.keys(PASSES).length} in code, ${headings.length} in the document`);
const range = review.match(/PASS 0 to (\d+)/g) ?? [];
check("review: every 'PASS 0 to N' range ends at the last pass", range.every((r) => Number(r.match(/(\d+)$/)[1]) === max || Number(r.match(/(\d+)$/)[1]) === 10 || Number(r.match(/(\d+)$/)[1]) === 18), range.join(" | "));

// ---- report categories
const allowed = (/Category labels must come from this list only: ([^\n]+)/.exec(review)?.[1] ?? "").split("·").map((s) => s.trim()).filter(Boolean);
const used = [...review.matchAll(/Category label for the report: ([^\n]+)/g)].flatMap((m) => [...m[1].matchAll(/`([A-Z+\-0-9]+)`/g)].map((x) => x[1]));
check("review: every category label a pass tells the reviewer to use is an allowed report label", allowed.length > 10 && used.every((u) => allowed.includes(u)), used.filter((u) => !allowed.includes(u)).join());

// ---- one name per verdict
const all = docs.map(read).join("\n");
check("docs: one name for the middle verdict, not both 'WITH CHANGES' and 'WITH COMMENTS'", !(/APPROVED WITH CHANGES/.test(all) && /APPROVED WITH COMMENTS/.test(all)));

// ---- the platform facts a pass states must agree with AGENTS.md
const topicRows = [...agents.matchAll(/^\| `([a-z0-9]+(?:-[a-z0-9]+)+)` \|/gm)].map((m) => m[1]);
const listed = [...review.matchAll(/^\s+([a-z0-9]+(?:-[a-z0-9]+)+)\s+→\s+\S+/gm)].map((m) => m[1]);
check("review: no hard-coded Kafka topic list that AGENTS.md does not contain", topicRows.length > 3 && listed.every((t) => topicRows.includes(t)), listed.filter((t) => !topicRows.includes(t)).join());
check("review: PASS 4 takes its topics from extract_event_topics, not from memory", /### PASS 4[\s\S]*?extract_event_topics[\s\S]*?### PASS 5/.test(review));

// ---- contradictions that were made once
check("review: no 'can never be downgraded' wording next to the downgrade rules for severity floors", !/can never be downgraded, regardless/.test(review));
check("review: the severity floors say what happens for FACT, INFERENCE and Class B/C", /Class A \+ Basis: FACT → keep at BLOCKER/.test(review) && /Class A \+ Basis: INFERENCE → downgrade to WARNING/.test(review) && /Class B or C → WARNING/.test(review));
check("review: the floors and the evidence rule agree: only FACT is a BLOCKER", /BLOCKER only if Basis: FACT/.test(review) && /Only FACT can support a BLOCKER/.test(review));
check("review: a card has three required subsections, and FIX-HISTORY is the one optional fourth", /three required labeled subsections/.test(review) && /optional fourth subsection/.test(review));
check("review: PASS 22 runs after every finding pass and filters all of them", new RegExp(`filters findings from PASS 0 through PASS ${max}`).test(review) && !/runs LAST among all passes/.test(review));

// ---- the new reasoning tools are actually wired into the passes that need them
const wired = {
    "STEP 1C routes with route_review_passes": /## STEP 1C[\s\S]*?route_review_passes/,
    "PASS 1 starts from check_tenant_flow": /### PASS 1 [\s\S]*?check_tenant_flow[\s\S]*?### PASS 2/,
    "PASS 22 runs the evidence gate (validate_finding_evidence) first": /### PASS 22[\s\S]*?validate_finding_evidence/,
    "PASS 27 uses get_fix_history": /### PASS 27[\s\S]*?get_fix_history/,
    "zombie states are model-checked (check_lifecycle_model)": /Zombie states\.[\s\S]*?check_lifecycle_model/,
    "PASS 24 generates invariant checks (generate_invariant_checks)": /### PASS 24[\s\S]*?generate_invariant_checks/,
    "test strength uses analyze_mutation_report": /analyze_mutation_report/,
    "the review checks platform facts before relying on them (check_platform_facts)": /### 0\.2g[\s\S]*?check_platform_facts/,
    "the ledger is a reasoning step: implied and silent claims, reasoning before citing, and a hunt for what it cannot see": /### 0\.2h[\s\S]*?IMPLIED[\s\S]*?SILENT[\s\S]*?Reason before you cite[\s\S]*?cannot see[\s\S]*?### 0\.3/,
    "PASS 20 reasons from hypotheses first, ranks product cells above the baseline, and has the model reason on the top cells": /### PASS 20[\s\S]*?Hypotheses before the matrix[\s\S]*?custom_cells[\s\S]*?reason_top[\s\S]*?Do not optimise for filling the matrix/,
    "the review builds the claims ledger (build_claims_ledger) after the story boundary": /### 0\.2c[\s\S]*?### 0\.2h[\s\S]*?build_claims_ledger[\s\S]*?### 0\.3/,
    "PASS 19 starts from the ledger and PASS 20 from the edge matrix": /### PASS 19[\s\S]*?ledger[\s\S]*?### PASS 20[\s\S]*?build_edge_matrix/,
};
check("report: it has a NOT EXAMINED section between ASSUMPTIONS and BEFORE YOU MERGE that names the edges, claims and facts nobody settled, and refuses a false 'None.'", (() => { const a = review.indexOf("━━━ ASSUMPTIONS"), n = review.indexOf("━━━ NOT EXAMINED"), b = review.indexOf("━━━ BEFORE YOU MERGE"); const sec = review.slice(n, b); return a > 0 && n > a && b > n && /build_edge_matrix/.test(sec) && /claims ledger/.test(sec) && /check_platform_facts/.test(sec) && /Write "None\." only when/.test(sec); })());
check("report: diff-quality findings have their own label, and PLACEMENT is only for code put in the wrong place", allowed.includes("DIFF-QUALITY") && /### PASS 10[\s\S]*?Category label for the report: `DIFF-QUALITY`[\s\S]*?### PASS 11/.test(review) && /never `PLACEMENT`/.test(review));
check("report: the product and privacy fit has a slot (the end of PASSED) and open answers reach NOT EXAMINED", /Product and privacy fit:\*` with five lines/.test(review) && /SECTION 4 — PASSED[\s\S]*?Product and privacy fit[\s\S]*?SECTION 5/.test(review) && /UNVERIFIED or CONCERN, and the knowledge that would settle them/.test(review) && !/PASS 11 — PRODUCT & PRIVACY FIT/.test(review));
check("report: the verdict gate that could not run is stated, not left as a silent absence", /`verify_against_spec` was not called or could not be recorded/.test(review));
check("report: no loose prose and no duplicate closing: records written have a footer line, STEP 5 prints nothing more for a rejection", /Records written by this review:/.test(review) && /Print nothing more: repeating them is noise/.test(review) && /only if the verdict is not APPROVED, add:/.test(review));
check("severity: it is set by evidence and rules, never by request, in the review, its contract and the persona", /Severity is set by evidence and rules, not by request/.test(review) && /Lower a severity because the developer asked/.test(review) && /Developer position:/.test(review) && /Severity is not negotiable/.test(read("agents/reviewer.md")));
check("report: an approval with open high-risk edges or unverified claims says so under the verdict banner", /Not examined: \{N\} high-risk edge/.test(review));
const personas = { reviewer: read("agents/reviewer.md"), planner: read("agents/planner.md"), coder: read("agents/coder.md") };
check("personas: the reviewer reasons from the product, treats the tools as evidence, and reports what it did not examine", /### Reason from the product; use the tools as evidence/.test(personas.reviewer) && /Hypotheses first/.test(personas.reviewer) && /NOT EXAMINED/.test(personas.reviewer) && /build_claims_ledger/.test(personas.reviewer));
check("personas: the planner checks the story against reality and enumerates edges before the plan is final", /Story versus reality, and the edges nobody listed/.test(personas.planner) && /build_claims_ledger/.test(personas.planner) && /build_edge_matrix/.test(personas.planner));
check("personas: the coder proves its change with tenant-flow and the ledger before hand-off", /### Prove it before you hand off/.test(personas.coder) && /check_tenant_flow/.test(personas.coder) && /build_claims_ledger/.test(personas.coder));
check("context protocol: AGENTS.md carries Rule 0b with the seven steps, the golden rule and the decisions carve-out", /### Rule 0b — Context Sufficiency/.test(agents) && ["Inventory", "Objective", "Gap analysis", "Recover before you ask", "Targeted clarification", "Confidence", "Execute"].every((s) => agents.includes(`**${s}`)) && /KNOWN, INFERRED and UNKNOWN/.test(agents) && /The golden rule/.test(agents) && /never missing DECISIONS/.test(agents) && agents.indexOf("### Rule 0 ") < agents.indexOf("### Rule 0b") && agents.indexOf("### Rule 0b") < agents.indexOf("### Rule 1 "));
check("context protocol: all four commands start with it, and ask as confirm-or-correct", ["commands/sfn-init.md", "commands/sfn-spec.md", "commands/sfn-code.md", "commands/sfn-review.md"].every((f) => /\*\*Context first\.\*\*[\s\S]*?Rule 0b/.test(read(f))) && /confirm-or-correct of what you believe/.test(review) && /confirm or correct/.test(read("commands/sfn-spec.md")));
check("context protocol: the report states its context confidence and marks each assumption INFERRED or ASSUMED", /Context confidence: HIGH \| MEDIUM \| LOW/.test(review) && /\? INFERRED \| ASSUMED/.test(review));
check("context protocol: the planner and the reviewer persona recover before they ask and state their confidence", /RECOVER FIRST\*\* \(Rule 0b/.test(read("agents/planner.md")) && /Recover first \(the callers, the task artifacts/.test(read("agents/reviewer.md")) && /State your context confidence/.test(read("agents/reviewer.md")));
check("context discovery: /sfn-review has the seven-phase mode, runs it when there is no task or specification, and never asks for requirements first", /## CONTEXT DISCOVERY MODE/.test(review) && ["Current state assessment", "Infer the developer's intent", "Gap analysis", "Draft task context", "Reconstruct the context", "Review\\.", "Knowledge capture"].every((p) => new RegExp("\\*\\*" + p).test(review)) && /discover_review_context/.test(review) && /record_draft_task_context/.test(review) && /never ask the developer for requirements first/.test(review) && /### 0\.2b[\s\S]*?run CONTEXT DISCOVERY MODE[\s\S]*?### 0\.2c/.test(review));
check("context discovery: the intent is investigated, not filled in: competing hypotheses, product-aware reading, own investigation, verified confidence and the protocol on questions", /reason_about_intent/.test(review) && /Competing hypotheses/.test(review) && /Product-aware reading/.test(review) && /Do your own investigation before you ask/.test(review) && /caps a hypothesis that nothing supports at 40/.test(review) && /at HIGH there is nothing to ask beyond two optional confirmations/.test(review) && /do not fill in a template/.test(review));
check("context discovery: confidence is recorded before and after the developer answers, and the persona investigates before it asks", /stage: "inferred"/.test(review) && /stage: "confirmed"/.test(review) && /progression/.test(review) && /reason_about_intent/.test(read("agents/reviewer.md")) && /confidence that the evidence earns, not the confidence you feel/.test(read("agents/reviewer.md")));
check("modes: /sfn-review names its two modes, how one is chosen, how it switches, and prints the mode in the report header", /## REVIEW MODES/.test(review) && /Mode 1: Existing Task Review/.test(review) && /Mode 2: Context Discovery Review/.test(review) && /decides the mode deterministically/.test(review) && /IDENTITY CONFLICT/.test(review) && /\*\*Switching\.\*\*/.test(review) && /Mode 1: Existing Task Review \(\{ref\}\) \| Mode 2: Context Discovery Review/.test(review) && review.indexOf("## REVIEW MODES") < review.indexOf("## CONTEXT DISCOVERY MODE") && /description:[^\n]*Mode 1, Existing Task Review[^\n]*Mode 2, Context Discovery Review/.test(review));
check("modes: the persona and the tool carry the same two modes", /\*\*Two modes\.\*\*/.test(read("agents/reviewer.md")) && /Mode 1, Existing Task Review/.test(read("agents/reviewer.md")) && /work_item/.test(fs.readFileSync(path.join(PKG, "mcp/src/tools_context.ts"), "utf8")));
check("context discovery: the draft reference is provisional, never a work item, and an inferred intent caps severity", /BE-TASK-Dnnn backend[\s\S]*?INFRA-TASK-Dnnn infrastructure/.test(review) && /never use it in a branch, commit, pull request or Azure Boards entry/.test(review) && /refuses to store inferred information as confirmed/.test(review) && /depends on an INFERRED intent is at most a WARNING and a question/.test(review));
check("context discovery: the persona recovers the context before asking and marks only the developer's words CONFIRMED", /No task, no problem/.test(read("agents/reviewer.md")) && /discover_review_context/.test(read("agents/reviewer.md")));
check("migrations: PASS 0 starts from the deterministic guard, treats an applied migration as immutable, and fires for any framework", /### PASS 0[\s\S]*?migration file of any other framework[\s\S]*?\*\*F — Applied migrations are immutable\*\*[\s\S]*?check_applied_migrations[\s\S]*?VERSION_CLASH[\s\S]*?### PASS 1/.test(review));
check("agents: AGENTS.md no longer claims a pre-PR check that no tool implements", !/automated in `run_pre_pr_checks`/.test(agents) && /check_applied_migrations/.test(agents));
const spec = read("commands/sfn-spec.md");
check("wiring: /sfn-spec asks whether the story matches reality (ledger, platform facts) and enumerates edges before the plan is final", /Does the story match reality\?[\s\S]*?build_claims_ledger[\s\S]*?check_platform_facts/.test(spec) && /\*\*Edges\.\*\*[\s\S]*?build_edge_matrix/.test(spec));
for (const [name, re] of Object.entries(wired)) check(`wiring: ${name}`, re.test(review));
check("wiring: /sfn-code scans its own tenant access, mutation-tests its guards and self-reviews with the ledger", /check_tenant_flow/.test(code) && /analyze_mutation_report/.test(code) && /Do it with the ledger[\s\S]*?build_claims_ledger/.test(code));

// ---- every language the tools claim is in the language-neutral table, in both commands
check("languages: the review has a language-neutral table covering Java, TypeScript, Python, C#, Go, Ruby and PHP", /## LANGUAGE-NEUTRAL REVIEW/.test(review) && ["Java", "TypeScript", "Python", "C#", "Go", "Ruby", "PHP"].every((l) => review.slice(review.indexOf("## LANGUAGE-NEUTRAL REVIEW"), review.indexOf("## STEP 2 ")).includes(l)));
check("languages: /sfn-code applies SOLID and DRY in the file's own language", /\*\*Any language\.\*\*/.test(code));

// ---- the workspace-level copies of the agent files are aligned with the shipped ones
for (const f of fs.readdirSync(path.join(PKG, "agents"))) {
    let root = null;
    try { root = read(`../.agents/${f}`); } catch { /* optional when the package is tested alone */ }
    if (root !== null) check(`agents/${f}: the repo-level .agents copy is identical`, root === read(`agents/${f}`));
}

console.log(failures === 0 ? "\nInstruction lint passed." : `\n${failures} instruction lint check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
