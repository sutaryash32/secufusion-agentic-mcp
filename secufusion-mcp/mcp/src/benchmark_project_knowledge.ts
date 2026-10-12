import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import {
    loadKnowledge, queryKnowledge, createEntry, setStatus, scaffoldKnowledge, inspectAgentsMd, parseFrontmatter,
    serializeEntry, renderEntry, AGENTS_MD_SOFT_LIMIT, CATEGORIES, parseEntryText, validateAdrBody,
} from "./project_knowledge.js";

/** A body that follows the ADR format standard. */
const adrBody = (summary: string, status = "Proposed") =>
    `> ${summary}\n\n## Decision Snapshot\n\n**Problem**\n\nThe problem.\n\n**Decision**\n\nThe decision.\n\n**Outcome**\n\nThe outcome.\n\n**Status**\n\n${status}\n\n**Related Work**\n\n- STORY-1\n\n---\n\n## Executive Summary\n\nWhy it mattered.\n\n## Context\n\nc\n\n## Problem Statement\n\nps\n\n## Investigation Summary\n\nis\n\n## Options Considered\n\noc\n\n## Decision\n\nd\n\n## Consequences\n\n### Benefits\n\nb\n\n### Trade-Offs\n\nt\n\n### Risks\n\nr\n\n### Future Reconsideration Criteria\n\nf\n\n## Verification\n\nv\n\n## References\n\n- ref\n`;

