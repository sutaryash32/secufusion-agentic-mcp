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
