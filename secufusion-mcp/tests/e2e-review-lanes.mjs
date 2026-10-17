import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";

// The three review lanes (merge regressions, silent behavior changes, scope drift), called through the real MCP server.
const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..").split(path.sep).join("/");
const SDK = `${PKG}/node_modules/@modelcontextprotocol/sdk/dist/esm`;
const { Client } = await import(pathToFileURL(`${SDK}/client/index.js`).href);
const { StdioClientTransport } = await import(pathToFileURL(`${SDK}/client/stdio.js`).href);

let failures = 0;
const check = (name, cond, detail = "") => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + detail}`);
    if (!cond) failures++;
};
const GIT = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", "-c", "commit.gpgsign=false"];
const g = (cwd, ...a) => execFileSync("git", [...GIT, ...a], { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const put = (root, rel, text) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };

const CTRL = "svc-a/src/main/java/com/x/EventController.java";
const BASE = `package com.x;

@RestController
@RequestMapping("/api/events")
public class EventController {

    @GetMapping("/{id}")
    @PreAuthorize("hasAuthority('event.read')")
    public Event get(@PathVariable Long id) {
        return service.find(id);
    }

    public int count() {
        return 1;
    }

    public int last() {
        return 9;
    }
}
`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2elanes-"));
fs.writeFileSync(path.join(dir, "package.json"), "{}");
g(dir, "init", "-q", "-b", "main");
put(dir, CTRL, BASE); put(dir, "README.md", "x\n");
g(dir, "add", "-A"); g(dir, "commit", "-q", "-m", "base");
g(dir, "checkout", "-q", "-b", "develop");
put(dir, CTRL, BASE.replace("    public int last() {", "    @GetMapping(\"/stats\")\n    public Stats stats() {\n        return null;\n    }\n\n    public int last() {"));
g(dir, "add", "-A"); g(dir, "commit", "-q", "-m", "develop adds /stats");
g(dir, "checkout", "-q", "main"); g(dir, "checkout", "-q", "-b", "feature");
put(dir, CTRL, BASE.replace("    public int count() {", "    public int featureOnly(int a) {\n        return a;\n    }\n\n    public int count() {"));
g(dir, "add", "-A"); g(dir, "commit", "-q", "-m", "feature work");
g(dir, "merge", "--no-commit", "--no-ff", "develop");
// a bad resolution: the develop endpoint and the authorization are lost; a tenant check changes silently; an unrelated file arrives
let t = fs.readFileSync(path.join(dir, CTRL), "utf8");
t = t.replace("    @GetMapping(\"/stats\")\n    public Stats stats() {\n        return null;\n    }\n\n", "").replace("    @PreAuthorize(\"hasAuthority('event.read')\")\n", "").replace("return 9;", "return 10;");
fs.writeFileSync(path.join(dir, CTRL), t);
put(dir, "svc-b/src/main/java/com/x/Banner.java", "package com.x;\n\npublic class Banner {\n}\n");
g(dir, "add", "-A"); g(dir, "commit", "-q", "-m", "Merge develop into feature");
const head = g(dir, "rev-parse", "HEAD");

const c = new Client({ name: "e2e", version: "1" }, { capabilities: {} });
await c.connect(new StdioClientTransport({ command: "node", args: [`${PKG}/mcp/dist/server.js`, "--root", dir], cwd: dir }));
const call = async (name, args) => { const r = await c.callTool({ name, arguments: { workspace_root: dir, ...args } }); return { err: !!r.isError, text: r.content.map((x) => x.text).join("\n") }; };
const tools = new Set((await c.listTools()).tools.map((x) => x.name));
check("the three lane tools are registered", ["check_merge_regressions", "check_behavior_changes", "check_scope_drift"].every((n) => tools.has(n)));

let r = await call("check_merge_regressions", { base: "main" });
check("merge regressions: the lost endpoint and authorization are POSSIBLE MERGE REGRESSIONs with evidence, and nothing is altered", !r.err && r.text.includes("POSSIBLE MERGE REGRESSION") && r.text.includes("GET /api/events/stats") && r.text.includes("PreAuthorize") && r.text.includes("Developer review required.") && r.text.includes("First disappeared in merge commit") && g(dir, "rev-parse", "HEAD") === head && g(dir, "status", "--porcelain") === "", r.text.slice(0, 600));
check("merge regressions: the feature-side method is kept, so it is not reported", !r.text.includes("featureOnly"));
r = await call("check_merge_regressions", { base: "main", format: "json" });
const json = JSON.parse(r.text);
check("merge regressions: json carries severity, parents and the base", json.counts.HIGH >= 2 && json.merges[0].parents.length === 2 && !!json.merges[0].base && json.findings.every((f) => f.severity && f.merge), r.text.slice(0, 300));

r = await call("check_behavior_changes", { base: "main" });
check("behavior changes: the silently changed value is surfaced as a candidate with the six-field instruction", !r.err && r.text.includes("BEHAVIOR CHANGE CANDIDATE") && r.text.includes("Intent Explicitly Confirmed") && /(DEFAULT|TIME|CONDITIONAL|AUTHORIZATION)/.test(r.text), r.text.slice(0, 700));

r = await call("check_scope_drift", { base: "main", core_files: [CTRL] });
check("scope drift: the unrelated service's file is reported as SCOPE DRIFT, report only", !r.err && r.text.includes("SCOPE DRIFT") && r.text.includes("svc-b/src/main/java/com/x/Banner.java") && r.text.includes("Move to separate story or explain why included.") && r.text.includes("never fails the review"), r.text.slice(0, 700));
check("scope drift: the controller is a core story file, not drift", /### CORE STORY FILES\n- svc-a\/src\/main\/java\/com\/x\/EventController\.java/.test(r.text), r.text.slice(0, 500));
r = await call("check_scope_drift", { base: "main" });
check("scope drift without a story says it cannot classify (does not call everything drift)", r.text.includes("could not be classified against a story") && !/^SCOPE DRIFT$/m.test(r.text), r.text.slice(0, 400));

check("check_entity_impact and check_invariant_enforcement are registered", tools.has("check_entity_impact") && tools.has("check_invariant_enforcement"));
r = await call("check_invariant_enforcement", { fields: ["count"] });
check("invariant enforcement: the map is produced through the server, names the field's variants, and states what an 'exactly one' invariant needs", !r.err && r.text.includes("INVARIANT ENFORCEMENT MAP") && r.text.includes("### count") && r.text.includes("Enforcement:") && /exactly one per tenant/.test(r.text) && g(dir, "status", "--porcelain") === "", r.text.slice(0, 500));
r = await call("check_entity_impact", { entity_terms: ["Event"], flags: ["count"], story_text: "transfer ownership" });
check("entity impact accepts flags and reports them", !r.err && /flags checked for authority coupling: count/.test(r.text), r.text.slice(0, 300));
r = await call("check_entity_impact", { entity_terms: ["Event"], story_text: "Let an admin transfer ownership of an event to another member" });
check("entity impact: the whole workspace is inventoried per service with file:line evidence, the trigger fires, and nothing changes", !r.err && r.text.includes("ENTITY IMPACT INVENTORY") && r.text.includes("Pessimistic-review trigger: FIRED") && /### [\w.-]+  \(\d+ files scanned; 1 non-test files reference the entity/.test(r.text) && /References: Event=\d+/.test(r.text) && /a hit is not a defect/i.test(r.text) && g(dir, "rev-parse", "HEAD") === head && g(dir, "status", "--porcelain") === "", r.text.slice(0, 700));
r = await call("check_entity_impact", { entity_terms: ["Event"], story_text: "Change the colour of the save button", format: "json" });
check("entity impact: a cosmetic story text contributes no trigger signal (json)", !JSON.parse(r.text).trigger.sources.includes("story text"), r.text.slice(0, 400));
// review maturity: confidence, decision registry, invariant catalog
check("the three maturity tools are registered", ["score_review_confidence", "check_decision_alignment", "get_relevant_invariants"].every((n) => tools.has(n)));
r = await call("score_review_confidence", { work_item_id: "STORY-X", findings_count: 0, invariants_inferred: 2, cross_service_scan: "not_run", pessimistic_trigger_fired: true });
check("confidence: an unexamined pessimistic review is LOW, says so, and is saved next to the gate ledger", !r.err && /CONFIDENCE SCORE: LOW/.test(r.text) && /CONFIDENCE EXPLANATION:/.test(r.text) && /not evidence of correctness/.test(r.text) && fs.existsSync(path.join(dir, ".secufusion", "gates", "STORY-X.confidence.json")), r.text.slice(0, 400));
put(dir, ".secufusion/tasks/STORY-X/decisions.json", JSON.stringify([{ id: 1, decision: "UD-1: the eventCount accessor must not change. User decision.", rationale: "User statement: keep count()", logged_at: "x" }]));
r = await call("check_decision_alignment", { terms: ["eventCount"], base: "main" });
check("decision registry: a recorded decision the diff touches is surfaced with signals and the four verdicts, read-only", !r.err && /DECISION ALIGNMENT:/.test(r.text) && /UD-1/.test(r.text) && /ALIGNS \/ VIOLATES \/ PARTIALLY ALIGNS \/ UNVERIFIED/.test(r.text) && g(dir, "rev-parse", "HEAD") === head, r.text.slice(0, 500));
r = await call("record_project_knowledge", { category: "invariants", title: "Event count stays one", body: "**Rule.** count() returns the single event count.", source: "UD-1", tags: ["event"], applies_to: ["count", "event"], meta: { domain: "Event", fields: ["count"], enforcement: ["CODE"] } });
check("an invariant is recorded through the knowledge tool, as proposed, with structured fields", !r.err && /PROPOSED invariants knowledge/.test(r.text), r.text);
r = await call("get_relevant_invariants", { terms: ["event", "count"], fields: ["count"], base: "main" });
check("invariant catalog: the recorded invariant is retrieved with source, enforcement and a classification (never CONFIRMED on code-only)", !r.err && /INVARIANT CATALOG: 1 invariant/.test(r.text) && /CLASSIFICATION: PROPOSED/.test(r.text) && /SOURCE:/.test(r.text) && /ENFORCEMENT TYPE:/.test(r.text), r.text.slice(0, 600));
await c.close();
fs.rmSync(dir, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
