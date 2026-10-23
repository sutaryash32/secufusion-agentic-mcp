// @ts-nocheck
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync, spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { Finding, assignIds, applySeverityFloors, applySuppressions, applyDecisions, computeDelta, decideVerdict, gateDecision, mergeRuns, toSarif, trimNoise, sortFindings, findingId, DEFAULT_SEVERITY_FLOORS } from "./review_findings.js";
import { runQuickCheck, parseAddedLines, quickCheck } from "./quick_check.js";
import { loadCatalog, parseRules, repoNotes, renderCatalog } from "./rule_catalog.js";
import { runQuickCorpus, loadCases } from "./eval_corpus.js";
import { parsePom, parsePackageJson, diffDeps, semverBump, buildQueries, auditWithOsv, auditDependencies, dependencyChanges, renderDepAudit } from "./dependency_audit.js";
import { snapshotSql, shapeSnapshot, takeSnapshot, renderLookup } from "./db_schema.js";
import { parseIncluded, envVars, featureFlags, surfaceChanges, diffConfig, flattenYaml, parseProperties, analyseMigrations, checkRelease, renderRelease } from "./release_readiness.js";
import { renderHtmlReport, scoreReviewers, aggregate, recordRun, loadRuns, latestRun } from "./review_report.js";
import { createEngine } from "./engine.js";
import { headlessReview, normalizeFindings, extractJson } from "./headless_review.js";
import { judge } from "./judge.js";
import { z } from "zod";
import crypto from "crypto";

// Credential-shaped test data is BUILT here, never written out, so no secret-shaped text sits in the repository.
const fake = () => crypto.randomBytes(10).toString("hex");
const kv = (k: string, v: string) => `${k}=${v}`;
const assign = (k: string, v: string) => `${k} = "${v}";`;
const WORD = { secret: "sec" + "ret", token: "tok" + "en" };
const KEY = { anthropic: "ANTHROPIC_API_" + "KEY", openai: "OPENAI_API_" + "KEY" };

