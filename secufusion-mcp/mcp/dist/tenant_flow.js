/**
 * Tenant-flow analysis: where does a tenant id come from, and does every data access carry it?
 *
 * Tenant isolation is usually enforced by convention: one missing predicate leaks one customer's data to another. This is a
 * deterministic, READ-ONLY scan that finds the two classic breaks in any language it has a profile for:
 *   UNSCOPED_DATA_ACCESS            a query / ORM call / raw SQL on tenant-owned data with no tenant predicate
 *   UNSCOPED_ID_LOOKUP              findById / find_by(id) / Find(id) style lookups by id alone (the IDOR shape)
 *   TENANT_FROM_REQUEST_UNGUARDED   a tenant id read from a request body / header / query with no access guard in the function
 * Languages: Java, Kotlin, JavaScript, TypeScript, Python, C#, Go, Ruby, PHP, and embedded or standalone SQL.
 * It is pattern-based (no compiler), so it reports LEADS with a confidence: HIGH when the accessed entity is known to be
 * tenant-owned (its definition mentions a tenant column) and nothing scopes the access; MEDIUM when ownership is not known;
 * LOW when a global scoping mechanism (Hibernate @Filter, EF query filters, Prisma extensions, Postgres row-level security,
 * Django managers...) exists in the workspace and may be doing the work. Read each lead before calling it a defect.
 */
