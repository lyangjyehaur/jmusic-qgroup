import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from './index';
import { fixture } from '../../../apps/api/testsupport/fixture';
const drop = 'DROP TRIGGER rebuild_storage_no_insert; DROP TRIGGER rebuild_storage_no_update; DROP TRIGGER rebuild_storage_no_delete; DROP TABLE rebuild_storage; UPDATE rebuild_schema SET version=13';
describe('schema 13 → storage lineage and recovery gate', () => {
  it('preserves all existing data, DDL, sequences and Python bot reads with stable independent lineage', () => {
    const root=mkdtempSync(join(tmpdir(),'qgroup-storage-')),path=join(root,'state.sqlite3');
    try {
      const old=openDatabase(path); fixture(old); old.exec(drop); old.exec("UPDATE sqlite_sequence SET seq=9000 WHERE name='music_profile_audit'");
      const tables=(old.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='rebuild_schema' ORDER BY name").all() as {name:string}[]).map(t=>t.name);
      const rows=tables.map(t=>old.prepare('SELECT * FROM "'+t+'" ORDER BY rowid').all());
      const ddl=old.prepare("SELECT name,sql FROM sqlite_master WHERE name!='rebuild_schema' ORDER BY name").all() as {name:string}[];
      const probe=()=>execFileSync('python3',['tools/rebuild/probe-auth-bot.py',path],{encoding:'utf8'}),bot=probe();old.close();
      const next=openDatabase(path);expect(tables.map(t=>next.prepare('SELECT * FROM "'+t+'" ORDER BY rowid').all())).toEqual(rows);
      for(const row of ddl)expect(next.prepare('SELECT name,sql FROM sqlite_master WHERE name=?').get(row.name)).toEqual(row);
      expect(probe()).toBe(bot);const storage=next.prepare('SELECT * FROM rebuild_storage').get();expect(storage).toMatchObject({id:1,recovery_required:0,lineage_id:expect.stringMatching(/^[a-f0-9]{32}$/)});
      expect(()=>next.exec("UPDATE rebuild_storage SET lineage_id=lower(hex(randomblob(16)))")).toThrow('immutable');expect(()=>next.exec('DELETE FROM rebuild_storage')).toThrow('immutable');expect(()=>next.exec("INSERT OR REPLACE INTO rebuild_storage(id,lineage_id) VALUES(1,lower(hex(randomblob(16))))")).toThrow('immutable');next.close();
      const again=openDatabase(path),other=openDatabase(':memory:');expect(again.prepare('SELECT * FROM rebuild_storage').get()).toEqual(storage);expect(other.prepare('SELECT * FROM rebuild_storage').get()).not.toEqual(storage);again.close();other.close();
    }finally{rmSync(root,{recursive:true,force:true});}
  });
  it('rolls back a collision, preserving evidence and version',()=>{
    const root=mkdtempSync(join(tmpdir(),'qgroup-storage-collision-')),path=join(root,'state.sqlite3');
    try {
      const db=openDatabase(path);db.exec(drop);db.exec("CREATE TABLE rebuild_storage(private_evidence TEXT); INSERT INTO rebuild_storage VALUES('retain')");const ddl=db.prepare('SELECT * FROM sqlite_master ORDER BY name').all();db.close();
      expect(()=>openDatabase(path)).toThrow();const raw=new Database(path);expect(raw.prepare('SELECT * FROM sqlite_master ORDER BY name').all()).toEqual(ddl);expect(raw.prepare('SELECT version FROM rebuild_schema').get()).toEqual({version:13});expect(raw.prepare('SELECT * FROM rebuild_storage').all()).toEqual([{private_evidence:'retain'}]);raw.close();
    }finally{rmSync(root,{recursive:true,force:true});}
  });
});
