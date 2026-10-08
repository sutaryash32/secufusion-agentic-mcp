// @ts-nocheck
import fs from "fs";
import path from "path";
import { z } from "zod";
import { extractSnapshot, computeDelta, renderReleaseNotes, saveSnapshot, loadSnapshot, findPreviousSnapshot, releasesDir, } from "./release_notes.js";
function readJsonFile(p) {
    try {
        return JSON.parse(fs.readFileSync(p, "utf-8").replace(/^﻿/, ""));
    }
    catch {
        return null;
    }
}
/** Walk up from a directory looking for any of the candidate files. */
function findUp(start, candidates, levels = 6) {
    let d = path.resolve(start);
    for (let i = 0; i < levels; i++) {
        for (const c of candidates) {
            const p = path.join(d, c);
            if (fs.existsSync(p))
                return p;
        }
        const parent = path.dirname(d);
        if (parent === d)
            break;
        d = parent;
    }
    return null;
}
export function registerReleaseTools(server) {
    server.tool("generate_release_notes", "Generates CHANGE-DRIVEN release notes: a changelog, not a repository scan. It snapshots the recorded state (project spec, migrations, DNA counts), diffs it against the previous release, and leads with the delta: " +
        "Executive Summary, Added, Changed, Fixed, Removed/Deprecated, Risks, Repository Intelligence Updates, Rule Changes, then an optional Detailed Snapshot last. " +
        "Detected changes are computed, never invented; sections with no change say so; an unchanged release says 'No significant changes'. " +
        "Supply the parts code cannot know (why the release exists, fixes, deprecations, notable discoveries); they appear labelled as author notes. Writes v<version>.md and a snapshot for the next release to compare against, to .mcp/release-history/ when the Project Intelligence Layer exists (version-controlled with the code), else .secufusion/releases/.", {
        workspace_root: z.string().describe("A directory inside the workspace containing .secufusion-project-spec.json"),
        version: z.string().describe("The version being released, e.g. 2.2.6"),
        previous_version: z.string().optional().describe("Previous release to compare against. Default: the newest stored snapshot older than `version`."),
        previous_spec_path: z.string().optional().describe("Path to the PREVIOUS spec (e.g. the .secufusion-project-spec.json.backup-<timestamp> made by the merge). Highest-fidelity baseline when no snapshot exists."),
        date: z.string().optional().describe("Release date (YYYY-MM-DD). Default: today."),
        why: z.string().optional().describe("Why this version exists, in one or two sentences, from the _changelog entry / the work that prompted it. Omit if unknown; it is then marked as not stated."),
        summary: z.string().optional().describe("Optional concise explanation of the release's purpose and impact."),
        added: z.array(z.string()).optional().describe("Author notes: capabilities the code cannot detect."),
        changed: z.array(z.string()).optional(),
        fixed: z.array(z.string()).optional().describe("Author notes: fixed defects, false positives, wrong mappings."),
        removed: z.array(z.string()).optional().describe("Author notes: removed or deprecated behaviour."),
        risks: z.array(z.string()).optional(),
        discoveries: z.array(z.string()).optional().describe("Author notes: notable discoveries."),
        rule_notes: z.array(z.string()).optional(),
        include_snapshot: z.boolean().optional().describe("Include the Detailed Snapshot at the end (default true)."),
        dry_run: z.boolean().optional().describe("Return the notes without writing the file or the snapshot."),
    }, async (a) => {
        try {
            const specPath = findUp(a.workspace_root, [".secufusion-project-spec.json"]);
            if (!specPath)
                return { isError: true, content: [{ type: "text", text: "⛔ No .secufusion-project-spec.json found at or above workspace_root. Run /sfn-init first." }] };
            const root = path.dirname(specPath);
            const spec = readJsonFile(specPath);
            if (!spec)
                return { isError: true, content: [{ type: "text", text: `⛔ ${specPath} is not valid JSON.` }] };
            const migPath = findUp(root, [".secufusion-migrations.json", path.join("scripts", ".secufusion-migrations.json")], 1);
            const dna = readJsonFile(path.join(root, ".secufusion", "dna.json"));
            const version = a.version.replace(/^v/, "");
            const current = extractSnapshot(version, spec, migPath ? readJsonFile(migPath) : null, dna);
            const notes = [];
            let previous = null;
            if (a.previous_spec_path) {
                const prevSpec = readJsonFile(path.resolve(root, a.previous_spec_path));
                if (!prevSpec)
                    notes.push(`previous_spec_path ${a.previous_spec_path} could not be read; falling back.`);
                else
                    previous = extractSnapshot((a.previous_version ?? "previous").replace(/^v/, ""), prevSpec, null, null);
            }
            if (!previous && a.previous_version) {
                previous = loadSnapshot(root, a.previous_version);
                if (!previous)
                    notes.push(`No stored snapshot for v${a.previous_version.replace(/^v/, "")}.`);
            }
            if (!previous)
                previous = findPreviousSnapshot(root, version);
            if (!previous)
                notes.push("No earlier snapshot or previous spec was available, so this is recorded as the baseline release; no delta is claimed.");
            const delta = computeDelta(previous, current);
            const date = a.date ?? new Date().toISOString().slice(0, 10);
            const md = renderReleaseNotes({
                version, previous_version: previous?.version ?? null, date, delta, current,
                include_snapshot: a.include_snapshot,
                narrative: { summary: a.summary, why: a.why, added: a.added, changed: a.changed, fixed: a.fixed, removed: a.removed, risks: a.risks, discoveries: a.discoveries, rule_notes: a.rule_notes },
            });
            let written = "";
            if (!a.dry_run) {
                const out = path.join(releasesDir(root), `v${version}.md`);
                fs.mkdirSync(path.dirname(out), { recursive: true });
                fs.writeFileSync(out, md, "utf-8");
                saveSnapshot(root, current);
                written = `📄 Written: ${out}\n🗂  Snapshot saved for the next release to compare against.\n`;
            }
            const header = `${written}Compared against: ${previous ? `v${previous.version}` : "nothing (baseline)"} · detected changes: ${delta.total}\n` +
                (notes.length ? notes.map((n) => `⚠️ ${n}`).join("\n") + "\n" : "") +
                (a.why ? "" : "ℹ️ `why` was not supplied; the notes say the rationale is not stated. Add it from the _changelog entry or the work that prompted this release.\n");
            return { content: [{ type: "text", text: `${header}\n---\n${md}` }] };
        }
        catch (e) {
            return { isError: true, content: [{ type: "text", text: `Error: ${e.message}` }] };
        }
    });
}
