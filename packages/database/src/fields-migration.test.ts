import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, seedMusicFields } from './index';
function versionSeven(path: string, fields = JSON.stringify({ note: '原文\n' + '字'.repeat(150), noteAt: 123.456, gender: '自訂'.repeat(8), genderPublic: true })) {
  const db = openDatabase(path);
  db.exec(`DROP TABLE music_field_history; DROP TABLE music_profile_fields; DROP TRIGGER rebuild_storage_no_insert; DROP TRIGGER rebuild_storage_no_update; DROP TRIGGER rebuild_storage_no_delete; DROP TABLE rebuild_storage; UPDATE rebuild_schema SET version=7;
    INSERT INTO users VALUES('member','unusable','帳號稱呼','before');
    INSERT INTO music_profiles VALUES('legacy',NULL,7,'before',NULL),('native','member',2,'native-time',NULL),('erased',NULL,0,'before','erased');
    INSERT INTO music_ownership_history(id,profile_id,revision,actor_ref,reason,created_at) VALUES(900,'legacy',7,'account:member','保留歷史','before');`);
  db.prepare('INSERT INTO music_legacy_profiles VALUES(?,?,?,?,?,?,?,?,?)').run('legacy', '10001', '原'.repeat(20), 1, 'private', '10001', fields, '[]', 'unlinked');
  return db;
}
describe('schema 7 → independent music fields', () => {
  it('preserves raw imported values, freezes native names and all prior rows/DDL/high-water marks, and reopens without overwriting edits', () => {
    const folder = mkdtempSync(join(tmpdir(), 'qgroup-fields-v8-')); const path = join(folder, 'state.sqlite3');
    try {
      const old = versionSeven(path);
      const tables = old.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='rebuild_schema' ORDER BY name").all() as {name:string}[];
      const before = tables.map(({name}) => old.prepare('SELECT * FROM "' + name + '" ORDER BY rowid').all());
      const schema = old.prepare("SELECT name,sql FROM sqlite_master WHERE name!='rebuild_schema' ORDER BY name").all() as {name:string;sql:string|null}[]; old.close();
      const next = openDatabase(path);
      expect(tables.map(({name}) => next.prepare('SELECT * FROM "' + name + '" ORDER BY rowid').all())).toEqual(before);
      for (const row of schema) expect(next.prepare('SELECT name,sql FROM sqlite_master WHERE name=?').get(row.name)).toEqual(row);
      expect(next.prepare('SELECT * FROM music_profile_fields ORDER BY profile_id').all()).toEqual([
        { profile_id:'legacy',name:'原'.repeat(20),note:'原文\n'+'字'.repeat(150),note_at:123.456,gender:'自訂'.repeat(8),gender_public:1,revision:0,updated_at:'before' },
        { profile_id:'native',name:'帳號稱呼',note:'',note_at:0,gender:'',gender_public:0,revision:0,updated_at:'native-time' },
      ]);
      next.prepare("UPDATE users SET nickname='新帳號稱呼'").run(); next.prepare("UPDATE music_profile_fields SET note='後來編輯' WHERE profile_id='legacy'").run();
      next.transaction(() => seedMusicFields(next))(); expect(next.prepare("SELECT note FROM music_profile_fields WHERE profile_id='legacy'").get()).toEqual({note:'後來編輯'});
      expect(next.pragma('foreign_key_check')).toEqual([]); next.close();
      const reopened = openDatabase(path); expect(reopened.prepare('SELECT version FROM rebuild_schema').get()).toEqual({version:14}); expect(reopened.prepare("SELECT name FROM music_profile_fields WHERE profile_id='native'").get()).toEqual({name:'帳號稱呼'}); reopened.close();
    } finally { rmSync(folder, {recursive:true,force:true}); }
  });
  it('rolls back DDL and version on a table collision or invalid private source instead of losing or coercing evidence', () => {
    for (const source of [undefined, '{"note":12}', '{"noteAt":-1}', '{"genderPublic":"false"}', '[]', '{']) {
      const folder = mkdtempSync(join(tmpdir(), 'qgroup-fields-fail-')); const path = join(folder, 'state.sqlite3');
      try {
        const old = versionSeven(path, source);
        if (source === undefined) old.exec("CREATE TABLE music_field_history(private_evidence TEXT); INSERT INTO music_field_history VALUES('retained')");
        const schema = old.prepare('SELECT * FROM sqlite_master ORDER BY name').all(); const evidence = old.prepare('SELECT * FROM music_legacy_profiles').all(); old.close();
        expect(() => openDatabase(path)).toThrow(); const unchanged = new Database(path);
        expect(unchanged.prepare('SELECT version FROM rebuild_schema').get()).toEqual({version:7}); expect(unchanged.prepare('SELECT * FROM sqlite_master ORDER BY name').all()).toEqual(schema); expect(unchanged.prepare('SELECT * FROM music_legacy_profiles').all()).toEqual(evidence); unchanged.close();
      } finally { rmSync(folder, {recursive:true,force:true}); }
    }
  });
});
