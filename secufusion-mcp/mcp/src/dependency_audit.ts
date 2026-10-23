import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

/**
 * Dependency changes and known vulnerabilities.
 *
 * The diff is deterministic (pom.xml and package.json at the base and at the head). The vulnerability
 * lookup asks OSV (https://osv.dev, no key) about the EXACT versions the change adds or moves, and sends
 * nothing else: no code, no repository name, only package names and versions. It is off unless the caller
 * allows the network, and it never invents an advisory: a version that cannot be pinned is reported as
 * skipped, not as safe.
 */
export interface Dep { version: string; scope: string }
export interface DepChange { manifest: string; name: string; change: "added" | "removed" | "changed"; from?: string; to?: string; scope: string; bump?: string }

export function parsePom(xml: string): Record<string, Dep> {
    if (!xml) return {};
    const body = xml.replace(/<!--[\s\S]*?-->/g, "");
    const props: Record<string, string> = {};
    const propsBlock = body.match(/<properties>([\s\S]*?)<\/properties>/)?.[1] ?? "";
    for (const m of propsBlock.matchAll(/<([\w.-]+)>\s*([^<]*?)\s*<\/\1>/g)) props[m[1]] = m[2];
    const project = body.match(/<project[\s\S]*?>[\s\S]*?<version>\s*([^<]+?)\s*<\/version>/);
    if (project) props["project.version"] = project[1];
    const resolve = (v?: string) => (v ?? "").replace(/\$\{([^}]+)\}/g, (_, k) => props[k] ?? `\${${k}}`);
    const deps: Record<string, Dep> = {};
    const managed = body.match(/<dependencyManagement>([\s\S]*?)<\/dependencyManagement>/)?.[1] ?? "";
    const direct = body.replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/, "").replace(/<plugins>[\s\S]*?<\/plugins>/g, "");
    const collect = (text: string, prefix: string) => {
        for (const m of text.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
            const tag = (t: string) => m[1].match(new RegExp(`<${t}>\\s*([^<]+?)\\s*</${t}>`))?.[1];
            const g = tag("groupId"), a = tag("artifactId");
            if (!g || !a) continue;
            deps[`${prefix}${g}:${a}`] = { version: resolve(tag("version")) || "managed", scope: tag("scope") ?? "compile" };
        }
    };
    collect(direct, "");
    collect(managed, "managed:");
    const parent = body.match(/<parent>([\s\S]*?)<\/parent>/)?.[1];
    if (parent) {
        const t = (x: string) => parent.match(new RegExp(`<${x}>\\s*([^<]+?)\\s*</${x}>`))?.[1];
        deps[`parent:${t("groupId")}:${t("artifactId")}`] = { version: resolve(t("version")), scope: "parent" };
    }
    return deps;
}

export function parsePackageJson(text: string): Record<string, Dep> {
    if (!text) return {};
    let pkg: any;
    try { pkg = JSON.parse(text); } catch { return {}; }
    const deps: Record<string, Dep> = {};
    for (const [section, scope] of [["dependencies", "prod"], ["devDependencies", "dev"], ["peerDependencies", "peer"], ["optionalDependencies", "optional"]] as const) {
        for (const [name, version] of Object.entries(pkg[section] ?? {})) deps[name] = { version: String(version), scope };
    }
    return deps;
}

export function semverBump(from?: string, to?: string): string {
    const v = (s?: string) => String(s ?? "").replace(/^[^\d]*/, "").split(/[.-]/).map((x) => Number.parseInt(x, 10));
    const [a, b] = [v(from), v(to)];
    if (Number.isNaN(a[0]) || Number.isNaN(b[0])) return "unknown";
    if (a[0] !== b[0]) return b[0] > a[0] ? "major" : "downgrade";
    if ((a[1] || 0) !== (b[1] || 0)) return (b[1] || 0) > (a[1] || 0) ? "minor" : "downgrade";
    if ((a[2] || 0) !== (b[2] || 0)) return (b[2] || 0) > (a[2] || 0) ? "patch" : "downgrade";
    return "other";
}

