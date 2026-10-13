import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { analyzeMergeRegressions, renderMergeReport, SEVERITY, extractSymbols, MergeReport } from "./merge_regression.js";

/** Merge regressions: functionality lost while a merge was resolved. Real git repositories, real merges, deliberately bad resolutions. */

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + detail}`);
    if (!cond) failures++;
}

const GIT = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", "-c", "commit.gpgsign=false"];
const g = (cwd: string, ...args: string[]) => execFileSync("git", [...GIT, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const write = (root: string, rel: string, content: string) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };
const read = (root: string, rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const edit = (root: string, rel: string, from: string, to: string) => { const t = read(root, rel); if (!t.includes(from)) throw new Error(`fixture: '${from}' not in ${rel}`); write(root, rel, t.replace(from, to)); };

const REPO = "src/main/java/com/x/EventRepository.java";
const CTRL = "src/main/java/com/x/EventController.java";
const TEST = "src/test/java/com/x/EventControllerTest.java";
const HELP = "src/main/java/com/x/Helpers.java";
const PROPS = "src/main/resources/application.properties";
const I18N = "src/main/resources/i18n/en.json";

const BASE_FILES: Record<string, string> = {
    [REPO]: `package com.x;

public interface EventRepository extends JpaRepository<Event, Long> {

    @Query("select e from Event e where e.id = :id and e.tenantId = :tenantId")
    Optional<Event> findSecure(@Param("id") Long id, @Param("tenantId") Long tenantId);

    List<Event> findByName(String name);

    int findAll(int page);

    void deleteOld();
}
`,
    [CTRL]: `package com.x;

@RestController
@RequestMapping("/api/events")
public class EventController {

    @GetMapping("/{id}")
    @PreAuthorize("hasAuthority('event.read')")
    @Operation(summary = "Get an event")
    public Event get(@PathVariable Long id) {
        if (!tenantContext.isCallerAncestorOrSelf(requester, id)) {
            throw new AccessDeniedException("no");
        }
        return service.find(id);
    }

    @PostMapping
    public Event create(@RequestBody Event e) {
        return service.save(e);
    }

    public int count() {
        return 1;
    }

    public int last() {
        return 9;
    }
}
`,
    [TEST]: `package com.x;

public class EventControllerTest {

    @Test
    void getWorks() {
    }

    @Test
    void createWorks() {
    }
}
`,
    [HELP]: `package com.x;

public class Helpers {

