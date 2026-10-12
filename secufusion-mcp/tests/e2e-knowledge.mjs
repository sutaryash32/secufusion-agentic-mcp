import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..").split(path.sep).join("/");
const SDK = `${PKG}/node_modules/@modelcontextprotocol/sdk/dist/esm`;
const { Client } = await import(pathToFileURL(`${SDK}/client/index.js`).href);
const { StdioClientTransport } = await import(pathToFileURL(`${SDK}/client/stdio.js`).href);

let failures = 0;
const check = (name, cond, detail = "") => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + detail}`);
    if (!cond) failures++;
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2etmp-"));
fs.writeFileSync(path.join(dir, "package.json"), "{}");
fs.writeFileSync(path.join(dir, ".secufusion-project-spec.json"), JSON.stringify({ microservices: { a: { language: "Java" } }, golden_rules: { r1: "Scope by tenant" } }));
const c = new Client({ name: "e2e", version: "1" }, { capabilities: {} });
await c.connect(new StdioClientTransport({ command: "node", args: [`${PKG}/mcp/dist/server.js`, "--root", dir], cwd: dir }));
const call = async (name, args) => {
    const r = await c.callTool({ name, arguments: args });
    return { err: !!r.isError, text: r.content.map((x) => x.text).join("\n") };
};
const W = dir;

const tools = new Set((await c.listTools()).tools.map((t) => t.name));
const pkgVersion = JSON.parse(fs.readFileSync(`${PKG}/package.json`, "utf-8")).version;
check("the server reports the package version to clients (not a stale hardcoded number)", c.getServerVersion()?.version === pkgVersion, `${c.getServerVersion()?.version} vs ${pkgVersion}`);
check("the four knowledge tools are registered", ["load_project_knowledge", "get_project_knowledge", "record_project_knowledge", "set_knowledge_status"].every((t) => tools.has(t)));

// ── a project with no intelligence layer yet ───────────────────────────────
let r = await call("load_project_knowledge", { workspace_root: W });
check("no .mcp/: says so, and offers to scaffold instead of failing", !r.err && r.text.includes("No Project Intelligence Layer") && r.text.includes("scaffold=true"), r.text);
check("nothing was created by merely looking", !fs.existsSync(path.join(dir, ".mcp")));
r = await call("get_project_knowledge", { workspace_root: W, terms: ["device"] });
check("querying a project without a layer is a clean no-op", !r.err && r.text.includes("No Project Intelligence Layer"));

r = await call("load_project_knowledge", { workspace_root: W, scaffold: true });
check("scaffold creates the structure", !r.err && fs.existsSync(path.join(dir, ".mcp", "known-exceptions")) && fs.existsSync(path.join(dir, ".mcp", "README.md")), r.text);

// ── adding knowledge ───────────────────────────────────────────────────────
r = await call("record_project_knowledge", { workspace_root: W, category: "known-exceptions", title: "Retention scheduler uses the system principal", body: "By design the scheduler authorizes as the system principal, not a user token. Do not 'fix' this.", source: "ADR review 2026-09", tags: ["retention", "authorization"], applies_to: ["retention", "**/Retention*.java"] });
check("recorded as PROPOSED, with the file location", !r.err && r.text.includes("PROPOSED") && r.text.includes(".mcp/known-exceptions/retention-scheduler-uses-the-system-principal.md"), r.text);
r = await call("record_project_knowledge", { workspace_root: W, category: "patterns", title: "Unsourced", body: "x", source: "   " });
check("knowledge without a source is refused", r.err && r.text.includes("source is required"), r.text);
r = await call("record_project_knowledge", { workspace_root: W, category: "patterns", title: "Sneaky accept", body: "x", source: "me", status: "accepted" });
check("an AI cannot mark knowledge accepted without the user's words", r.err && r.text.includes("user_statement"), r.text);
r = await call("record_project_knowledge", { workspace_root: W, category: "architecture", title: "Device vs Machine", body: "Device is a browser installation. Machine is a physical endpoint.", source: "team", tags: ["terminology"], applies_to: ["device", "*Device*"], status: "accepted", user_statement: "Yes, that is the correct definition" });
check("accepted when the user confirms", !r.err && r.text.includes("ACCEPTED"), r.text);

// ── finding it again, by relevance ─────────────────────────────────────────
r = await call("get_project_knowledge", { workspace_root: W, terms: ["1542 wrong label for browser count in the delete device user dialog"], files: ["sfn-web-ui/src/DeleteDeviceUserDialog.jsx"] });
check("the ticket's words and files surface the terminology trap, with why", r.text.includes("Device vs Machine") && r.text.includes("Matched:") && !r.text.includes("Retention scheduler"), r.text.slice(0, 500));
r = await call("get_project_knowledge", { workspace_root: W, files: ["sfn-policy-api/src/RetentionJob.java"] });
check("a file path surfaces the scoped exception, labelled unreviewed", r.text.includes("Retention scheduler") && r.text.includes("PROPOSED") && r.text.includes("unreviewed"), r.text.slice(0, 500));
r = await call("get_project_knowledge", { workspace_root: W, terms: ["zzzzzz"] });
check("no match says so, without claiming nothing is intentional", r.text.includes("No project knowledge matches") && r.text.includes("not evidence"), r.text);

// ── reviewing knowledge ────────────────────────────────────────────────────
r = await call("set_knowledge_status", { workspace_root: W, id: "retention-scheduler-uses-the-system-principal", status: "accepted", user_statement: "" });
check("accepting needs the user's words", r.err, r.text);
r = await call("set_knowledge_status", { workspace_root: W, id: "retention-scheduler-uses-the-system-principal", status: "accepted", user_statement: "Confirmed, that is intentional" });
check("accepted with the user's words", !r.err && r.text.includes("ACCEPTED"), r.text);
r = await call("get_project_knowledge", { workspace_root: W, files: ["sfn-policy-api/src/RetentionJob.java"] });
check("it is no longer labelled unreviewed", r.text.includes("Retention scheduler") && !r.text.includes("PROPOSED"));
r = await call("set_knowledge_status", { workspace_root: W, id: "ghost", status: "accepted", user_statement: "ok" });
check("unknown id is a clear error", r.err && r.text.includes("No knowledge entry"), r.text);

r = await call("load_project_knowledge", { workspace_root: W });
check("the model summary lists entries per category with accepted counts", r.text.includes("known-exceptions** (1, 1 accepted)") && r.text.includes("architecture** (1, 1 accepted)") && r.text.includes("terminology") === false || r.text.includes("Device vs Machine"), r.text);
check("load shows the unified view: DNA missing is stated, Project Intelligence counted", r.text.includes("Unified project knowledge") && r.text.includes("DNA (what): not built yet") && /Project Intelligence \(why\): \d+ entr/.test(r.text), r.text);
fs.mkdirSync(path.join(dir, ".secufusion"), { recursive: true });
fs.writeFileSync(path.join(dir, ".secufusion", "dna.json"), JSON.stringify({ graph: { nodes: [{ id: "s1", name: "alpha", type: "SERVICE" }, { id: "s2", name: "beta", type: "SERVICE" }, { id: "t1", name: "orders", type: "TOPIC" }], edges: [] } }));
r = await call("load_project_knowledge", { workspace_root: W });
check("with DNA present, what exists (2 services, 1 topics) sits beside why it exists", r.text.includes("DNA (what): 2 services, 1 topics") && /Project Intelligence \(why\)/.test(r.text), r.text);
fs.rmSync(path.join(dir, ".secufusion", "dna.json"));
fs.writeFileSync(path.join(dir, ".mcp", "patterns", "broken.md"), "no frontmatter here\n");
r = await call("load_project_knowledge", { workspace_root: W });
check("a malformed entry is reported rather than silently ignored", r.text.includes("MISSING_FRONTMATTER") && r.text.includes("broken.md"), r.text);
fs.rmSync(path.join(dir, ".mcp", "patterns", "broken.md"));

// ── ADRs: a design narrative first, metadata last ──────────────────────────
{
    const adrBody = (summary) => `> ${summary}\n\n## Decision Snapshot\n\n**Problem**\n\nReplicas diverge.\n\n**Decision**\n\nReconcile from the database.\n\n**Outcome**\n\nAll replicas converge.\n\n**Status**\n\nProposed\n\n**Related Work**\n\n- STORY-1093\n\n---\n\n## Executive Summary\n\nIt mattered because retention jobs ran twice.\n\n## Context\n\nc\n\n## Problem Statement\n\nps\n\n## Investigation Summary\n\nis\n\n## Options Considered\n\noc\n\n## Decision\n\nd\n\n## Consequences\n\n### Benefits\n\nb\n\n### Trade-Offs\n\nt\n\n### Risks\n\nr\n\n### Future Reconsideration Criteria\n\nf\n\n## Verification\n\nv\n\n## References\n\n- ref\n`;
    let r = await call("record_project_knowledge", { workspace_root: W, category: "adr", title: "Sloppy ADR", body: "id: adr-0009\ntitle: x\nstatus: proposed\n\nWe decided things.", source: "test" });
    check("an ADR that opens with metadata and skips the structure is refused, with what to fix", r.err && r.text.includes("does not follow the ADR format standard") && r.text.includes("begins with metadata") && r.text.includes("missing section `## Executive Summary`"), r.text.slice(0, 400));
    r = await call("record_project_knowledge", { workspace_root: W, category: "adr", title: "Preventing Scheduler State Divergence Across Events API Replicas", body: adrBody("Ensuring all replicas derive identical scheduler state from the database using reconciliation."), source: "STORY-1093 investigation" });
    check("a compliant ADR is recorded as PROPOSED", !r.err && r.text.includes("PROPOSED") && r.text.includes(".mcp/adr/adr-"), r.text);
    const adrFile = fs.readdirSync(path.join(dir, ".mcp", "adr")).find((f) => f.includes("scheduler-state"));
    const adrText = adrFile ? fs.readFileSync(path.join(dir, ".mcp", "adr", adrFile), "utf8") : "";
    check("the file reads like a document: title, summary, executive summary first, metadata last", /^# ADR-\d{4}: Preventing Scheduler State Divergence Across Events API Replicas\n\n> Ensuring all replicas/.test(adrText) && !adrText.startsWith("---") && adrText.indexOf("## Executive Summary") < adrText.indexOf("<!-- mcp:entry") && adrText.trimEnd().endsWith("-->"), adrText.slice(0, 200));
    r = await call("get_project_knowledge", { workspace_root: W, terms: ["scheduler state divergence replicas"] });
    check("retrieval shows the readable ADR with its summary first", r.text.includes("# ADR-") && r.text.includes("> Ensuring all replicas") && !r.text.includes("mcp:entry"), r.text.slice(0, 500));
    const adrId = adrFile.replace(/\.md$/, "");
    r = await call("set_knowledge_status", { workspace_root: W, id: adrId, status: "accepted", user_statement: "Yes, this is the decision we took." });
    const accepted = fs.readFileSync(path.join(dir, ".mcp", "adr", adrFile), "utf8");
    check("accepting it updates the readable Status line and the metadata together", !r.err && /\*\*Status\*\*\s+Accepted/.test(accepted) && /^status: accepted$/m.test(accepted), r.text + accepted.slice(-250));
}

