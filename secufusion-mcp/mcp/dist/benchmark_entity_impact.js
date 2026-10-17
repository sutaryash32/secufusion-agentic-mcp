import fs from "fs";
import os from "os";
import path from "path";
import { inventoryEntityImpact, renderEntityImpact, detectTrigger } from "./entity_impact.js";
/** Entity impact inventory: what else in the platform depends on the entity being changed. A fake multi-service workspace. */
let failures = 0;
function check(name, cond, detail = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + detail}`);
    if (!cond)
        failures++;
}
const write = (root, rel, content) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ent-"));
// svc-iam owns the Group entity
write(ws, "svc-iam/package.json", "{}");
write(ws, "svc-iam/src/main/java/com/x/Group.java", `package com.x;

public class Group {
    private String id;
    private Long ownerId;
    private String status;
    private Instant createdAt;
    private String createdBy;
}
`);
write(ws, "svc-iam/src/main/java/com/x/GroupController.java", `package com.x;

@RestController
public class GroupController {

    @PostMapping("/groups/{id}/transfer")
    @PreAuthorize("hasAuthority('group.transfer')")
    public Group transfer(@PathVariable String id, @RequestBody TransferRequest r) {
        if (!group.isOwner(currentUser)) { throw new AccessDeniedException("no"); }
        group.setOwnerId(r.newOwner());
        return groupService.save(group);
    }

    @DeleteMapping("/groups/{id}")
    public void delete(@PathVariable String id) {
        // delete the group
        groupRepository.deleteById(id);
    }
}
`);
write(ws, "svc-iam/src/main/java/com/x/GroupService.java", `package com.x;

public class GroupService {
    public boolean canManage(Group group, User u) {
        return u.isAdmin() || group.getStatus() == Status.ACTIVE;
    }
    public String contact(Group group) { return group.getTenant().getEmail() + tenant.email; }
    public User fallback(Group g) { return g.getDefaultUser(); }
}
`);
write(ws, "svc-iam/src/main/java/com/x/GroupImport.java", `package com.x;
public class GroupImport { public void importGroups(List<Group> groups) { groups.forEach(repo::save); } }
`);
write(ws, "svc-iam/src/test/java/com/x/GroupControllerTest.java", "package com.x;\npublic class GroupControllerTest { Group g; }\n");
// svc-events consumes group events and caches
write(ws, "svc-events/package.json", "{}");
write(ws, "svc-events/src/main/java/com/x/GroupEventConsumer.java", `package com.x;

