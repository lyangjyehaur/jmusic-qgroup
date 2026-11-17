import Database from 'better-sqlite3';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe,expect,it } from 'vitest';
import { openDatabase } from './index';
import { fixture } from '../../../apps/api/testsupport/fixture';
function versionTen(path:string){const db=openDatabase(path);fixture(db);db.exec('DROP TRIGGER music_shouts_erasure; DROP TABLE music_shouts; DROP TABLE music_shout_authors; DROP TABLE music_shout_deletions; UPDATE rebuild_schema SET version=10;');return db;}
describe('schema 10 → native shouts',()=>{
  it('preserves all source tables and bot reads, projects both native and legacy authors once, and keeps fractional timestamps and original bytes',()=>{
    const dir=mkdtempSync(join(tmpdir(),'qgroup-shout-migrate-')),path=join(dir,'synthetic.db');
    try{const old=versionTen(path);old.exec("INSERT INTO music_profiles VALUES('native','alice',1,'synthetic',NULL),('legacy',NULL,0,'synthetic',NULL); INSERT INTO music_legacy_profiles VALUES('legacy','10001','舊成分',1,'private','10001','{}','[]','unlinked');");
      for(const [kind,index,value] of [['shouts',0,{id:'active',qq:'native',name:'原名',text:'公開內容',createdAt:'123.75'}],['shoutHistory',0,{id:'archived',qq:'10001',name:'舊名稱',text:'舊內容',createdAt:12,archivedAt:33}]] as const)old.prepare('INSERT INTO music_documents VALUES(?,?,?)').run(kind,index,JSON.stringify(value));
      const tables=(old.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='rebuild_schema' ORDER BY name").all() as {name:string}[]).map(r=>r.name),snapshot=tables.map(name=>old.prepare('SELECT * FROM "'+name+'"').all()),ddl=old.prepare("SELECT name,sql FROM sqlite_master WHERE name!='rebuild_schema' ORDER BY name").all() as {name:string;sql:string|null}[];
      const probe=()=>JSON.parse(execFileSync('python3',['tools/rebuild/probe-auth-bot.py',path],{encoding:'utf8'})),bot=probe();old.close();
      const db=openDatabase(path);expect(db.prepare('SELECT version FROM rebuild_schema').get()).toEqual({version:13});expect(tables.map(name=>db.prepare('SELECT * FROM "'+name+'"').all())).toEqual(snapshot);
      for(const row of ddl)expect(db.prepare('SELECT name,sql FROM sqlite_master WHERE name=?').get(row.name)).toEqual(row);
      expect(db.prepare('SELECT id,profile_id,created_at,archived_at FROM music_shouts ORDER BY ordinal').all()).toEqual([{id:'archived',profile_id:'legacy',created_at:12,archived_at:33},{id:'active',profile_id:'native',created_at:123.75,archived_at:null}]);expect(probe()).toEqual(bot);db.close();
      const again=openDatabase(path);expect(again.prepare('SELECT count(*) n FROM music_shouts').get()).toEqual({n:2});expect(again.pragma('foreign_key_check')).toEqual([]);again.close();
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
  it('rolls back every added table, trigger, version and source change when duplicate or malformed records cannot be promoted',()=>{
    for(const invalid of ['duplicate','time']){const dir=mkdtempSync(join(tmpdir(),'qgroup-shout-fail-')),path=join(dir,'synthetic.db');try{
      const old=versionTen(path);old.prepare("INSERT INTO music_documents VALUES('shouts',0,?)").run(JSON.stringify({id:'same',qq:'orphan',text:'保留原資料',createdAt:invalid==='time'?'invalid':1}));
      if(invalid==='duplicate')old.prepare("INSERT INTO music_documents VALUES('shoutHistory',0,?)").run(JSON.stringify({id:'same',qq:'orphan',text:'不可遺失的重複 ID',createdAt:1}));
      const ddl=old.prepare('SELECT * FROM sqlite_master ORDER BY name').all(),docs=old.prepare('SELECT * FROM music_documents').all();old.close();
      expect(()=>openDatabase(path)).toThrow();const raw=new Database(path);expect(raw.prepare('SELECT version FROM rebuild_schema').get()).toEqual({version:10});expect(raw.prepare('SELECT * FROM sqlite_master ORDER BY name').all()).toEqual(ddl);expect(raw.prepare('SELECT * FROM music_documents').all()).toEqual(docs);raw.close();
    }finally{rmSync(dir,{recursive:true,force:true});}}
  });
  it('honors durable source erasure before promotion and removes native content and last-post metadata when a profile is erased',()=>{
    const dir=mkdtempSync(join(tmpdir(),'qgroup-shout-erase-')),path=join(dir,'synthetic.db');try{const old=versionTen(path);
      old.prepare("INSERT INTO music_legacy_erasures VALUES('10001','\"erased\"')").run();old.prepare("INSERT INTO music_documents VALUES('shouts',0,?)").run(JSON.stringify({id:'erased',qq:'10001',name:'已刪名字',text:'不得恢復',createdAt:1}));old.close();
      const db=openDatabase(path);expect(db.prepare('SELECT * FROM music_shouts').all()).toEqual([]);expect(db.prepare('SELECT * FROM music_documents').all()).toEqual([]);
      db.exec("INSERT INTO music_profiles VALUES('new',NULL,1,'now',NULL); INSERT INTO music_shouts VALUES('new-shout','new','','名字','內容',1,NULL,0); INSERT INTO music_shout_authors VALUES('new',1); UPDATE music_profiles SET erased_at='erased' WHERE id='new';");
      expect(db.prepare('SELECT * FROM music_shouts').all()).toEqual([]);expect(db.prepare('SELECT * FROM music_shout_authors').all()).toEqual([]);db.close();
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
});
