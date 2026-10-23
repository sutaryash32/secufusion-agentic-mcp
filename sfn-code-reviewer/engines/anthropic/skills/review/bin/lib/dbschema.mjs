// Read-only live schema snapshot (Postgres): tables, columns, FKs with ON DELETE, indexes.
// Metadata only — never row data. Pure query builder + result shaper; the script runs psql.

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ON_DELETE = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' };

export function snapshotSql(schemas = ['public']) {
  const bad = schemas.find((s) => !IDENT.test(s));
  if (bad) throw new Error(`invalid schema name: ${bad}`);
  const list = schemas.map((s) => `'${s}'`).join(',');
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

/** Shapes the raw json_build_object output into one entry per table (grep-friendly). */
export function shapeSnapshot(raw) {
  const tables = {};
  const t = (name) => (tables[name] ??= { columns: [], foreignKeys: [], indexes: [], referencedBy: [] });
  for (const c of raw.columns ?? []) {
    t(c.t).columns.push(`${c.c} ${c.type}${c.nullable ? '' : ' NOT NULL'}${c.default ? ` DEFAULT ${c.default}` : ''}`);
  }
  for (const fk of raw.fks ?? []) {
    const onDelete = ON_DELETE[fk.onDelete] ?? fk.onDelete;
    t(fk.t).foreignKeys.push(`${fk.name}: ${fk.def} [ON DELETE ${onDelete}]`);
    t(fk.refTable).referencedBy.push(`${fk.t} via ${fk.name} [ON DELETE ${onDelete}]`);
  }
  for (const ix of raw.indexes ?? []) t(ix.t).indexes.push(ix.def);
  return tables;
}