export function diffDeps(manifest: string, before: Record<string, Dep>, after: Record<string, Dep>): DepChange[] {
    const out: DepChange[] = [];
    for (const [name, d] of Object.entries(after)) {
        const b = before[name];
        if (!b) out.push({ manifest, name, change: "added", to: d.version, scope: d.scope });
        else if (b.version !== d.version || b.scope !== d.scope) out.push({ manifest, name, change: "changed", from: b.version, to: d.version, scope: d.scope, bump: semverBump(b.version, d.version) });
    }
    for (const [name, b] of Object.entries(before)) if (!after[name]) out.push({ manifest, name, change: "removed", from: b.version, scope: b.scope });
    return out;
}

const git = (root: string, args: string[]): string => {
    try { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }); } catch { return ""; }
};

/** Dependencies the working tree adds, removes or re-versions against `base`. Walks every pom.xml / package.json that changed. */
export function dependencyChanges(root: string, base: string): DepChange[] {
    if (!/^[\w./~^@{}-]+$/.test(base)) throw new Error(`refusing base ref "${base}"`);
    const files = new Set<string>();
    for (const l of git(root, ["diff", "--name-only", base]).split("\n")) if (/(^|\/)(pom\.xml|package\.json)$/.test(l)) files.add(l);
    for (const l of git(root, ["ls-files", "--others", "--exclude-standard"]).split("\n")) if (/(^|\/)(pom\.xml|package\.json)$/.test(l)) files.add(l);
    const out: DepChange[] = [];
    for (const f of files) {
        const parse = f.endsWith("pom.xml") ? parsePom : parsePackageJson;
        const before = parse(git(root, ["show", `${base}:${f}`]));
        let after: Record<string, Dep> = {};
        try { after = parse(fs.readFileSync(path.join(root, f), "utf8")); } catch { /* deleted */ }
        out.push(...diffDeps(f, before, after));
    }
    return out;
}

// ---- OSV ------------------------------------------------------------------------------------------

/** Exact versions for npm packages from package-lock.json (lockfileVersion 2/3). */
export function lockVersions(lockText: string): Record<string, string> {
    const out: Record<string, string> = {};
    try {
        const lock = JSON.parse(lockText);
        for (const [p, meta] of Object.entries<any>(lock.packages ?? {})) {
            const m = p.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/);
            if (m && meta?.version && p === `node_modules/${m[1]}`) out[m[1]] = meta.version;
        }
    } catch { /* no or invalid lockfile */ }
    return out;
}

const EXACT = /^\d+\.\d+(\.\d+)?([.-][\w.]+)?$/;

export function buildQueries(changes: DepChange[], npmLock: Record<string, string> = {}) {
    const queries: Array<{ package: { name: string; ecosystem: string }; version: string; dep: DepChange }> = [];
    const skipped: Array<{ name: string; version?: string; reason: string }> = [];
    for (const d of changes) {
        if (d.change === "removed" || d.name.startsWith("managed:")) continue;
        const pom = /(^|\/)pom\.xml$/.test(d.manifest);
        const name = pom ? d.name.replace(/^parent:/, "") : d.name;
        const version = pom ? d.to : npmLock[d.name] ?? String(d.to ?? "").replace(/^[~^=v]/, "");
        if (!version || !EXACT.test(version)) { skipped.push({ name, version: d.to, reason: "no exact version (managed, range or property)" }); continue; }
        queries.push({ package: { name, ecosystem: pom ? "Maven" : "npm" }, version, dep: d });
    }
    return { queries, skipped };
}

const severityOf = (v: any): string => {
    const db = String(v.database_specific?.severity ?? "").toUpperCase();
    return ["CRITICAL", "HIGH", "MODERATE", "MEDIUM", "LOW"].includes(db) ? (db === "MODERATE" ? "MEDIUM" : db) : "UNKNOWN";
};
const fixedVersions = (v: any, name: string): string[] => {
    const out = new Set<string>();
    for (const a of v.affected ?? []) if (a.package?.name === name) for (const r of a.ranges ?? []) for (const e of r.events ?? []) if (e.fixed) out.add(e.fixed);
    return [...out];
};

export interface VulnerableDep { manifest: string; name: string; ecosystem: string; version: string; change: string; vulns: Array<{ id: string; aliases?: string[]; summary?: string; severity?: string; fixed?: string[] }>; more: number }

