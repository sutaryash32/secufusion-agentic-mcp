import fs from "fs";
import os from "os";
import path from "path";
import { extractClaims, buildLedger } from "./claims_ledger.js";
import { buildMatrix, scoreMatrix, applyVerdicts } from "./edge_matrix.js";
import { gatherProductCells, gatherImpliedClaims } from "./product_context.js";
import { createEntry } from "./project_knowledge.js";
import { checkPlatformFacts, parseDocTopics } from "./platform_facts.js";

/** Claims ledger, edge matrix and platform facts: does the story match the code, and the instructions match reality? */

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + detail}`);
    if (!cond) failures++;
}
const mk = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const write = (root: string, rel: string, content: string) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };

// ============================================================ 1. claim extraction
{
    const story = `# Transfer ownership
As an IT Admin I want to hand my role to another user.

## Acceptance criteria
- Given I am the current IT Admin, when I transfer ownership to an active user in my tenant, then that user becomes the IT Admin and I lose the role.
- A user from another tenant must never be accepted as the new owner.
- The transfer is written to the audit log within 2 seconds.

## Context
Currently the export includes inactive users.
We assume the tenant email is always set.
Decided: the previous owner keeps their groups.
`;
    const c = extractClaims(story);
    const kind = (re: RegExp) => c.find((x) => re.test(x.text))?.kind;
    check("claims: acceptance criteria, including a given/when/then triple, are extracted as acceptance", c.length >= 6 && kind(/Given I am the current IT Admin/) === "acceptance" && kind(/another tenant must never/) === "acceptance", JSON.stringify(c.map((x) => [x.kind, x.text.slice(0, 30)])));
    check("claims: a non-functional criterion is recognised", kind(/audit log within 2 seconds/) === "nonfunctional");
    check("claims: reality, assumption and decision statements are told apart", kind(/Currently the export/) === "reality" && kind(/We assume the tenant email/) === "assumption" && kind(/previous owner keeps/) === "decision");
    check("claims: ids are stable and unique", new Set(c.map((x) => x.id)).size === c.length && c[0].id === "C1");
}

// ============================================================ 2. the ledger, both directions
{
    const ws = mk("led-");
    write(ws, "src/Transfer.java", Array.from({ length: 30 }, (_, i) => i === 11 ? "        owner.setDefaultUser(false); // handover" : i === 13 ? "        requireSameTenant(newOwner);" : `// line ${i + 1}`).join("\n"));
    write(ws, "src/TransferTest.java", "class TransferTest {\n  @Test void handsOver() { }\n  @Test void refusesOtherTenant() { }\n}\n");
    write(ws, "src/Export.java", "class Export {\n  List<User> all() { return repo.findAll(); }\n}\n");
    write(ws, "src/Extra.java", "class Extra {\n  void sideEffect() { cache.clear(); }\n}\n");
    write(ws, "src/Email.java", "class Email {\n  String of(Tenant t) { return t.getEmail(); }\n}\n");

    const claims = [
        { id: "C1", text: "the new owner becomes IT Admin and I lose the role", kind: "acceptance" as const },
        { id: "C2", text: "another tenant's user is never accepted", kind: "acceptance" as const },
        { id: "C3", text: "the transfer is written to the audit log", kind: "acceptance" as const },
        { id: "C4", text: "an inactive user cannot receive ownership", kind: "acceptance" as const },
        { id: "C5", text: "currently the export includes inactive users", kind: "reality" as const },
        { id: "C6", text: "currently the export is filtered to active users", kind: "reality" as const },
        { id: "C7", text: "we assume the tenant email is always set", kind: "assumption" as const },
    ];
    const evidence = [
        { claim_id: "C1", relation: "implements" as const, file: "src/Transfer.java", line: 12, quote: "owner.setDefaultUser(false)" },
        { claim_id: "C1", relation: "tests" as const, file: "src/TransferTest.java", line: 2, quote: "handsOver" },
        { claim_id: "C2", relation: "implements" as const, file: "src/Transfer.java", line: 14, quote: "requireSameTenant(newOwner)" },
        // C3: nothing at all
        { claim_id: "C4", relation: "implements" as const, file: "src/Transfer.java", line: 20, quote: "if (!newOwner.isActive()) throw" }, // not in the file
        { claim_id: "C5", relation: "supports" as const, file: "src/Export.java", line: 2, quote: "repo.findAll()" },
        { claim_id: "C6", relation: "contradicts" as const, file: "src/Export.java", line: 2, quote: "repo.findAll()" },
        { claim_id: "C9", relation: "supports" as const, file: "src/Export.java", line: 2, quote: "repo.findAll()" }, // unknown claim
    ];
    const changed = { "src/Transfer.java": [[10, 20]] as Array<[number, number]>, "src/Extra.java": [[2, 2]] as Array<[number, number]>, "src/TransferTest.java": [[1, 4]] as Array<[number, number]>, "README.md": [[1, 3]] as Array<[number, number]> };
    const l = buildLedger(ws, { claims, evidence, changed });
    const st = Object.fromEntries(l.claims.map((c) => [c.id, c.status]));
    check("ledger: implemented and tested with confirmed citations is VERIFIED", st.C1 === "VERIFIED", JSON.stringify(l.claims[0]));
    check("ledger: implemented with no test is IMPLEMENTED_UNTESTED", st.C2 === "IMPLEMENTED_UNTESTED");
    check("ledger: a claim with nothing behind it is NO_EVIDENCE (written, not built)", st.C3 === "NO_EVIDENCE");
    check("ledger: evidence whose quote is not in the file does not count: UNVERIFIABLE", st.C4 === "UNVERIFIABLE");
    check("ledger: a reality claim is VERIFIED by supporting code, and CONTRADICTED by contradicting code", st.C5 === "VERIFIED" && st.C6 === "CONTRADICTED");
    check("ledger: an unchecked assumption is UNVERIFIED, not assumed true", st.C7 === "UNVERIFIED");
    check("ledger: evidence for a claim that does not exist is reported", l.unknown_claim_ids.join() === "C9");
    check("ledger: the diff is mapped back: a changed region no claim accounts for is BUILT_NOT_WRITTEN; tests, docs and claimed regions are not",
        l.unclaimed_changes.length === 1 && l.unclaimed_changes[0].file === "src/Extra.java" && l.gaps.some((g) => g.type === "BUILT_NOT_WRITTEN" && /Extra\.java/.test(g.ref)), JSON.stringify(l.unclaimed_changes));
    const types = l.gaps.map((g) => `${g.severity}:${g.type}:${g.ref}`);
    check("ledger: gaps rank contradictions and unbuilt acceptance criteria as BLOCKER, untested as WARNING",
        types.includes("BLOCKER:CONTRADICTED:C6") && types.includes("BLOCKER:WRITTEN_NOT_BUILT:C3") && types.includes("BLOCKER:WRITTEN_NOT_BUILT:C4") && types.includes("WARNING:UNTESTED:C2") && l.gaps[0].severity === "BLOCKER", types.join(" | "));
    check("ledger: counts add up", Object.values(l.counts).reduce((a, b) => a + b, 0) === claims.length);
    const noDiff = buildLedger(ws, { claims, evidence });
    check("ledger: without a diff the reverse check is skipped and says so", !noDiff.diff_known && noDiff.unclaimed_changes.length === 0 && noDiff.notes.some((n) => /reverse check/.test(n)));
    const weak = buildLedger(ws, { claims: [claims[0]], evidence: [{ claim_id: "C1", relation: "implements", file: "src/Transfer.java", line: 12 }] });
    check("ledger: evidence with no quote is not enough to verify a claim", weak.claims[0].status === "UNVERIFIABLE", weak.claims[0].status);
    const outside = buildLedger(ws, { claims: [claims[0]], evidence: [evidence[0], evidence[1]], changed: { "src/Elsewhere.java": [[1, 2]] } });
    check("ledger: implementing code outside the change is noted", /outside the change/.test(outside.claims[0].why), outside.claims[0].why);
}

