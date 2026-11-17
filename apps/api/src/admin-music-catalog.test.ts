import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach,describe,expect,it } from 'vitest';
import { musicCreatedIds,openDatabase } from '@qgroup/database';
import { AdminMusicCatalog,AdminMusicEntryResult } from '@qgroup/contracts';
import { fixture } from '../testsupport/fixture';
import { adminCatalogFixture,catalogProfiles } from '../testsupport/admin-catalog-fixture';
import { createApp } from './app';
import { sharedRecords } from './privacy';
const origin='https://rebuild.example',stamp='2026-11-17T08:00:00.000Z',cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function setup(db=openDatabase(':memory:')){
  fixture(db);adminCatalogFixture(db);db.prepare("INSERT INTO user_admin_roles VALUES('alice',1,1,'synthetic')").run();
  const app=createApp({db,origin,now:()=>new Date(stamp)});await app.ready();cleanup.push(async()=>{await app.close();db.close();});
  const cookie='kanban_session=fixture-alice',viewer=(await app.inject({url:'/api/v2/session',headers:{cookie}})).json(),headers={cookie,origin,'x-account-scope':viewer.scope,'x-csrf-token':viewer.csrf};
  const access=(await app.inject({url:'/api/v2/admin/session',headers})).json(),admin={...headers,'x-admin-csrf':access.adminCsrf};
  const list=async()=>AdminMusicCatalog.parse((await app.inject({url:'/api/v2/admin/music-entries',headers})).json());
  const send=(input:object,key=randomUUID(),h=admin)=>app.inject({method:'POST',url:'/api/v2/admin/music-entries',headers:{...h,'idempotency-key':key},payload:input});
  const command=async(command:string,patch:object={})=>({command,revision:(await list()).revision,confirm:true,...patch});
  const picks=(key:keyof typeof catalogProfiles)=>db.prepare('SELECT entry_id,level,position FROM music_selections WHERE profile_id=? ORDER BY position').all(catalogProfiles[key]);
  return{db,app,headers,admin,viewer,list,send,command,picks};
}
describe('administrator native music catalog',()=>{
  it('lists complete public metadata and affected creation counts without requiring the administrator to have a profile',async()=>{
    const s=await setup(),list=await s.list();expect(list.entries).toHaveLength(22);expect(list.entries.find(e=>e.id==='sub-0')).toMatchObject({count:3,creationCount:3,creatorName:'詞庫alice'});
    expect(JSON.stringify(list)).not.toMatch(/不可匯出|private|10002|user_id|pin_hash|created_by/);
    s.db.prepare("UPDATE music_profiles SET user_id=NULL WHERE user_id='alice'").run();expect((await s.list()).entries).toHaveLength(22);
    for(const query of ['?qq=10002','?revision=1'])expect((await s.app.inject({url:'/api/v2/admin/music-entries'+query,headers:s.headers})).statusCode).toBe(400);
  });
  it('creates without a member quota, edits type/category without losing ownership or aliases, and rejects all normalized name/alias collisions',async()=>{
    const s=await setup(),before=(await s.list()).entries.find(e=>e.id==='sub-0')!;
    expect((await s.send(await s.command('update',{id:'sub-0',name:'新歌手',kind:'main',category:'领域'}))).statusCode).toBe(200);
    expect(s.db.prepare("SELECT category,aliases_json,created_by,created_at_json FROM music_entry_details WHERE entry_id='sub-0'").get()).toEqual({category:'领域',aliases_json:JSON.stringify(before.aliases),created_by:catalogProfiles.alice,created_at_json:'123'});
    expect(s.picks('alice')[0]).toEqual({entry_id:'sub-0',level:1,position:0});
    for(const name of ['ｙＯＲＵ','新\u200b歌手','𠀀'.repeat(25),'\u001c\u0085','bad\x00name'])expect((await s.send(await s.command('create',{name,kind:'sub',category:'歌手'}))).statusCode).toBeGreaterThanOrEqual(400);
    for(let i=0;i<3;i++){const response=await s.send(await s.command('create',{name:'管理建立 '+i,kind:'main',category:'领域'}));expect(response.statusCode,response.body).toBe(200);expect(AdminMusicEntryResult.parse(response.json()).command).toBe('create');}
    expect(s.db.prepare("SELECT count(*) n FROM music_entry_details WHERE created_by='admin'").get()).toEqual({n:3});
  });
  it('merges selections and creation lists exactly as Python, preserving the first familiarity, target owner and aliases',async()=>{
    const s=await setup(),catalog=await s.list(),data={entries:Object.fromEntries(catalog.entries.map(e=>[e.id,{id:e.id,text:e.name,kind:e.kind,category:e.category,aliases:e.aliases}])),members:Object.fromEntries(Object.entries(catalogProfiles).map(([key,id])=>[key,{selection:s.picks(key as keyof typeof catalogProfiles).map((x:any)=>({id:x.entry_id,level:x.level})),created:musicCreatedIds(s.db,id)}]))};
    const expected=JSON.parse(execFileSync('python3',['-c',`import json,sys
from unittest.mock import patch
from music_site import upstream as u
u.data=json.load(sys.stdin)
class H:
 def require_admin(self,b): return True
 def send_json(self,v,*a): return v
with patch.object(u,'save'):
 u.Handler.api_admin_merge(H(),{'fromId':'sub-0','toId':'sub-1'})
print(json.dumps({'members':u.data['members'],'aliases':u.data['entries']['sub-1']['aliases']}))`],{input:JSON.stringify(data),encoding:'utf8'}));
    const body=await s.command('merge',{id:'sub-0',toId:'sub-1'}),key=randomUUID(),first=await s.send(body,key);expect(first.statusCode,first.body).toBe(200);expect(first.json()).toMatchObject({affectedProfiles:3,targetId:'sub-1'});
    for(const [name,id] of Object.entries(catalogProfiles)){
      expect(s.picks(name as keyof typeof catalogProfiles)).toEqual(expected.members[name].selection.map((x:{id:string;level:number},position:number)=>({entry_id:x.id,level:x.level,position})));
      expect(musicCreatedIds(s.db,id)).toEqual(expected.members[name].created);
      expect(s.db.prepare('SELECT revision FROM music_profiles WHERE id=?').get(id)).toEqual({revision:1});
    }
    expect(JSON.parse((s.db.prepare("SELECT aliases_json FROM music_entry_details WHERE entry_id='sub-1'").get() as {aliases_json:string}).aliases_json)).toEqual(expected.aliases);
    expect(s.db.prepare("SELECT created_by,created_at_json FROM music_entry_details WHERE entry_id='sub-1'").get()).toEqual({created_by:'10002',created_at_json:'456'});
    expect((await s.send(body,key)).json()).toEqual(first.json());expect(s.db.prepare('SELECT count(*) n FROM music_catalog_actions').get()).toEqual({n:1});
    const mine=(await s.app.inject({url:'/api/v2/me/music/entries',headers:s.headers})).json();expect(mine.createdCounts.sub).toBe(1);expect(mine.entries).toEqual([]);
    const stale=await s.app.inject({method:'PUT',url:'/api/v2/me/music',headers:{...s.headers,'idempotency-key':randomUUID()},payload:{profileId:catalogProfiles.alice,musicEpoch:0,revision:0,selections:[{entryId:'sub-0',level:4}]}});expect(stale.statusCode).toBe(409);
  });
  it('administrator deletion removes selected references and creation records, preserves unrelated choices and blocks stale reviews',async()=>{
    const s=await setup(),body=await s.command('delete',{id:'sub-0'});
    s.db.prepare('UPDATE music_selections SET level=2 WHERE profile_id=? AND entry_id=?').run(catalogProfiles.alice,'sub-0');expect((await s.send(body)).statusCode).toBe(409);
    const response=await s.send(await s.command('delete',{id:'sub-0'}));expect(response.statusCode,response.body).toBe(200);expect(response.json().affectedProfiles).toBe(3);
    expect(s.picks('alice')).toEqual([{entry_id:'main-0',level:4,position:0},{entry_id:'sub-1',level:4,position:1}]);
    expect(s.db.prepare("SELECT * FROM music_selections WHERE entry_id='sub-0'").all()).toEqual([]);expect(s.db.prepare("SELECT * FROM music_entry_details WHERE entry_id='sub-0'").all()).toEqual([]);expect(musicCreatedIds(s.db,catalogProfiles.alice)).toEqual([]);
    expect(s.db.pragma('foreign_key_check')).toEqual([]);
  });
  it('checks origin, role, admin CSRF, exact operation signature and current authority before replay',async()=>{
    const s=await setup(),body=await s.command('merge',{id:'sub-0',toId:'sub-1'});
    for(const patch of [{'x-admin-csrf':'bad'},{origin:'https://evil.example'},{cookie:''},{'x-account-scope':'wrong'}])expect((await s.send(body,randomUUID(),{...s.admin,...patch})).statusCode).toBeGreaterThanOrEqual(400);
    expect((await s.send({...body,qq:'10002'})).statusCode).toBe(400);expect((await s.send({...body,toId:'sub-0'})).statusCode).toBe(400);
    const key=randomUUID();expect((await s.send(body,key)).statusCode).toBe(200);expect((await s.send({...body,toId:'sub-2'},key)).statusCode).toBe(409);
    s.db.prepare("UPDATE user_admin_roles SET is_admin=0,revision=revision+1 WHERE user_id='alice'").run();expect((await s.send(body,key)).statusCode).toBe(403);expect((await s.app.inject({url:'/api/v2/admin/music-entries',headers:s.headers})).statusCode).toBe(403);
  });
  it('rolls the entire merge back if receipt persistence fails, leaving no partial selections, aliases, revisions or history',async()=>{
    const s=await setup(),body=await s.command('merge',{id:'sub-0',toId:'sub-1'}),tables=['music_entries','music_entry_details','music_selections','music_profiles','music_legacy_profiles','music_entry_creations','music_catalog_actions'];
    const snapshot=()=>tables.map(t=>s.db.prepare('SELECT * FROM '+t+' ORDER BY rowid').all()),before=snapshot();
    s.db.exec("CREATE TRIGGER fail_catalog_receipt BEFORE INSERT ON auth_requests BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END;");
    expect((await s.send(body)).statusCode).toBe(500);expect(snapshot()).toEqual(before);
  });
  it('erases transferred native creation metadata, retains only necessary administrative references and keeps the audit append-only',async()=>{
    const s=await setup();expect((await s.send(await s.command('merge',{id:'sub-0',toId:'sub-1'}))).statusCode).toBe(200);
    expect(sharedRecords(s.db,'alice').music_catalog_actions).toBe(1);expect(()=>s.db.prepare('DELETE FROM music_catalog_actions').run()).toThrow('append-only');
    const profile=(await s.app.inject({url:'/api/v2/me/music',headers:s.headers})).json();
    const response=await s.app.inject({method:'POST',url:'/api/v2/me/privacy/erase',headers:s.headers,payload:{target:'music',profileId:profile.id,profileRevision:profile.revision,requestId:randomUUID(),secret:'a'.repeat(64),confirm:true}});expect(response.statusCode,response.body).toBe(200);
    expect(s.db.prepare('SELECT * FROM music_entry_creations WHERE profile_id=?').all(profile.id)).toEqual([]);
    expect(JSON.stringify(s.db.prepare('SELECT * FROM music_catalog_actions').all())).not.toMatch(/詞庫alice|不可匯出|10002|源別名/);
  });
  it('preserves all compatibility tables and actual Python bot views across catalog changes',async()=>{
    const folder=mkdtempSync(join(tmpdir(),'qgroup-admin-catalog-')),path=join(folder,'synthetic.db');cleanup.push(async()=>rmSync(folder,{recursive:true,force:true}));const s=await setup(openDatabase(path));
    for(const [i,status] of ['pending','sending','sent','failed','skipped'].entries())s.db.prepare("INSERT INTO bot_outbox(event_id,kind,dedupe_key,target,payload_json,status,attempts,claim_token,retry_at,simulated_at,created_at) VALUES('listen','synthetic',?,'synthetic','{}',?,2,'claim','retry','simulated','before')").run('key-'+i,status);
    const tables=(s.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'music_%' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('auth_requests') ORDER BY name").all() as {name:string}[]).map(r=>r.name),snapshot=()=>tables.map(t=>s.db.prepare('SELECT * FROM "'+t+'"').all()),before=snapshot();
    const probe=()=>JSON.parse(execFileSync('python3',['tools/rebuild/probe-auth-bot.py',path],{encoding:'utf8'})),bot=probe();
    expect((await s.send(await s.command('merge',{id:'sub-0',toId:'sub-1'}))).statusCode).toBe(200);expect((await s.send(await s.command('delete',{id:'sub-1'}))).statusCode).toBe(200);
    expect(snapshot()).toEqual(before);expect(probe()).toEqual(bot);
  });
});
