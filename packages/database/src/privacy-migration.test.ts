import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDatabase } from './index';
import { legacySchema } from './legacy-schema';
import { schemaV1 } from './schema-v1';
function seedVersionOne(path: string) {
  const db = new Database(path);
  db.exec(legacySchema); db.exec(schemaV1);
  db.exec(`INSERT INTO users VALUES('member','unusable','合成會員','before');
    INSERT INTO music_entries VALUES('entry','合成詞條','main');
    INSERT INTO music_profiles VALUES('stable-profile','member',7,'before');
    INSERT INTO music_selections VALUES('stable-profile','entry',4,0);
    INSERT INTO music_profile_audit(profile_id,revision,actor_id,before_json,after_json,created_at)
      VALUES('stable-profile',7,'member','null','{"id":"stable-profile","revision":7}','before');
    INSERT INTO request_results VALUES('member','old-save','old-signature','{"id":"stable-profile","revision":7}',200,'before');
    INSERT INTO request_results VALUES('member','other-route','other-signature','{"nickname":"合成會員"}',200,'before');`);
  return db;
}
describe('version 1 → privacy migration', () => {
  it('preserves stable IDs, selected levels, history, old receipt links, all frozen tables and triggers, and reopens idempotently', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qgroup-migrate-'));
    try {
      const path = join(dir, 'state.sqlite3'); const old = seedVersionOne(path);
      const history = old.prepare('SELECT * FROM music_profile_audit').all();
      const frozen = old.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'music_%' AND name NOT LIKE 'sqlite_%' AND name!='rebuild_schema' ORDER BY type,name").all();
      old.close();
      const upgraded = openDatabase(path);
      expect(upgraded.prepare('SELECT * FROM music_profiles').get()).toEqual({ id: 'stable-profile', user_id: 'member', revision: 7, updated_at: 'before', erased_at: null });
      expect(upgraded.prepare('SELECT * FROM music_profile_audit').all()).toEqual(history);
      expect(upgraded.prepare('SELECT * FROM music_selections').all()).toEqual([{ profile_id: 'stable-profile', entry_id: 'entry', level: 4, position: 0 }]);
      for (const item of frozen as { type: string; name: string; sql: string }[]) expect(upgraded.prepare('SELECT type,name,sql FROM sqlite_master WHERE name=? AND type=?').get(item.name, item.type)).toEqual(item);
      expect(upgraded.prepare('SELECT * FROM music_profile_receipts').all()).toEqual([{ user_id: 'member', request_key: 'old-save', profile_id: 'stable-profile' }]);
      expect(() => upgraded.prepare('DELETE FROM music_profile_audit').run()).toThrow('append-only');
      upgraded.prepare('UPDATE music_profiles SET user_id=NULL').run();
      expect(upgraded.pragma('foreign_key_check')).toEqual([]); upgraded.close();
      const reopened = openDatabase(path); expect(reopened.prepare('SELECT version FROM rebuild_schema').get()).toEqual({ version: 9 });
      expect(reopened.prepare('SELECT user_id FROM music_profiles').get()).toEqual({ user_id: null });
      expect(reopened.prepare('SELECT * FROM music_profile_receipts').all()).toHaveLength(1); reopened.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('rolls back all DDL/data/marker changes if a source foreign key is invalid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qgroup-migrate-fail-'));
    try {
      const path = join(dir, 'state.sqlite3'); const old = seedVersionOne(path);
      old.pragma('foreign_keys = OFF');
      old.prepare("INSERT INTO music_selections VALUES('missing','entry',1,0)").run();
      const before = old.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all(); old.close();
      expect(() => openDatabase(path)).toThrow('foreign key check failed');
      const unchanged = new Database(path);
      expect(unchanged.prepare('SELECT version FROM rebuild_schema').get()).toEqual({ version: 1 });
      expect(unchanged.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all()).toEqual(before);
      expect(unchanged.prepare('SELECT id,user_id,revision FROM music_profiles').get()).toEqual({ id: 'stable-profile', user_id: 'member', revision: 7 });
      unchanged.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('rejects a future version before changing journal mode or schema', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qgroup-migrate-future-'));
    try {
      const path = join(dir, 'state.sqlite3'); const old = seedVersionOne(path); old.exec('UPDATE rebuild_schema SET version=99'); old.close();
      expect(() => openDatabase(path)).toThrow('Unsupported rebuild schema');
      const unchanged = new Database(path); expect(unchanged.pragma('journal_mode', { simple: true })).toBe('delete'); unchanged.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