public class GroupEventConsumer {
    @KafkaListener(topics = "group-updated")
    @Cacheable("groups")
    public void onGroup(GroupEvent e) {
        Group g = lookup(e.groupId());
        if (g.getOwner() == null) { return; }
    }
    @Scheduled(cron = "0 0 * * * *")
    public void sweepGroups() { }
}
`);
// the UI shows groups and checks admin
write(ws, "svc-ui/package.json", "{}");
write(ws, "svc-ui/src/GroupPage.jsx", `export default function GroupPage({ group, user }) {
  const canEdit = user.isAdmin && group.status === 'ACTIVE';
  localStorage.setItem('lastGroup', group.id);
  return canEdit ? <button>Edit group</button> : null;
}
`);
// policy never mentions groups
write(ws, "svc-policy/package.json", "{}");
write(ws, "svc-policy/src/main/java/com/x/Policy.java", "package com.x;\npublic class Policy { String name; }\n");
// noise that must be skipped
write(ws, "svc-iam/node_modules/dep/Group.java", "class Group { owner }");
const rep = inventoryEntityImpact(ws, { terms: ["Group"], story_text: "Allow an admin to transfer ownership of a group to another member" });
const iam = rep.services.find((s) => s.service === "svc-iam");
const ev = rep.services.find((s) => s.service === "svc-events");
const ui = rep.services.find((s) => s.service === "svc-ui");
check("every service that mentions the entity is inventoried, the one that never does is listed as without references", ["svc-iam", "svc-events", "svc-ui"].every((s) => rep.services.some((x) => x.service === s)) && rep.services_without_references.includes("svc-policy") && !rep.services.some((s) => s.service === "svc-policy"), JSON.stringify([rep.services.map((s) => s.service), rep.services_without_references]));
check("vendored code (node_modules) is not scanned", !JSON.stringify(rep).includes("node_modules"));
check("the entity definition is found with the audit fields it carries", iam.entity_definitions.some((d) => d.file.endsWith("Group.java") && d.audit_fields.includes("createdAt") && d.audit_fields.includes("createdBy") && !d.audit_fields.includes("updatedAt")), JSON.stringify(iam.entity_definitions));
check("ownership checks are found across services (isOwner, setOwnerId, getOwner)", (iam.dep_counts.OWNERSHIP_CHECK ?? 0) >= 2 && (ev.dep_counts.OWNERSHIP_CHECK ?? 0) >= 1, JSON.stringify([iam.dep_counts, ev.dep_counts]));
check("admin checks are found in the service and in the UI (isAdmin)", (iam.dep_counts.ADMIN_CHECK ?? 0) >= 1 && (ui.dep_counts.ADMIN_CHECK ?? 0) >= 1);
check("authority and role checks are found (@PreAuthorize, hasAuthority)", (iam.dep_counts.ROLE_OR_AUTHORITY_CHECK ?? 0) >= 1);
check("status checks are found in the backend and the UI", (iam.dep_counts.STATUS_CHECK ?? 0) >= 1 && (ui.dep_counts.STATUS_CHECK ?? 0) >= 1);
check("tenant.email and defaultUser coupling are surfaced", (iam.dep_counts.TENANT_EMAIL ?? 0) >= 1 && (iam.dep_counts.DEFAULT_USER ?? 0) >= 1);
check("write paths are inventoried (transfer endpoint, delete endpoint, import)", (iam.deps.WRITE_PATH ?? []).some((h) => /PostMapping/.test(h.text)) && (iam.deps.WRITE_PATH ?? []).some((h) => /DeleteMapping/.test(h.text)) && (iam.deps.WRITE_PATH ?? []).some((h) => /importGroups/.test(h.text)) && iam.import_export_files.some((f) => f.endsWith("GroupImport.java")), JSON.stringify(iam.deps.WRITE_PATH));
check("cross-service copies and derived state are surfaced: events consumed, caches, client-side stores, scheduled jobs", (ev.dep_counts.EVENT ?? 0) >= 1 && (ev.dep_counts.CACHE ?? 0) >= 1 && (ev.dep_counts.SCHEDULED_JOB ?? 0) >= 1 && (ui.dep_counts.CACHE ?? 0) >= 1, JSON.stringify([ev.dep_counts, ui.dep_counts]));
check("tests that reference the entity are counted, not mixed into the dependencies", iam.tests_referencing_entity === 1 && !iam.entity_files.some((f) => /Test\.java$/.test(f)));
check("commented lines are not dependencies", !(iam.deps.WRITE_PATH ?? []).some((h) => /delete the group/.test(h.text)));
check("the trigger fires for an ownership/permission/lifecycle story", rep.trigger.fired && rep.trigger.matched.some((m) => /owner|transfer|admin/.test(m)), JSON.stringify(rep.trigger));
check("the trigger does not fire for a cosmetic story", !detectTrigger([{ source: "story text", text: "Change the colour of the save button on the settings page" }]).fired);
check("a lone weak word does not fire it, but a strong one does", !detectTrigger([{ source: "s", text: "Add a delete icon to the table" }]).fired && detectTrigger([{ source: "s", text: "Add permission checks to the export" }]).fired);
const text = renderEntityImpact(rep);
check("the report is per service, with file:line evidence and the honesty note", /### svc-iam/.test(text) && /### svc-events/.test(text) && /GroupController\.java:\d+/.test(text) && /a hit is not a defect/i.test(text) && /Pessimistic-review trigger: FIRED/.test(text) && /without references: svc-policy/.test(text), text.slice(0, 900));
const before = JSON.stringify(fs.readdirSync(ws));
inventoryEntityImpact(ws, { terms: ["Group"] });
check("the inventory is read-only", JSON.stringify(fs.readdirSync(ws)) === before);
check("with no entity terms nothing is claimed", inventoryEntityImpact(ws, { terms: [] }).services.length === 0);
// ── authority coupling and criticality ranking ─────────────────────────────
{
    const w2 = fs.mkdtempSync(path.join(os.tmpdir(), "ent2-"));
    const J2 = "src/main/java/com/x/";
    // a flag that decides who may act, next to a scope check
    write(w2, "svc-iam/package.json", "{}");
    write(w2, "svc-iam/" + J2 + "PrivacyService.java", `package com.x;
public class PrivacyService {
    public void check(User callerUser) {
        boolean hasScope = callerHasScope(callerUser, "tenant.privacy.write");
        boolean isDefaultAdmin = callerUser.isDefaultUser();
        if (!hasScope && !isDefaultAdmin) {
            throw new AccessDeniedException("no");
        }
    }
}
`);
    // the flag defines what a platform admin is, a few lines below the method name
    write(w2, "svc-events/package.json", "{}");
    write(w2, "svc-events/" + J2 + "ParentChainAuthorizer.java", `package com.x;
public class ParentChainAuthorizer {
    /**
     * platform admin: a root tenant with an active default user.
     */
    public boolean isPlatformAdmin(String callerId) {
        Tenant caller = tenantRepository.findByTenantID(callerId).orElse(null);
        if (caller == null) {
            return false;
        }
        return caller.isRoot() && userRepository.findByTenantAndDefaultUser(caller.getId(), true).isPresent();
    }
}
`);
    // a notifier that follows the flag
    write(w2, "svc-events/" + J2 + "ExtensionDiscoveryNotifier.java", `package com.x;
public class ExtensionDiscoveryNotifier {
    void notifyAdmins(String t) { List<User> admins = userRepository.findByTenantAndDefaultUserTrue(t); }
}
`);
    // a write path that reacts to it
    write(w2, "svc-iam/" + J2 + "UserService.java", `package com.x;
