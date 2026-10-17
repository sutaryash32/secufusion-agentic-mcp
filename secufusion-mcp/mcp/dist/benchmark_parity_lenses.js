import fs from "fs";
import os from "os";
import path from "path";
import { uiGating, renderGating, endpointConsumers, renderEndpointConsumers, serviceOwnership, renderOwnership, parentCascade, renderCascade } from "./parity_lenses.js";
import { mapFieldImpact, renderFieldImpact } from "./field_impact.js";
/** The four lenses added to close observed client-parity misses, plus derived-value tracing in the field impact model. */
let failures = 0;
function check(name, cond, detail = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + detail}`);
    if (!cond)
        failures++;
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lens-"));
const put = (root, rel, text) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
const J = (...l) => l.join("\n") + "\n";
// ── UI gating: the server accepts an ancestor-tenant caller, the UI derives its gate from a list lookup ──────────────
{
    const r = tmp();
    put(r, "api/src/main/java/com/x/UserController.java", J("@RestController", "public class UserController {", "    @PostMapping(\"/{id}/transfer-ownership\")", "    @PreAuthorize(\"hasAuthority('user-access.update')\")", "    public Resp transferOwnership(", "            @PathVariable String id,", "            @RequestBody Req body) {", "        requireCallerCanAccessUser(id);", "        return userService.transferOwnership(id, body.newOwner(), caller.getId());", "    }", "}"));
    put(r, "api/src/main/java/com/x/UserService.java", J("public class UserService {", "    public List<UsersDto> transferOwnership(String a, String b, String callerId) {", "        boolean isPortalAdmin = caller.getMappedGroups().stream().anyMatch(g -> g.getIsAdmin() == 'Y');", "        if (!isPortalAdmin) { throw new AccessDeniedException(\"Only Portal Administrators can transfer ownership\"); }", "        if (!isSameOrAncestorTenant(caller.getTenant().getTenantID(), acting)) { throw new AccessDeniedException(\"no\"); }", "        return null;", "    }", "}"));
    put(r, "web/src/modules/IAM/Main.jsx", J("export default function Main({ users, permissions }) {", "  const canTransferOwnership = useMemo(() => {", "    if (!permissions.canEdit) return false;", "    const self = users.find((u) => isSelfRow(u));", "    return self ? isPortalAdminUser(self) : false;", "  }, [permissions.canEdit, users]);", "  const cols = [{ id: 'x', hidden: (row) => !row.defaultUser || !canTransferOwnership }];", "  return <TransferOwnershipDialog />;", "}"));
    const g = uiGating(r, { action: "transfer ownership", server_hint: "transfer-?ownership|transferOwnership", ui_hint: "TransferOwnership|canTransferOwnership" });
    check("server side: the entry point, the @PreAuthorize and the checks in the handler AND in the service method it calls", g.server.some((s) => s.kind === "entry" && /transfer-ownership/.test(s.where)) && g.server.some((s) => s.kind === "annotation") && g.server.some((s) => /requireCallerCanAccessUser/.test(s.where)) && g.server.some((s) => /isSameOrAncestorTenant/.test(s.where)) && g.server.some((s) => /Only Portal Administrators/.test(s.where)), JSON.stringify(g.server.map((s) => s.where.slice(0, 60))));
    check("UI side: the gate lines and the predicate with its list lookup, inputs and fallback", g.ui_gates.some((x) => /hidden:/.test(x.where)) && g.predicates.length === 1 && /users\.find/.test(g.predicates[0].list_lookup ?? "") && /: false/.test(g.predicates[0].fallback ?? "") && /users/.test(g.predicates[0].inputs), JSON.stringify(g.predicates));
    check("the question is raised: the server accepts callers outside the acting tenant but the UI predicate comes from a list lookup", g.questions.some((q) => /outside the acting tenant/.test(q) && /NOT in that list/.test(q)), JSON.stringify(g.questions));
    check("the fallback is shown, so a reviewer can see the parent admin is hidden the action", /fallback when nothing is found: return self \? isPortalAdminUser\(self\) : false/.test(renderGating(g)));
    const none = uiGating(r, { action: "x", server_hint: "noSuchAction", ui_hint: "NoSuchUi" });
    check("when nothing matches it says so instead of claiming the gates agree", none.questions.some((q) => /No server entry point matched/.test(q)) && none.questions.some((q) => /No UI gate matched/.test(q)));
}
// ── endpoint consumers: URL constants behind a gateway prefix, wrapper hop, route strings are not calls ──────────────
{
    const r = tmp();
    put(r, "iam/src/main/java/com/x/UserController.java", J("@RestController", "@RequestMapping(\"/users\")", "public class UserController {", "    @GetMapping", "    public List<UsersDto> getAllUsers() { return null; }", "}"));
    put(r, "web/src/utils/apiEndpoints.js", J("export const API_ENDPOINTS = {", "  IAM: {", "    USERS: '/api/iam/users',", "  },", "  ROUTES: { LIST: '/users' },", "};"));
    put(r, "web/src/services/iamService.js", J("const iamService = {", "  getUsers: async () => {", "    const response = await axiosInstance.get(API_ENDPOINTS.IAM?.USERS || '/api/iam/users');", "    return response.data;", "  },", "  createUser: async (d) => {", "    const response = await axiosInstance.post(API_ENDPOINTS.IAM?.USERS || '/api/iam/users', d);", "    return response.data;", "  },", "};"));
    put(r, "web/src/modules/Tenant/OverviewTab.jsx", J("export const Overview = () => {", "  const [u] = await Promise.all([iamService.getUsers()]);", "};"));
    put(r, "web/src/modules/Groups/CreateGroup.jsx", J("export const CreateGroup = () => {", "  const users = await iamService.getUsers();", "  await iamService.createUser(x);", "};"));
    put(r, "web/src/routes/routes.config.js", J("export const R = { LIST: '/portal-access/users', NAV: '/users' };"));
    const [e] = endpointConsumers(r, { endpoints: [{ method: "GET", path: "/users" }] });
    check("the server handler is found (class-level prefix plus bare mapping)", e.handlers.length === 1 && /UserController/.test(e.handlers[0]), JSON.stringify(e.handlers));
    check("the service that holds the URL is a caller, found through the gateway-prefixed literal", e.callers.some((c) => /iamService\.js:3/.test(c.where)), JSON.stringify(e.callers.map((c) => c.where)));
    check("the screens that call the wrapper are callers (one hop), classified as UI screens", e.callers.filter((c) => c.kind === "UI screen").length >= 2 && e.callers.some((c) => /OverviewTab/.test(c.where) && /wrapper getUsers/.test(c.via)) && e.callers.some((c) => /CreateGroup\.jsx:2/.test(c.where)), JSON.stringify(e.callers.map((c) => c.where + c.via)));
    check("another verb on the same URL is a different endpoint: POST wrapper callers are not GET callers", !e.callers.some((c) => /iamService\.js:7/.test(c.where)) && !e.callers.some((c) => /CreateGroup\.jsx:3/.test(c.where)), JSON.stringify(e.callers.map((c) => c.where)));
    check("a client-side route string and a routes config are not API callers", !e.callers.some((c) => /routes\.config/.test(c.where)));
    const txt = renderEndpointConsumers([e]);
    check("the report asks what each screen does when the response contains a record it did not before", /ENDPOINT CONSUMER GRAPH/.test(txt) && /now contains a record it did not contain before/.test(txt));
    check("no caller is stated as 'not found', never as 'none exist'", /do not assume there is none/.test(renderEndpointConsumers(endpointConsumers(r, { endpoints: [{ path: "/nothing" }] }))));
}
// ── service ownership: a service that does not migrate the table writes it ───────────────────────────────────────────
{
    const r = tmp();
    const ent = (svc) => put(r, `${svc}/src/main/java/com/x/Tenant.java`, J("@Entity", "@Table(name = \"tenant\")", "public class Tenant {", "}"));
    ent("tenants-api");
    ent("iam-api");
    put(r, "tenants-api/src/main/resources/db/migration/V1__tenant.sql", "CREATE TABLE IF NOT EXISTS tenant (id text);\n");
    put(r, "tenants-api/src/main/resources/db/migration/V2__tenant_email.sql", "ALTER TABLE tenant ADD COLUMN email text;\n");
    put(r, "iam-api/src/main/java/com/x/UserService.java", J("class UserService {", "  void transfer() {", "    tenantRepository.save(tenant);", "  }", "}"));
    put(r, "tenants-api/src/main/java/com/x/TenantService.java", J("class TenantService {", "  void rename() {", "    tenantRepository.save(tenant);", "  }", "}"));
    const [o] = serviceOwnership(r, { entities: ["Tenant"] });
    check("the table, the services that map it and the service whose migrations own it", o.tables.length === 1 && o.tables[0].table === "tenant" && o.tables[0].mapped_in.join() === "iam-api,tenants-api" && o.tables[0].owner === "tenants-api", JSON.stringify(o.tables));
    check("a write from a service that does not own the table is a cross-service write; the owner's own write is not", o.cross_service_writers.join() === "iam-api" && o.writers.length === 2, JSON.stringify(o.cross_service_writers));
    check("the report asks whether every environment uses the same database", /CROSS-SERVICE WRITE from iam-api/.test(renderOwnership([o])) && /same database in every environment/.test(renderOwnership([o])));
    check("an unknown entity says so", /No @Entity class found/.test(renderOwnership(serviceOwnership(r, { entities: ["Ghost"] }))));
}
// ── parent cascade: deleting a tenant deletes its users through the repository, bypassing the user guard ─────────────
{
    const r = tmp();
    put(r, "svc/src/main/java/com/x/TenantService.java", J("class TenantService {", "    public void hardDeleteTenant(", "            String tenantId,", "            DeleteTenantRequest req) {", "        groupService.deleteGroupsByTenantId(tenantId);", "        List<User> users = userRepository.findByTenant(tenant);", "        userRepository.deleteAll(users);", "        kcUtil.deleteRealmHard(realm);", "    }", "    public void deprovisionTenant(String id) {", "        userService.deleteUser(first);", "        if (u.isDefaultUser()) { return; }", "    }", "    public void renameTenant(String id) { }", "}"));
    put(r, "svc/src/main/java/com/x/UserService.java", J("class UserService {", "  public void deleteUser(String id) {", "    if (user.isDefaultUser()) { throw new Conflict(); }", "  }", "}"));
    put(r, "db/V9__fk.sql", "ALTER TABLE users ADD CONSTRAINT fk_t FOREIGN KEY (t) REFERENCES tenant(id) ON DELETE CASCADE;\n");
    const c = parentCascade(r, { parent: "Tenant", children: ["User"], guard_terms: ["defaultUser", "isDefaultUser"] });
    check("a multi-line parent transition (hardDeleteTenant) is found", c.transitions.some((t) => t.method === "hardDeleteTenant") && c.transitions.some((t) => t.method === "deprovisionTenant") && !c.transitions.some((t) => t.method === "renameTenant"), JSON.stringify(c.transitions.map((t) => t.method)));
    const repo = c.paths.find((p) => p.method === "hardDeleteTenant" && /repository delete/.test(p.via));
    check("the child removal through the repository is found with file:line, and it does NOT mention the guard", !!repo && /TenantService\.java:7/.test(repo.where) && repo.mentions_guard === false, JSON.stringify(c.paths));
    const svc = c.paths.find((p) => p.method === "deprovisionTenant");
    check("a removal through the service is reported as going through the service, and the guard mention is read from the transition", !!svc && /goes through the service/.test(svc.via) && svc.mentions_guard === true, JSON.stringify(svc));
    check("an identity-provider removal is not confused with a child delete when the child is not a user", !parentCascade(r, { parent: "Tenant", children: ["Group"], guard_terms: [] }).paths.some((p) => /identity-provider/.test(p.via)));
    check("a database cascade is reported as removing children without any service guard", c.db_cascades.some((x) => /ON DELETE CASCADE/.test(x)) && /without running any service guard/.test(renderCascade(c, ["defaultUser"])));
    check("the report names the unguarded path", /DOES NOT MENTION defaultUser\/isDefaultUser: the child guard is not on this path/.test(renderCascade(c, ["defaultUser", "isDefaultUser"])));
}
// ── field impact: dotted attributes and derived values feeding a decision ────────────────────────────────────────────
{
    const r = tmp();
    put(r, "events/src/main/java/com/x/EnrollmentPrincipalGuard.java", J("class EnrollmentPrincipalGuard {", "  Set<String> allowedDomains(Tenant tenant) {", "    Set<String> allowed = new HashSet<>();", "    String tenantDomain = extractDomain(tenant.getEmail());", "    if (tenantDomain != null) {", "      allowed.add(tenantDomain);", "    }", "    return allowed;", "  }", "}"));
    put(r, "iam/src/main/java/com/x/UserService.java", J("class UserService {", "  void t(Tenant tenant, String e) {", "    tenant.setEmail(e);", "  }", "}"));
    put(r, "web/src/modules/Tenant/Settings.jsx", "export const S = ({ tenant }) => <i>{tenant.email || '-'}</i>;\n");
    const f = mapFieldImpact(r, { fields: ["tenant.email"] }).fields[0];
    check("a dotted attribute is read as tenant.getEmail(), tenant.email, and written as setEmail", f.total === 3 && f.writers === 1 && f.consumers.some((c) => /EnrollmentPrincipalGuard/.test(c.file)) && f.consumers.some((c) => c.kind === "write" && /iam/.test(c.service)), JSON.stringify(f.consumers.map((c) => c.kind + c.text)));
    const guard = f.consumers.find((c) => /EnrollmentPrincipalGuard/.test(c.file));
    check("the value derived from the field is traced to the decision it feeds", guard.derived?.name === "tenantDomain" && guard.derived.via === "extractDomain" && guard.derived.uses.some((u) => u.decision && /tenantDomain != null/.test(u.text)) && guard.derived.uses.some((u) => /allowed\.add\(tenantDomain\)/.test(u.text)), JSON.stringify(guard.derived));
    const txt = renderFieldImpact({ fields: [f], files_scanned: 3 });
    check("the report says the derived value changes when the field does and asks who is allowed or refused differently", /DERIVED VALUE tenantDomain \(via extractDomain\) changes when tenant\.email changes/.test(txt) && /who is allowed or refused differently/.test(txt));
    check("a write is not given a derived value", f.consumers.filter((c) => c.kind === "write").every((c) => !c.derived));
}
process.exit(failures ? 1 : 0);
