import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync,mkdtempSync,readFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach,describe,expect,it } from 'vitest';
import { openDatabase,type DB } from '@qgroup/database';
import { AdminMusicErasurePreview } from '@qgroup/contracts';
import { createApp } from './app';
import { fixture } from '../testsupport/fixture';
import { adminCatalogFixture,catalogProfiles } from '../testsupport/admin-catalog-fixture';
import { erasureJournal,type ErasureJournal,type StoredIntent } from './erasure-journal';
const origin='https://rebuild.example',stamp='2026-11-17T08:00:00.000Z',cleanup:(()=>Promise<void>|void)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function setup(options:{db?:DB;journal?:ErasureJournal;seed?:boolean}={}){
  const db=options.db??openDatabase(':memory:');if(options.seed!==false){fixture(db);adminCatalogFixture(db);db.prepare("INSERT INTO user_admin_roles VALUES('alice',1,1,'synthetic')").run();}
  const app=createApp({db,origin,now:()=>new Date(stamp),erasureJournal:options.journal});await app.ready();cleanup.push(async()=>{await app.close();db.close();});
  const cookie='kanban_session=fixture-alice',viewer=(await app.inject({url:'/api/v2/session',headers:{cookie}})).json(),headers={cookie,origin,'x-account-scope':viewer.scope,'x-csrf-token':viewer.csrf};
  const access=(await app.inject({url:'/api/v2/admin/session',headers})).json(),admin={...headers,'x-admin-csrf':access.adminCsrf};
  const path=(id:string|undefined=catalogProfiles.bob)=>id===''?'/api/v2/admin/music-reset':'/api/v2/admin/music/'+id+'/erase';
  const preview=async(id?:string)=>AdminMusicErasurePreview.parse((await app.inject({url:path(id),headers})).json());
  const input=async(id?:string)=>({revision:(await preview(id)).revision,confirm:id===''?'RESET':'DELETE',requestId:randomUUID(),secret:'ab'.repeat(32)});
  let ip=1;const send=(body:object,id?:string,h=admin)=>app.inject({remoteAddress:'127.0.1.'+ip++,method:'POST',url:path(id),headers:h,payload:body});
  const receipt=(body:{requestId:string;secret:string},h=admin)=>app.inject({method:'POST',url:'/api/v2/admin/music-erasure/receipt',headers:h,payload:{requestId:body.requestId,secret:body.secret}});
  return{db,app,headers,admin,preview,input,send,receipt};
}
describe('durable administrator music removal and reset',()=>{
  it('deletes linked and unlinked profiles, transfers terms, retires identity proofs and receipts, while retaining accounts and other selections',async()=>{
    const s=await setup();s.db.prepare("INSERT INTO music_shouts VALUES('shout',?,'10002','詞庫bob','私密喊話',100,NULL,0)").run(catalogProfiles.bob);
    s.db.prepare("INSERT INTO music_documents VALUES('shouts',0,?)").run(JSON.stringify({id:'shout',qq:'10002',text:'私密喊話'}));
    s.db.prepare("INSERT INTO music_legacy_identity VALUES('sessions',0,?)").run(JSON.stringify({qq:'10002',token_hash:'old-secret'}));
    s.db.prepare("INSERT INTO request_results VALUES('bob','old-save','signature','private-response',200,'before')").run();s.db.prepare("INSERT INTO music_profile_receipts VALUES('bob','old-save',?)").run(catalogProfiles.bob);
    expect(await s.preview()).toMatchObject({profiles:1,entries:1,selections:2,shouts:1,profile:{name:'詞庫bob',ownerId:'bob'}});
    const before=s.db.prepare('SELECT * FROM users').all(),alice=s.db.prepare('SELECT * FROM music_selections WHERE profile_id=?').all(catalogProfiles.alice),body=await s.input();
    const response=await s.send(body);expect(response.statusCode,response.body).toBe(200);expect(response.json()).toEqual({requestId:body.requestId,target:'admin_music',command:'delete_profile',status:'completed',profiles:1,entries:0});
    expect(s.db.prepare("SELECT created_by FROM music_entry_details WHERE entry_id='sub-1'").get()).toEqual({created_by:'admin'});
    expect(s.db.prepare('SELECT * FROM music_selections WHERE profile_id=?').all(catalogProfiles.alice)).toEqual(alice);expect(s.db.prepare('SELECT * FROM users').all()).toEqual(before);
    for(const table of ['music_legacy_profiles','music_profile_fields','music_profile_contacts','music_selections','music_entry_creations'])expect(s.db.prepare('SELECT * FROM '+table+' WHERE profile_id=?').all(catalogProfiles.bob)).toEqual([]);
    expect(s.db.prepare('SELECT * FROM music_shouts').all()).toEqual([]);expect(s.db.prepare("SELECT * FROM music_documents WHERE kind='shouts'").all()).toEqual([]);expect(s.db.prepare('SELECT * FROM music_legacy_identity').all()).toEqual([]);
    expect(s.db.prepare("SELECT response_status,response_json FROM request_results WHERE request_key='old-save'").get()).toEqual({response_status:410,response_json:JSON.stringify({code:'PROFILE_ERASED',message:'這份成分已刪除，原保存操作不會重建資料'})});
    expect((await s.send(body)).json()).toEqual(response.json());expect((await s.receipt(body)).json()).toEqual(response.json());
    expect((await s.send(await s.input(catalogProfiles.orphan),catalogProfiles.orphan)).statusCode).toBe(200);expect(s.db.pragma('foreign_key_check')).toEqual([]);
  });
  it('retires only associated OAuth proofs and epochs, rejects stale saves, and keeps unrelated login attempts and rate limits',async()=>{
    const s=await setup(),id=catalogProfiles.bob;
    for(const key of ['claim','ordinary'])s.db.prepare("INSERT INTO login_attempts(id,token_hash,user_id,provider,mode,status,expires_at,created_at,app_id,union_id) VALUES(?,'token','bob','qq','bind','verified','2099','before','synthetic','private-union')").run(key);
    s.db.prepare("INSERT INTO music_claim_intents VALUES('claim','token','bob',?,0,'proof','digest',0,'authorized','claim','synthetic','subject','2099','before')").run(id);
    s.db.prepare("INSERT INTO music_claim_attempts VALUES(?,123)").run('qq:'+'a'.repeat(64));const limits=s.db.prepare('SELECT * FROM music_claim_attempts').all();
    expect((await s.send(await s.input())).statusCode).toBe(200);
    expect(s.db.prepare("SELECT status,union_id FROM login_attempts WHERE id='claim'").get()).toEqual({status:'failed',union_id:''});expect(s.db.prepare("SELECT status FROM login_attempts WHERE id='ordinary'").get()).toEqual({status:'verified'});
    expect(s.db.prepare('SELECT * FROM music_claim_intents').all()).toEqual([]);expect(s.db.prepare('SELECT * FROM music_claim_attempts').all()).toEqual(limits);
    const cookie='kanban_session=fixture-bob',viewer=(await s.app.inject({url:'/api/v2/session',headers:{cookie}})).json();expect(viewer).toMatchObject({authenticated:true,musicEpoch:1});
    expect((await s.app.inject({method:'PUT',url:'/api/v2/me/music',headers:{cookie,origin,'x-account-scope':viewer.scope,'x-csrf-token':viewer.csrf,'idempotency-key':randomUUID()},payload:{profileId:id,musicEpoch:0,revision:0,selections:[{entryId:'main-0',level:3}]}})).statusCode).toBe(409);
  });
  it('resets only the reviewed music IDs and keeps settings, trends, catalog history, accounts and bot work intact',async()=>{
    const s=await setup(),tables=['users','events','attendees','bot_outbox','bot_settings','music_documents'];
    s.db.prepare("INSERT INTO music_documents VALUES('settings',0,?)").run(JSON.stringify({theme:'dark',adminPasswordHash:'legacy-unused'}));
    s.db.prepare("INSERT INTO music_documents VALUES('trend',0,?)").run(JSON.stringify({t:123,counts:{'sub-0':3}}));
    const before=tables.map(t=>s.db.prepare('SELECT * FROM '+t).all()),body=await s.input('');expect(await s.preview('')).toMatchObject({profiles:3,entries:22,selections:7});
    expect((await s.send(body,'')).json()).toMatchObject({command:'reset_music',profiles:3,entries:22});
    expect(tables.map(t=>s.db.prepare('SELECT * FROM '+t).all())).toEqual(before);
    for(const table of ['music_entries','music_entry_details','music_selections','music_legacy_profiles','music_profile_fields','music_entry_creations'])expect(s.db.prepare('SELECT * FROM '+table).all()).toEqual([]);
    expect(s.db.prepare('SELECT id FROM music_profiles WHERE erased_at IS NULL').all()).toEqual([]);
    expect(s.db.prepare('SELECT command,affected_profiles FROM music_catalog_actions').all()).toEqual([{command:'reset_music',affected_profiles:3}]);
    s.db.prepare("INSERT INTO music_entries VALUES('new','新詞條','sub')").run();const again=await s.send(body,'');expect(again.statusCode,again.body).toBe(200);expect(s.db.prepare("SELECT id FROM music_entries WHERE id='new'").get()).toBeDefined();
    expect(s.db.pragma('foreign_key_check')).toEqual([]);
  });
  it('checks current authority, origin, admin CSRF, strict confirmation and every reviewed revision before writing the durable journal',async()=>{
    const entries:StoredIntent[]=[],s=await setup({journal:{read:()=>entries,append:entry=>{entries.push(entry);}}}),body=await s.input();
    for(const patch of [{origin:'https://evil.example'},{'x-admin-csrf':'wrong'},{'x-account-scope':'wrong'},{cookie:''}])expect((await s.send(body,undefined,{...s.admin,...patch})).statusCode).toBeGreaterThanOrEqual(400);
    expect((await s.send({...body,confirm:'RESET'})).statusCode).toBe(400);expect((await s.send({...body,qq:'10002'})).statusCode).toBe(400);expect(entries).toEqual([]);
    s.db.prepare('UPDATE music_selections SET level=2 WHERE profile_id=?').run(catalogProfiles.bob);expect((await s.send(body)).json().code).toBe('MUSIC_ERASURE_CHANGED');expect(entries).toEqual([]);
    const fresh=await s.input();expect((await s.send(fresh)).statusCode).toBe(200);expect((await s.send({...fresh,revision:'a'.repeat(64)})).statusCode).toBe(409);
    s.db.prepare("UPDATE user_admin_roles SET is_admin=0,revision=revision+1 WHERE user_id='alice'").run();expect((await s.receipt(fresh)).statusCode).toBe(403);expect((await s.send(fresh)).statusCode).toBe(403);
  });
  it('rate-limits malformed destructive requests before any durable intent can be appended',async()=>{
    const entries:StoredIntent[]=[],s=await setup({journal:{read:()=>entries,append:entry=>{entries.push(entry);}}});
    const body=await s.input();for(let i=0;i<7;i++){
      const response=await s.app.inject({method:'POST',url:'/api/v2/admin/music/'+catalogProfiles.bob+'/erase',headers:s.admin,payload:{...body,confirm:false}});
      expect(response.statusCode).toBe(i<6?400:429);
    }expect(entries).toEqual([]);
  });
  it('requires both a receipt secret and current administrator authority, never returns profile content, and separates member privacy receipts',async()=>{
    const s=await setup(),body=await s.input();await s.send(body);const response=await s.receipt(body);expect(response.statusCode).toBe(200);expect(response.body).not.toMatch(/詞庫|bob|10002|secret|private|sub-1/);
    expect((await s.receipt({...body,secret:'cd'.repeat(32)})).statusCode).toBe(404);
    expect((await s.app.inject({method:'POST',url:'/api/v2/privacy/receipt',headers:s.headers,payload:{requestId:body.requestId,secret:body.secret}})).statusCode).toBe(404);
  });
  it('recovers a committed durable intent after SQL rollback and blocks all routes when the journal cannot be made durable',async()=>{
    const entries:StoredIntent[]=[],s=await setup({journal:{read:()=>entries,append:entry=>{entries.push(entry);}}});const body=await s.input();
    s.db.exec("CREATE TRIGGER synthetic_failure BEFORE INSERT ON privacy_receipts BEGIN SELECT RAISE(ABORT,'receipt failure'); END;");
    expect((await s.send(body)).statusCode).toBe(500);expect(entries).toHaveLength(1);expect(s.db.prepare('SELECT erased_at FROM music_profiles WHERE id=?').get(catalogProfiles.bob)).toEqual({erased_at:null});
    expect((await s.app.inject({url:'/api/v2/health'})).statusCode).toBe(503);s.db.exec('DROP TRIGGER synthetic_failure');expect((await s.receipt(body)).statusCode).toBe(200);expect(s.db.prepare('SELECT erased_at FROM music_profiles WHERE id=?').get(catalogProfiles.bob)).toEqual({erased_at:stamp});
    const bad=await setup({journal:{read:()=>[],append:()=>{throw new Error('synthetic durability failure');}}}),input=await bad.input();expect((await bad.send(input)).statusCode).toBe(500);expect((await bad.app.inject({url:'/api/v2/health'})).statusCode).toBe(503);
  });
  it('replays a reset onto an older database copy, preserves actual Python bot views and cannot erase new post-reset data on another restart',async()=>{
    const root=mkdtempSync(join(tmpdir(),'qgroup-admin-erasure-'));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
    const s=await setup({db:openDatabase(join(root,'state.sqlite3'))});const backup=join(root,'backup.sqlite3');await s.db.backup(backup);
    const probe=(path:string)=>JSON.parse(execFileSync('python3',['tools/rebuild/probe-auth-bot.py',path],{encoding:'utf8'})),before=probe(s.db.name),body=await s.input('');expect((await s.send(body,'')).statusCode).toBe(200);expect(probe(s.db.name)).toEqual(before);
    const restored=join(root,'restored.sqlite3');copyFileSync(backup,restored);copyFileSync(join(root,'state.erasures.jsonl'),join(root,'restored.erasures.jsonl'));
    const raw=readFileSync(join(root,'state.erasures.jsonl'),'utf8');expect(raw).not.toMatch(/詞庫|10002|不可匯出|private/);expect(raw).not.toContain(body.secret);expect(erasureJournal(s.db).read()[0]).toMatchObject({version:2,kind:'admin_music'});
    const copy=await setup({db:openDatabase(restored),seed:false});expect(copy.db.prepare('SELECT * FROM music_entries').all()).toEqual([]);expect(copy.db.prepare('SELECT id FROM music_profiles WHERE erased_at IS NULL').all()).toEqual([]);expect(probe(restored)).toEqual(before);expect((await copy.receipt(body)).statusCode).toBe(200);
    copy.db.prepare("INSERT INTO music_entries VALUES('after','新詞條','sub')").run();const {createPrivacy}=await import('./privacy');createPrivacy(copy.db);expect(copy.db.prepare("SELECT id FROM music_entries WHERE id='after'").get()).toBeDefined();
    expect(copy.db.pragma('foreign_key_check')).toEqual([]);
  });
});
