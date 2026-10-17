// @ts-nocheck
import fs from "fs";
import path from "path";
import { z } from "zod";
import { gitTop } from "./diff_quality.js";
import {
  CATEGORIES, CATEGORY_PURPOSE, STATUSES, KNOWLEDGE_DIR, loadKnowledge, queryKnowledge, renderEntry,
  createEntry, setStatus, scaffoldKnowledge, EXTRA_KEYS, inspectAgentsMd, autoScaffoldEnabled,
} from "./project_knowledge.js";
import { seedDefaultKnowledge } from "./default_knowledge.js";
import { buildHealth, renderHealth, renderUnifiedKnowledge, renderSuggestions, readLookups, recordLookup, findRepeated, significantTerms } from "./knowledge_health.js";

/** The directory that owns .mcp/: the nearest ancestor that already has one, else the git root, else the given directory. */
export function knowledgeRoot(start: string): string {
  let d = path.resolve(start);
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(d, KNOWLEDGE_DIR))) return d;
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return gitTop(start) ?? path.resolve(start);
}

function readJsonLoose(p: string): any | null {
  try { return JSON.parse(fs.readFileSync(p, "utf-8").replace(/^\uFEFF/, "")); } catch { return null; }
}
const loadSpec = (root: string) => readJsonLoose(path.join(root, ".secufusion-project-spec.json"));
const loadDna = (root: string) => readJsonLoose(path.join(root, ".secufusion", "dna.json"));

const WHY_LAYER =
  "Why it matters: the code explains WHAT the system does; `.mcp/` records WHY (decisions, intentional exceptions, terminology traps, lessons), " +
  "version-controlled with the code so it survives engineer turnover, MCP upgrades and prompt changes. Without it every new engineer or agent " +
  "rediscovers the same traps. Scaffolding creates structure and templates only: it never invents knowledge.";

const text = (t: string, isError = false) => ({ ...(isError ? { isError: true } : {}), content: [{ type: "text", text: t }] });

