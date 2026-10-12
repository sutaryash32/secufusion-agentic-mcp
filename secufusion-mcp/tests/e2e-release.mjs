import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..").split(path.sep).join("/");
const SDK = `${PKG}/node_modules/@modelcontextprotocol/sdk/dist/esm`;
const { Client } = await import(pathToFileURL(`${SDK}/client/index.js`).href);
const { StdioClientTransport } = await import(pathToFileURL(`${SDK}/client/stdio.js`).href);

let failures = 0;
const check = (name, cond, detail = "") => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + detail}`);
    if (!cond) failures++;
};

const spec = () => ({
    microservices: {
        "sfn-iam-api": { language: "Java", port: "8081", owns_tables: ["users"], kafka_produces: ["user-deleted"] },
        "sfn-events-api": { language: "Java", port: "8082", owns_tables: ["events"], kafka_consumes: ["user-deleted"] },
    },
    golden_rules: { tenant_isolation: { rule: "Scope every query by tenant", severity: "BLOCKER", reason: "leakage" } },
});

async function connect(dir) {
    const c = new Client({ name: "e2e", version: "1" }, { capabilities: {} });
    await c.connect(new StdioClientTransport({ command: "node", args: [`${PKG}/mcp/dist/server.js`, "--root", dir], cwd: dir }));
    return c;
}
const call = async (c, name, args) => {
    const r = await c.callTool({ name, arguments: args });
    return { err: !!r.isError, text: r.content.map((x) => x.text).join("\n") };
};
const mk = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2etmp-"));
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    return dir;
};
const writeSpec = (dir, s) => fs.writeFileSync(path.join(dir, ".secufusion-project-spec.json"), JSON.stringify(s, null, 2));
const rel = (dir, v) => path.join(dir, ".secufusion", "releases", `v${v}.md`);

// ── a release history: baseline -> changes -> nothing changed ──────────────
{
    const dir = mk();
    writeSpec(dir, spec());
    const c = await connect(dir);

    let r = await call(c, "generate_release_notes", { workspace_root: dir, version: "1.0.0", why: "First tracked release" });
    check("first release is a baseline: written, and claims no delta", !r.err && fs.existsSync(rel(dir, "1.0.0")) && r.text.includes("First recorded release") && r.text.includes("baseline"), r.text.slice(0, 400));
    check("a snapshot is stored for the next release", fs.existsSync(path.join(dir, ".secufusion", "releases", "snapshots", "v1.0.0.json")));

    const s2 = spec();
    s2.microservices["sfn-reports-api"] = { language: "Go", port: "8090", owns_tables: ["reports"], kafka_consumes: ["user-deleted"] };
    s2.golden_rules.tenant_isolation = { rule: "Scope every query by tenant, in the query body", severity: "BLOCKER", reason: "leakage" };
    s2.golden_rules.tenant_404 = { rule: "Cross-tenant lookups return 404", severity: "BLOCKER", reason: "no existence leak" };
    writeSpec(dir, s2);
    r = await call(c, "generate_release_notes", { workspace_root: dir, version: "1.1.0", why: "Add reporting and tighten tenant isolation", fixed: ["Method-name-only tenant checks"] });
    const md = fs.existsSync(rel(dir, "1.1.0")) ? fs.readFileSync(rel(dir, "1.1.0"), "utf8") : "";
    check("second release compares against the stored snapshot of 1.0.0 automatically", r.text.includes("Compared against: v1.0.0") && /detected changes: [1-9]/.test(r.text), r.text.slice(0, 300));
    check("the delta leads: summary, then Added/Changed/Fixed..., snapshot last", md.indexOf("## Executive Summary") < md.indexOf("## Added") && md.indexOf("## Rule Changes") < md.indexOf("## Detailed Snapshot"));
    check("new service is reported as repository intelligence", /New services \(1\)[\s\S]*sfn-reports-api/.test(md), md.slice(0, 1200));
    check("rule changes: 1 added, 1 modified", /\| 1 \| 1 \| 0 \| 0 \|/.test(md) && md.includes("`tenant_404`") && md.includes("before:") && md.includes("after:"));
    check("the author's rationale and fixes are shown, labelled as author notes", md.includes("Why this release exists:** Add reporting") && /Author notes[\s\S]*Method-name-only tenant checks/.test(md));

    r = await call(c, "generate_release_notes", { workspace_root: dir, version: "1.2.0", dry_run: true });
    check("dry_run returns the notes but writes nothing", !r.err && r.text.includes("No significant changes since v1.1.0") && !fs.existsSync(rel(dir, "1.2.0")));

    r = await call(c, "generate_release_notes", { workspace_root: dir, version: "1.2.0", why: "Re-verified, no functional change" });
    const md3 = fs.readFileSync(rel(dir, "1.2.0"), "utf8");
    check("an unchanged release explicitly says so", md3.includes("No significant changes since v1.1.0") && md3.includes("## Added (0)\nNone."), md3.slice(0, 500));

    r = await call(c, "generate_release_notes", { workspace_root: dir, version: "1.3.0", include_snapshot: false, dry_run: true });
    check("the detailed snapshot is optional", !r.text.includes("## Detailed Snapshot"));
    await c.close();
    fs.rmSync(dir, { recursive: true, force: true });
}

// ── /sfn-init's real flow: the previous state only exists as a backup file ──
{
    const dir = mk();
    const before = spec();
    fs.writeFileSync(path.join(dir, ".secufusion-project-spec.json.backup-20261008"), JSON.stringify(before));
    const after = spec();
    after.microservices["sfn-iam-api"].port = "9001";
    writeSpec(dir, after);
    const c = await connect(dir);
    const r = await call(c, "generate_release_notes", { workspace_root: dir, version: "2.2.5", previous_version: "2.2.4", previous_spec_path: ".secufusion-project-spec.json.backup-20261008" });
    const md = fs.existsSync(rel(dir, "2.2.5")) ? fs.readFileSync(rel(dir, "2.2.5"), "utf8") : "";
    check("a previous spec backup works as the baseline when no snapshot exists", !r.err && /`sfn-iam-api` port: 8081 → 9001/.test(md) && md.includes("**Previous:** v2.2.4"), r.text.slice(0, 400));
    await c.close();
    fs.rmSync(dir, { recursive: true, force: true });
}

// ── migrations: compared when the baseline exists, disclosed when it does not ──
{
    const migs = (events, tenants) => JSON.stringify({
        mcp_guardrails: {},
        microservices: {
            "sfn-events-api": { has_migrations: true, current_state: { latest_version: events }, organization: { version_gaps: [], total_scripts: events } },
            "sfn-tenants-api": { has_migrations: true, current_state: { latest_version: tenants }, organization: { version_gaps: [5, 6, 7], total_scripts: tenants - 3 } },
        },
    });
    const dir = mk();
    writeSpec(dir, spec());
    fs.writeFileSync(path.join(dir, ".secufusion-project-spec.json.backup-1"), JSON.stringify(spec()));
    fs.writeFileSync(path.join(dir, ".secufusion-migrations.json.backup-1"), migs(41, 65));
    fs.writeFileSync(path.join(dir, ".secufusion-migrations.json"), migs(42, 67));
    const c = await connect(dir);

    let r = await call(c, "generate_release_notes", { workspace_root: dir, version: "4.0.0", previous_version: "3.3.1", previous_spec_path: ".secufusion-project-spec.json.backup-1", previous_migrations_path: ".secufusion-migrations.json.backup-1", dry_run: true, why: "Spec merge" });
    check("with the earlier migrations file, V41→V42 and V65→V67 are reported (a real run said 'no changes')", r.text.includes("latest V41; 41 script(s) → latest V42; 42 script(s)") && r.text.includes("latest V65") && r.text.includes("→ latest V67") && !r.text.includes("No significant changes"), r.text.slice(0, 900));

    r = await call(c, "generate_release_notes", { workspace_root: dir, version: "4.0.0", previous_version: "3.3.1", previous_spec_path: ".secufusion-project-spec.json.backup-1", dry_run: true, why: "Spec merge" });
    check("without the earlier migrations file it says 'Not compared: migrations', not 'no changes'", r.text.includes("**Not compared:** migrations") && r.text.includes("No significant changes") && !r.text.includes("mapping, migration or risk changed"), r.text.slice(0, 900));

    r = await call(c, "generate_release_notes", { workspace_root: dir, version: "4.0.0", previous_version: "3.3.1", previous_spec_path: ".secufusion-project-spec.json.backup-1", previous_migrations_path: "nope.json", dry_run: true });
    check("an unreadable migrations baseline is flagged, not ignored", r.text.includes("previous_migrations_path nope.json could not be read"), r.text.slice(0, 400));
    // what the new MCP version itself brings: every bundled version after the previous one, up to the new one
    r = await call(c, "generate_release_notes", { workspace_root: dir, version: "4.2.0", previous_version: "2.5.1", previous_spec_path: ".secufusion-project-spec.json.backup-1", previous_migrations_path: ".secufusion-migrations.json.backup-1", dry_run: true, why: "Upgrade" });
    const iExec = r.text.indexOf("## Executive Summary"), iMcp = r.text.indexOf("## What this MCP version brings"), iAdded = r.text.indexOf("## Added");
    check("init's release notes include 'What this MCP version brings', after the Executive Summary and before the project's Added", iExec >= 0 && iMcp > iExec && iAdded > iMcp, r.text.slice(0, 300));
    const iv = ["### v4.2.0", "### v4.1.0", "### v4.0.0"].map((h) => r.text.indexOf(h));
    check("skipping versions loses nothing: 4.0.0, 4.1.0 and 4.2.0 all appear, newest first", iv.every((x) => x > 0) && iv[0] < iv[1] && iv[1] < iv[2], JSON.stringify(iv));
    check("it carries the real content: summary, added, breaking changes and new tools of those releases", r.text.includes("product-aware") && r.text.includes("#### Breaking changes") && r.text.includes("#### New tools") && r.text.includes("`get_knowledge_health`") && r.text.includes("resolve_work_item_ref"));
    r = await call(c, "generate_release_notes", { workspace_root: dir, version: "4.2.0", previous_version: "4.1.0", previous_spec_path: ".secufusion-project-spec.json.backup-1", dry_run: true, why: "Upgrade" });
    check("only versions after the previous one are listed", r.text.includes("### v4.2.0") && !r.text.includes("### v4.1.0") && !r.text.includes("### v4.0.0"));
    r = await call(c, "generate_release_notes", { workspace_root: dir, version: "9.9.9", previous_version: "4.2.0", previous_spec_path: ".secufusion-project-spec.json.backup-1", dry_run: true, why: "Future" });
    check("when the new version has no notes of its own, the earlier bundled ones are shown and the gap is stated", r.text.includes("### v4.3.0") && r.text.includes("No release information is bundled for v9.9.9 itself"), r.text.slice(0, 300));
    r = await call(c, "generate_release_notes", { workspace_root: dir, version: "9.9.9", previous_version: "4.3.0", previous_spec_path: ".secufusion-project-spec.json.backup-1", dry_run: true, why: "Future" });
    check("a version with no bundled notes says so instead of staying silent",r.text.includes("No release information is bundled with this version of the MCP for v9.9.9"), r.text.slice(0, 300));
    r = await call(c, "generate_release_notes", { workspace_root: dir, version: "4.2.0", previous_version: "4.1.0", previous_spec_path: ".secufusion-project-spec.json.backup-1", dry_run: true, mcp_release_info: false });
    check("the section can be switched off", !r.text.includes("What this MCP version brings"));
    await c.close();
    fs.rmSync(dir, { recursive: true, force: true });
}

// ── a rescan must not destroy the previous migration state, or rewrite its line endings ──
{
    const dir = mk();
    fs.mkdirSync(path.join(dir, "svc-a", "src", "main", "resources", "db", "migration"), { recursive: true });
    fs.writeFileSync(path.join(dir, "svc-a", "pom.xml"), "<project/>");
    fs.writeFileSync(path.join(dir, "svc-a", "src", "main", "resources", "db", "migration", "V1__init.sql"), "select 1;");
    const c = await connect(dir);
    const migFile = path.join(dir, ".secufusion-migrations.json");
    const CRLF = String.fromCharCode(13, 10);

    await call(c, "refresh_repository_knowledge", { workspace_root: dir });
    check("the first scan creates the migrations file", fs.existsSync(migFile) && JSON.parse(fs.readFileSync(migFile, "utf8")).microservices["svc-a"].current_state.latest_version === 1);
    check("...and nothing to back up yet", fs.readdirSync(dir).filter((f) => f.startsWith(".secufusion-migrations.json.backup")).length === 0);

    fs.writeFileSync(migFile, fs.readFileSync(migFile, "utf8").split(String.fromCharCode(10)).join(CRLF) + CRLF); // a Windows checkout
    await call(c, "refresh_repository_knowledge", { workspace_root: dir });
    check("an unchanged rescan creates no backup and keeps CRLF", fs.readdirSync(dir).filter((f) => f.startsWith(".secufusion-migrations.json.backup")).length === 0 && fs.readFileSync(migFile, "utf8").includes(CRLF));

    fs.writeFileSync(path.join(dir, "svc-a", "src", "main", "resources", "db", "migration", "V2__more.sql"), "select 2;");
    await call(c, "refresh_repository_knowledge", { workspace_root: dir });
    const backups = fs.readdirSync(dir).filter((f) => f.startsWith(".secufusion-migrations.json.backup"));
    check("when a scan changes it, the previous state is kept as a timestamped backup", backups.length === 1 && JSON.parse(fs.readFileSync(path.join(dir, backups[0]), "utf8")).microservices["svc-a"].current_state.latest_version === 1, backups.join());
    check("the live file has the new state", JSON.parse(fs.readFileSync(migFile, "utf8")).microservices["svc-a"].current_state.latest_version === 2);
    const live = fs.readFileSync(migFile, "utf8");
    check("the rewrite preserves the file's CRLF line endings (no whole-file diff)", live.includes(CRLF) && !/[^\r]\n/.test(live), JSON.stringify(live.slice(0, 40)));
    await c.close();
    fs.rmSync(dir, { recursive: true, force: true });
}

// ── stack detection looks inside the service folders ───────────────────────
{
    const dir = mk();
    for (const s of ["sfn-a-api", "sfn-b-api"]) { fs.mkdirSync(path.join(dir, s)); fs.writeFileSync(path.join(dir, s, "pom.xml"), "<project/>"); }
    fs.mkdirSync(path.join(dir, "web")); fs.writeFileSync(path.join(dir, "web", "package.json"), "{}");
    fs.mkdirSync(path.join(dir, "svc-docker")); fs.writeFileSync(path.join(dir, "svc-docker", "Dockerfile"), "FROM x");
    fs.writeFileSync(path.join(dir, ".secufusion-project-spec.json"), JSON.stringify(spec()));
    const c = await connect(dir);
    const r = await call(c, "scan_repository_stack", { workspace_root: dir });
    check("a poly-repo reports Java/Spring (with the project names), Node.js and Docker, not just the root", r.text.includes("Java/Spring (2 projects: sfn-a-api, sfn-b-api") && r.text.includes("Node.js (1 project: web") && r.text.includes("Docker"), r.text.slice(0, 400));
    await c.close();
    fs.rmSync(dir, { recursive: true, force: true });
}

// ── failure modes are loud ─────────────────────────────────────────────────
{
    const dir = mk();
    const c = await connect(dir);
    let r = await call(c, "generate_release_notes", { workspace_root: dir, version: "1.0.0" });
    check("no project spec: refuses with the fix", r.err && r.text.includes("/sfn-init"), r.text);
    fs.writeFileSync(path.join(dir, ".secufusion-project-spec.json"), "{ not json");
    r = await call(c, "generate_release_notes", { workspace_root: dir, version: "1.0.0" });
    check("invalid spec JSON: refuses", r.err && r.text.includes("not valid JSON"), r.text);
    writeSpec(dir, spec());
    r = await call(c, "generate_release_notes", { workspace_root: dir, version: "3.0.0", previous_version: "2.9.9" });
    check("an unknown previous version is reported, and the note falls back to baseline instead of inventing a delta", !r.err && r.text.includes("No stored snapshot for v2.9.9") && r.text.includes("First recorded release"), r.text.slice(0, 500));
    await c.close();
    fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures ? 1 : 0);