import fs from "fs";
import path from "path";
const EXT = {
    ".java": "java", ".kt": "java", ".kts": "java", ".scala": "java",
    ".js": "js", ".jsx": "js", ".mjs": "js", ".cjs": "js", ".ts": "js", ".tsx": "js", ".mts": "js", ".vue": "js",
    ".py": "python", ".cs": "csharp", ".go": "go", ".rb": "ruby", ".php": "php", ".sql": "sql", ".prisma": "js",
};
const SKIP_DIR = new Set(["node_modules", "dist", "build", "target", ".git", ".idea", ".vscode", "coverage", ".secufusion", ".mcp", "out", "bin", "obj", "vendor", "venv", ".venv", "__pycache__", ".next", ".gradle", "site-packages"]);
const MIGRATION = /(^|\/)(db\/migration|migrations?|alembic|flyway|liquibase|seeds?|fixtures?)\//i;
const TEST = /(^|\/)(src\/test|__tests__|tests?|spec|specs|testing)\/|\.(test|spec)\.[jt]sx?$|(Test|Tests|IT)\.(java|kt|cs)$|_test\.(go|py)$|(^|\/)test_[^/]*\.py$/;
const MAX_FILES = 20000, MAX_BYTES = 1_000_000;
const RANK = { LOW: 0, MEDIUM: 1, HIGH: 2 };
// ------------------------------------------------------------ tenant tokens
// A tenant predicate / argument: tenantId, tenant_id, TenantId, fk_tenant_id, tenant_uuid, "tenant" as a key, org-scoped ids.
const TENANT_PRED = /tenant[_\- ]?(id|uuid|key|code|ref)\b|tenantid|fk_tenant|\btenant\s*[:=]|\btenant\s*==|["'`]tenant["'`]|\.tenant\b|tenant\)/i;
const TENANT_ANY = /tenant/i;
const GUARD = /requireCallerCanAccess|assert\w*TenantAccess|authori[sz]e\w*Tenant|canAccessTenant|can_access_tenant|TenantAccessGuard|tenantAccessGuard|ParentChainAuthorizer|verifyTenant|validateTenant|checkTenant\w*|ensureTenant\w*|tenant_?access|require_tenant|TenantPermission|has_tenant_access|IsTenantMember|tenantContext\b|TenantContext\b|currentTenant|getActingTenant\w*|actingTenant\w*|ActingTenant\w*|tenant_from_token|tenantFromToken|req\.tenant\b|ctx\.tenant\b|request\.tenant\b|current_tenant|Current\.tenant|HttpContext\.Items\[["']tenant|ITenantProvider|ITenantContext/;
const GLOBAL_SCOPE = /@FilterDef|@Filter\(|@TenantId\b|@Where\(clause|HasQueryFilter\(|\$extends\(|\$use\(|default_manager|TenantManager|TenantAwareManager|row[ _-]level security|CREATE POLICY|ENABLE ROW LEVEL SECURITY|set_config\(\s*['"]app\.tenant|SET\s+app\.tenant|acts_as_tenant|apartment|django-tenants|multitenant|MultiTenant|ScopedBy|GlobalScope|addGlobalScope|BelongsToTenant|tenant_scope|TenantScope|withTenant\(|\.withScope\(/;
const SQL_EMBED = /\b(SELECT\b[\s\S]{0,400}?\bFROM\b|UPDATE\s+[\w."`\[\]]+\s+SET\b|DELETE\s+FROM\b|INSERT\s+INTO\b)/i;
const PROFILES = {
    java: {
        access: [
            /^\s*(?:@\w+[^\n]*\s+)?(?:public\s+|default\s+)?(?:[\w<>\[\],.? ]+\s+)(?:find|get|read|query|count|exists|delete|remove|search|stream|select|update|list|load)\w*\s*\([^)]*\)?\s*;?\s*$/,
            /\b(?:entityManager|em|session)\s*\.\s*create(?:Native)?Query\s*\(/,
            /\bjdbcTemplate\s*\.\s*\w+\s*\(/,
            /\bnamedParameterJdbcTemplate\s*\.\s*\w+\s*\(/,
            /\bfun\s+(?:find|get|read|query|count|exists|delete|remove|search|select|update|list|load)\w*\s*\(/,
        ],
        idLookup: [/\b\w*(?:[Rr]epository|[Rr]epo|[Dd]ao)\s*\.\s*(?:findById|getById|getReferenceById|existsById|deleteById|findAllById|getOne)\s*\(/],
        request: [
            /@RequestHeader\s*\([^)]*[Tt]enant[^)]*\)/,
            /@RequestParam\s*\([^)]*[Tt]enant[^)]*\)/,
            /@RequestBody\b[^\n]*[Tt]enant/,
            /\b(?:dto|request|req|body|payload|command|input|form)\w*\s*\.\s*(?:get)?[Tt]enant\w*(?:\(\s*\))?/,
            /\.getHeader\(\s*["'][^"']*[Tt]enant/,
        ],
        pathParam: [/@PathVariable\s*\([^)]*[Tt]enant[^)]*\)/],
        decl: [/^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:public|protected|private|internal|static|final|override|suspend|open|abstract|default|synchronized|\s)*(?:fun\s+\w+|[\w<>\[\],.? ]+\s+\w+)\s*\([^;{]*\)\s*(?:throws\s+[\w., ]+)?\s*(?:\{|=)/],
    },
    js: {
        access: [
            /\b(?:prisma|db|tx|client|ctx\.db|this\.prisma)\s*\.\s*\w+\s*\.\s*(?:findMany|findFirst|findUnique|findUniqueOrThrow|findFirstOrThrow|update|updateMany|delete|deleteMany|upsert|create|createMany|count|aggregate|groupBy)\s*\(/,
            /\b\w*(?:[Rr]epository|[Rr]epo|[Mm]anager)\s*\.\s*(?:find|findOne|findOneBy|findBy|findOneOrFail|update|delete|remove|save|count|query|softDelete)\w*\s*\(/,
            /\.\s*createQueryBuilder\s*\(/,
            /\b[A-Z]\w*\s*\.\s*(?:findAll|findOne|findByPk|find|findById|findOneAndUpdate|findByIdAndUpdate|findOneAndDelete|updateOne|updateMany|deleteOne|deleteMany|destroy|update|count|countDocuments|aggregate)\s*\(/,
            /\b(?:knex|db|trx)\s*\(\s*['"`]\w+['"`]\s*\)/,
            /\bdb\s*\.\s*(?:select|insert|update|delete)\s*\(/,
            /\b(?:pool|client|db|connection|conn)\s*\.\s*query\s*\(\s*[`'"]/,
        ],
        idLookup: [
            /\b\w*(?:[Rr]epository|[Rr]epo)\s*\.\s*(?:findOneById|findOne|findById|findOneByOrFail)\s*\(\s*(?:\w+\s*)?\)/,
            /\bfindByPk\s*\(/, /\bfindById\s*\(/, /\bfindUnique\s*\(\s*\{\s*where\s*:\s*\{\s*id\s*[:}]/,
        ],
        request: [
            /\b(?:req|request|ctx\.request|c\.req)\s*\.\s*(?:body|query|params|headers)\s*(?:\.|\[\s*['"`])\s*(?:tenant\w*|x-tenant\w*)/i,
            /\bheaders\s*\[\s*['"`]x-tenant/i,
            /\b(?:req|request)\s*\.\s*(?:get|header)\s*\(\s*['"`]x-tenant/i,
            /\b(?:const|let|var)\s*\{[^}]*\btenant\w*[^}]*\}\s*=\s*(?:req|request)\s*\.\s*(?:body|query|headers)/i,
            /\b(?:body|payload|dto|input)\s*\.\s*tenant\w*/i,
        ],
        pathParam: [/\b(?:req|request)\s*\.\s*params\s*\.\s*tenant\w*/i],
        decl: [
            /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*\w*\s*\(/,
            /^\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*(?::[^=]+)?=>/,
            /^\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+|override\s+)*\w+\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$/,
            /\b(?:app|router|server)\s*\.\s*(?:get|post|put|patch|delete|all)\s*\(/,
        ],
    },
    python: {
        access: [
            /\b[A-Z]\w*\s*\.\s*objects\s*\.\s*(?:filter|get|all|exclude|create|update|delete|values|values_list|annotate|bulk_\w+|get_or_create|update_or_create|raw|first|last|count)\b/,
            /\b(?:session|db|Session|self\.session|self\.db)\s*\.\s*(?:query|execute|scalars|scalar|get|delete|add)\s*\(/,
            /\b(?:select|update|delete|insert)\s*\(\s*[A-Z]\w*/,
            /\bcursor\s*\.\s*execute(?:many)?\s*\(/,
            /\b(?:await\s+)?[A-Z]\w*\s*\.\s*(?:find|find_one|aggregate|insert_one|update_one|delete_one|filter|get_or_none)\s*\(/,
        ],
        idLookup: [/\.objects\s*\.\s*get\s*\(\s*(?:pk|id)\s*=/, /\b(?:session|db)\s*\.\s*get\s*\(\s*[A-Z]\w*\s*,/, /\.query\s*\(\s*[A-Z]\w*\s*\)\s*\.\s*get\s*\(/],
        request: [
            /\brequest\s*\.\s*(?:data|POST|GET|query_params|headers|META|json)\b[^\n]*tenant/i,
            /\bkwargs\s*\[\s*['"]tenant/i,
            /\bHeader\s*\([^)]*tenant/i,
            /\b(?:payload|body|data|schema|dto|item)\s*\.\s*tenant_?\w*/i,
            /\brequest\s*\.\s*(?:get_json|json)\s*\(\s*\)[^\n]*tenant/i,
            /\bdef\s+\w+\s*\([^)]*\btenant_id\s*:\s*\w+/,
        ],
        decl: [/^\s*(?:async\s+)?def\s+\w+\s*\(/],
    },
    csharp: {
        access: [
            /\b_?(?:context|db|dbContext|ctx|dbcontext)\s*\.\s*\w+\s*\.\s*(?:Where|First|FirstOrDefault|Single|SingleOrDefault|Find|FindAsync|ToList|ToListAsync|Any|AnyAsync|Count|CountAsync|Remove|RemoveRange|Update|Add|AddAsync|Include)\w*\s*\(/,
            /\b(?:connection|conn|db|_db)\s*\.\s*(?:Query|QueryAsync|Execute|ExecuteAsync|QueryFirst\w*|QuerySingle\w*|ExecuteScalar\w*)\s*(?:<[^>]+>)?\s*\(/,
            /\bFromSql(?:Raw|Interpolated)\s*\(/, /\bExecuteSql(?:Raw|Interpolated)?\s*\(/,
            /\b_?\w*(?:Repository|Repo)\s*\.\s*(?:Get|Find|Query|Delete|Update|List)\w*\s*\(/,
        ],
        idLookup: [/\.\s*(?:Find|FindAsync|GetById|GetByIdAsync)\s*\(\s*\w+\s*\)/],
        request: [
            /Request\s*\.\s*Headers\s*\[\s*["'][^"']*[Tt]enant/,
            /\[From(?:Header|Query|Route)[^\]]*[Tt]enant[^\]]*\]/,
            /\b(?:model|dto|request|req|input|command|body|payload)\w*\s*\.\s*TenantId\b/,
        ],
        pathParam: [/\[FromRoute[^\]]*[Tt]enant[^\]]*\]/],
        decl: [/^\s*(?:\[[^\]]+\]\s*)*(?:public|private|protected|internal|static|async|override|virtual|\s)+[\w<>\[\],.? ]+\s+\w+\s*\([^;]*\)\s*(?:\{|=>)?\s*$/],
    },
    go: {
        access: [
            /\b(?:db|tx|DB|conn|r\.db|s\.db|repo\.db)\s*\.\s*(?:Where|Find|First|Take|Last|Create|Save|Delete|Update|Updates|Model|Table|Raw|Exec|Query|QueryRow|QueryContext|QueryRowContext|ExecContext|Get|Select|NamedExec|NamedQuery|Preload|Joins)\s*\(/,
            /\b(?:sqlx|pgx|sql)\s*\.\s*\w+\s*\(/,
        ],
        idLookup: [/\.\s*First\s*\(\s*&\w+\s*,\s*\w*[iI][dD]\w*\s*\)/, /\.\s*Find\s*\(\s*&\w+\s*,\s*\w*[iI][dD]\w*\s*\)/],
        request: [
            /\.\s*(?:Query|PostForm|Param|GetHeader|FormValue|DefaultQuery|QueryParam)\s*\(\s*"[^"]*[Tt]enant/,
            /Header\s*\.\s*Get\s*\(\s*"[^"]*[Tt]enant/,
            /\b(?:req|body|payload|input|dto|in)\w*\s*\.\s*Tenant\w*/,
        ],
        decl: [/^\s*func\s+(?:\([^)]*\)\s*)?\w+\s*\(/],
    },
    ruby: {
        access: [/\b[A-Z]\w*\s*\.\s*(?:where|find|find_by|find_by!|all|first|last|update_all|delete_all|destroy_all|joins|includes|pluck|count|exists\?|find_or_create_by|create|create!)\b/],
        idLookup: [/\b[A-Z]\w*\s*\.\s*find\s*\(\s*params\s*\[/, /\b[A-Z]\w*\s*\.\s*find\s*\(\s*\w*id\w*\s*\)/],
        request: [/\bparams\s*\[\s*:?['"]?tenant\w*/i, /\brequest\s*\.\s*headers\s*\[\s*['"][^'"]*[Tt]enant/],
        decl: [/^\s*def\s+\w+/],
    },
    php: {
        access: [/\b[A-Z]\w*\s*::\s*(?:where|find|findOrFail|all|first|create|query|with|whereIn|update|destroy|firstOrFail)\s*\(/, /\bDB\s*::\s*(?:table|select|statement|update|delete|insert)\s*\(/, /->\s*(?:query|prepare|exec)\s*\(\s*["']/],
        idLookup: [/\b[A-Z]\w*\s*::\s*(?:find|findOrFail)\s*\(\s*\$\w+\s*\)/],
        request: [/\$request\s*->\s*(?:input|get|query|header|post)\s*\(\s*['"][^'"]*tenant/i, /\$_(?:GET|POST|REQUEST)\s*\[\s*['"]tenant/i, /\$request\s*->\s*tenant\w*/i],
        decl: [/^\s*(?:public|private|protected|static|\s)*function\s+\w+\s*\(/],
    },
};
// ------------------------------------------------------------ entity definitions
const DEFS = [
    { re: /^\s*(?:export\s+)?(?:abstract\s+)?(?:public\s+|internal\s+|sealed\s+|data\s+|open\s+)*class\s+(\w+)/, group: 1 },
    { re: /^\s*model\s+(\w+)\s*\{/, group: 1 }, // Prisma
    { re: /^\s*type\s+(\w+)\s+struct\b/, group: 1 }, // Go
    { re: /^\s*create_table\s+["'](\w+)["']/, group: 1 }, // Rails schema
    { re: /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"\[]?(?:\w+\.)?(\w+)/i, group: 1 },
    { re: /\bsequelize\s*\.\s*define\s*\(\s*['"](\w+)['"]/, group: 1 },
    { re: /\bmongoose\s*\.\s*model\s*\(\s*['"](\w+)['"]/, group: 1 },
];
const ENTITYISH = /\{\s*get;|@Entity|@Table|@Document|@MappedSuperclass|@Embeddable|models\.Model|declarative_base|Base\)|SQLModel|DbContext|DbSet<|ApplicationRecord|ActiveRecord::Base|extends\s+Model|Eloquent|\bgorm\.|gorm:|@Column|@PrimaryGeneratedColumn|Schema\(|sequelize|DataTypes|\bmodel\s+\w+\s*\{|CREATE\s+TABLE|create_table|struct\s*\{/;
const normName = (s) => s.toLowerCase().replace(/[_\-\s]/g, "").replace(/(ies)$/, "y").replace(/(es|s)$/, "");
function langOf(file) {
    return EXT[path.extname(file).toLowerCase()] ?? null;
}
function walk(dir, out, budget) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const e of entries) {
        if (budget.n <= 0)
            return;
        if (e.isDirectory()) {
            if (!SKIP_DIR.has(e.name) && !e.isSymbolicLink())
                walk(path.join(dir, e.name), out, budget);
            continue;
        }
        if (e.isFile() && langOf(e.name)) {
            out.push(path.join(dir, e.name));
            budget.n--;
        }
    }
}
const isComment = (l) => /^\s*(\/\/|\/\*|\*|#|--|<!--|'''|""")/.test(l) && !/^\s*#\[|^\s*#\s*include/.test(l);
/** The statement that starts at line i: joined lines until the parentheses balance (max 14 lines). */
function statementAt(lines, i) {
    let text = "", depth = 0, j = i;
    for (; j < lines.length && j < i + 14; j++) {
        const l = lines[j];
        text += (j > i ? "\n" : "") + l;
        for (const ch of l) {
            if (ch === "(")
                depth++;
            else if (ch === ")")
                depth--;
        }
        if (depth <= 0 && (/[;{]\s*$/.test(l) || /\)\s*$/.test(l) || /^\s*$/.test(l)))
            break;
    }
    return { text, end: j };
}
/** Annotation / decorator lines that sit directly above a declaration (Java @Query, Python decorators, C# attributes). */
function annotationsAbove(lines, i) {
    const out = [];
    for (let j = i - 1; j >= 0 && j >= i - 12; j--) {
        const t = lines[j].trim();
        if (t === "" || /[;}]$/.test(t) || /\{\s*$/.test(t))
            break;
        out.unshift(lines[j]);
    }
    return out.join("\n");
}
function enclosingFunction(lines, i, decl) {
    for (let j = i; j >= 0 && j >= i - 150; j--) {
        const l = lines[j];
        if (isComment(l))
            continue;
        for (const re of decl) {
            if (re.test(l)) {
                const m = /(?:function\s*\*?\s*|def\s+|func\s+(?:\([^)]*\)\s*)?|fun\s+|fn\s+)(\w+)|\b(\w+)\s*\(|(?:const|let|var)\s+(\w+)\s*=/.exec(l);
                const name = m ? (m[1] ?? m[2] ?? m[3] ?? "") : "";
                return { name, line: j + 1, sig: l };
            }
        }
    }
    return null;
}
function argsText(stmt) {
    const i = stmt.indexOf("(");
    return i < 0 ? stmt : stmt.slice(i);
}
export function analyzeTenantFlow(root, opts = {}) {
    const rootAbs = path.resolve(root);
    const minConf = opts.min_confidence ?? "MEDIUM";
    const maxFindings = Math.max(1, Math.min(opts.max_findings ?? 200, 2000));
    const exempt = new Set((opts.exempt_entities ?? ["Tenant", "Tenants", "tenant", "tenants"]).map(normName));
    const notes = [];
    let files = [];
    if (opts.files?.length) {
        for (const f of opts.files) {
            const abs = path.resolve(rootAbs, f);
            if (abs.startsWith(rootAbs) && fs.existsSync(abs) && langOf(abs))
                files.push(abs);
        }
    }
    else
        walk(rootAbs, files, { n: MAX_FILES });
    const rel = (f) => path.relative(rootAbs, f).split(path.sep).join("/");
    files = files.filter((f) => !MIGRATION.test(rel(f)) && (opts.include_tests || !TEST.test(rel(f))));
    const text = new Map();
    const languages = {};
    for (const f of files) {
        try {
            const st = fs.statSync(f);
            if (st.size > MAX_BYTES)
                continue;
            const buf = fs.readFileSync(f);
            if (buf.includes(0))
                continue;
            text.set(f, buf.toString("utf8").split(/\r?\n/));
            const lg = langOf(f);
            languages[lg] = (languages[lg] ?? 0) + 1;
        }
        catch { /* unreadable: skip */ }
    }
    // pass 1: which entities are tenant-owned, and is there a global scoping mechanism?
    const owned = new Set();
    const scopingSignals = [];
    for (const [f, lines] of text) {
        const whole = lines.join("\n");
        const entityish = ENTITYISH.test(whole);
        lines.forEach((l, i) => {
            if (!isComment(l) && GLOBAL_SCOPE.test(l) && scopingSignals.length < 12)
                scopingSignals.push({ file: rel(f), line: i + 1, text: l.trim().slice(0, 140) });
        });
        if (!entityish)
            continue;
        const starts = [];
        lines.forEach((l, i) => {
            if (isComment(l))
                return;
            for (const d of DEFS) {
                const m = d.re.exec(l);
                if (m) {
                    starts.push({ i, name: m[d.group] });
                    break;
                }
            }
        });
        starts.forEach((s, k) => {
            const end = Math.min(k + 1 < starts.length ? starts[k + 1].i : lines.length, s.i + 80);
            if (TENANT_ANY.test(lines.slice(s.i, end).join("\n")))
                owned.add(normName(s.name));
        });
    }
    const ownedAny = owned.size > 0;
    // pass 2: access sites and request-sourced tenant ids
    const findings = [];
    const seen = new Set();
    const add = (f) => {
        const k = `${f.kind}|${f.file}|${f.line}`;
        if (seen.has(k))
            return;
        seen.add(k);
        findings.push(f);
    };
    const scoped = scopingSignals.length > 0;
    const entityIn = (stmt) => {
        const ids = stmt.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
        const keywords = /^(select|from|where|and|or|update|delete|insert|into|set|find|get|all|filter|first|last|create|save|query|this|self|await|async|return|const|let|var|new|public|private|static|final|void|null|true|false|int|string|long|bool|id)$/i;
        for (const id of ids) {
            if (!keywords.test(id) && owned.has(normName(id)))
                return id;
        }
        return undefined;
    };
    const exemptHit = (stmt) => (stmt.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []).some((id) => exempt.has(normName(id)) && !owned.has(normName(id))) && !entityIn(stmt);
    for (const [f, lines] of text) {
        const lang = langOf(f);
        const file = rel(f);
        const sqlOnly = lang === "sql";
        const prof = sqlOnly ? null : PROFILES[lang];
        const isRepoFile = /Repository|Dao|DAO|Repo\b/.test(path.basename(f));
        const decl = prof?.decl ?? [];
        for (let i = 0; i < lines.length && findings.length < maxFindings * 3; i++) {
            const line = lines[i];
            if (isComment(line))
                continue;
            // --- request-sourced tenant ids
            if (prof) {
                const reqRes = [...prof.request, ...(opts.allow_path_tenant ? [] : prof.pathParam ?? [])];
                if (reqRes.some((re) => re.test(line))) {
                    const fn = enclosingFunction(lines, i, decl);
                    const from = fn ? fn.line - 1 : Math.max(0, i - 5);
                    let to = Math.min(lines.length, i + 60);
                    for (let j = i + 1; j < to; j++) {
                        if (decl.some((re) => re.test(lines[j])) && /^\S|^\s{0,4}\S/.test(lines[j])) {
                            to = j;
                            break;
                        }
                    }
                    const body = lines.slice(from, to).join("\n");
                    if (!GUARD.test(body)) {
                        const touchesData = prof.access.some((re) => re.test(body));
                        add({
                            kind: "TENANT_FROM_REQUEST_UNGUARDED",
                            confidence: scoped ? "MEDIUM" : touchesData ? "HIGH" : "MEDIUM",
                            language: lang, file, line: i + 1, function: fn?.name, snippet: line.trim().slice(0, 160),
                            why: `a tenant id is taken from the request${touchesData ? " and the same function touches data" : ""}, and no tenant-access guard (requireCallerCanAccess, tenant context from the token, ...) appears in the function`,
                        });
                    }
                }
            }
            // --- data access
            const lineIsAccess = prof ? prof.access.some((re) => re.test(line)) : false;
            const lineIsSql = !isComment(line) && /["'`]/.test(line) && SQL_EMBED.test(line + (lines[i + 1] ?? "")) || (sqlOnly && SQL_EMBED.test(line));
            const lineIsId = prof ? prof.idLookup.some((re) => re.test(line)) : false;
            if (!lineIsAccess && !lineIsSql && !lineIsId)
                continue;
            let stmt = statementAt(lines, i).text;
            if (lang === "java" && (isRepoFile || /^\s*@/.test(line) || /^\s*(?:public\s+)?[\w<>\[\],.? ]+\s+\w+\s*\([^)]*\)\s*;/.test(line))) {
                const above = annotationsAbove(lines, i);
                stmt = above + "\n" + stmt;
            }
            if (lang === "csharp" || lang === "python")
                stmt = annotationsAbove(lines, i).replace(/^/, "") + "\n" + stmt;
            const sig = enclosingFunction(lines, i, decl);
            const hasPred = TENANT_PRED.test(argsText(stmt)) || (lineIsSql && TENANT_PRED.test(stmt));
            // Java repository method declarations: the tenant must be in the name (…TenantId…) or the @Query text
            const nameHasTenant = lang === "java" && isRepoFile && /\b\w*[Tt]enant\w*\s*\(/.test(stmt.split("\n").pop() ?? "");
            if (hasPred || nameHasTenant)
                continue;
            if (exemptHit(stmt))
                continue;
            const entity = entityIn(stmt);
            let confidence = entity ? "HIGH" : ownedAny ? "MEDIUM" : "LOW";
            if (scoped && confidence !== "LOW")
                confidence = confidence === "HIGH" ? "MEDIUM" : "LOW";
            // a repository method whose @Query ignores a tenant parameter declared on the next line (the classic unused-parameter bug)
            let declText = line;
            if (/^\s*@/.test(line)) {
                let j = i;
                while (j < lines.length && /^\s*@/.test(lines[j]))
                    j++;
                declText = lines.slice(j, j + 3).join(" ");
            }
            const tenantParam = /tenant\w*\s*[,)]|@Param\(\s*["']tenant|(?:String|UUID|Long|Guid|int|string)\s+tenant\w*/i.test(declText);
            const paramNote = (sig && TENANT_ANY.test(sig.sig)) || tenantParam ? " The enclosing function takes a tenant parameter but the data access does not use it." : "";
            const kind = lineIsId && !lineIsAccess ? "UNSCOPED_ID_LOOKUP" : "UNSCOPED_DATA_ACCESS";
            if (kind === "UNSCOPED_ID_LOOKUP" && !entity && ownedAny && confidence === "MEDIUM")
                confidence = "MEDIUM";
            add({
                kind, confidence, language: lang, file, line: i + 1, function: sig?.name, entity,
                snippet: line.trim().slice(0, 160),
                why: (kind === "UNSCOPED_ID_LOOKUP" ? "a lookup by id alone: any tenant's row with that id is returned." : "no tenant predicate in this query or ORM call.") +
                    (entity ? ` ${entity} is tenant-owned (its definition mentions a tenant column).` : "") + paramNote +
                    (scoped ? " A global scoping mechanism exists in the workspace (see global_scoping_signals): check whether it already applies here." : ""),
            });
        }
    }
    const filtered = findings.filter((f) => RANK[f.confidence] >= RANK[minConf]).sort((a, b) => RANK[b.confidence] - RANK[a.confidence] || a.file.localeCompare(b.file) || a.line - b.line);
    const truncated = filtered.length > maxFindings;
    if (!ownedAny)
        notes.push("no tenant-owned entity definition was found, so entity ownership is unknown and findings are at most MEDIUM");
    if (scoped)
        notes.push("global tenant scoping signals were found (Hibernate filters, EF query filters, Prisma extensions, row-level security, ...): confidences are lowered, read them");
    notes.push("pattern-based, no compiler: a LEAD is not a verdict. Read the function, then cite file:line. A query reached only through a scoped helper is a false positive this scan cannot see");
    return {
        root: rootAbs, files_scanned: text.size, languages, tenant_owned_entities: [...owned].sort(),
        global_scoping_signals: scopingSignals, findings: filtered.slice(0, maxFindings), truncated, notes,
    };
}
export function renderTenantFlow(r) {
    const by = (c) => r.findings.filter((f) => f.confidence === c).length;
    const out = [
        `# Tenant flow: ${r.files_scanned} file(s) · ${Object.entries(r.languages).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`,
        `${r.findings.length} lead(s): HIGH ${by("HIGH")} · MEDIUM ${by("MEDIUM")} · LOW ${by("LOW")}${r.truncated ? " (truncated)" : ""}`,
        `Tenant-owned entities found: ${r.tenant_owned_entities.length ? r.tenant_owned_entities.join(", ") : "none"}`,
        "",
    ];
    for (const f of r.findings) {
        out.push(`[${f.confidence}] ${f.kind}  ${f.file}:${f.line}${f.function ? `  in ${f.function}` : ""}${f.entity ? `  (${f.entity})` : ""}`);
        out.push(`    ${f.snippet}`, `    ${f.why}`);
    }
    if (r.global_scoping_signals.length)
        out.push("", "Global scoping signals:", ...r.global_scoping_signals.map((s) => `  ${s.file}:${s.line}  ${s.text}`));
    out.push("", ...r.notes.map((n) => `note: ${n}`));
    return out.join("\n");
}
