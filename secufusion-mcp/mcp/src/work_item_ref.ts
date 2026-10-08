/**
 * Work-item identity. A ticket reference like BUG-1230 is metadata that must survive
 * unchanged into folder names, intent files, branch names, commit messages and PR text.
 *
 * Rules:
 *  - The type prefix the user wrote is preserved exactly (BUG, Bug, STORY, FEATURE, EPIC, TASK,
 *    WI, a Jira key like PROJ ...). Only the separator is normalized to "-" (so "Bug 1230" -> "Bug-1230").
 *  - A known type is never replaced by a generic default, and never overridden by the
 *    classification's task_type (that describes the kind of work, not the ticket's identity).
 *  - If no type was given, none is invented. Bare numbers stay bare.
 */

export interface WorkItemRef {
    raw: string;
    /** Type prefix exactly as written, or null when none was given. */
    type: string | null;
    number: string | null;
    /** Canonical reference: "<type>-<number>", or the bare number / raw text when no type. */
    ref: string;
}

const FULL = /^\s*([A-Za-z][A-Za-z]{0,15})[-_ #]*(\d+)\s*$/;

export function parseWorkItemRef(raw: string): WorkItemRef {
    const s = String(raw ?? "").trim();
    if (/^\d+$/.test(s)) return { raw: s, type: null, number: s, ref: s };
    const m = FULL.exec(s);
    if (m) return { raw: s, type: m[1], number: m[2], ref: `${m[1]}-${m[2]}` };
    return { raw: s, type: null, number: null, ref: s };
}

/** Guidance string for every tool parameter that takes a work item id. */
export const WORK_ITEM_ID_DESC =
    "The ticket reference EXACTLY as the user wrote it, including its type prefix: 'BUG-1230', 'TASK-1230', 'STORY-1230', 'FEATURE-1230', 'EPIC-1230' (not just '1230'). Never change or drop the type.";

/** How a reference is shown to people: the type is kept; "WI-" is only the label for a bare number. */
export function displayRef(id: string): string {
    const p = parseWorkItemRef(id);
    if (p.type) return p.ref;
    if (p.number && p.ref === p.number) return `WI-${p.number}`;
    return p.ref;
}

function safe(text: string): string {
    return text.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

/** The id part of a folder/branch slug: type kept verbatim (case included), nothing invented. */
export function refSlugPrefix(id: string): string {
    const p = parseWorkItemRef(id);
    if (p.type) return p.ref;
    if (p.number && p.ref === p.number) return p.number;
    return safe(p.ref) || "item";
}

/** Slug of the human title. Only strips a leading reference that is THIS ticket's own number. */
export function titleSlug(title: string, id: string, max = 50): string {
    let t = String(title ?? "").trim();
    const num = parseWorkItemRef(id).number;
    if (num) {
        const own = new RegExp(`^\\s*(?:[A-Za-z]{1,16}[-_ #]*)?#?${num}(?!\\d)\\s*[:\\-\\u2013\\u2014.]?\\s*`);
        t = t.replace(own, "");
    }
    return t.toLowerCase()
        .replace(/[:\s]+/g, "-")
        .replace(/[^a-z0-9-]+/g, "")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, max)
        .replace(/-+$/, "");
}

/** e.g. BUG-1230 + "Tenant deletion fails" -> "BUG-1230-tenant-deletion-fails". */
export function folderName(id: string, title: string): string {
    const slug = titleSlug(title, id);
    const prefix = refSlugPrefix(id);
    return slug ? `${prefix}-${slug}` : prefix;
}

/** Deterministic names for branches, commits and PRs. The reference is used verbatim. */
export function identityBundle(id: string, title: string) {
    const p = parseWorkItemRef(id);
    const slug = titleSlug(title, id, 40);
    const ref = p.type ? p.ref : displayRef(id);
    return {
        ref,
        type: p.type,
        number: p.number,
        type_known: !!p.type,
        folder: folderName(id, title),
        branch_suffix: slug ? `${refSlugPrefix(id)}-${slug}` : refSlugPrefix(id),
        commit_prefix: `${ref}: `,
        pr_title_prefix: `${ref}: `,
        warnings: p.type ? [] : p.number ? [`No work-item type was given for ${p.number}. Nothing was inferred. If this is BUG-${p.number} or TASK-${p.number}, pass that exact reference so it stays consistent with Azure Boards.`] : [],
    };
}

export function sameTicket(a: string, b: string): boolean {
    const x = parseWorkItemRef(a).number, y = parseWorkItemRef(b).number;
    return !!x && x === y;
}

/** Both carry a type, same number, different type: one of them is wrong. */
export function typesConflict(a: string, b: string): boolean {
    const x = parseWorkItemRef(a), y = parseWorkItemRef(b);
    return !!x.type && !!y.type && x.number === y.number && x.type.toLowerCase() !== y.type.toLowerCase();
}

export function findRegistryConflict(registry: Array<Record<string, unknown>>, id: string): string | null {
    for (const r of registry) {
        const other = String(r["work_item_id"] ?? "");
        if (other && typesConflict(other, id)) return other;
    }
    return null;
}

export function identityConflictMessage(requested: string, registered: string): string {
    const n = parseWorkItemRef(requested).number;
    return `⛔ IDENTITY CONFLICT: ticket ${n} is already registered as ${registered}, but ${requested} was requested. ` +
        `Work-item numbers are unique, so these cannot both be right, and the type is never silently changed. ` +
        `Use ${registered}, or correct the registry entry deliberately if ${requested} is the true reference.`;
}

/** Does this task folder belong to this ticket? Case-insensitive; also finds legacy "Task-1230-"/"Bug-1230-" folders. */
export function folderMatches(folder: string, id: string): boolean {
    const f = folder.toLowerCase();
    const p = parseWorkItemRef(id);
    const prefix = refSlugPrefix(id).toLowerCase();
    if (f === prefix || f.startsWith(prefix + "-") || f === `wi-${id}`.toLowerCase()) return true;
    if (p.number) {
        const legacy = new RegExp(`^[a-z]{1,16}-${p.number}(-|$)`);
        if (legacy.test(f)) return true;
    }
    return false;
}

/** Does this intent file belong to this ticket? Handles the old "0001-WI-<id>-slug.md" names too. */
export function intentFileMatches(file: string, id: string): boolean {
    const f = file.toLowerCase();
    const p = parseWorkItemRef(id);
    const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (f.includes(`-${displayRef(id).toLowerCase()}-`)) return true;
    if (new RegExp(`(^|-)wi-${esc(id.toLowerCase())}(-|\\.|$)`).test(f)) return true;
    if (p.number) {
        const tolerant = new RegExp(`^\\d+-(?:[a-z]+-){0,2}${p.number}-`);
        return tolerant.test(f);
    }
    return false;
}
