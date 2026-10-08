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
]);
const TOOL_SHAPED = /\b(?:manage|get|spec|check|verify|validate|record|resolve|normalize|classify|philosophy|prime|generate|discover|investigate|trace|create|find|calculate|score|search|suggest|skill|log|ingest|execute|correlate|query|refresh|inspect|extract|scan|start|load|mark|retire|link|analyze|smart|detect|set|ask|answer)_[a-z_]+\b/g;

for (const rel of docs) {
    const text = read(rel);
    const unknown = [...new Set(text.match(TOOL_SHAPED) ?? [])].filter((t) => !tools.has(t) && !actions.has(t) && !NOT_TOOLS.has(t));
    check(`${rel}: every tool-shaped name it uses exists on the server`, unknown.length === 0, unknown.join(", "));
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
const mentioning = [...docs, "../README.md", "../layman.md", ".claude-plugin/plugin.json", "../.agents/claude.md"].filter((f) => RETIRED.test(read(f)));
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

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures ? 1 : 0);
