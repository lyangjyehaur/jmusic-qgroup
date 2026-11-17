import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from './index';
function versionThree(path: string) {
  const db = openDatabase(path);
  db.exec(`DROP TABLE music_field_history; DROP TABLE music_profile_fields; DROP TABLE music_pin_history; DROP TABLE music_ownership_history; DROP TABLE music_claim_intents; DROP TABLE music_claim_attempts; DROP TABLE music_contact_history; DROP TABLE music_profile_contacts; UPDATE rebuild_schema SET version=3;
    INSERT INTO users VALUES('member','unusable','會員稱呼','before');
    INSERT INTO music_entries VALUES('e','原詞條','sub');
    INSERT INTO music_profiles VALUES('p1','member',7,'before',NULL),('p2',NULL,0,'before',NULL),('p3',NULL,0,'before','erased');
    INSERT INTO music_selections VALUES('p1','e',4,0);
    INSERT INTO music_legacy_profiles VALUES('p1','10001','舊成分稱呼',1,'private-pin','10001','{}','[]','oauth'),('p2','m_aaaaaaaaaaaaaaaaaaaaaaaa','獨立成分',1,'','','{}','[]','unlinked');`);
  return db;
}
describe('schema 3 → canonical music contacts', () => {
  it('preserves every prior table and stable profile while projecting immutable numeric and cleared native contacts', () => {
    const folder = mkdtempSync(join(tmpdir(), 'qgroup-contact-v4-')); const path = join(folder, 'state.sqlite3');
    try {
      const old = versionThree(path);
      const names = old.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='rebuild_schema'").all() as { name: string }[];
      const before = names.map(({ name }) => old.prepare('SELECT * FROM "' + name + '" ORDER BY rowid').all()); old.close();
      const next = openDatabase(path);
      expect(names.map(({ name }) => next.prepare('SELECT * FROM "' + name + '" ORDER BY rowid').all())).toEqual(before);
      expect(next.prepare('SELECT * FROM music_profile_contacts ORDER BY profile_id').all()).toEqual([
        { profile_id: 'p1', contact_qq: '10001', source: 'legacy', revision: 0, updated_at: 'before' },
        { profile_id: 'p2', contact_qq: '', source: 'self_reported', revision: 0, updated_at: 'before' },
      ]);
      expect(() => next.prepare("INSERT INTO music_profile_contacts VALUES('p3','10001','self_reported',0,'now')").run()).toThrow('UNIQUE');
      expect(next.pragma('foreign_key_check')).toEqual([]); next.close();
      const reopened = openDatabase(path); expect(reopened.prepare('SELECT version FROM rebuild_schema').get()).toEqual({ version: 13 }); expect(reopened.prepare('SELECT * FROM music_profile_contacts').all()).toHaveLength(2); reopened.close();
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });
  it('rolls back the complete migration on an existing-table collision', () => {
    const folder = mkdtempSync(join(tmpdir(), 'qgroup-contact-v4-fail-')); const path = join(folder, 'state.sqlite3');
    try {
      const old = versionThree(path); old.exec('CREATE TABLE music_contact_history(private_evidence TEXT)');
      const before = old.prepare('SELECT * FROM sqlite_master ORDER BY type,name').all(); old.close();
      expect(() => openDatabase(path)).toThrow('already exists'); const unchanged = new Database(path);
      expect(unchanged.prepare('SELECT version FROM rebuild_schema').get()).toEqual({ version: 3 }); expect(unchanged.prepare('SELECT * FROM sqlite_master ORDER BY type,name').all()).toEqual(before);
      expect(unchanged.prepare("SELECT revision FROM music_profiles WHERE id='p1'").get()).toEqual({ revision: 7 }); unchanged.close();
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });
});
