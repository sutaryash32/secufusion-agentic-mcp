/**
 * Silent behavior change detection: business behavior that changed even though the code compiles and the tests pass.
 *
 * This is the deterministic half. It reads the diff (base to working tree) and surfaces every changed line that carries
 * behavior: authorization checks, validation, query predicates, filtering, default values, feature flags, conditionals and
 * time calculations, with the signals that explain HOW it changed (a comparison flipped, a number changed, a predicate was
 * dropped, a negation appeared). It cannot know what the change means for users or whether anyone intended it: the
 * reviewer judges that (Old Behavior, New Behavior, Affected Users, Acceptance Criteria Impact, Risk, Intent Explicitly
 * Confirmed). It is a detector built on patterns, so it surfaces candidates and never proves a behavior change.
 */
import path from "path";
import { git, gitTop, pickBase } from "./diff_quality.js";

export type Category = "AUTHORIZATION" | "VALIDATION" | "QUERY_PREDICATE" | "FILTERING" | "DEFAULT_VALUE" | "FEATURE_FLAG" | "CONDITIONAL" | "TIME_CALCULATION";
export type Risk = "LOW" | "MEDIUM" | "HIGH";

const PATTERNS: Array<[Category, RegExp]> = [
    ["AUTHORIZATION", /(@PreAuthorize|@PostAuthorize|@Secured|@RolesAllowed|hasAuthority|hasAnyAuthority|hasRole|hasPermission|isCallerAncestorOrSelf|AccessDenied|Forbidden|isAuthorized|isAuthenticated|permitAll|authenticated\(\)|authorizeHttpRequests|requestMatchers|antMatchers|checkPermission|canAccess|requireRole|requireAuth)/i],
    ["VALIDATION", /(@Valid\b|@Validated|@NotNull|@NotBlank|@NotEmpty|@Size\b|@Min\b|@Max\b|@Pattern\b|@Email\b|@Positive|@Negative|\bvalidate\w*\(|Objects\.requireNonNull|Preconditions\.|throw new (IllegalArgument|IllegalState|Validation|BadRequest|ConstraintViolation)\w*|\.isBlank\(\)|\.matches\()/],
    ["QUERY_PREDICATE", /(@Query\b|\bWHERE\b|\bJOIN\b|\bHAVING\b|\bORDER BY\b|\bfindBy\w+|\bexistsBy\w+|\bcountBy\w+|\bdeleteBy\w+|Specification|CriteriaBuilder|\.where\(|tenantId|tenant_id)/i],
    ["FILTERING", /(\.filter\(|removeIf\(|\.anyMatch\(|\.allMatch\(|\.noneMatch\(|\.skip\(|\.limit\(|\.distinct\(|\.takeWhile\(|\.dropWhile\(|\.some\(|\.every\()/],
    ["DEFAULT_VALUE", /(@Value\(\s*"[^"]*:[^"]*"|defaultValue|getOrDefault\(|\.orElse\(|orElseGet\(|\?\?|\|\|\s*['"\d\[{]|\bDEFAULT[_A-Z]*\b|\bdefault\w*\s*[=:])/],
    ["FEATURE_FLAG", /(featureFlag|\bfeature[._-]\w+|\.enabled\b|isEnabled|isFeatureEnabled|\btoggle|@ConditionalOn\w+|@Profile\(|\bFF_\w+|\bflags?\.\w+)/i],
    ["CONDITIONAL", /(\bif\s*\(|\belse\s+if\b|\bwhile\s*\(|\?[^?:]*:|&&|\|\||\bswitch\s*\()/],
    ["TIME_CALCULATION", /(Duration\.|Instant\.|LocalDate\w*|ZonedDateTime|OffsetDateTime|ChronoUnit|TimeUnit|\.(plus|minus)(Days|Hours|Minutes|Seconds|Weeks|Months|Years)?\(|currentTimeMillis|new Date\(|Date\.now\(|setTimeout|setInterval|@Scheduled|\bcron\b|\bexpir\w*|\bttl\b|retention[._-]?\w*(days|period|hours|minutes|seconds|ttl|window|grace)|\b\d+\s*\*\s*(1000|60|24)\b|\.isBefore\(|\.isAfter\(|\bmoment\(|\bdayjs\()/i],
];

const CODE = /\.(java|kt|scala|groovy|jsx?|tsx?|mjs|cjs|py|go|cs|rb|php|sql|properties|ya?ml)$|(^|\/)\.env(\.[\w.-]+)?$/;
const CONFIG = /\.(properties|ya?ml)$|(^|\/)\.env(\.[\w.-]+)?$/;
const TEST = /(^|\/)(src\/test|__tests__|tests?|spec)\/|\.(test|spec)\.[jt]sx?$|(Test|Tests|IT)\.java$/;
const SKIP = /(^|\/)(node_modules|dist|build|target|\.git|coverage)\/|\.min\.|package-lock\.json|yarn\.lock/;
const NOISE = /^(\s*$|\s*(\/\/|\/\*|\*|#|import\s|package\s)|\s*(log|logger|LOG|console)\.\w+\()/;

export interface Candidate {
    file: string; line: number; context: string; categories: Category[];
    old: string[]; new: string[]; signals: string[]; baseline_risk: Risk;
}
export interface BehaviorReport {
    root: string | null; base: string | null; base_reason: string; files_scanned: number; test_files_changed: string[];
    candidates: Candidate[]; counts: Record<Risk, number>; notes: string[];
}

const numbers = (s: string) => [...s.matchAll(/(?<![\w.])-?\d+(?:\.\d+)?(?![\w.])/g)].map((m) => m[0]);
const strings = (s: string) => [...s.matchAll(/"([^"\\]*)"|'([^'\\]*)'/g)].map((m) => m[1] ?? m[2]);
const operators = (s: string) => [...s.matchAll(/===|!==|==|!=|>=|<=|&&|\|\||(?<![-=<>])[<>](?![<>=])/g)].map((m) => m[0]);
const negations = (s: string) => (s.match(/!(?!=)/g) ?? []).length;
const idents = (s: string) => new Set([...s.matchAll(/[A-Za-z_]\w{2,}/g)].map((m) => m[0]));
const ANNOT = (s: string) => [...s.matchAll(/@\w+/g)].map((m) => m[0]);

function diffSet(a: string[], b: string[]): { removed: string[]; added: string[] } {
    const sa = [...a], sb = [...b];
    const removed = sa.filter((x) => { const i = sb.indexOf(x); if (i >= 0) { sb.splice(i, 1); return false; } return true; });
    return { removed, added: sb };
}

function signalsFor(oldT: string, newT: string): string[] {
    const out: string[] = [];
    if (!oldT.trim()) out.push("added with no counterpart in the old code");
    if (!newT.trim()) out.push("removed with no replacement");
    if (oldT.trim() && newT.trim()) {
        const n = diffSet(numbers(oldT), numbers(newT));
        if (n.removed.length || n.added.length) out.push(`value ${n.removed.join(", ") || "(none)"} -> ${n.added.join(", ") || "(none)"}`);
        const st = diffSet(strings(oldT), strings(newT));
        if (st.removed.length || st.added.length) out.push(`text ${st.removed.map((x) => `"${x}"`).join(", ") || "(none)"} -> ${st.added.map((x) => `"${x}"`).join(", ") || "(none)"}`);
        const o = diffSet(operators(oldT), operators(newT));
        if (o.removed.length || o.added.length) out.push(`operator ${o.removed.join(" ") || "(none)"} -> ${o.added.join(" ") || "(none)"}`);
        const ng = negations(newT) - negations(oldT);
        if (ng > 0) out.push("negation added"); else if (ng < 0) out.push("negation removed");
        const an = diffSet(ANNOT(oldT), ANNOT(newT));
        if (an.removed.length || an.added.length) out.push(`annotation ${an.removed.join(" ") || "(none)"} -> ${an.added.join(" ") || "(none)"}`);
    }
    const io = idents(oldT), inn = idents(newT);
    const gone = [...io].filter((x) => !inn.has(x)).slice(0, 6), came = [...inn].filter((x) => !io.has(x)).slice(0, 6);
    if (oldT.trim() && newT.trim()) {
        if (gone.length) out.push(`no longer references: ${gone.join(", ")}`);
        if (came.length) out.push(`now references: ${came.join(", ")}`);
    }
    return out;
}

function baselineRisk(cats: Category[], signals: string[]): Risk {
    const removed = signals.some((s) => s.startsWith("removed with no replacement"));
    const dropped = signals.some((s) => /no longer references/.test(s));
    if (cats.includes("AUTHORIZATION") || cats.includes("QUERY_PREDICATE")) return "HIGH";
    if (cats.includes("VALIDATION")) return removed || dropped ? "HIGH" : "MEDIUM";
    if (cats.some((c) => ["FEATURE_FLAG", "DEFAULT_VALUE", "TIME_CALCULATION", "FILTERING"].includes(c))) return "MEDIUM";
    return signals.some((s) => /^(operator|negation)/.test(s)) ? "MEDIUM" : "LOW";
}

export function analyzeBehaviorChanges(cwd: string, opts: { base?: string } = {}): BehaviorReport {
    const top = gitTop(cwd);
    const rep: BehaviorReport = { root: top, base: null, base_reason: "", files_scanned: 0, test_files_changed: [], candidates: [], counts: { HIGH: 0, MEDIUM: 0, LOW: 0 }, notes: [] };
    if (!top) { rep.notes.push("Not a git repository: there is no diff to inspect."); return rep; }
    const { base, reason } = pickBase(top, opts.base);
    rep.base = base; rep.base_reason = reason;
    const text = git(top, ["diff", "-U0", "--no-color", "--no-renames", base]);
    if (text === null) { rep.notes.push(`git diff against ${base} failed.`); return rep; }

    const files = new Set<string>(), tests = new Set<string>();
    let file = "", ctx = "", newLine = 0, removed: string[] = [], added: string[] = [];
    const flush = () => {
        if (file && (removed.length || added.length)) group(file, ctx, newLine, removed, added);
        removed = []; added = [];
    };
    const group = (f: string, c: string, ln: number, rem: string[], add: string[]) => {
        const keep = (l: string) => !NOISE.test(l);
        const r = rem.filter(keep), a = add.filter(keep);
        if (!r.length && !a.length) return;
        const cfg = CONFIG.test(f);
        const cats = new Set<Category>();
        for (const l of [...r, ...a]) for (const [cat, re] of PATTERNS) if (re.test(l)) cats.add(cat);
        if (cfg) { cats.add("DEFAULT_VALUE"); }
        if (!cats.size) return;
        const ordered = PATTERNS.map(([c2]) => c2).filter((c2) => cats.has(c2));
        const signals = signalsFor(r.join(" "), a.join(" "));
        rep.candidates.push({ file: f, line: ln, context: c, categories: ordered, old: r.map((x) => x.trim()), new: a.map((x) => x.trim()), signals, baseline_risk: baselineRisk(ordered, signals) });
    };
    for (const raw of text.split(/\r?\n/)) {
        if (raw.startsWith("diff --git ")) { flush(); file = ""; continue; }
        if (raw.startsWith("+++ ")) {
            const p = raw.slice(4).replace(/^b\//, "");
            if (p === "/dev/null") { file = ""; continue; }
            if (SKIP.test(p) || !CODE.test(p)) { file = ""; continue; }
            if (TEST.test(p)) { tests.add(p); file = ""; continue; }
            file = p; files.add(p); continue;
        }
        if (raw.startsWith("--- ")) continue;
        const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@\s?(.*)$/.exec(raw);
        if (h) { flush(); newLine = Number(h[1]); ctx = h[2].trim(); continue; }
        if (!file) continue;
        if (raw.startsWith("-")) removed.push(raw.slice(1));
        else if (raw.startsWith("+")) added.push(raw.slice(1));
    }
    flush();
    rep.files_scanned = files.size;
    rep.test_files_changed = [...tests].sort();
    const rank: Record<Risk, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
    rep.candidates.sort((a, b) => rank[a.baseline_risk] - rank[b.baseline_risk] || a.file.localeCompare(b.file) || a.line - b.line);
    for (const c of rep.candidates) rep.counts[c.baseline_risk]++;
    if (reason.startsWith("HEAD")) rep.notes.push("No default branch to compare against, so only uncommitted changes were inspected. Pass `base` to inspect committed work.");
    rep.notes.push("Untracked (never added) files are not in the diff. Pattern-based detection: it surfaces candidates, it does not prove a behavior change or its absence; code that changes behavior without touching these patterns can be missed.");
    return rep;
}

export function renderBehaviorReport(r: BehaviorReport, max = 40): string {
    const head =
        `## SILENT BEHAVIOR CHANGE REVIEW: candidates\n` +
        `Base: ${r.base ?? "n/a"} (${r.base_reason}) · files scanned: ${r.files_scanned} · candidates: HIGH ${r.counts.HIGH}, MEDIUM ${r.counts.MEDIUM}, LOW ${r.counts.LOW}\n` +
        `Test files changed (not scanned, but note whether tests were edited to fit new behavior): ${r.test_files_changed.join(", ") || "none"}\n` +
        (r.notes.length ? r.notes.map((n) => `Note: ${n}`).join("\n") + "\n" : "") +
        `This is deterministic evidence of WHAT changed. You judge what it MEANS: turn each material candidate into a BEHAVIOR CHANGE block (Old Behavior, New Behavior, Affected Users, Acceptance Criteria Impact, Risk, Intent Explicitly Confirmed) and dismiss the rest with a reason. A passing build and passing tests do not confirm intent.\n`;
    if (!r.candidates.length) return head + "\nNo behavior-bearing changes found in the diff.\n";
    const blocks = r.candidates.slice(0, max).map((c, i) => [
        `BEHAVIOR CHANGE CANDIDATE ${i + 1}`,
        `File: ${c.file}:${c.line}${c.context ? `  ·  in: ${c.context}` : ""}`,
        `Categories: ${c.categories.join(", ")}`,
        "Old code:", ...(c.old.length ? c.old.map((l) => `  - ${l}`) : ["  (none: the line is new)"]),
        "New code:", ...(c.new.length ? c.new.map((l) => `  + ${l}`) : ["  (none: the line was removed)"]),
        `Signals: ${c.signals.join("; ") || "none"}`,
        `Baseline risk: ${c.baseline_risk}`,
    ].join("\n"));
    return head + "\n" + blocks.join("\n\n---\n\n") + (r.candidates.length > max ? `\n\n…and ${r.candidates.length - max} more (lower risk), not shown.\n` : "\n");
}

void path;
