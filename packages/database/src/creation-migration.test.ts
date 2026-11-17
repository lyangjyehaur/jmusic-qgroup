import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from './index';
import { fixture } from '../../../apps/api/testsupport/fixture';
import { nicknameFixture } from '../../../apps/api/testsupport/nickname-fixture';
function versionNine(path: string) {
  const db = openDatabase(path); fixture(db); nicknameFixture(db);
  db.exec(`DROP TRIGGER music_creation_insert; DROP TRIGGER music_creation_legacy; DROP TRIGGER music_creation_erasure;
    DROP TABLE music_profile_creation; UPDATE rebuild_schema SET version=9;
    INSERT INTO music_profiles VALUES('audited','alice',2,'2026-11-17',NULL),('unknown',NULL,4,'2026-11-17',NULL),
      ('legacy',NULL,0,'2026-11-17',NULL),('erased',NULL,1,'2026-11-17','2026-11-17');
    INSERT INTO music_legacy_profiles VALUES('legacy','10001','舊成分',1,'private','10001','{"createdAt":1}','[]','unlinked');
    INSERT INTO music_profile_audit(profile_id,revision,actor_id,before_json,after_json,created_at)
      VALUES('audited',1,'alice','null','{}','2020-01-01T00:00:00Z'),('audited',2,'alice','{}','{}','2026-11-17T00:00:00Z');`);
  return db;
}
describe('schema 9 → immutable native music creation provenance', () => {
  it('recovers only proven creation, preserves all original tables and Python bot reads, and reopens idempotently', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qgroup-creation-')), path = join(dir, 'isolated.sqlite3');
    try {
      const old = versionNine(path);
      const tables = old.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='rebuild_schema' ORDER BY name").all() as { name: string }[];
      const snapshot = tables.map(({ name }) => old.prepare('SELECT * FROM "' + name + '" ORDER BY rowid').all());
      const ddl = old.prepare("SELECT name,sql FROM sqlite_master WHERE name!='rebuild_schema' ORDER BY name").all() as { name: string; sql: string | null }[];
      const probe = () => JSON.parse(execFileSync('python3', ['tools/rebuild/probe-auth-bot.py', path], { encoding: 'utf8' }));
      const bot = probe(); old.close();
      const db = openDatabase(path);
      expect(db.prepare('SELECT version FROM rebuild_schema').get()).toEqual({ version: 12 });
      expect(tables.map(({ name }) => db.prepare('SELECT * FROM "' + name + '" ORDER BY rowid').all())).toEqual(snapshot);
      for (const row of ddl) expect(db.prepare('SELECT name,sql FROM sqlite_master WHERE name=?').get(row.name)).toEqual(row);
      expect(db.prepare('SELECT * FROM music_profile_creation ORDER BY profile_id').all()).toEqual([
        { profile_id: 'audited', created_at: '2020-01-01T00:00:00Z' }, { profile_id: 'unknown', created_at: null },
      ]);
      expect(probe()).toEqual(bot); expect(db.pragma('foreign_key_check')).toEqual([]); db.close();
      const reopened = openDatabase(path);
      expect(reopened.prepare('SELECT * FROM music_profile_creation ORDER BY profile_id').all()).toHaveLength(2); reopened.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('retains native creation through edits/reassignment and removes it on erasure or legacy import', () => {
    const db = openDatabase(':memory:');
    try {
      db.exec(`INSERT INTO music_profiles VALUES('blank',NULL,0,'2020-01-01',NULL);
        UPDATE music_profiles SET updated_at='2026-11-17',revision=9 WHERE id='blank';`);
      expect(db.prepare('SELECT created_at FROM music_profile_creation').get()).toEqual({ created_at: '2020-01-01' });
      db.exec("UPDATE music_profiles SET erased_at='erased' WHERE id='blank'");
      expect(db.prepare('SELECT * FROM music_profile_creation').all()).toEqual([]);
      db.exec(`INSERT INTO music_profiles VALUES('imported',NULL,0,'import-time',NULL);
        INSERT INTO music_legacy_profiles VALUES('imported','10001','舊',1,'','','{}','[]','unlinked');`);
      expect(db.prepare('SELECT * FROM music_profile_creation').all()).toEqual([]);
    } finally { db.close(); }
  });
  it('rolls back added DDL, version and source data on a conflicting table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qgroup-creation-fail-')), path = join(dir, 'isolated.sqlite3');
    try {
      const old = versionNine(path); old.exec("CREATE TABLE music_profile_creation(private_evidence TEXT); INSERT INTO music_profile_creation VALUES('retained')");
      const schema = old.prepare('SELECT * FROM sqlite_master ORDER BY name').all(); old.close();
      expect(() => openDatabase(path)).toThrow(); const raw = new Database(path);
      expect(raw.prepare('SELECT version FROM rebuild_schema').get()).toEqual({ version: 9 });
      expect(raw.prepare('SELECT * FROM sqlite_master ORDER BY name').all()).toEqual(schema);
      expect(raw.prepare('SELECT * FROM music_profile_creation').all()).toEqual([{ private_evidence: 'retained' }]); raw.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
