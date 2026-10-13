import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

/**
 * The command and agent documents are the product's real interface to the LLM. This checks that they
 * stay true to the server: every tool they name exists, the 4-command pipeline is wired, and the
 * deprecated commands redirect instead of duplicating logic.
 */

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..").split(path.sep).join("/");
const SDK = `${PKG}/node_modules/@modelcontextprotocol/sdk/dist/esm`;
const { Client } = await import(pathToFileURL(`${SDK}/client/index.js`).href);
const { StdioClientTransport } = await import(pathToFileURL(`${SDK}/client/stdio.js`).href);

let failures = 0;
const check = (name, cond, detail = "") => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + detail}`);
    if (!cond) failures++;
};

const c = new Client({ name: "docs", version: "1" }, { capabilities: {} });
await c.connect(new StdioClientTransport({ command: "node", args: [`${PKG}/mcp/dist/server.js`, "--root", process.env.TEMP || "/tmp"], cwd: PKG }));
const listed = (await c.listTools()).tools;
const tools = new Set(listed.map((t) => t.name));
// Values of any tool's `action` parameter are legitimate things for a document to name (e.g. manage_task action=log_decision).
const actions = new Set(listed.flatMap((t) => t.inputSchema?.properties?.action?.enum ?? []));
await c.close();

const read = (rel) => fs.readFileSync(path.join(PKG, rel), "utf8");
const docs = [
    ...fs.readdirSync(path.join(PKG, "commands")).map((f) => `commands/${f}`),
    ...fs.readdirSync(path.join(PKG, "agents")).map((f) => `agents/${f}`),
];

// Identifiers that look like tool names but are fields, files, folders or retired tools.
const NOT_TOOLS = new Set([
    "files_touched", "work_item_id", "task_type", "business_goal", "acceptance_criteria", "services_involved", "out_of_scope",
    "raw_request", "data_lifecycle", "business_rules", "root_cause", "user_statement", "decision_id", "requirement_id", "design_id",
    "affected_components", "novelty_reason", "next_step", "pending_acs", "completed_acs", "file_path", "change_summary",
    "ui_impact", "ui_reference", "user_decisions", "plan_gate", "workspace_root", "diff_summary", "diff_quality", "diff_scope",
    "outside_plan", "planned_untouched", "total_churn_lines", "branch_suffix", "commit_prefix", "pr_title_prefix", "required_changes",
    "scope_creep", "guardrail_violations", "out_of_scope_changes", "reported_by", "client_confirmed", "skip_checks",
    "run_pre_pr_checks_with_reviewer_agent", // retired; checked separately below
    "spec_json", "claude_plugin_root",
    "spec_document", // a library module (mcp/src/spec_document.ts), not a tool
]);
const TOOL_SHAPED = /\b(?:manage|get|spec|check|verify|validate|record|resolve|normalize|classify|philosophy|prime|generate|discover|investigate|trace|create|find|calculate|score|search|suggest|skill|log|ingest|execute|correlate|query|refresh|inspect|extract|scan|start|load|mark|retire|link|analyze|smart|detect|set|ask|answer)_[a-z_]+\b/g;

for (const rel of docs) {
    const text = read(rel);
    const unknown = [...new Set(text.match(TOOL_SHAPED) ?? [])].filter((t) => !tools.has(t) && !actions.has(t) && !NOT_TOOLS.has(t));
    check(`${rel}: every tool-shaped name it uses exists on the server`, unknown.length === 0, unknown.join(", "));
}

// ── the root README is the front door: it must match the server ──────────
{
    const readme = read("../README.md");
    const missing = [...tools].filter((t) => !new RegExp("`" + t + "`").test(readme));
    check("README's tool reference mentions every registered tool", missing.length === 0, missing.join(", "));
    const invented = [...new Set(readme.match(TOOL_SHAPED) ?? [])].filter((t) => !tools.has(t) && !actions.has(t) && !NOT_TOOLS.has(t));
    check("README names no tool that does not exist", invented.length === 0, invented.join(", "));
    check("README documents the four-command workflow and the .mcp layer", ["/sfn-init", "/sfn-spec", "/sfn-code", "/sfn-review", ".mcp/", "Project teaches the agent"].every((x) => readme.includes(x)));
    check("README has every requested section, in the requested order",
        (() => {
            const want = ["## Why This Exists", "## Major Revamp", "## Project Intelligence Layer", "## MCP Workflow", "## Commands", "## Review Philosophy", "## Knowledge Management", "## Lessons Learned",
                "## Architectural Decisions", "## New Contributor Guide", "## Contributing Knowledge", "## Release Notes Philosophy", "## Long-Term Vision"];
            const pos = want.map((h) => readme.indexOf(h));
            return pos.every((p, i) => p >= 0 && (i === 0 || p > pos[i - 1]));
        })());
    check("README explains the .mcp folders, proposed vs accepted, and delta-first release notes",
        ["architecture/", "adr/", "patterns/", "known-exceptions/", "lessons-learned/", "operational/", "release-history/", "agents.md"].every((x) => readme.includes(x)) &&
        /proposed/.test(readme) && /accepted/.test(readme) && /Delta first\. Snapshot second/.test(readme) && /A correct implementation with a noisy diff is not a fully reviewed change/.test(readme));
    const pkgVersion = JSON.parse(read("package.json")).version;
    const pluginVersion = JSON.parse(read(".claude-plugin/plugin.json")).version;
    check("every release carries its MCP release information: release-notes/v<version>.md has all six sections, and ships in the package", (() => {
        const f = path.join(PKG, "release-notes", `v${pkgVersion}.md`);
        if (!fs.existsSync(f)) return false;
        const t = fs.readFileSync(f, "utf-8").replace(/\r\n/g, "\n");
        const heads = ["Summary", "Added", "Changed", "Fixed", "Breaking changes", "New tools"];
        const body = (h) => (new RegExp("## " + h + "\\n([\\s\\S]*?)(?=\\n## |$)").exec(t)?.[1] ?? "").trim();
        return heads.every((h) => body(h).length > 0) && JSON.parse(fs.readFileSync(path.join(PKG, "package.json"), "utf-8")).files.includes("release-notes");
    })(), `a version bump needs release-notes/v${pkgVersion}.md (Summary, Added, Changed, Fixed, Breaking changes, New tools)`);
check("package.json and the plugin manifest carry the same version", pkgVersion === pluginVersion, `${pkgVersion} vs ${pluginVersion}`);
    check("README states the current version and has matching release notes", readme.includes(`**Version ${pkgVersion}**`) && readme.includes(`## What's New in ${pkgVersion}`) && readme.includes("## Upgrading from"), pkgVersion);
    check("README's '71 tools' style counts match the server", (() => { const m = /\*\*Version [\d.]+\*\*[^\n]*?(\d+) tools/.exec(readme); return !!m && Number(m[1]) === tools.size; })(), `server has ${tools.size}`);
    check("README ends with the closing line", readme.trimEnd().endsWith("The intelligence of the project should travel with the project itself."));
    check("README states the retired commands are gone and mentions no removed tool", /no longer exist/.test(readme) && !/manage_branch_state|@2[.]2[.]5/.test(readme));
}

