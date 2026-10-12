import fs from "fs";
import path from "path";
import { globToRe } from "./diff_quality.js";

/**
 * Project Intelligence Layer.
 *
 * Project knowledge (architecture, decisions, patterns, accepted exceptions, lessons, operations)
 * lives in the repository under `.mcp/`, version-controlled, owned by the project rather than by
 * any agent, prompt or engineer. agents.md teaches the agent HOW TO THINK; this layer holds WHAT
 * IS TRUE about this project and WHY.
 *
 *   .mcp/
 *     agents.md  (optional, lightweight)
 *     architecture/  adr/  patterns/  known-exceptions/  lessons-learned/  operational/  release-history/
 *
 * Each entry is a markdown file with a small frontmatter block. Only `accepted` entries are
 * authoritative; `proposed` entries are visible but labelled unreviewed.
 */

export const KNOWLEDGE_DIR = ".mcp";
export const CATEGORIES = ["architecture", "adr", "patterns", "known-exceptions", "lessons-learned", "operational"] as const;
export type Category = (typeof CATEGORIES)[number];
export const STATUSES = ["proposed", "accepted", "superseded", "deprecated"] as const;
export type Status = (typeof STATUSES)[number];

export const CATEGORY_PURPOSE: Record<Category, string> = {
    architecture: "System design, service relationships, domain terminology, entity ownership, data flow",
    adr: "Architecture decisions: what was decided, alternatives rejected, reasoning, constraints, tradeoffs",
    patterns: "Coding conventions, API/Kafka/repository patterns, naming standards",
    "known-exceptions": "Intentional inconsistencies, legacy constraints, backward-compatibility decisions, accepted technical debt",
    "lessons-learned": "Incidents, review findings, historical bugs, investigation outcomes, common false positives",
    operational: "Deployment constraints, migration knowledge, environment-specific behaviour, risk areas",
};

export interface KnowledgeEntry {
    id: string;
    title: string;
    category: Category;
    status: Status;
    tags: string[];
    applies_to: string[];
    source: string;
    date: string;
    supersedes: string[];
    file: string;
    body: string;
}

export interface KnowledgeProblem { file: string; code: string; message: string }

// ── frontmatter (a small, strict subset: scalars and string lists) ──────────

const FM = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

function parseValue(raw: string): string | string[] {
    const v = raw.trim();
    if (v.startsWith("[")) {
        try { const a = JSON.parse(v); if (Array.isArray(a)) return a.map(String); } catch { /* fall through */ }
        return v.replace(/^\[|\]$/g, "").split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    }
    if (v.startsWith('"')) { try { return String(JSON.parse(v)); } catch { /* fall through */ } }
    return v.replace(/^'(.*)'$/, "$1");
}

function parseMeta(block: string): Record<string, string | string[]> {
    const meta: Record<string, string | string[]> = {};
    for (const line of block.split(/\r?\n/)) {
        const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
        if (kv) meta[kv[1]] = parseValue(kv[2]);
    }
    return meta;
}

export function parseFrontmatter(text: string): { meta: Record<string, string | string[]>; body: string } | null {
    const m = FM.exec(text);
    if (!m) return null;
    return { meta: parseMeta(m[1]), body: text.slice(m[0].length).replace(/^\s+/, "") };
}

/**
 * Metadata for human-first documents (ADRs) sits at the END of the file in an HTML comment, so the reader meets the title and
 * the executive summary, not machine fields. It is invisible when the Markdown is rendered.
 */
