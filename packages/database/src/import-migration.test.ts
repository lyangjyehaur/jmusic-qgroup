import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from './index';

const added = ['music_legacy_erasures', 'music_documents', 'music_legacy_identity', 'music_entry_details', 'music_legacy_profiles', 'migration_map', 'migration_runs'];
function versionTwo(path: string) {
  const db = openDatabase(path);
  db.exec("INSERT INTO users VALUES('member','unusable','保留稱呼','before'); INSERT INTO music_entries VALUES('entry','保留詞條','sub'); INSERT INTO music_profiles VALUES('profile','member',4,'before',NULL); INSERT INTO music_selections VALUES('profile','entry',3,0)");
  for (const table of ['music_field_history','music_profile_fields','music_pin_history','music_ownership_history','music_claim_intents','music_claim_attempts','music_contact_history','music_profile_contacts']) db.exec('DROP TABLE ' + table);
  for (const table of added) db.exec('DROP TABLE ' + table);
  db.exec('UPDATE rebuild_schema SET version=2'); db.close();
}
describe('schema 2 → import migration', () => {
  it('preserves existing profiles and all old structures, and reopens without duplicating import tables', () => {
    const folder = mkdtempSync(join(tmpdir(), 'qgroup-v3-')); const path = join(folder, 'state.sqlite3');
    try {
      versionTwo(path); const source = new Database(path); const schema = source.prepare("SELECT name,sql FROM sqlite_master WHERE name!='rebuild_schema' ORDER BY name").all() as { name: string; sql: string | null }[]; const choices = source.prepare('SELECT * FROM music_selections').all(); source.close();
      const migrated = openDatabase(path);
      for (const row of schema) expect(migrated.prepare('SELECT name,sql FROM sqlite_master WHERE name=?').get(row.name)).toEqual(row);
      expect(migrated.prepare('SELECT * FROM music_selections').all()).toEqual(choices); expect(migrated.pragma('foreign_key_check')).toEqual([]); migrated.close();
      const next = openDatabase(path); expect(next.prepare('SELECT version FROM rebuild_schema').get()).toEqual({ version: 10 }); expect(next.prepare('SELECT * FROM music_profiles').all()).toHaveLength(1); next.close();
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });
  it('rolls back the whole version migration on DDL collision, leaving old data and marker intact', () => {
    const folder = mkdtempSync(join(tmpdir(), 'qgroup-v3-fail-')); const path = join(folder, 'state.sqlite3');
    try {
      versionTwo(path); const source = new Database(path); source.exec('CREATE TABLE music_documents(important TEXT)'); const before = source.prepare('SELECT * FROM sqlite_master ORDER BY name').all(); source.close();
      expect(() => openDatabase(path)).toThrow('already exists'); const after = new Database(path);
      expect(after.prepare('SELECT * FROM sqlite_master ORDER BY name').all()).toEqual(before); expect(after.prepare('SELECT version FROM rebuild_schema').get()).toEqual({ version: 2 }); expect(after.prepare('SELECT * FROM music_selections').all()).toHaveLength(1); after.close();
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });
});
