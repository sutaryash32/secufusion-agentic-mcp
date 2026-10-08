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
fs.writeFileSync(path.join(dir, ".mcp", "patterns", "broken.md"), "no frontmatter here\n");
r = await call("load_project_knowledge", { workspace_root: W });
check("a malformed entry is reported rather than silently ignored", r.text.includes("MISSING_FRONTMATTER") && r.text.includes("broken.md"), r.text);
fs.rmSync(path.join(dir, ".mcp", "patterns", "broken.md"));

// ── release history now lives with the project ─────────────────────────────
r = await call("generate_release_notes", { workspace_root: W, version: "1.0.0", why: "baseline" });
check("with a .mcp/ layer, release notes and snapshots are written under .mcp/release-history (version-controlled)", fs.existsSync(path.join(dir, ".mcp", "release-history", "v1.0.0.md")) && fs.existsSync(path.join(dir, ".mcp", "release-history", "snapshots", "v1.0.0.json")) && !fs.existsSync(path.join(dir, ".secufusion", "releases", "v1.0.0.md")), r.text.slice(0, 300));
fs.writeFileSync(path.join(dir, ".secufusion-project-spec.json"), JSON.stringify({ microservices: { a: { language: "Java" }, b: { language: "Go" } }, golden_rules: { r1: "Scope by tenant" } }));
r = await call("generate_release_notes", { workspace_root: W, version: "1.1.0", why: "add b" });
check("the next release compares against the snapshot kept in .mcp/release-history", r.text.includes("Compared against: v1.0.0") && /New services \(1\)/.test(r.text), r.text.slice(0, 400));
r = await call("load_project_knowledge", { workspace_root: W });
check("release history is part of the memory model", r.text.includes("release-history") && r.text.includes("v1.0.0.md"), r.text);

await c.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures ? 1 : 0);