const TRAILER = /\r?\n[ \t]*<!--[ \t]*mcp:entry[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*-->[ \t]*(?:\r?\n)*$/;

/** An entry's metadata and body, from front matter at the top (any category) or the `mcp:entry` block at the end. */
export function parseEntryText(text: string): { meta: Record<string, string | string[]>; body: string } | null {
    const fm = parseFrontmatter(text);
    if (fm) return fm;
    const m = TRAILER.exec(text);
    if (!m) return null;
    return { meta: parseMeta(m[1]), body: text.slice(0, m.index).replace(/^﻿/, "").trim() };
}

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" && v ? [v] : []);

function metaLines(e: Omit<KnowledgeEntry, "file">): string[] {
    const j = (x: unknown) => JSON.stringify(x);
    return [
        `id: ${j(e.id)}`,
        `title: ${j(e.title)}`,
        `category: ${e.category}`,
        `status: ${e.status}`,
        `tags: ${j(e.tags)}`,
        `applies_to: ${j(e.applies_to)}`,
        `source: ${j(e.source)}`,
        `date: ${e.date}`,
        `supersedes: ${j(e.supersedes)}`,
    ];
}

export function serializeEntry(e: Omit<KnowledgeEntry, "file">): string {
    // ADRs are documents first: title and executive summary on top, machine metadata in a trailing comment.
    if (e.category === "adr") {
        return [e.body.trim(), "", "<!-- mcp:entry", "Machine-readable metadata for the MCP project knowledge layer. Change the status with set_knowledge_status.", ...metaLines(e), "-->", ""].join("\n");
    }
    return ["---", ...metaLines(e), "---", "", e.body.trim(), ""].join("\n");
}

// ── ADR format: a design narrative, not a database record ───────────────────

export const ADR_SECTIONS = ["Decision Snapshot", "Executive Summary", "Context", "Problem Statement", "Investigation Summary", "Options Considered", "Decision", "Consequences", "Verification", "References"];
export const ADR_SNAPSHOT_FIELDS = ["Problem", "Decision", "Outcome", "Status", "Related Work"];
export const ADR_CONSEQUENCE_PARTS = ["Benefits", "Trade-Offs", "Risks", "Future Reconsideration Criteria"];
const STATUS_LABEL: Record<string, string> = { proposed: "Proposed", accepted: "Accepted", superseded: "Superseded", deprecated: "Deprecated" };

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");

/** The body without a leading H1: the tool owns the title line (`# ADR-NNNN: Title`). */
export function stripAdrTitle(body: string): string {
    return body.replace(/^\s*#[ \t]+[^\r\n]*\r?\n/, "").trim();
}

/** What is wrong with an ADR body, if anything. The first page must answer: what problem, why it mattered, what was chosen, why. */
export function validateAdrBody(body: string): string[] {
    const b = stripAdrTitle(body);
    const problems: string[] = [];
    const first = b.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
    if (/^(---|[A-Za-z_][\w-]*\s*:\s)/.test(first.trim())) problems.push("it begins with metadata (YAML-looking fields). Start with a one-sentence summary; the MCP stores its metadata at the end of the file");
    else if (!first.trim().startsWith(">")) problems.push("it must open with a one-sentence summary as a blockquote (`> ...`) directly under the title: the problem being solved and the selected approach");
    for (const s of ADR_SECTIONS) if (!new RegExp(`^##[ \\t]+${esc(s)}[ \\t]*$`, "m").test(b)) problems.push(`missing section \`## ${s}\``);
    for (const f of ADR_SNAPSHOT_FIELDS) if (!new RegExp(`^\\*\\*${esc(f)}\\*\\*[ \\t]*$`, "m").test(b)) problems.push(`Decision Snapshot is missing \`**${f}**\``);
    for (const c of ADR_CONSEQUENCE_PARTS) if (!new RegExp(`^###[ \\t]+${esc(c)}[ \\t]*$`, "m").test(b)) problems.push(`Consequences is missing \`### ${c}\``);
    return problems;
}

/** Keep the human-readable **Status** line in the Decision Snapshot in step with the recorded status. */
export function syncStatusLine(body: string, status: string): string {
    return body.replace(/(^\*\*Status\*\*[ \t]*\r?\n+)([^\r\n]+)/m, (_m, head) => head + (STATUS_LABEL[status] ?? status));
}

export function composeAdr(num: string, title: string, body: string, status: string): string {
    return `# ADR-${num}: ${title.trim()}\n\n${syncStatusLine(stripAdrTitle(body), status)}\n`;
}

// ── loading and validation ──────────────────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
    if (!fs.existsSync(dir)) return out;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (e.name.toLowerCase().endsWith(".md") && e.name.toLowerCase() !== "readme.md") out.push(p);
    }
    return out;
}

