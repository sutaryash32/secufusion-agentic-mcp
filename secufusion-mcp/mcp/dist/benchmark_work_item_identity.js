import { parseWorkItemRef, displayRef, refSlugPrefix, titleSlug, folderName, identityBundle, sameTicket, typesConflict, findRegistryConflict, folderMatches, intentFileMatches, } from "./work_item_ref.js";
/** Ticket identity must survive unchanged into slugs, branches, commits and references. */
let failures = 0;
function check(name, cond, detail = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + detail}`);
    if (!cond)
        failures++;
}
const TITLE = "Tenant deletion reports failure";
const TYPES = ["BUG", "TASK", "STORY", "FEATURE", "EPIC"];
// ── every work-item type is preserved exactly ──────────────────────────────
for (const t of TYPES) {
    const id = `${t}-1230`;
    const p = parseWorkItemRef(id);
    check(`${id}: parsed as type ${t}, number 1230`, p.type === t && p.number === "1230" && p.ref === id, JSON.stringify(p));
    const folder = folderName(id, TITLE);
    check(`${id}: folder is ${id}-tenant-deletion-reports-failure`, folder === `${id}-tenant-deletion-reports-failure`, folder);
    const b = identityBundle(id, TITLE);
    check(`${id}: branch suffix, commit and PR prefixes use ${id} verbatim`, b.branch_suffix.startsWith(`${id}-`) && b.commit_prefix === `${id}: ` && b.pr_title_prefix === `${id}: ` && b.ref === id && b.warnings.length === 0, JSON.stringify(b));
    check(`${id}: displayed as ${id}, never WI-${id}`, displayRef(id) === id);
    check(`${id}: never turned into a different type`, TYPES.filter((o) => o !== t).every((o) => !folder.toUpperCase().includes(`${o}-1230`)), folder);
}
// ── the reported bug ───────────────────────────────────────────────────────
{
    const f = folderName("BUG-1230", TITLE);
    check("BUG-1230 is never converted into task-1230", !/task/i.test(f) && f.startsWith("BUG-1230-"), f);
    check("a bare number is not given an invented 'Task' type", folderName("1230", TITLE) === "1230-tenant-deletion-reports-failure", folderName("1230", TITLE));
    const b = identityBundle("1230", TITLE);
    check("bare number: no type invented, and the user is told how to fix it", !b.type_known && b.warnings.length === 1 && b.warnings[0].includes("BUG-1230") && !/task-1230/i.test(JSON.stringify(b).replace(/or TASK-1230/g, "")), JSON.stringify(b.warnings));
    check("bare number is shown as WI-1230 (the generic label), not a guessed type", displayRef("1230") === "WI-1230");
}
// ── case and separators ────────────────────────────────────────────────────
{
    check("case is preserved: Bug-1230 stays Bug-1230", folderName("Bug-1230", TITLE).startsWith("Bug-1230-"));
    check("case is preserved: bug-1230 stays bug-1230", folderName("bug-1230", TITLE).startsWith("bug-1230-"));
    check("only the separator is normalized: 'Bug 1230' -> Bug-1230", parseWorkItemRef("Bug 1230").ref === "Bug-1230" && parseWorkItemRef("BUG_1230").ref === "BUG-1230");
    check("WI-2847 stays WI-2847 (not doubled to WI-WI-2847)", displayRef("WI-2847") === "WI-2847");
    check("Jira-style keys are preserved", displayRef("PROJ-123") === "PROJ-123" && folderName("PROJ-123", "x y").startsWith("PROJ-123-"));
    check("unparseable ids are kept, made filesystem-safe, not replaced", refSlugPrefix("weird id/1") === "weird-id-1" && displayRef("weird id/1") === "weird id/1");
}
// ── title handling ─────────────────────────────────────────────────────────
{
    check("the ticket's own prefix is stripped from the title", titleSlug("BUG-1230: Tenant deletion fails", "BUG-1230") === "tenant-deletion-fails");
    check("a bare '1230:' title prefix is stripped for BUG-1230", titleSlug("1230: Tenant deletion fails", "BUG-1230") === "tenant-deletion-fails");
    check("a title that merely starts with a digit is not mangled ('2FA')", titleSlug("2FA enforcement for admins", "BUG-1230") === "2fa-enforcement-for-admins", titleSlug("2FA enforcement for admins", "BUG-1230"));
    check("another ticket's number in the title is not stripped", titleSlug("BUG-9999: other thing", "BUG-1230") === "bug-9999-other-thing", titleSlug("BUG-9999: other thing", "BUG-1230"));
    check("empty title yields just the reference", folderName("EPIC-7", "") === "EPIC-7");
}
// ── identity conflicts ─────────────────────────────────────────────────────
{
    check("BUG-1230 vs TASK-1230 conflict (numbers are unique)", typesConflict("BUG-1230", "TASK-1230"));
    check("BUG-1230 vs Bug-1230 do not conflict (same type, different case)", !typesConflict("BUG-1230", "Bug-1230"));
    check("bare 1230 never conflicts with BUG-1230, and they are the same ticket", !typesConflict("1230", "BUG-1230") && sameTicket("1230", "BUG-1230"));
    check("different numbers are different tickets", !typesConflict("BUG-1230", "TASK-1231") && !sameTicket("BUG-1230", "BUG-1231"));
    check("registry conflict is detected, and a matching entry is not a conflict", findRegistryConflict([{ work_item_id: "BUG-1230" }], "TASK-1230") === "BUG-1230" && findRegistryConflict([{ work_item_id: "BUG-1230" }], "BUG-1230") === null && findRegistryConflict([{ work_item_id: "1230" }], "BUG-1230") === null);
}
// ── lookup of existing artifacts (including older, wrongly named ones) ─────
{
    check("folder lookup is case-insensitive", folderMatches("BUG-1230-x", "bug-1230") && folderMatches("Bug-1230-x", "BUG-1230"));
    check("legacy 'Task-1230-' folder created by the old bug is still found for BUG-1230 and 1230", folderMatches("Task-1230-old", "BUG-1230") && folderMatches("Task-1230-old", "1230"));
    check("lookup does not match a longer number", !folderMatches("Task-12300-x", "1230") && !folderMatches("BUG-12301-x", "BUG-1230"));
    check("lookup does not match a different ticket", !folderMatches("BUG-1231-x", "BUG-1230"));
    check("intent files: new name found", intentFileMatches("0001-BUG-1230-tenant.md", "BUG-1230"));
    check("intent files: old '0001-WI-BUG-1230-' and '0001-WI-2847-' names still found", intentFileMatches("0001-WI-BUG-1230-tenant.md", "BUG-1230") && intentFileMatches("0001-WI-2847-x.md", "2847"));
    check("intent files: no false match on a longer number or another ticket", !intentFileMatches("0002-WI-12301-x.md", "1230") && !intentFileMatches("0012-BUG-99-title-1230.md", "1230"));
}
console.log(failures === 0 ? "\nWORK ITEM IDENTITY BENCHMARK: ALL PASS" : `\nWORK ITEM IDENTITY BENCHMARK: ${failures} FAILED`);
process.exit(failures ? 1 : 0);
