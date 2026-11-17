import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach,describe,expect,it } from 'vitest';
import { openDatabase,seedWallpapers,wallpaperDigest } from './index';
import { fixture } from '../../../apps/api/testsupport/fixture';
const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function setup(){const root=mkdtempSync(join(tmpdir(),'qgroup-wall-migration-'));roots.push(root);const path=join(root,'state.db'),walls=join(root,'walls');mkdirSync(walls);writeFileSync(join(walls,'manifest.json'),JSON.stringify({items:[],rotateSeconds:24}));return{root,path,walls};}
function v12(path:string){const db=openDatabase(path);fixture(db);db.exec('DROP TRIGGER appearance_actions_no_update; DROP TRIGGER appearance_actions_no_delete; DROP TABLE appearance_actions; DROP TABLE wallpaper_items; DROP TABLE wallpaper_assets; DROP TABLE wallpaper_config; UPDATE rebuild_schema SET version=12');return db;}
const manifest={rotateSeconds:12,custom:{preserve:'original'},items:[{src:'/walls/one.png',name:'原圖',enabled:false},{src:'/walls/missing.webp',name:'遺失',enabled:true},{src:'/walls/two.jpg',name:'第二張',enabled:true}]};
describe('schema 12 → transactional wallpapers',()=>{
  it('preserves original manifest, order, enabled flags, missing entries and bytes, all prior DDL/data and actual Python bot reads, once',()=>{
    const s=setup(),raw=JSON.stringify(manifest,null,2),bytes=Buffer.from([137,80,78,71,13,10,26,10,0,255]);writeFileSync(join(s.walls,'manifest.json'),raw);writeFileSync(join(s.walls,'one.png'),bytes);writeFileSync(join(s.walls,'two.jpg'),Buffer.from([255,216,255,1]));
    const old=v12(s.path),tables=(old.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='rebuild_schema' ORDER BY name").all() as {name:string}[]).map(r=>r.name),before=tables.map(t=>old.prepare('SELECT * FROM "'+t+'"').all()),ddl=old.prepare("SELECT name,sql FROM sqlite_master WHERE name!='rebuild_schema' ORDER BY name").all() as {name:string}[];
    const probe=()=>JSON.parse(execFileSync('python3',['tools/rebuild/probe-auth-bot.py',s.path],{encoding:'utf8'})),bot=probe();old.close();
    const next=openDatabase(s.path);expect(next.prepare('SELECT version FROM rebuild_schema').get()).toEqual({version:13});expect(tables.map(t=>next.prepare('SELECT * FROM "'+t+'"').all())).toEqual(before);for(const row of ddl)expect(next.prepare('SELECT name,sql FROM sqlite_master WHERE name=?').get(row.name)).toEqual(row);expect(probe()).toEqual(bot);
    expect(next.prepare('SELECT rotate_seconds,initialized,legacy_manifest_json FROM wallpaper_config').get()).toEqual({rotate_seconds:12,initialized:1,legacy_manifest_json:raw});expect(next.prepare('SELECT name,enabled,position FROM wallpaper_items ORDER BY position').all()).toEqual([{name:'原圖',enabled:0,position:0},{name:'遺失',enabled:1,position:1},{name:'第二張',enabled:1,position:2}]);expect(next.prepare('SELECT data FROM wallpaper_assets WHERE digest=?').get(wallpaperDigest(bytes))).toEqual({data:bytes});expect(next.prepare('SELECT digest FROM wallpaper_items WHERE position=1').get()).toEqual({digest:null});expect(next.pragma('foreign_key_check')).toEqual([]);next.close();
    writeFileSync(join(s.walls,'manifest.json'),'broken after import');const again=openDatabase(s.path);expect(seedWallpapers(again,s.walls)).toBe(false);expect(again.prepare('SELECT count(*) n FROM wallpaper_items').get()).toEqual({n:3});again.close();
  });
  it('rolls back all schema/data changes on a collision or unsafe source',()=>{
    for(const collision of [false,true]){const s=setup(),old=v12(s.path);if(collision)old.exec('CREATE TABLE wallpaper_items(id TEXT)');else writeFileSync(join(s.walls,'manifest.json'),JSON.stringify({...manifest,items:[{src:'/walls/../private.png'}]}));const ddl=old.prepare('SELECT * FROM sqlite_master ORDER BY name').all();old.close();expect(()=>openDatabase(s.path)).toThrow();const raw=new Database(s.path);expect(raw.prepare('SELECT version FROM rebuild_schema').get()).toEqual({version:12});expect(raw.prepare('SELECT * FROM sqlite_master ORDER BY name').all()).toEqual(ddl);raw.close();}
  });
  it('rejects directory, manifest and image symlinks and keeps failed explicit imports retryable',()=>{
    const s=setup(),db=openDatabase(':memory:');try{
      writeFileSync(join(s.root,'original.json'),JSON.stringify({rotateSeconds:24,items:[{src:'/walls/link.png'}]}));rmSync(join(s.walls,'manifest.json'));symlinkSync(join(s.root,'original.json'),join(s.walls,'manifest.json'));expect(()=>seedWallpapers(db,s.walls)).toThrow();rmSync(join(s.walls,'manifest.json'));writeFileSync(join(s.walls,'manifest.json'),JSON.stringify({rotateSeconds:24,items:[{src:'/walls/link.png'}]}));symlinkSync(join(s.root,'original.json'),join(s.walls,'link.png'));expect(()=>seedWallpapers(db,s.walls)).toThrow();expect(db.prepare('SELECT initialized FROM wallpaper_config').get()).toEqual({initialized:0});expect(db.prepare('SELECT * FROM wallpaper_items').all()).toEqual([]);
      symlinkSync(s.walls,join(s.root,'linked'));expect(()=>seedWallpapers(db,join(s.root,'linked'))).toThrow();
    }finally{db.close();}
  });
  it('allows an explicit later import when no source existed at migration time',()=>{
    const s=setup(),db=openDatabase(':memory:');try{expect(seedWallpapers(db,join(s.root,'absent'))).toBe(false);writeFileSync(join(s.walls,'manifest.json'),JSON.stringify({items:[],rotateSeconds:600}));expect(seedWallpapers(db,s.walls)).toBe(true);expect(db.prepare('SELECT rotate_seconds FROM wallpaper_config').get()).toEqual({rotate_seconds:600});}finally{db.close();}
  });
});
