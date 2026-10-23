import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

/**
 * Live database schema snapshot (PostgreSQL), read-only.
 *
 * Some facts exist only in the live database: the foreign keys of join tables that no migration creates,
 * their ON DELETE behaviour, the indexes that really exist. Without them a reviewer can only say "ask the
 * author". This reads METADATA only (tables, columns, foreign keys, indexes), never row data, inside a
 * read-only transaction with a statement timeout.
 *
 * The connection string is read from an environment variable the caller NAMES; it is never accepted as a
 * tool argument, never written to disk and scrubbed from error text.
 */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{2,}$/;
const ON_DELETE: Record<string, string> = { a: "NO ACTION", r: "RESTRICT", c: "CASCADE", n: "SET NULL", d: "SET DEFAULT" };

export function snapshotSql(schemas: string[] = ["public"]): string {
    const bad = schemas.find((s) => !IDENT.test(s));
    if (bad) throw new Error(`invalid schema name: ${bad}`);
    const list = schemas.map((s) => `'${s}'`).join(",");
    return `
SELECT json_build_object(
  'columns', (SELECT coalesce(json_agg(json_build_object(
      't', table_schema || '.' || table_name, 'c', column_name, 'type', data_type,
      'nullable', is_nullable = 'YES', 'default', column_default) ORDER BY table_name, ordinal_position), '[]')
    FROM information_schema.columns WHERE table_schema IN (${list})),
  'fks', (SELECT coalesce(json_agg(json_build_object(
      't', n.nspname || '.' || c.relname, 'name', con.conname, 'def', pg_get_constraintdef(con.oid),
      'refTable', rn.nspname || '.' || r.relname, 'onDelete', con.confdeltype::text)), '[]')
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_class r ON r.oid = con.confrelid JOIN pg_namespace rn ON rn.oid = r.relnamespace
    WHERE con.contype = 'f' AND n.nspname IN (${list})),
  'indexes', (SELECT coalesce(json_agg(json_build_object('t', schemaname || '.' || tablename, 'name', indexname, 'def', indexdef)), '[]')
    FROM pg_indexes WHERE schemaname IN (${list}))
);`;
}

export interface TableInfo { columns: string[]; foreignKeys: string[]; indexes: string[]; referencedBy: string[] }

/** Shapes the raw json into one entry per table, easy to read and to search. */
export function shapeSnapshot(raw: any): Record<string, TableInfo> {
    const tables: Record<string, TableInfo> = {};
    const t = (name: string) => (tables[name] ??= { columns: [], foreignKeys: [], indexes: [], referencedBy: [] });
    for (const c of raw.columns ?? []) t(c.t).columns.push(`${c.c} ${c.type}${c.nullable ? "" : " NOT NULL"}${c.default ? ` DEFAULT ${c.default}` : ""}`);
    for (const fk of raw.fks ?? []) {
        const onDelete = ON_DELETE[fk.onDelete] ?? fk.onDelete;
        t(fk.t).foreignKeys.push(`${fk.name}: ${fk.def} [ON DELETE ${onDelete}]`);
        t(fk.refTable).referencedBy.push(`${fk.t} via ${fk.name} [ON DELETE ${onDelete}]`);
    }
    for (const ix of raw.indexes ?? []) t(ix.t).indexes.push(ix.def);
    return tables;
}

export interface Snapshot { taken_at: string; schemas: string[]; tables: Record<string, TableInfo> }

/** Runs psql (injectable for tests). The URL is read from `urlEnv`, which must name an environment variable. */
export function takeSnapshot(o: { urlEnv: string; schemas?: string[]; exec?: (args: string[], env: NodeJS.ProcessEnv) => string }): Snapshot {
    if (!ENV_NAME.test(o.urlEnv)) throw new Error("url_env must be the NAME of an environment variable (for example SFN_REVIEW_DB_URL), never the connection string itself");
    const url = process.env[o.urlEnv];
    if (!url) throw new Error(`environment variable ${o.urlEnv} is not set`);
    const schemas = o.schemas ?? ["public"];
    const exec = o.exec ?? ((args, env) => execFileSync("psql", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 60_000, env, stdio: ["ignore", "pipe", "pipe"] }));
    try {
        const out = exec(["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", snapshotSql(schemas), url], {
            ...process.env,
            // Belt and braces on top of a read-only role: read-only transaction and a statement timeout.
            PGOPTIONS: "-c default_transaction_read_only=on -c statement_timeout=20000", PGCONNECT_TIMEOUT: "10",
        });
        return { taken_at: new Date().toISOString(), schemas, tables: shapeSnapshot(JSON.parse(out.trim())) };
    } catch (e: any) {
        // psql echoes the URL on some errors: never pass its text on verbatim.
        const msg = String(e?.stderr || e?.message || e).replace(/postgres(ql)?:\/\/\S+/g, "<db-url>").split("\n")[0];
        throw new Error(`snapshot failed: ${msg}`);
    }
}

export const snapshotPath = (root: string) => path.join(root, ".secufusion", "db-schema.json");

export function saveSnapshot(root: string, s: Snapshot): string {
    const p = snapshotPath(root);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(s, null, 1));
    return p;
}

export function loadSnapshot(root: string): Snapshot | null {
    try { return JSON.parse(fs.readFileSync(snapshotPath(root), "utf8")); } catch { return null; }
}

export function lookupTables(s: Snapshot, names: string[]) {
    const out: Record<string, TableInfo | null> = {};
    for (const n of names) {
        const key = Object.keys(s.tables).find((k) => k === n || k.split(".").pop() === n || k.toLowerCase().endsWith("." + n.toLowerCase()));
        out[n] = key ? s.tables[key] : null;
    }
    return out;
}

/**
 * Facts a reviewer needs from the snapshot for the tables a change touches:
 *   FK behaviour on delete (cascade or restrict), tables referencing this one, missing indexes on FK columns.
 */
export function renderLookup(s: Snapshot, names: string[]): string {
    const r = lookupTables(s, names);
    const o = [`# Live schema (${s.schemas.join(", ")}, taken ${s.taken_at.slice(0, 16).replace("T", " ")}Z)`, ""];
    for (const [n, t] of Object.entries(r)) {
        if (!t) { o.push(`${n}: NOT FOUND in the snapshot (a table the code maps but the database lacks, or in another schema).`, ""); continue; }
        o.push(`## ${n}`, "columns:", ...t.columns.map((c) => "  " + c));
        if (t.foreignKeys.length) o.push("foreign keys:", ...t.foreignKeys.map((x) => "  " + x));
        if (t.referencedBy.length) o.push("referenced by (what a delete here runs into):", ...t.referencedBy.map((x) => "  " + x));
        if (t.indexes.length) o.push("indexes:", ...t.indexes.map((x) => "  " + x));
        const fkCols = t.foreignKeys.flatMap((f) => [...f.matchAll(/FOREIGN KEY \(([^)]+)\)/g)].map((m) => m[1].split(",")[0].trim()));
        const unindexed = fkCols.filter((c) => !t.indexes.some((ix) => new RegExp(`\\(\\s*${c}\\b`).test(ix)));
        if (unindexed.length) o.push(`FK column(s) with no index: ${unindexed.join(", ")}  (DB-009)`);
        o.push("");
    }
    return o.join("\n");
}