// ── release history now lives with the project ─────────────────────────────
r = await call("generate_release_notes", { workspace_root: W, version: "1.0.0", why: "baseline" });
check("with a .mcp/ layer, release notes and snapshots are written under .mcp/release-history (version-controlled)", fs.existsSync(path.join(dir, ".mcp", "release-history", "v1.0.0.md")) && fs.existsSync(path.join(dir, ".mcp", "release-history", "snapshots", "v1.0.0.json")) && !fs.existsSync(path.join(dir, ".secufusion", "releases", "v1.0.0.md")), r.text.slice(0, 300));
fs.writeFileSync(path.join(dir, ".secufusion-project-spec.json"), JSON.stringify({ microservices: { a: { language: "Java" }, b: { language: "Go" } }, golden_rules: { r1: "Scope by tenant" } }));
r = await call("generate_release_notes", { workspace_root: W, version: "1.1.0", why: "add b" });
check("the next release compares against the snapshot kept in .mcp/release-history", r.text.includes("Compared against: v1.0.0") && /New services \(1\)/.test(r.text), r.text.slice(0, 400));
r = await call("load_project_knowledge", { workspace_root: W });
check("release history is part of the memory model", r.text.includes("release-history") && r.text.includes("v1.0.0.md"), r.text);

// ── health report: documented vs discovered, no invented percentage ────────
fs.writeFileSync(path.join(dir, ".secufusion-project-spec.json"), JSON.stringify({
    platform: { event_bus: "Kafka", database: "PostgreSQL" },
    terminology: { Device: "browser installation", Machine: "physical endpoint" },
    microservices: { "svc-a": { language: "Java", kafka_produces: ["a-events"], owns_tables: ["t1"] }, "svc-b": { language: "Java", owns_tables: ["t2"] } },
    golden_rules: { tenant_isolation: "scope by tenant" },
}));
r = await call("get_knowledge_health", { workspace_root: W });
check("health reports 'N of M discovered entities documented' and no percentage", /\*\*Coverage: \d+ of \d+ discovered entities documented\*\*/.test(r.text) && !r.text.includes("%"), r.text.slice(0, 300));
check("...Device/Machine are documented (an accepted entry names them); the services are not", r.text.includes("Domain concepts | 2 | 2 |") && r.text.includes("Services | 2 | 0 |"), r.text.slice(0, 700));
check("...with the definition of 'documented' stated", r.text.includes("at least one `accepted` entry"));
check("...and anomaly candidates reported separately", r.text.includes("Known-exception candidates (not in the coverage line)"));
r = await call("load_project_knowledge", { workspace_root: W });
check("the /sfn-init index now ends with the health report and top suggestions", r.text.includes("## Project intelligence health") && r.text.includes("suggestion(s) to turn what is known into project knowledge"), r.text.slice(-600));

