import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from './index';
function versionFour(path: string) {
  const db = openDatabase(path);
  db.exec("DROP TABLE music_field_history; DROP TABLE music_profile_fields; DROP TABLE music_pin_history; DROP TABLE music_ownership_history; DROP TABLE music_claim_intents; DROP TABLE music_claim_attempts; DROP TRIGGER rebuild_storage_no_insert; DROP TRIGGER rebuild_storage_no_update; DROP TRIGGER rebuild_storage_no_delete; DROP TABLE rebuild_storage; UPDATE rebuild_schema SET version=4; INSERT INTO users VALUES('member','unused','原稱呼','before'); INSERT INTO music_profiles VALUES('profile','member',7,'before',NULL)");
  db.prepare("INSERT INTO music_legacy_identity VALUES('login_attempts',0,?)").run(JSON.stringify({bucket:'qq:'+'a'.repeat(64),created:1794902400.25}));
  return db;
}
describe('schema 4 → persistent PIN recovery', () => {
  it('preserves prior data and private source evidence while projecting existing PIN limits once', () => {
    const folder=mkdtempSync(join(tmpdir(),'qgroup-claim-v5-'));const path=join(folder,'state.sqlite3');
    try {
      const old=versionFour(path);const tables=old.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='rebuild_schema'").all() as {name:string}[];
      const before=tables.map(({name})=>old.prepare('SELECT * FROM "'+name+'" ORDER BY rowid').all()); old.close();
      const next=openDatabase(path);expect(tables.map(({name})=>next.prepare('SELECT * FROM "'+name+'" ORDER BY rowid').all())).toEqual(before);
      expect(next.prepare('SELECT * FROM music_claim_attempts').all()).toEqual([{bucket:'qq:'+'a'.repeat(64),created:1794902400.25}]); expect(next.pragma('foreign_key_check')).toEqual([]);next.close();
      const reopened=openDatabase(path);expect(reopened.prepare('SELECT version FROM rebuild_schema').get()).toEqual({version:14});expect(reopened.prepare('SELECT * FROM music_claim_attempts').all()).toHaveLength(1);reopened.close();
    }finally{rmSync(folder,{recursive:true,force:true});}
  });
  it('rolls back DDL, marker and projections when a private source rate bucket is malformed',()=>{
    const folder=mkdtempSync(join(tmpdir(),'qgroup-claim-v5-fail-'));const path=join(folder,'state.sqlite3');
    try{
      const old=versionFour(path);old.prepare("INSERT INTO music_legacy_identity VALUES('login_attempts',1,?)").run('{"bucket":"unclassified-private","created":"invalid"}');const before=old.prepare('SELECT * FROM sqlite_master ORDER BY name').all();old.close();
      expect(()=>openDatabase(path)).toThrow('CHECK constraint');const unchanged=new Database(path);expect(unchanged.prepare('SELECT version FROM rebuild_schema').get()).toEqual({version:4});expect(unchanged.prepare('SELECT * FROM sqlite_master ORDER BY name').all()).toEqual(before);expect(unchanged.prepare('SELECT * FROM music_legacy_identity').all()).toHaveLength(2);unchanged.close();
    }finally{rmSync(folder,{recursive:true,force:true});}
  });
});
