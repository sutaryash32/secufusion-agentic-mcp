import fs from "fs";
import os from "os";
import path from "path";
import { seal, reveal, renderReveal, similarity } from "./calibration.js";
import { discoverFamily, scanTransitions, buildFeatureModel, renderFeatureModel } from "./feature_model.js";
/** Feature model and client-parity calibration. */
let failures = 0;
function check(name, cond, detail = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + detail}`);
    if (!cond)
        failures++;
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "calib-"));
const put = (root, rel, text) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
// ── work item family ────────────────────────────────────────────────────────
const ws = tmp();
put(ws, ".secufusion/registry.json", JSON.stringify([
    { work_item_id: "BUG-9", title: "Admin not shown", status: "complete", tags: ["tenant"] },
    { work_item_id: "TASK-11", title: "Backend: transfer", status: "active", tags: ["STORY-10", "split-from-BUG-9", "backend"] },
    { work_item_id: "TASK-12", title: "Frontend: transfer", status: "active", tags: ["STORY-10", "frontend"] },
    { work_item_id: "TASK-77", title: "Unrelated", status: "active", tags: ["billing"] },
    { work_item_id: "TASK-13", title: "Follow-up for 10 notifications", status: "active", tags: [] },
]));
{
    const fam = discoverFamily(ws, "STORY-10");
    check("the story, its tagged children and the item it was split from are discovered", ["STORY-10", "TASK-11", "TASK-12", "BUG-9"].every((i) => fam.some((f) => f.id === i)), fam.map((f) => f.id).join());
    check("roles are story / child / origin", fam.find((f) => f.id === "TASK-11").role === "child" && fam.find((f) => f.id === "BUG-9").role === "origin" && fam.find((f) => f.id === "STORY-10").role === "story");
    check("an unrelated item is not in the family", !fam.some((f) => f.id === "TASK-77"));
    check("a story with no record of its own still resolves from its children", /no record/.test(fam[0].title));
    check("an item that only mentions the number in its title is 'related', not a child", fam.find((f) => f.id === "TASK-13")?.role === "related");
}
// ── transitions: what exists, and does the method ever look at the flag ─────
put(ws, "svc-a/src/main/java/com/x/UserService.java", [
    "public class UserService {",
    "    public User createUser(Dto d) {", "        User u = new User();", "        u.setDefaultUser(true);", "        return repo.save(u);", "    }",
    "    public User updateUser(String id, Dto d) {", "        User u = repo.findById(id);", "        u.setStatus(d.getStatus());", "        ensureGroups(u, d.getGroups());", "        return repo.save(u);", "    }",
    "    public void deleteUser(String id) {", "        User u = repo.findById(id);", "        if (u.isDefaultUser()) {", "            throw new Conflict();", "        }", "        repo.delete(u);", "    }",
    "    public void transferOwnership(String a, String b) {", "        User s = repo.findById(a);", "        s.setDefaultUser(false);", "    }",
    "}",
].join("\n"));
put(ws, "svc-a/src/test/java/com/x/UserServiceTest.java", "public class UserServiceTest { void deleteUser() {\n} }\n");
{
    const { rows } = scanTransitions(ws, ["User"], ["defaultUser"]);
    const row = (t) => rows.find((r) => r.entity === "User" && r.transition === t);
    check("create, update, delete and transfer paths are found with file:line", ["create", "update", "delete", "transfer"].every((t) => row(t)?.sites.length === 1) && /UserService\.java$/.test(row("delete").sites[0].file) && row("delete").sites[0].line === 13, JSON.stringify(rows.map((r) => r.transition)));
    check("a status write inside a generic update is a status change, and a group write is a membership change", row("status change")?.sites[0].method === "updateUser" && row("membership change")?.sites[0].method === "updateUser", JSON.stringify(rows.map((r) => r.transition)));
    check("a method that never mentions the flag is a lead (updateUser), one that does is not (deleteUser)", row("update").unguarded.length === 1 && row("delete").unguarded.length === 0);
    check("test files are not transition paths", !rows.some((r) => r.sites.some((s) => /Test/.test(s.file))));
    check("the service is the first path segment", row("update").services[0] === "svc-a");
}
{
    const m = buildFeatureModel(ws, { work_item_id: "STORY-10", entities: ["User"], flags: ["defaultUser"] });
    const txt = renderFeatureModel(m);
    check("the model lists the family, entities, existing transitions, absent transitions, capability, graph and a review matrix", ["## 1. Work item family", "## 2. Primary business entities", "## 3. Lifecycle transitions", "## 4. Transitions with NO path", "## 5. Capability dependencies", "## 6. Cross-service dependency graph", "## 7. Review matrix"].every((h) => txt.includes(h)), txt.slice(0, 300));
    check("a transition with no path is listed as a lifecycle question, not skipped", m.missing.some((x) => x.entity === "User" && x.transition === "restore") && /NO PATH/.test(txt));
    check("every transition is checked against every contract clause", /check against ownership, authority, lifecycle, consistency \(source of truth\), audit, dependencies, tenancy/.test(txt));
    check("entities proposed from tags are marked for confirmation", /confirm/.test(renderFeatureModel(buildFeatureModel(ws, { work_item_id: "STORY-10" }))));
}
// ── calibration: blind protocol ─────────────────────────────────────────────
{
    const r = tmp();
    const derived = [
        { title: "Two IT Admins through concurrent writers", category: "BLOCKING", text: "defaultUser has no unique constraint; concurrent transfers or creates leave two owners" },
        { title: "Stale grid after failed transfer", category: "NON-BLOCKING", text: "the dialog keeps its candidate list after a failure" },
    ];
    let refusedEmpty = false;
    try {
        seal(r, "S", []);
    }
    catch {
        refusedEmpty = true;
    }
    check("sealing nothing is refused", refusedEmpty);
    let unsealed = "";
    try {
        reveal(r, "S", [{ text: "x" }]);
    }
    catch (e) {
        unsealed = e.message;
    }
    check("revealing before sealing is refused (the comparison must be blind)", /no sealed findings/.test(unsealed), unsealed);
    const s = seal(r, "S", derived);
    check("sealing records a hash and a time", s.sha256.length === 64 && s.count === 2);
    let twice = "";
    try {
        seal(r, "S", derived);
    }
    catch (e) {
        twice = e.message;
    }
    check("a sealed list is never re-sealed", /already sealed/.test(twice));
    const client = [
        { text: "Concurrent transfers could leave two IT Admins; there is no unique constraint on defaultUser", category: "BLOCKING" },
        { text: "Stale grid after a failed transfer", category: "NON-BLOCKING" },
        { text: "Deprovisioning bypasses the delete guard", category: "BLOCKING" },
    ];
    const res = reveal(r, "S", client);
    check("matching comments are derived, the unrelated one is missed", res.pairings[0].verdict === "DERIVED" && res.pairings[1].verdict === "DERIVED" && res.pairings[2].verdict === "MISSED", JSON.stringify(res.pairings));
    check("parity counts and blocking recall are reported", res.parity.derived === 2 && res.parity.missed === 1 && res.parity.blocking_recall === "1/2", JSON.stringify(res.parity));
    let late = "";
    {
        const r2 = tmp();
        seal(r2, "S", derived);
        reveal(r2, "S", client);
        fs.rmSync(path.join(r2, ".secufusion", "calibration", "S.sealed.json"));
        try {
            seal(r2, "S", derived);
        }
        catch (e) {
            late = e.message;
        }
    }
    check("after the client comments exist, sealing is refused", /already recorded/.test(late), late);
    const ov = reveal(r, "S", client, [{ client: 2, derived: 0, verdict: "PARTIAL" }, { client: 0, derived: null, verdict: "MISSED" }]);
    check("the reviewer's overrides replace the lexical proposals", ov.pairings[2].verdict === "PARTIAL" && ov.pairings[2].by === "reviewer" && ov.pairings[0].verdict === "MISSED");
    const sevDiff = reveal(r, "S", [{ text: "Stale grid after a failed transfer", category: "BLOCKING" }]);
    check("a severity difference between the client and the derived concern is shown", sevDiff.pairings[0].category_match === false && /SEVERITY DIFFERS/.test(renderReveal(sevDiff, [{ text: "Stale grid after a failed transfer", category: "BLOCKING" }])));
    check("derived concerns the client did not raise are listed as extras", reveal(r, "S", [{ text: "Deprovisioning bypasses the delete guard" }]).extras.length === 2);
    const file = path.join(r, ".secufusion", "calibration", "S.sealed.json");
    const rec = JSON.parse(fs.readFileSync(file, "utf-8"));
    rec.findings[0].title = "edited after the fact";
    fs.writeFileSync(file, JSON.stringify(rec));
    let tamper = "";
    try {
        reveal(r, "S", client);
    }
    catch (e) {
        tamper = e.message;
    }
    check("a sealed list edited after sealing is detected and the comparison refused", /changed after sealing/.test(tamper), tamper);
    check("similarity: shared identifiers and words score high, unrelated text scores zero", similarity("tenant.email drifts from defaultUser", "defaultUser and tenant email drift") >= 0.5 && similarity("colour of the save button", "concurrent transfers leave two owners") === 0);
}
process.exit(failures ? 1 : 0);
