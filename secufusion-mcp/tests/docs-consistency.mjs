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
check("/sfn-review covers reordering, naming, conventions and scope vs the specification", /REORDERING/.test(review) && /Naming inconsistencies/.test(review) && /diff_scope/.test(review) && /noisy diff/i.test(review));

const router = read("agents/claude.md");
check("the agent router describes init, spec, code, review and no retired tool", /sfn:spec/.test(router) && /sfn:code/.test(router) && /sfn:review/.test(router) && !/run_pre_pr_checks_with_reviewer_agent/.test(router));

const plugin = JSON.parse(read(".claude-plugin/plugin.json"));
check("plugin.json describes the init -> spec -> code -> review workflow", /sfn-spec/.test(plugin.description) && /sfn-code/.test(plugin.description) && /sfn-review/.test(plugin.description));
check("generate_spec_document is registered", tools.has("generate_spec_document"));


check("/sfn-init builds project understanding from .mcp/ and keeps agents.md lightweight", /load_project_knowledge\(/.test(cmds["sfn-init.md"]) && /agents\.md lightweight|Keep agents\.md lightweight/i.test(cmds["sfn-init.md"]) && /record_project_knowledge/.test(cmds["sfn-init.md"]));
check("/sfn-spec consults project knowledge before investigating", /get_project_knowledge/.test(cmds["sfn-spec.md"]) && /terminology trap|intentional exception/i.test(cmds["sfn-spec.md"]));
check("/sfn-review and the reviewer persona check recorded exceptions before flagging", /get_project_knowledge/.test(cmds["sfn-review.md"]) && /get_project_knowledge/.test(read("agents/reviewer.md")) && /known exception|intentional/i.test(read("agents/reviewer.md")));
check("project-specific terminology no longer lives in AGENTS.md (it points to .mcp/)", !/Naming inconsistency ≠ bug/.test(read("agents/AGENTS.md")) && !/\| \*\*Device\*\* \| A \*\*browser installation\*\*/.test(read("agents/AGENTS.md")) && /\.mcp\/architecture\/terminology-device-vs-machine\.md/.test(read("agents/AGENTS.md")));
const init = cmds["sfn-init.md"];
check("/sfn-init backs up the spec AND the migrations file BEFORE scanning, and passes the migrations baseline to the release notes", /preserve the "before" state/.test(init) && /\.secufusion-migrations\.json\.backup/.test(init) && init.indexOf("preserve the \"before\" state") < init.indexOf("scan_repository_stack(workspace_root") && /previous_migrations_path/.test(init));
check("/sfn-init builds release notes with generate_release_notes (change-driven), not by free-writing", tools.has("generate_release_notes") && /generate_release_notes\(/.test(init) && /changelog, not a repository scan/.test(init) && /previous_spec_path/.test(init) && /Do not paste inventories/.test(init));

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures ? 1 : 0);