// ============================================================ 3. the edge matrix: product-aware, ranked, reasoned
{
    const ws = mk("mx-");
    // the project's own memory
    createEntry(ws, { category: "invariants", title: "Exactly one IT Admin per tenant", body: "A tenant must always have exactly one active IT Admin.", tags: ["it-admin", "tenant", "ownership", "owner"], source: "BUG-1288", status: "accepted", extra: { fields: "defaultUser", enforcement: "code check only", write_paths: "UserService.transferOwnership, UserService.deleteUser" } });
    createEntry(ws, { category: "invariants", title: "A user belongs to one tenant", body: "A user row has exactly one tenant.", tags: ["user", "tenant"], source: "guess", status: "proposed" });
    createEntry(ws, { category: "decisions", title: "Previous owner keeps their groups after a transfer", body: "Decided with the product owner.", tags: ["ownership", "transfer", "groups", "owner"], source: "UD-8", status: "accepted", extra: { guardrail: "transfer never removes group membership" } });
    createEntry(ws, { category: "lessons-learned", title: "Deleting an owner did not re-check the owner guard", body: "The delete path skipped the guard the transfer path had.", tags: ["ownership", "delete", "owner"], source: "BUG-1301", status: "accepted" });
    createEntry(ws, { category: "known-exceptions", title: "System principals bypass authorization", body: "Intentional: scheduler jobs run as the system.", tags: ["authorization", "owner"], source: "ADR-4", status: "accepted" });
    // the code that exists
    write(ws, "svc/src/main/java/com/x/UserService.java", `package com.x;
public class UserService {
    public void transferOwnership(String tenantId, Long newOwner) {
        owner.setDefaultUser(false);
        next.setDefaultUser(true);
    }
    public void deleteUser(Long id) {
        repo.deleteById(id);
    }
    public void disableUser(Long id) {
        user.setStatus("DISABLED");
    }
}
`);
    write(ws, "svc/src/main/java/com/x/ParentChainAuthorizer.java", `package com.x;
public class ParentChainAuthorizer {
    public boolean canAct(User u) {
        if (u.isDefaultUser()) { return true; }
        return false;
    }
}
`);
    const entry = { name: "POST /api/owners/transfer", inputs: [{ name: "newOwnerId", type: "uuid" }, { name: "tenantId", type: "uuid" }, { name: "reason", type: "string" }, { name: "effectiveAt", type: "datetime" }, { name: "message", type: "string" }], states: ["ACTIVE", "SUSPENDED"], operations: ["transfer"], roles: ["IT_ADMIN", "USER"], external_calls: ["keycloak"], messaging: true, writes_data: true };
    const pc = gatherProductCells(ws, { entries: [entry], entities: ["User"], flags: ["defaultUser"], terms: ["ownership", "owner"], story_text: "Transfer ownership of the tenant to another user." });
    const area = (re: RegExp) => pc.cells.filter((c) => re.test(c.area));
    const inv = area(/^invariant exactly-one/)[0];
    check("product: an accepted invariant becomes a high-risk question that names its source, its fields and the enforcement the project recorded",
        !!inv && inv.risk === 9 && /\.mcp\/invariants\/exactly-one/.test(inv.source) && /code check only/.test(inv.edge) && /defaultUser/.test(inv.edge) && /transferOwnership/.test(inv.edge) && inv.origin === "PRODUCT", JSON.stringify(inv));
    check("product: a proposed invariant is a lower-risk HINT, not a rule", (() => { const p = area(/^invariant a-user-belongs/)[0]; return !!p && p.risk === 6 && /proposed/.test(p.why); })());
    check("product: decisions, lessons and known exceptions each become their own kind of question", (() => { const d = area(/^decision /)[0], l = area(/^lesson /)[0], k = area(/^known exception/)[0]; return !!d && d.risk === 8 && /transfer never removes group membership/.test(d.edge) && !!l && l.risk === 8 && /repeat/.test(l.edge) && !!k && k.risk === 5 && /intentional exception/.test(k.edge); })(), JSON.stringify(pc.cells.map((c) => c.area)));
    const del = pc.cells.find((c) => /lifecycle User\.delete/.test(c.area));
    check("product: a lifecycle path in the code that never mentions the flag is a top-risk question with file:line", !!del && del.risk === 9 && del.origin === "CODE" && /UserService\.java:\d+/.test(del.source) && /never mentions defaultUser/.test(del.edge), JSON.stringify(pc.cells.filter((c) => /lifecycle/.test(c.area)).map((c) => [c.area, c.risk])));
    check("product: a path that does not exist is a question, not a clean bill", pc.cells.some((c) => /lifecycle User\.restore/.test(c.area) && /No restore path/.test(c.edge)));
    check("product: knowledge and code that were used are reported", pc.knowledge_used.length >= 4 && pc.knowledge_used.some((k) => k.category === "invariants" && k.status === "accepted"));

    const custom = [{ entry: entry.name, area: "support", edge: "A support engineer fixes the owner by hand in the database while a transfer is in flight", why: "support does this weekly (BUG-1301); no code path guards direct writes", risk: 9 }, { area: "x", edge: "too vague", why: "no" }];
    const opts = { product: pc.cells, custom, flags: ["defaultUser"], terms: ["owner"] };
    const { cells } = buildMatrix([entry], opts);
    check("matrix: cells are ranked by risk, product / code / model cells before the generic baseline", cells[0].risk >= 9 && cells.slice(0, 4).every((c) => c.origin !== "BASELINE") && (() => { const firstBase = cells.findIndex((c) => c.origin === "BASELINE"); return cells.slice(0, firstBase).every((c) => c.risk >= cells[firstBase].risk); })());
    check("matrix: a custom cell must say why it is suspected; one that does not is ignored", cells.some((c) => c.origin === "MODEL" && /support engineer/.test(c.edge) && c.risk === 9) && !cells.some((c) => /too vague/.test(c.edge)));
    check("matrix: a baseline edge on a field the product cares about is ranked up", (() => { const hot = buildMatrix([{ name: "e", inputs: [{ name: "defaultUser", type: "boolean" }, { name: "plainFlag", type: "boolean" }] }], { flags: ["defaultUser"] }).cells; const a = hot.find((c) => /defaultUser/.test(c.area))!, b = hot.find((c) => /plainFlag/.test(c.area))!; return a.risk > b.risk && /product cares/.test(a.why ?? ""); })());
    check("matrix: a string called 'message' is text, not a number (type beats a misleading name); ids are text edges", cells.some((c) => /input message/.test(c.area) && /emoji/.test(c.edge)) && !cells.some((c) => /input message/.test(c.area) && /overflow/.test(c.edge)) && cells.some((c) => /input newOwnerId/.test(c.area) && /another tenant/.test(c.edge)));
    check("matrix: state x operation, role, external call, messaging, concurrency, data age and deployment edges exist as baseline",
        ["transfer while the entity is SUSPENDED", "USER attempts transfer", "call times out", "delivered twice", "submitted twice at once", "legacy rows", "old and the new version run at once"].every((s) => cells.some((c) => c.edge.includes(s) && c.origin === "BASELINE")));
    check("matrix: ids are stable when a cell is added, so earlier answers still apply", (() => { const before = buildMatrix([entry], { product: pc.cells }).cells; const after = buildMatrix([entry], { product: pc.cells, custom }).cells; return before.every((c) => after.some((d) => d.id === c.id && d.edge === c.edge)); })());
    const wide = [entry, { ...entry, name: "b" }, { ...entry, name: "c" }];
    const full = buildMatrix(wide, { product: pc.cells }).cells, cut = buildMatrix(wide, { product: pc.cells, max_cells: 50 });
    const keptIds = new Set(cut.cells.map((c) => c.id)), dropped = full.filter((c) => !keptIds.has(c.id));
    check("matrix: when the matrix is cut, the lowest-risk cells go first and no kept cell is riskier-than-nothing dropped", cut.truncated && dropped.length > 0 && Math.max(...dropped.map((c) => c.risk)) <= Math.min(...cut.cells.map((c) => c.risk)) && cut.cells.every((c) => c.risk >= 6), `kept min ${Math.min(...cut.cells.map((c) => c.risk))}, dropped max ${Math.max(...dropped.map((c) => c.risk))}`);

    // answering
    write(ws, "svc/src/main/java/com/x/Guard.java", "class Guard {\n  void ensureOwner(Tenant t) { requireSingleActiveOwner(t); }\n}\n");
    const top = cells.find((c) => c.origin === "PRODUCT" && /exactly-one/.test(c.area))!;
    const code = cells.find((c) => c.origin === "CODE")!;
    const base = cells.filter((c) => c.origin === "BASELINE" && c.risk <= 4);
    const good = { file: "svc/src/main/java/com/x/Guard.java", line: 2, quote: "requireSingleActiveOwner(t)" };
    const chain = "The invariant is enforced only in code: Guard.ensureOwner is called from transfer but deleteUser never calls it, so the delete path can leave zero owners.";
    const r = scoreMatrix(ws, [entry], [
        { cell_id: top.id, status: "COVERED", reasoning: "fine", evidence: good },                       // a label, not reasoning
        { cell_id: code.id, status: "NOT_APPLICABLE", why: "n/a" },                                          // a label, not a reason
        { cell_id: cells.find((c) => c.origin === "MODEL")!.id, status: "GAP", reasoning: chain, scenario: "support writes owner_id while transfer runs; both commit; the tenant has two owners" },
        { bulk: { origin: "BASELINE", max_risk: 4 }, status: "NOT_APPLICABLE", why: "the DTO validates length, charset and ranges at the boundary (UserDto.java), so these edges cannot reach the service" },
    ], opts);
    check("answers: a high-risk cell answered with a label instead of reasoning is weak, and so is a bare NOT_APPLICABLE", r.weak.some((w) => w.id === top.id && /written reasoning/.test(w.problem)) && r.weak.some((w) => w.id === code.id && /real reason/.test(w.problem)), JSON.stringify(r.weak.map((w) => w.problem)));
    check("answers: a reasoned GAP counts, with its scenario", r.gaps.length === 1 && /two owners/.test(r.gaps[0].reasoning ?? ""));
    check("answers: one reason can cover many baseline cells in bulk", base.length > 5 && r.answered >= base.length + 3 && base.every((b) => !r.unanswered.some((u) => u.id === b.id)));
    const sound = scoreMatrix(ws, [entry], [{ cell_id: top.id, status: "COVERED", reasoning: chain.replace("deleteUser never calls it", "deleteUser calls it too"), evidence: good }], opts);
    check("answers: reasoning plus evidence that is in the code is a sound answer; the attention number counts only high-risk cells", sound.weak.length === 0 && sound.attention.high_risk_sound === 1 && sound.attention.high_risk_total > 5 && sound.high_risk_unanswered.length === sound.attention.high_risk_total - 1);
    const fake = scoreMatrix(ws, [entry], [{ cell_id: top.id, status: "COVERED", reasoning: chain, evidence: { file: "svc/src/main/java/com/x/Guard.java", line: 2, quote: "preventTwoOwners(t)" } }], opts);
    check("answers: evidence that is not in the code makes the answer weak", fake.weak.some((w) => w.id === top.id && /not in the code/.test(w.problem)));

    // a model's reasoning, applied only as far as its evidence checks out
    const v = applyVerdicts(ws, cells, [
        { cell_id: top.id, verdict: "HOLDS", reasoning: "ensureOwner runs on every write path", evidence: [good] },
        { cell_id: code.id, verdict: "HOLDS", reasoning: "the guard is somewhere", evidence: [{ file: "svc/src/main/java/com/x/Guard.java", line: 2, quote: "doesNotExist()" }] },
        { cell_id: cells.find((c) => c.origin === "MODEL")!.id, verdict: "VIOLATED", reasoning: "direct writes skip the guard", scenario: "support edits owner_id mid-transfer", evidence: [good] },
        { cell_id: cells[5].id, verdict: "UNKNOWN", reasoning: "needs the live schema" },
        { cell_id: "Enope", verdict: "HOLDS", reasoning: "x" },
    ]);
    const st = Object.fromEntries(v.answers.map((a) => [a.cell_id, a.status]));
    check("reasoning: a HOLDS with verified evidence is COVERED, a HOLDS with evidence that is not in the code is only DEFERRED", st[top.id] === "COVERED" && st[code.id] === "DEFERRED", JSON.stringify(st));
    check("reasoning: a VIOLATED becomes a GAP with its scenario, an UNKNOWN stays open, a verdict for a cell that does not exist is ignored", st[cells.find((c) => c.origin === "MODEL")!.id] === "GAP" && st[cells[5].id] === "DEFERRED" && v.notes.some((n) => /unknown cell Enope/.test(n)));

    // product-aware claims: what the story does not say
    const story = "Transfer ownership of the tenant to another user. The new owner becomes the IT Admin.";
    const imp = gatherImpliedClaims(ws, { entries: [], entities: ["User"], flags: ["defaultUser"], terms: ["ownership"], story_text: story });
    check("claims: the accepted invariant and decision the story does not state are added as IMPLIED claims with their source", imp.claims.some((c) => c.kind === "implied" && /Exactly one IT Admin/.test(c.text) && /\.mcp\/invariants/.test(c.source ?? "")) && imp.claims.some((c) => c.kind === "implied" && /Previous owner keeps/.test(c.text)));
    check("claims: lifecycle paths the story never mentions are SILENT claims; a path the story does mention is not", imp.claims.some((c) => c.kind === "silent" && /User delete/.test(c.text)) && !imp.claims.some((c) => c.kind === "silent" && /User transfer/.test(c.text)), JSON.stringify(imp.claims.map((c) => c.kind + ":" + c.text.slice(0, 40))));
    const lc = buildLedger(ws, { claims: imp.claims.map((c, i) => ({ id: `P${i + 1}`, ...c })), evidence: [{ claim_id: "P1", relation: "supports", ...good }] });
    check("claims: an implied claim nobody checked is a WARNING gap, a silent one is a decision for the user, and showing the change preserves it VERIFIES it",
        lc.claims[0].status === "VERIFIED" && lc.gaps.some((g) => g.type === "PRODUCT_REQUIRES_UNCHECKED") && lc.gaps.some((g) => g.type === "STORY_SILENT" && /decision/.test(g.text)), JSON.stringify(lc.gaps.map((g) => g.type)));

    // no product memory: say so, do not pretend
    const bare = mk("bare-");
    const none = gatherProductCells(bare, { entries: [entry], entities: ["User"], flags: ["defaultUser"] });
    const bareMatrix = scoreMatrix(bare, [entry], [], { product: none.cells });
    check("matrix: with no project knowledge the tool says the matrix is only the generic baseline", none.notes.some((n) => /no \.mcp\/ project knowledge/.test(n)) && bareMatrix.notes.some((n) => /only the generic baseline/.test(n)));
}