export interface KnowledgeModel {
    exists: boolean;
    root: string;
    entries: KnowledgeEntry[];
    problems: KnowledgeProblem[];
    release_history: string[];
}

export function loadKnowledge(workspaceRoot: string): KnowledgeModel {
    const root = path.join(workspaceRoot, KNOWLEDGE_DIR);
    const model: KnowledgeModel = { exists: fs.existsSync(root), root, entries: [], problems: [], release_history: [] };
    if (!model.exists) return model;

    const seen = new Map<string, string>();
    for (const cat of CATEGORIES) {
        for (const abs of walk(path.join(root, cat))) {
            const rel = path.relative(workspaceRoot, abs).split(path.sep).join("/");
            const problem = (code: string, message: string) => model.problems.push({ file: rel, code, message });
            const parsed = parseEntryText(fs.readFileSync(abs, "utf-8"));
            if (!parsed) { problem("MISSING_FRONTMATTER", "No metadata block: add front matter at the top, or an `<!-- mcp:entry ... -->` block at the end, with id, title, status and source."); continue; }
            const { meta, body } = parsed;
            const id = String(meta.id ?? "").trim(), title = String(meta.title ?? "").trim(), source = String(meta.source ?? "").trim();
            if (!id) problem("MISSING_FIELD", "id is required");
            if (!title) problem("MISSING_FIELD", "title is required");
            if (!source) problem("MISSING_FIELD", "source is required (where this knowledge came from)");
            const fmCat = String(meta.category ?? cat);
            if (fmCat !== cat) problem("CATEGORY_MISMATCH", `category '${fmCat}' does not match its folder '${cat}'`);
            const status = String(meta.status ?? "");
            if (!(STATUSES as readonly string[]).includes(status)) problem("BAD_STATUS", `status '${status}' must be one of ${STATUSES.join(", ")}`);
            if (!body.trim()) problem("EMPTY_BODY", "the entry has no content");
            if (id) {
                if (seen.has(id)) problem("DUPLICATE_ID", `id '${id}' is also used by ${seen.get(id)}`);
                else seen.set(id, rel);
            }
            if (!id || !title) continue;
            model.entries.push({
                id, title, category: cat, status: ((STATUSES as readonly string[]).includes(status) ? status : "proposed") as Status,
                tags: asList(meta.tags), applies_to: asList(meta.applies_to), source, date: String(meta.date ?? ""),
                supersedes: asList(meta.supersedes), file: rel, body,
            });
        }
    }
    const ids = new Set(model.entries.map((e) => e.id));
    for (const e of model.entries) {
        for (const s of e.supersedes) if (!ids.has(s)) model.problems.push({ file: e.file, code: "DANGLING_SUPERSEDES", message: `supersedes '${s}', which does not exist` });
    }
    const rh = path.join(root, "release-history");
    if (fs.existsSync(rh)) model.release_history = fs.readdirSync(rh).filter((f) => f.endsWith(".md")).sort();
    return model;
}

// ── retrieval: what applies here, not everything ────────────────────────────

export interface KnowledgeQuery {
    terms?: string[];
    files?: string[];
    categories?: Category[];
    tags?: string[];
    include_inactive?: boolean;
    limit?: number;
}

export interface ScoredEntry { entry: KnowledgeEntry; score: number; why: string[] }

