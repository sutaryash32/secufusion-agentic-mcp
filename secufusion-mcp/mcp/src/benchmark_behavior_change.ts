import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { analyzeBehaviorChanges, renderBehaviorReport, BehaviorReport } from "./behavior_change.js";
import { findIntentEvidence, gatherIntentSources, IntentSource } from "./intent_evidence.js";
import { createEntry } from "./project_knowledge.js";

/** Silent behavior changes: code that compiles and passes its tests while the business behavior moves. Real git repositories. */

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

const SVC = "src/main/java/com/x/RetentionService.java";
const REPO = "src/main/java/com/x/EventRepository.java";
const CTRL = "src/main/java/com/x/EventController.java";
const PROPS = "src/main/resources/application.properties";
const TEST = "src/test/java/com/x/RetentionServiceTest.java";

const FILES: Record<string, string> = {
    [SVC]: `package com.x;

import java.time.Instant;

public class RetentionService {

    @Value("\${retention.days:30}")
    private int days;

    public boolean isExpired(Event e, int limit) {
        // how old is too old
        log.info("checking {}", e);
        if (e.ageInDays() >= limit) {
            return true;
        }
        return false;
    }

    public Instant cutoff() {
        return Instant.now().minus(Duration.ofDays(30));
    }

    public List<Event> active(List<Event> all) {
        return all.stream().filter(e -> e.isActive()).collect(toList());
    }

    public String label() {
        return "Retention";
    }
}
`,
    [REPO]: `package com.x;

public interface EventRepository extends JpaRepository<Event, Long> {

    @Query("select e from Event e where e.id = :id and e.tenantId = :tenantId")
    Optional<Event> findSecure(@Param("id") Long id, @Param("tenantId") Long tenantId);
}
`,
    [CTRL]: `package com.x;

@RestController
public class EventController {

    @PreAuthorize("hasAuthority('event.read')")
    @GetMapping("/events/{id}")
    public Event get(@PathVariable Long id) {
        return service.find(id);
    }

    public Event create(@NotBlank String name) {
        return service.create(name);
    }
}
`,
    [PROPS]: "server.port=8080\nfeature.audit.enabled=false\nretention.grace=7\n",
    [TEST]: "package com.x;\n\npublic class RetentionServiceTest {\n    @Test\n    void expired() {\n        assertTrue(service.isExpired(e, 30));\n    }\n}\n",
};

function repo(): string {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), "bhv-"));
    g(r, "init", "-q", "-b", "main");
    for (const [f, c] of Object.entries(FILES)) write(r, f, c);
    g(r, "add", "-A"); g(r, "commit", "-q", "-m", "base");
    g(r, "checkout", "-q", "-b", "work");
    return r;
}
const at = (rep: BehaviorReport, file: string, needle: string) => rep.candidates.find((c) => c.file === file && [...c.old, ...c.new].some((l) => l.includes(needle)));

