/**
 * Four small capabilities, each added to close one observed miss in a client-parity calibration. None is a general review lens.
 *
 *   uiGating            who can SEE an action in the UI versus who the server lets EXECUTE it            (parent-admin visibility miss)
 *   endpointConsumers   every caller of an endpoint: UI screens, other services, and their wrappers     (GET /users callers miss)
 *   serviceOwnership    which service owns a table, and which others write it                            (shared-database assumption miss)
 *   parentCascade       what deleting/deprovisioning a parent does to its children, and whether the
 *                       child guard is on that path                                                       (deprovisioning bypass miss)
 *
 * Pattern-based and READ-ONLY. They list evidence and the question it raises; the reviewer argues the consequence.
 */
import fs from "fs";
import path from "path";

const SKIP_DIR = new Set(["node_modules", "dist", "build", "target", ".git", ".idea", ".vscode", "coverage", ".secufusion", ".mcp", "out", "bin"]);
const TEST = /(^|\/)(src\/test|__tests__|tests?|spec)\/|\.(test|spec)\.[jt]sx?$|(Test|Tests|IT)\.(java|kt)$/;
const COMMENT = /^\s*(\*|\/\/|\/\*|#|--|<!--)/;

interface F { rel: string; service: string; lines: string[] }
function load(root: string, ext: RegExp, opts: { tests?: boolean; budget?: number } = {}): F[] {
    const out: F[] = [];
    const budget = { n: opts.budget ?? 9000 };
    const walk = (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (budget.n <= 0) return;
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { if (!SKIP_DIR.has(e.name) && !e.name.startsWith(".")) walk(p); continue; }
            if (!ext.test(e.name)) continue;
            const rel = path.relative(root, p).split(path.sep).join("/");
            if (!opts.tests && TEST.test(rel)) continue;
            try { if (fs.statSync(p).size > 600_000) continue; out.push({ rel, service: rel.includes("/") ? rel.split("/")[0] : "(root)", lines: fs.readFileSync(p, "utf-8").split(/\r?\n/) }); budget.n--; } catch { /* unreadable */ }
        }
    };
    walk(root);
    return out;
}
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ev = (f: F, i: number) => `${f.rel}:${i + 1}  ${f.lines[i].trim().slice(0, 150)}`;

function block(lines: string[], start: number, max = 120): number {
    let depth = 0, seen = false;
    for (let i = start; i < Math.min(lines.length, start + max); i++) {
        for (const ch of lines[i]) { if (ch === "{" || ch === "(") { depth++; seen = true; } else if (ch === "}" || ch === ")") depth--; }
        if (seen && depth <= 0) return i;
    }
    return Math.min(lines.length - 1, start + max);
}

// ── UI gating matrix ────────────────────────────────────────────────────────

const SERVER_AUTH = /(@PreAuthorize|@Secured|@RolesAllowed|AccessDenied|Forbidden|isSameOrAncestor|ancestor|parentTenant|ParentChain|callerCanAccess|requireCaller|hasAuthority|hasRole|getIsAdmin|isAdmin|isPortalAdmin|Not authori[sz]ed|Only [A-Za-z ]+ can)/i;
const UI_GATE = /(hidden\s*:|disabled\s*[=:]|\bcan[A-Z]\w*|permissions\.|hasPermission|isPortalAdmin\w*|isAdmin|canEdit|canDelete|\bshow[A-Z]\w*\s*=)/;
export interface GatingResult {
    action: string;
    server: Array<{ kind: "entry" | "annotation" | "check"; where: string }>;
    ui_gates: Array<{ where: string }>;
    predicates: Array<{ name: string; defined: string; list_lookup: string | null; fallback: string | null; inputs: string }>;
    questions: string[]; files_scanned: number;
}