// ============================================================ 4. platform facts
{
    const ws = mk("pf-");
    write(ws, "AGENTS.md", `# Platform
| Topic | Producer | Consumer |
|---|---|---|
| \`device-registration\` | \`sfn-iam-api\` | \`sfn-events-api\` |
| \`extension-policy-changed\` | \`sfn-tenants-api\` | \`sfn-events-api\` |
| \`policy-events\` | \`sfn-policy-api\` | **NO LIVE CONSUMER** |
| \`ghost-topic\` | \`sfn-iam-api\` | \`sfn-events-api\` |

Migrations live in \`src/main/resources/db/migration/\`. State is in \`.secufusion-gone.json\`.
Services: sfn-iam-api, sfn-events-api, sfn-tenants-api, sfn-policy-api, sfn-ghost-api.
`);
    write(ws, "sfn-iam-api/pom.xml", "<project/>");
    write(ws, "sfn-iam-api/src/main/resources/db/migration/V1__x.sql", "select 1;");
    write(ws, "sfn-iam-api/src/main/java/Prod.java", `class Prod { void go() { kafkaTemplate.send("device-registration", payload); } }\n`);
    write(ws, "sfn-events-api/requirements.txt", "kafka-python\n");
    write(ws, "sfn-events-api/app/consumer.py", `from kafka import KafkaConsumer\nconsumer = KafkaConsumer('device-registration', bootstrap_servers='x')\n`);
    write(ws, "sfn-policy-api/package.json", "{}");
    write(ws, "sfn-policy-api/src/prod.ts", `await producer.send({ topic: 'extension-policy-changed', messages: [] });\nawait producer.send({ topic: 'policy-events', messages: [] });\n`);
    write(ws, "sfn-tenants-api/go.mod", "module x\n");
    write(ws, "sfn-tenants-api/consume.go", `package main\nfunc f() { c.ConsumePartition("policy-events", 0, 0) }\n`);
    write(ws, "sfn-audit/AuditSender.csproj", "<Project/>");
    write(ws, "sfn-audit/Send.cs", `class S { async Task Go() { await producer.ProduceAsync("audit-events", msg); } }\n`);

    check("facts: the topic table is parsed with producers and consumers", (() => { const t = parseDocTopics(fs.readFileSync(path.join(ws, "AGENTS.md"), "utf8")); return t.length === 4 && t[0].producers[0] === "sfn-iam-api" && t[0].consumers[0] === "sfn-events-api"; })());
    const r = checkPlatformFacts(ws, "AGENTS.md");
    const f = (type: string, subject?: string) => r.findings.filter((x) => x.type === type && (!subject || x.subject === subject));
    check("facts: a topic the document lists and the code matches raises nothing", r.findings.filter((x) => x.subject === "device-registration").length === 0, JSON.stringify(r.findings.filter((x) => x.subject === "device-registration")));
    check("facts: a producer the document attributes to the wrong service is a CONTRADICTION with file:line", (() => { const x = f("TOPIC_ROLE_MISMATCH", "extension-policy-changed")[0]; return !!x && x.severity === "CONTRADICTION" && /sfn-policy-api/.test(x.detail) && x.evidence.some((e) => /prod\.ts:1/.test(e)); })(), JSON.stringify(f("TOPIC_ROLE_MISMATCH")));
    check("facts: 'no live consumer' in the document while the code consumes the topic is a CONTRADICTION", f("TOPIC_ROLE_MISMATCH", "policy-events").some((x) => /no live consumer/.test(x.detail) && x.evidence.some((e) => /consume\.go:2/.test(e))), JSON.stringify(f("TOPIC_ROLE_MISMATCH", "policy-events")));
    check("facts: a topic only in the document is UNVERIFIED, never wrong", f("TOPIC_ONLY_IN_DOC", "ghost-topic")[0]?.severity === "UNVERIFIED");
    check("facts: a topic only in the code is reported as undocumented", f("TOPIC_ONLY_IN_CODE", "audit-events").length === 1);
    check("facts: a path the document names that exists is fine, one that does not is UNVERIFIED", f("PATH_MISSING", ".secufusion-gone.json").length === 1 && f("PATH_MISSING", "src/main/resources/db/migration").length === 0);
    check("facts: a service the document lists that is not in the workspace is a NOTE", f("SERVICE_NOT_IN_WORKSPACE", "sfn-ghost-api")[0]?.severity === "NOTE" && f("SERVICE_NOT_IN_WORKSPACE", "sfn-iam-api").length === 0);
    check("facts: findings are ordered with contradictions first", r.findings[0].severity === "CONTRADICTION");
    let refused = false; try { checkPlatformFacts(ws, "../../etc/hosts"); } catch { refused = true; }
    check("facts: a document outside the workspace is refused", refused);
}

console.log(failures === 0 ? "\nAll ledger, matrix and platform-fact checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