// ── behavior changes that compile and pass tests ───────────────────────────
{
    const r = repo();
    edit(r, SVC, "e.ageInDays() >= limit", "e.ageInDays() > limit");                       // off-by-one on the boundary
    edit(r, SVC, "retention.days:30", "retention.days:60");                                // default value
    edit(r, SVC, "Duration.ofDays(30)", "Duration.ofDays(90)");                            // time calculation
    edit(r, SVC, "filter(e -> e.isActive())", "filter(e -> !e.isActive())");               // filter inverted
    edit(r, REPO, " and e.tenantId = :tenantId", "");                                      // predicate dropped
    edit(r, CTRL, "hasAuthority('event.read')", "hasAuthority('event.write')");            // authority changed
    edit(r, CTRL, "@NotBlank String name", "String name");                                 // validation removed
    edit(r, PROPS, "feature.audit.enabled=false", "feature.audit.enabled=true");           // flag flipped
    // noise that must NOT be reported
    edit(r, SVC, "// how old is too old", "// how old is too old, in days");               // comment
    edit(r, SVC, 'log.info("checking {}", e);', 'log.info("evaluating {}", e);');          // log line
    edit(r, SVC, 'return "Retention";', 'return "Retention policy";');                     // a plain label
    edit(r, TEST, "service.isExpired(e, 30)", "service.isExpired(e, 31)");                 // a test edited to fit
    g(r, "add", "-A"); g(r, "commit", "-q", "-m", "work");
    const headBefore = g(r, "rev-parse", "HEAD");
    const rep = analyzeBehaviorChanges(r, { base: "main" });

    const gt = at(rep, SVC, ">");
    check("a flipped comparison (>= became >) is caught with the operator named", !!gt && gt.categories.includes("CONDITIONAL") && gt.signals.some((s) => s.includes("operator >= -> >")), JSON.stringify(gt));
    const def = at(rep, SVC, "retention.days");
    check("a changed default value is caught with the old and new value", !!def && def.categories.includes("DEFAULT_VALUE") && def.signals.some((s) => /value 30 -> 60/.test(s)), JSON.stringify(def));
    const time = at(rep, SVC, "Duration.ofDays");
    check("a changed time calculation is caught (30 days became 90)", !!time && time.categories.includes("TIME_CALCULATION") && time.signals.some((s) => /value 30 -> 90/.test(s)), JSON.stringify(time));
    const filt = at(rep, SVC, ".filter(");
    check("an inverted filter is caught: negation added", !!filt && filt.categories.includes("FILTERING") && filt.signals.includes("negation added"), JSON.stringify(filt));
    const q = at(rep, REPO, "tenantId");
    check("a dropped query predicate is HIGH and names what is no longer referenced (the tenant predicate)", !!q && q.categories.includes("QUERY_PREDICATE") && q.baseline_risk === "HIGH" && q.signals.some((s) => /no longer references: .*tenantId/.test(s)), JSON.stringify(q));
    const auth = at(rep, CTRL, "hasAuthority");
    check("a changed authorization check is HIGH", !!auth && auth.categories.includes("AUTHORIZATION") && auth.baseline_risk === "HIGH" && auth.signals.some((s) => /event\.read/.test(s) && /event\.write/.test(s)), JSON.stringify(auth));
    const val = at(rep, CTRL, "@NotBlank");
    check("a removed validation is HIGH", !!val && val.categories.includes("VALIDATION") && val.baseline_risk === "HIGH" && val.signals.some((s) => /annotation @NotBlank/.test(s)), JSON.stringify(val));
    const flag = at(rep, PROPS, "feature.audit.enabled");
    check("a flipped feature flag in configuration is caught", !!flag && flag.categories.includes("FEATURE_FLAG") && flag.signals.some((s) => /text|value|false|true|references/.test(s)), JSON.stringify(flag));
    check("comments, log wording and a plain label are noise, not behavior", !rep.candidates.some((c) => [...c.old, ...c.new].some((l) => /how old is too old|evaluating|checking|Retention policy/.test(l))), JSON.stringify(rep.candidates.map((c) => c.new)));
    check("test files are not scanned as product behavior, but a test edited to fit is listed", !rep.candidates.some((c) => c.file === TEST) && rep.test_files_changed.includes(TEST), JSON.stringify(rep.test_files_changed));
    check("candidates are ordered HIGH first and counts add up", rep.candidates.map((c) => c.baseline_risk).join("").replace(/HIGH/g, "H").replace(/MEDIUM/g, "M").replace(/LOW/g, "L").match(/^H*M*L*$/) !== null && rep.counts.HIGH + rep.counts.MEDIUM + rep.counts.LOW === rep.candidates.length, JSON.stringify(rep.counts));
    check("the report reads against the reviewer's block: it asks for the six fields and says a passing build is not confirmation", ["Old Behavior", "New Behavior", "Affected Users", "Acceptance Criteria Impact", "Risk", "Intent Explicitly Confirmed", "do not confirm intent"].every((x) => renderBehaviorReport(rep).includes(x)) && /BEHAVIOR CHANGE CANDIDATE 1/.test(renderBehaviorReport(rep)));
    check("the scan is read-only", g(r, "rev-parse", "HEAD") === headBefore && g(r, "status", "--porcelain") === "");
    fs.rmSync(r, { recursive: true, force: true });
}

