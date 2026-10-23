import path from "path";
import { execFileSync } from "child_process";
import { classify } from "./migration_guard.js";
import { diffDeps, parsePackageJson, parsePom } from "./dependency_audit.js";
/**
 * Release readiness: what is in a release, and what operations must do for it.
 *
 * Deterministic (git only, no model). For a range `from..to` it lists the pull requests and work items,
 * the migrations to apply in order (and the ones that were edited, duplicated or numbered below the
 * head), new configuration and environment variables (with "no default, startup fails without it"),
 * feature flags and whether they default on, dependency changes, and endpoints and topics added or removed.
 * Each attention item says what to do. It answers "can we ship this, and what must ops do first".
 */
export function parseIncluded(subjects) {
    const prs = [];
    const workItems = new Set();
    for (const s of subjects) {
        const m = s.match(/^Merged PR (\d+): (.+)$/) ?? s.match(/^Merge pull request #(\d+)[^\n]*$/);
        if (m)
            prs.push({ id: Number(m[1]), title: m[2] ?? s });
        for (const w of s.matchAll(/\b(?:WI|BUG|US|TASK|AB#)[- #]?(\d{3,6})\b/gi))
            workItems.add(Number(w[1]));
    }
    return { prs, workItems: [...workItems].sort((a, b) => a - b) };
}
export function parseProperties(text = "") {
    const out = {};
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#") || line.startsWith("!"))
            continue;
        const m = line.match(/^([^=:\s]+)\s*[=:]\s*(.*)$/);
        if (m)
            out[m[1]] = m[2];
    }
    return out;
}
/** Minimal YAML flattener for Spring-style config: mappings and scalars; lists are skipped. */
export function flattenYaml(text = "") {
    const out = {};
    const stack = [];
    for (const raw of text.split(/\r?\n/)) {
        const t = raw.trim();
        if (!t || t.startsWith("#") || t === "---")
            continue;
        const indent = raw.length - raw.trimStart().length;
        const m = t.match(/^([\w.\-[\]]+)\s*:\s*(.*)$/);
        if (!m)
            continue;
        while (stack.length && stack[stack.length - 1].indent >= indent)
            stack.pop();
        const key = [...stack.map((s) => s.key), m[1]].join(".");
        if (m[2] === "" || m[2] === "|" || m[2] === ">")
            stack.push({ indent, key: m[1] });
        else
            out[key] = m[2].replace(/^["']|["']$/g, "");
    }
    return out;
}
export function diffConfig(file, before, after) {
    const added = [], removed = [], changed = [];
    for (const [k, v] of Object.entries(after)) {
        if (!(k in before))
            added.push({ key: k, value: v });
        else if (before[k] !== v)
            changed.push({ key: k, from: before[k], to: v });
    }
    for (const k of Object.keys(before))
        if (!(k in after))
            removed.push({ key: k, value: before[k] });
    return { file, added, removed, changed };
}
/** Environment variables referenced as ${VAR} or ${VAR:default}. `required` = no default, so startup fails without it. */
export function envVars(diffs) {
    const vars = new Map();
    for (const d of diffs) {
        for (const e of [...d.added, ...d.changed.map((c) => ({ key: c.key, value: c.to }))]) {
            for (const m of String(e.value).matchAll(/\$\{([A-Z][A-Z0-9_]*)(?::([^}]*))?\}/g)) {
                const prev = vars.get(m[1]);
                vars.set(m[1], { name: m[1], required: m[2] === undefined && (prev?.required ?? true), default: m[2] ?? prev?.default, usedBy: [...(prev?.usedBy ?? []), `${d.file}:${e.key}`] });
            }
        }
    }
    return [...vars.values()];
}
export function featureFlags(diffs) {
    const flags = [];
    for (const d of diffs) {
        for (const e of d.added) {
            if (/(^|\.)(enabled|enable|feature\.[\w.-]+)$/i.test(e.key)) {
                const def = String(e.value).match(/\$\{[A-Z0-9_]+:(true|false)\}/i)?.[1] ?? String(e.value);
                flags.push({ file: d.file, key: e.key, default: def, onByDefault: /^true$/i.test(def) });
            }
        }
    }
    return flags;
}
/** Endpoint and topic surface changes from a unified diff (added versus removed lines). */
export function surfaceChanges(diffText) {
    const endpoints = { added: [], removed: [] };
    const topics = { added: [], removed: [] };
    for (const line of diffText.split(/\r?\n/)) {
        const sign = line[0];
        if ((sign !== "+" && sign !== "-") || line.startsWith("+++") || line.startsWith("---"))
            continue;
        const body = line.slice(1);
        const ep = body.match(/@(Get|Post|Put|Delete|Patch|Request)Mapping\s*\(\s*(?:value\s*=\s*|path\s*=\s*)?"([^"]*)"/);
        if (ep)
            (sign === "+" ? endpoints.added : endpoints.removed).push(`${ep[1] === "Request" ? "*" : ep[1].toUpperCase()} ${ep[2]}`);
        const tp = body.match(/\b\w*TOPIC\w*\s*=\s*"([^"]+)"/);
        if (tp)
            (sign === "+" ? topics.added : topics.removed).push(tp[1]);
    }
    const net = (x) => ({ added: x.added.filter((a) => !x.removed.includes(a)), removed: x.removed.filter((r) => !x.added.includes(r)) });
    return { endpoints: net(endpoints), topics: net(topics) };
}
const FLYWAY = /(?:^|\/)V(\d+)(?:_(\d+))?__([\w-]+)\.sql$/;
const flywayVersion = (p) => { const m = p.match(FLYWAY); return m ? Number(`${m[1]}.${m[2] ?? 0}`) : undefined; };
/** Added, edited, deleted, malformed, duplicated and out-of-order migrations in the range. Any framework for edits and deletes; Flyway-style for the numbering. */
export function analyseMigrations(changes, allAtTo) {
    const mig = changes.filter((c) => classify(c.path));
    const added = changes.filter((c) => c.status === "A" && flywayVersion(c.path) !== undefined).map((c) => ({ path: c.path, version: flywayVersion(c.path) })).sort((a, b) => a.version - b.version);
    const modified = mig.filter((c) => c.status === "M" && !classify(c.path).repeatable).map((c) => c.path);
    const deleted = mig.filter((c) => c.status === "D" && !classify(c.path).repeatable).map((c) => c.path);
    const malformed = changes.filter((c) => c.status === "A" && /(^|\/)db\/migration\/[^/]+\.sql$/.test(c.path) && flywayVersion(c.path) === undefined && !/(^|\/)R__/.test(c.path)).map((c) => c.path);
    const byVersion = new Map();
    for (const p of allAtTo) {
        const v = flywayVersion(p);
        if (v !== undefined)
            byVersion.set(v, [...(byVersion.get(v) ?? []), p]);
    }
    const duplicates = [...byVersion.entries()].filter(([, ps]) => ps.length > 1).map(([version, files]) => ({ version, files }));
    const priorMax = Math.max(0, ...[...byVersion.keys()].filter((v) => !added.some((a) => a.version === v)));
    return { added, modified, deleted, malformed, duplicates, outOfOrder: added.filter((a) => a.version < priorMax).map((a) => a.path) };
}
export function releaseVerdict(r) {
    const attention = [];
    if (r.migrations.modified.length)
        attention.push(`${r.migrations.modified.length} already-existing migration(s) modified: ${r.migrations.modified.map((m) => path.basename(m)).join(", ")}`);
    if (r.migrations.deleted.length)
        attention.push(`${r.migrations.deleted.length} migration(s) deleted`);
    if (r.migrations.duplicates.length)
        attention.push(`duplicate migration version(s): ${r.migrations.duplicates.map((d) => `V${d.version}`).join(", ")}`);
    if (r.migrations.outOfOrder.length)
        attention.push(`${r.migrations.outOfOrder.length} migration(s) numbered below the current head`);
    if (r.migrations.malformed.length)
        attention.push(`${r.migrations.malformed.length} malformed migration filename(s)`);
    const req = r.envVars.filter((v) => v.required);
    if (req.length)
        attention.push(`${req.length} new env var(s) with no default: ${req.map((v) => v.name).join(", ")}`);
    const on = r.flags.filter((f) => f.onByDefault);
    if (on.length)
        attention.push(`${on.length} new flag(s) on by default: ${on.map((f) => f.key).join(", ")}`);
    const majors = r.dependencyChanges.filter((d) => d.bump === "major");
    if (majors.length)
        attention.push(`${majors.length} major dependency upgrade(s): ${majors.map((d) => d.name).join(", ")}`);
    if (r.surface.endpoints.removed.length)
        attention.push(`${r.surface.endpoints.removed.length} endpoint mapping(s) removed: check callers`);
    if (r.surface.topics.removed.length)
        attention.push(`${r.surface.topics.removed.length} Kafka topic constant(s) removed: check consumers`);
    return { verdict: (attention.length ? "attention" : "ready"), attention };
}
const REF = /^[\w./~^@{}-]+$/;
const git = (root, args) => {
    try {
        return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    }
    catch {
        return "";
    }
};
const refExists = (root, ref) => git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).trim() !== "";
export function checkRelease(root, o = {}) {
    const repo = path.basename(path.resolve(root));
    const to = o.to ?? (refExists(root, "origin/develop") ? "origin/develop" : "HEAD");
    const from = o.from ?? git(root, ["describe", "--tags", "--abbrev=0", to]).trim();
    if (![from, to].every((r) => r && REF.test(r)))
        return { error: `refusing refs "${from}".."${to}"` };
    if (!refExists(root, from) || !refExists(root, to))
        return { error: `cannot resolve ${from || "(no tag)"}..${to}. Pass "from" (a tag or commit).` };
    const subjects = git(root, ["log", "--format=%s", `${from}..${to}`]).split("\n").filter(Boolean);
    const nameStatus = git(root, ["diff", "--no-renames", "--name-status", from, to]).split("\n").filter(Boolean).map((l) => { const [status, p] = l.split("\t"); return { status: status[0], path: p }; });
    const show = (rev, p) => git(root, ["show", `${rev}:${p}`]);
    const migrations = analyseMigrations(nameStatus, git(root, ["ls-tree", "-r", "--name-only", to]).split("\n").filter((p) => classify(p)));
    const configDiffs = nameStatus
        .filter((c) => /(^|\/)application[^/]*\.(properties|ya?ml)$/.test(c.path) && !c.path.includes("/test/"))
        .map((c) => {
        const parse = c.path.endsWith(".properties") ? parseProperties : flattenYaml;
        return diffConfig(c.path, parse(c.status === "A" ? "" : show(from, c.path)), parse(c.status === "D" ? "" : show(to, c.path)));
    })
        .filter((d) => d.added.length || d.removed.length || d.changed.length);
    const dependencyChanges = nameStatus.flatMap(({ path: p, status }) => {
        const parse = /(^|\/)pom\.xml$/.test(p) ? parsePom : /(^|\/)package\.json$/.test(p) ? parsePackageJson : null;
        return parse ? diffDeps(p, parse(status === "A" ? "" : show(from, p)), parse(status === "D" ? "" : show(to, p))) : [];
    });
    const surface = surfaceChanges(git(root, ["diff", "-U0", from, to, "--", "*.java"]));
    const partial = { migrations, envVars: envVars(configDiffs), flags: featureFlags(configDiffs), dependencyChanges, surface };
    return { repo, from, to, commits: subjects.length, filesChanged: nameStatus.length, ...parseIncluded(subjects), configDiffs, ...partial, ...releaseVerdict(partial) };
}
export function renderRelease(r) {
    if ("error" in r)
        return `Release check failed: ${r.error}`;
    const L = [`# Release readiness: ${r.repo} \`${r.from}\` -> \`${r.to}\` — ${r.verdict === "ready" ? "READY" : "NEEDS ATTENTION"}`, "",
        `${r.commits} commits · ${r.filesChanged} files · ${r.prs.length} PRs${r.workItems.length ? ` · work items ${r.workItems.map((w) => `#${w}`).join(", ")}` : ""}`, ""];
    if (r.attention.length)
        L.push("## Needs attention", ...r.attention.map((a) => `- ${a}`), "");
    L.push("## Ops checklist");
    if (r.migrations.added.length) {
        L.push("- [ ] Apply migrations in this order:");
        r.migrations.added.forEach((m) => L.push(`  - [ ] ${path.basename(m.path)}`));
    }
    else
        L.push("- No new migrations.");
    for (const v of r.envVars)
        L.push(`- [ ] ${v.required ? "Set" : "Optionally set"} env ${v.name}${v.default !== undefined ? ` (default ${v.default})` : " — NO DEFAULT, startup fails without it"} — used by ${v.usedBy.join(", ")}`);
    for (const f of r.flags)
        L.push(`- [ ] Flag ${f.key} defaults to ${f.default}${f.onByDefault ? " — ON BY DEFAULT" : ""} (${f.file})`);
    for (const d of r.configDiffs) {
        for (const c of d.changed)
            L.push(`- [ ] Config ${c.key} changed ${c.from} -> ${c.to} (${d.file})`);
        for (const c of d.removed)
            L.push(`- [ ] Config ${c.key} removed (${d.file}): remove overrides in the environment files`);
    }
    if (r.dependencyChanges.length)
        L.push("", "## Dependencies", ...r.dependencyChanges.map((d) => `- ${d.change} ${d.name} ${d.from ? d.from + " -> " : ""}${d.to ?? ""}${d.bump === "major" ? " (MAJOR)" : ""}`));
    const s = r.surface;
    if (s.endpoints.added.length || s.endpoints.removed.length || s.topics.added.length || s.topics.removed.length) {
        L.push("", "## API and Kafka surface", ...s.endpoints.added.map((e) => `- + endpoint ${e}`), ...s.endpoints.removed.map((e) => `- - endpoint ${e} (check callers)`), ...s.topics.added.map((t) => `- + topic ${t}`), ...s.topics.removed.map((t) => `- - topic ${t} (check consumers)`));
    }
    if (r.prs.length)
        L.push("", "## Pull requests", ...r.prs.map((p) => `- #${p.id} ${p.title}`));
    L.push("", "Deterministic: from git and the config files only. It does not read the code, so run /sfn-review on the range for logic.");
    return L.join("\n");
}
