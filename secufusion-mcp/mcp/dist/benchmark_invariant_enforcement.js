import fs from "fs";
import os from "os";
import path from "path";
import { mapInvariantEnforcement, renderEnforcement, variantsOf } from "./invariant_enforcement.js";
/** Invariant Enforcement Map: one field per strength, in a fake multi-service workspace. */
let failures = 0;
function check(name, cond, detail = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + detail}`);
    if (!cond)
        failures++;
}
const write = (root, rel, content) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "enf-"));
const J = "svc/src/main/java/com/x/";
// 1. defaultUser: a partial unique index in the database, a writer, and a concurrency test
write(ws, "svc/src/main/resources/db/migration/V7__one_default_user.sql", `ALTER TABLE users ADD COLUMN default_user boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX uq_one_default_user ON users (tenant_id) WHERE default_user = true;
`);
write(ws, J + "OwnerService.java", `package com.x;
public class OwnerService {
    public void promote(User u) { u.setDefaultUser(true); repo.save(u); }
}
`);
write(ws, "svc/src/test/java/com/x/OwnerRaceTest.java", `package com.x;
public class OwnerRaceTest {
    @Test void twoAdminsAtOnce() { ExecutorService pool = null; user.setDefaultUser(true); }
}
`);
// 2. ownerId: every writer takes a lock on the parent row first
write(ws, J + "TransferService.java", `package com.x;
public class TransferService {
    @Transactional
    public void transfer(String tenantId, Long newOwner) {
        Tenant t = tenantRepository.findByIdForUpdate(tenantId);
        t.setOwnerId(newOwner);
    }
}
`);
// 3. archived: read-then-write with no lock and no constraint
write(ws, J + "ArchiveService.java", `package com.x;
public class ArchiveService {
    public void archive(Tenant t) {
        if (repo.countByArchived(t.getId(), true) == 0) {
            t.setArchived(true);
        }
    }
}
`);
// 4. nickname: written, nothing else
write(ws, J + "ProfileService.java", `package com.x;
public class ProfileService { public void rename(User u, String n) { u.setNickname(n); } }
`);
// 5. region: only NOT NULL in the database, one plain writer
write(ws, "svc/src/main/resources/db/migration/V8__region.sql", "ALTER TABLE tenant ALTER COLUMN region SET NOT NULL;\nALTER TABLE tenant ADD COLUMN region varchar(8) NOT NULL;\n");
write(ws, J + "RegionService.java", `package com.x;
public class RegionService { public void move(Tenant t) { t.setRegion("eu"); } }
`);
// 6. tier: one locked writer and one unlocked writer
write(ws, J + "TierLocked.java", `package com.x;
public class TierLocked { @Lock(LockModeType.PESSIMISTIC_WRITE) public void a(Tenant t) { t.setTier("gold"); } }
`);
write(ws, J + "TierBulk.java", `package com.x;
public class TierBulk { public void b(Tenant t) { t.setTier("silver"); } }
`);
// 7. legacyFlag: only ever read
write(ws, J + "Reader.java", "package com.x;\npublic class Reader { boolean r(Tenant t) { return t.isLegacyFlag(); } }\n");
// 8. flagX: found on a real workspace: imports and comments that look like locks, DTO mappings and JPQL predicates that look like writes, and a file where only ONE method takes the lock
write(ws, J + "FlagService.java", `package com.x;
import java.io.Serializable;
import jakarta.persistence.LockTimeoutException;
public class FlagService {
    // the synchronized bottleneck is avoided here
    @Transactional
    public void locked(Tenant t) {
        Tenant x = repo.findByIdForUpdate(t.getId());
        x.setFlagX(true);
    }

    public void createFirst(Tenant t) {
        if (repo.countByFlagX(t.getId(), true) == 0) {
            t.setFlagX(true);
        }
    }

    public FlagDto map(Tenant t) {
        FlagDto dto = new FlagDto();
        dto.setFlagX(t.isFlagX());
        return dto;
    }
}
`);
write(ws, J + "FlagRepository.java", `package com.x;
public interface FlagRepository {
    @Query("select t from Tenant t where t.flagX = true")
    List<Tenant> flagged();
}
`);
// 9. ownerKey / orphanKey: the lock is taken through a helper the writer calls, a helper write whose callers hold the lock, and a helper write whose caller does not
write(ws, J + "HelperService.java", `package com.x;
public class HelperService {
    @Transactional
    public void transfer(String tenantId) {
        lockTenant(tenantId);
        Tenant t = repo.find(tenantId);
        t.setOwnerKey("n");
    }

    private Tenant lockTenant(String id) {
        return repo.findByIdForUpdate(id);
    }

    public void viaCaller(Tenant t) {
        lockTenant(t.getId());
        apply(t);
    }

    private void apply(Tenant t) {
        t.setOwnerKey("x");
    }

    public void unlocked(Tenant t) {
        apply2(t);
    }

