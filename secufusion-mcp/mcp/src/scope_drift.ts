/**
 * PR scope drift: changes unrelated to the story.
 *
 * Classifies every changed file as CORE (the story's own files), INDIRECTLY RELATED (tests, configuration, migrations,
 * documentation or neighbours of core files) or UNRELATED (does not contribute directly to an acceptance criterion, an
 * architecture decision, a bug fix or a product requirement). It REPORTS ONLY: scope drift never fails a review. The
 * classification is a deterministic first pass from the story's plan, requirement and acceptance criteria; the reviewer
 * confirms or adjusts it, and the developer may explain why a file is included.
 */
import path from "path";
import { git, gitTop, pickBase, matchesPlanned } from "./diff_quality.js";

export type ScopeClass = "CORE" | "INDIRECT" | "UNRELATED";
export interface ClassifiedFile { file: string; klass: ScopeClass; reason: string; lines_changed: number }
export interface ScopeInput {
    acceptance_criteria?: string[];
    /** Any other story text: requirement request, plan summary and steps. */
    story_text?: string;
    planned_files?: string[];
    core_files?: string[];
}
export interface ScopeDriftReport {
    root: string | null; base: string | null; base_reason: string;
    classified: boolean; files: ClassifiedFile[];
    counts: Record<ScopeClass, number>; notes: string[];
}

const TEST = /(^|\/)(src\/test|__tests__|tests?|spec)\/|\.(test|spec)\.[jt]sx?$|(Test|Tests|IT|Spec)\.(java|kt|scala|groovy)$|_test\.(go|py)$/;
const LOCK = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/;
const MIGRATION = /(^|\/)(db\/migration|migrations?)\/.*\.sql$/;
const CONFIG = /(^|\/)(application|bootstrap)[\w.-]*\.(properties|ya?ml)$|(^|\/)\.env(\.[\w.-]+)?$/;
const DOC = /\.md$|(^|\/)docs?\//i;

const base_ = (f: string) => path.posix.basename(f).replace(/\.[^.]+$/, "");
const subjectOfTest = (f: string) => base_(f).replace(/\.(test|spec)$/i, "").replace(/(Tests?|IT|Spec)$/, "").replace(/^test_/, "").replace(/_test$/, "");
/** the service/module a file belongs to: the path above src/, else its first folder */
export const serviceOf = (f: string) => { const i = f.indexOf("/src/"); return i > 0 ? f.slice(0, i) : f.includes("/") ? f.split("/")[0] : ""; };