// ── uncommitted work is inspected too; an untouched repo reports nothing ───
{
    const r = repo();
    edit(r, SVC, "e.ageInDays() >= limit", "e.ageInDays() > limit");
    const rep = analyzeBehaviorChanges(r, { base: "main" });
    check("uncommitted working-tree changes are in the diff", !!at(rep, SVC, ">"));
    g(r, "checkout", "-q", "--", ".");
    const none = analyzeBehaviorChanges(r, { base: "main" });
    check("no changes: 'No behavior-bearing changes found'", none.candidates.length === 0 && renderBehaviorReport(none).includes("No behavior-bearing changes found"));
    fs.rmSync(r, { recursive: true, force: true });
}

// ── a diff of pure noise ───────────────────────────────────────────────────
{
    const r = repo();
    edit(r, SVC, "// how old is too old", "// reworded");
    edit(r, SVC, "import java.time.Instant;", "import java.time.Instant;\nimport java.util.List;");
    const rep = analyzeBehaviorChanges(r, { base: "main" });
    check("comment and import changes alone produce no candidates", rep.candidates.length === 0, JSON.stringify(rep.candidates));
    fs.rmSync(r, { recursive: true, force: true });
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "bhv-"));
    check("not a git repository: a note, no crash", analyzeBehaviorChanges(plain).notes.some((n) => /Not a git repository/.test(n)));
    fs.rmSync(plain, { recursive: true, force: true });
}