    public String helper(String s) {
        return s;
    }
}
`,
    [PROPS]: "server.port=8080\nfeature.retention.days=30\nfeature.keep=1\n",
    [I18N]: JSON.stringify({ a: { b: "x", c: "y" } }, null, 2) + "\n",
    "README.md": "# Events\n\n## Setup\n\ntext\n\n## Usage\n\ntext\n",
};

/** main -> feature (adds things) and develop (adds things, deliberately deletes deleteOld); returns the repo with HEAD on feature */
function fixture(): string {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), "mrg-"));
    g(r, "init", "-q", "-b", "main");
    for (const [f, c] of Object.entries(BASE_FILES)) write(r, f, c);
    g(r, "add", "-A"); g(r, "commit", "-q", "-m", "base");

    g(r, "checkout", "-q", "-b", "develop");
    edit(r, CTRL, "    public int last() {", "    @GetMapping(\"/stats\")\n    public Stats stats() {\n        return null;\n    }\n\n    public int developMethod() {\n        return 2;\n    }\n\n    public int last() {");
    edit(r, REPO, "\n    void deleteOld();\n", "");
    edit(r, I18N, '"c": "y"', '"c": "y",\n    "d": "z"');
    g(r, "add", "-A"); g(r, "commit", "-q", "-m", "develop work");

    g(r, "checkout", "-q", "main"); g(r, "checkout", "-q", "-b", "feature");
    edit(r, CTRL, "    public int count() {", "    public int featureMethod(int a) {\n        return a;\n    }\n\n    public int count() {");
    edit(r, PROPS, "feature.keep=1\n", "feature.keep=1\nfeature.new=1\n");
    edit(r, TEST, "    @Test\n    void createWorks() {\n    }\n", "    @Test\n    void createWorks() {\n    }\n\n    @Test\n    void featureTest() {\n    }\n");
    g(r, "add", "-A"); g(r, "commit", "-q", "-m", "feature work");
    return r;
}

/** the bad resolution: loses a lot, deliberately */
function badResolution(r: string) {
    edit(r, CTRL, "    @PreAuthorize(\"hasAuthority('event.read')\")\n", "");
    edit(r, CTRL, "    @Operation(summary = \"Get an event\")\n", "");
    edit(r, CTRL, "        if (!tenantContext.isCallerAncestorOrSelf(requester, id)) {\n            throw new AccessDeniedException(\"no\");\n        }\n", "");
    edit(r, CTRL, "    @GetMapping(\"/stats\")\n    public Stats stats() {\n        return null;\n    }\n\n", "");
    edit(r, CTRL, "    public int featureMethod(int a) {\n        return a;\n    }\n\n", "");
    edit(r, CTRL, "    public int count() {", "    public int count(int x) {");
    edit(r, REPO, "    List<Event> findByName(String name);\n\n", "");
    edit(r, REPO, " and e.tenantId = :tenantId", "");
    edit(r, REPO, "    int findAll(int page);", "    int findAll(int page, int size);");
    edit(r, TEST, "    @Test\n    void createWorks() {\n    }\n\n", "");
    edit(r, PROPS, "feature.retention.days=30\n", "");
    edit(r, I18N, '"c": "y",', "");
    edit(r, "README.md", "## Usage\n\ntext\n", "");
    // helper() moves to a new file: not a loss
    edit(r, HELP, "    public String helper(String s) {\n        return s;\n    }\n", "");
    write(r, "src/main/java/com/x/Util.java", "package com.x;\n\npublic class Util {\n\n    public String helper(String s) {\n        return s;\n    }\n}\n");
}

const has = (rep: MergeReport, kind: string, file: string, needle: string) => rep.findings.find((f) => f.kind === kind && f.file === file && f.display.includes(needle));

// ── the severity model is the one specified ────────────────────────────────
check("severity model: HIGH = security, authorization, endpoint, repository query; MEDIUM = methods, tests, config; LOW = translations, OpenAPI, docs",
    ["SECURITY_VALIDATION", "AUTHORIZATION_CHECK", "API_ENDPOINT", "REPOSITORY_QUERY", "QUERY_PREDICATE"].every((k) => SEVERITY[k as keyof typeof SEVERITY] === "HIGH")
    && ["METHOD", "TEST_CASE", "CONFIG_KEY", "PUBLIC_API_CHANGED"].every((k) => SEVERITY[k as keyof typeof SEVERITY] === "MEDIUM")
    && ["TRANSLATION_KEY", "OPENAPI_ANNOTATION", "DOCUMENTATION"].every((k) => SEVERITY[k as keyof typeof SEVERITY] === "LOW"));

// ── extraction ──────────────────────────────────────────────────────────────
{
    const s = extractSymbols(CTRL, BASE_FILES[CTRL]);
    const k = (kind: string) => s.filter((x) => x.kind === kind).map((x) => x.key);
    check("extractor: endpoint with class base path, authorization annotation, OpenAPI annotation, methods", k("API_ENDPOINT").includes("GET /api/events/{id}") && k("API_ENDPOINT").includes("POST /api/events") && k("AUTHORIZATION_CHECK").length === 1 && k("OPENAPI_ANNOTATION").length === 1 && k("METHOD").includes("count/0") && k("METHOD").includes("last/0"), JSON.stringify(s.map((x) => x.kind + ":" + x.key)));
    check("extractor: security-bearing lines are captured with their method", k("SECURITY_VALIDATION").length >= 2, JSON.stringify(k("SECURITY_VALIDATION")));
    const r = extractSymbols(REPO, BASE_FILES[REPO]);
    check("extractor: repository methods and query predicates (the tenant predicate among them)", r.some((x) => x.kind === "REPOSITORY_QUERY" && x.key === "findSecure/2") && r.some((x) => x.kind === "QUERY_PREDICATE" && /tenantid = :tenantid/.test(x.key)) && r.some((x) => x.kind === "REPOSITORY_QUERY" && x.key === "deleteOld/0"), JSON.stringify(r.map((x) => x.kind + ":" + x.key)));
    check("extractor: tests, config keys, translation keys, headings", extractSymbols(TEST, BASE_FILES[TEST]).filter((x) => x.kind === "TEST_CASE").length === 2 && extractSymbols(PROPS, BASE_FILES[PROPS]).filter((x) => x.kind === "CONFIG_KEY").length === 3 && extractSymbols(I18N, BASE_FILES[I18N]).map((x) => x.key).join() === "a.b,a.c" && extractSymbols("README.md", BASE_FILES["README.md"]).filter((x) => x.kind === "DOCUMENTATION").length === 3);
}

// ── a badly resolved merge ─────────────────────────────────────────────────
{
    const r = fixture();
    g(r, "merge", "--no-commit", "--no-ff", "develop");
    badResolution(r);
    g(r, "add", "-A"); g(r, "commit", "-q", "-m", "Merge develop into feature");
    const headBefore = g(r, "rev-parse", "HEAD"), statusBefore = g(r, "status", "--porcelain");
    const rep = analyzeMergeRegressions(r);

    check("the merge commit is found and examined, with both parents and the merge base", rep.merges.length === 1 && rep.merges[0].parents.length === 2 && !!rep.merges[0].base, JSON.stringify(rep.merges));
    check("HIGH: authorization annotation lost on get()", !!has(rep, "AUTHORIZATION_CHECK", CTRL, "PreAuthorize"), JSON.stringify(rep.findings.map((f) => f.kind + ":" + f.display)));
    check("HIGH: security validation lines lost (tenant ancestor check and access-denied)", !!has(rep, "SECURITY_VALIDATION", CTRL, "isCallerAncestorOrSelf") && !!has(rep, "SECURITY_VALIDATION", CTRL, "AccessDeniedException"));
    check("HIGH: the endpoint added on the develop side (GET /api/events/stats) is lost", !!has(rep, "API_ENDPOINT", CTRL, "/api/events/stats"));
    check("HIGH: the repository query's tenant predicate is lost", !!has(rep, "QUERY_PREDICATE", REPO, "tenantid = :tenantid"));
    check("HIGH: a repository method both parents kept is gone (findByName)", !!has(rep, "REPOSITORY_QUERY", REPO, "findByName"));
    check("MEDIUM: a method added on the feature side is lost (featureMethod)", !!has(rep, "METHOD", CTRL, "featureMethod"));
    check("MEDIUM: a public signature changed during the merge (count() became count(int))", !!has(rep, "PUBLIC_API_CHANGED", CTRL, "count"));
    check("MEDIUM: a test case, a config key", !!has(rep, "TEST_CASE", TEST, "createWorks") && !!has(rep, "CONFIG_KEY", PROPS, "feature.retention.days"));
    check("LOW: a translation key, an OpenAPI annotation, a documentation heading", !!has(rep, "TRANSLATION_KEY", I18N, "a.c") && !!has(rep, "OPENAPI_ANNOTATION", CTRL, "Operation") && !!has(rep, "DOCUMENTATION", "README.md", "Usage"));
    check("severities follow the model", rep.findings.every((f) => f.severity === SEVERITY[f.kind]) && rep.counts.HIGH >= 6 && rep.counts.MEDIUM >= 4 && rep.counts.LOW >= 3, JSON.stringify(rep.counts));
    check("findings are sorted HIGH first", rep.findings.map((f) => f.severity).join("").replace(/HIGH/g, "H").replace(/MEDIUM/g, "M").replace(/LOW/g, "L").match(/^H*M*L*$/) !== null);

    const stats = has(rep, "API_ENDPOINT", CTRL, "/api/events/stats")!;
    check("evidence: an addition from one side shows only that parent and 'not in the merge base'", stats.present_in.length === 1 && /parent 2/.test(stats.present_in[0]) && stats.in_base === false, JSON.stringify(stats));
    const fbn = has(rep, "REPOSITORY_QUERY", REPO, "findByName")!;
    check("evidence: something both parents kept shows both and 'in the merge base'", fbn.present_in.length === 2 && fbn.in_base === true, JSON.stringify(fbn));
    check("evidence names the merge commit where it first disappeared", fbn.merge.length === 7 && rep.findings.every((f) => f.merge === fbn.merge));

    check("git's own three-way result is NOT a regression: develop's deliberate deletion of deleteOld() is honoured", !rep.findings.some((f) => f.display.includes("deleteOld")) && rep.merges[0].deletions_honoured >= 1, JSON.stringify(rep.merges[0]));
    check("a method that moved to another file in the merge is NOT reported", !rep.findings.some((f) => f.display.includes("helper")) && rep.merges[0].moved_not_reported >= 1, JSON.stringify(rep.merges[0]));
    check("what the merge kept is not reported (developMethod, create, last)", !rep.findings.some((f) => /developMethod|create\(|last\(/.test(f.display)));

    const text = renderMergeReport(rep);
    check("the report uses the specified format: observation, POSSIBLE MERGE REGRESSION, evidence, risk, 'Developer review required.'", text.includes("MERGE REGRESSION REVIEW") && text.includes("Classification:\nPOSSIBLE MERGE REGRESSION") && text.includes("- Missing in merge result") && text.includes("- First disappeared in merge commit") && text.includes("Risk:") && text.includes("Developer review required."), text.slice(0, 600));
    check("it never calls a loss dead code and states it changes nothing", !/dead code|cleanup candidate/i.test(text.replace(/Do not delete[^\n]*/, "")) && /Nothing was changed/.test(text) && /DETECTS, REPORTS and EXPLAINS/.test(text));
    check("the scan is read-only: HEAD and the working tree are untouched", g(r, "rev-parse", "HEAD") === headBefore && g(r, "status", "--porcelain") === statusBefore);

    const byCommit = analyzeMergeRegressions(r, { merge_commit: headBefore });
    check("a specific merge commit can be scanned and gives the same findings", byCommit.findings.length === rep.findings.length);
    check("a limited number of blocks is rendered with the remainder counted", renderMergeReport(rep, 2).includes("more (lower severity), not shown"));
    fs.rmSync(r, { recursive: true, force: true });
}

// ── a clean merge: nothing to report ───────────────────────────────────────
{
    const r = fixture();
    g(r, "merge", "-q", "--no-ff", "-m", "Merge develop into feature", "develop");
    const rep = analyzeMergeRegressions(r);
    check("a merge that lost nothing reports nothing (develop's deletion honoured, both sides' additions kept)", rep.merges.length === 1 && rep.findings.length === 0 && rep.merges[0].deletions_honoured >= 1, JSON.stringify(rep.merges) + JSON.stringify(rep.findings.map((f) => f.display)));
    check("and says so plainly", renderMergeReport(rep).includes("No possible merge regressions found"));
    fs.rmSync(r, { recursive: true, force: true });
}

// ── a merge in progress (reviewing before the commit) ──────────────────────
{
    const r = fixture();
    g(r, "merge", "--no-commit", "--no-ff", "develop");
    edit(r, CTRL, "    @PreAuthorize(\"hasAuthority('event.read')\")\n", "");
    const rep = analyzeMergeRegressions(r);
    check("a merge in progress is scanned from the working tree against both parents", rep.merges.length === 1 && rep.merges[0].sha === "working tree" && !!has(rep, "AUTHORIZATION_CHECK", CTRL, "PreAuthorize"), JSON.stringify(rep.merges));
    check("scanning a merge in progress changes nothing", /PreAuthorize/.test(read(r, CTRL)) === false && g(r, "rev-parse", "-q", "--verify", "MERGE_HEAD").length > 0);
    fs.rmSync(r, { recursive: true, force: true });
}

// ── nothing to scan ────────────────────────────────────────────────────────
{
    const r = fs.mkdtempSync(path.join(os.tmpdir(), "mrg-"));
    g(r, "init", "-q", "-b", "main"); write(r, "a.txt", "x\n"); g(r, "add", "-A"); g(r, "commit", "-q", "-m", "one");
    write(r, "b.txt", "y\n"); g(r, "add", "-A"); g(r, "commit", "-q", "-m", "two");
    const rep = analyzeMergeRegressions(r);
    check("linear history: no merge commit, and the limitation (rebase/squash) is stated", rep.merges.length === 0 && rep.notes.some((n) => /No merge commit/.test(n) && /rebased, squashed/.test(n)), JSON.stringify(rep.notes));
    fs.rmSync(r, { recursive: true, force: true });
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "mrg-"));
    check("not a git repository: a plain note, no crash", analyzeMergeRegressions(plain).notes.some((n) => /Not a git repository/.test(n)));
    fs.rmSync(plain, { recursive: true, force: true });
}

process.exit(failures ? 1 : 0);
