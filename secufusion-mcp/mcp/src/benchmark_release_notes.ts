import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import {
    extractSnapshot, computeDelta, computeRisks, renderReleaseNotes, saveSnapshot, findPreviousSnapshot, compareVersions,
    ReleaseSnapshot,
} from "./release_notes.js";

/** Release notes must tell the story of what changed, not dump the repository. */

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + detail}`);
    if (!cond) failures++;
}

const baseSpec = () => ({
    microservices: {
        "sfn-iam-api": { language: "Java", port: "8081", owns_tables: ["users", "tenant_mapping"], kafka_produces: ["user-deleted"], kafka_consumes: [], direct_rest_calls: { "sfn-events-api": "audit" } },
        "sfn-events-api": { language: "Java", port: "8082", owns_tables: ["events"], kafka_produces: [], kafka_consumes: ["user-deleted"] },
    },
    golden_rules: {
        tenant_isolation: { rule: "Every query is tenant scoped", severity: "BLOCKER", reason: "data leakage" },
        no_hardcoded_urls: { rule: "No hardcoded environment URLs", severity: "WARNING", reason: "env parity" },
        manual_migrations: { rule: "Migrations are applied manually", severity: "BLOCKER", reason: "no auto apply" },
    },
    terminology: { Device: "A browser installation", Machine: "A physical endpoint" },
    platform: { name: "SecuFusion", database: "PostgreSQL" },
    manual_review_flags: ["sfn-auth-api may duplicate sfn-iam-api"],
});
const snap = (version: string, spec: any, mig?: any, dna?: any) => extractSnapshot(version, spec, mig, dna);
const render = (prev: ReleaseSnapshot | null, cur: ReleaseSnapshot, nar: any = {}, opts: any = {}) =>
    renderReleaseNotes({ version: cur.version, previous_version: prev?.version ?? null, date: "2026-10-08", delta: computeDelta(prev, cur), current: cur, narrative: nar, ...opts });
const idx = (md: string, h: string) => md.indexOf(h);

// ── nothing changed ────────────────────────────────────────────────────────
{
    const a = snap("2.2.4", baseSpec()), b = snap("2.2.5", baseSpec());
    const d = computeDelta(a, b);
    const md = render(a, b);
    check("identical specs: zero detected changes", d.total === 0);
    check("identical specs: explicitly says 'No significant changes since v2.2.4'", md.includes("No significant changes since v2.2.4"), md.slice(0, 600));
    check("identical specs: every change section says None, with count (0)", ["## Added (0)\nNone.", "## Changed (0)\nNone.", "## Fixed (0)\nNone.", "## Removed / Deprecated (0)\nNone.", "## Repository Intelligence Updates (0)\nNone."].every((s) => md.includes(s)), md);
    check("identical specs: rule table shows 3 unchanged, 0 changed", md.includes("| 0 | 0 | 0 | 3 |"));
}

// ── structure: delta first, snapshot last, no metadata dump up front ───────
{
    const a = snap("1.0.0", baseSpec());
    const spec2: any = baseSpec();
    spec2.microservices["sfn-new-api"] = { language: "Go", owns_tables: ["reports"], kafka_consumes: ["user-deleted"] };
    const b = snap("1.1.0", spec2);
    const md = render(a, b, { why: "Add the reporting service" });
    const order = ["# Version 1.1.0", "## Executive Summary", "## Added", "## Changed", "## Fixed", "## Removed / Deprecated", "## Risks", "## Repository Intelligence Updates", "## Rule Changes", "## Detailed Snapshot"];
    const pos = order.map((h) => idx(md, h));
    check("sections appear in the required order", pos.every((p, i) => p >= 0 && (i === 0 || p > pos[i - 1])), JSON.stringify(pos));
    check("the Detailed Snapshot is last and is labelled as not a list of changes", idx(md, "## Detailed Snapshot") > idx(md, "## Rule Changes") && md.includes("Not a list of changes"));
    const beforeFirstSection = md.slice(0, idx(md, "## Added"));
    check("no service/metadata table before the changes begin", !beforeFirstSection.includes("| Service |") && !beforeFirstSection.includes("| Services |") && beforeFirstSection.length < 1500, String(beforeFirstSection.length));
    check("the executive summary leads with why the release exists", md.slice(idx(md, "## Executive Summary")).startsWith("## Executive Summary\n**Why this release exists:** Add the reporting service") || md.includes("**Why this release exists:** Add the reporting service"));
    check("the snapshot can be omitted", !render(a, b, {}, { include_snapshot: false }).includes("## Detailed Snapshot"));
    check("rendering is deterministic", render(a, b, { why: "x" }) === render(a, b, { why: "x" }));
}

// ── additions / removals / changes ─────────────────────────────────────────
{
    const a = snap("1.0.0", baseSpec());
    const s2: any = baseSpec();
    s2.microservices["sfn-new-api"] = { language: "Go", owns_tables: ["reports"], kafka_produces: ["report-ready"], kafka_consumes: ["user-deleted"] };
    s2.microservices["sfn-iam-api"].port = "9001";
    s2.microservices["sfn-iam-api"].kafka_consumes = ["tenant-created"];
    const b = snap("1.1.0", s2);
    const md = render(a, b);
    check("new service is listed under Repository Intelligence with language and counts", /New services \(1\)[\s\S]*`sfn-new-api` \(Go\), owns 1 table\(s\)/.test(md), md);
    check("new topic is listed with producers and consumers", /`report-ready`: producers sfn-new-api; consumers none/.test(md));
    check("changed port is shown as from → to under Changed", /`sfn-iam-api` port: 8081 → 9001/.test(md));
    check("a new mapping on an existing service is listed under Added", /New mappings on existing services[\s\S]*`sfn-iam-api` kafka_consumes: \+tenant-created/.test(md));
    check("table ownership discovery is reported", /Table ownership discovered[\s\S]*reports \(sfn-new-api\)/.test(md));
    check("executive summary quantifies the delta and says WHAT changed", /\*\*\d+ detected change\(s\) since v1\.0\.0\*\* \(added: 1 service\(s\), 2 topic\(s\); changed: 1 service\(s\), 1 topic\(s\);/.test(md), md.slice(0, 700));

    const s3: any = baseSpec();
    delete s3.microservices["sfn-events-api"];
    const md3 = render(a, snap("1.1.0", s3));
    check("a removed service is listed under Removed / Deprecated", /## Removed \/ Deprecated \(\d+\)[\s\S]*Services \(1\)[\s\S]*`sfn-events-api`/.test(md3));
    check("its topic consumer mapping is reported as dropped", /Mappings dropped from existing services|Table ownership dropped/.test(md3));
}

// ── rules ──────────────────────────────────────────────────────────────────
{
    const a = snap("2.2.4", baseSpec());
    const s2: any = baseSpec();
    s2.golden_rules.tenant_isolation = { rule: "Every query is tenant scoped at query level; never trust the method name", severity: "BLOCKER", reason: "data leakage" };
    s2.golden_rules.tenant_404 = { rule: "Cross-tenant lookups return 404, never 403", severity: "BLOCKER", reason: "do not reveal existence" };
    delete s2.golden_rules.no_hardcoded_urls;
    const md = render(a, snap("2.2.5", s2));
    check("rule table counts: 1 added, 1 modified, 1 removed, 1 unchanged", md.includes("| 1 | 1 | 1 | 1 |"), md.slice(idx(md, "## Rule Changes")));
    check("modified rule shows before and after", /`tenant_isolation`\n\s+- before: \[BLOCKER\] Every query is tenant scoped \(why: data leakage\)\n\s+- after: \[BLOCKER\] Every query is tenant scoped at query level/.test(md));
    check("added and removed rules are named", md.includes("`tenant_404`") && md.includes("`no_hardcoded_urls`"));
    check("unchanged rules are named when few", md.includes("**Unchanged:** `manual_migrations`"));
    check("executive summary states the rule counts", md.includes("Rules: 1 added, 1 modified, 1 removed, 1 unchanged."));

    // string-valued rules (the shape used by this repo's real spec)
    const b: any = { golden_rules: { r1: "Always scope by tenant" } }, c: any = { golden_rules: { r1: "Always scope by tenant, from the token" } };
    check("string-valued golden_rules are diffed too", computeDelta(snap("1", b), snap("2", c)).rules.modified.length === 1);
}

// ── risks and fixes ────────────────────────────────────────────────────────
{
    const a = snap("1.0.0", baseSpec());
    const s2: any = baseSpec();
    s2.microservices["sfn-events-api"].kafka_consumes = [];
    s2.microservices["sfn-iam-api"].kafka_produces = ["user-deleted", "user-created"];
    const b = snap("1.1.0", s2);
    const md = render(a, b);
    check("a topic that lost its consumer is an introduced risk", /Introduced \(\d+\)[\s\S]*`user-deleted` is produced by sfn-iam-api but has no consumer/.test(md), md.slice(idx(md, "## Risks")));
    check("risk summary is quantified", /Net: \d+ introduced, \d+ resolved, \d+ unchanged\./.test(md));

    const back = render(b, a);
    check("restoring the consumer resolves the risk: listed once, under Risks, with a pointer from Fixed", /## Fixed \(0\)\n2 risk\(s\) were also resolved; they are listed under \*Risks\*\./.test(back) && /## Risks\n\*\*Resolved \(2\)\*\*[\s\S]*has no consumer/.test(back), back.slice(idx(back, "## Fixed")));
    check("a resolved risk is not duplicated across sections", (back.match(/Topic `user-deleted` is produced by sfn-iam-api but has no consumer/g) ?? []).length === 1);

    const sa: any = baseSpec(); sa.microservices["sfn-iam-api"].port = "CONFLICT: 8081 (literal) vs 8087 (env)";
    const sb: any = baseSpec(); sb.microservices["sfn-iam-api"].port = "8081";
    const mdFix = render(snap("1", sa), snap("2", sb));
    check("an unresolved CONFLICT value that becomes a clean value is reported as a resolved ambiguity", /Ambiguities resolved \(1\)[\s\S]*`sfn-iam-api\.port`/.test(mdFix));
    check("...and that one event is reported exactly once (not also under Changed or as a resolved risk)", (mdFix.match(/sfn-iam-api\.port|`sfn-iam-api` port/g) ?? []).length === 1 && !/## Risks[\s\S]*is unresolved/.test(mdFix), mdFix.slice(idx(mdFix, "## Changed")));
    check("manual-review flag removed counts as a resolved risk", computeDelta(snap("1", baseSpec()), snap("2", { ...baseSpec(), manual_review_flags: [] })).risks.resolved.length === 1);
    check("risks are derived from structure: multi-owner table", computeRisks(snap("1", { microservices: { a: { owns_tables: ["t"] }, b: { owns_tables: ["t"] } } })).some((r) => r.id === "TABLE_MULTI_OWNER:t"));
}

// ── baseline ───────────────────────────────────────────────────────────────
{
    const md = render(null, snap("1.0.0", baseSpec()));
    check("no previous release: says it is the first recorded release and claims no delta", md.includes("First recorded release") && md.includes("no delta can be computed"));
    check("no previous release: change sections do not present the whole repo as 'Added'", md.includes("## Added (0)\nNo earlier release to compare against") && !md.includes("`sfn-iam-api` (Java)"));
    check("no previous release: header is marked as a baseline", md.includes("Baseline release"));
}

// ── author notes ───────────────────────────────────────────────────────────
{
    const a = snap("1.0.0", baseSpec()), b = snap("1.1.0", baseSpec());
    const withNotes = render(a, b, { fixed: ["Tenant filter was missing on AuditRepository"], added: ["Strict query-level scoping check"], discoveries: ["sfn-auth-api duplicates sfn-iam-api login"], removed: ["Legacy ByTenantId name heuristic"] });
    check("author notes appear in the right sections, labelled, and counted", /## Fixed \(1\)[\s\S]*Author notes[\s\S]*Tenant filter was missing/.test(withNotes) && /## Added \(1\)/.test(withNotes) && /## Repository Intelligence Updates \(1\)/.test(withNotes) && /## Removed \/ Deprecated \(1\)/.test(withNotes));
    check("author notes alone prevent a false 'No significant changes'", !withNotes.includes("No significant changes"));
    check("a missing rationale is stated, not invented", render(a, b).includes("**Why this release exists:** _not stated by the author._"));
}

// ── real-world input and scale ─────────────────────────────────────────────
{
    const realPath = fileURLToPath(new URL("../../scripts/.secufusion-project-spec.json", import.meta.url));
    if (fs.existsSync(realPath)) {
        const real = JSON.parse(fs.readFileSync(realPath, "utf-8").replace(/^﻿/, ""));
        const a = snap("2.2.4", real);
        check("this repo's real spec extracts without error", Object.keys(a.services).length > 0 && Object.keys(a.rules).length > 0, JSON.stringify({ s: Object.keys(a.services).length, r: Object.keys(a.rules).length }));
        check("real spec vs itself: no changes", computeDelta(a, snap("2.2.5", real)).total === 0);
        const mod = JSON.parse(JSON.stringify(real));
        const firstRule = Object.keys(mod.golden_rules)[0];
        const firstSvc = Object.keys(mod.microservices)[0];
        mod.golden_rules[firstRule] = String(mod.golden_rules[firstRule]) + " (tightened)";
        delete mod.microservices[Object.keys(mod.microservices)[1]];
        mod.microservices[firstSvc].port = "9999";
        const md = render(a, snap("2.2.5", mod));
        check("real spec: a tightened rule, a removed service and a port change are all found", md.includes(`\`${firstRule}\``) && /Services \(1\)/.test(md) && md.includes(`\`${firstSvc}.port\``), md.slice(0, 900));
        check("real spec: executive summary comes before any table", md.indexOf("## Executive Summary") < md.indexOf("|"));
    } else check("real spec fixture present", false, realPath);

    const many: any = { microservices: {} };
    for (let i = 0; i < 100; i++) many.microservices[`svc-${i}`] = { language: "Java", owns_tables: [`t${i}`] };
    const md = render(null, snap("1.0.0", many));
    check("a 100-service snapshot is capped, not dumped", (md.match(/\| svc-/g) ?? []).length === 40 && md.includes("…and 60 more services."));
}

// ── snapshots on disk ──────────────────────────────────────────────────────
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "relnotes-"));
    for (const v of ["2.2.4", "2.2.10", "2.2.5"]) saveSnapshot(root, snap(v, baseSpec()));
    check("version compare is numeric, not lexicographic (2.2.10 > 2.2.5)", compareVersions("2.2.10", "2.2.5") > 0 && compareVersions("v1.0.0", "1.0.0") === 0);
    check("previous of 2.2.11 is 2.2.10", findPreviousSnapshot(root, "2.2.11")?.version === "2.2.10");
    check("previous of 2.2.5 is 2.2.4", findPreviousSnapshot(root, "2.2.5")?.version === "2.2.4");
    check("the oldest release has no previous", findPreviousSnapshot(root, "2.2.4") === null);
    check("a release is never compared against itself", findPreviousSnapshot(root, "2.2.10")?.version === "2.2.5");
    fs.rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nRELEASE NOTES BENCHMARK: ALL PASS" : `\nRELEASE NOTES BENCHMARK: ${failures} FAILED`);
process.exit(failures ? 1 : 0);
