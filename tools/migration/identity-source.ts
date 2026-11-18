import Database from 'better-sqlite3';
import type { DB } from '@qgroup/database';
import { identitySchema } from './identity-schema';

type SchemaObject = { type: string; name: string; tbl_name: string; sql: string | null };
type Column = { cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number; hidden: number };
export type IdentitySourceEvidence = {
  version: 1;
  schema: SchemaObject[];
  pragmas: { userVersion: number; applicationId: number; encoding: string };
  sqliteSequence: { name: string; seq: string }[];
  tables: { name: string; columns: Column[]; rows: { rowNumber: number; rowid: string; storageClasses: string[] }[] }[];
};
const quoted = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const schemaObjects = (db: DB) => db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all() as SchemaObject[];
const columns = (db: DB, name: string) => db.prepare(`PRAGMA table_xinfo(${quoted(name)})`).all() as Column[];
const frozen = new Database(':memory:');
const reference = (() => {
  try {
    frozen.exec(identitySchema);
    const schema = schemaObjects(frozen), tables = schema.filter(row => row.type === 'table' && !row.name.startsWith('sqlite_')).map(row => ({ name: row.name, columns: columns(frozen, row.name) }));
    if (tables.length !== 10) throw new Error('Frozen identity inventory requires review');
    return { schema, tables };
  } finally { frozen.close(); }
})();
export function assertIdentitySchema(db: DB) {
  if (JSON.stringify(schemaObjects(db)) !== JSON.stringify(reference.schema) || reference.tables.some(table => JSON.stringify(columns(db, table.name)) !== JSON.stringify(table.columns))) {
    throw new Error('Unsupported music identity schema; explicit review required');
  }
  if (db.pragma('user_version', { simple: true }) !== 0 || db.pragma('application_id', { simple: true }) !== 0 || db.pragma('encoding', { simple: true }) !== 'UTF-8') {
    throw new Error('Unsupported music identity database metadata; explicit review required');
  }
}

/** Private structural evidence only. No credential bodies or member identifiers.
 * Row numbers still identify migration_map rows; original signed SQLite rowids
 * and sequence values use decimal strings without JavaScript rounding. */
export function captureIdentitySource(db: DB): IdentitySourceEvidence {
  assertIdentitySchema(db);
  const rawSequences = db.prepare('SELECT name,seq,typeof(seq) AS storage FROM sqlite_sequence ORDER BY name').safeIntegers(true).all() as { name: string; seq: unknown; storage: string }[];
  const maximum = (db.prepare('SELECT max(id) AS maximum FROM link_audit').safeIntegers(true).get() as { maximum: bigint | null }).maximum;
  if (rawSequences.length > 1 || rawSequences.some(row => row.name !== 'link_audit' || row.storage !== 'integer' || typeof row.seq !== 'bigint' || row.seq < 0n || maximum !== null && row.seq < maximum) || maximum !== null && maximum > 0n && !rawSequences.length) {
    throw new Error('Unsupported music identity sequence; explicit review required');
  }
  return {
    version: 1, schema: schemaObjects(db),
    pragmas: { userVersion: Number(db.pragma('user_version', { simple: true })), applicationId: Number(db.pragma('application_id', { simple: true })), encoding: String(db.pragma('encoding', { simple: true })) },
    sqliteSequence: rawSequences.map(row => ({ name: row.name, seq: String(row.seq) })),
    tables: reference.tables.map(table => {
      const select = table.columns.map((column, index) => `typeof(${quoted(column.name)}) AS ${quoted('storage_' + index)}`);
      const rows = db.prepare(`SELECT rowid AS source_rowid,${select.join(',')} FROM ${quoted(table.name)} ORDER BY rowid`).safeIntegers(true).all() as Record<string, string | bigint>[];
      return { name: table.name, columns: columns(db, table.name), rows: rows.map((row, rowNumber) => ({ rowNumber, rowid: String(row.source_rowid), storageClasses: table.columns.map((_column, index) => String(row['storage_' + index])) })) };
    }),
  };
}