const isPathLike = (s: string) => /[/*.\\]/.test(s);
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length >= 3);

/**
 * Generic words that carry no project meaning. They are dropped from FREE TEXT (a ticket title, a sentence)
 * so that "wrong label for user count" does not match every entry that mentions a user. A single explicit
 * term ("user") is still honoured, because the caller chose it on purpose.
 */
const GENERIC = new Set(("the and for with without from into when then that this have been should must does not are was were its their there which what who " +
    "user users label labels count counts incorrect wrong error errors issue issues data value values name names item items page dialog screen button " +
    "request response return returns show shows shown display displays new add fix bug update change changes using used use get set make makes need needs " +
    "can cannot also only just some any all each both more most other such than too very").split(" "));

function termWords(t: string): string[] {
    const ws = words(t);
    return ws.length > 1 ? ws.filter((w) => !GENERIC.has(w)) : ws;
}

export function queryKnowledge(entries: KnowledgeEntry[], q: KnowledgeQuery): ScoredEntry[] {
    const terms = [...new Set((q.terms ?? []).flatMap((t) => termWords(t)))];
    const files = (q.files ?? []).map((f) => f.split("\\").join("/"));
    const wantTags = (q.tags ?? []).map((t) => t.toLowerCase());
    const scored: ScoredEntry[] = [];
    for (const e of entries) {
        if (!q.include_inactive && (e.status === "superseded" || e.status === "deprecated")) continue;
        if (q.categories?.length && !q.categories.includes(e.category)) continue;
        let score = 0;
        const why: string[] = [];
        const head = `${e.title} ${e.tags.join(" ")} ${e.applies_to.filter((a) => !isPathLike(a)).join(" ")} ${e.id}`.toLowerCase();
        const body = e.body.toLowerCase();
        for (const t of terms) {
            if (head.includes(t)) { score += 3; why.push(`term "${t}" in title/tags`); }
            else if (body.includes(t)) { score += 1; why.push(`term "${t}" in body`); }
        }
        for (const pat of e.applies_to.filter(isPathLike)) {
            const re = (() => { try { return globToRe(pat); } catch { return null; } })();
            const hit = files.find((f) => re?.test(f) || f.includes(pat.replace(/\*/g, "")));
            if (hit) { score += 4; why.push(`applies to ${hit}`); }
        }
        for (const t of wantTags) if (e.tags.map((x) => x.toLowerCase()).includes(t)) { score += 3; why.push(`tag ${t}`); }
        // A single common word appearing somewhere in a body is not relevance. Require a strong signal
        // (title/tag/applies_to/file/tag match) or at least two body matches. The accepted bonus cannot rescue a weak match.
        const categoryOnly = !!q.categories?.length && !terms.length && !files.length && !wantTags.length;
        if (score < 2 && !categoryOnly) continue;
        if (e.status === "accepted") score += 1;
        scored.push({ entry: e, score, why: [...new Set(why)].slice(0, 4) });
    }
    return scored.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id)).slice(0, q.limit ?? 8);
}

export function renderEntry(s: ScoredEntry, maxBody = 2500): string {
    const e = s.entry;
    const flag = e.status === "accepted" ? "" : ` ⚠️ ${e.status.toUpperCase()}${e.status === "proposed" ? " (unreviewed: treat as a hint, not a rule)" : ""}`;
    const body = e.body.length > maxBody ? e.body.slice(0, maxBody) + "\n…(truncated; full text in " + e.file + ")" : e.body;
    return `### ${e.title}  \`${e.id}\`  [${e.category}]${flag}\nSource: ${e.source}${e.date ? ` · ${e.date}` : ""} · File: ${e.file}${s.why.length ? `\nMatched: ${s.why.join("; ")}` : ""}\n\n${body.trim()}`;
}

// ── writing (making knowledge easy to add) ──────────────────────────────────

export const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

