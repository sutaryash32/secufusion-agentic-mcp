const IDENT = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;
const BAD_SQL = /;|--|\/\*|\b(drop|delete|update|insert|alter|truncate|grant|revoke|create|exec|execute|merge|call|copy|pg_sleep|sleep)\b/i;
const SAFE_PRED = /^[\w\s.=<>!'"()%,]+$/;
function ident(v, what) {
    if (!v || !IDENT.test(v))
        throw new Error(`${what} must be a plain identifier (letters, digits, underscore, optional schema.), got ${JSON.stringify(v)}`);
    return v;
}
function pred(v) {
    if (v === undefined)
        return undefined;
    if (!SAFE_PRED.test(v) || BAD_SQL.test(v))
        throw new Error(`where predicate ${JSON.stringify(v)} must be a simple boolean expression (no ; -- /* or statements)`);
    return v.trim();
}
const q = (d, id) => id.split(".").map((p) => (d === "mysql" ? "`" + p + "`" : d === "sqlserver" ? "[" + p + "]" : '"' + p + '"')).join(".");
const short = (s) => s.replace(/[^A-Za-z0-9]+/g, "_").toLowerCase().slice(0, 40);
function violationSql(d, s, warnings) {
    const t = q(d, ident(s.table, "table"));
    const w = pred(s.where);
    const sc = s.scope_column ? q(d, ident(s.scope_column, "scope_column")) : undefined;
    switch (s.kind) {
        case "exactly_one":
        case "at_most_one":
        case "at_least_one": {
            if (!sc)
                throw new Error(`${s.kind} needs scope_column (e.g. tenant_id)`);
            if (!w)
                throw new Error(`${s.kind} needs where (the predicate that marks the special row, e.g. default_user = true)`);
            const cmp = s.kind === "exactly_one" ? "<> 1" : s.kind === "at_most_one" ? "> 1" : "< 1";
            if (s.kind !== "at_most_one") {
                if (!s.scope_table) {
                    warnings.push("no scope_table given: a scope with ZERO matching rows is invisible to this query. Give scope_table (e.g. tenant) to find those too.");
                    return `SELECT ${sc} AS scope_id, COUNT(*) AS matching_rows\nFROM ${t}\nWHERE ${w}\nGROUP BY ${sc}\nHAVING COUNT(*) ${cmp};`;
                }
                const st = q(d, ident(s.scope_table, "scope_table")), sk = q(d, ident(s.scope_table_key ?? "id", "scope_table_key"));
                return `SELECT s.${sk} AS scope_id, COALESCE(c.n, 0) AS matching_rows\nFROM ${st} s\nLEFT JOIN (SELECT ${sc} AS scope_id, COUNT(*) AS n FROM ${t} WHERE ${w} GROUP BY ${sc}) c ON c.scope_id = s.${sk}\nWHERE COALESCE(c.n, 0) ${cmp};`;
            }
            return `SELECT ${sc} AS scope_id, COUNT(*) AS matching_rows\nFROM ${t}\nWHERE ${w}\nGROUP BY ${sc}\nHAVING COUNT(*) ${cmp};`;
        }
        case "unique": {
            const cols = (s.columns ?? []).map((c) => q(d, ident(c, "column")));
            if (!cols.length)
                throw new Error("unique needs columns");
            const all = sc ? [sc, ...cols] : cols;
            return `SELECT ${all.join(", ")}, COUNT(*) AS duplicates\nFROM ${t}${w ? `\nWHERE ${w}` : ""}\nGROUP BY ${all.join(", ")}\nHAVING COUNT(*) > 1;`;
        }
        case "not_null": {
            const col = q(d, ident(s.columns?.[0], "columns[0]"));
            return `SELECT *\nFROM ${t}\nWHERE ${col} IS NULL${w ? ` AND (${w})` : ""};`;
        }
        case "references": {
            const col = q(d, ident(s.columns?.[0], "columns[0]"));
            const rt = q(d, ident(s.ref_table, "ref_table")), rc = q(d, ident(s.ref_column ?? "id", "ref_column"));
            return `SELECT c.*\nFROM ${t} c\nLEFT JOIN ${rt} p ON p.${rc} = c.${col}\nWHERE c.${col} IS NOT NULL AND p.${rc} IS NULL;`;
        }
    }
}
function ddl(d, s) {
    const raw = ident(s.table, "table");
    const t = q(d, raw);
    const header = (what) => `-- =====================================================\n-- V{n}: ${what}\n-- WHY: ${s.description ?? s.id}\n-- NOTE: applied MANUALLY, before deploying the code that relies on it. Run the violation query first: it must return no rows.\n-- =====================================================\n`;
    const idx = `uq_${short(raw)}_${short(s.scope_column ?? "")}_${short(s.id)}`.replace(/_+/g, "_");
    const w = pred(s.where);
    const sc = s.scope_column ? q(d, ident(s.scope_column, "scope_column")) : undefined;
    switch (s.kind) {
        case "exactly_one":
        case "at_most_one": {
            if (!sc || !w)
                return { supported: false, ddl: "", note: "needs scope_column and where" };
            const atLeast = s.kind === "exactly_one" ? " The at-least-one half (never zero) cannot be a plain index: enforce it in code under a lock, or with a deferred constraint trigger, and keep the violation query as a monitor." : "";
            if (d === "mysql") {
                return { supported: false, ddl: "", note: "MySQL has no partial unique index. Use a generated column (NULL when the predicate is false) with a UNIQUE index on (scope, generated)." + atLeast };
            }
            return { supported: true, ddl: `${header(`one row per ${s.scope_column} where ${w}`)}CREATE UNIQUE INDEX ${d === "postgres" ? "IF NOT EXISTS " : ""}${q(d, idx)} ON ${t} (${sc}) WHERE ${w};\n`, note: "enforces at most one." + atLeast };
        }
        case "at_least_one":
            return { supported: false, ddl: "", note: "'at least one' is not expressible as an index. Enforce it in code under a lock and monitor it with the violation query." };
        case "unique": {
            const cols = [...(sc ? [sc] : []), ...(s.columns ?? []).map((c) => q(d, ident(c, "column")))];
            if (!cols.length)
                return { supported: false, ddl: "", note: "needs columns" };
            return { supported: true, ddl: `${header(`unique ${cols.join(", ")}`)}CREATE UNIQUE INDEX ${d === "postgres" ? "IF NOT EXISTS " : ""}${q(d, idx)} ON ${t} (${cols.join(", ")})${w && d !== "mysql" ? ` WHERE ${w}` : ""};\n`, note: w && d === "mysql" ? "the predicate was dropped: MySQL has no partial index." : "" };
        }
        case "not_null": {
            const col = q(d, ident(s.columns?.[0], "columns[0]"));
            return { supported: true, ddl: `${header(`${s.columns?.[0]} is never null`)}${d === "sqlserver" ? `-- SQL Server: ALTER TABLE ${t} ALTER COLUMN ${col} <existing type> NOT NULL;` : d === "mysql" ? `-- MySQL: ALTER TABLE ${t} MODIFY ${col} <existing type> NOT NULL;` : `ALTER TABLE ${t} ALTER COLUMN ${col} SET NOT NULL;`}\n`, note: "backfill or fix existing NULL rows first (see the violation query)." };
        }
        case "references": {
            const col = q(d, ident(s.columns?.[0], "columns[0]")), rt = q(d, ident(s.ref_table, "ref_table")), rc = q(d, ident(s.ref_column ?? "id", "ref_column"));
            return { supported: true, ddl: `${header(`${s.columns?.[0]} references ${s.ref_table}`)}ALTER TABLE ${t} ADD CONSTRAINT ${q(d, "fk_" + short(raw) + "_" + short(s.columns?.[0] ?? ""))} FOREIGN KEY (${col}) REFERENCES ${rt} (${rc});\n`, note: "decide ON DELETE explicitly: the default (restrict) fails a delete mid-batch." };
        }
    }
}
const SQL_ONE_LINE = (sql) => sql.replace(/\s*\n\s*/g, " ").replace(/"/g, '\\"');
function skeleton(lang, s, sql) {
    const name = s.id.replace(/[^A-Za-z0-9]+/g, "_");
    const one = SQL_ONE_LINE(sql);
    switch (lang) {
        case "java":
            return `// JUnit 5 + Spring: ${s.id}\n@Test\nvoid invariant_${name}_has_no_violations() {\n    List<Map<String, Object>> rows = jdbc.queryForList("${one}");\n    assertThat(rows).as("rows that break ${s.id}").isEmpty();\n}\n\n@Test\nvoid crossTenant_${name}_isRefused() throws Exception {\n    // authenticate as tenant A, call the endpoint with a resource id that belongs to tenant B\n    mockMvc.perform(get("/api/<resource>/{id}", tenantBResourceId).with(asTenant(TENANT_A))).andExpect(status().isNotFound());\n}\n`;
        case "kotlin":
            return `// JUnit 5 + Spring: ${s.id}\n@Test\nfun \`invariant ${name} has no violations\`() {\n    val rows = jdbc.queryForList("${one}")\n    assertThat(rows).isEmpty()\n}\n`;
        case "typescript":
            return `// Vitest / Jest: ${s.id}\nit("invariant ${name} has no violations", async () => {\n  const { rows } = await pool.query(\`${sql.replace(/`/g, "\\`").replace(/\n/g, " ")}\`);\n  expect(rows).toHaveLength(0);\n});\n\nit("refuses a cross-tenant read of ${s.table}", async () => {\n  const res = await request(app).get(\`/api/<resource>/\${tenantBResourceId}\`).set("Authorization", tokenFor(TENANT_A));\n  expect(res.status).toBe(404);\n});\n`;
        case "python":
            return `# pytest: ${s.id}\ndef test_invariant_${name}_has_no_violations(db):\n    rows = db.execute("${one}").fetchall()\n    assert rows == []\n\n\ndef test_cross_tenant_${name}_is_refused(client, tenant_a_token, tenant_b_resource_id):\n    res = client.get(f"/api/<resource>/{tenant_b_resource_id}", headers={"Authorization": tenant_a_token})\n    assert res.status_code == 404\n`;
        case "csharp":
            return `// xUnit: ${s.id}\n[Fact]\npublic async Task Invariant_${name}_HasNoViolations()\n{\n    var rows = await _db.QueryAsync("${one}");\n    Assert.Empty(rows);\n}\n\n[Fact]\npublic async Task CrossTenant_${name}_IsRefused()\n{\n    var res = await _client.WithTenant(TenantA).GetAsync($"/api/<resource>/{TenantBResourceId}");\n    Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);\n}\n`;
        case "go":
            return `// go test: ${s.id}\nfunc TestInvariant_${name}_HasNoViolations(t *testing.T) {\n\trows, err := db.Query("${one}")\n\tif err != nil { t.Fatal(err) }\n\tdefer rows.Close()\n\tif rows.Next() { t.Fatal("rows break ${s.id}") }\n}\n`;
        case "ruby":
            return `# RSpec: ${s.id}\nit "invariant ${name} has no violations" do\n  rows = ActiveRecord::Base.connection.select_all("${one}")\n  expect(rows.to_a).to be_empty\nend\n`;
        case "php":
            return `// PHPUnit / Laravel: ${s.id}\npublic function test_invariant_${name}_has_no_violations(): void\n{\n    $rows = DB::select("${one}");\n    $this->assertCount(0, $rows);\n}\n`;
    }
}
export function generateInvariantChecks(specs, opts = {}) {
    const dialect = opts.dialect ?? "postgres";
    const language = opts.language ?? "java";
    return specs.map((s) => {
        const warnings = [];
        const sql = violationSql(dialect, s, warnings);
        return { id: s.id, kind: s.kind, violation_sql: sql, enforcement: ddl(dialect, s), test_skeleton: skeleton(language, s, sql), warnings };
    });
}
export function renderInvariantChecks(list, dialect, language) {
    const out = [`# Invariant checks (${dialect}, tests in ${language})`, "Nothing was executed and no file was written. Review each block, then run the SELECT against a read-only snapshot.", ""];
    for (const c of list) {
        out.push(`## ${c.id} (${c.kind})`, "", "Violation query (read-only):", "```sql", c.violation_sql, "```", "");
        out.push(c.enforcement.supported ? "Database enforcement (migration draft):" : "Database enforcement: not expressible here.", ...(c.enforcement.supported ? ["```sql", c.enforcement.ddl.trimEnd(), "```"] : []), ...(c.enforcement.note ? [`note: ${c.enforcement.note}`] : []), "");
        out.push(`Test skeleton (${language}):`, "```", c.test_skeleton.trimEnd(), "```", ...c.warnings.map((w) => `warning: ${w}`), "");
    }
    return out.join("\n");
}
