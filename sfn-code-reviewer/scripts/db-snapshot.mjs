#!/usr/bin/env node
// Read-only live schema snapshot for the db specialist (DB-001/005/006/009 against the real DB).
// Metadata only. Runs psql with a read-only transaction and a statement timeout; the connection
// string is read from the env var named in config and never written anywhere.
//
//   node db-snapshot.mjs --scope scope.json --out db-schema.json
// Adds `dbSchemaFile` to the scope file on success. Never fails the review: on any problem it logs
// and exits 0 without the field.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { shapeSnapshot, snapshotSql } from './lib/dbschema.mjs';
import { loadConfig } from './lib/paths.mjs';

const { values: args } = parseArgs({ options: { scope: { type: 'string' }, out: { type: 'string' } } });
const log = (m) => console.error(`[sfn-review:db] ${m}`);
if (!args.scope || !args.out) { log('usage: db-snapshot.mjs --scope <scope.json> --out <db-schema.json>'); process.exit(64); }

const c = loadConfig().review.integrations?.liveDb;
const scope = JSON.parse(readFileSync(args.scope, 'utf8'));
const url = c && process.env[c.urlEnv];
if (!c?.enabled && !process.env.SFN_FORCE_LIVEDB) process.exit(0);
if (!(c.stacks ?? []).includes(scope.repoConfig?.stack)) { log(`skipped (stack ${scope.repoConfig?.stack})`); process.exit(0); }
if (!url) { log(`skipped: ${c.urlEnv} is not set`); process.exit(0); }

try {
  const out = execFileSync('psql', ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', snapshotSql(c.schemas), url], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
    // Belt and braces on top of a read-only role: read-only transaction + statement timeout.
    env: { ...process.env, PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=20000', PGCONNECT_TIMEOUT: '10' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tables = shapeSnapshot(JSON.parse(out.trim()));
  writeFileSync(args.out, JSON.stringify({ takenAt: new Date().toISOString(), schemas: c.schemas, tables }, null, 1));
  scope.dbSchemaFile = resolve(args.out);
  writeFileSync(args.scope, JSON.stringify(scope, null, 2));
  log(`snapshot: ${Object.keys(tables).length} tables`);
} catch (e) {
  // psql echoes the URL on some errors — never print stderr verbatim.
  const msg = String(e.stderr || e.message).replace(/postgres(ql)?:\/\/\S+/g, '<db-url>').split('\n')[0];
  log(`skipped: ${msg}`);
}