export function nextAdrNumber(model: KnowledgeModel): string {
    const nums = model.entries.filter((e) => e.category === "adr").map((e) => Number(/^adr-(\d+)/.exec(e.id)?.[1] ?? 0));
    return String((nums.length ? Math.max(...nums) : 0) + 1).padStart(4, "0");
}

/** Per-category starter templates: what a good entry of that kind answers. Written to .mcp/templates/. */
export const TEMPLATE_BODIES: Record<Category, { status: Status; tags: string; guide: string }> = {
    architecture: {
        status: "proposed", tags: '["terminology"]',
        guide: `# <What this describes: a service, a boundary, a term, a data flow>

**What it is.** One or two sentences a new engineer can act on.

**How it relates to the rest.** Which services, tables, topics or screens it touches (name them exactly; names are how this entry is found).

**What is easy to get wrong.** The misreading that has cost time, and the correct reading.

**Do not "fix".** Anything that looks inconsistent but is deliberate.`,
    },
    adr: {
        status: "proposed", tags: '["decision"]',
        guide: `# ADR-XXXX: <Decision Title>

> One concise sentence: the architectural problem being solved and the selected approach.

## Decision Snapshot

**Problem**

One paragraph explaining the architecture problem.

**Decision**

One paragraph explaining the selected solution.

**Outcome**

One paragraph explaining the resulting behavior.

**Status**

Proposed

**Related Work**

- STORY-XXXX
- PR-XXXX
- Investigation document
- Related ADRs

---

## Executive Summary

A concise business and engineering summary. A reviewer should understand what problem existed, why it mattered, what was decided and why, without reading the rest.

---

## Context

The original architecture and the circumstances.

---

## Problem Statement

The architectural concern that triggered the investigation.

---

## Investigation Summary

The key discoveries that led to the decision.

---

## Options Considered

Every alternative, and why each was accepted or rejected.

---

## Decision

The selected architecture.

---

## Consequences

### Benefits

### Trade-Offs

### Risks

### Future Reconsideration Criteria

---

## Verification

Tests, reviews, validation and acceptance criteria.

---

## References

- Investigation document
- Story
- Review notes
- Related ADRs`,
    },
    patterns: {
        status: "proposed", tags: '["convention"]',
        guide: `# <The pattern or convention>

**Rule.** How it is done here.

**Example.** A real file and line that does it correctly.

**Why.** What goes wrong otherwise.

**Exceptions.** Where it is deliberately not followed (and link the known-exception).`,
    },
    "known-exceptions": {
        status: "proposed", tags: '["intentional"]',
        guide: `# <What looks wrong but is intentional>

**What it looks like.** The thing a reviewer or a bug report would flag.

**Why it is intentional.** The reason, the decision or the constraint behind it.

**Do not change it unless.** The condition under which it should be revisited.

**How to recognise it.** File, class or behaviour to look for (name them exactly).`,
    },
    "lessons-learned": {
        status: "proposed", tags: '["incident"]',
        guide: `# <What happened, in one line>

**What happened.** The facts: when, where, impact.

**What it taught.** The cause that was not obvious.

**What to do differently.** The concrete practice or check that prevents a repeat.

**Common misreading / false positive.** The wrong conclusion people draw from the symptoms.`,
    },
    operational: {
        status: "proposed", tags: '["deployment"]',
        guide: `# <Deployment, migration, environment or runtime fact>

**What is true.** The behaviour or constraint.

**Where it applies.** Environment, service, step in the release process.

**What breaks if ignored.** The failure mode.

**How to do it correctly.** The exact steps or commands.`,
    },
};

