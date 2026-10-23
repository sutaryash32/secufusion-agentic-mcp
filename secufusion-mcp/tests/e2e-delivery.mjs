import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";

/**
 * The delivery tools through the real server: they are registered, they run on a real git repository, their
 * outputs are what the review instructions promise, nothing leaves the machine without being asked, and the
 * judgment protocol still works when no engine is configured.
 */
const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..").split(path.sep).join("/");
const SDK = `${PKG}/node_modules/@modelcontextprotocol/sdk/dist/esm`;
const { Client } = await import(pathToFileURL(`${SDK}/client/index.js`).href);
const { StdioClientTransport } = await import(pathToFileURL(`${SDK}/client/stdio.js`).href);

let failures = 0;
const check = (name, cond, detail = "") => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + String(detail).slice(0, 400)}`);
    if (!cond) failures++;
};
const write = (root, rel, content) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "dlv-e2e-"));
const git = (...a) => execFileSync("git", ["-C", ws, "-c", "user.name=Dev", "-c", "user.email=d@d", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
write(ws, "pom.xml", "<project/>");
write(ws, "src/main/resources/db/migration/V1__a.sql", "create table a (id int);\n");
write(ws, "src/main/resources/db/migration/V2__b.sql", "create table b (id int);\n");
git("init", "-q"); git("symbolic-ref", "HEAD", "refs/heads/develop"); git("add", "."); git("commit", "-q", "-m", "base"); git("checkout", "-q", "-b", "work");
write(ws, "src/main/resources/db/migration/V2__b.sql", "create table b (id int, x int);\n");
write(ws, "src/main/java/com/x/RepoQ.java", 'class RepoQ {\n  Object find(String id) { return em.createNativeQuery("select * from t where id=" + id); }\n}\n');

const env = { ...process.env }; for (const k of ["SFN_ENGINE", "SFN_VERIFY_ENGINE", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) delete env[k];
const c = new Client({ name: "delivery", version: "1" }, { capabilities: {} });
await c.connect(new StdioClientTransport({ command: "node", args: [`${PKG}/mcp/dist/server.js`, "--root", ws], cwd: PKG, env }));
const call = async (name, args) => { const r = await c.callTool({ name, arguments: args }); return { text: r.content[0].text, error: !!r.isError }; };

const NEW = ["run_quick_check", "get_rule_catalog", "verify_findings", "merge_review_runs", "finalize_review_findings", "findings_to_sarif", "render_review_report", "suggest_reviewers", "run_quick_eval", "load_eval_cases", "draft_eval_case_from_fix", "snapshot_db_schema", "lookup_db_schema", "audit_dependencies", "check_release_readiness", "get_review_metrics", "get_engine_status"];
const tools = new Set((await c.listTools()).tools.map((t) => t.name));
check("all 17 delivery tools are registered", NEW.every((t) => tools.has(t)), NEW.filter((t) => !tools.has(t)).join());

const qc = await call("run_quick_check", { workspace_root: ws, base: "develop", format: "json" });
const q = JSON.parse(qc.text);
check("quick check over the server: the edited applied migration and the SQL concatenation are found, the gate fails", q.findings.some((f) => f.ruleId === "DB-002") && q.findings.some((f) => f.ruleId === "SEC-010") && q.gate.exitCode === 1 && q.stack === "java-spring", qc.text);

const cat = await call("get_rule_catalog", { area: "security", repo: "sfn-events-api" });
check("rule catalog over the server: security rules with the evidence mapping and the repository notes", /SEC-010 \[blocker, quick-check\]/.test(cat.text) && /BLOCKER when FACT/.test(cat.text) && /Repository notes/.test(cat.text));

const findings = q.findings.map(({ id, ...f }) => f);
const fin = await call("finalize_review_findings", { workspace_root: ws, findings, gate: { fail_on: "blocker" }, record: true });
const f = JSON.parse(fin.text);
check("finalize over the server: stable ids, a verdict, a failing gate, and the run is stored", f.result.findings.every((x) => x.id) && f.result.verdict === "fix_first" && f.gate.exitCode === 1 && fs.readdirSync(path.join(ws, ".secufusion", "review-runs")).length === 1, fin.text.slice(0, 300));

const fixedOne = findings.filter((x) => x.ruleId !== "SEC-010");
const again = JSON.parse((await call("finalize_review_findings", { workspace_root: ws, findings: fixedOne, previous: "auto" })).text);
check("finalize over the server: a re-review reports the finding that was fixed", again.result.delta.fixed.some((x) => x.ruleId === "SEC-010") && again.result.delta.stillOpen.length >= 1);

const noDate = JSON.parse((await call("finalize_review_findings", { workspace_root: ws, findings, suppressions: [] })).text);
check("finalize over the server: nothing is hidden unless a suppression with an end date says so", noDate.result.suppressed.length === 0);

const sarif = await call("findings_to_sarif", { workspace_root: ws, result: f.result, out_path: ".secufusion/review.sarif" });
check("sarif over the server is written inside the workspace", /Wrote/.test(sarif.text) && JSON.parse(fs.readFileSync(path.join(ws, ".secufusion/review.sarif"), "utf8")).version === "2.1.0");
const esc = await call("findings_to_sarif", { workspace_root: ws, result: f.result, out_path: "../escape.sarif" });
check("a report path outside the workspace is refused", esc.error && /outside workspace_root/.test(esc.text));

const html = await call("render_review_report", { workspace_root: ws, result: f.result, out_path: ".secufusion/review.html", reviewers_base: "develop" });
check("html report over the server is written and contains the findings", /Wrote/.test(html.text) && /SEC-010/.test(fs.readFileSync(path.join(ws, ".secufusion/review.html"), "utf8")));

const met = await call("get_review_metrics", { workspace_root: ws, html_path: ".secufusion/metrics.html" });
check("metrics over the server read the stored run, with no author anywhere", /1 review/.test(met.text) && fs.existsSync(path.join(ws, ".secufusion/metrics.html")) && !/Dev\b/.test(met.text));

const eng = await call("get_engine_status", {});
check("engine status: with nothing configured both engines are off, and it says prompts are only sent on purpose", /primary: off/.test(eng.text) && /verify: off/.test(eng.text) && /on purpose/.test(eng.text));

const dep = await call("audit_dependencies", { workspace_root: ws, base: "develop" });
check("dependency audit never touches the network unless allowed, and says so", /NOT run/.test(dep.text) && /allow_network/.test(dep.text));

const lk = await call("lookup_db_schema", { workspace_root: ws, tables: ["a"] });
check("schema lookup without a snapshot says what to do instead of guessing", lk.error && /snapshot_db_schema/.test(lk.text));
const snap = await call("snapshot_db_schema", { workspace_root: ws, url_env: "postgres://u:p@h/db" });
check("schema snapshot refuses a connection string passed as an argument, without echoing it", snap.error && /NAME of an environment variable/.test(snap.text) && !/u:p@h/.test(snap.text));

const ver = await call("verify_findings", { workspace_root: ws, findings: f.result.findings.filter((x) => x.ruleId === "SEC-010"), mode: "cross" });
check("verify with no client model and no engine asks the calling model and records nothing", /JUDGMENT REQUIRED/.test(ver.text) && /verify-findings/.test(ver.text) && /REFUTE/.test(ver.text) && /createNativeQuery/.test(ver.text) && !fs.existsSync(path.join(ws, ".secufusion", "judgments")));
const ok = await call("verify_findings", { workspace_root: ws, findings: f.result.findings.slice(0, 2), judgment: { decisions: [{ n: 0, decision: "confirm", verification: "no bind parameter" }, { n: 1, decision: "reject", verification: "the file is a test fixture" }] } });
const vr = JSON.parse(ok.text);
check("verify with a supplied judgment applies it: confirmed kept, rejected removed with its reason", vr.kept.length === 1 && vr.rejected.length === 1 && vr.rejected[0].verification === "the file is a test fixture");

const ev = await call("run_quick_eval", { format: "json" });
const er = JSON.parse(ev.text);
check("quick eval over the server: every case the quick check can judge passes", er.report.overall.cases_passed === er.report.overall.cases && er.report.overall.cases >= 6 && er.needs_model.length >= 5, ev.text.slice(0, 300));

const rel = await call("check_release_readiness", { workspace_root: ws, from: "develop", to: "HEAD" });
check("release readiness over the server runs on a range", /Release readiness/.test(rel.text));

await c.close();
console.log(failures === 0 ? "\nAll delivery e2e checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