public class UserService {
    @Transactional
    public void createUser(User u) {
        u.setDefaultUser(true);
    }
}
`);
    // a UI that gates an action on it
    write(w2, "svc-ui/package.json", "{}");
    write(w2, "svc-ui/src/Row.jsx", `export default function Row({ row, user }) {
  const canTransfer = user.hasAuthority('user.transfer') && row.defaultUser;
  return canTransfer ? <button>Transfer</button> : null;
}
`);
    // a plain declaration and a DTO field: naming the flag is not using it in a decision
    write(w2, "svc-iam/" + J2 + "UserEntity.java", `package com.x;
public class UserEntity {
    private boolean defaultUser;
    public boolean isDefaultUser() { return defaultUser; }
    @PreAuthorize("hasAuthority('x')")
    public void other() { }
}
`);
    // the same rule copied into another service
    write(w2, "svc-policy/package.json", "{}");
    write(w2, "svc-policy/" + J2 + "ParentChainAuthorizer.java", `package com.x;
public class ParentChainAuthorizer {
    public boolean isPlatformAdmin(String callerId) {
        Tenant caller = tenantRepository.findByTenantID(callerId).orElse(null);
        return caller != null && userRepository.findByTenantAndDefaultUser(caller.getId(), true).isPresent();
    }
}
`);
    const r2 = inventoryEntityImpact(w2, { terms: ["User"], flags: ["defaultUser"], story_text: "transfer ownership of the admin" });
    const rk = (n) => r2.ranked_consumers.find((c) => c.file.endsWith(n));
    check("authority coupling: a flag used next to a scope check is CRITICAL and says why", rk("PrivacyService.java")?.criticality === "CRITICAL" && rk("PrivacyService.java").categories.includes("AUTHORITY_COUPLING") && /authorization decision/.test(rk("PrivacyService.java").why), JSON.stringify(rk("PrivacyService.java")));
    check("authority coupling: the flag that DEFINES a platform admin (several lines below the method name) is CRITICAL", rk("ParentChainAuthorizer.java")?.criticality === "CRITICAL", JSON.stringify(rk("ParentChainAuthorizer.java")));
    check("a write path that sets the flag is MEDIUM, a notifier that follows it is LOW", rk("UserService.java")?.criticality === "MEDIUM" && rk("ExtensionDiscoveryNotifier.java")?.criticality === "LOW", JSON.stringify([rk("UserService.java"), rk("ExtensionDiscoveryNotifier.java")]));
    check("UI gating on the flag is capped at MEDIUM and described as a UX/authority mismatch, not a security boundary", rk("Row.jsx")?.criticality === "MEDIUM" && /UI gating/.test(rk("Row.jsx").why), JSON.stringify(rk("Row.jsx")));
    check("a field or method declaration that merely names the flag is not authority coupling, even beside an authorization annotation", !(rk("UserEntity.java")?.categories ?? []).includes("AUTHORITY_COUPLING"), JSON.stringify(rk("UserEntity.java")));
    const order = r2.ranked_consumers.map((c) => c.criticality).join("").replace(/CRITICAL/g, "C").replace(/MEDIUM/g, "M").replace(/LOW/g, "L");
    check("ranked consumers are ordered Critical first, then Medium, then Low", /^C+M*L*$/.test(order) && r2.ranked_consumers[0].criticality === "CRITICAL", order);
    const t2 = renderEntityImpact(r2);
    check("the report opens with the ranked worklist, with evidence lines, before the per-service detail", t2.indexOf("RANKED CONSUMERS: read these first") > 0 && t2.indexOf("RANKED CONSUMERS") < t2.indexOf("### svc-iam") && /\[CRITICAL\] svc-iam\/src\/main\/java\/com\/x\/PrivacyService\.java/.test(t2) && /PrivacyService\.java:\d+/.test(t2) && /flags checked for authority coupling: defaultUser/.test(t2), t2.slice(0, 900));
    const noFlags = renderEntityImpact(inventoryEntityImpact(w2, { terms: ["User"] }));
    check("without flags it says authority coupling was not checked instead of claiming there is none", /No flags were given, so authority coupling was not checked/.test(noFlags) && !/\[CRITICAL\] .*PrivacyService/.test(noFlags.replace(/AUTH_INFRA/g, "")) || /No flags were given/.test(noFlags));
    check("the same rule copied into two services is ONE ranked entry listing the copies, so duplicated rules shorten the worklist and are flagged for parity", r2.ranked_consumers.filter((c) => c.file.endsWith("ParentChainAuthorizer.java")).length === 1 && (rk("ParentChainAuthorizer.java")?.also_in ?? []).some((x) => /svc-(events|policy)\/ParentChainAuthorizer\.java/.test(x)) && /ALSO IN 1 other service\(s\)/.test(t2) && /check the copies agree/.test(t2), JSON.stringify(rk("ParentChainAuthorizer.java")));
    check("max_ranked limits the worklist", inventoryEntityImpact(w2, { terms: ["User"], flags: ["defaultUser"], max_ranked: 2 }).ranked_consumers.length === 2);
    fs.rmSync(w2, { recursive: true, force: true });
}
fs.rmSync(ws, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
