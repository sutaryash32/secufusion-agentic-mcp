// @ts-nocheck
import fs from "fs";
import path from "path";
import { z } from "zod";
import { extractClaims, buildLedger, renderLedger } from "./claims_ledger.js";
import { buildMatrix, scoreMatrix, renderMatrix, applyVerdicts } from "./edge_matrix.js";
import { gatherProductCells, gatherImpliedClaims } from "./product_context.js";
import { checkPlatformFacts, renderFacts } from "./platform_facts.js";
import { judge, judgmentParam, hashOf } from "./judge.js";
const ok = (text) => ({ content: [{ type: "text", text }] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: `Error: ${e?.message ?? e}` }] });
const json = (o) => ok(JSON.stringify(o, null, 2));
const claim = z.object({
    id: z.string().optional(), text: z.string().min(3).max(600),
    kind: z.enum(["acceptance", "reality", "assumption", "decision", "nonfunctional", "implied", "silent"]).optional(), source: z.string().optional(),
});
const evidence = z.object({
    claim_id: z.string(),
    relation: z.enum(["implements", "tests", "supports", "contradicts"]).describe("implements: code that does it. tests: a test that proves it. supports: code that shows a reality claim, assumption or product requirement holds. contradicts: code that shows the claim is false."),
    file: z.string(), line: z.number().int().optional(), quote: z.string().optional().describe("The code, copied from the file. Without it the evidence is weak."), note: z.string().optional(),
});
const evid = z.object({ file: z.string(), line: z.number().int().optional(), quote: z.string().optional() });
/** A few lines of real context for a cell: the code around its file:line, or the project-knowledge entry it came from. */
function excerptFor(root, source) {
    if (!source)
        return undefined;
    try {
        const m = /^(.+?):(\d+)$/.exec(source);
        const rootAbs = path.resolve(root);
        if (m) {
            const f = path.resolve(rootAbs, m[1]);
            if (!f.startsWith(rootAbs) || !fs.existsSync(f))
                return undefined;
            const lines = fs.readFileSync(f, "utf8").split(/\r?\n/), n = Number(m[2]);
            return lines.slice(Math.max(0, n - 6), n + 8).map((l, i) => `${Math.max(1, n - 5) + i}: ${l}`).join("\n").slice(0, 1200);
        }
        const mk = /^(\.mcp\/[^\s(]+)/.exec(source);
        if (mk) {
            const f = path.resolve(rootAbs, mk[1]);
            if (f.startsWith(rootAbs) && fs.existsSync(f))
                return fs.readFileSync(f, "utf8").slice(0, 900);
        }
    }
    catch { /* no excerpt */ }
    return undefined;
}
const verdictSchema = z.object({
    verdicts: z.array(z.object({
        cell_id: z.string(),
        verdict: z.enum(["HOLDS", "VIOLATED", "UNKNOWN"]),
        reasoning: z.string().min(20),
        scenario: z.string().optional(),
        evidence: z.array(evid).optional(),
    })).min(1),
});
export function registerLedgerTools(server) {
    server.tool("build_claims_ledger", "Claims ledger: does the code match the story, does the story match reality, and what is the gap between what is written and what is built? Every statement in the story is a CLAIM (acceptance, reality, assumption, decision, non-functional). " +
        "It is PRODUCT-AWARE: besides what the story says, it adds the claims the story does NOT make: IMPLIED claims (the accepted invariants and decisions in .mcp/ that apply to the story's terms) and SILENT claims (lifecycle paths that exist for the story's entities and that the story never mentions). " +
        "Step 1: pass `story_text` (plus `entities` and `flags` if you know them) with no evidence to get the claims; read and correct them. Step 2: reason about each claim against the code and pass `evidence` (implements, tests, supports, contradicts, each with file, line and a quote copied from the code). " +
        "The tool verifies every citation against the real files, gives each claim a status (VERIFIED, IMPLEMENTED_UNTESTED, CONTRADICTED, UNVERIFIABLE, UNVERIFIED, NO_EVIDENCE) and maps the diff BACK to the claims: WRITTEN_NOT_BUILT, BUILT_NOT_WRITTEN. " +
        "Any language. READ-ONLY. It checks that evidence EXISTS, not what it means: read each cited line.", {
        workspace_root: z.string().describe("The repository root (a git repository when you pass base)"),
        story_text: z.string().max(60000).optional().describe("The story, acceptance criteria and spec text, to extract claims from"),
        claims: z.array(claim).max(160).optional().describe("Your corrected list of claims (keep the extracted ids)"),
        evidence: z.array(evidence).max(500).optional(),
        entities: z.array(z.string()).max(12).optional().describe("The primary business entities of the story (e.g. User, Tenant): used to find lifecycle paths the story is silent about"),
        flags: z.array(z.string()).max(12).optional().describe("Fields that carry ownership, status or authority (e.g. defaultUser, isAdmin)"),
        terms: z.array(z.string()).max(30).optional().describe("Extra domain terms to look up in .mcp/ project knowledge"),
        include_implied: z.boolean().optional().describe("Add IMPLIED and SILENT claims from product knowledge and the code (default true when extracting)"),
        base: z.string().optional().describe("Git ref the change is compared with, to find changed regions no claim accounts for"),
        changed: z.record(z.string(), z.array(z.tuple([z.number().int(), z.number().int()]))).optional().describe("Changed line ranges per file, instead of git"),
        format: z.enum(["blocks", "json"]).optional(),
    }, async ({ workspace_root, story_text, claims, evidence, entities, flags, terms, include_implied, base, changed, format }) => {
        try {
            let list = claims;
            const notes = [];
            if (!list) {
                if (!story_text)
                    return fail(new Error("pass story_text or claims"));
                list = extractClaims(story_text);
                if (include_implied !== false) {
                    const imp = gatherImpliedClaims(workspace_root, { entries: [], terms, entities, flags, story_text });
                    imp.claims.forEach((c, i) => list.push({ id: `C${list.length + 1}`, ...c }));
                    notes.push(...imp.notes);
                    notes.push(`${imp.claims.length} IMPLIED / SILENT claim(s) were added from product knowledge and the code: they are what the product requires or the story leaves open, not what the story says`);
                }
            }
            const l = buildLedger(workspace_root, { claims: list, evidence, base, changed });
            l.notes.unshift(...notes);
            return format === "json" ? json(l) : ok(renderLedger(l));
        }
        catch (e) {
            return fail(e);
        }
    });
    server.tool("build_edge_matrix", "Edge matrix for 'what are ALL the edges nobody thought of', built to be reasoned about, not ticked off. It is PRODUCT-AWARE: cells come from (1) PRODUCT knowledge: accepted invariants, decisions, lessons learned and known exceptions in .mcp/ that apply to the change, each naming its source; " +
        "(2) CODE: lifecycle paths that exist for your `entities` (and which never mention your `flags`), paths that do not exist, authorization decisions elsewhere that read the same fields, rules copied across services; (3) MODEL: your own hypotheses (`custom_cells`, each with the reason you suspect it); and (4) BASELINE: standard edges per input type, state, role, call and delivery, ranked low and meant to be answered in bulk. " +
        "Cells are ranked by risk and keep stable ids. Call it first without `answers` to get the ranking. With `reason_top` = N it asks the model to REASON about the N highest-risk unanswered cells (using the server's sampling when the client supports it, otherwise returning a JUDGMENT REQUEST to answer and pass back as `judgment`); every verdict's evidence is verified against the code, and a 'holds' with no verified evidence is deferred, not accepted. " +
        "Or answer yourself: COVERED (reasoning + evidence for high-risk cells), NOT_APPLICABLE (a real reason), GAP (with a scenario) or DEFERRED; `bulk` answers many baseline cells at once. Any language. READ-ONLY: judgments are not stored.", {
        workspace_root: z.string().describe("The repository root: project knowledge, code and evidence are read from here"),
        entry_points: z.array(z.object({
            name: z.string(),
            inputs: z.array(z.object({ name: z.string(), type: z.string(), required: z.boolean().optional() })).max(60).optional(),
            states: z.array(z.string()).max(30).optional(), operations: z.array(z.string()).max(30).optional(), roles: z.array(z.string()).max(30).optional(),
            external_calls: z.array(z.string()).max(20).optional(), messaging: z.boolean().optional(), scheduled: z.boolean().optional(),
            writes_data: z.boolean().optional(), tenant_scoped: z.boolean().optional(),
        })).min(1).max(40),
        story_text: z.string().max(60000).optional().describe("The story: used to find the project knowledge that applies"),
        entities: z.array(z.string()).max(12).optional().describe("Primary business entities of the change: used to scan their lifecycle paths and authority consumers"),
        flags: z.array(z.string()).max(12).optional().describe("Fields carrying ownership, status or authority (e.g. defaultUser, isAdmin): raise the risk of anything that touches them"),
        terms: z.array(z.string()).max(30).optional().describe("Domain terms to look up in project knowledge"),
        custom_cells: z.array(z.object({ entry: z.string().optional(), area: z.string(), edge: z.string().min(10), why: z.string().min(10).describe("Why you suspect this edge: the product rule or the code that points to it"), source: z.string().optional(), risk: z.number().int().min(1).max(10).optional() })).max(60).optional(),
        answers: z.array(z.object({
            cell_id: z.string().optional(), cell_ids: z.array(z.string()).max(200).optional(),
            bulk: z.object({ origin: z.enum(["PRODUCT", "CODE", "MODEL", "BASELINE"]).optional(), area_contains: z.string().optional(), edge_contains: z.string().optional(), max_risk: z.number().int().min(1).max(10).optional() }).optional(),
            status: z.enum(["COVERED", "NOT_APPLICABLE", "GAP", "DEFERRED"]),
            reasoning: z.string().optional().describe("Required for high-risk cells: the product rule, the path through the code, why it holds or does not"),
            why: z.string().optional(), scenario: z.string().optional().describe("For a GAP: the concrete sequence (who, what, in which order) and the broken state"),
            evidence: evid.optional(),
        })).max(3000).optional(),
        reason_top: z.number().int().min(0).max(25).optional().describe("Ask the model to reason about the N highest-risk unanswered cells (default 0: off)"),
        judgment: judgmentParam,
        max_cells: z.number().int().min(50).max(3000).optional(),
        show: z.number().int().min(1).max(500).optional().describe("Cells listed per section in blocks format (default 40)"),
        format: z.enum(["blocks", "json"]).optional(),
    }, async ({ workspace_root, entry_points, story_text, entities, flags, terms, custom_cells, answers, reason_top, judgment, max_cells, show, format }) => {
        try {
            const product = gatherProductCells(workspace_root, { entries: entry_points, terms, entities, flags, story_text });
            const opts = { max_cells, product: product.cells, custom: custom_cells, flags, terms: [...(terms ?? []), ...(entities ?? [])] };
            let all = answers ?? [];
            const extra = [];
            if (reason_top && reason_top > 0) {
                const { cells } = buildMatrix(entry_points, opts);
                const answered = scoreMatrix(workspace_root, entry_points, all, opts);
                const open = new Set(answered.unanswered.map((c) => c.id));
                const top = cells.filter((c) => open.has(c.id)).slice(0, reason_top);
                if (top.length) {
                    const outcome = await judge(server, workspace_root, {
                        kind: "edge-reasoning",
                        subject: hashOf(top.map((c) => c.id)),
                        role: "adversarial reviewer who knows this product and its past failures",
                        rubric: [
                            "Reason about each cell from the PRODUCT RULE (its source) to the CODE PATH. Ask what must always remain true, which path could break it, and what another actor, a retry, an old row, a second service or an unusual order of operations would do.",
                            "Judge only from the evidence packet and from code you read. A claim about the code must cite file, line and a quote copied from that file: a citation that is not in the code is discarded.",
                            "HOLDS only if you can cite the guard, constraint, lock or test that makes it hold. If you cannot, the verdict is UNKNOWN: that is honest, not a failure.",
                            "VIOLATED needs a concrete scenario: who does what, in which order, and the broken state that results. Do not invent a rule the product has not recorded: a rule you are only inferring must be said to be inferred.",
                            "A few deep verdicts are worth more than many shallow ones. Product and code cells come before baseline cells. If a cell reveals a more dangerous edge nobody listed, say so in its reasoning.",
                        ],
                        evidence: {
                            note: "each cell is a question about the change; `source` says where it came from; `excerpt` is the real code or the project-knowledge entry",
                            cells: top.map((c) => ({ cell_id: c.id, origin: c.origin, risk: c.risk, entry: c.entry, area: c.area, question: c.edge, source: c.source, why: c.why, excerpt: excerptFor(workspace_root, c.source) })),
                            product_knowledge_used: product.knowledge_used,
                        },
                        schema: verdictSchema,
                        schemaHint: '{"verdicts":[{"cell_id":"E1a2b3c","verdict":"HOLDS|VIOLATED|UNKNOWN","reasoning":"the chain from the rule to the code, at least a sentence","scenario":"(VIOLATED) who does what in which order and the broken state","evidence":[{"file":"path","line":12,"quote":"code copied from the file"}]}]}',
                        supplied: judgment,
                        reinvoke: "build_edge_matrix",
                        persist: false,
                    });
                    if (outcome.status !== "ok")
                        return ok(outcome.text);
                    const applied = applyVerdicts(workspace_root, cells, outcome.verdict.verdicts);
                    all = [...all, ...applied.answers];
                    extra.push(`reasoning on the top ${top.length} cell(s) came from the ${outcome.source === "sampling" ? "client's model (sampling)" : "calling model"}; every citation was checked against the code`, ...applied.notes);
                }
                else
                    extra.push("reason_top was set but every cell already has an answer");
            }
            const r = scoreMatrix(workspace_root, entry_points, all, opts);
            r.notes.unshift(...product.notes, ...extra, ...(product.knowledge_used.length ? [`project knowledge used: ${product.knowledge_used.slice(0, 12).map((k) => `${k.id} (${k.category}, ${k.status})`).join(", ")}`] : []));
            return format === "json" ? json(r) : ok(renderMatrix(r, show));
        }
        catch (e) {
            return fail(e);
        }
    });
    server.tool("check_platform_facts", "Checks the facts the review relies on against the code. Reads a markdown document (default agents/AGENTS.md) and compares: its message-topic table against the topics the code really produces and consumes (Kafka in Java, Kotlin, JavaScript, TypeScript, Python, C#, Go, and topic names in properties and yaml), the files and folders it names in backticks against the workspace, and the services it lists against the folders present. " +
        "A CONTRADICTION always carries file:line evidence. UNVERIFIED means the scan could not see the other side (a topic built at runtime, a service in another repository), not that the document is wrong. Run it at the start of a review: a stale fact is a knowledge gap, never a premise. READ-ONLY.", {
        workspace_root: z.string().describe("The workspace root (for several services, the folder that holds them)"),
        doc_path: z.string().optional().describe("Workspace-relative path of the document (default agents/AGENTS.md, then .agents/AGENTS.md)"),
        format: z.enum(["blocks", "json"]).optional(),
    }, async ({ workspace_root, doc_path, format }) => {
        try {
            const candidates = doc_path ? [doc_path] : ["agents/AGENTS.md", ".agents/AGENTS.md", "AGENTS.md", "secufusion-mcp/agents/AGENTS.md"];
            const found = candidates.find((c) => fs.existsSync(path.resolve(workspace_root, c)));
            if (!found)
                return fail(new Error(`document not found (tried ${candidates.join(", ")})`));
            const r = checkPlatformFacts(workspace_root, found);
            return format === "json" ? json(r) : ok(renderFacts(r));
        }
        catch (e) {
            return fail(e);
        }
    });
}