// ── repeated investigation is noticed, and clears once knowledge exists ────
const q = { workspace_root: W, terms: ["quarantine zebra protocol"] };
let n1 = await call("get_project_knowledge", q), n2 = await call("get_project_knowledge", q);
check("the first two lookups of an unanswered topic raise no nudge", !n1.text.includes("Repeated investigation") && !n2.text.includes("Repeated investigation"));
let n3 = await call("get_project_knowledge", q);
check("the third raises 'Repeated investigation detected' with the dates and a way to act", n3.text.includes("Repeated investigation detected") && n3.text.includes("quarantine") && n3.text.includes("record_project_knowledge"), n3.text);
r = await call("suggest_project_knowledge", { workspace_root: W });
check("suggest_project_knowledge lists it first, as HIGH, with evidence and a prefilled call that has no body", r.text.includes("1. **[HIGH] Investigation notes: protocol, quarantine, zebra**") && r.text.includes("Looked up 3 times") && r.text.includes("record_project_knowledge(") && !r.text.includes("body:"), r.text.slice(0, 700));
check("the lookups are kept as local working state, not in .mcp (which is committed)", fs.existsSync(path.join(dir, ".secufusion", "knowledge-lookups.json")) && !fs.readdirSync(path.join(dir, ".mcp")).some((f) => f.includes("lookup")));
await call("record_project_knowledge", { workspace_root: W, category: "known-exceptions", title: "Quarantine zebra protocol", body: "The zebra quarantine is intentional.", source: "ops runbook", applies_to: ["quarantine zebra protocol"], status: "accepted", user_statement: "yes" });
n3 = await call("get_project_knowledge", q);
check("once accepted knowledge answers it, the nudge is gone", !n3.text.includes("Repeated investigation") && n3.text.includes("Quarantine zebra protocol"));
r = await call("suggest_project_knowledge", { workspace_root: W });
check("...and it is no longer suggested", !r.text.includes("quarantine"), r.text.slice(0, 400));