export function uiGating(root: string, o: { action: string; server_hint: string; ui_hint: string }): GatingResult {
    const sRe = new RegExp(o.server_hint, "i"), uRe = new RegExp(o.ui_hint, "i");
    const server: GatingResult["server"] = [];
    const jv = load(root, /\.(java|kt)$/);
    const calls = new Set<string>();
    for (const f of jv) {
        if (!f.lines.some((l) => sRe.test(l))) continue;
        for (let i = 0; i < f.lines.length; i++) {
            const l = f.lines[i];
            if (COMMENT.test(l) || !sRe.test(l)) continue;
            if (/@(Post|Get|Put|Delete|Patch|Request)Mapping/.test(l)) {
                server.push({ kind: "entry", where: ev(f, i) });
                for (let k = Math.max(0, i - 6); k <= Math.min(f.lines.length - 1, i + 1); k++) if (/@(PreAuthorize|Secured|RolesAllowed)/.test(f.lines[k])) server.push({ kind: "annotation", where: ev(f, k) });
                // the handler body and the service method it calls
                // the handler starts at the first non-annotation line with an opening parenthesis after the mapping
                let m = i + 1; while (m < f.lines.length && (/^\s*@/.test(f.lines[m]) || !/\w\s*\(/.test(f.lines[m])) && m < i + 14) m++;
                const end = block(f.lines, Math.min(m, f.lines.length - 1), 80);
                for (let k = i; k <= end; k++) { if (SERVER_AUTH.test(f.lines[k]) && !/@Operation|@ApiResponse/.test(f.lines[k])) server.push({ kind: "check", where: ev(f, k) }); for (const c of f.lines[k].matchAll(/\b(\w+Service)\.(\w+)\(/g)) if (sRe.test(c[2])) calls.add(c[2]); }
            }
        }
    }
    for (const f of jv) {
        for (let i = 0; i < f.lines.length; i++) {
            const m = /\b(?:public|protected|private)?\s*[\w<>\[\], ?]+\s+(\w+)\s*\(/.exec(f.lines[i]);
            if (!m || !calls.has(m[1]) || /;\s*$/.test(f.lines[i]) || /@RestController/.test(f.lines.slice(0, 40).join("\n"))) continue;
            const end = block(f.lines, i, 160);
            server.push({ kind: "entry", where: `service ${ev(f, i)}` });
            for (let k = i; k <= end; k++) if (SERVER_AUTH.test(f.lines[k]) && !COMMENT.test(f.lines[k])) server.push({ kind: "check", where: ev(f, k) });
        }
    }
    const ui = load(root, /\.(jsx?|tsx?|vue)$/);
    const gates: GatingResult["ui_gates"] = [];
    const names = new Set<string>();
    for (const f of ui) {
        if (!f.lines.some((l) => uRe.test(l))) continue;
        for (let i = 0; i < f.lines.length; i++) {
            const l = f.lines[i];
            if (COMMENT.test(l)) continue;
            if ((uRe.test(l) && UI_GATE.test(l)) || (UI_GATE.test(l) && /\bcan[A-Z]\w*/.test(l) && f.lines.slice(Math.max(0, i - 3), i + 4).some((x) => uRe.test(x)))) {
                gates.push({ where: ev(f, i) });
                for (const n of l.matchAll(/\b(can[A-Z]\w*)\b/g)) names.add(n[1]);
            }
        }
    }
    const preds: GatingResult["predicates"] = [];
    for (const n of names) {
        for (const f of ui) {
            const i = f.lines.findIndex((l) => new RegExp(`\\b(const|let|var)\\s+${esc(n)}\\b`).test(l));
            if (i < 0) continue;
            const end = block(f.lines, i, 40);
            const body = f.lines.slice(i, end + 1);
            const look = body.find((l) => /\.(find|some|filter|includes)\(/.test(l)) ?? null;
            // the fallback that matters is the one taken when the lookup finds nothing: a ternary or ?? default, not an early return
            const fb = [...body].reverse().find((l) => /\?[^:]*:\s*(true|false)\b|\?\?\s*(true|false)|\|\|\s*(true|false)\b/.test(l)) ?? [...body].reverse().find((l) => /return\s+(true|false)/.test(l)) ?? null;
            const deps = /\},?\s*\[([^\]]*)\]\s*\)/.exec(body.join("\n"))?.[1]?.trim() ?? "";
            preds.push({ name: n, defined: ev(f, i), list_lookup: look ? look.trim().slice(0, 150) : null, fallback: fb ? fb.trim().slice(0, 150) : null, inputs: deps });
            break;
        }
    }
    const questions: string[] = [];
    const serverText = server.map((s) => s.where).join("\n");
    const serverWide = /ancestor|parentTenant|ParentChain|isSameOrAncestor/i.test(serverText);
    if (serverWide && preds.some((p) => p.list_lookup)) questions.push("The server accepts callers outside the acting tenant (an ancestor or parent), but a UI predicate is derived from a list lookup of the current user. What does the predicate return when the caller is NOT in that list? A caller the server allows must not be hidden the action. See the fallback shown.");
    if (server.some((s) => s.kind === "annotation") && !gates.length) questions.push("The server restricts this action but no UI gate was found: every user is offered an action the server will refuse, and sees the refusal as an error.");
    if (!server.length) questions.push("No server entry point matched server_hint: the UI action may call an endpoint under another name. Do not conclude the gates agree.");
    if (!gates.length) questions.push("No UI gate matched ui_hint: check the hint, or whether the action is offered to everyone.");
    const sCount = new Set(server.filter((s) => s.kind === "check" || s.kind === "annotation").map((s) => s.where.replace(/^.*?:\d+\s+/, "").replace(/\W+/g, "").toLowerCase().slice(0, 40))).size;
    if (sCount > preds.length + gates.length && sCount >= 3) questions.push(`The server applies ${sCount} distinct authorization conditions; the UI applies ${preds.length} predicate(s). List which server conditions the UI does not mirror (they decide who sees an action they cannot use) and which UI conditions the server does not enforce (they are cosmetic).`);
    return { action: o.action, server, ui_gates: gates, predicates: preds, questions, files_scanned: jv.length + ui.length };
}

export function renderGating(r: GatingResult): string {
    const L = [`## UI GATING MATRIX: ${r.action}`, "WHO CAN SEE the action in the UI versus WHO THE SERVER LETS EXECUTE it. Pattern-based and read-only: this lists both sides; you decide whether they agree."];
    L.push("", "### Server (who may execute)");
    if (!r.server.length) L.push("- (no entry point matched)");
    for (const s of r.server.slice(0, 24)) L.push(`- [${s.kind}] ${s.where}`);
    L.push("", "### UI (who is shown the action)");
    if (!r.ui_gates.length) L.push("- (no gate matched)");
    for (const g of r.ui_gates.slice(0, 16)) L.push(`- ${g.where}`);
    if (r.predicates.length) {
        L.push("", "### UI predicates and where their input comes from");
        for (const p of r.predicates) L.push(`- ${p.name}  ${p.defined}\n    inputs: ${p.inputs || "(none found)"}\n    list lookup: ${p.list_lookup ?? "none"}\n    fallback when nothing is found: ${p.fallback ?? "none found"}`);
    }
    L.push("", "### Questions this raises");
    if (!r.questions.length) L.push("- None from the patterns. That does not mean the two sides agree.");
    for (const q of r.questions) L.push(`- ${q}`);
    return L.join("\n");
}

// ── endpoint consumer graph ─────────────────────────────────────────────────

export interface EndpointConsumers {
    endpoint: string; handlers: string[]; wrappers: Array<{ name: string; where: string }>;
    callers: Array<{ service: string; kind: "UI screen" | "UI service" | "other service" | "extension"; where: string; via: string }>; files_scanned: number;
}

export function endpointConsumers(root: string, o: { endpoints: Array<{ method?: string; path: string }> }): EndpointConsumers[] {
    const code = load(root, /\.(java|kt|jsx?|tsx?|mjs|py|vue)$/);
    return o.endpoints.map((ep) => {
        const segs = ep.path.split("/").filter((s) => s && !/^[{:]/.test(s));
        const lit = "/" + segs.join("/");
        // the path must START the URL (after a quote or a ${base}), so '/portal-access/users' (a UI route) is not '/users'
        const BT = String.fromCharCode(96);
        // a gateway prefix (/api, /api/iam) in front of the service path still names this endpoint
        const litRe = new RegExp("(?:['\"" + BT + "]|\\})(?:/api(?:/[a-z-]+)?)?" + esc(lit) + "(?:[/?'\"" + BT + "$]|\\$\\{|$)");
        const CALL = /\.(get|post|put|patch|delete|request)\s*\(|\bfetch\s*\(|\baxios\b|\.uri\(|exchange\(|getFor(Object|Entity)|postFor|@FeignClient|\bhttp\w*\(/i;
        // callers usually name the URL through a constant (API_ENDPOINTS.IAM.USERS = '/api/iam/users'): resolve the constant names first
        const keys = new Set<string>();
        for (const f of code) if (/endpoint|constants?|urls?|api\.?config/i.test(path.basename(f.rel))) for (const l of f.lines) { const m = /^\s*['"]?([A-Za-z_]\w{3,})['"]?\s*:\s*['"`]/.exec(l); if (m && litRe.test(l) && !COMMENT.test(l) && !/^(LIST|CREATE|GET|ALL|BASE|URL|PATH|INDEX|UPDATE|DELETE|ROOT|VIEW|EDIT|SEARCH)$/i.test(m[1])) keys.add(m[1]); }
        const keyRe = keys.size ? new RegExp("(?:\\.|\\?\\.)(?:" + [...keys].map(esc).join("|") + ")\\b") : null;
        const handlers: string[] = [];
        const callers: EndpointConsumers["callers"] = [];
        const wrappers: EndpointConsumers["wrappers"] = [];
        const kindOf = (rel: string): EndpointConsumers["callers"][0]["kind"] => /snf-browser-extn|extension/i.test(rel) ? "extension" : /\/(modules|components|pages|views|screens)\//.test(rel) ? "UI screen" : /\.(jsx?|tsx?|vue|mjs)$/.test(rel) ? "UI service" : "other service";
        for (const f of code) {
            for (let i = 0; i < f.lines.length; i++) {
                const l = f.lines[i];
                if (COMMENT.test(l)) continue;
                if (/\.(java|kt)$/.test(f.rel) && /@(Get|Post|Put|Delete|Patch)Mapping/.test(l) && (ep.method ? new RegExp(ep.method, "i").test(l) : true)) {
                    // handler path = class-level prefix + method path; match on the last static segment
                    const last = segs[segs.length - 1];
                    const prefix = f.lines.slice(0, i).reverse().find((x) => /@RequestMapping/.test(x)) ?? "";
                    if ((last && (l.includes(`"/${last}"`) || l.includes(`"${last}"`))) || (segs.length === 1 && prefix.includes(`/${segs[0]}`) && /Mapping(\(\s*\)|\s*$|\(\s*"\/?"\s*\))/.test(l))) handlers.push(ev(f, i));
                    continue;
                }
                if ((litRe.test(l) || (keyRe && keyRe.test(l))) && !/@(Get|Post|Put|Delete|Patch|Request)Mapping/.test(l) && !/^\s*import\b/.test(l) && !/routes?\.config|Sidebar|Header/i.test(f.rel) && CALL.test(f.lines.slice(Math.max(0, i - 2), i + 2).join(" "))) {
                    // another HTTP verb on this URL is a different endpoint (POST /users is not GET /users)
                    const win = f.lines.slice(Math.max(0, i - 2), i + 3).join(" ");
                    if (ep.method && /\.(jsx?|tsx?|mjs|vue)$/.test(f.rel) && /\.(post|put|delete|patch|get)\s*\(/i.test(win) && !new RegExp(`\\.${ep.method.toLowerCase()}\\s*\\(|method\\s*:\\s*['"]${ep.method}`, "i").test(win)) continue;
                    if (ep.method && /get/i.test(ep.method) && /\/\$\{\w+\}|\/\$\{[^}]+\}\s*[`'"]?\s*,?\s*$/.test(l) && !/\.get\(/.test(l)) continue;
                    // the function that holds the URL: the nearest enclosing definition above (getUsers: async () => {  /  export const getUsers = ...  /  async getUsers() {)
                    let wn: string | null = null;
                    for (let k = i; k >= Math.max(0, i - 6) && !wn; k--) {
                        const d = /^\s*(?:async\s+)?(\w+)\s*:\s*(?:async\s*)?(?:\(|function)|^\s*(?:export\s+)?(?:async\s+)?(?:const|function)\s+(\w+)\s*(?:=\s*(?:async\s*)?(?:\(|function)|\()|^\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/.exec(f.lines[k]);
                        const cand = d ? (d[1] ?? d[2] ?? d[3]) : null;
                        if (cand && !["if", "for", "while", "return", "get", "post", "put", "delete", "try", "catch", "switch", "response", "res", "data", "result"].includes(cand)) wn = cand;
                    }
                    callers.push({ service: f.service, kind: kindOf(f.rel), where: ev(f, i), via: litRe.test(l) ? "direct URL" : "URL constant" });
                    if (wn && !["if", "for", "while", "return", "get", "post", "put", "delete"].includes(wn)) wrappers.push({ name: wn, where: ev(f, i) });
                }
            }
        }
        // one hop: who calls each wrapper
        const seen = new Set<string>();
        for (const w of wrappers) {
            if (seen.has(w.name)) continue; seen.add(w.name);
            const re = new RegExp(`(?:\\.|\\b)${esc(w.name)}\\s*\\(`);
            for (const f of code) {
                if (!/\.(jsx?|tsx?|vue|mjs)$/.test(f.rel)) continue;
                for (let i = 0; i < f.lines.length; i++) {
                    if (COMMENT.test(f.lines[i]) || !re.test(f.lines[i]) || f.lines[i].includes(w.where.split("  ")[0].split(":")[0]) && /(const|function)\s/.test(f.lines[i])) continue;
                    if (f.rel === w.where.split(":")[0] && /(const|function|:\s*(async\s*)?\()/.test(f.lines[i])) continue;
                    callers.push({ service: f.service, kind: kindOf(f.rel), where: ev(f, i), via: `wrapper ${w.name}()` });
                }
            }
        }
        const uniq = new Map(callers.map((c) => [c.where, c]));
        return { endpoint: `${ep.method ? ep.method.toUpperCase() + " " : ""}${ep.path}`, handlers, wrappers, callers: [...uniq.values()], files_scanned: code.length };
    });
}

export function renderEndpointConsumers(rs: EndpointConsumers[]): string {
    const L = ["## ENDPOINT CONSUMER GRAPH", "Every caller of a changed endpoint: UI screens, other services, the browser extension, and the wrappers between them. A caller is not a defect: each one assumed a response (who is in it, what it contains), and the change alters that assumption. Pattern-based and read-only; a caller built from a variable URL is invisible."];
    for (const r of rs) {
        L.push("", `### ${r.endpoint}`);
        L.push(`Handlers: ${r.handlers.length ? "" : "(none matched)"}`); for (const h of r.handlers.slice(0, 5)) L.push(`- ${h}`);
        const by = new Map<string, number>(); for (const c of r.callers) by.set(`${c.service} ${c.kind}`, (by.get(`${c.service} ${c.kind}`) ?? 0) + 1);
        L.push(`Callers: ${r.callers.length}${r.callers.length ? " (" + [...by].map(([k, n]) => `${k} x${n}`).join(", ") + ")" : ""}`);
        for (const c of r.callers.slice(0, 20)) L.push(`- [${c.kind}] ${c.where}   via ${c.via}`);
        if (r.callers.length > 20) L.push(`- ...and ${r.callers.length - 20} more`);
        if (r.callers.filter((c) => c.kind === "UI screen").length) L.push("ask: for each screen, what happens when the response now contains a record it did not contain before, or lacks one it did (counts, dropdowns, selection lists, exports)?");
        if (r.callers.some((c) => c.kind === "other service" || c.kind === "extension")) L.push("ask: for each non-UI caller, does it depend on the old contents or shape of the response?");
        if (!r.callers.length) L.push("No caller found. Say so; do not assume there is none (variable URLs, gateways and generated clients are invisible here).");
    }
    return L.join("\n");
}

// ── service ownership ───────────────────────────────────────────────────────

export interface OwnershipResult {
    entity: string; tables: Array<{ table: string; mapped_in: string[]; migrations_in: string[]; owner: string | null }>;
    writers: Array<{ service: string; where: string; kind: "save" | "delete" | "setter" }>; cross_service_writers: string[]; files_scanned: number;
}

export function serviceOwnership(root: string, o: { entities: string[] }): OwnershipResult[] {
    const jv = load(root, /\.(java|kt)$/);
    const sql = load(root, /\.sql$/, { tests: true });
    return o.entities.map((entity) => {
        const tableMap = new Map<string, Set<string>>();
        for (const f of jv) {
            const text = f.lines.join("\n");
            if (!new RegExp(`class\\s+${esc(entity)}\\b`).test(text) || !/@Entity/.test(text)) continue;
            const m = /@Table\s*\(\s*(?:[^)]*?)name\s*=\s*"(\w+)"/.exec(text);
            const t = m ? m[1] : entity.toLowerCase() + "s";
            tableMap.set(t, (tableMap.get(t) ?? new Set()).add(f.service));
        }
        const tables = [...tableMap].map(([table, mapped]) => {
            const mig = new Map<string, number>();
            for (const f of sql) {
                const re = new RegExp(`(CREATE\\s+TABLE(?:\\s+IF\\s+NOT\\s+EXISTS)?\\s+(?:public\\.)?"?${esc(table)}"?\\b|ALTER\\s+TABLE(?:\\s+ONLY)?\\s+(?:public\\.)?"?${esc(table)}"?\\b)`, "i");
                if (f.lines.some((l) => re.test(l)) && /(db\/migration|migrations?|flyway|liquibase|V\d+__)/i.test(f.rel)) mig.set(f.service, (mig.get(f.service) ?? 0) + 1);
            }
            const migrations_in = [...mig.keys()];
            const owner = migrations_in.length === 1 ? migrations_in[0] : [...mig].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
            return { table, mapped_in: [...mapped].sort(), migrations_in, owner };
        });
        const repo = new RegExp(`\\b${entity.charAt(0).toLowerCase() + entity.slice(1)}(?:Repository|Repo|Dao)\\.(save|saveAll|saveAndFlush|delete\\w*|update\\w*)\\(`);
        const writers: OwnershipResult["writers"] = [];
        for (const f of jv) for (let i = 0; i < f.lines.length; i++) {
            const l = f.lines[i];
            if (COMMENT.test(l)) continue;
            const m = repo.exec(l);
            if (m) writers.push({ service: f.service, where: ev(f, i), kind: /^delete/.test(m[1]) ? "delete" : "save" });
        }
        const owners = new Set(tables.map((t) => t.owner).filter(Boolean) as string[]);
        const writerServices = [...new Set(writers.map((w) => w.service))];
        const cross = owners.size ? writerServices.filter((s) => !owners.has(s)) : [];
        return { entity, tables, writers, cross_service_writers: cross, files_scanned: jv.length + sql.length };
    });
}

export function renderOwnership(rs: OwnershipResult[]): string {
    const L = ["## SERVICE OWNERSHIP MODEL", "Which service owns each table (the one that migrates it) and which services map and WRITE it. A write from a service that does not own the table silently assumes a shared database and the owner's schema, constraints and rules. Pattern-based and read-only."];
    for (const r of rs) {
        L.push("", `### ${r.entity}`);
        if (!r.tables.length) L.push("No @Entity class found for this name.");
        for (const t of r.tables) L.push(`- table ${t.table}: mapped in ${t.mapped_in.join(", ") || "(none)"}; migrations in ${t.migrations_in.join(", ") || "(none found)"}; owner ${t.owner ?? "UNKNOWN"}`);
        const ws = new Map<string, number>(); for (const w of r.writers) ws.set(w.service, (ws.get(w.service) ?? 0) + 1);
        L.push(`Writers via repository: ${[...ws].map(([s, n]) => `${s} x${n}`).join(", ") || "none found"}`);
        for (const s of r.cross_service_writers) {
            L.push(`- CROSS-SERVICE WRITE from ${s} (does not own the table):`);
            for (const w of r.writers.filter((x) => x.service === s).slice(0, 5)) L.push(`    [${w.kind}] ${w.where}`);
        }
        if (r.cross_service_writers.length) L.push("ask: does this service run against the same database in every environment? Whose migration, constraint and validation rules apply to this write? What happens if the owning service changes the schema or the rule?");
        else if (r.tables.some((t) => t.mapped_in.length > 1)) L.push("The table is mapped in several services but no non-owner write was found. Say so; the mapping alone already assumes a shared database.");
    }
    return L.join("\n");
}

// ── parent cascade / deprovision ────────────────────────────────────────────

export interface CascadePath { service: string; where: string; method: string; child: string; via: string; mentions_guard: boolean | null }
export interface CascadeResult { parent: string; transitions: Array<{ where: string; method: string }>; paths: CascadePath[]; db_cascades: string[]; files_scanned: number }

export function parentCascade(root: string, o: { parent: string; children: string[]; guard_terms?: string[] }): CascadeResult {
    const jv = load(root, /\.(java|kt)$/);
    const sql = load(root, /\.sql$/, { tests: true });
    const guard = (o.guard_terms ?? []).map((g) => g.toLowerCase());
    const NAME = new RegExp(`(delete|remove|deprovision|offboard|terminate|purge|decommission|destroy|deactivate|suspend|cleanup|cascade)\\w*${esc(o.parent)}|${esc(o.parent.toLowerCase())}\\w*(delete|remove|deprovision|offboard|terminate|purge|decommission)|(deprovision|offboard|terminate|decommission)`, "i");
    const transitions: CascadeResult["transitions"] = [];
    const paths: CascadePath[] = [];
    for (const f of jv) {
        for (let i = 0; i < f.lines.length; i++) {
            const m = /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|protected|private|static|final|synchronized)\s+)*[\w<>\[\],.? ]+?\s+(\w+)\s*\((?:[^;]*\)\s*(?:throws\s+[\w.,\s]+)?\{?)?\s*$/.exec(f.lines[i]);
            if (!m || !NAME.test(m[1]) || /^(get|is|find|set)/i.test(m[1])) continue;
            transitions.push({ where: ev(f, i), method: m[1] });
            const end = block(f.lines, i, 220);
            for (let k = i; k <= end; k++) {
                const l = f.lines[k];
                if (COMMENT.test(l)) continue;
                for (const c of o.children) {
                    const lc = c.charAt(0).toLowerCase() + c.slice(1);
                    let via: string | null = null;
                    if (new RegExp(`\\b${lc}(?:Repository|Repo|Dao)\\.(delete\\w*|remove\\w*)\\(`).test(l)) via = "repository delete (bypasses the service method)";
                    else if (new RegExp(`\\b${lc}Service\\.(delete\\w*|remove\\w*)\\(`).test(l)) via = "service delete (goes through the service)";
                    else if (new RegExp(`DELETE\\s+FROM\\s+\\w*${esc(c.toLowerCase())}`, "i").test(l)) via = "raw SQL delete";
                    else if (new RegExp(`\\b(kc\\w*|keycloak\\w*)\\.(removeUser|deleteUser|deleteRealm|removeRealm)\\(`, "i").test(l) && /user/i.test(c)) via = "identity-provider removal";
                    if (via) {
                        const body = f.lines.slice(i, end + 1).join("\n").toLowerCase();
                        paths.push({ service: f.service, where: ev(f, k), method: m[1], child: c, via, mentions_guard: guard.length ? guard.some((g) => body.includes(g)) : null });
                    }
                }
            }
        }
    }
    const db_cascades: string[] = [];
    for (const f of sql) for (let i = 0; i < f.lines.length; i++) if (/ON\s+DELETE\s+CASCADE/i.test(f.lines[i]) && o.children.some((c) => new RegExp(esc(c.toLowerCase()), "i").test(f.lines.slice(Math.max(0, i - 3), i + 1).join(" ")))) db_cascades.push(ev(f, i));
    for (const f of jv) for (let i = 0; i < f.lines.length; i++) if (/(CascadeType\.(REMOVE|ALL)|orphanRemoval\s*=\s*true|@OnDelete)/.test(f.lines[i]) && o.children.some((c) => new RegExp(`\\b${esc(c)}\\b`).test(f.lines.slice(i, i + 4).join(" ")))) db_cascades.push(ev(f, i));
    return { parent: o.parent, transitions, paths, db_cascades: [...new Set(db_cascades)].slice(0, 20), files_scanned: jv.length + sql.length };
}

export function renderCascade(r: CascadeResult, guards: string[]): string {
    const L = [`## PARENT CASCADE: what happens to the children when a ${r.parent} goes away`, "A guard on the child's own delete method protects nothing when the parent's lifecycle removes children another way. Pattern-based and read-only."];
    L.push("", `### ${r.parent} transitions that can remove or retire it (${r.transitions.length})`);
    if (!r.transitions.length) L.push("- None found by name. Say so; deprovisioning may live in another service, a job or a database cascade.");
    for (const t of r.transitions.slice(0, 15)) L.push(`- ${t.where}`);
    L.push("", "### Child removals reached from those transitions");
    if (!r.paths.length) L.push("- None found.");
    for (const p of r.paths.slice(0, 20)) L.push(`- ${p.child} via ${p.via}\n    ${p.where}   (in ${p.method})${p.mentions_guard === null ? "" : p.mentions_guard ? "   mentions the guard" : `   DOES NOT MENTION ${guards.join("/")}: the child guard is not on this path`}`);
    L.push("", "### Database and mapping cascades");
    if (!r.db_cascades.length) L.push("- None found.");
    for (const c of r.db_cascades) L.push(`- ${c}   (the database removes children without running any service guard)`);
    L.push("", "ask: if the parent is deleted or deprovisioned, what happens to a child the guard protects (the owner, the last administrator)? Is the parent action itself guarded, and by what?");
    return L.join("\n");
}
