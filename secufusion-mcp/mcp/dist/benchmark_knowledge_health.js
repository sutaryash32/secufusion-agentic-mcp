import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { discoverEntities, computeCoverage, buildHealth, renderHealth, renderSuggestions, findTribalCandidates, findRepeated, recordLookup, readLookups, significantTerms, COVERAGE_DEFINITION, } from "./knowledge_health.js";
import { createEntry, loadKnowledge, scaffoldKnowledge, autoScaffoldEnabled, parseEntryText, CATEGORIES, inspectAgentsMd, AGENTS_MD_SOFT_LIMIT } from "./project_knowledge.js";
/** Coverage is documented vs discovered entities, per dimension. Never an arbitrary percentage. */
let failures = 0;
function check(name, cond, detail = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + detail}`);
    if (!cond)
        failures++;
}
const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "kh-")); dirs.push(d); return d; };
const put = (root, rel, content) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), content); };
const spec = () => ({
    platform: { name: "X", tenancy_model: "multi-tenant", auth_provider: "Keycloak (per-tenant realms)", event_bus: "Kafka", database: "PostgreSQL", migration_strategy: "MANUAL" },
    terminology: { _critical: "read first", Device: "A browser installation", Machine: "A physical endpoint", history: "legacy", rules: ["r1"] },
    microservices: {
        "sfn-iam-api": { port: "8084", owns_tables: ["users"], kafka_produces: ["user-deleted"], calls_services: ["sfn-events-api"] },
        "sfn-events-api": { port: "8086", owns_tables: ["events"], kafka_consumes: ["user-deleted"] },
        "sfn-policy-api": { port: "CONFLICT: 8089 vs 8090", owns_tables: ["policies"], kafka_produces: ["policy-events"] },
    },
    golden_rules: { tenant_isolation: "Always scope by tenant", no_hardcoded_env: "No hardcoded environment values", kafka_no_blocking: "No blocking calls in listeners" },
    manual_review_flags: ["sfn-iam-api and sfn-events-api both write audit rows for the same action"],
});
const E = (extra) => ({
    id: "e", title: "t", category: "architecture", status: "accepted", tags: [], applies_to: [], source: "s", date: "2026-01-01", supersedes: [], file: "x.md", body: "", ...extra,
});
const dim = (cov, d) => cov.find((c) => c.dimension === d);
// ── discovery ───────────────────────────────────────────────────────────────
{
    const d = discoverEntities(spec());
    check("services, topics and rules come from the project spec", d.services.length === 3 && d.topics.length === 2 && d.rules.length === 3, JSON.stringify([d.services.length, d.topics.length, d.rules.length]));
    check("domain concepts are the terminology entries, not its meta keys", d.concepts.map((c) => c.name).sort().join() === "Device,Machine", d.concepts.map((c) => c.name).join());
    check("platform decisions are the recorded platform choices", d.decisions.length === 5 && d.decisions.some((x) => x.name === "event_bus"), d.decisions.map((x) => x.name).join());
    check("anomalies are discovered: a dead topic, an unresolved CONFLICT, a manual-review flag", d.exceptions.some((x) => x.name === "TOPIC_NO_CONSUMER:policy-events") && d.exceptions.some((x) => x.name.startsWith("UNRESOLVED:sfn-policy-api")) && d.exceptions.some((x) => x.name.startsWith("FLAG:")), d.exceptions.map((x) => x.name).join(" | "));
    check("an empty or missing spec discovers nothing and does not throw", Object.values(discoverEntities(null)).every((v) => v.length === 0) && Object.values(discoverEntities({})).every((v) => v.length === 0));
}
// ── what counts as documented ──────────────────────────────────────────────
{
    const d = discoverEntities(spec());
    const none = computeCoverage(d, []);
    check("with no knowledge, everything discovered is undocumented", none.every((c) => c.documented === 0 && c.undocumented.length === c.discovered) && none.reduce((n, c) => n + c.discovered, 0) > 10);
    const entries = [
        E({ id: "svc", title: "IAM service", applies_to: ["sfn-iam-api"], body: "Owns users." }),
        E({ id: "tenant", category: "patterns", title: "Tenant scoping", body: "This is the tenant isolation rule in practice." }),
        E({ id: "dev", title: "Device vs Machine", tags: ["device", "machine"] }),
        E({ id: "kaf", category: "adr", title: "Why Kafka", body: "We chose Kafka as the event bus." }),
        E({ id: "dead", category: "known-exceptions", title: "policy-events has no consumer", body: "The policy-events topic is produced but intentionally unconsumed." }),
    ];
    const cov = computeCoverage(d, entries);
    check("a service is documented by an accepted entry naming it (applies_to)", dim(cov, "services").documented === 1 && !dim(cov, "services").undocumented.some((u) => u.name === "sfn-iam-api"));
    check("names match across _ / - / space (tenant_isolation ↔ 'tenant isolation')", dim(cov, "rules").documented === 1 && !dim(cov, "rules").undocumented.some((u) => u.name === "tenant_isolation"));
    check("a domain concept is documented by tags", dim(cov, "concepts").documented === 2, JSON.stringify(dim(cov, "concepts")));
    check("a platform decision needs an ADR or architecture entry naming it (Kafka → event_bus)", !dim(cov, "decisions").undocumented.some((u) => u.name === "event_bus") && dim(cov, "decisions").documented === 1);
    check("...a patterns entry that mentions Kafka does not document the decision", (() => {
        const c = computeCoverage(d, [E({ id: "p", category: "patterns", body: "We use Kafka and Keycloak and PostgreSQL everywhere" })]);
        return dim(c, "decisions").documented === 0 && dim(c, "decisions").undocumented.length === 5;
    })());
    check("an anomaly is documented only by a known-exceptions entry naming it", dim(cov, "exceptions").documented === 1 && !dim(cov, "exceptions").undocumented.some((u) => u.name === "TOPIC_NO_CONSUMER:policy-events"), JSON.stringify(dim(cov, "exceptions").undocumented.map((u) => u.name)));
    check("...a flag that names two services needs an exception naming BOTH", (() => {
        const one = computeCoverage(d, [E({ id: "x", category: "known-exceptions", body: "sfn-iam-api writes audit rows." })]);
        const both = computeCoverage(d, [E({ id: "y", category: "known-exceptions", body: "sfn-iam-api and sfn-events-api both write audit rows." })]);
        const flagDocumented = (c) => !dim(c, "exceptions").undocumented.some((u) => u.name.startsWith("FLAG:"));
        return !flagDocumented(one) && flagDocumented(both);
    })());
    const proposedOnly = computeCoverage(d, [E({ id: "p", status: "proposed", applies_to: ["sfn-iam-api"] })]);
    check("an entry that is only proposed is 'proposed only', not documented", dim(proposedOnly, "services").documented === 0 && dim(proposedOnly, "services").proposed_only === 1 && !dim(proposedOnly, "services").undocumented.some((u) => u.name === "sfn-iam-api"));
    check("an accepted entry beats a proposed one for the same entity", (() => {
        const c = computeCoverage(d, [E({ id: "p", status: "proposed", applies_to: ["sfn-iam-api"] }), E({ id: "a", applies_to: ["sfn-iam-api"] })]);
        return dim(c, "services").documented === 1 && dim(c, "services").proposed_only === 0;
    })());
    check("superseded and deprecated entries document nothing", (() => {
        const c = computeCoverage(d, [E({ id: "s", status: "superseded", applies_to: ["sfn-iam-api"] }), E({ id: "d", status: "deprecated", applies_to: ["sfn-iam-api"] })]);
        return dim(c, "services").documented === 0 && dim(c, "services").undocumented.length === 3;
    })());
    check("a too-short or partial token does not match (word boundaries)", (() => {
        const c = computeCoverage(d, [E({ id: "x", body: "the sfn-iam-apis are discussed; sfn-events-apiary" })]);
        return dim(c, "services").documented === 0;
    })());
}
// ── the report: ratios, a stated definition, no invented percentage ─────────
{
    const root = tmp();
    scaffoldKnowledge(root);
    createEntry(root, { category: "architecture", title: "IAM", body: "Owns users", source: "s", applies_to: ["sfn-iam-api"], status: "accepted" });
    const model = loadKnowledge(root);
    const h = buildHealth({ spec: spec(), model, workspaceRoot: root, events: [] });
    const text = renderHealth(h);
    check("it reports 'N of M discovered entities documented'", /\*\*Coverage: 1 of \d+ discovered entities documented\*\*/.test(text), text.slice(0, 200));
    check("it never prints a percentage", !text.includes("%"));
    check("it states what 'documented' means", text.includes(COVERAGE_DEFINITION.slice(0, 60)));
    check("it lists the gaps by dimension", /Knowledge gaps/.test(text) && /Services \(2\)/.test(text));
    check("totals add up", h.totals.discovered === h.totals.documented + h.totals.proposed_only + h.totals.undocumented, JSON.stringify(h.totals));
    check("entries per category are reported with accepted counts", h.by_category["architecture"].total === 1 && h.by_category["architecture"].accepted === 1);
    // the knowledge graph is not the denominator
    const noisy = { graph: { nodes: [{ type: "SERVICE", name: "IAM-SERVICE" }, { type: "TOPIC", name: "KafkaTopicConfig.DEVICE_DELETED_TOPIC" }, { type: "TOPIC", name: "TOPIC" }, { type: "SERVICE", name: "sfn-iam-api" }], edges: [] } };
    const h2 = buildHealth({ spec: spec(), dna: noisy, model, workspaceRoot: root, events: [] });
    check("noisy graph names do not inflate the discovered count", h2.totals.discovered === h.totals.discovered);
    check("...they are reported separately as unreconciled (and real, already-known ones are not)", h2.unreconciled_graph_names.includes("IAM-SERVICE") && h2.unreconciled_graph_names.includes("TOPIC") && !h2.unreconciled_graph_names.includes("sfn-iam-api"), h2.unreconciled_graph_names.join());
}
// ── anomalies are a separate backlog, not part of the coverage headline ────
{
    const root = tmp();
    scaffoldKnowledge(root);
    const model = loadKnowledge(root);
    const d = discoverEntities(spec());
    const entityCount = d.services.length + d.topics.length + d.rules.length + d.concepts.length + d.decisions.length;
    const h = buildHealth({ spec: spec(), model, workspaceRoot: root, events: [] });
    check("the headline counts entities only: services + topics + rules + concepts + decisions", h.totals.discovered === entityCount && h.totals.discovered === 15, `${h.totals.discovered} vs ${entityCount}`);
    check("...even though anomalies were also discovered", d.exceptions.length > 0);
    const text = renderHealth(h);
    check("anomalies are reported separately and described as unconfirmed", /Known-exception candidates \(not in the coverage line\)/.test(text) && /unconfirmed: some may be benign/.test(text));
    check("the table's rows are the headline dimensions (no anomaly row)", !/\| Anomalies/.test(text));
    // a spec with many multi-owner tables must not flood the suggestions
    const big = { microservices: {}, golden_rules: {} };
    for (let i = 0; i < 6; i++)
        big.microservices[`svc-${i}`] = { owns_tables: Array.from({ length: 12 }, (_, k) => `shared_table_${k}`) };
    const hb = buildHealth({ spec: big, model, workspaceRoot: root, events: [] });
    const tableSuggestions = hb.suggestions.filter((s) => /tables owned by several services/.test(s.title));
    check("12 multi-owner tables become ONE suggestion with a count and examples", tableSuggestions.length === 1 && /^12 tables owned by several services/.test(tableSuggestions[0].title) && /\+9 more/.test(tableSuggestions[0].evidence), tableSuggestions.map((s) => s.title + " :: " + s.evidence).join(" || "));
    check("real entities (MEDIUM) are suggested ahead of unconfirmed anomalies (LOW)", (() => {
        const firstEntity = h.suggestions.findIndex((s) => s.kind === "UNDOCUMENTED_ENTITY" && s.priority === "MEDIUM");
        const firstAnomaly = h.suggestions.findIndex((s) => s.kind === "UNDOCUMENTED_EXCEPTION");
        return firstEntity >= 0 && firstAnomaly >= 0 && firstEntity < firstAnomaly;
    })(), h.suggestions.map((s) => `${s.priority}:${s.kind}`).join(" "));
    // an anomaly someone has actually investigated is promoted to its own HIGH suggestion
    const ev = { ts: "2026-10-05T10:00:00.000Z", kind: "investigate", terms: ["policy-events"], files: [], matched: [], accepted_matched: false };
    const hi = buildHealth({ spec: spec(), model, workspaceRoot: root, events: [ev], minRepeat: 3 });
    check("an investigated anomaly gets its own HIGH suggestion", hi.suggestions.some((s) => s.kind === "UNDOCUMENTED_EXCEPTION" && s.priority === "HIGH" && /policy-events/.test(s.title)));
}
// ── tribal knowledge hiding in the agent file ──────────────────────────────
{
    const root = tmp();
    put(root, ".agents/AGENTS.md", [
        "# Router", "", "## Workflow", "Always investigate before coding. Never skip the review.", "",
        "## Service architecture", "sfn-iam-api calls sfn-events-api and publishes user-deleted; sfn-policy-api emits policy-events.", "",
        "### CRITICAL: Device vs Machine terminology", "Device means a browser installation. " + "x".repeat(260), "",
        "## Already moved", "See .mcp/architecture/terminology-device-vs-machine.md for sfn-iam-api and sfn-events-api terminology.", "",
        "```", "## not a heading, inside a fence", "```",
    ].join("\n"));
    const names = [...discoverEntities(spec()).services, ...discoverEntities(spec()).topics].map((e) => e.name);
    const t = findTribalCandidates(root, names);
    check("a section naming several project entities is flagged as tribal knowledge", t.some((c) => c.heading === "Service architecture" && c.entities.length >= 2 && c.suggested_category === "architecture"), JSON.stringify(t));
    check("a CRITICAL / terminology section is flagged", t.some((c) => /Device vs Machine/.test(c.heading)));
    check("workflow guidance is NOT flagged (it is what agents.md is for)", !t.some((c) => c.heading === "Workflow"));
    check("a section that already points at .mcp/ is not flagged", !t.some((c) => c.heading === "Already moved"));
    check("headings inside code fences are ignored", !t.some((c) => /not a heading/.test(c.heading)));
    check("each candidate says where it is and why", t.every((c) => c.file === ".agents/AGENTS.md" && c.line > 0 && c.reason.length > 0));
}
// ── every agent-facing file is scanned, with a stricter bar for behavior sections ──
{
    const root = tmp();
    const svc = "sfn-iam-api sfn-events-api sfn-policy-api";
    put(root, "CLAUDE.md", [
        "# Project memory", "",
        "## Working agreement (coding-agent contract)", "Investigate before coding. For example in sfn-iam-api and sfn-events-api always check the tenant first.", "",
        "## Stack, per service", `${svc} are Spring Boot services behind the gateway; events flow over user-deleted and policy-events.`, "",
    ].join("\n"));
    put(root, ".agents/skills/sfn-review/references/AGENTS.md", [
        "# Copy", "", "## Service architecture", `${svc} and the user-deleted topic form the core; policy-events is produced by sfn-policy-api.`, "",
        "## Stack, per service", `${svc} are Spring Boot services behind the gateway; events flow over user-deleted and policy-events.`, "",
    ].join("\n"));
    const d = discoverEntities(spec());
    const names = [...d.services, ...d.topics].map((e) => e.name);
    const t = findTribalCandidates(root, names);
    check("CLAUDE.md and the skills copy of AGENTS.md are both scanned", t.some((c) => c.file === "CLAUDE.md") && t.some((c) => c.file === ".agents/skills/sfn-review/references/AGENTS.md"), JSON.stringify(t.map((c) => c.file + ":" + c.heading)));
    check("a behavior section that merely names two services as examples is NOT flagged", !t.some((c) => /Working agreement/.test(c.heading)), JSON.stringify(t.map((c) => c.heading)));
    check("a section naming three or more entities IS flagged", t.some((c) => c.heading === "Service architecture"));
    check("the same section copied into two files is reported once", t.filter((c) => c.heading === "Stack, per service").length === 1);
    const a = inspectAgentsMd(root);
    check("all agent files are listed, and CLAUDE.md is the primary", a.files.length === 2 && a.file === "CLAUDE.md", JSON.stringify(a.files));
    put(root, ".agents/skills/sfn-review/references/AGENTS.md", "line\n".repeat(AGENTS_MD_SOFT_LIMIT + 40));
    check("a size warning comes from ANY agent file over the limit, and names it", (inspectAgentsMd(root).warning ?? "").startsWith(".agents/skills/sfn-review/references/AGENTS.md is "), inspectAgentsMd(root).warning ?? "none");
}
// ── repeated investigation ─────────────────────────────────────────────────
{
    const ev = (terms, accepted = false, day = 5) => ({ ts: `2026-10-0${day}T10:00:00.000Z`, kind: "knowledge", terms, files: [], matched: [], accepted_matched: accepted });
    const none = [];
    check("generic words are not significant terms", significantTerms(["the user count is wrong", "retention scheduler"]).join() === "retention,scheduler", significantTerms(["the user count is wrong", "retention scheduler"]).join());
    check("two lookups are not 'repeated'", findRepeated([ev(["retention scheduler"]), ev(["retention scheduler"], false, 6)], none, 3).length === 0);
    const three = [ev(["retention scheduler"]), ev(["scheduler retention authorization"], false, 6), ev(["retention scheduler"], false, 8)];
    const rep = findRepeated(three, none, 3);
    check("three lookups of the same topic with no accepted answer are 'repeated'", rep.length === 1 && rep[0].count === 3 && rep[0].terms.includes("retention") && rep[0].terms.includes("scheduler"), JSON.stringify(rep));
    check("terms that always appear together are reported as one topic", rep[0].terms.join() === "retention,scheduler");
    check("it carries the date range", rep[0].first.startsWith("2026-10-05") && rep[0].last.startsWith("2026-10-08"));
    check("lookups that WERE answered by accepted knowledge do not count", findRepeated([ev(["retention"], true), ev(["retention"], true), ev(["retention"], true)], none, 3).length === 0);
    check("knowledge recorded since then clears it", findRepeated(three, [E({ id: "r", title: "Retention scheduler authorization", body: "retention scheduler runs as system principal" })], 3).length === 0);
    check("...but a merely proposed entry does not", findRepeated(three, [E({ id: "r", status: "proposed", title: "Retention scheduler authorization", body: "retention scheduler runs as system principal" })], 3).length === 1);
    check("the threshold is configurable", findRepeated(three.slice(0, 2), none, 2).length === 1);
    const root = tmp();
    for (let i = 0; i < 520; i++)
        recordLookup(root, ev([`topic${i}word`]));
    check("the lookup log is capped (working state, not an archive)", readLookups(root).length === 500);
    check("recording never throws on an unwritable location", (() => { try {
        recordLookup("Z:/definitely/not/writable/\0", ev(["x"]));
        return true;
    }
    catch {
        return false;
    } })());
}
// ── suggestions ────────────────────────────────────────────────────────────
{
    const root = tmp();
    scaffoldKnowledge(root);
    const model = loadKnowledge(root);
    const ev = (terms) => ({ ts: "2026-10-05T10:00:00.000Z", kind: "knowledge", terms, files: [], matched: [], accepted_matched: false });
    const h = buildHealth({ spec: spec(), model, workspaceRoot: root, events: [ev(["policy-events"]), ev(["policy-events"]), ev(["policy-events"])], minRepeat: 3 });
    check("repeated investigation is the top suggestion, with its evidence", h.suggestions[0].kind === "REPEATED_INVESTIGATION" && h.suggestions[0].priority === "HIGH" && /3 times/.test(h.suggestions[0].why), JSON.stringify(h.suggestions[0]));
    check("an undocumented entity you have investigated outranks one you haven't", (() => {
        const hit = h.suggestions.find((s) => s.title.includes("policy-events") && s.kind !== "REPEATED_INVESTIGATION");
        const miss = h.suggestions.find((s) => s.kind === "UNDOCUMENTED_ENTITY" && s.priority === "LOW");
        return !!hit && hit.priority === "HIGH" && !!miss;
    })());
    check("anomalies are suggested as known-exceptions, entities with a sensible category", h.suggestions.some((s) => s.kind === "UNDOCUMENTED_EXCEPTION" && s.category === "known-exceptions") && h.suggestions.some((s) => s.category === "adr"));
    check("suggestions never contain an invented body: the next step asks for verified content", h.suggestions.every((s) => /record_project_knowledge\(/.test(s.next_step) && !/body:/.test(s.next_step)));
    check("they are sorted HIGH before MEDIUM before LOW", h.suggestions.map((s) => ({ HIGH: 0, MEDIUM: 1, LOW: 2 }[s.priority])).every((v, i, a) => i === 0 || a[i - 1] <= v));
    check("the rendered list says why and what to do", /Why:/.test(renderSuggestions(h.suggestions, 3)) && /Next:/.test(renderSuggestions(h.suggestions, 3)));
    check("when nothing is missing it says so instead of inventing work", renderSuggestions([]).includes("No knowledge suggestions"));
}
// ── scaffold templates and opt-in auto-create ──────────────────────────────
{
    const root = tmp();
    const created = scaffoldKnowledge(root);
    check("scaffold creates one template per category under .mcp/templates/", CATEGORIES.every((c) => fs.existsSync(path.join(root, ".mcp", "templates", `${c}.md`))) && created.filter((c) => c.includes("templates/")).length === CATEGORIES.length, created.join());
    check("each template is a valid entry skeleton that says what a good entry answers", CATEGORIES.every((c) => {
        const p = parseEntryText(fs.readFileSync(path.join(root, ".mcp", "templates", `${c}.md`), "utf8"));
        return !!p && p.meta.category === c && p.meta.status === "proposed" && p.body.length > 150;
    }));
    const adrTemplate = fs.readFileSync(path.join(root, ".mcp", "templates", "adr.md"), "utf8");
    check("the ADR template is a document first (title and summary, metadata last) with the full ADR structure", /^# ADR-XXXX: <Decision Title>\n\n> /.test(adrTemplate) && !adrTemplate.startsWith("---") && ["Decision Snapshot", "Executive Summary", "Context", "Problem Statement", "Investigation Summary", "Options Considered", "Consequences", "Future Reconsideration Criteria", "Verification", "References"].every((h) => adrTemplate.includes(h)) && adrTemplate.indexOf("## References") < adrTemplate.indexOf("<!-- mcp:entry"));
    check("the exception template says what NOT to change", /Do not change it/.test(fs.readFileSync(path.join(root, ".mcp", "templates", "known-exceptions.md"), "utf8")));
    check("templates are not mistaken for knowledge entries", loadKnowledge(root).entries.length === 0 && loadKnowledge(root).problems.length === 0);
    fs.writeFileSync(path.join(root, ".mcp", "templates", "adr.md"), "team's own template");
    scaffoldKnowledge(root);
    check("re-scaffolding never overwrites a customised template", fs.readFileSync(path.join(root, ".mcp", "templates", "adr.md"), "utf8") === "team's own template");
    const r2 = tmp();
    delete process.env.SECUFUSION_AUTO_SCAFFOLD;
    check("auto-create is OFF by default", autoScaffoldEnabled(r2).enabled === false);
    put(r2, ".secufusion-project-spec.json", JSON.stringify({ _meta: { auto_scaffold_knowledge: true } }));
    check("it is enabled by _meta.auto_scaffold_knowledge in the spec", autoScaffoldEnabled(r2).enabled && autoScaffoldEnabled(r2).via === "_meta.auto_scaffold_knowledge");
    put(r2, ".secufusion-project-spec.json", JSON.stringify({ _meta: { auto_scaffold_knowledge: "yes" } }));
    check("...only for a real true, not a truthy string", !autoScaffoldEnabled(r2).enabled);
    process.env.SECUFUSION_AUTO_SCAFFOLD = "1";
    check("...or by SECUFUSION_AUTO_SCAFFOLD=1", autoScaffoldEnabled(r2).enabled && autoScaffoldEnabled(r2).via === "SECUFUSION_AUTO_SCAFFOLD");
    delete process.env.SECUFUSION_AUTO_SCAFFOLD;
    put(r2, ".secufusion-project-spec.json", "{ broken");
    check("an unreadable spec never turns it on", !autoScaffoldEnabled(r2).enabled);
}
// ── this repository's own real spec ────────────────────────────────────────
{
    const real = fileURLToPath(new URL("../../scripts/.secufusion-project-spec.json", import.meta.url));
    if (fs.existsSync(real)) {
        const d = discoverEntities(JSON.parse(fs.readFileSync(real, "utf8").replace(/^\uFEFF/, "")));
        check("the real project spec yields real services, rules and anomalies", d.services.length >= 5 && d.rules.length >= 3 && d.exceptions.length >= 1, JSON.stringify(Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.length]))));
    }
}
for (const d of dirs)
    fs.rmSync(d, { recursive: true, force: true });
console.log(failures === 0 ? "\nKNOWLEDGE HEALTH BENCHMARK: ALL PASS" : `\nKNOWLEDGE HEALTH BENCHMARK: ${failures} FAILED`);
process.exit(failures ? 1 : 0);
