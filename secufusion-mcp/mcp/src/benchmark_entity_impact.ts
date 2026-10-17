import fs from "fs";
import os from "os";
import path from "path";
import { inventoryEntityImpact, renderEntityImpact, detectTrigger } from "./entity_impact.js";

/** Entity impact inventory: what else in the platform depends on the entity being changed. A fake multi-service workspace. */

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + detail}`);
    if (!cond) failures++;
}
const write = (root: string, rel: string, content: string) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };

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
const iam = rep.services.find((s) => s.service === "svc-iam")!;
const ev = rep.services.find((s) => s.service === "svc-events")!;
const ui = rep.services.find((s) => s.service === "svc-ui")!;

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

fs.rmSync(ws, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