/** Writes the starter templates (never overwrites). Returns what it created. */
function writeTemplates(root: string): string[] {
    const dir = path.join(root, "templates");
    const created: string[] = [];
    fs.mkdirSync(dir, { recursive: true });
    for (const c of CATEGORIES) {
        const file = path.join(dir, `${c}.md`);
        if (fs.existsSync(file)) continue;
        const t = TEMPLATE_BODIES[c];
        if (c === "adr") {
            // an ADR template is a document first; its metadata sits at the end, like a real ADR's
            fs.writeFileSync(file, [
                t.guide, "", "<!-- mcp:entry", "Machine-readable metadata. Replace these values; the MCP writes this block itself when you use record_project_knowledge.",
                'id: "adr-0000-replace-with-a-short-unique-id"', 'title: "Replace with the decision title"', "category: adr", `status: ${t.status}`, `tags: ${t.tags}`,
                'applies_to: ["a term people search for", "path/glob/**"]', 'source: "Ticket, PR, incident, person or file this came from (required)"',
                `date: ${new Date().toISOString().slice(0, 10)}`, "supersedes: []", "-->", "",
            ].join("\n"));
            created.push(`${KNOWLEDGE_DIR}/templates/${c}.md`);
            continue;
        }
        fs.writeFileSync(file, [
            "---",
            'id: "replace-with-a-short-unique-id"',
            'title: "Replace with a human-readable title"',
            `category: ${c}`,
            `status: ${t.status}`,
            `tags: ${t.tags}`,
            'applies_to: ["a term people search for", "path/glob/**"]',
            'source: "Ticket, PR, incident, person or file this came from (required)"',
            `date: ${new Date().toISOString().slice(0, 10)}`,
            "supersedes: []",
            "---",
            "",
            t.guide,
            "",
        ].join("\n"));
        created.push(`${KNOWLEDGE_DIR}/templates/${c}.md`);
    }
    return created;
}

/**
 * Opt-in: should /sfn-init create .mcp/ without being asked? Off unless enabled by
 * SECUFUSION_AUTO_SCAFFOLD=1 or `_meta.auto_scaffold_knowledge: true` in the project spec.
 */
export function autoScaffoldEnabled(workspaceRoot: string): { enabled: boolean; via: string | null } {
    const env = (process.env.SECUFUSION_AUTO_SCAFFOLD ?? "").toLowerCase();
    if (env === "1" || env === "true") return { enabled: true, via: "SECUFUSION_AUTO_SCAFFOLD" };
    try {
        const spec = JSON.parse(fs.readFileSync(path.join(workspaceRoot, ".secufusion-project-spec.json"), "utf-8").replace(/^\uFEFF/, ""));
        if (spec?._meta?.auto_scaffold_knowledge === true) return { enabled: true, via: "_meta.auto_scaffold_knowledge" };
    } catch { /* no spec, or unreadable: stay off */ }
    return { enabled: false, via: null };
}

export function scaffoldKnowledge(workspaceRoot: string): string[] {
    const root = path.join(workspaceRoot, KNOWLEDGE_DIR);
    const created: string[] = [];
    for (const d of [...CATEGORIES, "release-history"]) {
        const dir = path.join(root, d);
        if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); created.push(`${KNOWLEDGE_DIR}/${d}/`); }
        const keep = path.join(dir, ".gitkeep");
        if (!fs.existsSync(keep) && fs.readdirSync(dir).length === 0) fs.writeFileSync(keep, "");
    }
    const readme = path.join(root, "README.md");
    if (!fs.existsSync(readme)) {
        fs.writeFileSync(readme, README_TEXT);
        created.push(`${KNOWLEDGE_DIR}/README.md`);
    }
    created.push(...writeTemplates(root));
    return created;
}

export interface NewEntry {
    category: Category;
    title: string;
    body: string;
    tags?: string[];
    applies_to?: string[];
    source: string;
    status?: Status;
    supersedes?: string[];
    id?: string;
}