/** The repository is its own source of intelligence: knowledge is project-owned, validated, and found by relevance. */

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + detail}`);
    if (!cond) failures++;
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pil-"));
const dirs: string[] = [];
const fresh = () => { const d = tmp(); dirs.push(d); return d; };
const put = (root: string, rel: string, content: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), content); };
const entry = (extra = "", body = "Body text.") => `---\nid: "e1"\ntitle: "T"\ncategory: patterns\nstatus: accepted\ntags: []\napplies_to: []\nsource: "s"\ndate: 2026-01-01\nsupersedes: []\n${extra}---\n\n${body}\n`;

// ── scaffold and the empty case ────────────────────────────────────────────
{
    const r = fresh();
    check("no .mcp/: reported as not existing, not as an error", loadKnowledge(r).exists === false && loadKnowledge(r).entries.length === 0);
    const created = scaffoldKnowledge(r);
    check("scaffold creates every category folder plus release-history and a README", CATEGORIES.every((c) => fs.existsSync(path.join(r, ".mcp", c))) && fs.existsSync(path.join(r, ".mcp", "release-history")) && created.includes(".mcp/README.md"));
    check("scaffold keeps empty folders in git (.gitkeep)", fs.existsSync(path.join(r, ".mcp", "adr", ".gitkeep")));
    check("the README tells people how to add knowledge", /Adding knowledge/.test(fs.readFileSync(path.join(r, ".mcp", "README.md"), "utf8")));
    const before = fs.readFileSync(path.join(r, ".mcp", "README.md"), "utf8");
    fs.writeFileSync(path.join(r, ".mcp", "README.md"), before + "\nteam notes\n");
    scaffoldKnowledge(r);
    check("scaffold never overwrites existing files", fs.readFileSync(path.join(r, ".mcp", "README.md"), "utf8").endsWith("team notes\n"));
    check("an empty layer loads cleanly", loadKnowledge(r).exists && loadKnowledge(r).problems.length === 0);
}

// ── adding knowledge is easy, and carries provenance ───────────────────────
{
    const r = fresh();
    const a = createEntry(r, { category: "known-exceptions", title: "Legacy 'Device' naming in events", body: "Event payloads still say device for physical machines.", source: "PR #482 review", tags: ["terminology"], applies_to: ["events/**"] });
    check("created under the right folder, proposed by default, with the source recorded", a.file === ".mcp/known-exceptions/legacy-device-naming-in-events.md" && a.entry.status === "proposed" && a.entry.source === "PR #482 review");
    const m = loadKnowledge(r);
    check("what was written loads back identically and validates", m.entries.length === 1 && m.entries[0].title === "Legacy 'Device' naming in events" && m.problems.length === 0, JSON.stringify(m.problems));
    check("a source is mandatory (no unattributed knowledge)", (() => { try { createEntry(r, { category: "patterns", title: "x", body: "y", source: "  " }); return false; } catch (e: any) { return /source is required/.test(e.message); } })());
    check("an empty body is refused", (() => { try { createEntry(r, { category: "patterns", title: "x", body: " ", source: "s" }); return false; } catch (e: any) { return /body is required/.test(e.message); } })());
    check("a duplicate id is refused", (() => { try { createEntry(r, { category: "known-exceptions", title: "Legacy 'Device' naming in events", body: "again", source: "s" }); return false; } catch (e: any) { return /already exists/.test(e.message); } })());
    const adr1 = createEntry(r, { category: "adr", title: "Use Kafka for deletion events", body: adrBody("Deletion events travel over Kafka so every service converges."), source: "design review" });
    const adr2 = createEntry(r, { category: "adr", title: "Manual migrations", body: adrBody("Migrations are applied manually before deploy."), source: "design review" });
    check("ADRs are numbered sequentially", adr1.id === "adr-0001-use-kafka-for-deletion-events" && adr2.id === "adr-0002-manual-migrations", `${adr1.id} ${adr2.id}`);
    // ADR format standard: a document first (title, executive summary), metadata last and invisible
    {
        const text = fs.readFileSync(path.join(r, adr1.file), "utf8");
        check("an ADR opens with its title and one-sentence summary, not metadata", text.startsWith("# ADR-0001: Use Kafka for deletion events\n\n> Deletion events travel over Kafka") && !/^---/.test(text) && !/^id:/m.test(text.split("<!-- mcp:entry")[0]), text.slice(0, 160));
        check("its metadata sits in a trailing comment (invisible when rendered)", /<!-- mcp:entry[\s\S]*\bid: "adr-0001-use-kafka-for-deletion-events"[\s\S]*-->\s*$/.test(text), text.slice(-300));
        const loaded = loadKnowledge(r).entries.find((e) => e.id === adr1.id)!;
        check("it loads back with its metadata, and the body is the readable document", loaded.title === "Use Kafka for deletion events" && loaded.status === "proposed" && loaded.category === "adr" && loaded.body.startsWith("# ADR-0001:") && !loaded.body.includes("mcp:entry"), JSON.stringify(loaded).slice(0, 200));
        check("the Decision Snapshot Status line matches the recorded status at creation", /\*\*Status\*\*\s+Proposed/.test(text));
        setStatus(r, adr1.id, "accepted");
        const acc = fs.readFileSync(path.join(r, adr1.file), "utf8");
        check("accepting an ADR updates both the metadata and the readable Status line, touching nothing else", /^status: accepted$/m.test(acc) && /\*\*Status\*\*\s+Accepted/.test(acc) && acc.replace("status: accepted", "status: proposed").replace("Accepted", "Proposed") === text, acc.slice(-200));
        const bad = (() => { try { createEntry(r, { category: "adr", title: "Sloppy", body: "Decision...", source: "s" }); return ""; } catch (e: any) { return e.message as string; } })();
        check("an ADR that does not follow the format is refused, naming what is missing", /does not follow the ADR format standard/.test(bad) && /blockquote/.test(bad) && /missing section `## Executive Summary`/.test(bad) && /Do not start with metadata/.test(bad), bad.slice(0, 300));
        check("an ADR that starts with metadata is refused", validateAdrBody("id: adr-0003\ntitle: x\nstatus: proposed\n\n" + adrBody("s")).some((p) => /begins with metadata/.test(p)) && validateAdrBody("---\nid: x\n---\n" + adrBody("s")).some((p) => /begins with metadata/.test(p)));
        check("a body that supplies its own H1 does not get a second title", (() => { const e = createEntry(r, { category: "adr", title: "Own heading", body: "# Something else\n\n" + adrBody("Own heading summary."), source: "s" }); const t = fs.readFileSync(path.join(r, e.file), "utf8"); return t.startsWith("# ADR-0003: Own heading\n") && (t.match(/^# /gm) ?? []).length === 1; })());
        const legacy = '---\nid: "legacy-adr"\ntitle: "Legacy"\ncategory: adr\nstatus: accepted\ntags: []\napplies_to: []\nsource: "old"\ndate: 2026-01-01\nsupersedes: []\n---\n\nOld style body.\n';
        check("an existing ADR with front matter at the top still loads", parseEntryText(legacy)?.meta.id === "legacy-adr" && !!parseEntryText(legacy)?.body.startsWith("Old style body"));
        check("other categories keep front matter at the top", fs.readFileSync(path.join(r, a.file), "utf8").startsWith("---\nid:"));
    }
    const old = createEntry(r, { category: "patterns", title: "Old pattern", body: "x", source: "s" });
    const fresh2 = createEntry(r, { category: "patterns", title: "New pattern", body: "y", source: "s", supersedes: [old.id] });
    const m2 = loadKnowledge(r);
    check("superseding marks the old entry superseded and hides it by default", m2.entries.find((e) => e.id === old.id)!.status === "superseded" && !queryKnowledge(m2.entries, { terms: ["pattern"] }).some((h) => h.entry.id === old.id) && queryKnowledge(m2.entries, { terms: ["pattern"], include_inactive: true }).some((h) => h.entry.id === old.id));
    check("superseding something that does not exist is refused", (() => { try { createEntry(r, { category: "patterns", title: "z", body: "z", source: "s", supersedes: ["ghost"] }); return false; } catch (e: any) { return /no such entry/.test(e.message); } })());
    void fresh2;
    check("setStatus changes only the status line", (() => {
        const file = path.join(r, a.file);
        const before = fs.readFileSync(file, "utf8");
        setStatus(r, a.id, "accepted");
        const after = fs.readFileSync(file, "utf8");
        return after === before.replace("status: proposed", "status: accepted");
    })());
    check("round trip keeps awkward characters (colons, quotes, #)", (() => {
        const e = { id: "x", title: 'A "quoted": title # not a comment', category: "patterns" as const, status: "accepted" as const, tags: ["a,b", "c d"], applies_to: ["x/**"], source: "src: here", date: "2026-01-01", supersedes: [], body: "b" };
        const p = parseFrontmatter(serializeEntry(e))!;
        return p.meta.title === e.title && JSON.stringify(p.meta.tags) === JSON.stringify(e.tags) && p.meta.source === e.source;
    })());
}

// ── validation: bad knowledge is reported, not silently used ───────────────
{
    const r = fresh();
    put(r, ".mcp/patterns/no-frontmatter.md", "just text\n");
    put(r, ".mcp/patterns/no-source.md", entry("").replace('source: "s"\n', "").replace('id: "e1"', 'id: "ns"'));
    put(r, ".mcp/patterns/wrong-folder.md", entry("").replace("category: patterns", "category: adr").replace('id: "e1"', 'id: "wf"'));
    put(r, ".mcp/patterns/bad-status.md", entry("").replace("status: accepted", "status: maybe").replace('id: "e1"', 'id: "bs"'));
    put(r, ".mcp/patterns/dup-a.md", entry("").replace('id: "e1"', 'id: "dup"'));
    put(r, ".mcp/patterns/dup-b.md", entry("").replace('id: "e1"', 'id: "dup"'));
    put(r, ".mcp/patterns/dangling.md", entry('supersedes: ["nope"]\n').replace('id: "e1"', 'id: "dg"').replace("supersedes: []\n", ""));
    put(r, ".mcp/patterns/empty.md", entry("", "").replace('id: "e1"', 'id: "em"'));
    const m = loadKnowledge(r);
    const codes = new Set(m.problems.map((p) => p.code));
    check("every kind of problem is reported", ["MISSING_FRONTMATTER", "MISSING_FIELD", "CATEGORY_MISMATCH", "BAD_STATUS", "DUPLICATE_ID", "DANGLING_SUPERSEDES", "EMPTY_BODY"].every((c) => codes.has(c)), [...codes].join());
    check("each problem names its file", m.problems.every((p) => p.file.startsWith(".mcp/patterns/")));
    check("an entry with a bad status is not trusted as accepted", m.entries.find((e) => e.id === "bs")?.status === "proposed");
    check("CRLF files and BOMs parse", parseFrontmatter("﻿" + entry().replace(/\n/g, "\r\n"))?.meta.id === "e1");
}

// ── retrieval: what applies, not everything ────────────────────────────────
{
    const r = fresh();
    createEntry(r, { category: "architecture", title: "Device vs Machine terminology", body: "Device is a browser installation. Machine is a physical endpoint.", source: "team", tags: ["terminology", "device"], applies_to: ["device", "*Device*"], status: "accepted" });
    createEntry(r, { category: "known-exceptions", title: "Retention scheduler runs without a user token", body: "The scheduler authorizes as the system principal by design.", source: "ADR", tags: ["retention", "authorization"], applies_to: ["sfn-policy-api/**/Retention*"], status: "accepted" });
    createEntry(r, { category: "lessons-learned", title: "Kafka listener blocked on REST", body: "A synchronous call in a listener stalled the consumer group.", source: "incident", tags: ["kafka"], applies_to: ["**/*Listener.java"], status: "proposed" });
    createEntry(r, { category: "operational", title: "Migrations are applied manually", body: "Nothing runs on boot.", source: "ops", tags: ["migrations"], applies_to: ["**/db/migration/**"], status: "accepted" });
    const all = loadKnowledge(r).entries;

    const byTerm = queryKnowledge(all, { terms: ["1542 Incorrect label for browser count in delete device user dialog"] });
    check("the 1542 ticket words surface the Device vs Machine trap", byTerm[0]?.entry.id === "device-vs-machine-terminology", JSON.stringify(byTerm.map((h) => h.entry.id)));
    const byFile = queryKnowledge(all, { files: ["sfn-web-ui/src/components/DeleteDeviceUserDialog.jsx"] });
    check("a touched file surfaces it by path glob (*Device*)", byFile.some((h) => h.entry.id === "device-vs-machine-terminology" && h.why.some((w) => w.startsWith("applies to"))));
    check("only relevant entries come back, not the whole layer", byFile.length === 1 && queryKnowledge(all, { terms: ["zzzz"] }).length === 0);
    check("a long ticket does not drag in unrelated entries over one common word ('user' appears in the scheduler entry's body)",
        !byTerm.some((h) => h.entry.id === "retention-scheduler-runs-without-a-user-token") && byTerm.length === 1, JSON.stringify(byTerm.map((h) => [h.entry.id, h.score])));
    check("...but two independent body matches are enough", queryKnowledge(all, { terms: ["system principal"] })[0]?.entry.id === "retention-scheduler-runs-without-a-user-token", JSON.stringify(queryKnowledge(all, { terms: ["system principal"] }).map((h) => [h.entry.id, h.score])));
    check("an explicit single term is still honoured even if generic ('user' on its own)", queryKnowledge(all, { terms: ["user"] }).some((h) => h.entry.id === "retention-scheduler-runs-without-a-user-token"));
    check("a single weak body word never surfaces an accepted entry via the accepted bonus", queryKnowledge(all, { terms: ["principal"] }).length === 0, JSON.stringify(queryKnowledge(all, { terms: ["principal"] }).map((h) => h.entry.id)));
    check("a path glob selects a scoped exception", queryKnowledge(all, { files: ["sfn-policy-api/src/main/RetentionScheduler.java"] })[0]?.entry.id === "retention-scheduler-runs-without-a-user-token");
    check("migrations knowledge is found by migration file path", queryKnowledge(all, { files: ["sfn-iam-api/src/main/resources/db/migration/V41__x.sql"] })[0]?.entry.id === "migrations-are-applied-manually");
    check("filter by category", queryKnowledge(all, { categories: ["lessons-learned"] }).every((h) => h.entry.category === "lessons-learned") && queryKnowledge(all, { categories: ["lessons-learned"] }).length === 1);
    check("filter by tag", queryKnowledge(all, { tags: ["kafka"] })[0]?.entry.id === "kafka-listener-blocked-on-rest");
    check("accepted entries outrank equally matching proposed ones", (() => {
        const a = { ...all[0], id: "a", status: "accepted" as const, title: "alpha topic", tags: [], applies_to: [] }, b = { ...all[0], id: "b", status: "proposed" as const, title: "alpha topic", tags: [], applies_to: [] };
        return queryKnowledge([b, a], { terms: ["alpha"] })[0].entry.id === "a";
    })());
    check("proposed entries are labelled unreviewed when rendered", /PROPOSED \(unreviewed/.test(renderEntry(queryKnowledge(all, { tags: ["kafka"] })[0])) && !/PROPOSED/.test(renderEntry(byTerm[0])));
    check("the limit is respected and long bodies are truncated with a pointer to the file", queryKnowledge(all, { terms: ["device", "scheduler", "kafka", "migrations"], limit: 2 }).length === 2 && /truncated; full text in/.test(renderEntry({ entry: { ...all[0], body: "x".repeat(5000) }, score: 1, why: [] }, 100)));
}

// ── agents.md stays lightweight ────────────────────────────────────────────
{
    const r = fresh();
    check("no agents file: nothing to say", inspectAgentsMd(r).file === null);
    put(r, ".agents/AGENTS.md", "# rules\n".repeat(40));
    check("a short agents file is fine", inspectAgentsMd(r).warning === null && inspectAgentsMd(r).lines > 0);
    put(r, ".agents/AGENTS.md", "line\n".repeat(AGENTS_MD_SOFT_LIMIT + 30));
    const w = inspectAgentsMd(r).warning ?? "";
    check("a bloated agents file is flagged and told where project knowledge belongs", /soft limit/.test(w) && /\.mcp\//.test(w));
    put(r, ".mcp/agents.md", "# tiny\n");
    check(".mcp/agents.md takes precedence over the legacy location", inspectAgentsMd(r).file === ".mcp/agents.md");
}

// ── this repository's own migrated knowledge ───────────────────────────────
{
    const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
    if (fs.existsSync(path.join(repoRoot, ".mcp"))) {
        const m = loadKnowledge(repoRoot);
        check("the repo's own .mcp/ validates with no problems", m.problems.length === 0, JSON.stringify(m.problems));
        const dvm = m.entries.find((e) => e.id === "terminology-device-vs-machine");
        check("Device vs Machine was migrated out of AGENTS.md as accepted, with provenance", dvm?.status === "accepted" && /Migrated from .agents\/AGENTS.md/.test(dvm.source) && /browser installation/i.test(dvm.body));
        const hits = queryKnowledge(m.entries, { terms: ["1542 Incorrect Label for Browser Count in Delete User Confirmation", "devices"], files: ["sfn-web-ui/src/components/DeleteDeviceUserDialog.jsx"] });
        check("ticket 1542's real context surfaces it first", hits[0]?.entry.id === "terminology-device-vs-machine", JSON.stringify(hits.map((h) => h.entry.id)));
        const agents = fs.readFileSync(path.join(repoRoot, ".agents", "AGENTS.md"), "utf8");
        check("AGENTS.md now points to the knowledge instead of holding it", /terminology-device-vs-machine\.md/.test(agents) && !/Naming inconsistency ≠ bug/.test(agents) && !/\| \*\*Device\*\* \| A \*\*browser installation\*\*/.test(agents));
        check("the line-ending lesson is recorded", m.entries.some((e) => e.id === "line-ending-diff-noise" && e.category === "lessons-learned"));
    } else check("repo .mcp/ present", false, repoRoot);
}

for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
console.log(failures === 0 ? "\nPROJECT KNOWLEDGE BENCHMARK: ALL PASS" : `\nPROJECT KNOWLEDGE BENCHMARK: ${failures} FAILED`);
process.exit(failures ? 1 : 0);
