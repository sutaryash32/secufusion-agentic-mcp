// @ts-nocheck
import fs from "fs";
import path from "path";
import { z } from "zod";
import { gitTop } from "./diff_quality.js";
import { CATEGORIES, CATEGORY_PURPOSE, STATUSES, KNOWLEDGE_DIR, loadKnowledge, queryKnowledge, renderEntry, createEntry, setStatus, scaffoldKnowledge, inspectAgentsMd, } from "./project_knowledge.js";
/** The directory that owns .mcp/: the nearest ancestor that already has one, else the git root, else the given directory. */
export function knowledgeRoot(start) {
    let d = path.resolve(start);
    for (let i = 0; i < 8; i++) {
        if (fs.existsSync(path.join(d, KNOWLEDGE_DIR)))
            return d;
        const parent = path.dirname(d);
        if (parent === d)
            break;
        d = parent;
    }
    return gitTop(start) ?? path.resolve(start);
}
const text = (t, isError = false) => ({ ...(isError ? { isError: true } : {}), content: [{ type: "text", text: t }] });
export function registerKnowledgeTools(server) {
    server.tool("load_project_knowledge", "Builds the project's unified memory model from the Project Intelligence Layer (.mcp/): architecture knowledge, ADRs, patterns, known exceptions, lessons learned, operational intelligence. " +
        "Used by /sfn-init. Returns a compact index (not the full text), validation problems, and whether agents.md has grown into a knowledge dump. Use get_project_knowledge to read what applies to a task. " +
        "scaffold=true creates the .mcp/ structure if it does not exist.", {
        workspace_root: z.string().describe("A directory inside the project"),
        scaffold: z.boolean().optional().describe("Create the .mcp/ folder structure and README if missing."),
    }, async ({ workspace_root, scaffold }) => {
        try {
            const root = knowledgeRoot(workspace_root);
            let created = [];
            if (scaffold)
                created = scaffoldKnowledge(root);
            const m = loadKnowledge(root);
            const agents = inspectAgentsMd(root);
            if (!m.exists) {
                return text(`📚 No Project Intelligence Layer found at ${path.join(root, KNOWLEDGE_DIR)}.\n` +
                    `Project knowledge currently lives only in agent files and people's heads. Run load_project_knowledge with scaffold=true to create it, ` +
                    `then record what the project already knows with record_project_knowledge.\n` +
                    (agents.warning ? `\n⚠️ ${agents.warning}\n` : ""));
            }
            const byCat = (c) => m.entries.filter((e) => e.category === c);
            const lines = [];
            lines.push(`📚 Project memory model — ${m.entries.length} entr${m.entries.length === 1 ? "y" : "ies"} in ${KNOWLEDGE_DIR}/` + (created.length ? ` (created: ${created.join(", ")})` : ""));
            for (const c of CATEGORIES) {
                const es = byCat(c);
                const acc = es.filter((e) => e.status === "accepted").length;
                lines.push(`\n**${c}** (${es.length}${es.length ? `, ${acc} accepted` : ""}) — ${CATEGORY_PURPOSE[c]}`);
                for (const e of es.slice(0, 25))
                    lines.push(`- \`${e.id}\` ${e.title}${e.status === "accepted" ? "" : ` [${e.status}]`}${e.tags.length ? ` · ${e.tags.join(", ")}` : ""}`);
                if (es.length > 25)
                    lines.push(`- …and ${es.length - 25} more`);
            }
            lines.push(`\n**release-history** (${m.release_history.length}) ${m.release_history.slice(-5).join(", ")}`);
            const unreviewed = m.entries.filter((e) => e.status === "proposed");
            if (unreviewed.length)
                lines.push(`\n⚠️ ${unreviewed.length} proposed (unreviewed) entr${unreviewed.length === 1 ? "y" : "ies"}: treat as hints until a person accepts them (set_knowledge_status).`);
            if (m.problems.length)
                lines.push(`\n⛔ ${m.problems.length} problem(s) in the knowledge files:\n${m.problems.slice(0, 20).map((p) => `- ${p.file}: ${p.code}: ${p.message}`).join("\n")}`);
            if (agents.file)
                lines.push(`\nagents file: ${agents.file} (${agents.lines} lines)` + (agents.warning ? `\n⚠️ ${agents.warning}` : " — lightweight, as intended."));
            lines.push(`\nNext: when working on a task, call get_project_knowledge with the task's terms and the files involved. Do not read every entry.`);
            return text(lines.join("\n"));
        }
        catch (e) {
            return text(`Error: ${e.message}`, true);
        }
    });
    server.tool("get_project_knowledge", "Returns the project knowledge that APPLIES to a task: ranked by the terms (ticket words, entity or service names), files and tags you give, with the reason each matched. " +
        "Use before investigating (terminology traps, known exceptions), before declaring something a bug (is it an intentional exception?), and during review. " +
        "Accepted entries are authoritative project decisions; proposed ones are unreviewed hints; superseded/deprecated are hidden unless include_inactive.", {
        workspace_root: z.string().describe("A directory inside the project"),
        terms: z.array(z.string()).optional().describe("Words from the ticket or code: 'device', 'retention scheduler', 'tenant', a service name"),
        files: z.array(z.string()).optional().describe("Repo-relative paths being touched or reviewed"),
        categories: z.array(z.enum(CATEGORIES)).optional(),
        tags: z.array(z.string()).optional(),
        include_inactive: z.boolean().optional(),
        limit: z.number().int().min(1).max(20).optional(),
    }, async ({ workspace_root, terms, files, categories, tags, include_inactive, limit }) => {
        try {
            const root = knowledgeRoot(workspace_root);
            const m = loadKnowledge(root);
            if (!m.exists)
                return text("No Project Intelligence Layer (.mcp/) in this project. Nothing to consult; run load_project_knowledge with scaffold=true to create it.");
            const hits = queryKnowledge(m.entries, { terms, files, categories, tags, include_inactive, limit });
            if (!hits.length)
                return text(`No project knowledge matches (${m.entries.length} entries searched). That is not evidence that nothing is intentional here: if you find a trap or exception, record it with record_project_knowledge.`);
            return text(`📚 ${hits.length} relevant entr${hits.length === 1 ? "y" : "ies"} of ${m.entries.length}:\n\n` + hits.map((h) => renderEntry(h)).join("\n\n---\n\n"));
        }
        catch (e) {
            return text(`Error: ${e.message}`, true);
        }
    });
    server.tool("record_project_knowledge", "Adds ONE piece of project knowledge to the repository (.mcp/<category>/<id>.md) so it outlives this conversation, this agent and this engineer: a terminology trap, an ADR, a pattern, an intentional exception, a lesson, an operational constraint. " +
        "It is saved as `proposed` (visible but labelled unreviewed) unless the user explicitly confirms it, in which case pass user_statement and status=accepted. " +
        "`source` is mandatory: say where this came from. Record what is TRUE and WHY, and what must NOT be 'fixed'. Never record a guess as knowledge.", {
        workspace_root: z.string().describe("A directory inside the project"),
        category: z.enum(CATEGORIES),
        title: z.string(),
        body: z.string().describe("Markdown: what is true, why, and what must not be changed. Cite file:line where you can."),
        source: z.string().describe("Ticket / PR / incident / person / file this came from"),
        tags: z.array(z.string()).optional(),
        applies_to: z.array(z.string()).optional().describe("Path globs and/or plain terms used to surface this entry when relevant, e.g. 'sfn-iam-api/**', 'device'"),
        supersedes: z.array(z.string()).optional().describe("Ids of entries this replaces; they are marked superseded."),
        status: z.enum(["proposed", "accepted"]).optional(),
        user_statement: z.string().optional().describe("Required with status=accepted: the user's own words confirming this is true."),
        id: z.string().optional(),
    }, async (a) => {
        try {
            if (a.status === "accepted" && !a.user_statement?.trim()) {
                return text("⛔ status=accepted needs user_statement: quote the user confirming this knowledge. Otherwise record it as proposed.", true);
            }
            const root = knowledgeRoot(a.workspace_root);
            const r = createEntry(root, { category: a.category, title: a.title, body: a.body, source: a.source, tags: a.tags, applies_to: a.applies_to, supersedes: a.supersedes, status: a.status, id: a.id });
            return text(`✅ Recorded ${r.entry.status.toUpperCase()} ${r.entry.category} knowledge \`${r.id}\` → ${r.file}\n` +
                (r.entry.status === "proposed" ? `It is labelled unreviewed until a person accepts it (set_knowledge_status or edit \`status:\`).\n` : "") +
                `Commit it with the code so it stays with the project.`);
        }
        catch (e) {
            return text(`⛔ ${e.message}`, true);
        }
    });
    server.tool("set_knowledge_status", "Accept, deprecate or supersede a knowledge entry. Changes only its status line. Requires user_statement: a person decides what the project treats as true.", {
        workspace_root: z.string().describe("A directory inside the project"),
        id: z.string(),
        status: z.enum(STATUSES),
        user_statement: z.string().describe("The user's own words authorising this change."),
    }, async ({ workspace_root, id, status, user_statement }) => {
        try {
            if (!user_statement?.trim())
                return text("⛔ user_statement is required: a person decides what the project treats as true.", true);
            const file = setStatus(knowledgeRoot(workspace_root), id, status);
            return text(`✅ ${id} is now ${status.toUpperCase()} (${file}).`);
        }
        catch (e) {
            return text(`⛔ ${e.message}`, true);
        }
    });
}