export function createEntry(workspaceRoot: string, n: NewEntry): { file: string; id: string; entry: KnowledgeEntry } {
    if (!n.title.trim()) throw new Error("title is required");
    if (!n.body.trim()) throw new Error("body is required");
    if (!n.source.trim()) throw new Error("source is required: where this knowledge came from (ticket, PR, incident, file, conversation)");
    const model = loadKnowledge(workspaceRoot);
    const base = slug(n.id ?? n.title) || "entry";
    const id = n.category === "adr" && !n.id ? `adr-${nextAdrNumber(model)}-${base}` : base;
    if (model.entries.some((e) => e.id === id)) throw new Error(`An entry with id '${id}' already exists. Use a different title, or supersede the existing one.`);
    for (const s of n.supersedes ?? []) if (!model.entries.some((e) => e.id === s)) throw new Error(`Cannot supersede '${s}': no such entry.`);
    const status = n.status ?? "proposed";
    let body = n.body;
    if (n.category === "adr") {
        const problems = validateAdrBody(n.body);
        if (problems.length) {
            throw new Error(
                `The ADR does not follow the ADR format standard:\n- ${problems.join("\n- ")}\n\n` +
                `An ADR reads like an engineering design narrative. Under the title (the tool writes \`# ADR-NNNN: <Decision Title>\`) give: a one-sentence \`>\` summary; ` +
                `## ${ADR_SECTIONS.join(", ## ")}. The Decision Snapshot holds ${ADR_SNAPSHOT_FIELDS.map((f) => `**${f}**`).join(", ")}; Consequences holds ${ADR_CONSEQUENCE_PARTS.map((f) => `### ${f}`).join(", ")}. ` +
                `The first page must answer: what problem, why it mattered, what was chosen, why. Do not start with metadata; the MCP stores it at the end of the file.`);
        }
        body = composeAdr(/^adr-(\d+)/.exec(id)?.[1] ?? nextAdrNumber(model), n.title, n.body, status);
    }
    scaffoldKnowledge(workspaceRoot);
    const entry: Omit<KnowledgeEntry, "file"> = {
        id, title: n.title.trim(), category: n.category, status,
        tags: n.tags ?? [], applies_to: n.applies_to ?? [], source: n.source.trim(),
        date: new Date().toISOString().slice(0, 10), supersedes: n.supersedes ?? [], body,
    };
    const rel = `${KNOWLEDGE_DIR}/${n.category}/${id}.md`;
    const abs = path.join(workspaceRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, serializeEntry(entry), "utf-8");
    for (const s of n.supersedes ?? []) setStatus(workspaceRoot, s, "superseded");
    return { file: rel, id, entry: { ...entry, file: rel } };
}

/** Rewrites only the `status:` line, leaving everything else byte-for-byte. */
export function setStatus(workspaceRoot: string, id: string, status: Status): string {
    const e = loadKnowledge(workspaceRoot).entries.find((x) => x.id === id);
    if (!e) throw new Error(`No knowledge entry with id '${id}'.`);
    const abs = path.join(workspaceRoot, e.file);
    const raw = fs.readFileSync(abs, "utf-8");
    let next = raw.replace(/^(status:\s*).*$/m, `$1${status}`);
    if (e.category === "adr") next = syncStatusLine(next, status); // the Decision Snapshot's readable Status line follows
    if (next === raw && e.status !== status) throw new Error(`Could not update status in ${e.file}.`);
    fs.writeFileSync(abs, next, "utf-8");
    return e.file;
}

// ── agents.md health: it should teach HOW TO THINK, not hold project history ─

export const AGENTS_MD_SOFT_LIMIT = 250;

/** Every agent-facing instruction file the project has, in priority order. Project knowledge can hide in any of them. */
export function listAgentFiles(workspaceRoot: string): string[] {
    const fixed = [".mcp/agents.md", ".mcp/AGENTS.md", "AGENTS.md", "CLAUDE.md", ".agents/AGENTS.md", ".agents/claude.md", "agents/AGENTS.md"];
    const found: string[] = fixed.filter((rel) => fs.existsSync(path.join(workspaceRoot, rel)));
    // skill bundles carry their own copy: .agents/skills/<skill>/references/AGENTS.md
    const skills = path.join(workspaceRoot, ".agents", "skills");
    if (fs.existsSync(skills)) {
        for (const d of fs.readdirSync(skills, { withFileTypes: true })) {
            if (!d.isDirectory()) continue;
            const rel = `.agents/skills/${d.name}/references/AGENTS.md`;
            if (fs.existsSync(path.join(workspaceRoot, rel))) found.push(rel);
        }
    }
    return found;
}

