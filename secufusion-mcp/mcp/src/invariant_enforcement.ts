/**
 * Invariant Enforcement Map: how is the field behind an invariant actually protected?
 *
 * "Exactly one IT Admin per tenant" is only as strong as whatever enforces it. For a field this finds every place the
 * workspace WRITES it, any database constraint on it (unique, partial unique, check, exclude), any lock or version guard in
 * the writing METHOD, whether that method reads the field first (check-then-act), and whether a concurrency test exists.
 * It rates the result:
 *   DB_ENFORCED      a unique / partial unique / check / exclude constraint backs the field
 *   LOCK_PROTECTED   every write sits in a method that takes a lock or version guard
 *   CHECK_THEN_ACT   a write reads the field shortly before, with no lock in the method and no constraint: two actors can both pass the check
 *   CODE_ONLY        writes exist with no constraint, no lock in the method and no preceding read of the field
 *   NO_WRITES_FOUND  the field is never written in the scanned code
 * A weakly enforced invariant is a zombie-state risk (two owners, zero owners, orphans). It is evidence, not a verdict: the
 * reviewer compares the rating with what the invariant needs. Pattern-based and READ-ONLY. Lock detection is per method: a
 * write in a helper that a locked method calls is reported as unprotected, so check the callers.
 */
import fs from "fs";
import path from "path";

export type Strength = "DB_ENFORCED" | "LOCK_PROTECTED" | "CHECK_THEN_ACT" | "CODE_ONLY" | "NO_WRITES_FOUND";
export interface Hit { file: string; line: number; text: string }
export interface FieldEnforcement {
    field: string; variants: string[]; strength: Strength; reasons: string[];
    writes: Hit[]; write_count: number; db: Array<Hit & { kind: string }>; weak_db: Hit[]; locks: Hit[];
    unprotected_writes: Hit[]; unprotected_write_files: string[]; check_then_act: Hit[]; concurrency_tests: string[];
}
export interface EnforcementReport { root: string; fields: FieldEnforcement[]; files_scanned: number; truncated: boolean; notes: string[] }