    private void apply2(Tenant t) {
        t.setOrphanKey("y");
    }
}
`);
// noise: vendored code must not count
write(ws, "svc/node_modules/dep/X.java", "class X { void a() { u.setNickname(1); } }");
const rep = mapInvariantEnforcement(ws, { fields: ["default_user", "ownerId", "archived", "nickname", "region", "tier", "legacyFlag", "flagX", "ownerKey", "orphanKey"] });
const f = (n) => rep.fields.find((x) => x.field === n);
check("variants: camelCase and snake_case are both searched", JSON.stringify(variantsOf("default_user")) === JSON.stringify(["defaultUser", "default_user"]) && JSON.stringify(variantsOf("ownerId")) === JSON.stringify(["ownerId", "owner_id"]));
check("DB_ENFORCED: a partial unique index is found (SQL snake_case) and the writer (Java camelCase) is found through the other variant", f("default_user").strength === "DB_ENFORCED" && f("default_user").db.some((d) => /UNIQUE \(partial\)/.test(d.kind) && /uq_one_default_user|default_user/.test(d.text)) && f("default_user").write_count === 1, JSON.stringify(f("default_user")));
check("a concurrency test that exercises the field is found", f("default_user").concurrency_tests.some((t) => /OwnerRaceTest/.test(t)));
check("LOCK_PROTECTED: the only writer takes a lock on the parent row (findByIdForUpdate) before writing", f("ownerId").strength === "LOCK_PROTECTED" && f("ownerId").unprotected_write_files.length === 0 && f("ownerId").locks.length >= 1, JSON.stringify(f("ownerId")));
check("CHECK_THEN_ACT: the writer reads the field first, with no lock and no constraint: named as a zombie-state risk", f("archived").strength === "CHECK_THEN_ACT" && f("archived").check_then_act.length === 1 && /two actors can both pass the check/.test(f("archived").reasons.join(" ")), JSON.stringify(f("archived")));
check("CODE_ONLY: a plain writer with no read, lock or constraint", f("nickname").strength === "CODE_ONLY" && f("nickname").write_count === 1, JSON.stringify(f("nickname")));
check("vendored code (node_modules) is ignored", f("nickname").write_count === 1 && !JSON.stringify(rep).includes("node_modules"));
check("NOT NULL alone does not count as enforcing uniqueness: it is reported as weaker", f("region").strength === "CODE_ONLY" && f("region").weak_db.length >= 1 && /NOT NULL/.test(f("region").reasons.join(" ")), JSON.stringify(f("region")));
check("a field with one locked writer and one unlocked writer is NOT lock-protected, and the unprotected file is named", f("tier").strength !== "LOCK_PROTECTED" && f("tier").unprotected_write_files.some((x) => /TierBulk/.test(x)) && !f("tier").unprotected_write_files.some((x) => /TierLocked/.test(x)) && /partially protected/.test(f("tier").reasons.join(" ")), JSON.stringify(f("tier")));
check("NO_WRITES_FOUND: a field that is only ever read says so rather than claiming safety", f("legacyFlag").strength === "NO_WRITES_FOUND" && f("legacyFlag").write_count === 0);
check("no concurrency test is flagged for fields without one", f("archived").concurrency_tests.length === 0 && /no concurrency test/.test(f("archived").reasons.join(" ")));
const fx = f("flagX");
check("imports and comments that mention locks (Serializable, LockTimeoutException, 'synchronized') are NOT lock evidence", fx.locks.length === 1 && /findByIdForUpdate/.test(fx.locks[0].text) && !fx.locks.some((l) => /import|Serializable|LockTimeout|bottleneck/.test(l.text)), JSON.stringify(fx.locks));
check("a DTO mapping (dto.setFlagX(...)) and a JPQL read predicate (t.flagX = true) are NOT writes", fx.write_count === 2 && !fx.writes.some((w) => /dto\.|t\.flagX = true/.test(w.text)), JSON.stringify(fx.writes));
check("lock coverage is per METHOD: the locked method is protected, the other writer in the same file is not, and is named", fx.unprotected_writes.length === 1 && /createFirst|setFlagX\(true\)/.test(fx.unprotected_writes[0].text) && fx.unprotected_writes[0].line > 10 && fx.strength === "CHECK_THEN_ACT" && /partially protected: 1 of 2/.test(fx.reasons.join(" ")), JSON.stringify(fx));
const ok = f("ownerKey"), orph = f("orphanKey");
check("a lock taken through a helper the writer calls counts, and the evidence says which helper", ok.write_count === 2 && ok.strength === "LOCK_PROTECTED" && ok.locks.some((l) => /via lockTenant\(\)/.test(l.text)), JSON.stringify(ok));
check("a write in a helper whose only caller holds the lock counts as protected, via the caller", ok.locks.some((l) => /via the caller of apply\(\)/.test(l.text)), JSON.stringify(ok.locks));
check("a write in a helper whose caller takes NO lock is unprotected", orph.strength === "CODE_ONLY" && orph.unprotected_writes.length === 1 && /setOrphanKey/.test(orph.unprotected_writes[0].text), JSON.stringify(orph));
const text = renderEnforcement(rep);
check("the report explains what an 'exactly one' invariant needs, and rates each field with file:line evidence", /exactly one per tenant/.test(text) && /Enforcement: DB_ENFORCED/.test(text) && /Enforcement: CHECK_THEN_ACT/.test(text) && /ArchiveService\.java:\d+/.test(text) && /V7__one_default_user\.sql:\d+/.test(text) && /evidence, not a verdict/.test(text), text.slice(0, 700));
const before = JSON.stringify(fs.readdirSync(ws));
mapInvariantEnforcement(ws, { fields: ["nickname"] });
check("the map is read-only", JSON.stringify(fs.readdirSync(ws)) === before);
check("no fields: nothing is claimed", mapInvariantEnforcement(ws, { fields: [] }).fields.length === 0 && /No fields were given/.test(renderEnforcement(mapInvariantEnforcement(ws, { fields: [] }))));
fs.rmSync(ws, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
