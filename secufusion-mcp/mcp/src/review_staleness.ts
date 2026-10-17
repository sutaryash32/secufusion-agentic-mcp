/**
 * Post-review change detection: a review is only about the code it saw.
 *
 * When the review gate passes, the content hash of every file that differs from the base is recorded. Later, the same set
 * is recomputed: a file that changed, a file that is newly part of the change, or a reviewed file that was reverted means
 * code exists that the verdict never covered, so the review is STALE. Committing the reviewed work changes nothing (the
 * content is the same), so a normal commit never makes a review stale. Workflow files (.secufusion/, .mcp/) are ignored.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { git, gitTop, pickBase } from "./diff_quality.js";

export interface ReviewSnapshot {
    repo: string; base: string; head: string | null; taken_at: string;
    files: Record<string, string>; truncated: boolean;
}
export interface Staleness {
    checked: boolean; stale: boolean;
    changed: string[]; added: string[]; reverted: string[];
    head_moved: boolean; note?: string;
}

// workflow files are not code under review: .secufusion/, .mcp/, build output, and the MCP's own files (.secufusion-tokens.json, the spec and migrations files and their backups) at any level
const SKIP = /^(\.secufusion|\.mcp|node_modules|dist|build|target|\.git|coverage)\/|(^|\/)\.secufusion[\w.-]*$/;
const MAX_FILES = 3000, MAX_BYTES = 2_000_000;

const hashFile = (abs: string): string => {
    try {
        const b = fs.readFileSync(abs);
        return b.length > MAX_BYTES ? `size:${b.length}` : crypto.createHash("sha1").update(b).digest("hex");
    } catch { return "deleted"; }
};

function changedFiles(top: string, base: string): { files: string[]; truncated: boolean } {
    const out = new Set<string>();
    for (const f of ((git(top, ["diff", "--name-only", "--no-renames", base]) ?? "") as string).split(/\r?\n/).filter(Boolean)) out.add(f);
    for (const f of ((git(top, ["ls-files", "--others", "--exclude-standard"]) ?? "") as string).split(/\r?\n/).filter(Boolean)) out.add(f);
    const all = [...out].filter((f) => !SKIP.test(f)).sort();
    return { files: all.slice(0, MAX_FILES), truncated: all.length > MAX_FILES };
}

/** The reviewed state: every changed file with its content hash. Null outside a git repository (staleness cannot be tracked). */
export function takeReviewSnapshot(workspaceRoot: string, opts: { base?: string } = {}): ReviewSnapshot | null {
    const top = gitTop(workspaceRoot);
    if (!top) return null;
    const { base } = pickBase(top, opts.base);
    const { files, truncated } = changedFiles(top, base);
    const files_: Record<string, string> = {};
    for (const f of files) files_[f] = hashFile(path.join(top, f));
    return { repo: top, base, head: ((git(top, ["rev-parse", "HEAD"]) ?? "") as string).trim() || null, taken_at: new Date().toISOString(), files: files_, truncated };
}

export function checkStaleness(snap: ReviewSnapshot): Staleness {
    if (!fs.existsSync(snap.repo)) return { checked: false, stale: false, changed: [], added: [], reverted: [], head_moved: false, note: `the reviewed repository ${snap.repo} no longer exists` };
    const { files } = changedFiles(snap.repo, snap.base);
    const now = new Map(files.map((f) => [f, hashFile(path.join(snap.repo, f))] as const));
    const changed = Object.keys(snap.files).filter((f) => now.has(f) && now.get(f) !== snap.files[f]);
    const added = files.filter((f) => !(f in snap.files));
    const reverted = Object.keys(snap.files).filter((f) => !now.has(f));
    const head = ((git(snap.repo, ["rev-parse", "HEAD"]) ?? "") as string).trim() || null;
    return { checked: true, stale: changed.length + added.length + reverted.length > 0, changed, added, reverted, head_moved: head !== snap.head };
}

// ── persistence, next to the gate ledger ────────────────────────────────────

const snapPath = (root: string, id: string) => path.join(root, ".secufusion", "gates", `${id.replace(/[^a-zA-Z0-9._-]/g, "_")}.review-snapshot.json`);

export function saveReviewSnapshot(root: string, id: string, snap: ReviewSnapshot | null): void {
    const p = snapPath(root, id);
    if (!snap) { try { fs.rmSync(p, { force: true }); } catch { /* nothing to remove */ } return; }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(snap, null, 2));
}

export function loadReviewSnapshot(root: string, id: string): ReviewSnapshot | null {
    try { return JSON.parse(fs.readFileSync(snapPath(root, id), "utf-8")); } catch { return null; }
}

/** Staleness of the recorded review for a work item, or null when no snapshot was recorded. */
export function reviewStalenessFor(root: string, id: string): Staleness | null {
    const snap = loadReviewSnapshot(root, id);
    return snap ? checkStaleness(snap) : null;
}

export function describeStaleness(s: Staleness, max = 12): string {
    const parts: string[] = [];
    const list = (label: string, a: string[]) => { if (a.length) parts.push(`${label} (${a.length}): ${a.slice(0, max).join(", ")}${a.length > max ? ", ..." : ""}`); };
    list("changed after the review", s.changed); list("newly part of the change", s.added); list("reviewed but now reverted to the base", s.reverted);
    return parts.join("\n");
}

export const STALE_NEXT = "Re-run /sfn-review so it reviews what changed since the verdict (the delta above), then verify_against_spec records a fresh verdict. Code changed after review has not been reviewed.";
