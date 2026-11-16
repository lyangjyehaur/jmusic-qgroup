import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from './index';
describe('schema 5 → ownership audit', () => {
  it('preserves every existing row and trigger and reopens without duplicating schema', () => {
    const folder=mkdtempSync(join(tmpdir(),'qgroup-ownership-v6-'));const path=join(folder,'state.sqlite3');
    try {
      const old=openDatabase(path);old.exec("DROP TABLE music_pin_history; DROP TABLE music_ownership_history; UPDATE rebuild_schema SET version=5; INSERT INTO users VALUES('member','unused','原稱呼','before'); INSERT INTO music_profiles VALUES('profile','member',7,'before',NULL)");
      const tables=old.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='rebuild_schema'").all() as {name:string}[];
      const before=tables.map(({name})=>old.prepare('SELECT * FROM "'+name+'" ORDER BY rowid').all());const schema=old.prepare("SELECT name,sql FROM sqlite_master WHERE name!='rebuild_schema' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string;sql:string}[];old.close();
      const next=openDatabase(path);expect(tables.map(({name})=>next.prepare('SELECT * FROM "'+name+'" ORDER BY rowid').all())).toEqual(before);for(const row of schema)expect(next.prepare('SELECT name,sql FROM sqlite_master WHERE name=?').get(row.name)).toEqual(row);expect(next.pragma('foreign_key_check')).toEqual([]);next.close();
      const reopened=openDatabase(path);expect(reopened.prepare('SELECT version FROM rebuild_schema').get()).toEqual({version:7});expect(reopened.prepare('SELECT * FROM music_ownership_history').all()).toEqual([]);reopened.close();
    } finally {rmSync(folder,{recursive:true,force:true});}
  });
  it('rolls the version and DDL back on collision, leaving the existing private table intact',()=>{
    const folder=mkdtempSync(join(tmpdir(),'qgroup-ownership-v6-fail-'));const path=join(folder,'state.sqlite3');
    try {
      const old=openDatabase(path);old.exec("DROP TABLE music_pin_history; DROP TABLE music_ownership_history; UPDATE rebuild_schema SET version=5; CREATE TABLE music_ownership_history(private_evidence TEXT); INSERT INTO music_ownership_history VALUES('retained')");const before=old.prepare('SELECT * FROM sqlite_master ORDER BY name').all();old.close();
      expect(()=>openDatabase(path)).toThrow('already exists');const unchanged=new Database(path);expect(unchanged.prepare('SELECT version FROM rebuild_schema').get()).toEqual({version:5});expect(unchanged.prepare('SELECT * FROM sqlite_master ORDER BY name').all()).toEqual(before);expect(unchanged.prepare('SELECT * FROM music_ownership_history').all()).toEqual([{private_evidence:'retained'}]);unchanged.close();
    } finally {rmSync(folder,{recursive:true,force:true});}
  });
});
