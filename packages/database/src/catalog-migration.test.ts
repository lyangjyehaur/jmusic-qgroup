import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe,expect,it } from 'vitest';
import { musicCreatedIds,openDatabase } from './index';
import { fixture } from '../../../apps/api/testsupport/fixture';
import { adminCatalogFixture,catalogProfiles } from '../../../apps/api/testsupport/admin-catalog-fixture';
function versionEleven(path:string){
  const db=openDatabase(path);fixture(db);adminCatalogFixture(db);
  db.exec('DROP TRIGGER music_entry_creations_erasure; DROP TABLE music_entry_creations; DROP TABLE music_catalog_actions; UPDATE rebuild_schema SET version=11;');return db;
}
describe('schema 11 → catalog reference preservation',()=>{
  it('preserves every existing table and DDL, retains both creation-list semantics and actual Python bot reads, and reopens once',()=>{
    const root=mkdtempSync(join(tmpdir(),'qgroup-catalog-migration-')),path=join(root,'synthetic.db');try{
      const old=versionEleven(path),tables=(old.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='rebuild_schema' ORDER BY name").all() as {name:string}[]).map(r=>r.name),snapshot=tables.map(name=>old.prepare('SELECT * FROM "'+name+'"').all()),ddl=old.prepare("SELECT name,sql FROM sqlite_master WHERE name!='rebuild_schema' ORDER BY name").all() as {name:string;sql:string|null}[];
      const probe=()=>JSON.parse(execFileSync('python3',['tools/rebuild/probe-auth-bot.py',path],{encoding:'utf8'})),bot=probe();old.close();
      const next=openDatabase(path);expect(next.prepare('SELECT version FROM rebuild_schema').get()).toEqual({version:12});expect(tables.map(name=>next.prepare('SELECT * FROM "'+name+'"').all())).toEqual(snapshot);for(const row of ddl)expect(next.prepare('SELECT name,sql FROM sqlite_master WHERE name=?').get(row.name)).toEqual(row);
      expect(musicCreatedIds(next,catalogProfiles.alice)).toEqual(['sub-0']);expect(musicCreatedIds(next,catalogProfiles.bob)).toEqual(['sub-1','sub-0','main-0']);expect(probe()).toEqual(bot);expect(next.pragma('foreign_key_check')).toEqual([]);next.close();
      const again=openDatabase(path);expect(again.prepare('SELECT count(*) n FROM music_catalog_actions').get()).toEqual({n:0});again.close();
    }finally{rmSync(root,{recursive:true,force:true});}
  });
  it('rolls all DDL, trigger and version additions back on an incompatible table collision',()=>{
    const root=mkdtempSync(join(tmpdir(),'qgroup-catalog-collision-')),path=join(root,'synthetic.db');try{
      const old=versionEleven(path);old.exec('CREATE TABLE music_entry_creations(profile_id TEXT)');const ddl=old.prepare('SELECT * FROM sqlite_master ORDER BY name').all();old.close();
      expect(()=>openDatabase(path)).toThrow();const raw=new Database(path);expect(raw.prepare('SELECT version FROM rebuild_schema').get()).toEqual({version:11});expect(raw.prepare('SELECT * FROM sqlite_master ORDER BY name').all()).toEqual(ddl);raw.close();
    }finally{rmSync(root,{recursive:true,force:true});}
  });
  it('removes transferred creation references on profile erasure while preserving a term owned by someone else',()=>{
    const db=openDatabase(':memory:');try{fixture(db);adminCatalogFixture(db);db.prepare('INSERT INTO music_entry_creations VALUES(?,?,0)').run(catalogProfiles.alice,'sub-1');
      db.prepare("UPDATE music_profiles SET user_id=NULL,erased_at='erased' WHERE id=?").run(catalogProfiles.alice);
      expect(db.prepare('SELECT * FROM music_entry_creations').all()).toEqual([]);expect(db.prepare("SELECT id FROM music_entries WHERE id='sub-1'").get()).toEqual({id:'sub-1'});
    }finally{db.close();}
  });
});
