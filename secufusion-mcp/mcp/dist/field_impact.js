/**
 * Field impact model: for a field, who reads it, who writes it, and what each consumer does with it.
 *
 *   FIELD -> CONSUMERS (service, file:line) -> CAPABILITY (authority decision, API contract, UI, persistence, event, audit, report)
 *         -> the question that turns a dependency into a business consequence.
 *
 * A dependency is not a finding. A finding needs the consequence ("operators lose platform access"), and the consequence has
 * to be argued from what the consumer DOES with the value. This tool lists the consumers and classifies how each uses the
 * field; it never writes the consequence. Pattern-based and READ-ONLY.
 */
import fs from "fs";
import path from "path";
import { variantsOf } from "./invariant_enforcement.js";
const CODE = /\.(java|kt|ts|tsx|js|jsx|mjs|py|cs|go|sql|xml|ya?ml)$/;
const SKIP_DIR = new Set(["node_modules", "dist", "build", "target", ".git", ".idea", ".vscode", "coverage", ".secufusion", ".mcp", "out", "bin"]);
const TEST = /(^|\/)(src\/test|__tests__|tests?|spec)\/|\.(test|spec)\.[jt]sx?$|(Test|Tests|IT)\.(java|kt)$/;
const COMMENT = /^\s*(\*|\/\/|\/\*|#|--|<!--)/;
const LOG = /\blog(ger)?\.|console\./i;
const DTO_SET = /\b\w*(dto|Dto|response|Response|request|Request|payload|builder|Builder)\w*\s*\.\s*set/;
const AUTH_FILE = /(Authoriz|Guard|Filter|Interceptor|Security|Auth\w*Service|Permission|Access)/;
const DECISION = /\b(if|while|filter|anyMatch|allMatch|noneMatch|orElseThrow|isPresent|isEmpty|\.equals|&&|\|\||\?)\b|\bif\s*\(|&&|\|\||\?\s|!\w/;
function capabilityOf(rel, line, decision) {
    if (/\.(sql|xml|ya?ml)$/.test(rel) || /(Repository|Entity|\/entity\/|\/repository\/|migration)/.test(rel))
        return "PERSISTENCE";
    if (AUTH_FILE.test(path.basename(rel)) || (decision && /(hasAuthority|hasRole|isPlatformAdmin|isAdmin|authoriz|PreAuthorize|permission)/i.test(line)))
        return "AUTHORITY";
    if (/\.(tsx|jsx)$/.test(rel) || /\/(src\/)?(modules|components|pages|views)\//.test(rel))
        return "UI";
    if (/(Controller|Dto|DTO|Request|Response|Resource)\w*\.(java|kt|ts)$/.test(rel) || /\/(controller|dto)\//.test(rel))
        return "API";
    if (/(Event|Kafka|Listener|Publisher|Producer|Consumer|Message)/.test(path.basename(rel)))
        return "EVENT";
    if (/(Audit|History)/.test(path.basename(rel)) || /\b(createdAt|createdBy|updatedAt|updatedBy|lastUpdatedBy)\b/.test(line))
        return "AUDIT";
    if (/(Report|Export|Dashboard|Summary|Analytics|Metric)/.test(path.basename(rel)))
        return "REPORT";
    return "LOGIC";
}
function walk(dir, out, budget) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (budget.n <= 0)
            return;
        if (e.isDirectory()) {
            if (!SKIP_DIR.has(e.name) && !e.name.startsWith("."))
                walk(path.join(dir, e.name), out, budget);
        }
        else if (CODE.test(e.name)) {
            out.push(path.join(dir, e.name));
            budget.n--;
        }
    }
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function mapFieldImpact(root, opts) {
    const files = [];
    walk(root, files, { n: 9000 });
    const max = opts.max_per_field ?? 400;
    const out = opts.fields.map((field) => {
        // "tenant.email" is an entity attribute: it is read as tenant.getEmail(), tenant.email, tenantEmail, getTenantEmail, tenant_email
        const dot = /^(\w+)\.(\w+)$/.exec(field);
        const cap1 = (s) => s.charAt(0).toUpperCase() + s.slice(1);
        const dotted = dot ? [`${dot[1]}.get${cap1(dot[2])}`, `${dot[1]}.set${cap1(dot[2])}`, `${dot[1]}.${dot[2]}`, `${dot[1]}${cap1(dot[2])}`, `get${cap1(dot[1])}${cap1(dot[2])}`, `${dot[1]}_${dot[2]}`] : [];
        const variants = [...new Set(dot ? dotted : [field, ...variantsOf(field)])].filter((v) => v.length >= 3);
        return { field, variants, consumers: [], total: 0, by_service: {}, by_capability: {}, writers: 0, truncated: false };
    });
    const res = out.map((f) => ({ f, re: new RegExp(`(?<![A-Za-z0-9_])(?:[a-z]+)?(?:${f.variants.map(esc).join("|")})(?![a-z0-9])`, "i"), set: new RegExp(`\\.set${esc((f.field.includes(".") ? f.field.split(".")[1] : f.field).charAt(0).toUpperCase() + (f.field.includes(".") ? f.field.split(".")[1] : f.field).slice(1))}\\s*\\(|(^|[\\s.(,])(${f.variants.map(esc).join("|")})\\s*=(?!=)|\\bSET\\b[^;]*\\b(${f.variants.map(esc).join("|")})\\b`, "i") }));
    for (const abs of files) {
        const rel = path.relative(root, abs).split(path.sep).join("/");
        if (TEST.test(rel))
            continue;
        if (opts.file_filter?.length && !opts.file_filter.some((x) => path.basename(rel).toLowerCase().includes(x.toLowerCase())))
            continue;
        let text;
        try {
            if (fs.statSync(abs).size > 600_000)
                continue;
            text = fs.readFileSync(abs, "utf-8");
        }
        catch {
            continue;
        }
        const lowered = text.toLowerCase();
        if (!res.some(({ f }) => f.variants.some((v) => lowered.includes(v.toLowerCase()))))
            continue;
        const service = rel.includes("/") ? rel.split("/")[0] : "(root)";
        const lines = text.split(/\r?\n/);
        for (const { f, re, set } of res) {
            for (let i = 0; i < lines.length; i++) {
                const l = lines[i];
                if (!re.test(l) || COMMENT.test(l) || LOG.test(l))
                    continue;
                if (/^\s*(import|package)\b/.test(l))
                    continue;
                f.total++;
                f.by_service[service] = (f.by_service[service] ?? 0) + 1;
                const kind = set.test(l) && !DTO_SET.test(l) ? "write" : "read";
                const decision = kind === "read" && DECISION.test(l);
                const cap = capabilityOf(rel, l, decision);
                f.by_capability[cap] = (f.by_capability[cap] ?? 0) + 1;
                if (kind === "write")
                    f.writers++;
                // one hop of derivation: `String tenantDomain = extractDomain(tenant.getEmail());` makes tenantDomain a value that changes when the field changes
                let derived;
                const asg = kind === "read" ? /^\s*(?:final\s+)?(?:[\w<>\[\]?,.]+\s+)?(\w+)\s*=\s*(?:(\w[\w.]*)\()?.*$/.exec(l) : null;
                if (asg && !/^(if|for|while|return|else)$/.test(asg[1]) && /=/.test(l) && !/==/.test(l.split("=")[0] + "=")) {
                    const uses = [];
                    for (let k = i + 1; k < Math.min(lines.length, i + 45) && uses.length < 4; k++) {
                        if (COMMENT.test(lines[k]) || !new RegExp(`(?<![A-Za-z0-9_])${esc(asg[1])}(?![A-Za-z0-9_])`).test(lines[k]))
                            continue;
                        uses.push({ line: k + 1, text: lines[k].trim().slice(0, 140), decision: DECISION.test(lines[k]) });
                    }
                    if (uses.length)
                        derived = { name: asg[1], via: asg[2] ?? "assignment", uses };
                }
                if (f.consumers.length < max)
                    f.consumers.push({ service, file: rel, line: i + 1, text: l.trim().slice(0, 150), capability: cap, kind, decision, derived });
                else
                    f.truncated = true;
            }
        }
    }
    return { fields: out, files_scanned: files.length };
}
const CONSEQUENCE_QUESTION = {
    AUTHORITY: "who gains or loses the right to act when this value changes (or is missing, or duplicated)? Which operators lose which access?",
    API: "what do API callers and other services receive or send when this value changes? Which contract do they assume?",
    UI: "what does the user see and what can they do after this value changes, or after the operation that changes it fails?",
    PERSISTENCE: "which rows hold this value, can two rows disagree, and what do existing rows contain?",
    EVENT: "who is told when this value changes, and who is not?",
    AUDIT: "is history preserved when this value changes, and can support explain who changed what, when?",
    REPORT: "what do reports, exports and dashboards show for old and new values?",
    LOGIC: "what branch does this value select, and what happens on the other branch?",
};
export function renderFieldImpact(r, perCap = 4) {
    const L = [];
    L.push("## FIELD IMPACT MODEL", "FIELD -> CONSUMERS -> CAPABILITY -> the question that turns a dependency into a business consequence. A dependency is not a finding: the consequence has to be argued from what each consumer does with the value.", `Scanned ${r.files_scanned} files. Pattern-based and read-only; a missing hit is not proof of absence.`);
    for (const f of r.fields) {
        L.push("", `### ${f.field}  (variants: ${f.variants.join(", ")})`);
        if (!f.total) {
            L.push("No consumers found in the scanned code. Say so; do not assume it is unused (it may be reached by reflection, SQL, a UI binding or another repository).");
            continue;
        }
        const svc = Object.entries(f.by_service).sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s} ${n}`).join(", ");
        if (f.total > 400)
            L.push(`WARNING: ${f.total} references: the field name is too generic to say anything. Narrow it with file_filter (for example ['User']) or name a more specific field; the list below is a sample, not a consumer inventory.`);
        L.push(`${f.total} reference(s) in ${Object.keys(f.by_service).length} service(s): ${svc}; ${f.writers} write(s).${f.truncated ? " (list truncated)" : ""}`);
        const caps = Object.keys(f.by_capability);
        caps.sort((a, b) => (a === "AUTHORITY" ? -1 : b === "AUTHORITY" ? 1 : (f.by_capability[b] ?? 0) - (f.by_capability[a] ?? 0)));
        for (const cap of caps) {
            const cs = f.consumers.filter((c) => c.capability === cap);
            const dec = cs.filter((c) => c.decision);
            L.push(`- ${cap}: ${f.by_capability[cap]} reference(s)${dec.length ? `, ${dec.length} inside a decision` : ""}`);
            const show = [...dec, ...cs.filter((c) => !c.decision)].filter((c, i, a) => a.findIndex((x) => x.file === c.file && x.kind === c.kind) === i).slice(0, perCap);
            for (const c of show) {
                L.push(`    ${c.service}  ${c.file.split("/").slice(-1)[0]}:${c.line}  ${c.kind === "write" ? "[WRITE] " : ""}${c.text}`);
                if (c.derived) {
                    L.push(`      DERIVED VALUE ${c.derived.name} (via ${c.derived.via}) changes when ${f.field} changes; it is used at:`);
                    for (const u of c.derived.uses)
                        L.push(`        :${u.line}  ${u.decision ? "[DECISION] " : ""}${u.text}`);
                }
            }
            if (show.some((c) => c.derived?.uses.some((u) => u.decision)))
                L.push("    consequence: a derived value that feeds a decision means the decision changes when the field does, for every actor the decision applies to. Name who is allowed or refused differently after the change.");
            L.push(`    ask: ${CONSEQUENCE_QUESTION[cap]}`);
        }
    }
    return L.join("\n");
}