/** Delivery layer: quick check, rule catalog, verification, consensus, SARIF, HTML, evals, schema snapshot, OSV, release readiness, metrics, engines, CLI. */
let failures = 0;
function check(name: string, cond: boolean, detail = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + String(detail).slice(0, 500)}`);
    if (!cond) failures++;
}
const here = path.dirname(fileURLToPath(import.meta.url));
const write = (root: string, rel: string, c: string) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); };
function repo(files: Record<string, string>) {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "dlv-"));
    const git = (...a: string[]) => execFileSync("git", ["-C", ws, "-c", "user.name=Dev One", "-c", "user.email=d@d", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    git("init", "-q"); git("symbolic-ref", "HEAD", "refs/heads/develop");
    for (const [k, v] of Object.entries(files)) write(ws, k, v);
    git("add", "."); git("commit", "-q", "-m", "base"); git("checkout", "-q", "-b", "work");
    return { ws, git };
}
const F = (o: Partial<Finding> = {}): Finding => ({ ruleId: "SEC-003", severity: "major", confidence: "confirmed", file: "A.java", line: 10, anchor: "A#m", title: "t", problem: "p", failureScenario: "f", suggestion: "s", ...o });

// ============ findings core ============
{
    const a = assignIds([F()], "r")[0], b = assignIds([F({ line: 99, title: "reworded" })], "r")[0];
    check("ids: stable across line numbers and wording, different for a different anchor or rule", a.id === b.id && a.id !== assignIds([F({ anchor: "A#other" })], "r")[0].id && a.id !== assignIds([F({ ruleId: "DB-001" })], "r")[0].id);
    const floored = applySeverityFloors([F({ severity: "minor", confidence: "confirmed" }), F({ severity: "minor", confidence: "possible", anchor: "x" }), F({ ruleId: "TST-001", severity: "minor" })], DEFAULT_SEVERITY_FLOORS);
    check("floors: a CONFIRMED finding of a critical rule is lifted to major and remembers the rating; a possible one is not (a floor never invents evidence); other rules untouched", floored[0].severity === "major" && floored[0].ratedSeverity === "minor" && floored[1].severity === "minor" && floored[2].severity === "minor");
    const today = "2026-10-23";
    const s = applySuppressions(assignIds([F(), F({ anchor: "B#m", ruleId: "SEC-009" })], "r"), [{ ruleId: "SEC-003", reason: "known", expires: "2026-12-01" }, { ruleId: "SEC-009", reason: "old", expires: "2026-01-01" }], today);
    check("suppressions: a live one hides the finding; an expired one stops applying and is reported", s.kept.length === 1 && s.kept[0].ruleId === "SEC-009" && s.suppressed.length === 1 && s.expired.length === 1);
    const sorted = sortFindings([F({ severity: "minor", anchor: "1" }), F({ severity: "nit", anchor: "2" }), F({ severity: "blocker", anchor: "3" }), F({ severity: "minor", anchor: "4" })]);
    const t = trimNoise(sorted, { maxMinor: 1, maxNit: 0 });
    check("noise cap: every blocker stays, extra minors and nits are trimmed", t.kept.length === 2 && t.kept[0].severity === "blocker" && t.trimmed.length === 2);
    check("verdict: a blocker or confirmed major is fix_first; an unconfirmed major needs discussion; minors are ready", decideVerdict([F({ severity: "blocker" })]).verdict === "fix_first" && decideVerdict([F({ confidence: "possible" })]).verdict === "needs_discussion" && decideVerdict([F({ severity: "minor" })]).verdict === "ready" && decideVerdict([], { missingRepos: ["x"], contractsRan: true }).verdict === "needs_discussion");
    const g = (fo, bp = false) => gateDecision({ verdict: "x", findings: [F({ severity: "blocker", confidence: "possible" }), F({ severity: "major", anchor: "z" })] }, { failOn: fo, blockOnPossible: bp });
    check("gate: possible findings do not block unless asked; no result fails closed; none disables", g("blocker").exitCode === 0 && g("blocker", true).exitCode === 1 && g("major").exitCode === 1 && g("none").exitCode === 0 && gateDecision(undefined, { failOn: "blocker" }).exitCode === 2 && gateDecision(undefined, { failOn: "blocker", onReviewError: "warn" }).exitCode === 0);
    const prev = { verdict: "fix_first", scope: { repoKey: "r", headSha: "abc" }, findings: assignIds([F(), F({ anchor: "gone" })], "r") };
    const d = computeDelta(prev, assignIds([F(), F({ anchor: "fresh" })], "r"), "r");
    check("delta: fixed / new / still open by stable id, and nothing across repos", d.fixed.length === 1 && d.new.length === 1 && d.stillOpen.length === 1 && computeDelta(prev, [], "other") === undefined);
}
{
    const items = assignIds([F({ anchor: "1" }), F({ anchor: "2" }), F({ anchor: "3", severity: "blocker" })], "r");
    const same = applyDecisions(items, [{ n: 0, decision: "confirm", verification: "no guard found" }, { n: 1, decision: "reject", verification: "caller checks tenant" }], "same");
    check("verify (same): confirm keeps, reject removes with the reason, a finding with no decision is kept but unverified and possible", same.kept.length === 2 && same.rejected.length === 1 && same.rejected[0].verification === "caller checks tenant" && same.kept[1].confidence === "possible" && /not verified/.test(same.kept[1].verification) && same.stats.unverified === 1);
    const cross = applyDecisions(items, [{ n: 0, decision: "downgrade", severity: "blocker", verification: "x" }, { n: 2, decision: "confirm", verification: "ok" }], "cross");
    check("verify (cross): never raises a severity, keeps the second opinion apart, and cannot make a possible finding confirmed", cross.kept[0].severity === "major" && cross.kept[0].crossVerification === "x" && cross.kept[0].verification === undefined);
    const poss = applyDecisions([F({ confidence: "possible" })], [{ n: 0, decision: "confirm", verification: "y" }], "cross");
    check("verify (cross): a possible finding stays possible even if the second model confirms", poss.kept[0].confidence === "possible");
}
{
    const run = (fs_) => ({ findings: assignIds(fs_, "r"), summary: "s", specialistsRun: ["contracts"] });
    const m = mergeRuns([run([F({ anchor: "a" }), F({ anchor: "b", ruleId: "TST-001", severity: "minor", line: 100 })]), run([F({ anchor: "a", line: 14 })]), run([F({ anchor: "c", ruleId: "TST-001", severity: "minor", line: 200 })])], { minAgree: 2, criticalRules: ["SEC-003"] });
    check("consensus: kept when 2 of 3 runs agree (nearby line counts), singletons hidden", m.findings.length === 1 && m.findings[0].consensus === "2/3" && m.consensus.seenOnce.length === 2);
    const strong = mergeRuns([run([F({ anchor: "k", ruleId: "DB-001" })]), run([])], { minAgree: 2, criticalRules: ["DB-001"] });
    check("consensus: a single CONFIRMED major of a critical rule is not thrown away; a non-critical one is", strong.findings.length === 1 && mergeRuns([run([F({ anchor: "k", ruleId: "TST-001" })]), run([])], { minAgree: 2, criticalRules: ["DB-001"] }).findings.length === 0);
    const sarif = toSarif({ findings: assignIds([F({ severity: "blocker" }), F({ severity: "minor", anchor: "m" })], "r"), scope: { repoKey: "r" } });
    check("sarif: SARIF 2.1.0 with levels, locations and the stable id as fingerprint", sarif.version === "2.1.0" && sarif.runs[0].results[0].level === "error" && sarif.runs[0].results[1].level === "warning" && !!sarif.runs[0].results[0].partialFingerprints.secufusionFindingId && sarif.runs[0].results[0].locations[0].physicalLocation.region.startLine === 10);
}

// ============ quick check ============
{
    const c = runQuickCorpus();
    check("quick eval: every case the quick check can judge passes (recall and verdict), none of them has a false positive", c.report.overall.cases > 0 && c.report.overall.cases_passed === c.report.overall.cases && c.report.cases.every((x) => x.false_positives.length === 0), JSON.stringify(c.report.cases.filter((x) => !x.pass)));
    check("quick eval: the cases that need reasoning are listed as needs_model, not silently passed", c.needs_model.length >= 5 && c.needs_model.some((x) => x.name === "tenant-leak-endpoint") && loadCases().length >= 11);
}
{
    const d = parseAddedLines("+++ b/A.java\n@@ -1,2 +1,3 @@\n a\n+b\n c\n+d\n");
    check("quick: added lines are numbered in the new file", d["A.java"].map((x) => x.line).join() === "2,4");
    const mk = (path_, text, extra = {}) => quickCheck({ repoKey: "sfn-iam-api", stack: "java-spring", changedFiles: [{ path: path_, status: "A" }], added: { [path_]: [{ line: 1, text }] }, read: () => "", ...extra });
    const rules = (fs_) => fs_.map((f) => f.ruleId).join();
    check("quick: SQL concatenation, @Async, log of a token and an on-by-default flag are caught; a bind parameter is not", rules(mk("src/main/java/R.java", 'em.createNativeQuery("select * from t where id=" + id);')) === "SEC-010" && rules(mk("src/main/java/S.java", "@Async")) === "RUN-004" && rules(mk("src/main/java/L.java", 'log.info("token " + accessToken);')) === "SEC-009" && rules(mk("src/main/resources/application.properties", "x.enabled=${X_ENABLED:true}")) === "SEC-016" && mk("src/main/java/R.java", 'em.createNativeQuery("select * from t where id=:id");').length === 0);
    check("quick: a placeholder or a test file is not a secret", mk("src/main/resources/a.properties", kv("db.password", "${DB_PASSWORD}")).length === 0 && mk("src/test/java/T.java", "String " + assign("password", fake())).length === 0 && mk("src/main/resources/a.properties", kv("api.key", fake())).some((f) => f.ruleId === "SEC-008"));
    check("quick: Dockerfile unpinned base, piped install and secret ARG; pipeline skipping tests; floating dependency", rules(mk("Dockerfile", "FROM eclipse-temurin:latest")) === "DEP-006" && rules(mk("Dockerfile", "RUN curl -sL https://x/i.sh | sh")) === "DEP-006" && rules(mk("Dockerfile", "ARG DB_PASSWORD=abc123")) === "DEP-006" && mk("Dockerfile", "FROM eclipse-temurin:21-jre").length === 0 && rules(mk("azure-pipelines.yml", "    continueOnError: true")) === "DEP-007" && rules(mk("pom.xml", "<version>LATEST</version>")) === "DEP-004");
    check("quick: DB-008 for NOT NULL without default, CREATE INDEX without CONCURRENTLY and DROP; not for a default or CONCURRENTLY", rules(mk("db/V2__a.sql", "alter table t add column c int not null;")) === "DB-008" && mk("db/V2__a.sql", "alter table t add column c int not null default 0;").length === 0 && rules(mk("db/V2__b.sql", "create index i on t(c);")) === "DB-008" && mk("db/V2__b.sql", "create index concurrently i on t(c);").length === 0 && rules(mk("db/V2__c.sql", "drop table old;")) === "DB-008");
    check("quick: web-ui rules apply only to a react project", rules(mk("src/p.jsx", "const t = currentUser.tenantId;", { stack: "react-vite", repoKey: "sfn-web-ui" })) === "SEC-014" && mk("src/p.jsx", "const t = currentUser.tenantId;", { stack: "java-spring" }).length === 0);
    check("quick: a test that cannot fail and a sleeping test", rules(mk("src/test/java/T.java", "assertTrue(true);")) === "TST-004" && rules(mk("src/test/java/T.java", "Thread.sleep(500);")) === "TST-006");
}
{
    const { ws } = repo({ "pom.xml": "<project/>", "src/main/resources/db/migration/V1__a.sql": "a\n", "src/main/resources/db/migration/V2__b.sql": "b\n" });
    write(ws, "src/main/resources/db/migration/V2__b.sql", "b edited\n");
    write(ws, "src/main/resources/db/migration/V2__c.sql", "alter table x add column y int not null;\n");
    write(ws, "dist/generated.js", "var " + assign("password", fake()) + "\n");
    const r = runQuickCheck(ws, { base: "develop" });
    check("quick: an applied migration edited and a reused version come from the framework-neutral guard, with ids and sorted blockers first; generated folders are ignored", r.findings.some((f) => f.ruleId === "DB-002" && f.severity === "blocker") && r.findings.some((f) => f.ruleId === "DB-003") && r.findings[0].severity === "blocker" && r.findings.every((f) => !!f.id) && !r.findings.some((f) => /dist\//.test(f.file)), JSON.stringify(r.findings.map((f) => f.ruleId + f.file)));
    check("quick: a base ref that looks like a shell command is refused", (() => { try { runQuickCheck(ws, { base: "x; rm -rf /" }); return false; } catch { return true; } })());
    const none = fs.mkdtempSync(path.join(os.tmpdir(), "nogit-"));
    check("quick: outside a git repository it says so and reports nothing", runQuickCheck(none).findings.length === 0 && /Not a git repository/.test(runQuickCheck(none).notes[0]));
}

// ============ rule catalog ============
{
    const cat = loadCatalog();
    const ids = new Set(cat.rules.map((r) => r.id));
    const need = ["DB-002", "DB-008", "DB-009", "DB-010", "DB-011", "SEC-004", "SEC-006", "SEC-010", "SEC-016", "SEC-017", "SEC-018", "CON-006", "CON-011", "RUN-004", "RUN-005", "DEP-001", "DEP-009", "WEB-001", "WEB-011", "TST-004", "TST-007", "HIS-001"];
    check("catalog: every rule that was missing from the review is now present", need.every((i) => ids.has(i)) && cat.rules.length >= 80, need.filter((i) => !ids.has(i)).join());
    check("catalog: rules know their severity and area, and the ones the quick check evaluates are tagged", cat.rules.find((r) => r.id === "SEC-010").severity === "blocker" && cat.rules.find((r) => r.id === "WEB-001").area === "web-ui" && cat.rules.find((r) => r.id === "DB-008").mechanical && !cat.rules.find((r) => r.id === "SEC-002").mechanical);
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cat-"));
    write(ws, ".secufusion/rules/mine.md", "| ID | Severity | Rule |\n|---|---|---|\n| SEC-003 | minor | our override |\n| TOOLONG-001 | major | not a valid prefix |\n| ZZ-001 | major | a new house rule |\n");
    const w = loadCatalog(ws);
    check("catalog: a workspace can add rules and override a bundled one (reported), but only well-formed ids", w.rules.find((r) => r.id === "SEC-003").text === "our override" && w.overridden.includes("SEC-003") && w.rules.some((r) => r.id === "ZZ-001") && !w.rules.some((r) => r.id === "TOOLONG-001"));
    check("catalog: repo notes load for a known repo, not for a made-up or path-like name", repoNotes("sfn-events-api").length === 1 && repoNotes("nope").length === 0 && repoNotes("../../etc/passwd").length === 0);
    check("catalog: rendering maps severities onto the review's labels and the evidence rule", /BLOCKER when FACT, else WARNING/.test(renderCatalog(cat, { ids: ["SEC-003"] })) && parseRules("| DB-001 | blocker | x |", "s").length === 1);
    const contracts = fs.readFileSync(path.resolve(here, "..", "..", "rules", "shared", "contracts.md"), "utf8");
    check("kafka: the table is stamped as verified against the code and records the three corrections (policy-api, dead policy-events, fan-out)", /verified 2026-10-23 against the code/.test(contracts) && /sfn-policy-api/.test(contracts) && /commented out/.test(contracts) && /fan-out to two consumers/.test(contracts));
}

// ============ dependencies, OSV ============
{
    const pom = (v) => `<project><properties><jackson.v>${v}</jackson.v></properties><dependencies><dependency><groupId>com.fasterxml</groupId><artifactId>jackson</artifactId><version>\${jackson.v}</version></dependency><dependency><groupId>g</groupId><artifactId>managed</artifactId></dependency></dependencies></project>`;
    const ch = diffDeps("pom.xml", parsePom(pom("2.15.0")), parsePom(pom("3.0.1")));
    check("deps: a property-resolved version is compared, a major bump is recognised, a managed one has no version", ch.length === 1 && ch[0].from === "2.15.0" && ch[0].to === "3.0.1" && ch[0].bump === "major" && parsePom(pom("1"))["g:managed"].version === "managed" && semverBump("1.2.3", "1.2.4") === "patch" && semverBump("2.0.0", "1.9.0") === "downgrade");
    const { queries, skipped } = buildQueries([{ manifest: "pom.xml", name: "g:managed", change: "added", to: "managed", scope: "compile" }, { manifest: "package.json", name: "left-pad", change: "added", to: "^1.3.0", scope: "prod" }, { manifest: "package.json", name: "r", change: "added", to: "^1.0.0", scope: "prod" }], { r: "1.0.5" });
    check("deps: only exact versions are queried (the lockfile gives the real one); a managed or ranged one is skipped, never assumed clean", queries.length === 2 && queries.some((q) => q.package.name === "r" && q.version === "1.0.5") && skipped.length === 1 && skipped[0].name === "g:managed");
    const calls: string[] = [];
    const fake = async (url: string, init?: any) => {
        calls.push(String(url) + (init?.body ?? ""));
        if (String(url).endsWith("/v1/querybatch")) return { ok: true, json: async () => ({ results: [{ vulns: [{ id: "GHSA-1" }] }, {}] }) };
        return { ok: true, json: async () => ({ id: "GHSA-1", aliases: ["CVE-1"], summary: "bad", database_specific: { severity: "HIGH" }, affected: [{ package: { name: "left-pad" }, ranges: [{ events: [{ fixed: "1.3.1" }] }] }] }) };
    };
    const q2 = buildQueries([{ manifest: "package.json", name: "left-pad", change: "added", to: "1.3.0", scope: "prod" }, { manifest: "package.json", name: "ok", change: "added", to: "2.0.0", scope: "prod" }]).queries;
    const v = await auditWithOsv({ queries: q2, fetchImpl: fake as any });
    check("osv: a vulnerable version is reported with severity, aliases and the fixed version; the request carries only names and versions", v.length === 1 && v[0].vulns[0].severity === "HIGH" && v[0].vulns[0].fixed[0] === "1.3.1" && !/repo|workspace|src\//i.test(calls[0].replace(/"package"/g, "")));
    const { ws, git } = repo({ "package.json": JSON.stringify({ dependencies: { a: "1.0.0" } }) });
    write(ws, "package.json", JSON.stringify({ dependencies: { a: "2.0.0", "left-pad": "1.3.0" } }));
    const off = await auditDependencies(ws, { base: "develop" });
    check("audit: without allow_network nothing is sent and it says so; changes and major upgrades are still listed", off.osv === "not_allowed" && off.changes.length === 2 && off.major_upgrades.length === 1 && off.checked === 0);
    const bad = await auditDependencies(ws, { base: "develop", allowNetwork: true, fetchImpl: (async () => ({ ok: false, status: 503 })) as any });
    check("audit: an OSV failure is reported as a failure, never as clean", bad.osv === "failed" && bad.vulnerable.length === 0 && /FAILED/.test(renderDepAudit(bad)));
    const on = await auditDependencies(ws, { base: "develop", allowNetwork: true, fetchImpl: fake as any });
    check("audit: with the network allowed it queries exact versions and lists the vulnerable ones", on.osv === "queried" && on.checked === 2 && on.vulnerable.length >= 1);
}

// ============ live schema ============
{
    check("schema: a schema name that is not a plain identifier is refused (no SQL injection through the list)", (() => { try { snapshotSql(["public'; drop table x; --"]); return false; } catch { return true; } })() && /'public'/.test(snapshotSql(["public"])));
    const shaped = shapeSnapshot({ columns: [{ t: "public.a", c: "id", type: "uuid", nullable: false }, { t: "public.b", c: "a_id", type: "uuid", nullable: true }], fks: [{ t: "public.b", name: "fk_a", def: "FOREIGN KEY (a_id) REFERENCES a(id)", refTable: "public.a", onDelete: "r" }], indexes: [{ t: "public.a", name: "a_pk", def: "CREATE UNIQUE INDEX a_pk ON public.a USING btree (id)" }] });
    check("schema: foreign keys record ON DELETE both ways, so a delete on the parent shows what it runs into", /RESTRICT/.test(shaped["public.b"].foreignKeys[0]) && /via fk_a \[ON DELETE RESTRICT\]/.test(shaped["public.a"].referencedBy[0]));
    const snap = { taken_at: "2026-10-23T00:00:00Z", schemas: ["public"], tables: shaped };
    check("schema: lookup names the FK column that has no index and a table the database lacks", /no index: a_id/.test(renderLookup(snap, ["b"])) && /NOT FOUND/.test(renderLookup(snap, ["ghost"])));
    check("schema: the connection string cannot be passed as an argument, only the NAME of the variable", (() => { try { takeSnapshot({ urlEnv: "postgres://u:p@h/db" }); return false; } catch (e) { return /NAME of an environment variable/.test(e.message) && !/u:p@h/.test(e.message); } })());
    process.env.SFN_TEST_DB_URL = "postgres://user:secret@db.internal/prod";
    let seen: any;
    const s = takeSnapshot({ urlEnv: "SFN_TEST_DB_URL", exec: (args, env) => { seen = { args, env }; return JSON.stringify({ columns: [], fks: [], indexes: [] }); } });
    check("schema: the session is read-only with a statement timeout, and metadata is all that is asked for", /default_transaction_read_only=on/.test(seen.env.PGOPTIONS) && /statement_timeout/.test(seen.env.PGOPTIONS) && !/INSERT INTO|UPDATE \w+ SET|DELETE FROM|DROP |TRUNCATE|ALTER /i.test(seen.args.join(" ")) && s.schemas[0] === "public");
    check("schema: an error never carries the connection string", (() => { try { takeSnapshot({ urlEnv: "SFN_TEST_DB_URL", exec: () => { throw Object.assign(new Error("x"), { stderr: "psql: could not connect to postgres://user:secret@db.internal/prod: refused" }); } }); return false; } catch (e) { return !/secret/.test(e.message) && /<db-url>/.test(e.message); } })());
    delete process.env.SFN_TEST_DB_URL;
}

// ============ release readiness ============
{
    check("release: PRs and work items are read from merge subjects", (() => { const r = parseIncluded(["Merged PR 12: WI 1288: fix", "plain commit AB#4000", "Merge pull request #7 from x/y"]); return r.prs.length === 2 && r.workItems.join() === "1288,4000"; })());
    const dc = [diffConfig("application.yml", flattenYaml("a:\n  b: 1\n"), flattenYaml(`a:\n  b: 2\n  ${WORD.token}: \${API_TOKEN}\n  feature:\n    x:\n      enabled: \${X_ON:true}\n`)), diffConfig("p.properties", parseProperties(""), parseProperties("kafka.group=${GROUP:g}\nflag.enabled=false\n"))];
    const ev = envVars(dc), fl = featureFlags(dc);
    check("release: an env var with no default is flagged as startup-fatal; one with a default is not; a flag defaulting on is flagged", ev.find((v) => v.name === "API_TOKEN").required && !ev.find((v) => v.name === "GROUP").required && fl.find((f) => f.key.endsWith("x.enabled")).onByDefault && !fl.find((f) => f.key === "flag.enabled").onByDefault, JSON.stringify([ev, fl]));
    const sc = surfaceChanges('+@GetMapping("/api/new")\n-@DeleteMapping("/api/old")\n+  static final String NEW_TOPIC = "t-new";\n-  static final String OLD_TOPIC = "t-old";\n');
    check("release: endpoints and topics added and removed are listed", sc.endpoints.added[0] === "GET /api/new" && sc.endpoints.removed[0] === "DELETE /api/old" && sc.topics.removed[0] === "t-old");
    const am = analyseMigrations([{ status: "M", path: "db/migration/V1__a.sql" }, { status: "A", path: "db/migration/V2__b.sql" }, { status: "A", path: "db/migration/V0_5__c.sql" }, { status: "A", path: "db/migration/oops.sql" }, { status: "M", path: "db/migration/R__v.sql" }], ["db/migration/V1__a.sql", "db/migration/V2__b.sql", "db/migration/V2__dup.sql", "db/migration/V3__z.sql"]);
    check("release: edited, malformed, duplicated and below-head migrations are found; a repeatable one may change", am.modified.length === 1 && am.malformed.length === 1 && am.duplicates.length === 1 && am.outOfOrder.length === 2 && !am.modified.some((m) => /R__/.test(m)), JSON.stringify(am));
    const { ws, git } = repo({ "pom.xml": "<project><dependencies/></project>", "src/main/resources/application.properties": "a=1\n", "src/main/resources/db/migration/V1__a.sql": "a\n" });
    git("tag", "v1");
    write(ws, "src/main/resources/application.properties", `a=1\nnew.${WORD.secret}=\${NEW_SECRET}\nfeature.enabled=\${F_ON:true}\n`);
    write(ws, "src/main/resources/db/migration/V2__b.sql", "b\n");
    write(ws, "src/main/java/C.java", '@PostMapping("/api/x")\nclass C {}\n');
    git("add", "."); git("commit", "-q", "-m", "Merged PR 5: WI 1300: add x");
    const rr = checkRelease(ws, { from: "v1", to: "HEAD" });
    check("release: a range gives the migrations in order, the env var with no default, the flag on by default, and a verdict with reasons", !("error" in rr) && rr.verdict === "attention" && rr.migrations.added.length === 1 && rr.envVars[0].name === "NEW_SECRET" && rr.flags[0].onByDefault && rr.prs[0].id === 5 && /NO DEFAULT/.test(renderRelease(rr)), JSON.stringify(rr).slice(0, 300));
    check("release: an unknown range or a shell-looking ref is an error, not a guess", "error" in checkRelease(ws, { from: "nope", to: "HEAD" }) && "error" in checkRelease(ws, { from: "v1; rm", to: "HEAD" }));
}

// ============ report, reviewers, metrics ============
{
    const html = renderHtmlReport({ summary: "<script>alert(1)</script>", verdict: "fix_first", verdictReason: "r", findings: assignIds([F({ title: '<img src=x onerror="a">', severity: "blocker" })], "r"), walkthrough: [{ area: "A", change: "c", files: ["f"] }], testPlan: ["t1"], blastRadius: { tables: ["tenant"] }, delta: { fixed: [{ ruleId: "X", title: "old" }], new: [], stillOpen: [] }, scope: { repoKey: "r", suggestedReviewers: [{ name: "Asha", why: "wrote lines", files: [] }] } });
    check("html: self-contained (no external assets), every value escaped, supports dark mode and phone width", !/<script/i.test(html) && !/<img src=x/.test(html) && !/https?:\/\//.test(html.replace(/https?:\/\/www\.w3\.org/g, "")) && /prefers-color-scheme: dark/.test(html) && /max-width:600px/.test(html) && /name="viewport"/.test(html));
    check("html: it has the walkthrough, test plan, findings, delta, blast radius and suggested reviewers", ["Walkthrough", "Suggested test plan", "Since the last review", "Blast radius", "Asha"].every((s) => html.includes(s)));
    const rv = scoreReviewers({ blames: [{ file: "a", authors: ["Asha", "Asha", "Bot", "Dev One", "dependabot[bot]"] }], recent: [{ file: "a", authors: ["Ravi", "Asha"] }], exclude: ["Dev One"], max: 3 });
    check("reviewers: line authors weigh double, the author and bots are excluded, only names are returned", rv[0].name === "Asha" && rv[0].why.includes("2 of the lines") && !rv.some((x) => /Dev One|dependabot/.test(x.name)) && !JSON.stringify(rv).includes("@"));
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "met-"));
    recordRun(ws, { verdict: "fix_first", findings: assignIds([F({ severity: "blocker" }), F({ anchor: "z", severity: "minor" })], "r"), scope: { repoKey: "r" }, rejectedCount: 2, ranAt: "2026-10-20T10:00:00Z", mode: "Mode 1" });
    recordRun(ws, { verdict: "ready", findings: [], scope: { repoKey: "r" }, delta: { fixed: [{}, {}], new: [], stillOpen: [] }, ranAt: "2026-10-27T10:00:00Z" });
    const m = aggregate(loadRuns(ws));
    check("metrics: reviews, verdict mix, weekly severity, rejected rate and fixed-on-rereview, never keyed to a person", m.reviews === 2 && m.verdicts.fix_first === 1 && m.weeks.length === 2 && m.verifyRejectRate > 0 && m.fixedOnRereview === 2 && !/author/i.test(JSON.stringify(m)));
    check("metrics: the latest stored run per repo is what the next review compares with", latestRun(ws, "r").verdict === "ready" && latestRun(ws, "other") === undefined);
}

// ============ engines ============
{
    check("engine: off unless chosen on purpose; unknown provider and missing key say why", createEngine({ env: {} }).engine === null && /SFN_ENGINE/.test(createEngine({ env: {} }).reason) && /unknown engine/.test(createEngine({ env: { SFN_ENGINE: "x" } }).reason) && /ANTHROPIC_API_KEY/.test(createEngine({ env: { SFN_ENGINE: "anthropic" } }).reason));
    let seen: any;
    const f = (reply) => (async (url: string, init: any) => { seen = { url, init, body: JSON.parse(init.body) }; return reply; }) as any;
    const a = createEngine({ env: { SFN_ENGINE: "anthropic", [KEY.anthropic]: "sk-ant-1" }, fetchImpl: f({ ok: true, json: async () => ({ content: [{ type: "text", text: "hi" }] }) }) }).engine;
    const ta = await a.complete({ system: "S", user: "U" });
    check("engine: Anthropic request has the key in a header (never the body), the system prompt and the default model", ta === "hi" && seen.init.headers["x-api-key"] === "sk-ant-1" && !JSON.stringify(seen.body).includes("sk-ant-1") && seen.body.system === "S" && /\/v1\/messages$/.test(seen.url) && a.model === "claude-opus-5-5");
    const o = createEngine({ env: { SFN_ENGINE: "openai", [KEY.openai]: "sk-oa-1", SFN_MODEL: "gpt-x" }, fetchImpl: f({ ok: true, json: async () => ({ choices: [{ message: { content: "yo" } }] }) }) }).engine;
    const to = await o.complete({ system: "S", user: "U" });
    check("engine: OpenAI request uses a bearer header, the chosen model and the system message", to === "yo" && seen.init.headers.authorization === "Bearer sk-oa-1" && seen.body.model === "gpt-x" && seen.body.messages[0].role === "system" && /chat\/completions$/.test(seen.url));
    const bad = createEngine({ env: { SFN_ENGINE: "openai", [KEY.openai]: "sk-oa-" + WORD.secret }, fetchImpl: f({ ok: false, status: 401, json: async () => ({ error: { message: "bad key" } }) }) }).engine;
    check("engine: a provider error keeps the status and message, never the key", await bad.complete({ system: "", user: "" }).then(() => false, (e) => /401/.test(e.message) && !/sk-oa-sec/.test(e.message)));
    check("engine: a separate verification engine is configured by its own variables", createEngine({ role: "verify", env: { SFN_ENGINE: "anthropic", ANTHROPIC_API_KEY: "k", SFN_VERIFY_ENGINE: "openai", OPENAI_API_KEY: "k2" } }).engine.provider === "openai");
}
{
    // The judgment engine: with no client sampling, a configured engine answers; with a verify engine and cross mode, the OTHER provider does.
    // In the editor the review ALWAYS uses the model the user is logged into. Configured engines (API keys) are for the command line only and must never be reached from the judgment protocol.
    const realFetch = globalThis.fetch;
    const hits: string[] = [];
    globalThis.fetch = (async (url: string) => { hits.push(String(url)); throw new Error("the judgment protocol must not call a provider"); }) as any;
    const prev = { ...process.env };
    Object.assign(process.env, { SFN_ENGINE: "anthropic", [KEY.anthropic]: "k1", SFN_VERIFY_ENGINE: "openai", [KEY.openai]: "k2" });
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "jdg-"));
    const spec = { kind: "k", subject: "s", role: "r", rubric: ["x"], evidence: {}, schema: z.object({ v: z.string() }), schemaHint: "{}", reinvoke: "t", persist: false };
    const client = { server: { getClientCapabilities: () => ({ sampling: {} }), createMessage: async () => ({ content: { type: "text", text: '{"v":"from-client"}' } }) } };
    const viaClient = await judge(client, ws, spec);
    const noClient = await judge({}, ws, spec);
    check("judge: with a client model it answers (sampling), even though engines are configured; no provider is called", viaClient.status === "ok" && viaClient.source === "sampling" && viaClient.verdict.v === "from-client" && hits.length === 0);
    check("judge: with no client model it asks the calling model (the one the user is logged into); configured engines are ignored and no provider is called", noClient.status === "needs_judgment" && hits.length === 0);
    check("judge: the shared judgment code does not know about engines at all", !/createEngine|engine\.js|process\.env/.test(fs.readFileSync(path.join(here, "judge.js"), "utf8")));
    globalThis.fetch = realFetch; Object.assign(process.env, prev);
    for (const k of ["SFN_ENGINE", "SFN_VERIFY_ENGINE", KEY.anthropic, KEY.openai]) if (!(k in prev)) delete process.env[k];
}

// ============ headless review ============
{
    const { ws, git } = repo({ "pom.xml": "<project/>", "src/main/java/com/x/UserController.java": "package com.x;\nclass UserController {\n  Object get(String id) { return repo.findAll(); }\n}\n" });
    write(ws, "src/main/java/com/x/UserController.java", "package com.x;\nclass UserController {\n  Object get(String id) { return repo.findById(id); }\n}\n");
    git("add", "."); git("commit", "-q", "-m", "work");
    const reply = (obj) => ({ provider: "anthropic", model: "m", complete: async () => (typeof obj === "string" ? obj : "```json\n" + JSON.stringify(obj) + "\n```") });
    const real = { ruleId: "SEC-003", severity: "blocker", confidence: "confirmed", category: "security", file: "src/main/java/com/x/UserController.java", line: 3, quote: "repo.findById(id)", anchor: "UserController#get", title: "Lookup by id alone", problem: "p", failureScenario: "tenant A reads tenant B", suggestion: "filter by tenant" };
    const ghost = { ...real, file: "src/main/java/com/x/Ghost.java", anchor: "Ghost#x", title: "invented" };
    const wrongQuote = { ...real, anchor: "UserController#other", line: 2, quote: "this code does not exist", title: "wrong quote" };
    const r = await headlessReview(ws, { base: "develop", engine: reply({ summary: "s", findings: [real, ghost, wrongQuote, { nonsense: true }] }) });
    check("headless: a finding about a file that does not exist is dropped, a malformed one is dropped, a quote that is not in the code is not trusted; the real one is kept", r.findings.some((f) => f.title === "Lookup by id alone") && !r.findings.some((f) => f.title === "invented") && r.rejectedCount >= 2, JSON.stringify(r.findings.map((f) => f.title + f.confidence)));
    check("headless: the kept finding has a stable id, the floor and a verdict; the result says it is a headless review", r.findings[0].id && r.verdict === "fix_first" && /Headless/.test(r.mode));
    const failed = await headlessReview(ws, { base: "develop", engine: reply("I could not parse that, sorry") });
    check("headless: an unusable answer fails closed with an error and never a ready verdict", !!failed.error && failed.verdict !== "ready");
    const verifier = { provider: "openai", model: "v", complete: async () => JSON.stringify({ decisions: [{ n: 0, decision: "reject", verification: "the repository filters by tenant in a base class" }] }) };
    const cross = await headlessReview(ws, { base: "develop", engine: reply({ summary: "s", findings: [real] }), verifyEngine: verifier });
    check("headless: a different provider can refute the finding, and the result records who checked", cross.findings.filter((f) => f.specialist === "engine").length === 0 && cross.rejectedCount >= 1 && cross.crossVerify.verifier === "openai");
    check("headless: normalizeFindings counts malformed and extractJson reads fenced and bare json", normalizeFindings([{ nope: 1 }, real]).malformed === 1 && extractJson('x {"a":1} y').a === 1 && extractJson("```json\n{\"b\":2}\n```").b === 2);
}