const cmds = Object.fromEntries(fs.readdirSync(path.join(PKG, "commands")).map((f) => [f, read(`commands/${f}`)]));
check("the pipeline commands exist: init, spec, code, review", ["sfn-init.md", "sfn-spec.md", "sfn-code.md", "sfn-review.md"].every((f) => cmds[f]));
check("every command has frontmatter with a description", Object.entries(cmds).every(([, t]) => /^---\n[\s\S]*?description:/.test(t.replace(/\r\n/g, "\n"))));

const spec = cmds["sfn-spec.md"];
const REQUIRED_STEPS = ["philosophy_check", "spec_create_intent", "manage_task", "manage_requirement", "classify_task", "manage_exploration", "manage_implementation_plan", "validate_implementation_plan", "generate_spec_document", "resolve_work_item_ref"];
check("/sfn-spec covers understand, investigate, analyze and design with the right tools", REQUIRED_STEPS.every((t) => spec.includes(t)), REQUIRED_STEPS.filter((t) => !spec.includes(t)).join());
check("/sfn-spec forbids production code and invented decisions", /Do NOT write or modify any production code/.test(spec) && /Never invent a decision/.test(spec));
check("/sfn-spec orders philosophy before spec_create_intent before manage_task initialize (the server gate order)", spec.indexOf("philosophy_check") < spec.indexOf("spec_create_intent") && spec.indexOf("spec_create_intent") < spec.indexOf("manage_task action=initialize"));
check("/sfn-spec ends by yielding to the user and handing off to /sfn-code", /YIELD/.test(spec) && /\/sfn-code/.test(spec));