export async function auditWithOsv(o: { queries: ReturnType<typeof buildQueries>["queries"]; baseUrl?: string; fetchImpl?: typeof fetch }): Promise<VulnerableDep[]> {
    const { queries, baseUrl = "https://api.osv.dev", fetchImpl = fetch } = o;
    if (!queries.length) return [];
    const res = await fetchImpl(`${baseUrl}/v1/querybatch`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ queries: queries.map(({ package: p, version }) => ({ package: p, version })) }),
        signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`OSV querybatch -> ${res.status}`);
    const { results = [] } = (await res.json()) as any;
    const out: VulnerableDep[] = [];
    for (let i = 0; i < queries.length; i++) {
        const ids: string[] = (results[i]?.vulns ?? []).map((v: any) => v.id);
        if (!ids.length) continue;
        const vulns: VulnerableDep["vulns"] = [];
        for (const id of ids.slice(0, 10)) {
            const r = await fetchImpl(`${baseUrl}/v1/vulns/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(30_000) });
            if (!r.ok) { vulns.push({ id }); continue; }
            const v: any = await r.json();
            vulns.push({ id: v.id, aliases: v.aliases ?? [], summary: v.summary ?? "", severity: severityOf(v), fixed: fixedVersions(v, queries[i].package.name) });
        }
        const q = queries[i];
        out.push({ manifest: q.dep.manifest, name: q.package.name, ecosystem: q.package.ecosystem, version: q.version, change: q.dep.change, vulns, more: Math.max(0, ids.length - 10) });
    }
    return out;
}

export interface DepAudit { base: string; changes: DepChange[]; major_upgrades: DepChange[]; checked: number; skipped: Array<{ name: string; reason: string }>; vulnerable: VulnerableDep[]; osv: "queried" | "not_allowed" | "failed"; osv_error?: string }

export async function auditDependencies(root: string, o: { base: string; allowNetwork?: boolean; baseUrl?: string; fetchImpl?: typeof fetch }): Promise<DepAudit> {
    const changes = dependencyChanges(root, o.base);
    let npmLock: Record<string, string> = {};
    for (const m of new Set(changes.map((d) => d.manifest).filter((m) => m.endsWith("package.json")))) {
        const lock = path.join(root, path.dirname(m), "package-lock.json");
        if (fs.existsSync(lock)) npmLock = { ...npmLock, ...lockVersions(fs.readFileSync(lock, "utf8")) };
    }
    const { queries, skipped } = buildQueries(changes, npmLock);
    const base: DepAudit = { base: o.base, changes, major_upgrades: changes.filter((c) => c.bump === "major"), checked: 0, skipped, vulnerable: [], osv: "not_allowed" };
    if (!o.allowNetwork) return base;
    try {
        base.vulnerable = await auditWithOsv({ queries, baseUrl: o.baseUrl, fetchImpl: o.fetchImpl });
        base.checked = queries.length;
        base.osv = "queried";
    } catch (e: any) {
        base.osv = "failed";
        base.osv_error = String(e?.message ?? e);
    }
    return base;
}

export function renderDepAudit(a: DepAudit): string {
    const o = [`# Dependency audit vs ${a.base}: ${a.changes.length} change(s), ${a.major_upgrades.length} major upgrade(s)`, ""];
    for (const c of a.changes) o.push(`${c.change.toUpperCase().padEnd(8)} ${c.name} ${c.from ? c.from + " -> " : ""}${c.to ?? ""}${c.bump ? ` (${c.bump})` : ""}  [${c.scope}] ${c.manifest}`);
    if (a.osv === "not_allowed") o.push("", "Vulnerability lookup NOT run: it sends package names and versions to osv.dev, so it needs allow_network=true.");
    if (a.osv === "failed") o.push("", `Vulnerability lookup FAILED (${a.osv_error}). Treat the versions as unchecked, not as safe.`);
    if (a.osv === "queried") {
        o.push("", `OSV checked ${a.checked} exact version(s): ${a.vulnerable.length} with known vulnerabilities.`);
        for (const v of a.vulnerable) {
            o.push(`  VULNERABLE ${v.name}@${v.version} (${v.ecosystem})`);
            for (const x of v.vulns) o.push(`    ${x.id}${x.aliases?.length ? " / " + x.aliases.join(", ") : ""}  ${x.severity ?? ""}  ${x.summary ?? ""}${x.fixed?.length ? "  fixed in " + x.fixed.join(", ") : ""}`);
            if (v.more) o.push(`    ... and ${v.more} more`);
        }
    }
    if (a.skipped.length) o.push("", `Not checked (${a.skipped.length}): ${a.skipped.map((s) => s.name).join(", ")} — no exact version. This is UNKNOWN, not clean.`);
    return o.join("\n");
}