// ── before "intent not confirmed", the story's recorded sources are searched ──
{
    const sources: IntentSource[] = [
        { kind: "acceptance criterion", label: "acceptance criterion 1", text: "The default retention period is 60 days." },
        { kind: "acceptance criterion", label: "acceptance criterion 2", text: "Only one replica runs a retention job." },
        { kind: "story text", label: "requirement: request", text: "Retention scheduler replica convergence. Add reconciliation so replicas agree." },
        { kind: "ADR", label: "ADR adr-0003", text: "ADR-0003: Reconcile timers against the database. Reconciliation runs every 5 minutes." },
        { kind: "product decision", label: "user decision D1", text: "Should expired events be archived? Yes, archive them for 90 days." },
    ];
    const def = findIntentEvidence(['@Value("${retention.days:30}")'], ['@Value("${retention.days:60}")'], sources);
    check("a changed default is matched to the acceptance criterion that states it (60 days)", def.length >= 1 && def[0].label === "acceptance criterion 1" && def[0].matched.includes("60") && def[0].matched.includes("retention"), JSON.stringify(def));
    const time = findIntentEvidence(["return Instant.now().minus(Duration.ofDays(30));"], ["return Instant.now().minus(Duration.ofDays(90));"], sources);
    check("a changed time window is matched to the recorded product decision (archive for 90 days)", time.some((s) => s.source === "product decision" && s.matched.includes("90")), JSON.stringify(time));
    const none = findIntentEvidence(["if (e.ageInDays() >= limit) {"], ["if (e.ageInDays() > limit) {"], sources);
    check("nothing is claimed when nothing in the story talks about it", none.length === 0, JSON.stringify(none));
    const lone = findIntentEvidence(['String label = "Retention";'], ['String label = "Retention policy";'], sources);
    check("a single shared common word is not evidence", lone.every((s) => s.matched.length >= 2), JSON.stringify(lone));
    const adr = findIntentEvidence(["scheduler.reconcileEvery(10);"], ["scheduler.reconcileEvery(5);"], sources);
    check("an ADR that decided it is found and labelled as an ADR", adr.some((s) => s.source === "ADR" && /reconcil/i.test(s.quote)), JSON.stringify(adr));

    // real recorded state: a requirement, an ADR, accepted project knowledge and the task's decision log
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "intent-"));
    fs.mkdirSync(path.join(ws, ".secufusion", "requirements"), { recursive: true });
    fs.writeFileSync(path.join(ws, ".secufusion", "requirements", "STORY-7.json"), JSON.stringify({
        id: "STORY-7", title: "Retention defaults", raw_request: "Make the default retention longer.", status: "CONFIRMED", clarification_questions: [],
        acceptance_criteria: ["The default retention period is 60 days"], scope: "events service", constraints: [], facts: ["The scheduler reads retention.days"],
        user_decisions: [{ id: "D1", category: "product", question: "Archive expired events?", options: ["yes", "no"], evidence: [], state: "ANSWERED", asked_at: "x", answer: "yes, for 90 days", user_statement: "yes, keep them 90 days" },
                         { id: "D2", category: "product", question: "Open question", options: [], evidence: [], state: "OPEN", asked_at: "x" }],
    }));
    const taskDir = path.join(ws, ".secufusion", "tasks", "STORY-7-x");
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "decisions.json"), JSON.stringify([{ decision: "Reconcile every 5 minutes", rationale: "bounds staleness" }]));
    fs.writeFileSync(path.join(taskDir, "spec.json"), JSON.stringify({ work_item_id: "STORY-7", title: "Retention defaults", acceptance_criteria: [], description: "Longer default retention" }));
    createEntry(ws, { category: "adr", title: "Retention window", source: "design", body: `> The retention window is 60 days.\n\n## Decision Snapshot\n\n**Problem**\n\np\n\n**Decision**\n\nd\n\n**Outcome**\n\no\n\n**Status**\n\nProposed\n\n**Related Work**\n\n- x\n\n## Executive Summary\n\ns\n\n## Context\n\nc\n\n## Problem Statement\n\nps\n\n## Investigation Summary\n\ni\n\n## Options Considered\n\no\n\n## Decision\n\nWe keep events for 60 days.\n\n## Consequences\n\n### Benefits\n\nb\n\n### Trade-Offs\n\nt\n\n### Risks\n\nr\n\n### Future Reconsideration Criteria\n\nf\n\n## Verification\n\nv\n\n## References\n\n- r\n` });
    createEntry(ws, { category: "architecture", title: "Archive policy", source: "owner", status: "accepted", body: "Expired events are archived and kept for 90 days before deletion." });
    const got = gatherIntentSources({ ecosystemRoot: ws, workItemId: "STORY-7", taskDir });
    const kinds = new Set(got.map((s) => s.kind));
    check("the story's sources are gathered: acceptance criteria, story text, ADR and product decisions", ["acceptance criterion", "story text", "ADR", "product decision"].every((k) => kinds.has(k as any)), JSON.stringify([...kinds]));
    check("only answered user decisions count (an open question is not a decision)", got.some((s) => s.label === "user decision D1") && !got.some((s) => s.label === "user decision D2"));
    check("the task's decision log and accepted project knowledge are product decisions; a proposed ADR is labelled a hint", got.some((s) => s.label === "task decision") && got.some((s) => s.label === "project knowledge archive-policy") && got.some((s) => s.kind === "ADR" && /proposed: a hint, not confirmation/.test(s.trust ?? "")), JSON.stringify(got.map((s) => s.label + "|" + (s.trust ?? ""))));
    const found = findIntentEvidence(["Duration.ofDays(30)"], ["Duration.ofDays(90)"], got);
    check("with real recorded state, the 90-day window is traced to the decision and the knowledge entry", found.some((s) => s.source === "product decision") && found.every((s) => s.matched.length >= 2), JSON.stringify(found));

    // the report shows the search, and says when it was not run
    const r = repo();
    edit(r, SVC, "retention.days:30", "retention.days:60");
    g(r, "add", "-A"); g(r, "commit", "-q", "-m", "w");
    const withSearch = renderBehaviorReport(analyzeBehaviorChanges(r, { base: "main", sources }));
    check("the report lists possible supporting evidence under the candidate, and tells the reviewer to read it", /Possible supporting evidence \(searched: acceptance criteria, story text, ADRs, recorded product decisions/.test(withSearch) && /acceptance criterion 1/.test(withSearch) && /decide whether it really confirms THIS change/.test(withSearch), withSearch.slice(0, 1200));
    const noSources = renderBehaviorReport(analyzeBehaviorChanges(r, { base: "main" }));
    check("without a story it says the search was NOT run (never silently 'no evidence')", /Intent evidence: NOT SEARCHED/.test(noSources) && /work_item_id/.test(noSources));
    const empty = renderBehaviorReport(analyzeBehaviorChanges(r, { base: "main", sources: [] }));
    check("with a story but nothing found it says so and points at the user's instructions", /Intent evidence: none found in acceptance criteria, story text, ADRs, recorded product decisions/.test(empty) && /user's instructions in this conversation/.test(empty), empty.slice(0, 900));
    fs.rmSync(r, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
}

process.exit(failures ? 1 : 0);