export function classifyScope(changed: Array<{ file: string; lines: number }>, input: ScopeInput): { classified: boolean; files: ClassifiedFile[] } {
    const planned = [...(input.planned_files ?? []), ...(input.core_files ?? [])].filter(Boolean);
    const story = [...(input.acceptance_criteria ?? []), input.story_text ?? ""].join("\n").toLowerCase();
    const known = planned.length > 0 || story.trim().length > 0;
    if (!known) {
        return { classified: false, files: changed.map((c) => ({ file: c.file, klass: "UNRELATED" as ScopeClass, reason: "no story information (no plan, requirement or acceptance criteria) to classify against", lines_changed: c.lines })) };
    }
    const out = new Map<string, ClassifiedFile>();
    const core: ClassifiedFile[] = [];
    for (const c of changed) {
        const why = planned.some((p) => matchesPlanned(c.file, p))
            ? (input.core_files ?? []).some((p) => matchesPlanned(c.file, p)) ? "named by the reviewer as a core file" : "listed in the plan's affected files"
            : (base_(c.file).length >= 5 && !TEST.test(c.file) && story.includes(base_(c.file).toLowerCase())) ? `named in the story (${base_(c.file)} appears in the acceptance criteria, requirement or plan)` : null;
        if (why) { const f = { file: c.file, klass: "CORE" as ScopeClass, reason: why, lines_changed: c.lines }; out.set(c.file, f); core.push(f); }
    }
    const coreBases = new Set(core.map((c) => base_(c.file).toLowerCase()));
    const coreDirs = new Map(core.map((c) => [path.posix.dirname(c.file), c.file] as const));
    const coreServices = new Set(core.map((c) => serviceOf(c.file)));
    const changedSet = new Set(changed.map((c) => c.file));
    for (const c of changed) {
        if (out.has(c.file)) continue;
        const f = c.file;
        let r: string | null = null;
        if (TEST.test(f) && coreBases.has(subjectOfTest(f).toLowerCase())) r = `test of the core file ${subjectOfTest(f)}`;
        else if (LOCK.test(f)) continue; // decided below, once its manifest is classified
        else if (/^\.mcp\//.test(f)) r = "project knowledge recorded with the story";
        else if (MIGRATION.test(f) && coreServices.has(serviceOf(f))) r = "database migration in the same service as core changes";
        else if (CONFIG.test(f) && coreServices.has(serviceOf(f))) r = "configuration of the same service as core changes";
        else if (DOC.test(f) && coreServices.has(serviceOf(f))) r = "documentation of the same service as core changes";
        else if (coreDirs.has(path.posix.dirname(f))) r = `same folder as the core file ${path.posix.basename(coreDirs.get(path.posix.dirname(f))!)}`;
        out.set(f, r ? { file: f, klass: "INDIRECT", reason: r, lines_changed: c.lines } : {
            file: f, klass: "UNRELATED", lines_changed: c.lines,
            reason: "not in the plan, not named in the story, and not a test, configuration, migration, documentation or neighbour of a core file",
        });
    }
    // a lock file follows its manifest: the lock of an unrelated package.json is unrelated too
    for (const c of changed) {
        if (out.has(c.file) || !LOCK.test(c.file)) continue;
        const manifest = out.get(path.posix.join(path.posix.dirname(c.file), "package.json").replace(/^\.\//, ""));
        out.set(c.file, manifest && manifest.klass !== "UNRELATED"
            ? { file: c.file, klass: "INDIRECT", reason: `lock file of the ${manifest.klass === "CORE" ? "core" : "related"} package.json`, lines_changed: c.lines }
            : { file: c.file, klass: "UNRELATED", reason: manifest ? "lock file of an unrelated package.json" : "a lock file with no changed package.json beside it", lines_changed: c.lines });
    }
    return { classified: true, files: changed.map((c) => out.get(c.file)!) };
}

export function analyzeScopeDrift(cwd: string, opts: { base?: string } & ScopeInput = {}): ScopeDriftReport {
    const top = gitTop(cwd);
    const rep: ScopeDriftReport = { root: top, base: null, base_reason: "", classified: false, files: [], counts: { CORE: 0, INDIRECT: 0, UNRELATED: 0 }, notes: [] };
    if (!top) { rep.notes.push("Not a git repository: there is no changed-file list."); return rep; }
    const { base, reason } = pickBase(top, opts.base);
    rep.base = base; rep.base_reason = reason;
    const lines = new Map<string, number>();
    for (const l of (git(top, ["diff", "--numstat", "--no-renames", base]) ?? "").split(/\r?\n/).filter(Boolean)) {
        const [a, d, ...p] = l.split("\t"); const f = p.join("\t");
        if (f && !f.startsWith(".secufusion/")) lines.set(f, (a === "-" ? 0 : Number(a)) + (d === "-" ? 0 : Number(d)));
    }
    for (const f of (git(top, ["ls-files", "--others", "--exclude-standard"]) ?? "").split(/\r?\n/).filter(Boolean)) if (!f.startsWith(".secufusion/") && !lines.has(f)) lines.set(f, 0);
    const changed = [...lines].map(([file, n]) => ({ file, lines: n })).sort((a, b) => a.file.localeCompare(b.file));
    const res = classifyScope(changed, opts);
    rep.classified = res.classified; rep.files = res.files;
    for (const f of rep.files) rep.counts[f.klass]++;
    if (reason.startsWith("HEAD")) rep.notes.push("No default branch to compare against, so only uncommitted changes were considered. Pass `base` to include committed work.");
    if (!res.classified) rep.notes.push("No plan, requirement or acceptance criteria were available, so files could not be classified against a story. Ask the developer for the story, or pass work_item_id / core_files.");
    rep.notes.push("A first-pass classification from the plan, the story text and file relationships. Confirm or adjust it by reading the files; a file may belong for a reason the story text does not show.");
    return rep;
}

export function renderScopeDrift(r: ScopeDriftReport): string {
    const by = (k: ScopeClass) => r.files.filter((f) => f.klass === k);
    const head =
        `## PR SCOPE DRIFT REVIEW\n` +
        `Base: ${r.base ?? "n/a"} (${r.base_reason}) · files changed: ${r.files.length} · CORE ${r.counts.CORE}, INDIRECTLY RELATED ${r.counts.INDIRECT}, UNRELATED ${r.counts.UNRELATED}\n` +
        `Scope drift is REPORTED ONLY: it never fails the review.\n` +
        (r.notes.length ? r.notes.map((n) => `Note: ${n}`).join("\n") + "\n" : "");
    if (!r.files.length) return head + "\nNo changed files.\n";
    if (!r.classified) return head + "\nFiles changed (unclassified):\n" + r.files.map((f) => `- ${f.file}`).join("\n") + "\n";
    const list = (k: ScopeClass) => by(k).length ? by(k).map((f) => `- ${f.file} (${f.lines_changed} lines): ${f.reason}`).join("\n") : "- none";
    const drift = by("UNRELATED").map((f) => [
        "SCOPE DRIFT", "",
        `File: ${f.file}`, "",
        "Reason:",
        "Does not contribute directly to:",
        "- Acceptance Criteria", "- Architecture Decision", "- Bug Fix", "- Product Requirement",
        `(${f.reason}; ${f.lines_changed} lines changed)`, "",
        "Recommendation:", "Move to separate story or explain why included.",
    ].join("\n"));
    return head + `\n### CORE STORY FILES\n${list("CORE")}\n\n### INDIRECTLY RELATED FILES\n${list("INDIRECT")}\n\n### UNRELATED FILES\n${list("UNRELATED")}\n` + (drift.length ? "\n" + drift.join("\n\n---\n\n") + "\n" : "\nNo scope drift detected.\n");
}
