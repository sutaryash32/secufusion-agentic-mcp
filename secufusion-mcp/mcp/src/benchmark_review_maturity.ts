import fs from "fs";
import os from "os";
import path from "path";
import { createEntry, loadKnowledge, setStatus, scaffoldKnowledge, CATEGORIES } from "./project_knowledge.js";
import {
    loadDecisions, collectChange, checkDecisionAlignment, renderDecisionAlignment,
    relevantInvariants, candidateInvariants, renderInvariants, classify, scoreConfidence,
} from "./review_maturity.js";

/** Review maturity: decision registry, invariant catalog, confidence scoring. */

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + detail}`);
    if (!cond) failures++;
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "maturity-"));
const put = (root: string, rel: string, text: string) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };

// ── the knowledge layer carries decisions and invariants, with structured fields ─────────────
{
    const r = tmp();
    check("decisions and invariants are knowledge categories", CATEGORIES.includes("decisions" as any) && CATEGORIES.includes("invariants" as any));
    const made = createEntry(r, { category: "invariants" as any, title: "One IT Admin per tenant", body: "**Rule.** Exactly one.", source: "UD-4", tags: ["tenant"], extra: { domain: "Tenant", fields: ["defaultUser"], enforcement: ["LOCK", "TEST"], bogus: "dropped" } as any });
    const back = loadKnowledge(r).entries.find((e) => e.id === made.id)!;
    check("structured fields survive a write and a reload", back.extra?.domain === "Tenant" && JSON.stringify(back.extra?.fields) === '["defaultUser"]' && JSON.stringify(back.extra?.enforcement) === '["LOCK","TEST"]', JSON.stringify(back.extra));
    check("only whitelisted fields are stored", !("bogus" in (back.extra ?? {})));
    check("a new entry is proposed, never silently accepted", back.status === "proposed");
    check("the scaffold ships templates for both new categories", scaffoldKnowledge(r) !== null && fs.existsSync(path.join(r, ".mcp", "templates", "decisions.md")) && fs.existsSync(path.join(r, ".mcp", "templates", "invariants.md")));
}

// ── decision registry ────────────────────────────────────────────────────────────────────────
const ws = tmp();
put(ws, ".secufusion/tasks/TASK-1/decisions.json", JSON.stringify([
    { id: 1, decision: "UD-1: deleting the current IT Admin (defaultUser) is prohibited; DELETE returns 409. Assumptions awaiting confirmation: a tenant with no contact email keeps it empty.", rationale: "User statement: \"Deleting the current Tenant IT Admin is not allowed directly.\"", logged_at: "x" },
    { id: 2, decision: "Locking uses findByIdForUpdate on the user row.", rationale: "Code review finding", logged_at: "x" },
]));
put(ws, ".secufusion/tasks/TASK-2/decisions.json", JSON.stringify([{ id: 1, decision: "UD-1: deleting the current IT Admin (defaultUser) is prohibited; DELETE returns 409. Assumptions awaiting confirmation: a tenant with no contact email keeps it empty.", rationale: "same", logged_at: "x" }]));
put(ws, ".secufusion/requirements/REQ-1.json", JSON.stringify({ user_decisions: [
    { id: "UD-9", state: "ANSWERED", question: "May a transfer change the tenant email domain?", answer: "No", user_statement: "Ownership transfer must not introduce tenant-domain changes.", options: [], evidence: [], category: "x", asked_at: "x" },
    { id: "UD-10", state: "OPEN", question: "Open one", options: [], evidence: [], category: "x", asked_at: "x" },
] }));
createEntry(ws, { category: "decisions" as any, title: "Identity and capability are separate", body: "A transfer moves only defaultUser; group membership is capability.", source: "UD-7/8", status: "accepted", extra: { ref: "UD-7", guardrail: ["defaultUser"] } as any });
const ds = loadDecisions(ws);
{
    check("decisions are harvested from the registry, work records and answered requirement decisions", ds.some((d) => d.origin === "registry" && d.ref === "UD-7") && ds.some((d) => d.origin === "task-record") && ds.some((d) => d.origin === "requirement"), ds.map((d) => d.ref + ":" + d.origin).join());
    check("the same decision recorded in two tasks is one decision", ds.filter((d) => d.text.startsWith("UD-1: deleting")).length === 1);
    check("an OPEN user decision is not a decision", !ds.some((d) => d.refs.includes("UD-10")));
    const ud1 = ds.find((d) => d.refs.includes("UD-1"))!;
    check("a decision quoting the user is USER-ANSWERED; a code-review note is only RECORDED", ud1.status === "USER-ANSWERED" && ds.find((d) => d.text.startsWith("Locking"))!.status === "RECORDED", `${ud1.status}`);
    check("a registry entry the user accepted is ACCEPTED; the harvested ones never are", ds.find((d) => d.ref === "UD-7")!.status === "ACCEPTED" && ds.filter((d) => d.origin !== "registry").every((d) => d.status !== "ACCEPTED"));
    check("an assumption nobody confirmed is carried on the decision", ud1.unconfirmed.length === 1 && /no contact email/.test(ud1.text));
    check("restrictive wording is recognised (prohibited, returns 409)", ud1.cues.includes("prohibited") && ud1.cues.some((c) => /409/.test(c)));
}

const DIFF_OK = [
    "+++ b/svc/UserService.java", "@@ -10,0 +11,3 @@",
    "+    source.setDefaultUser(false);", "+    newOwner.setDefaultUser(true);", "+    dto.setDefaultUser(user.isDefaultUser());",
    "+    // defaultUser is moved here", "+    @Schema(description = \"defaultUser flag\")",
].join("\n");
{
    const ctx = collectChange(ws, { terms: ["defaultUser"], diff_text: DIFF_OK });
    const checks = checkDecisionAlignment(ds, ctx);
    const ud1 = checks.find((c) => c.decision.refs.includes("UD-1"));
    const w = ud1?.signals.find((s) => s.kind === "NEW_WRITER");
    check("a decision whose field the diff touches is surfaced", !!ud1 && ud1.matched_on.includes("defaultUser"));
    check("real writers are reported with file:line", !!w && w.evidence.some((e) => /svc\/UserService\.java:11 .*setDefaultUser\(false\)/.test(e)) && w.evidence.some((e) => /:12 .*setDefaultUser\(true\)/.test(e)), JSON.stringify(w));
    check("a DTO mapper, a comment and an annotation are not writers", !!w && !w.evidence.some((e) => /dto\.set|\/\/ defaultUser|@Schema/.test(e)));
    check("an unconfirmed assumption on the decision is a signal", !!ud1 && ud1.signals.some((s) => s.kind === "UNCONFIRMED_ASSUMPTION"));
    check("code touched with no test change is a signal", !!ud1 && ud1.signals.some((s) => s.kind === "NO_TEST_CHANGE"));
    const txt = renderDecisionAlignment(checks, ds.length, ctx);
    check("the output offers the four verdicts and never claims ALIGNS itself", /ALIGNS \/ VIOLATES \/ PARTIALLY ALIGNS \/ UNVERIFIED/.test(txt) && !/^DECISION ALIGNMENT: ALIGNS/m.test(txt) && /second source of truth/.test(txt) && /signals, not verdicts/i.test(txt));
    check("a decision recorded only in a work record is labelled RECORDED knowledge, not a project rule", /RECORDED knowledge, not ACCEPTED/.test(txt));
}
{
    // a guardrail line removed from a prohibition
    const diff = ["+++ b/svc/UserService.java", "@@ -20,3 +20,0 @@", "-        if (user.isDefaultUser()) {", "-            throw new ResourceConflictException(\"Transfer ownership first\");", "-        }"].join("\n");
    const sig = checkDecisionAlignment(ds, collectChange(ws, { diff_text: diff, terms: [] })).find((c) => c.decision.refs.includes("UD-1"))?.signals ?? [];
    check("removing the check that protects a prohibited operation is a GUARDRAIL_REMOVED signal", sig.some((s) => s.kind === "GUARDRAIL_REMOVED" && s.evidence.length >= 1), JSON.stringify(sig));
    const none = checkDecisionAlignment(ds, collectChange(ws, { diff_text: ["+++ b/web/Button.jsx", "@@ -1,0 +1,1 @@", "+const colour = 'red';"].join("\n"), terms: ["button colour"] }));
    check("an unrelated change touches no decision (no invented relevance)", none.length === 0, none.map((c) => c.decision.ref).join());
    const empty = renderDecisionAlignment([], 0, collectChange(tmp(), { diff_text: "" }));
    check("an empty registry says absence of decisions is not absence of constraints", /not absence of constraints/.test(empty));
    const generic = checkDecisionAlignment(ds, collectChange(ws, { diff_text: ["+++ b/a/B.java", "@@ -1,0 +1,1 @@", "+    this.userId = userId;"].join("\n"), terms: [] }));
    check("a generic identifier (userId) alone does not match a decision", generic.length === 0, generic.map((c) => c.decision.ref).join());
}

// ── invariant catalog ────────────────────────────────────────────────────────────────────────
const code = tmp();
put(code, "svc/src/main/java/UserService.java", [
    "class UserService {",
    "  void create(Tenant t, User u) {",
    "    if (repo.findByTenantAndDefaultUser(t, true).isEmpty()) {", "      u.setDefaultUser(true);", "    }", "  }",
    "  @Transactional", "  void transfer(User a, User b) {", "    tenantRepo.findByIdForUpdate(a.tenantId());", "    a.setDefaultUser(false);", "    b.setDefaultUser(true);", "  }", "}",
].join("\n"));
put(code, "svc/src/main/java/Mapper.java", "class Mapper { void m(Dto dto, User u) { dto.setDefaultUser(u.isDefaultUser()); } }\n");
put(code, "svc/src/main/resources/V1__t.sql", "CREATE TABLE t (id int, email text, UNIQUE (email));\n");
const cat = tmp();
const mk = (title: string, fields: string[], enforcement: string[], status: "proposed" | "accepted", domain = "Tenant") => createEntry(cat, { category: "invariants" as any, title, body: "**Rule.** x", source: "UD-4", tags: ["tenant"], applies_to: ["tenant", "IT Admin"], status, extra: { domain, fields, enforcement } as any });
{
    mk("Exactly one IT Admin per tenant", ["defaultUser"], ["LOCK"], "accepted");
    mk("Unique email", ["email"], ["DB"], "accepted", "User");
    mk("tenant email follows IT Admin", ["defaultUser"], ["CODE"], "accepted");
    mk("Draft rule nobody accepted", ["email"], ["DB"], "proposed", "User");
    const res = relevantInvariants(cat, { terms: ["tenant", "IT Admin"], code_root: code, fields: ["defaultUser", "email"] });
    const by = (t: string) => res.items.find((i) => i.title === t)!;
    check("relevant invariants are retrieved from the catalog by terms and by field", res.items.length === 4 && res.catalog_size === 4, `${res.items.length}`);
    check("accepted but only check-then-act on one writer: NOT DEMONSTRATED, never CONFIRMED", by("Exactly one IT Admin per tenant").classification === "NOT DEMONSTRATED" && /CHECK_THEN_ACT|outside any lock/.test(by("Exactly one IT Admin per tenant").reasons.join()), JSON.stringify(by("Exactly one IT Admin per tenant")));
    check("accepted and backed by a unique constraint: CONFIRMED", by("Unique email").classification === "CONFIRMED" && by("Unique email").enforcement_types.includes("DB"));
    check("a rule declared as code-only is not confirmed by a lock or constraint on its field", by("tenant email follows IT Admin").classification !== "CONFIRMED");
    check("an invariant nobody accepted is PROPOSED, whatever the code shows", by("Draft rule nobody accepted").classification === "PROPOSED");
    check("write paths carry file:line and whether each is protected", by("Exactly one IT Admin per tenant").write_paths.some((w) => !w.protected && /UserService\.java:4/.test(w.where)) && by("Exactly one IT Admin per tenant").write_paths.some((w) => w.protected), JSON.stringify(by("Exactly one IT Admin per tenant").write_paths));
    check("a DTO mapper is not a write path", !by("Exactly one IT Admin per tenant").write_paths.some((w) => /Mapper/.test(w.where)));
    const v = relevantInvariants(cat, { terms: ["tenant"], code_root: code, violated: [by("Unique email").id] });
    check("VIOLATED only when the reviewer names the invariant, and it outranks everything", v.items[0].classification === "VIOLATED" && v.items[0].id === by("Unique email").id);
    const sorted = res.items.map((i) => i.classification);
    check("the report lists NOT DEMONSTRATED before PROPOSED before CONFIRMED", sorted.indexOf("NOT DEMONSTRATED") < sorted.indexOf("PROPOSED") && sorted.indexOf("PROPOSED") < sorted.indexOf("CONFIRMED"), sorted.join());
    const txt = renderInvariants(res);
    check("the rendered catalog shows SOURCE, EVIDENCE, WRITE PATHS and ENFORCEMENT TYPE per invariant, grouped by domain", /## Tenant/.test(txt) && /## User/.test(txt) && /SOURCE:/.test(txt) && /EVIDENCE:/.test(txt) && /WRITE PATHS:/.test(txt) && /ENFORCEMENT TYPE:/.test(txt));
    const none = relevantInvariants(cat, { terms: ["scheduler cron"], code_root: code });
    check("an unrelated change retrieves no invariants (no padding)", none.items.length === 0);
    check("an empty catalog says every invariant is inferred", /empty.*inferred/.test(renderInvariants(relevantInvariants(tmp(), { terms: ["tenant"] }))));
    check("classify: a violation outranks status and enforcement", classify("accepted", null, true).cls === "VIOLATED");
    const cands = candidateInvariants(ds);
    check("candidate invariants are suggested from decisions, as text only, and no entry is written", cands.some((c) => /prohibited/i.test(c.text)) && loadKnowledge(ws).entries.filter((e) => e.category === "invariants").length === 0);
}

// ── confidence ───────────────────────────────────────────────────────────────────────────────
{
    const strong = scoreConfidence({ invariants_confirmed: 4, cross_service_scan: "complete", test_evidence: "ran_and_passed", db_constraints: "verified", concurrency: "covered", lifecycle: "covered", authority: "covered", unverified: 0, requires_decision: 0 });
    check("everything examined with evidence: HIGH", strong.level === "HIGH" && strong.score >= 80, strong.explanation);
    const blind = scoreConfidence({ findings_count: 0 });
    check("nothing examined: LOW, and 'no findings' is not read as trust", blind.level === "LOW" && /not evidence of correctness/.test(blind.explanation), blind.explanation);
    const stale = scoreConfidence({ ...{ invariants_confirmed: 4, cross_service_scan: "complete", test_evidence: "ran_and_passed", db_constraints: "verified", concurrency: "covered", lifecycle: "covered", authority: "covered" }, stale: true });
    check("a stale review is LOW even with perfect evidence", stale.level === "LOW" && stale.caps.some((c) => /STALE/.test(c)));
    const trig = scoreConfidence({ pessimistic_trigger_fired: true, cross_service_scan: "not_run", invariants_confirmed: 3, test_evidence: "ran_and_passed", db_constraints: "verified", concurrency: "covered", lifecycle: "covered", authority: "covered" });
    check("a pessimistic story with no cross-service scan is LOW", trig.level === "LOW");
    const dec = scoreConfidence({ invariants_confirmed: 4, cross_service_scan: "complete", test_evidence: "ran_and_passed", db_constraints: "verified", concurrency: "covered", lifecycle: "covered", authority: "covered", requires_decision: 1 });
    check("one open REQUIRES_DECISION caps a strong review at MEDIUM", dec.level === "MEDIUM" && dec.caps.some((c) => /await a person/.test(c)), dec.explanation);
    const inferred = scoreConfidence({ invariants_confirmed: 1, invariants_inferred: 4, cross_service_scan: "complete", test_evidence: "ran_and_passed", db_constraints: "verified", concurrency: "covered", lifecycle: "covered", authority: "covered" });
    check("more inferred invariants than confirmed caps at MEDIUM", inferred.level === "MEDIUM");
    const viol = scoreConfidence({ invariants_confirmed: 5, invariants_violated: 1, cross_service_scan: "complete", test_evidence: "ran_and_passed", db_constraints: "verified", concurrency: "covered", lifecycle: "covered", authority: "covered" });
    check("a found violation caps at MEDIUM", viol.level === "MEDIUM");
    const many = scoreConfidence({ invariants_confirmed: 5, cross_service_scan: "complete", test_evidence: "ran_and_passed", db_constraints: "verified", concurrency: "covered", lifecycle: "covered", authority: "covered", requires_decision: 3 });
    check("three open decisions: LOW", many.level === "LOW");
    const na = scoreConfidence({ invariants_confirmed: 2, cross_service_scan: "n/a", test_evidence: "ran_and_passed", db_constraints: "n/a", concurrency: "n/a", lifecycle: "n/a", authority: "n/a" });
    check("dimensions that do not apply are excluded, not counted as gaps", na.level === "HIGH" && na.dimensions.filter((d) => d.score === null).length === 5, na.explanation);
    check("the explanation names each dimension and what would raise confidence", /Cross-service scan/.test(dec.explanation) && /CONFIDENCE SCORE: MEDIUM/.test(dec.explanation) && /CONFIDENCE EXPLANATION:/.test(dec.explanation) && /To raise confidence:/.test(blind.explanation));
}

process.exit(failures ? 1 : 0);