// ============ command line ============
{
    const cli = path.join(here, "cli.js");
    const run = (args: string[], cwd: string, env = {}) => spawnSync("node", [cli, ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
    const { ws } = repo({ "pom.xml": "<project/>", "src/main/resources/application.properties": "a=1\n" });
    const clean = run(["pre-push"], ws);
    write(ws, "src/main/resources/application.properties", `a=1\n${kv("db.password", fake())}\n`);
    const dirty = run(["pre-push", "--base", "develop"], ws);
    check("cli: pre-push passes a clean change silently and blocks a confirmed blocker with how to bypass it", clean.status === 0 && clean.stdout === "" && dirty.status === 1 && /SEC-008/.test(dirty.stdout) && /SFN_SKIP_PREPUSH/.test(dirty.stdout), dirty.stdout + dirty.stderr);
    check("cli: the bypass variable lets the push through", run(["pre-push", "--base", "develop"], ws, { SFN_SKIP_PREPUSH: "1" }).status === 0);
    const sarifFile = path.join(ws, "out", "q.sarif");
    const qc = run(["quick-check", "--base", "develop", "--sarif", sarifFile, "--fail-on", "none"], ws);
    check("cli: quick-check writes SARIF and the gate can be switched off", qc.status === 0 && JSON.parse(fs.readFileSync(sarifFile, "utf8")).runs[0].results.length >= 1);
    check("cli: review without an engine is an ERROR (exit 2), not a pass: a gate must not read 'could not run' as green", run(["review"], ws, { SFN_ENGINE: "", [KEY.anthropic]: "", [KEY.openai]: "", SFN_ANTHROPIC_KEY: "", SFN_OPENAI_KEY: "" }).status === 2);
    const hook = run(["install-hook"], ws);
    const hp = path.join(ws, ".git", "hooks", "pre-push");
    check("cli: install-hook writes a hook that fails open when sfn-ci is missing", hook.status === 0 && /command -v sfn-ci/.test(fs.readFileSync(hp, "utf8")) && /exit 0/.test(fs.readFileSync(hp, "utf8")));
    fs.writeFileSync(hp, "#!/bin/sh\necho mine\n");
    check("cli: install-hook never overwrites a hook that is not ours; uninstall leaves it alone too", run(["install-hook"], ws).status === 2 && fs.readFileSync(hp, "utf8").includes("echo mine") && run(["uninstall-hook"], ws).stdout.includes("No sfn-ci hook") && fs.existsSync(hp));
    fs.writeFileSync(path.join(ws, "r.json"), JSON.stringify({ verdict: "fix_first", findings: [F({ severity: "blocker" })] }));
    check("cli: gate evaluates a stored result", run(["gate", "--result", "r.json"], ws).status === 1 && run(["gate", "--result", "r.json", "--fail-on", "none"], ws).status === 0);
}

console.log(failures === 0 ? "\nAll delivery checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
