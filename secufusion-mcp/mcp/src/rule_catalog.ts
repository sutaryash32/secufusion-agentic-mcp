import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/**
 * The rule catalog: the SecuFusion-specific rules a review checks, loaded from `rules/shared/*.md`
 * (tables with `| ID | Severity | Rule |`) and per-repository notes in `rules/repos/<repo>.md`.
 *
 * Rules are data in markdown, not code, so they can be read, edited and reviewed like any document.
 * A workspace can add its own in `.secufusion/rules/*.md` (same table format) and per-repository notes in
 * `.secufusion/rules/repos/<repo>.md`; workspace rules override bundled rules with the same ID.
 *
 * The catalog does not replace reasoning. A rule is a prompt for the reviewer ("did the change do X?"),
 * not a verdict. Rules marked `mechanical` are also checked by the quick check with no model.
 */
export interface Rule { id: string; severity: "blocker" | "major" | "minor" | "nit"; area: string; text: string; source: string; mechanical: boolean }

const here = path.dirname(fileURLToPath(import.meta.url));
const bundledDir = () => {
    for (const p of [path.resolve(here, "..", "..", "rules"), path.resolve(here, "..", "rules")]) if (fs.existsSync(p)) return p;
    return path.resolve(here, "..", "..", "rules");
};

/** Rules the quick check evaluates by pattern, with no model. */
export const MECHANICAL = new Set(["DB-001", "DB-002", "DB-003", "DB-007", "DB-008", "SEC-001", "SEC-007", "SEC-008", "SEC-009", "SEC-010", "SEC-014", "SEC-015", "SEC-016", "RUN-004", "RUN-005", "CON-007", "DEP-004", "DEP-005", "DEP-006", "DEP-007", "TST-004", "TST-006", "TST-008", "WEB-009"]);

const AREA: Record<string, string> = { CON: "contracts", DB: "database", DEP: "dependencies", HIS: "history", RUN: "runtime", SEC: "security", TST: "tests", WEB: "web-ui" };

export function parseRules(markdown: string, source: string): Rule[] {
    const out: Rule[] = [];
    for (const line of markdown.split(/\r?\n/)) {
        const m = line.match(/^\|\s*([A-Z]{2,4}-\d{3})\s*\|\s*(blocker|major|minor|nit)\s*\|\s*(.+?)\s*\|\s*$/);
        if (!m) continue;
        out.push({ id: m[1], severity: m[2] as Rule["severity"], area: AREA[m[1].split("-")[0]] ?? "general", text: m[3], source, mechanical: MECHANICAL.has(m[1]) });
    }
    return out;
}

const readMdDir = (dir: string): Array<{ file: string; text: string }> => {
    try { return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort().map((f) => ({ file: f, text: fs.readFileSync(path.join(dir, f), "utf8") })); } catch { return []; }
};

export function loadCatalog(workspaceRoot?: string): { rules: Rule[]; overridden: string[]; sources: string[] } {
    const byId = new Map<string, Rule>();
    const sources: string[] = [];
    for (const { file, text } of readMdDir(path.join(bundledDir(), "shared"))) { sources.push(`rules/shared/${file}`); for (const r of parseRules(text, `rules/shared/${file}`)) byId.set(r.id, r); }
    const overridden: string[] = [];
    if (workspaceRoot) {
        for (const { file, text } of readMdDir(path.join(workspaceRoot, ".secufusion", "rules"))) {
            sources.push(`.secufusion/rules/${file}`);
            for (const r of parseRules(text, `.secufusion/rules/${file}`)) { if (byId.has(r.id)) overridden.push(r.id); byId.set(r.id, r); }
        }
    }
    return { rules: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)), overridden, sources };
}

/** Per-repository notes: bundled first, then the workspace's own (which win on conflict by coming last). */
export function repoNotes(repoKey: string, workspaceRoot?: string): Array<{ source: string; text: string }> {
    const safe = repoKey.replace(/[^\w.-]/g, "");
    const out: Array<{ source: string; text: string }> = [];
    const read = (p: string, label: string) => { try { out.push({ source: label, text: fs.readFileSync(p, "utf8") }); } catch { /* none */ } };
    if (safe) read(path.join(bundledDir(), "repos", `${safe}.md`), `rules/repos/${safe}.md`);
    if (workspaceRoot && safe) read(path.join(workspaceRoot, ".secufusion", "rules", "repos", `${safe}.md`), `.secufusion/rules/repos/${safe}.md`);
    return out;
}

export function knownRepos(): string[] {
    return readMdDir(path.join(bundledDir(), "repos")).map((f) => f.file.replace(/\.md$/, ""));
}

export function renderCatalog(r: ReturnType<typeof loadCatalog>, o: { area?: string; ids?: string[]; severity?: string } = {}): string {
    let rules = r.rules;
    if (o.area) rules = rules.filter((x) => x.area === o.area!.toLowerCase());
    if (o.ids?.length) rules = rules.filter((x) => o.ids!.includes(x.id));
    if (o.severity) rules = rules.filter((x) => x.severity === o.severity);
    const reportSeverity = { blocker: "BLOCKER when FACT, else WARNING", major: "WARNING (BLOCKER only when FACT and Class A)", minor: "NICE TO HAVE", nit: "NICE TO HAVE (leave out unless asked)" } as const;
    const o2 = [`# Rule catalog: ${rules.length} rule(s)${o.area ? ` in ${o.area}` : ""}`, "", "A rule is a question to answer from the code, not a verdict. Cite file:line; report with the evidence rule (only FACT supports BLOCKER).", ""];
    for (const x of rules) o2.push(`${x.id} [${x.severity}${x.mechanical ? ", quick-check" : ""}] -> ${reportSeverity[x.severity]}\n  ${x.text}`);
    if (r.overridden.length) o2.push("", `Overridden by this workspace: ${r.overridden.join(", ")}`);
    return o2.join("\n");
}
