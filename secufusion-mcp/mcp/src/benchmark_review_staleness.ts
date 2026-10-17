import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { takeReviewSnapshot, checkStaleness, saveReviewSnapshot, loadReviewSnapshot, reviewStalenessFor, describeStaleness } from "./review_staleness.js";

/** Post-review change detection: a review only covers the code it saw. Real git repositories. */

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + detail}`);
    if (!cond) failures++;
}
const GIT = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", "-c", "commit.gpgsign=false"];
const g = (cwd: string, ...args: string[]) => execFileSync("git", [...GIT, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const write = (root: string, rel: string, content: string) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };

function repo(): string {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), "stale-"));
    g(r, "init", "-q", "-b", "main");
    write(r, "a.txt", "base a\n"); write(r, "b.txt", "base b\n");
    g(r, "add", "-A"); g(r, "commit", "-q", "-m", "base");
    g(r, "checkout", "-q", "-b", "work");
    write(r, "a.txt", "reviewed a\n"); write(r, "c.txt", "new c\n");
    return r;
}

// ── a review snapshot, then life goes on ───────────────────────────────────
{
    const r = repo();
    const snap = takeReviewSnapshot(r, { base: "main" })!;
    check("the snapshot records every file that differs from the base, tracked or new, with a content hash", !!snap && Object.keys(snap.files).sort().join() === "a.txt,c.txt" && Object.values(snap.files).every((h) => /^[0-9a-f]{40}$/.test(h)), JSON.stringify(snap?.files));
    check("right after the review nothing is stale", checkStaleness(snap).stale === false && checkStaleness(snap).checked);

    g(r, "add", "-A"); g(r, "commit", "-q", "-m", "commit the reviewed work");
    const afterCommit = checkStaleness(snap);
    check("committing the reviewed work does NOT make the review stale (same content)", afterCommit.stale === false && afterCommit.head_moved === true, JSON.stringify(afterCommit));

    write(r, ".secufusion/tasks/x/notes.md", "workflow noise");
    write(r, ".mcp/adr/new.md", "knowledge recorded after the review");
    check("workflow files (.secufusion, .mcp) are not code and never make a review stale", checkStaleness(snap).stale === false);

    write(r, ".secufusion-tokens.json", "{\"calls\": 1}");
    write(r, "svc/.secufusion-migrations.json", "{}");
    write(r, ".secufusion-project-spec.json.backup-20261001", "{}");
    check("the MCP's own files (token accounting, spec, migrations and their backups), at the root or in a service, are never code under review", checkStaleness(snap).stale === false, JSON.stringify(checkStaleness(snap)));

    write(r, "a.txt", "reviewed a, then edited\n");
    const edited = checkStaleness(snap);
    check("a reviewed file edited after the review makes it stale, naming the file", edited.stale && edited.changed.join() === "a.txt", JSON.stringify(edited));

    write(r, "a.txt", "reviewed a\n");
    check("restoring the exact reviewed content makes it current again", checkStaleness(snap).stale === false);

    write(r, "d.txt", "added after review\n");
    const added = checkStaleness(snap);
    check("a file that becomes part of the change after the review is stale ('added')", added.stale && added.added.join() === "d.txt", JSON.stringify(added));
    fs.rmSync(path.join(r, "d.txt"));

    write(r, "c.txt", "base-less c changed\n");
    check("a changed new file is caught too", checkStaleness(snap).changed.join() === "c.txt");
    write(r, "c.txt", "new c\n");

    g(r, "checkout", "-q", "main", "--", "a.txt");
    const reverted = checkStaleness(snap);
    check("a reviewed file reverted to the base is reported (the reviewed change is gone)", reverted.stale && reverted.reverted.join() === "a.txt", JSON.stringify(reverted));
    check("the description lists what changed, by kind", /reviewed but now reverted to the base \(1\): a\.txt/.test(describeStaleness(reverted)));
    fs.rmSync(r, { recursive: true, force: true });
}

// ── persistence next to the gate ledger ────────────────────────────────────
{
    const r = repo();
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-"));
    saveReviewSnapshot(ws, "STORY-1", takeReviewSnapshot(r, { base: "main" }));
    check("the snapshot is saved per work item beside the ledger and loads back", !!loadReviewSnapshot(ws, "STORY-1") && fs.existsSync(path.join(ws, ".secufusion", "gates", "STORY-1.review-snapshot.json")));
    check("staleness is computed from the saved snapshot", reviewStalenessFor(ws, "STORY-1")?.stale === false);
    write(r, "b.txt", "changed after review\n");
    check("and sees a later change", reviewStalenessFor(ws, "STORY-1")?.stale === true && reviewStalenessFor(ws, "STORY-1")?.added.join() === "b.txt");
    saveReviewSnapshot(ws, "STORY-1", null);
    check("a review that is not an approval clears the snapshot", loadReviewSnapshot(ws, "STORY-1") === null && reviewStalenessFor(ws, "STORY-1") === null);
    check("no snapshot, no claim: staleness is unknown, not 'current'", reviewStalenessFor(ws, "NEVER-REVIEWED") === null);
    fs.rmSync(r, { recursive: true, force: true }); fs.rmSync(ws, { recursive: true, force: true });
}

// ── outside git ────────────────────────────────────────────────────────────
{
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "stale-"));
    check("outside a git repository there is nothing to track (null, not a false 'current')", takeReviewSnapshot(plain) === null);
    fs.rmSync(plain, { recursive: true, force: true });
}

process.exit(failures ? 1 : 0);
