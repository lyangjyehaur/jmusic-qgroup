import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from './index';
describe('schema 6 → PIN reset audit', () => {
  it('preserves all existing rows, structures and high-water marks and reopens idempotently', () => {
    const folder=mkdtempSync(join(tmpdir(),'qgroup-pin-v7-'));const path=join(folder,'state.sqlite3');
    try {
      const old=openDatabase(path);old.exec("DROP TABLE music_field_history; DROP TABLE music_profile_fields; DROP TABLE music_pin_history; DROP TRIGGER rebuild_storage_no_insert; DROP TRIGGER rebuild_storage_no_update; DROP TRIGGER rebuild_storage_no_delete; DROP TABLE rebuild_storage; UPDATE rebuild_schema SET version=6; INSERT INTO users VALUES('member','unusable','合成稱呼','before'); INSERT INTO music_profiles VALUES('profile','member',7,'before',NULL); INSERT INTO music_ownership_history(id,profile_id,revision,actor_ref,reason,created_at) VALUES(100,'profile',7,'account:member','原歷史','before')");
      const tables=old.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='rebuild_schema' ORDER BY name").all() as {name:string}[];
      const before=tables.map(({name})=>old.prepare('SELECT * FROM "'+name+'" ORDER BY rowid').all());
      const schema=old.prepare("SELECT name,sql FROM sqlite_master WHERE name!='rebuild_schema' ORDER BY name").all() as {name:string;sql:string|null}[];old.close();
      const next=openDatabase(path);expect(tables.map(({name})=>next.prepare('SELECT * FROM "'+name+'" ORDER BY rowid').all())).toEqual(before);for(const row of schema)expect(next.prepare('SELECT name,sql FROM sqlite_master WHERE name=?').get(row.name)).toEqual(row);expect(next.pragma('foreign_key_check')).toEqual([]);next.close();
      const reopened=openDatabase(path);expect(reopened.prepare('SELECT version FROM rebuild_schema').get()).toEqual({version:14});expect(reopened.prepare('SELECT * FROM music_pin_history').all()).toEqual([]);reopened.close();
    }finally{rmSync(folder,{recursive:true,force:true});}
  });
  it('rolls DDL and marker back on collision while preserving private evidence', () => {
    const folder=mkdtempSync(join(tmpdir(),'qgroup-pin-v7-fail-'));const path=join(folder,'state.sqlite3');
    try {
      const old=openDatabase(path);old.exec("DROP TABLE music_field_history; DROP TABLE music_profile_fields; DROP TABLE music_pin_history; DROP TRIGGER rebuild_storage_no_insert; DROP TRIGGER rebuild_storage_no_update; DROP TRIGGER rebuild_storage_no_delete; DROP TABLE rebuild_storage; UPDATE rebuild_schema SET version=6; CREATE TABLE music_pin_history(private_evidence TEXT); INSERT INTO music_pin_history VALUES('retained')");const before=old.prepare('SELECT * FROM sqlite_master ORDER BY name').all();old.close();
      expect(()=>openDatabase(path)).toThrow('already exists');const unchanged=new Database(path);expect(unchanged.prepare('SELECT version FROM rebuild_schema').get()).toEqual({version:6});expect(unchanged.prepare('SELECT * FROM sqlite_master ORDER BY name').all()).toEqual(before);expect(unchanged.prepare('SELECT * FROM music_pin_history').all()).toEqual([{private_evidence:'retained'}]);unchanged.close();
    }finally{rmSync(folder,{recursive:true,force:true});}
  });
});