export function registerKnowledgeTools(server: any): void {
  server.tool(
    "load_project_knowledge",
    "Builds the project's unified memory model from the Project Intelligence Layer (.mcp/): architecture knowledge, ADRs, patterns, known exceptions, lessons learned, operational intelligence. " +
    "Used by /sfn-init. Returns a compact index (not the full text), validation problems, and whether agents.md has grown into a knowledge dump. Use get_project_knowledge to read what applies to a task. " +
    "scaffold=true creates the .mcp/ structure if it does not exist. seed_defaults=true (what /sfn-init passes) also records the platform knowledge the MCP ships " +
    "(Device vs Machine terminology) as `proposed` with its source, skipping anything the project already records and never overwriting.",
    {
      workspace_root: z.string().describe("A directory inside the project"),
      scaffold: z.boolean().optional().describe("Create the .mcp/ folder structure and README if missing."),
      seed_defaults: z.boolean().optional().describe("Record the MCP-shipped platform defaults (Device vs Machine terminology) as proposed entries when .mcp/ exists. Idempotent; skips anything already recorded."),
    },
    async ({ workspace_root, scaffold, seed_defaults }) => {
      try {
        const root = knowledgeRoot(workspace_root);
        let created: string[] = [];
        const auto = autoScaffoldEnabled(root);
        const wasMissing = !fs.existsSync(path.join(root, KNOWLEDGE_DIR));
        if (scaffold || (wasMissing && auto.enabled)) created = scaffoldKnowledge(root);
        const seeded = seed_defaults && fs.existsSync(path.join(root, KNOWLEDGE_DIR)) ? seedDefaultKnowledge(root) : null;
        const seedNote = seeded
          ? [
              ...seeded.created.map((id) => `🌱 Recorded the platform default \`${id}\` as PROPOSED (shipped with the MCP; confirm it, then accept it with set_knowledge_status and the user's words).`),
              ...seeded.skipped.map((s) => `🌱 Platform default \`${s.id}\` not added: ${s.reason}.`),
            ].join("\n")
          : "";
        const m = loadKnowledge(root);
        const agents = inspectAgentsMd(root);
        if (!m.exists) {
          return text(
            `📚 No Project Intelligence Layer found at ${path.join(root, KNOWLEDGE_DIR).split(path.sep).join("/")}.\n\n${WHY_LAYER}\n\n` +
            `Next: run load_project_knowledge with scaffold=true to create .mcp/ (folders, README and a template per category), then record what the project already knows with record_project_knowledge. ` +
            `To create it automatically on every /sfn-init, set _meta.auto_scaffold_knowledge to true in .secufusion-project-spec.json (or SECUFUSION_AUTO_SCAFFOLD=1). It is off by default.\n` +
            (agents.warning ? `\n⚠️ ${agents.warning}\n` : "")
          );
        }
        if (wasMissing && created.length) {
          // just created: say so, and say why, without pretending there is knowledge yet
          return text(
            `📚 Created the Project Intelligence Layer at ${path.join(root, KNOWLEDGE_DIR).split(path.sep).join("/")}` + (auto.enabled && !scaffold ? ` (automatically, via ${auto.via})` : "") + `.\n\n${WHY_LAYER}\n\n` +
            `Created: ${created.join(", ")}\n\n` + (seedNote ? `${seedNote}\n\n` : "It is empty, so nothing has been claimed yet. ") +
            `Use the templates in .mcp/templates/ or record_project_knowledge to add entries (saved as proposed until a person accepts them). ` +
            `Run get_knowledge_health to see what the project spec says exists but is not yet documented.` +
            (agents.warning ? `\n\n⚠️ ${agents.warning}` : "")
          );
        }
        const byCat = (c: string) => m.entries.filter((e) => e.category === c);
        const lines: string[] = [];
        if (seedNote) lines.push(seedNote + "\n");
        lines.push(`📚 Project memory model — ${m.entries.length} entr${m.entries.length === 1 ? "y" : "ies"} in ${KNOWLEDGE_DIR}/` + (created.length ? ` (created: ${created.join(", ")})` : ""));
        for (const c of CATEGORIES) {
          const es = byCat(c);
          const acc = es.filter((e) => e.status === "accepted").length;
          lines.push(`\n**${c}** (${es.length}${es.length ? `, ${acc} accepted` : ""}) — ${CATEGORY_PURPOSE[c]}`);
          for (const e of es.slice(0, 25)) lines.push(`- \`${e.id}\` ${e.title}${e.status === "accepted" ? "" : ` [${e.status}]`}${e.tags.length ? ` · ${e.tags.join(", ")}` : ""}`);
          if (es.length > 25) lines.push(`- …and ${es.length - 25} more`);
        }
        lines.push(`\n**release-history** (${m.release_history.length}) ${m.release_history.slice(-5).join(", ")}`);
        const unreviewed = m.entries.filter((e) => e.status === "proposed");
        if (unreviewed.length) lines.push(`\n⚠️ ${unreviewed.length} proposed (unreviewed) entr${unreviewed.length === 1 ? "y" : "ies"}: treat as hints until a person accepts them (set_knowledge_status).`);
        if (m.problems.length) lines.push(`\n⛔ ${m.problems.length} problem(s) in the knowledge files:\n${m.problems.slice(0, 20).map((p) => `- ${p.file}: ${p.code}: ${p.message}`).join("\n")}`);
        if (agents.file) lines.push(`\nagents file: ${agents.file} (${agents.lines} lines)` + (agents.warning ? `\n⚠️ ${agents.warning}` : " — lightweight, as intended."));
        try { lines.push("\n" + renderUnifiedKnowledge(loadDna(root), m)); } catch { /* optional view */ }
        try {
          const health = buildHealth({ spec: loadSpec(root), dna: loadDna(root), model: m, workspaceRoot: root, events: readLookups(root) });
          lines.push(`\n${renderHealth(health)}`);
          if (health.suggestions.length) lines.push(`\n${renderSuggestions(health.suggestions, 3)}\n(call suggest_project_knowledge for the full list)`);
        } catch { /* the index is still valid without the health report */ }
        lines.push(`\nNext: when working on a task, call get_project_knowledge with the task's terms and the files involved. Do not read every entry.`);
        return text(lines.join("\n"));
      } catch (e: any) { return text(`Error: ${e.message}`, true); }
    }
  );

  server.tool(
    "get_project_knowledge",
    "Returns the project knowledge that APPLIES to a task: ranked by the terms (ticket words, entity or service names), files and tags you give, with the reason each matched. " +
    "Use before investigating (terminology traps, known exceptions), before declaring something a bug (is it an intentional exception?), and during review. " +
    "Accepted entries are authoritative project decisions; proposed ones are unreviewed hints; superseded/deprecated are hidden unless include_inactive.",
    {
      workspace_root: z.string().describe("A directory inside the project"),
      terms: z.array(z.string()).optional().describe("Words from the ticket or code: 'device', 'retention scheduler', 'tenant', a service name"),
      files: z.array(z.string()).optional().describe("Repo-relative paths being touched or reviewed"),
      categories: z.array(z.enum(CATEGORIES as any)).optional(),
      tags: z.array(z.string()).optional(),
      include_inactive: z.boolean().optional(),
      limit: z.number().int().min(1).max(20).optional(),
    },
    async ({ workspace_root, terms, files, categories, tags, include_inactive, limit }) => {
      try {
        const root = knowledgeRoot(workspace_root);
        const m = loadKnowledge(root);
        if (!m.exists) return text("No Project Intelligence Layer (.mcp/) in this project. Nothing to consult; run load_project_knowledge with scaffold=true to create it.");
        const hits = queryKnowledge(m.entries, { terms, files, categories, tags, include_inactive, limit });
        // Remember what was looked up and whether accepted knowledge answered it: that is how repeated investigation is noticed.
        recordLookup(root, {
          ts: new Date().toISOString(), kind: "knowledge", terms: terms ?? [], files: files ?? [],
          matched: hits.map((h) => h.entry.id), accepted_matched: hits.some((h) => h.entry.status === "accepted"),
        });
        const repeats = findRepeated(readLookups(root), m.entries, 3)
          .filter((r) => significantTerms(terms ?? []).some((t) => r.terms.includes(t)));
        const nudge = repeats.length
          ? `\n\n💡 Repeated investigation detected: "${repeats[0].terms.slice(0, 4).join(", ")}" has been looked up ${repeats[0].count} times (${repeats[0].first.slice(0, 10)} to ${repeats[0].last.slice(0, 10)}) without accepted project knowledge answering it. ` +
            `Consider recording what you verified as project knowledge (record_project_knowledge, or suggest_project_knowledge for a prefilled suggestion).`
          : "";
        if (!hits.length) return text(`No project knowledge matches (${m.entries.length} entries searched). That is not evidence that nothing is intentional here: if you find a trap or exception, record it with record_project_knowledge.${nudge}`);
        return text(`📚 ${hits.length} relevant entr${hits.length === 1 ? "y" : "ies"} of ${m.entries.length}:\n\n` + hits.map((h) => renderEntry(h)).join("\n\n---\n\n") + nudge);
      } catch (e: any) { return text(`Error: ${e.message}`, true); }
    }
  );

  server.tool(
    "record_project_knowledge",
    "Adds ONE piece of project knowledge to the repository (.mcp/<category>/<id>.md) so it outlives this conversation, this agent and this engineer: a terminology trap, an ADR, a pattern, an intentional exception, a lesson, an operational constraint. " +
    "An ADR (category `adr`) must read like an engineering design narrative, not a database record: pass a `body` that opens with a one-sentence `>` summary, never with metadata or YAML-looking fields; the tool writes the `# ADR-NNNN: <Decision Title>` heading itself and stores its metadata at the end of the file. Required: ## Decision Snapshot (**Problem**, **Decision**, **Outcome**, **Status**, **Related Work**), ## Executive Summary, ## Context, ## Problem Statement, ## Investigation Summary, ## Options Considered, ## Decision, ## Consequences (### Benefits, ### Trade-Offs, ### Risks, ### Future Reconsideration Criteria), ## Verification, ## References. The first page must answer: what problem, why it mattered, what was chosen, why. " +
    "It is saved as `proposed` (visible but labelled unreviewed) unless the user explicitly confirms it, in which case pass user_statement and status=accepted. " +
    "`source` is mandatory: say where this came from. Record what is TRUE and WHY, and what must NOT be 'fixed'. Never record a guess as knowledge.",
    {
      workspace_root: z.string().describe("A directory inside the project"),
      category: z.enum(CATEGORIES as any),
      title: z.string(),
      body: z.string().describe("Markdown: what is true, why, and what must not be changed. Cite file:line where you can."),
      source: z.string().describe("Ticket / PR / incident / person / file this came from"),
      tags: z.array(z.string()).optional(),
      applies_to: z.array(z.string()).optional().describe("Path globs and/or plain terms used to surface this entry when relevant, e.g. 'sfn-iam-api/**', 'device'"),
      supersedes: z.array(z.string()).optional().describe("Ids of entries this replaces; they are marked superseded."),
      status: z.enum(["proposed", "accepted"]).optional(),
      user_statement: z.string().optional().describe("Required with status=accepted: the user's own words confirming this is true."),
      id: z.string().optional(),
      meta: z.record(z.union([z.string(), z.array(z.string())])).optional().describe("For category decisions or invariants only: ref (UD-1), domain (Tenant), decided_by, guardrail (terms that identify code touching a decision), fields (field names behind an invariant), enforcement (TEST/LOCK/DB/CODE), write_paths."),
    },
    async (a) => {
      try {
        if (a.status === "accepted" && !a.user_statement?.trim()) {
          return text("⛔ status=accepted needs user_statement: quote the user confirming this knowledge. Otherwise record it as proposed.", true);
        }
        const root = knowledgeRoot(a.workspace_root);
        const r = createEntry(root, { category: a.category, title: a.title, body: a.body, source: a.source, tags: a.tags, applies_to: a.applies_to, supersedes: a.supersedes, status: a.status, id: a.id, extra: a.meta });
        return text(
          `✅ Recorded ${r.entry.status.toUpperCase()} ${r.entry.category} knowledge \`${r.id}\` → ${r.file}\n` +
          (r.entry.status === "proposed" ? `It is labelled unreviewed until a person accepts it (set_knowledge_status or edit \`status:\`).\n` : "") +
          `Commit it with the code so it stays with the project.`
        );
      } catch (e: any) { return text(`⛔ ${e.message}`, true); }
    }
  );

  server.tool(
    "set_knowledge_status",
    "Accept, deprecate or supersede a knowledge entry. Changes only its status line. Requires user_statement: a person decides what the project treats as true.",
    {
      workspace_root: z.string().describe("A directory inside the project"),
      id: z.string(),
      status: z.enum(STATUSES as any),
      user_statement: z.string().describe("The user's own words authorising this change."),
    },
    async ({ workspace_root, id, status, user_statement }) => {
      try {
        if (!user_statement?.trim()) return text("⛔ user_statement is required: a person decides what the project treats as true.", true);
        const file = setStatus(knowledgeRoot(workspace_root), id, status);
        return text(`✅ ${id} is now ${status.toUpperCase()} (${file}).`);
      } catch (e: any) { return text(`⛔ ${e.message}`, true); }
    }
  );

  server.tool(
    "get_knowledge_health",
    "Project intelligence health: documented vs discovered entities (services, topics, golden rules, domain concepts, platform decisions, anomalies), per dimension, with the undocumented ones listed. " +
    "Also lists project-specific sections still sitting in the agent file and areas investigated repeatedly without accepted knowledge. Coverage is a ratio of counts, defined in the output; it is not a score.",
    {
      workspace_root: z.string().describe("A directory inside the project"),
      detail: z.boolean().optional().describe("List every undocumented entity instead of a short sample."),
    },
    async ({ workspace_root, detail }) => {
      try {
        const root = knowledgeRoot(workspace_root);
        const m = loadKnowledge(root);
        if (!m.exists) return text(`No Project Intelligence Layer yet, so nothing is documented. ${WHY_LAYER}\nRun load_project_knowledge with scaffold=true.`);
        const spec = loadSpec(root);
        if (!spec) return text("No .secufusion-project-spec.json found, so there is nothing to compare the knowledge against. Run /sfn-init first.", true);
        const h = buildHealth({ spec, dna: loadDna(root), model: m, workspaceRoot: root, events: readLookups(root) });
        return text(renderHealth(h, { detail }));
      } catch (e: any) { return text(`Error: ${e.message}`, true); }
    }
  );

  server.tool(
    "suggest_project_knowledge",
    "Recommends knowledge worth recording, with evidence: topics investigated repeatedly without accepted knowledge, discovered entities and anomalies the project spec records but .mcp does not describe, and project-specific sections that belong out of the agent file. " +
    "Each suggestion says why, and gives a prefilled record_project_knowledge call WITHOUT a body: record only what has been verified. Nothing is created by this tool.",
    {
      workspace_root: z.string().describe("A directory inside the project"),
      limit: z.number().int().min(1).max(30).optional(),
      min_repeats: z.number().int().min(2).max(20).optional().describe("Lookups of the same topic before it counts as repeated (default 3)."),
    },
    async ({ workspace_root, limit, min_repeats }) => {
      try {
        const root = knowledgeRoot(workspace_root);
        const m = loadKnowledge(root);
        if (!m.exists) return text(`No Project Intelligence Layer yet. ${WHY_LAYER}\nRun load_project_knowledge with scaffold=true, then ask again.`);
        const h = buildHealth({ spec: loadSpec(root), dna: loadDna(root), model: m, workspaceRoot: root, events: readLookups(root), minRepeat: min_repeats });
        return text(renderSuggestions(h.suggestions, limit ?? 8));
      } catch (e: any) { return text(`Error: ${e.message}`, true); }
    }
  );
}
