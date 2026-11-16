import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from './index';

function version8(path:string) {
  const db=openDatabase(path);
  const triggers=db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND tbl_name='bot_settings_history'").all() as {sql:string}[];
  db.exec('DROP TRIGGER bot_settings_history_no_delete; DELETE FROM bot_settings; DELETE FROM bot_settings_history; DELETE FROM bot_runtime; UPDATE rebuild_schema SET version=8;');
  db.exec(triggers.find(row=>row.sql.includes('bot_settings_history_no_delete'))!.sql);
  return db;
}
describe('schema 8 → bot singleton migration',()=>{
  it('backfills the original empty inheriting policy, baseline and runtime exactly once',()=>{
    const folder=mkdtempSync(join(tmpdir(),'qgroup-bot-baseline-')),path=join(folder,'isolated.sqlite3');
    try{
      version8(path).close();const db=openDatabase(path);
      expect(db.prepare('SELECT version FROM rebuild_schema').get()).toEqual({version:9});
      expect(db.prepare('SELECT id,revision,config_json FROM bot_settings').get()).toEqual({id:1,revision:0,config_json:'{}'});
      expect(db.prepare('SELECT revision,config_json,actor_ref,action FROM bot_settings_history').all()).toEqual([{revision:0,config_json:'{}',actor_ref:'',action:'baseline'}]);
      expect(db.prepare('SELECT * FROM bot_runtime').get()).toEqual({id:1,applied_revision:null,checked_at:null,last_attempt_at:null,deployment_group:''});
      const before=['bot_settings','bot_settings_history','bot_runtime'].map(table=>db.prepare('SELECT * FROM '+table).all());db.close();
      const next=openDatabase(path);expect(['bot_settings','bot_settings_history','bot_runtime'].map(table=>next.prepare('SELECT * FROM '+table).all())).toEqual(before);next.close();
    }finally{rmSync(folder,{recursive:true,force:true});}
  });
  it('preserves imported explicit disabled policy, history and pacing/deployment state byte for byte',()=>{
    const folder=mkdtempSync(join(tmpdir(),'qgroup-bot-preserve-')),path=join(folder,'isolated.sqlite3');
    try{
      const old=version8(path);old.exec(`INSERT INTO bot_settings VALUES(1,7,'{"enabled":false,"dry_run":true,"groups":[]}', 'source-time');
        INSERT INTO bot_settings_history VALUES(0,'{}','original-baseline','source-actor','baseline');
        INSERT INTO bot_settings_history VALUES(7,'{"enabled":false}','original-save','source-actor','save');
        INSERT INTO bot_runtime VALUES(1,6,'checked','last-attempt','original-group');`);
      const tables=['bot_settings','bot_settings_history','bot_runtime'];const before=tables.map(table=>old.prepare('SELECT * FROM '+table).all());old.close();
      const next=openDatabase(path);expect(tables.map(table=>next.prepare('SELECT * FROM '+table).all())).toEqual(before);expect(()=>next.exec('DELETE FROM bot_settings_history')).toThrow('append-only');next.close();
    }finally{rmSync(folder,{recursive:true,force:true});}
  });
  it('rolls back all singleton writes and the version when baseline insertion fails',()=>{
    const folder=mkdtempSync(join(tmpdir(),'qgroup-bot-rollback-')),path=join(folder,'isolated.sqlite3');
    try{
      const old=version8(path);old.exec("CREATE TRIGGER synthetic_baseline_failure BEFORE INSERT ON bot_settings_history BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");old.close();
      expect(()=>openDatabase(path)).toThrow('synthetic failure');const db=new Database(path);
      expect(db.prepare('SELECT version FROM rebuild_schema').get()).toEqual({version:8});for(const table of ['bot_settings','bot_settings_history','bot_runtime'])expect(db.prepare('SELECT * FROM '+table).all()).toEqual([]);db.close();
    }finally{rmSync(folder,{recursive:true,force:true});}
  });
});
