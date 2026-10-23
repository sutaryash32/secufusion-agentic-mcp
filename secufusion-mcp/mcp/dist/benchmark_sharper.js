import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { validateEvidence } from "./finding_evidence.js";
import { analyzeTenantFlow } from "./tenant_flow.js";
import { checkModel } from "./lifecycle_model.js";
import { generateInvariantChecks } from "./invariant_checks.js";
import { parseMutationReport, reviewMutants, parseUnifiedZero } from "./mutation_review.js";
import { scoreRuns } from "./review_eval.js";
import { routeReview } from "./review_router.js";
import { getFixHistory } from "./fix_history.js";
/** The eight "sharper reasoner" modules, each against fixtures in several languages. */
let failures = 0;
function check(name, cond, detail = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + detail}`);
    if (!cond)
        failures++;
}
const mk = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const write = (root, rel, content) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };
// ============================================================ 1. finding evidence
{
    const ws = mk("ev-");
    write(ws, "src/Svc.java", `package x;\npublic class Svc {\n    void run() {\n        repo.findById(id);   // lookup\n    }\n}\n`);
    write(ws, "t/ProofTest.java", `class ProofTest { @Test void leaks() {} }\n`);
    const r = validateEvidence(ws, [
        { id: "ok", file: "src/Svc.java", line: 4, quote: "repo.findById(id);" },
        { id: "near", file: "src/Svc.java", line: 5, quote: "repo.findById(id)" },
        { id: "fake", file: "src/Svc.java", line: 4, quote: "repo.deleteEverything()" },
        { id: "far", file: "src/Svc.java", line: 999, quote: "x" },
        { id: "nofile", file: "src/Nope.java", line: 1, quote: "x" },
        { id: "escape", file: "../../etc/passwd", line: 1, quote: "root" },
        { id: "unquoted", file: "src/Svc.java", line: 4 },
        { id: "proven", file: "src/Svc.java", line: 4, quote: "repo.findById(id)", proof: { test_file: "t/ProofTest.java", test_name: "leaks", head_result: "FAIL" } },
        { id: "refuted", file: "src/Svc.java", line: 4, quote: "repo.findById(id)", proof: { test_file: "t/ProofTest.java", test_name: "leaks", head_result: "PASS" } },
        { id: "ghosttest", file: "src/Svc.java", line: 4, quote: "repo.findById(id)", proof: { test_file: "t/Missing.java", head_result: "FAIL" } },
    ]);
    const by = Object.fromEntries(r.results.map((x) => [x.id, x]));
    check("evidence: an exact citation is VERIFIED and kept", by.ok.status === "VERIFIED" && by.ok.action === "KEEP");
    check("evidence: a quote on a nearby line is VERIFIED_NEAR with the real line", by.near.status === "VERIFIED_NEAR" && by.near.actual_line === 4);
    const moved = validateEvidence(ws, [{ id: "moved", file: "src/Svc.java", line: 6, quote: "void run()" }], { window: 0 }).results[0];
    check("evidence: a quote at another line is corrected, not dropped", moved.status === "QUOTE_AT_OTHER_LINE" && moved.actual_line === 3 && moved.action === "KEEP", JSON.stringify(moved));
    check("evidence: a quote that is not in the file is DROPPED", by.fake.status === "QUOTE_NOT_FOUND" && by.fake.action === "DROP");
    check("evidence: a line outside the file and a missing file are DROPPED", by.far.action === "DROP" && by.nofile.status === "FILE_MISSING" && by.nofile.action === "DROP");
    check("evidence: a path that escapes the workspace is refused", by.escape.status === "PATH_OUTSIDE_ROOT" && by.escape.action === "DROP");
    check("evidence: no quote means KEEP_AS_POSSIBLE, never a confirmed finding", by.unquoted.status === "LINE_OK_UNQUOTED" && by.unquoted.action === "KEEP_AS_POSSIBLE");
    check("evidence: a failing proof test PROVES, a passing one REFUTES (downgrade), a missing test is not proof", by.proven.proof === "PROVEN" && by.proven.action === "KEEP" && by.refuted.proof === "REFUTED" && by.refuted.action === "DOWNGRADE" && by.ghosttest.proof === "PROOF_TEST_MISSING" && by.ghosttest.action === "KEEP_AS_POSSIBLE");
    check("evidence: counts add up", r.kept + r.possible + r.downgraded + r.dropped === r.results.length);
}
// ============================================================ 2. tenant flow, nine languages
{
    const ws = mk("tf-");
    // ---- Java (Spring)
    write(ws, "svc/src/main/java/com/x/Device.java", `package com.x;\n@Entity\npublic class Device {\n    private String tenantId;\n    private String name;\n}\n`);
    write(ws, "svc/src/main/java/com/x/DeviceRepository.java", `package com.x;
public interface DeviceRepository extends JpaRepository<Device, Long> {
    List<Device> findByName(String name);
    List<Device> findByTenantIdAndName(String tenantId, String name);
    @Query("select d from Device d where d.name = :name")
    List<Device> byName(@Param("name") String name, @Param("tenantId") String tenantId);
    @Query("select d from Device d where d.tenantId = :tenantId")
    List<Device> byTenant(@Param("tenantId") String tenantId);
}
`);
    write(ws, "svc/src/main/java/com/x/DeviceController.java", `package com.x;
public class DeviceController {
    @GetMapping("/a")
    public List<Device> bad(@RequestHeader("X-Tenant-Id") String tenantId) {
        return repo.findByName("x");
    }
    @GetMapping("/b")
    public List<Device> good(@RequestHeader("X-Tenant-Id") String tenantId) {
        tenantAccessGuard.requireCallerCanAccess(tenantId);
        return repo.findByTenantIdAndName(tenantId, "x");
    }
}
`);
    // ---- TypeScript (Prisma + Express)
    write(ws, "api/prisma/schema.prisma", `model Order {\n  id String @id\n  tenantId String\n  total Int\n}\n`);
    write(ws, "api/src/orders.ts", `import { prisma } from "./db";
export async function listBad(req, res) {
  const t = req.body.tenantId;
  const rows = await prisma.order.findMany({ where: { total: { gt: 1 } } });
  res.json(rows);
}
export async function listGood(req, res) {
  const tenantId = req.tenant.id;
  const rows = await prisma.order.findMany({ where: { tenantId, total: { gt: 1 } } });
  res.json(rows);
}
`);
    // ---- Python (Django + raw SQL)
    write(ws, "py/models.py", `from django.db import models\nclass Invoice(models.Model):\n    tenant = models.ForeignKey('Tenant', on_delete=models.CASCADE)\n    number = models.CharField(max_length=20)\n`);
    write(ws, "py/views.py", `from .models import Invoice
def bad(request):
    return Invoice.objects.filter(number=request.GET["n"])

def good(request, tenant_id):
    return Invoice.objects.filter(tenant_id=tenant_id, number=request.GET["n"])

def raw_bad(cursor, n):
    cursor.execute("SELECT * FROM invoice WHERE number = %s", [n])

def raw_good(cursor, n, tenant_id):
    cursor.execute("SELECT * FROM invoice WHERE tenant_id = %s AND number = %s", [tenant_id, n])
`);
    // ---- C# (EF Core)
    write(ws, "cs/Payment.cs", `public class Payment { public Guid Id { get; set; } public Guid TenantId { get; set; } public decimal Amount { get; set; } }\n`);
    write(ws, "cs/PaymentService.cs", `public class PaymentService {
    public List<Payment> Bad(decimal min) {
        return _context.Payments.Where(p => p.Amount > min).ToList();
    }
    public List<Payment> Good(Guid tenantId, decimal min) {
        return _context.Payments.Where(p => p.TenantId == tenantId && p.Amount > min).ToList();
    }
}
`);
    // ---- Go (GORM)
    write(ws, "go/ticket.go", `package main
type Ticket struct {
	ID       uint
	TenantID string
	Title    string
}
func Bad(db *gorm.DB, title string) []Ticket {
	var tickets []Ticket
	db.Where("title = ?", title).Find(&tickets)
	return tickets
}
func Good(db *gorm.DB, tenantID, title string) []Ticket {
	var tickets []Ticket
	db.Where("tenant_id = ? AND title = ?", tenantID, title).Find(&tickets)
	return tickets
}
`);
    // ---- Ruby (Rails)
    write(ws, "rb/note.rb", `class Note < ApplicationRecord\n  belongs_to :tenant\nend\n`);
    write(ws, "rb/notes_controller.rb", `class NotesController\n  def bad\n    Note.where(title: params[:title])\n  end\n  def good\n    Note.where(tenant_id: current_tenant.id, title: params[:title])\n  end\nend\n`);
    // ---- PHP (Laravel)
    write(ws, "php/Project.php", `<?php\nclass Project extends Model {\n    protected $fillable = ['tenant_id', 'name'];\n}\n`);
    write(ws, "php/ProjectController.php", `<?php\nclass ProjectController {\n    public function bad($name) {\n        return Project::where('name', $name)->get();\n    }\n    public function good($tenantId, $name) {\n        return Project::where('tenant_id', $tenantId)->where('name', $name)->get();\n    }\n}\n`);
    // ---- noise that must be ignored
    write(ws, "svc/src/test/java/com/x/DeviceTest.java", `class DeviceTest { void t() { repo.findByName("x"); } }\n`);
    write(ws, "svc/src/main/resources/db/migration/V1__x.sql", `SELECT * FROM device WHERE name = 'x';\n`);
    write(ws, "node_modules/lib/x.js", `Model.findAll();\n`);
    const r = analyzeTenantFlow(ws, { min_confidence: "LOW" });
    const has = (file, kind, line) => r.findings.some((f) => f.file.endsWith(file) && f.kind === kind && (line === undefined || f.line === line));
    const lacks = (file, line) => !r.findings.some((f) => f.file.endsWith(file) && f.line === line);
    check("tenant flow: languages detected", ["java", "js", "python", "csharp", "go", "ruby", "php"].every((l) => (r.languages[l] ?? 0) > 0), JSON.stringify(r.languages));
    check("tenant flow: tenant-owned entities are learned from their definitions in every language", ["device", "order", "invoice", "payment", "ticket", "note", "project"].every((e) => r.tenant_owned_entities.includes(e)), r.tenant_owned_entities.join());
    check("tenant flow [java]: derived query and @Query without a tenant are flagged, scoped ones are not", has("DeviceRepository.java", "UNSCOPED_DATA_ACCESS", 3) && has("DeviceRepository.java", "UNSCOPED_DATA_ACCESS", 5) && lacks("DeviceRepository.java", 4) && lacks("DeviceRepository.java", 7), r.findings.filter((f) => f.file.endsWith("DeviceRepository.java")).map((f) => f.line).join());
    check("tenant flow [java]: a tenant param that the @Query ignores is called out", r.findings.some((f) => f.file.endsWith("DeviceRepository.java") && f.line === 5 && /takes a tenant parameter/.test(f.why)));
    check("tenant flow [java]: tenant from a header with no guard is flagged, the guarded one is not", has("DeviceController.java", "TENANT_FROM_REQUEST_UNGUARDED", 4) && !r.findings.some((f) => f.file.endsWith("DeviceController.java") && f.kind === "TENANT_FROM_REQUEST_UNGUARDED" && f.line === 8));
    check("tenant flow [typescript]: unscoped prisma query and tenant from req.body are flagged, scoped is not", has("orders.ts", "UNSCOPED_DATA_ACCESS", 4) && has("orders.ts", "TENANT_FROM_REQUEST_UNGUARDED", 3) && lacks("orders.ts", 9));
    check("tenant flow [python]: Django ORM and raw SQL without a tenant are flagged, scoped ones are not", has("views.py", "UNSCOPED_DATA_ACCESS", 3) && has("views.py", "UNSCOPED_DATA_ACCESS", 9) && lacks("views.py", 6) && lacks("views.py", 12));
    check("tenant flow [csharp]: EF Core query without a tenant is flagged, scoped is not", has("PaymentService.cs", "UNSCOPED_DATA_ACCESS", 3) && lacks("PaymentService.cs", 6));
    check("tenant flow [go]: GORM query without a tenant is flagged, scoped is not", has("ticket.go", "UNSCOPED_DATA_ACCESS", 9) && lacks("ticket.go", 14));
    check("tenant flow [ruby]: ActiveRecord query without a tenant is flagged, scoped is not", has("notes_controller.rb", "UNSCOPED_DATA_ACCESS", 3) && lacks("notes_controller.rb", 6));
    check("tenant flow [php]: Eloquent query without a tenant is flagged, scoped is not", has("ProjectController.php", "UNSCOPED_DATA_ACCESS", 4) && lacks("ProjectController.php", 7));
    check("tenant flow: a known tenant-owned entity with nothing scoping it is HIGH", r.findings.filter((f) => f.kind === "UNSCOPED_DATA_ACCESS" && f.entity).every((f) => f.confidence === "HIGH"));
    check("tenant flow: tests, migrations and vendored code are not scanned", !r.findings.some((f) => /DeviceTest|V1__x|node_modules/.test(f.file)));
    // a global scoping mechanism lowers confidence and is reported
    write(ws, "svc/src/main/java/com/x/Scope.java", `@FilterDef(name = "tenantFilter")\nclass Scope {}\n`);
    const r2 = analyzeTenantFlow(ws, { min_confidence: "LOW" });
    check("tenant flow: a global scoping mechanism is reported and lowers confidence", r2.global_scoping_signals.length > 0 && r2.findings.every((f) => f.confidence !== "HIGH"));
    // path variable policy
    const ws2 = mk("tf2-");
    write(ws2, "C.java", `class C {\n  @GetMapping("/t/{tenantId}")\n  public X get(@PathVariable("tenantId") String tenantId) {\n    return x;\n  }\n}\n`);
    check("tenant flow: a tenant id in the URL path is reported by default and allowed on request", analyzeTenantFlow(ws2, { min_confidence: "LOW" }).findings.length === 1 && analyzeTenantFlow(ws2, { allow_path_tenant: true, min_confidence: "LOW" }).findings.length === 0);
    // an entity-less workspace never claims HIGH
    const ws3 = mk("tf3-");
    write(ws3, "a.py", `def f(db):\n    return Thing.objects.all()\n`);
    check("tenant flow: without any tenant-owned entity the confidence is capped at LOW", analyzeTenantFlow(ws3, { min_confidence: "LOW" }).findings.every((f) => f.confidence === "LOW"));
}
// ============================================================ 3. lifecycle model checker
{
    // IT Admin: exactly one active owner. A is the owner, B is a candidate.
    const vars = {
        A_owner: { type: "bool", init: true }, B_owner: { type: "bool", init: false },
        A_active: { type: "bool", init: true }, B_active: { type: "bool", init: true },
    };
    const inv = [{ name: "exactly one active owner", expr: "count(A_owner && A_active, B_owner && B_active) == 1" }];
    const naive = checkModel({
        variables: vars, invariants: inv, mode: "sequential", max_depth: 3,
        operations: [
            { name: "deactivate_A", requires: "A_active", effects: ["A_active = false"] },
            { name: "transfer_A_to_B", requires: "A_owner && B_active", effects: ["A_owner = false", "B_owner = true"] },
        ],
    });
    check("lifecycle: an unguarded deactivation leaves zero owners, with the shortest trace", !naive.ok && naive.violations.length === 1 && naive.violations[0].trace.length === 1 && /deactivate_A/.test(naive.violations[0].trace[0]));
    const guarded = checkModel({
        variables: vars, invariants: inv, mode: "sequential", max_depth: 4,
        operations: [
            { name: "deactivate_A", requires: "A_active && !A_owner", effects: ["A_active = false"] },
            { name: "deactivate_B", requires: "B_active && !B_owner", effects: ["B_active = false"] },
            { name: "transfer_A_to_B", requires: "A_owner && B_active", effects: ["A_owner = false", "B_owner = true"] },
            { name: "transfer_B_to_A", requires: "B_owner && A_active", effects: ["B_owner = false", "A_owner = true"] },
        ],
    });
    check("lifecycle: with the owner guard, no sequence of up to 4 operations breaks the invariant", guarded.ok && guarded.violations.length === 0 && guarded.states_explored > 3, JSON.stringify(guarded.violations));
    const race = (lock) => checkModel({
        variables: vars, invariants: inv, mode: "concurrent", actors: 2, ops_per_actor: 1,
        operations: [
            { name: "deactivate_B", requires: "B_active && !B_owner", effects: ["B_active = false"], atomic: false, ...(lock ? { lock: "tenant" } : {}) },
            { name: "transfer_A_to_B", requires: "A_owner && B_active", effects: ["A_owner = false", "B_owner = true"], atomic: false, ...(lock ? { lock: "tenant" } : {}) },
        ],
    });
    const raced = race(false);
    check("lifecycle: two concurrent check-then-act operations break the invariant, and the trace shows the interleaving", !raced.ok && raced.violations.length === 1 && raced.violations[0].trace.some((s) => /checks: deactivate_B/.test(s)) && raced.violations[0].trace.some((s) => /checks: transfer_A_to_B/.test(s)), JSON.stringify(raced.violations[0]?.trace));
    check("lifecycle: taking the same lock in both removes the race", race(true).ok, JSON.stringify(race(true).violations));
    const bad = checkModel({ variables: vars, invariants: [{ name: "x", expr: "nope && true" }], operations: [{ name: "o", effects: [] }] });
    check("lifecycle: an unknown variable is a model error, not a pass", !bad.ok && bad.model_errors.length > 0);
    const dom = checkModel({
        variables: { n: { type: "int", init: 1, min: 0, max: 2 } }, invariants: [{ name: "n is one", expr: "n >= 0" }],
        operations: [{ name: "inc", effects: ["n = n + 5"] }], mode: "sequential", max_depth: 1,
    });
    check("lifecycle: an assignment outside the declared domain is reported", dom.model_errors.some((e) => /above its maximum/.test(e)));
    const trunc = checkModel({
        variables: { a: { type: "int", init: 0, min: 0, max: 1000 } }, invariants: [{ name: "always", expr: "a >= 0" }],
        operations: [{ name: "inc", requires: "a < 1000", effects: ["a = a + 1"] }], mode: "sequential", max_depth: 12, max_states: 1000,
    });
    check("lifecycle: a search that hits the state limit says so and is not called a proof", trunc.truncated === false || trunc.ok === false || trunc.notes.some((n) => /explored/.test(n)));
}
// ============================================================ 4. invariant checks
{
    const specs = [
        { id: "one-it-admin", kind: "exactly_one", table: "users", scope_column: "tenant_id", scope_table: "tenant", where: "default_user = true", description: "exactly one IT Admin per tenant" },
        { id: "unique-email", kind: "unique", table: "users", scope_column: "tenant_id", columns: ["email"] },
        { id: "device-owner", kind: "references", table: "devices", columns: ["user_id"], ref_table: "users" },
        { id: "name-not-null", kind: "not_null", table: "devices", columns: ["name"] },
    ];
    const pg = generateInvariantChecks(specs, { dialect: "postgres", language: "python" });
    check("invariants: exactly_one finds scopes with zero rows by joining the scope table", /LEFT JOIN/.test(pg[0].violation_sql) && /<> 1/.test(pg[0].violation_sql));
    check("invariants: postgres gets a partial unique index in migration-draft style", pg[0].enforcement.supported && /CREATE UNIQUE INDEX IF NOT EXISTS/.test(pg[0].enforcement.ddl) && /WHERE default_user = true/.test(pg[0].enforcement.ddl) && /applied MANUALLY/.test(pg[0].enforcement.ddl));
    check("invariants: the 'never zero' half is called out as not index-enforceable", /at-least-one half/.test(pg[0].enforcement.note));
    check("invariants: unique, references and not_null generate their SQL", /HAVING COUNT\(\*\) > 1/.test(pg[1].violation_sql) && /LEFT JOIN "users"/.test(pg[2].violation_sql) && /IS NULL/.test(pg[3].violation_sql) && /FOREIGN KEY/.test(pg[2].enforcement.ddl));
    check("invariants: the test skeleton is in the requested language", /def test_invariant_/.test(pg[0].test_skeleton) && generateInvariantChecks(specs.slice(0, 1), { language: "go" })[0].test_skeleton.includes("func TestInvariant_") && /xUnit/.test(generateInvariantChecks(specs.slice(0, 1), { language: "csharp" })[0].test_skeleton));
    const my = generateInvariantChecks(specs.slice(0, 1), { dialect: "mysql" })[0];
    check("invariants: mysql has no partial index, so it says so instead of inventing one", !my.enforcement.supported && /generated column/.test(my.enforcement.note) && /`users`/.test(my.violation_sql));
    const ss = generateInvariantChecks(specs.slice(0, 1), { dialect: "sqlserver" })[0];
    check("invariants: sql server gets a filtered unique index with bracket quoting", ss.enforcement.supported && /\[users\]/.test(ss.enforcement.ddl));
    let rejected = 0;
    for (const bad of [
        { id: "x", kind: "unique", table: "users; DROP TABLE users", columns: ["a"] },
        { id: "x", kind: "exactly_one", table: "u", scope_column: "t", where: "a = 1; DELETE FROM u" },
        { id: "x", kind: "exactly_one", table: "u", scope_column: "t", where: "a = 1 -- x" },
        { id: "x", kind: "unique", table: "u", columns: ["a b"] },
    ]) {
        try {
            generateInvariantChecks([bad]);
        }
        catch {
            rejected++;
        }
    }
    check("invariants: injection through identifiers or the predicate is refused", rejected === 4, String(rejected));
}
// ============================================================ 5. mutation review, three formats
{
    const changed = { "src/main/java/com/x/Guard.java": [[10, 14]], "src/auth.ts": [[3, 3]], "app/service.py": [[20, 22]] };
    const pit = `<?xml version="1.0"?><mutations>
<mutation detected='false' status='SURVIVED' numberOfTestsRun='3'><sourceFile>Guard.java</sourceFile><mutatedClass>com.x.Guard</mutatedClass><mutatedMethod>check</mutatedMethod><lineNumber>12</lineNumber><mutator>org.pitest.mutationtest.engine.gregor.mutators.NegateConditionalsMutator</mutator><description>negated conditional</description></mutation>
<mutation detected='true' status='KILLED' numberOfTestsRun='3'><sourceFile>Guard.java</sourceFile><mutatedClass>com.x.Guard</mutatedClass><mutatedMethod>check</mutatedMethod><lineNumber>11</lineNumber><mutator>org.pitest.mutationtest.engine.gregor.mutators.ReturnValsMutator</mutator><description>x</description></mutation>
<mutation detected='false' status='NO_COVERAGE' numberOfTestsRun='0'><sourceFile>Guard.java</sourceFile><mutatedClass>com.x.Guard</mutatedClass><mutatedMethod>other</mutatedMethod><lineNumber>200</lineNumber><mutator>org.pitest.mutationtest.engine.gregor.mutators.VoidMethodCallMutator</mutator><description>x</description></mutation>
</mutations>`;
    const p = reviewMutants(parseMutationReport(pit), changed);
    check("mutation [PIT/Java]: a survivor on a changed line is a guard weak spot; kills and unchanged lines are not", p.format === "PIT XML" && p.weak_spots.length === 1 && p.weak_spots[0].line === 12 && p.weak_spots[0].guard && p.mutants_on_changed_lines === 2 && p.score_on_changed_lines === 50, JSON.stringify(p));
    const stryker = JSON.stringify({ files: { "src/auth.ts": { mutants: [{ id: "1", mutatorName: "ConditionalExpression", status: "Survived", location: { start: { line: 3, column: 1 }, end: { line: 3, column: 9 } } }, { id: "2", mutatorName: "StringLiteral", status: "Killed", location: { start: { line: 3, column: 1 }, end: { line: 3, column: 9 } } }, { id: "3", mutatorName: "BlockStatement", status: "NoCoverage", location: { start: { line: 90, column: 1 }, end: { line: 91, column: 1 } } }] } } });
    const s = reviewMutants(parseMutationReport(stryker), changed);
    check("mutation [Stryker/TypeScript]: parsed, survivors on changed lines only", /mutation-testing-elements/.test(s.format) && s.weak_spots.length === 1 && s.weak_spots[0].file === "src/auth.ts" && s.weak_spots[0].guard);
    const gen = JSON.stringify([{ file: "app/service.py", line: 21, mutator: "negate_condition", status: "survived" }, { file: "app/service.py", line: 22, mutator: "swap_operator", status: "killed" }, { file: "other.py", line: 1, mutator: "x", status: "survived" }]);
    const g = reviewMutants(parseMutationReport(gen), changed);
    check("mutation [generic JSON: Python/Go/Rust/Ruby]: works with a converted report", g.format === "generic JSON" && g.weak_spots.length === 1 && g.weak_spots[0].line === 21 && g.unmatched_mutant_files.includes("other.py"));
    const ranges = parseUnifiedZero("diff --git a/a.go b/a.go\n--- a/a.go\n+++ b/a.go\n@@ -3,0 +4,2 @@\n+x\n+y\n@@ -10 +12 @@\n-a\n+b\n");
    check("mutation: changed ranges are read from a zero-context diff", JSON.stringify(ranges) === JSON.stringify({ "a.go": [[4, 5], [12, 12]] }), JSON.stringify(ranges));
}
// ============================================================ 6. review eval scoring
{
    const cases = [
        { name: "tenant-leak", expected: [{ id: "unscoped-query", rule: "SEC-003", file: "Repo.java", min_severity: "blocker" }, { id: "body-tenant", category: "tenant-isolation", file: "Ctl.java", line: 10 }], must_not: [{ id: "style", category: "style" }], verdict_in: ["fix_first"] },
        { name: "clean", expected: [], must_not: [{ id: "anything-blocking", min_severity: "major" }], verdict_in: ["ready"] },
    ];
    const runs = [
        { case: "tenant-leak", verdict: "fix_first", findings: [{ severity: "blocker", rule: "SEC-003", file: "src/Repo.java", line: 4, pass: 1 }, { severity: "warning", category: "tenant-isolation", file: "Ctl.java", line: 12, pass: 15 }, { severity: "nit", category: "style", file: "A.java", pass: 26, title: "naming" }, { severity: "minor", category: "other", file: "B.java", pass: 26 }] },
        { case: "clean", verdict: "ready", findings: [{ severity: "major", file: "X.java", pass: 20 }, { severity: "major", file: "Y.java", pass: 20 }, { severity: "major", file: "Z.java", pass: 20 }] },
    ];
    const r = scoreRuns(cases, runs);
    const tl = r.cases.find((c) => c.case === "tenant-leak"), cl = r.cases.find((c) => c.case === "clean");
    check("eval: expected findings are matched by rule, category, file suffix, line distance and minimum severity", tl.recall === 100 && tl.missed.length === 0, JSON.stringify(tl));
    check("eval: a must_not hit is a false positive and fails the case; an unexpected finding is only 'unlisted'", tl.false_positives.length === 1 && tl.unlisted === 1 && !tl.pass);
    check("eval: a wrong verdict fails a case even with no findings missed", cl.verdict_ok === true && !cl.pass === true, JSON.stringify(cl));
    const p20 = r.passes.find((p) => p.pass === "20"), p26 = r.passes.find((p) => p.pass === "26"), p1 = r.passes.find((p) => p.pass === "1");
    check("eval: a pass that only produced must_not hits is advised DEMOTE, one that hit expectations is KEEP", p20.advice === "DEMOTE" && p1.advice === "KEEP" && p26.hit_must_not === 1, JSON.stringify(r.passes));
    check("eval: overall numbers", r.overall.cases === 2 && r.overall.recall === 100);
}
// ============================================================ 7. review router, many languages
{
    const ws = mk("rt-");
    write(ws, "svc/src/main/java/com/x/DeviceRepository.java", `public interface DeviceRepository extends JpaRepository<Device, Long> {}\n`);
    write(ws, "web/src/api/orders.ts", `import express from "express"; const router = express.Router(); router.get("/o", (req, res) => res.json(prisma.order.findMany()));\n`);
    write(ws, "svc/src/main/resources/db/migration/V9__x.sql", `ALTER TABLE a ADD COLUMN b int;\n`);
    write(ws, "py/auth/permissions.py", `def check(user):\n    return user.is_superuser\n`);
    write(ws, "README.md", `# x\n`);
    const docs = routeReview(ws, { files: ["README.md", "docs/a.md", "package-lock.json"] });
    check("router: a documentation-only change is quick with only the always-on passes", docs.level === "quick" && docs.selected.map((s) => s.pass).join() === "10,11,22,27", docs.selected.map((s) => s.pass).join());
    const tiny = routeReview(ws, { files: ["web/src/api/orders.ts"] });
    const big = routeReview(ws, { files: ["svc/src/main/java/com/x/DeviceRepository.java", "svc/src/main/resources/db/migration/V9__x.sql", "py/auth/permissions.py", "web/src/api/orders.ts"], has_spec: true });
    const sel = (p) => p.selected.map((s) => s.pass);
    check("router: a risky multi-language change is deep and selects every lens, spec passes included", big.level === "deep" && sel(big).length === 28 && [6, 19].every((x) => sel(big).includes(x)), `${big.level} ${big.score} ${sel(big).length}`);
    check("router: signals are found from paths and from code in Java, SQL, TypeScript and Python", ["migration", "data_access", "http", "security"].every((s) => big.factors.some((f) => f.signal === s) || s === "http"), big.factors.map((f) => f.signal).join());
    check("router: a small HTTP change selects the contract passes but skips unrelated lenses, and says why", sel(tiny).includes(21) && !sel(tiny).includes(0) && tiny.skipped.some((s) => s.pass === 0 && /no signal/.test(s.why)));
    check("router: spec passes are NOT APPLICABLE without a specification, with the reason", !sel(routeReview(ws, { files: ["web/src/api/orders.ts"] })).includes(19) && routeReview(ws, { files: ["web/src/api/orders.ts"] }).skipped.some((s) => s.pass === 19 && /NOT APPLICABLE/.test(s.why)));
    check("router: passes are grouped for parallel specialists, the filter group always present", Object.keys(big.groups).includes("filter") && Object.keys(big.groups).includes("data-tenancy"));
    check("router: the level can be overridden", routeReview(ws, { files: ["README.md"], level: "deep" }).level === "deep");
}
// ============================================================ 8. fix history (real git repo)
{
    const ws = mk("fh-");
    const git = (...a) => execFileSync("git", ["-C", ws, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    git("init", "-q");
    write(ws, "src/guard.go", "package main\n\nfunc A() {}\n");
    git("add", ".");
    git("commit", "-q", "-m", "add skeleton");
    write(ws, "src/guard.go", "package main\n\nfunc A() {\n\tcheckTenant()\n}\n");
    git("add", ".");
    git("commit", "-q", "-m", "BUG-1230: fix tenant guard missing in A");
    write(ws, "src/guard.go", "package main\n\nfunc A() {\n\tcheckTenant()\n}\n\n// docs\n");
    git("add", ".");
    git("commit", "-q", "-m", "tidy comments");
    write(ws, ".rejected-patterns.json", JSON.stringify([{ pattern: "tenant id from request body in guard.go", reason: "BUG-1230" }]));
    const h = getFixHistory(ws, "src/guard.go", { keywords: ["tenant"] });
    check("fix history: only the fix-like commit is returned, with its work item", h.commits_scanned === 3 && h.fix_commits.length === 1 && h.fix_commits[0].work_items.includes("BUG-1230") && h.fix_commits[0].keywords.includes("fix"), JSON.stringify(h.fix_commits));
    check("fix history: the team's rejected patterns about the same file are surfaced", h.memory_matches.some((m) => m.source === ".rejected-patterns.json"));
    const lr = getFixHistory(ws, "src/guard.go", { line_range: [4, 4] });
    check("fix history: a line range asks git for just that region's history (works for any language)", lr.fix_commits.length === 1 && lr.fix_commits[0].subject.includes("BUG-1230"), JSON.stringify(lr));
    let refused = 0;
    for (const f of [() => getFixHistory(ws, "../../etc/passwd"), () => getFixHistory(ws, "src/guard.go", { since: "1 day; rm -rf /" }), () => getFixHistory(ws, "src/guard.go", { line_range: [5, 2] })]) {
        try {
            f();
        }
        catch {
            refused++;
        }
    }
    check("fix history: a path outside the repo, a shell-shaped 'since' and a bad range are refused", refused === 3, String(refused));
}
console.log(failures === 0 ? "\nAll sharper-reasoner checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