const CODE = /\.(java|kt|scala|groovy|jsx?|tsx?|mjs|py|go|cs|rb|php|sql|xml|ya?ml)$/;
const JS_LIKE = /\.(jsx?|tsx?|mjs|py)$/;
const DB_FILE = /\.(sql|xml|ya?ml)$/;
const SKIP_DIR = new Set(["node_modules", "dist", "build", "target", ".git", ".idea", ".vscode", "coverage", ".secufusion", ".mcp", "out", "bin"]);
const TEST = /(^|\/)(src\/test|__tests__|tests?|spec)\/|\.(test|spec)\.[jt]sx?$|(Test|Tests|IT)\.(java|kt)$/;
// real lock usage, not a mention: case-sensitive tokens, and never an import, package or comment line
const LOCK = /(PESSIMISTIC_(WRITE|READ|FORCE_INCREMENT)|@Lock\b|\bFOR UPDATE\b|\bFOR SHARE\b|\bSKIP LOCKED\b|@Version\b|@OptimisticLock|\bLockModeType\b|\bReentrantLock\b|\bpg_(try_)?advisory\w*|Isolation\.SERIALIZABLE|\b\w+ForUpdate\w*\(|\block_timeout\b|\bsynchronized\s*\(|\bsynchronized\s+(void|public|private|static|[A-Z])|\.lock\(\))/;
const DB_KIND: Array<[string, RegExp]> = [
    ["UNIQUE", /(\bUNIQUE\b|\bCREATE UNIQUE INDEX\b|unique\s*=\s*true|@UniqueConstraint|uniqueConstraints|\bEXCLUDE\b)/i],
    ["CHECK", /(\bCHECK\s*\(|@Check\b)/i],
];
const WEAK_DB = /(\bNOT NULL\b|\bnullable\s*=\s*false\b|\bFOREIGN KEY\b|\bREFERENCES\b|\bPRIMARY KEY\b)/i;
const CONCURRENCY_TEST = /(ExecutorService|CountDownLatch|CyclicBarrier|CompletableFuture|\bparallel\b|\bThread\b|\bRunnable\b|concurrent|\brace\b|simultaneous|@RepeatedTest|Promise\.all)/i;
const NON_ENTITY_RECEIVER = /(dto|request|response|req|resp|view|model|json|payload|event)$/i;
const COMMENT = /^\s*(\/\/|\*|\/\*|#|--|import\s|package\s)/;
const CONTROL = /^\s*(if|for|while|switch|catch|else|return|new|throw|try|do)\b/;
const DECL = /^\s*(?:(?:public|protected|private|static|final|synchronized|abstract|default|async)\s+)*(?:<[^>]+>\s+)?(?:[\w.<>\[\],?]+\s+)+\w+\s*\([^;]*\)?[^;{]*\{\s*$|^\s*(?:export\s+)?(?:async\s+)?function\s+\w+/;
const MAX_FILES = 20000, MAX_BYTES = 1_000_000;

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const toSnake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
const toCamel = (s: string) => s.replace(/[_-]+([a-z0-9])/gi, (_m, c: string) => c.toUpperCase()).replace(/^./, (c) => c.toLowerCase());
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function variantsOf(field: string): string[] {
    const camel = toCamel(field.trim()), snake = toSnake(camel);
    return [...new Set([camel, snake])];
}

function walk(dir: string, out: string[], budget: { n: number }) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (budget.n <= 0) return;
        if (e.isDirectory()) { if (!SKIP_DIR.has(e.name) && !e.name.startsWith(".")) walk(path.join(dir, e.name), out, budget); }
        else if (CODE.test(e.name)) { out.push(path.join(dir, e.name)); budget.n--; }
    }
}

/** the method around line i: from the nearest declaration above to the next declaration below */
function methodRange(lines: string[], i: number): [number, number] {
    let s = i;
    while (s > 0 && i - s < 150 && !(DECL.test(lines[s]) && !CONTROL.test(lines[s]))) s--;
    let e = i + 1;
    while (e < lines.length - 1 && e - i < 150 && !(DECL.test(lines[e]) && !CONTROL.test(lines[e]))) e++;
    return [s, e];
}

const nameOf = (declLine: string): string | null => /(\w+)\s*\(/.exec(declLine)?.[1] ?? null;
const lockLineIn = (lines: string[], s: number, e: number): number => { for (let k = s; k < e; k++) if (!COMMENT.test(lines[k]) && LOCK.test(lines[k])) return k; return -1; };

/** methods of this file that take a lock themselves (name, evidence line): a caller that invokes one is protected */
function helpersOf(lines: string[]): Map<string, { line: number; text: string }> {
    const out = new Map<string, { line: number; text: string }>();
    lines.forEach((l, i) => {
        if (COMMENT.test(l) || !LOCK.test(l)) return;
        const [s] = methodRange(lines, i);
        const n = nameOf(lines[s]);
        if (n && !out.has(n)) out.set(n, { line: i + 1, text: l.trim().slice(0, 160) });
    });
    return out;
}

/**
 * Is the write on line i protected? Yes if its method takes a lock itself, or calls a lock-taking helper of the same file,
 * or (for a helper) every caller in the file is protected in one of those ways. Returns the evidence, or null.
 */
function protection(lines: string[], i: number, helpers: Map<string, { line: number; text: string }>, depthLeft = 2): { line: number; text: string } | null {
    const [s, e] = methodRange(lines, i);
    const direct = lockLineIn(lines, s, e);
    if (direct >= 0) return { line: direct + 1, text: lines[direct].trim().slice(0, 160) };
    const self = nameOf(lines[s]);
    for (const [n, ev] of helpers) {
        if (n === self) continue;
        for (let k = s + 1; k < e; k++) if (!COMMENT.test(lines[k]) && new RegExp(`\\b${esc(n)}\\s*\\(`).test(lines[k])) return { line: ev.line, text: `via ${n}(): ${ev.text}` };
    }
    // a helper whose callers are all protected
    if (self && depthLeft > 0) {
        const callers: number[] = [];
        lines.forEach((l, k) => { if (k !== s && !COMMENT.test(l) && !DECL.test(l) && new RegExp(`\\b${esc(self)}\\s*\\(`).test(l)) callers.push(k); });
        if (callers.length) {
            const ps = callers.map((k) => protection(lines, k, helpers, depthLeft - 1));
            if (ps.every(Boolean)) return { line: ps[0]!.line, text: `via the caller of ${self}(): ${ps[0]!.text}` };
        }
    }
    return null;
}

export function mapInvariantEnforcement(workspaceRoot: string, opts: { fields: string[]; max_hits?: number }): EnforcementReport {
    const root = path.resolve(workspaceRoot);
    const maxHits = opts.max_hits ?? 6;
    const files: string[] = []; const budget = { n: MAX_FILES }; walk(root, files, budget);
    const rep: EnforcementReport = { root, fields: [], files_scanned: 0, truncated: budget.n <= 0, notes: [] };

    const texts = new Map<string, string[]>();
    for (const f of files) {
        try { if (fs.statSync(f).size > MAX_BYTES) continue; texts.set(path.relative(root, f).split(path.sep).join("/"), fs.readFileSync(f, "utf-8").split(/\r?\n/)); rep.files_scanned++; } catch { /* unreadable */ }
    }

    for (const field of opts.fields.map((x) => x.trim()).filter(Boolean)) {
        const variants = variantsOf(field);
        const camel = variants[0];
        const mention = new RegExp(variants.map(esc).join("|"), "i");
        const setter = new RegExp(`([A-Za-z_][\\w]*)\\.set${esc(cap(camel))}\\(`);
        const jsAssign = new RegExp(`([A-Za-z_][\\w]*)\\.${esc(camel)}\\s*=[^=]`);
        const sqlSet = new RegExp(`\\bSET\\b[^;]*\\b(${variants.map(esc).join("|")})\\s*=`, "i");
        const isWrite = (l: string, rel: string): boolean => {
            if (DB_FILE.test(rel)) return false;
            const s = setter.exec(l);
            if (s && !NON_ENTITY_RECEIVER.test(s[1])) return true;
            if (JS_LIKE.test(rel)) { const a = jsAssign.exec(l); if (a && !NON_ENTITY_RECEIVER.test(a[1])) return true; }
            return sqlSet.test(l);
        };
        // a read: any non-write mention of the field (getter, finder such as countByX, property access) that is not a comment or a log line
        const isRead = (b: string, rel: string) => mention.test(b) && !COMMENT.test(b) && !/\blog(ger)?\./i.test(b) && !isWrite(b, rel);

        const fe: FieldEnforcement = { field, variants, strength: "NO_WRITES_FOUND", reasons: [], writes: [], write_count: 0, db: [], weak_db: [], locks: [], unprotected_writes: [], unprotected_write_files: [], check_then_act: [], concurrency_tests: [] };

        for (const [rel, lines] of texts) {
            if (TEST.test(rel)) {
                const body = lines.join("\n");
                if (mention.test(body) && (CONCURRENCY_TEST.test(body) || /concurr|race/i.test(path.basename(rel)))) fe.concurrency_tests.push(rel);
                continue;
            }
            if (!lines.some((l) => mention.test(l))) continue;
            lines.forEach((l, i) => {
                if (COMMENT.test(l)) return;
                // database constraints
                const win = lines.slice(Math.max(0, i - 2), i + 3).join(" ");
                if (mention.test(l) && (DB_FILE.test(rel) || /@(Column|Table|Check|UniqueConstraint|Index)\b/.test(win))) {
                    // a constraint counts only when the line that carries it names the field (or opens a column list that continues onto this line):
                    // a CHECK on the NEXT column of a CREATE TABLE is not a constraint on this one
                    const prev = i > 0 && /\b(UNIQUE|CHECK|EXCLUDE|INDEX)\b[^;]*\(\s*$/i.test(lines[i - 1]) ? lines[i - 1] : "";
                    const own = [prev, ...lines.slice(Math.max(0, i - 2), i + 3).filter((x) => mention.test(x))].join(" ");
                    const kind = DB_KIND.find(([, re]) => re.test(own))?.[0];
                    if (kind) fe.db.push({ file: rel, line: i + 1, text: l.trim().slice(0, 160), kind: kind + (/\bWHERE\b/i.test(win) ? " (partial)" : "") });
                    else if (WEAK_DB.test(win)) fe.weak_db.push({ file: rel, line: i + 1, text: l.trim().slice(0, 160) });
                }
                if (!isWrite(l, rel)) return;
                fe.write_count++;
                const hit = { file: rel, line: i + 1, text: l.trim().slice(0, 160) };
                if (fe.writes.length < maxHits) fe.writes.push(hit);
                // is the writing METHOD protected, and does it read the field first?
                const [s] = methodRange(lines, i);
                const prot = protection(lines, i, helpersOf(lines));
                if (prot) { if (fe.locks.length < maxHits) fe.locks.push({ file: rel, line: prot.line, text: prot.text }); return; }
                if (fe.unprotected_writes.length < 50) fe.unprotected_writes.push(hit);
                if (lines.slice(Math.max(s, i - 25), i).some((b) => isRead(b, rel)) && fe.check_then_act.length < maxHits) fe.check_then_act.push(hit);
            });
        }
        fe.unprotected_write_files = [...new Set(fe.unprotected_writes.map((h) => h.file))];

        const constrained = fe.db.some((d) => d.kind.startsWith("UNIQUE") || d.kind.startsWith("CHECK"));
        if (constrained) {
            fe.strength = "DB_ENFORCED";
            fe.reasons.push(`a database constraint backs the field: ${[...new Set(fe.db.map((d) => d.kind))].join(", ")}`);
        } else if (fe.write_count === 0) {
            fe.strength = "NO_WRITES_FOUND";
            fe.reasons.push("no write to the field was found in the scanned code");
        } else if (fe.unprotected_writes.length === 0) {
            fe.strength = "LOCK_PROTECTED";
            fe.reasons.push("every write sits in a method that takes a lock or version guard (confirm the lock is taken before the check, on the right row, and held through the write)");
        } else if (fe.check_then_act.length) {
            fe.strength = "CHECK_THEN_ACT";
            fe.reasons.push("a write reads the field shortly before writing it, with no lock in the method and no database constraint: two actors can both pass the check");
        } else {
            fe.strength = "CODE_ONLY";
            fe.reasons.push("writes exist with no database constraint and no lock in the writing method; any rule about the field is enforced only by application code");
        }
        if (!constrained && fe.weak_db.length) fe.reasons.push("the database only has NOT NULL / foreign-key / primary-key style constraints on it, which do not enforce uniqueness or cardinality");
        if (!constrained && fe.unprotected_writes.length && fe.unprotected_writes.length < fe.write_count) fe.reasons.push(`partially protected: ${fe.unprotected_writes.length} of ${fe.write_count} write(s) are in methods that take no lock`);
        if (!fe.concurrency_tests.length && fe.strength !== "NO_WRITES_FOUND") fe.reasons.push("no concurrency test exercises the field");
        rep.fields.push(fe);
    }
    if (rep.truncated) rep.notes.push(`Stopped after ${MAX_FILES} files; the map is partial.`);
    rep.notes.push("Pattern-based and read-only. Lock detection is per method: a write in a helper called from a locked method is reported unprotected, so check the callers. DTO and request mappings and read predicates are not counted as writes. The rating is evidence, not a verdict: compare it with what the invariant needs.");
    return rep;
}

const GUIDE: Record<Strength, string> = {
    DB_ENFORCED: "The database itself refuses a violating row. Strongest form; check the constraint really expresses the invariant (for example a partial unique index per parent, not just a plain unique column).",
    LOCK_PROTECTED: "Every write is in a method that takes a lock or version guard. Confirm it is taken BEFORE the check and held through the write, on the right row (usually the parent), and that no other path (delete, bulk, import, another service) writes the field.",
    CHECK_THEN_ACT: "Two actors can both read the same state, both pass the check, and both write. For an 'exactly one' or 'never zero' invariant this is a zombie-state risk (two owners, zero owners, orphans).",
    CODE_ONLY: "Nothing but application code stands behind the field. If the invariant is about cardinality or uniqueness, concurrent writers can break it.",
    NO_WRITES_FOUND: "No writer found: check the field name, or that writes go through another name (a builder, a JPQL update, another service).",
};

export function renderEnforcement(r: EnforcementReport): string {
    const head =
        `## INVARIANT ENFORCEMENT MAP\n` +
        `Fields: ${r.fields.map((f) => f.field).join(", ") || "none"} · files scanned: ${r.files_scanned}${r.truncated ? " (truncated)" : ""}\n` +
        `An invariant such as "exactly one per tenant" needs a database unique (or partial unique) constraint, or a lock on the parent row held around the check and the write. ` +
        `CHECK_THEN_ACT and CODE_ONLY mean concurrent actors can break it.\n` +
        (r.notes.length ? r.notes.map((n) => `Note: ${n}`).join("\n") + "\n" : "");
    if (!r.fields.length) return head + "\nNo fields were given.\n";
    const blocks = r.fields.map((f) => {
        const L: string[] = [`### ${f.field}  (variants: ${f.variants.join(", ")})`, `Enforcement: ${f.strength}`, ...f.reasons.map((x) => `- ${x}`), GUIDE[f.strength]];
        L.push(f.db.length ? `Database constraints:\n${f.db.map((d) => `- ${d.file}:${d.line} [${d.kind}]  ${d.text}`).join("\n")}` : "Database constraints: none found");
        if (f.weak_db.length) L.push(`Weaker database constraints (not uniqueness):\n${f.weak_db.slice(0, 3).map((d) => `- ${d.file}:${d.line}  ${d.text}`).join("\n")}`);
        L.push(`Write sites (${f.write_count}):\n${f.writes.map((d) => `- ${d.file}:${d.line}  ${d.text}`).join("\n") || "- none"}${f.write_count > f.writes.length ? `\n- …and ${f.write_count - f.writes.length} more` : ""}`);
        L.push(f.locks.length ? `Writes in methods that take a lock (evidence line):\n${f.locks.map((d) => `- ${d.file}:${d.line}  ${d.text}`).join("\n")}` : "Writes in methods that take a lock: none found");
        if (f.unprotected_writes.length) L.push(`Writes in methods with NO lock (${f.unprotected_writes.length}):\n${f.unprotected_writes.slice(0, maxShow).map((d) => `- ${d.file}:${d.line}  ${d.text}`).join("\n")}`);
        if (f.check_then_act.length) L.push(`Check-then-act (the field is read shortly before the write, no lock):\n${f.check_then_act.map((d) => `- ${d.file}:${d.line}  ${d.text}`).join("\n")}`);
        L.push(`Concurrency tests: ${f.concurrency_tests.join(", ") || "none found"}`);
        return L.join("\n");
    });
    return head + "\n" + blocks.join("\n\n") + "\n";
}
const maxShow = 12;