check("exactly the four pipeline commands exist (the retired /sfn-plan and /sfn-explore are gone)", JSON.stringify(Object.keys(cmds).sort()) === JSON.stringify(["sfn-code.md", "sfn-init.md", "sfn-review.md", "sfn-spec.md"]), Object.keys(cmds).join());
const RETIRED = new RegExp(["sfn-plan", "sfn:plan", "sfn-explore", "sfn:explore"].join("|"));
const mentioning = [...docs, "../layman.md", ".claude-plugin/plugin.json", "../.agents/claude.md"].filter((f) => RETIRED.test(read(f)));
check("no document, README or plugin manifest still names a retired command", mentioning.length === 0, mentioning.join(", "));

const code = cmds["sfn-code.md"];
check("/sfn-code requires the specification and refuses to improvise one", /spec\.md/.test(code) && /\/sfn-spec/.test(code) && !/run `\/sfn-plan/.test(code));
check("/sfn-code: build only what was specified, preserve conventions and line endings, no drive-by changes", /Build only what was specified/.test(code) && /line endings/i.test(code) && /unrelated refactoring/i.test(code));

const review = cmds["sfn-review.md"];
check("/sfn-review has the diff-quality pass and records the verdict against the spec", /PASS 10/.test(review) && /check_diff_quality/.test(review) && /verify_against_spec/.test(review));
{
    const rv = cmds["sfn-review.md"];
    const passes = [...rv.matchAll(/^### PASS (\d+) /gm)].map((m) => Number(m[1]));
    check("/sfn-review has every pass 0 to 18, once each, in order", JSON.stringify(passes) === JSON.stringify([...Array(19).keys()]), passes.join());
    check("/sfn-review PASS 11 is Product & Privacy Fit and asks the five questions with four possible answers", /### PASS 11 — Product & Privacy Fit/.test(rv) && ["actual product behavior", "production deployment model", "tenant hierarchy", "hard to maintain six months", "violate the privacy model"].every((q) => rv.replace(/\*/g, "").toLowerCase().includes(q.toLowerCase())) && ["FITS", "DOES NOT FIT", "CONCERN", "UNVERIFIED"].every((a) => rv.includes(a)));
    check("/sfn-review covers all eight dimensions with their own passes", ["Product Behavior", "Architecture & Service Boundaries", "Deployment Model", "Tenant Hierarchy", "Privacy Model", "Operational Resilience", "Future Maintainability"].every((h) => new RegExp("### PASS \\d+ — " + h.replace(/[&]/g, "\\&")).test(rv)));
    check("/sfn-review never invents product rules: Source and Basis required, only FACT blocks, unrecorded is UNVERIFIED", /Source:/.test(rv) && /Basis:/.test(rv) && /Only FACT can support a BLOCKER/.test(rv) && /UNVERIFIED/.test(rv) && /KNOWLEDGE GAPS/.test(rv) && /Invent a product rule/.test(rv));
    check("/sfn-review is standalone: builds product knowledge itself, falls back to source, accepts any target and any work-item type", /Zero prior MCP session/.test(rv) && /Fall back to the source code/.test(rv) && /get_project_knowledge/.test(rv) && /analyze_impact/.test(rv) && /BUG-1230/.test(rv) && /folder path/i.test(rv));
    check("/sfn-review report has the product fit table, dimensions, knowledge used and gaps", ["PRODUCT & PRIVACY FIT", "REVIEW DIMENSIONS", "PRODUCT KNOWLEDGE USED", "KNOWLEDGE GAPS"].every((h) => rv.includes("## " + h)));
    check("/sfn-review is an investigation, not a checklist: hypotheses are formed, tested and traced, lenses not forms", /HOW YOU REVIEW/.test(rv) && /## STEP 1B/.test(rv) && /hypothes/i.test(rv) && /H\{n\}/.test(rv) && /## REASONING TRACE/.test(rv) && /lenses?/.test(rv) && /never a ceiling/.test(rv) && /not a checklist runner|Run the passes as a checklist/.test(rv) && /DISMISSED/.test(rv));
    check("/sfn-review keeps deterministic facts deterministic while letting the model reason", /What stays deterministic/.test(rv) && /check_diff_quality/.test(rv) && /score_change_risk/.test(rv));
    check("/sfn-review is spec-aware: loads the specification before the code, finds one when none is named, and never invents one", /## STEP 0 — Build your product, specification and experience knowledge/.test(rv) && /### 0\.2b: Load the specification/.test(rv) && /spec_status/.test(rv) && /spec\.md/.test(rv) && /search_tasks/.test(rv) && /No specification exists/.test(rv) && /Do not invent a specification/.test(rv));
    check("/sfn-review checks conformance to the whole spec: scope, decisions, assumptions, claims, and whether the spec contradicts the product", /FINDING 6C — SCOPE/.test(rv) && /FINDING 6D — SPEC DECISION/.test(rv) && /FINDING 6E — SPEC ASSUMPTION/.test(rv) && /specification itself\*\* contradicts recorded product knowledge/.test(rv));
    check("/sfn-review loads engineering experience as the lowest-trust memory, never a rule", /get_engineering_experience/.test(rv) && /find_experience_conflicts/.test(rv) && /lowest-trust memory/.test(rv) && /EXPERIENCE_USED_AS_FACT/.test(rv));
    check("the report names the specification and the experience used", /specification you reviewed against/.test(rv) && /Engineering experience consulted/.test(rv));
    check("/sfn-review establishes the story boundary first (objective, acceptance criteria, decisions, out-of-scope items) and falls back to the diff, never an invented boundary", /### 0\.2c: Establish the story boundary/.test(rv) && /Story objective/.test(rv) && /Out-of-scope items/.test(rv) && /boundary of last resort: \*\*the diff\*\*/.test(rv) && /do not invent a boundary/.test(rv) && rv.indexOf("### 0.2c") < rv.indexOf("### 0.3"));
    check("/sfn-review classifies every finding as Class A, B or C with the boundary test", /## STEP 3C/.test(rv) && /\*\*CLASS A: IN SCOPE\.\*\*/.test(rv) && /\*\*CLASS B: ADJACENT CONCERNS\.\*\*/.test(rv) && /\*\*CLASS C: FUTURE PRODUCT RISKS\.\*\*/.test(rv) && /directly contribute to satisfying the acceptance criteria, the ADR or the problem statement/.test(rv) && /Do not propose code changes inside the current story/.test(rv) && /separate story/.test(rv));
    check("approval rests only on Class A, and the scope rules cannot be used to hide a real finding", /decided \*\*only by Class A findings\*\*/.test(rv) && /Do not launder a real finding into Class B/.test(rv) && /Deterministic gates are always Class A/.test(rv) && /An unmet acceptance criterion is Class A/.test(rv) && /PASS 9 suggestions are never Class A/.test(rv) && /Introduced beats existing/.test(rv));
    check("the report follows the scope structure: story scope, in-scope findings, out-of-scope observations, future considerations, verdict from in-scope only", (() => { const o = ["## STORY SCOPE ASSESSMENT", "## IN-SCOPE FINDINGS", "## OUT-OF-SCOPE OBSERVATIONS", "## FUTURE CONSIDERATIONS", "## FINAL VERDICT (based only on in-scope findings)"].map((h) => rv.indexOf(h)); return o.every((x) => x > 0) && o.every((x, i) => i === 0 || x > o[i - 1]); })());
    check("legacy and suggestion material no longer feeds the verdict (PASS 9, PASS 10 legacy, PASS 11 answers, persona)", /Its output is never in scope/.test(rv) && /Pre-existing mixed endings[^\n]*OUT-OF-SCOPE OBSERVATIONS \(Class B\)/.test(rv) && /The answers concern this change/.test(rv) && /### Story boundary: review the story, not the neighbourhood/.test(read("agents/reviewer.md")) && /as OUT-OF-SCOPE OBSERVATIONS \(Class B\)/.test(read("agents/reviewer.md")) && /The review stays inside the story/.test(read("../README.md")));
    check("maintainability alone never blocks", /maintainability alone never produces a BLOCKER/i.test(rv));
}
check("/sfn-review covers reordering, naming, conventions and scope vs the specification", /REORDERING/.test(review) && /Naming inconsistencies/.test(review) && /diff_scope/.test(review) && /noisy diff/i.test(review));

const router = read("agents/claude.md");
check("the agent router describes init, spec, code, review and no retired tool", /sfn:spec/.test(router) && /sfn:code/.test(router) && /sfn:review/.test(router) && !/run_pre_pr_checks_with_reviewer_agent/.test(router));

const plugin = JSON.parse(read(".claude-plugin/plugin.json"));
check("plugin.json describes the init -> spec -> code -> review workflow", /sfn-spec/.test(plugin.description) && /sfn-code/.test(plugin.description) && /sfn-review/.test(plugin.description));
check("generate_spec_document is registered", tools.has("generate_spec_document"));


for (const f of ["AGENTS.md", "claude.md", "coder.md", "planner.md", "reviewer.md"]) {
    const norm = (t) => t.replace(/\r\n/g, "\n");
    let rootCopy = null;
    try { rootCopy = norm(read(`../.agents/${f}`)); } catch { /* the repo-level copy is optional when the package is tested on its own */ }
    if (rootCopy !== null) check(`agent file ${f}: repo-level .agents copy is aligned with the shipped plugin copy`, rootCopy === norm(read(`agents/${f}`)));
}
{
    const agents = read("agents/AGENTS.md").replace(/\r\n/g, "\n");
    const sec = /## ARTIFACT PLACEMENT, ONE HOME PER DOCUMENT\n([\s\S]*?)\n---/.exec(agents)?.[1] ?? "";
    check("AGENTS.md has one home per document: the type table and all nine rules", sec.length > 0 && ["| Document type | Home | How |", "SEARCH BEFORE YOU CREATE", "ONE SOURCE OF RECORD", "NEVER WRITE A FILE WITH THE NAME", "HAND-WRITING INTO `.mcp/`", "A USER-GIVEN PATH THAT DOES NOT NAME A REPO", "MOVING OR RENAMING A FILE", "PREFLIGHT", "BOOKKEEPING", "END EVERY TURN THAT CREATED FILES WITH A TABLE"].every((x) => sec.includes(x)));
    check("knowledge-type documents (ADR, lessons, exceptions, patterns) go to .mcp via record_project_knowledge, saved proposed, never as a second copy", /ADR \/ architecture decision, lessons learned, known exception, pattern, operational constraint \| `\.mcp\/<category>\/`/.test(sec) && /`record_project_knowledge`; saved as `proposed`/.test(sec) && /supersedes/.test(sec) && /Never create a second ADR/.test(sec) && /get_project_knowledge/.test(sec));
    check("placement rules use real tools: resolve_work_item_ref, record_project_knowledge, get_project_knowledge, manage_task log_file_touched", ["resolve_work_item_ref", "record_project_knowledge", "get_project_knowledge", "manage_task", "generate_spec_document"].every((t) => sec.includes(t) && tools.has(t)) && /log_file_touched/.test(sec));
    const mcpGenerated = ["spec.md", "pr-summary.md", "spec.json", "decisions.json", "progress.json", "files-touched.json", "scenarios.json", "pr-narrative.json"];
    check("every file an MCP tool generates is named as forbidden, and hand-written ones carry .draft", mcpGenerated.every((f) => new RegExp("`" + f.replace(".", "\.") + "`").test(sec)) && /\.draft/.test(sec));
    check("the reviewer persona's hand-written deliverables use the .draft names in the task folder", /`ado-comment\.draft\.md`/.test(read("agents/reviewer.md")) && /`pr-comment\.draft\.md`/.test(read("agents/reviewer.md")) && !/ado-comments\.md/.test(read("agents/reviewer.md")));
    {
        const persona = read("agents/reviewer.md").replace(/\r\n/g, "\n");
        const inv = /### Design Investigation Record[\s\S]*?(?=\nTask type emoji|\n## Phase 2)/.exec(persona)?.[0] ?? "";
        const sections = ["Problem discovered", "How it was investigated", "Assumptions proven wrong", "Architectural requirements identified", "Original architecture", "Failure scenarios", "Analyses", "Options evaluated", "Final architecture", "Risks that remain", "Release blockers", "Open questions", "References"];
        check("the reviewer persona defines the Design Investigation Record with every section the format requires", inv.length > 0 && sections.every((h) => inv.includes(h)) && /investigation\.draft\.md/.test(inv));
        check("the investigation record never duplicates the PR summary or the ADR, is built from recorded evidence, and says 'not recorded' instead of guessing", /Do NOT create another PR summary and do NOT create another ADR/.test(inv) && /not recorded/.test(inv) && /recorded evidence only/.test(inv) && /Source of record:/.test(inv) && /WHY/.test(inv));
        check("the ADR is recorded through record_project_knowledge (category adr), searched first, never a hand-written second copy", /### ADR \(architecture decision\)[\s\S]*?record_project_knowledge[\s\S]*?`adr`[\s\S]*?get_project_knowledge[\s\S]*?supersedes/.test(persona));
        check("the ADR format standard is in the persona and the README: title and summary first, never metadata, every required section", /\*\*ADR format standard\.\*\*/.test(persona) && /Never start it with metadata/.test(persona) && ["Decision Snapshot", "Executive Summary", "Problem Statement", "Investigation Summary", "Options Considered", "Future Reconsideration Criteria", "Verification", "References"].every((h) => persona.includes(h) && read("../README.md").includes(h)) && /ADRs are documents first/.test(read("../README.md")));
        check("the post-review order is ADO comment, PR description, ADR, then the investigation record, and /sfn-review offers all of them", /ADO comment, the PR description, the ADR[^\n]*and the Design Investigation Record/.test(persona) && /ADO comment, PR description, the ADR[^\n]*and the design investigation record/.test(cmds["sfn-review.md"]));
    }
    check("/sfn-review writes the PR summary with generate_pr_summary before completing, from what the work established", /generate_pr_summary/.test(cmds["sfn-review.md"]) && cmds["sfn-review.md"].indexOf("generate_pr_summary") < cmds["sfn-review.md"].lastIndexOf("manage_task action=complete") && /Not recorded/.test(cmds["sfn-review.md"]) && tools.has("generate_pr_summary"));
    check("/sfn-init seeds the platform defaults (Device vs Machine) by default, as proposed and never duplicated", /load_project_knowledge\(workspace_root, seed_defaults: true\)/.test(cmds["sfn-init.md"]) && /Device vs Machine terminology/.test(cmds["sfn-init.md"]) && /proposed/.test(cmds["sfn-init.md"]) && /never a second copy/.test(cmds["sfn-init.md"]) && /Platform defaults\./.test(read("../README.md")));
    check("/sfn-spec, /sfn-code and /sfn-review each point at the placement rule and require log_file_touched", ["sfn-spec.md", "sfn-code.md", "sfn-review.md"].every((f) => /ARTIFACT PLACEMENT, ONE HOME PER DOCUMENT/.test(cmds[f]) && /log_file_touched/.test(cmds[f])) && !Object.values(cmds).some((t) => /FILE-CREATION DISCIPLINE/.test(t)) && !/FILE-CREATION DISCIPLINE/.test(agents));
}
const readmeText = read("../README.md");
check("README presents DNA (what) and Project Intelligence (why) as one Unified Project Knowledge System", /## Unified Project Knowledge System/.test(readmeText) && /What exists\?/.test(readmeText) && /Why does it exist\?/.test(readmeText) && /DNA tells the MCP what the system is\. Project Intelligence tells the MCP why the system became that way\./.test(readmeText));
check("/sfn-init loads both layers and says they are combined; the agent router does too", /Unified Project Knowledge System/.test(cmds["sfn-init.md"]) && /what exists/.test(cmds["sfn-init.md"]) && /why it exists/.test(cmds["sfn-init.md"]) && /Layer 2/.test(read("agents/claude.md")) && /Layer 1/.test(read("agents/claude.md")));
check("/sfn-init builds project understanding from .mcp/ and keeps agents.md lightweight", /load_project_knowledge\(/.test(cmds["sfn-init.md"]) && /agents\.md lightweight|Keep agents\.md lightweight/i.test(cmds["sfn-init.md"]) && /record_project_knowledge/.test(cmds["sfn-init.md"]));
check("/sfn-spec consults project knowledge before investigating", /get_project_knowledge/.test(cmds["sfn-spec.md"]) && /terminology trap|intentional exception/i.test(cmds["sfn-spec.md"]));
check("/sfn-review and the reviewer persona check recorded exceptions before flagging", /get_project_knowledge/.test(cmds["sfn-review.md"]) && /get_project_knowledge/.test(read("agents/reviewer.md")) && /known exception|intentional/i.test(read("agents/reviewer.md")));
check("project-specific terminology no longer lives in AGENTS.md (it points to .mcp/)", !/Naming inconsistency ≠ bug/.test(read("agents/AGENTS.md")) && !/\| \*\*Device\*\* \| A \*\*browser installation\*\*/.test(read("agents/AGENTS.md")) && /\.mcp\/architecture\/terminology-device-vs-machine\.md/.test(read("agents/AGENTS.md")));
const init = cmds["sfn-init.md"];
check("/sfn-init presents the health report without turning it into a score, offers suggestions, and explains templates and opt-in auto-scaffold", /never turn them into a percentage or a grade/.test(init) && /suggest_project_knowledge/.test(init) && /\.mcp\/templates/.test(init) && /auto_scaffold_knowledge/.test(init) && /unconfirmed/.test(init));
check("/sfn-spec and /sfn-review act on the repeated-investigation nudge", /Repeated investigation detected/.test(cmds["sfn-spec.md"]) && /repeated investigation/i.test(cmds["sfn-review.md"]));
check("/sfn-init backs up the spec AND the migrations file BEFORE scanning, and passes the migrations baseline to the release notes", /preserve the "before" state/.test(init) && /\.secufusion-migrations\.json\.backup/.test(init) && init.indexOf("preserve the \"before\" state") < init.indexOf("scan_repository_stack(workspace_root") && /previous_migrations_path/.test(init));
check("/sfn-init builds release notes with generate_release_notes (change-driven), not by free-writing", tools.has("generate_release_notes") && /generate_release_notes\(/.test(init) && /changelog, not a repository scan/.test(init) && /previous_spec_path/.test(init) && /Do not paste inventories/.test(init));

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures ? 1 : 0);