// investigating an entity feeds the same history
fs.mkdirSync(path.join(dir, ".secufusion"), { recursive: true });
fs.writeFileSync(path.join(dir, ".secufusion", "dna.json"), JSON.stringify({ graph: { nodes: [], edges: [] } }));
let i3;
for (let i = 0; i < 3; i++) i3 = await call("investigate_entity", { workspace_root: W, entity_name: "Frobnicator" });
check("investigating the same entity three times with no knowledge triggers the nudge too", i3.text.includes("Repeated investigation detected") && i3.text.includes("frobnicator"), i3.text.slice(-400));

// ── adoption: explain why, offer, and only create when asked or opted in ────
const bare = fs.mkdtempSync(path.join(os.tmpdir(), "e2etmp-"));
fs.writeFileSync(path.join(bare, "package.json"), "{}");
r = await call("load_project_knowledge", { workspace_root: bare });
check("no .mcp/: it explains why the layer matters and how to opt in to auto-creation", r.text.includes("Why it matters") && r.text.includes("auto_scaffold_knowledge") && r.text.includes("off by default"), r.text.slice(0, 700));
check("...and creates nothing by itself", !fs.existsSync(path.join(bare, ".mcp")));
r = await call("get_knowledge_health", { workspace_root: bare });
check("health without a layer says so instead of inventing a score", r.text.includes("No Project Intelligence Layer yet") && !r.text.includes("%"));
fs.writeFileSync(path.join(bare, ".secufusion-project-spec.json"), JSON.stringify({ _meta: { auto_scaffold_knowledge: true }, microservices: { s: {} } }));
r = await call("load_project_knowledge", { workspace_root: bare });
check("with auto_scaffold_knowledge:true it creates the structure and says it did so automatically", r.text.includes("Created the Project Intelligence Layer") && r.text.includes("automatically") && fs.existsSync(path.join(bare, ".mcp", "adr")), r.text.slice(0, 500));
check("...including a template per category", ["architecture", "adr", "patterns", "known-exceptions", "lessons-learned", "operational"].every((c) => fs.existsSync(path.join(bare, ".mcp", "templates", `${c}.md`))));
check("...and it claims no knowledge exists yet", r.text.includes("It is empty") && r.text.includes("never invents knowledge") || r.text.includes("nothing has been claimed"), r.text);
fs.rmSync(bare, { recursive: true, force: true });

await c.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures ? 1 : 0);
