import { createHash } from 'node:crypto';
import type { DB } from '@qgroup/database';
import type { IdentitySourceEvidence } from './identity-source';

const quoted = (name: string) => '"' + name.replaceAll('"', '""') + '"';
function reject(): never { throw new Error('Music identity source reconciliation failed; no candidate was published'); }
/** Re-read the read-only original directly. Never calls the importer, source
 * capture, or migration statuses to derive the expected structural evidence. */
export function reconcileIdentitySource(candidate: DB, source: DB) {
  const schema = source.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all() as IdentitySourceEvidence['schema'];
  const tables = schema.filter(row => row.type === 'table' && !row.name.startsWith('sqlite_')).map(table => {
    const columns = source.prepare(`PRAGMA table_xinfo(${quoted(table.name)})`).all() as IdentitySourceEvidence['tables'][number]['columns'];
    const rows = source.prepare(`SELECT rowid AS original_rowid,${columns.map((column, index) => `typeof(${quoted(column.name)}) AS ${quoted('type_' + index)}`).join(',')} FROM ${quoted(table.name)} ORDER BY rowid`).safeIntegers(true).all() as Record<string, string | bigint>[];
    return { name: table.name, columns, rows: rows.map((row, rowNumber) => ({ rowNumber, rowid: String(row.original_rowid), storageClasses: columns.map((_column, index) => String(row['type_' + index])) })) };
  });
  const sequences = source.prepare('SELECT name,seq FROM sqlite_sequence ORDER BY name').safeIntegers(true).all() as { name: string; seq: bigint }[];
  const evidence: IdentitySourceEvidence = {
    version: 1, schema,
    pragmas: { userVersion: Number(source.pragma('user_version', { simple: true })), applicationId: Number(source.pragma('application_id', { simple: true })), encoding: String(source.pragma('encoding', { simple: true })) },
    sqliteSequence: sequences.map(row => ({ name: row.name, seq: String(row.seq) })), tables,
  };
  const records = candidate.prepare("SELECT position,payload_json FROM music_documents WHERE kind='identity_source' ORDER BY position").all() as { position: number; payload_json: string }[];
  const encoded = JSON.stringify(evidence);
  if (records.length !== 1 || records[0]!.position !== 0 || records[0]!.payload_json !== encoded) reject();
  return { evidence, report: { version: 1, verified: true, tableCount: tables.length, schemaObjects: schema.length, sourceRows: tables.reduce((sum, table) => sum + table.rows.length, 0), sequenceRows: sequences.length, digest: createHash('sha256').update(encoded).digest('hex') } };
}
