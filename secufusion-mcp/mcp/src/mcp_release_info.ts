/**
 * What a new MCP version itself brings. The package ships one release-notes file per version (release-notes/vX.Y.Z.md).
 * /sfn-init's generate_release_notes includes every version between the project's previous MCP version and the new one,
 * so a project that skips versions still sees everything it missed.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { compareVersions } from "./release_notes.js";

/** release-notes/ sits next to mcp/ in the package (mcp/dist/x.js -> ../../release-notes). */
export function releaseNotesDir(): string {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "release-notes");
}

export const REQUIRED_SECTIONS = ["Summary", "Added", "Changed", "Fixed", "Breaking changes", "New tools"];

export interface McpRelease { version: string; body: string }

/** Releases with from < version <= to (newest first). With no `from`, only `to` itself. */
export function loadMcpReleases(from: string | null, to: string, dir: string = releaseNotesDir()): { releases: McpRelease[]; hasCurrent: boolean } {
    const clean = (v: string) => v.replace(/^v/, "");
    const target = clean(to);
    let files: string[] = [];
    try { files = fs.readdirSync(dir).filter((f) => /^v\d+\.\d+\.\d+.*\.md$/.test(f)); } catch { /* no bundled notes */ }
    const all = files.map((f) => f.replace(/^v|\.md$/g, ""));
    const inRange = all.filter((v) => compareVersions(v, target) <= 0 && (from ? compareVersions(v, clean(from)) > 0 : compareVersions(v, target) === 0));
    const releases = inRange.sort((a, b) => compareVersions(b, a)).map((version) => ({
        version,
        body: fs.readFileSync(path.join(dir, `v${version}.md`), "utf-8").replace(/\r\n/g, "\n").trim(),
    }));
    return { releases, hasCurrent: all.some((v) => compareVersions(v, target) === 0) };
}

/** Markdown for the project's release notes. Headings are demoted so they nest under the section. */
export function renderMcpRelease(r: { releases: McpRelease[]; hasCurrent: boolean }, to: string, from: string | null): string {
    const target = to.replace(/^v/, "");
    const head = `## What this MCP version brings\n_secufusion-mcp ${from ? `v${from.replace(/^v/, "")} to ` : ""}v${target}. This is about the tool, not your project's changes (those are below)._\n`;
    if (!r.releases.length) {
        return `${head}\n_No release information is bundled with this version of the MCP for v${target}._\n`;
    }
    const blocks = r.releases.map((x) => `### v${x.version}\n\n${x.body.replace(/^## /gm, "#### ")}`);
    const note = r.hasCurrent ? "" : `\n_No release information is bundled for v${target} itself; showing the latest earlier versions in range._\n`;
    return `${head}\n${blocks.join("\n\n")}\n${note}`;
}