export function inspectAgentsMd(workspaceRoot: string): { file: string | null; lines: number; warning: string | null; files: Array<{ file: string; lines: number }> } {
    const files = listAgentFiles(workspaceRoot).map((rel) => ({ file: rel, lines: fs.readFileSync(path.join(workspaceRoot, rel), "utf-8").split(/\r?\n/).length }));
    if (!files.length) return { file: null, lines: 0, warning: null, files };
    const primary = files[0];
    const over = files.filter((f) => f.lines > AGENTS_MD_SOFT_LIMIT).sort((x, y) => y.lines - x.lines);
    const w = over[0];
    return {
        file: primary.file, lines: primary.lines, files,
        warning: w
            ? `${w.file} is ${w.lines} lines (soft limit ${AGENTS_MD_SOFT_LIMIT}). It should hold workflow rules and engineering philosophy; move project-specific history, terminology and exceptions into .mcp/ (use record_project_knowledge).`
            : null,
    };
}

const README_TEXT = `# Project Intelligence Layer

This folder is the project's own memory. It is version-controlled with the code so that any engineer,
reviewer or AI agent can understand **why** the system is the way it is, without tribal knowledge.

This is Layer 2 of the Unified Project Knowledge System. Layer 1, the DNA (.secufusion/dna.json), is generated from the code
and answers "what exists?". This folder answers "why does it exist?" and cannot be regenerated from the code.

The code explains WHAT the system does. This folder explains:
WHY it was designed this way, WHICH decisions are intentional, WHICH patterns are preferred,
WHICH inconsistencies are legacy, WHICH behaviours must not change, WHICH mistakes were already
found, and WHICH assumptions are dangerous.

| Folder | Holds |
|---|---|
| \`architecture/\` | System design, service relationships, domain terminology, entity ownership, data flow |
| \`adr/\` | Architecture decisions: decision, rejected alternatives, reasoning, constraints, tradeoffs |
| \`patterns/\` | Coding conventions, API / Kafka / repository patterns, naming standards |
| \`known-exceptions/\` | Intentional inconsistencies, legacy constraints, accepted technical debt |
| \`lessons-learned/\` | Incidents, review findings, historical bugs, common false positives |
| \`operational/\` | Deployment constraints, migration knowledge, environment behaviour, risk areas |
| \`release-history/\` | Change-driven release notes and the snapshots they compare against |

\`agents.md\` (if present) stays lightweight: workflow rules and engineering philosophy only.

## Adding knowledge

Found a terminology trap, a decision, an exception, a lesson? Add one file. Either ask the agent
(\`record_project_knowledge\`) or copy the template for its category from \`templates/\` (each says what a good
entry of that kind answers). The generic shape is:

\`\`\`markdown
---
id: "short-unique-id"
title: "Human readable title"
category: known-exceptions        # must match the folder
status: proposed                  # proposed | accepted | superseded | deprecated
tags: ["terminology", "device"]
applies_to: ["sfn-iam-api/**", "device"]   # path globs and/or terms; used to surface it when relevant
source: "Ticket / PR / incident / person: where this came from"
date: 2026-10-08
supersedes: []
---
What is true, and why. Say what must NOT be "fixed".
\`\`\`

\`proposed\` entries are shown to agents but labelled unreviewed. A person marks an entry \`accepted\`
(by editing \`status:\` or via \`set_knowledge_status\`) once they agree it is true.
`;
