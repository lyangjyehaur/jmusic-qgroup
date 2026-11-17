import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach,describe,expect,it } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { MusicShouts,MusicShout,AdminMusicShouts } from '@qgroup/contracts';
import { fixture } from '../testsupport/fixture';
import { musicShoutFixture } from '../testsupport/music-shout-fixture';
import { createApp } from './app';
const origin='https://rebuild.example',cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function setup(db=openDatabase(':memory:')){
  fixture(db);let clock=new Date('2026-11-17T08:00:00.125Z');musicShoutFixture(db,clock);db.prepare("INSERT INTO user_admin_roles VALUES('alice',1,1,'synthetic')").run();
  const app=createApp({db,origin,now:()=>clock});await app.ready();cleanup.push(async()=>{await app.close();db.close();});
  const cookie='kanban_session=fixture-alice',viewer=(await app.inject({url:'/api/v2/session',headers:{cookie}})).json();
  const headers={cookie,origin,'x-account-scope':viewer.scope,'x-csrf-token':viewer.csrf},access=(await app.inject({url:'/api/v2/admin/session',headers})).json();
  const profile=db.prepare("SELECT id FROM music_profiles WHERE user_id='alice'").get() as {id:string};
  const input=(text='想一起聽音樂')=>({profileId:profile.id,musicEpoch:viewer.musicEpoch,text,confirm:true});
  const post=(data=input(),key=randomUUID())=>app.inject({method:'POST',url:'/api/v2/me/music/shouts',headers:{...headers,'idempotency-key':key},payload:data});
  const read=(path='/api/v2/music/shouts')=>app.inject({url:path,headers});
  return{db,app,headers,profile,input,post,read,admin:{...headers,'x-admin-csrf':access.adminCsrf},clock:(value:string)=>{clock=new Date(value);}};
}
describe('native music shouts',()=>{
  it('matches Python archival, stable history ordering and public names at the fractional expiration boundary',async()=>{
    const s=await setup(),rows=s.db.prepare('SELECT * FROM music_shouts ORDER BY ordinal').all() as {id:string;profile_id:string|null;legacy_key:string;name:string;body:string;created_at:number;archived_at:number|null}[];
    const data={members:Object.fromEntries((s.db.prepare('SELECT profile_id,name FROM music_profile_fields').all() as {profile_id:string;name:string}[]).map(row=>[row.profile_id,{name:row.name}])),shouts:[] as object[],shoutHistory:[] as object[]};
    for(const row of rows)data[row.archived_at===null?'shouts':'shoutHistory'].push({id:row.id,qq:row.profile_id??row.legacy_key,name:row.name,text:row.body,createdAt:row.created_at,...row.archived_at===null?{}:{archivedAt:row.archived_at}});
    const expected=JSON.parse(execFileSync('python3',['-c',`import json,sys
from unittest.mock import patch
from music_site import upstream as u
u.data=json.load(sys.stdin)
with patch.object(u,'save'):
 u.archive_shouts(1794902400.125)
 def view(s):
  d=u.shout_public(s)
  return {k:d[k] for k in ('id','text','name','createdAt','expiresAt')} | {'archivedAt':int(s['archivedAt'] or 0) if 'archivedAt' in s else None}
 print(json.dumps({'active':[view(s) for s in u.active_shouts(1794902400.125)],'history':[view(s) for s in u.history_shouts()]}))`],{input:JSON.stringify(data),encoding:'utf8'}));
    const strip=(items:ReturnType<typeof MusicShout.parse>[])=>items.map(({id,text,name,createdAt,expiresAt,archivedAt})=>({id,text,name,createdAt,expiresAt,archivedAt}));
    expect(strip(MusicShouts.parse((await s.read('/api/v2/music/shouts?limit=50')).json()).items)).toEqual(expected.active);
    expect(strip(MusicShouts.parse((await s.read('/api/v2/music/shouts/history?limit=50')).json()).items)).toEqual(expected.history);
  });
  it('archives at the exact float cutoff, preserves stable history and paginates every record with current names and contact provenance',async()=>{
    const s=await setup(),active=MusicShouts.parse((await s.read()).json());expect(active.items.map(x=>x.id)).toEqual(['shout-bob']);expect(active).toMatchObject({total:1,nextAllowedAt:0,mine:null});
    const history=MusicShouts.parse((await s.read('/api/v2/music/shouts/history?offset=0&limit=10')).json());expect(history.total).toBe(25);expect(history.items[0]).toMatchObject({id:'shout-expired',archivedAt:1794902400});
    const last=MusicShouts.parse((await s.read('/api/v2/music/shouts/history?offset=20&limit=10')).json());expect(last.items).toHaveLength(5);expect(last.items.at(-1)).toMatchObject({author:null,name:'舊發布者'});expect(JSON.stringify(last)).not.toContain('已不存在的私人識別');
    const detail=MusicShout.parse((await s.read('/api/v2/music/shouts/shout-bob')).json());expect(detail.author).toMatchObject({name:'找搭子乙',contactQQ:'234567',contactSource:'self_reported'});
    s.db.prepare("UPDATE music_profile_fields SET name='乙新稱呼' WHERE profile_id=?").run(detail.author!.id);expect((await s.read()).body).toContain('乙新稱呼');expect((await s.read()).body).not.toMatch(/不可匯出|legacy_key|user_id|scope|pin|token/);
  });
  it('publishes atomically, normalizes Python whitespace, preserves exact retries and replaces only after the 24 hour boundary',async()=>{
    const s=await setup(),key=randomUUID(),input=s.input('  第一則\n\u0085 找搭子 👩🏽‍🎤  '),response=await s.post(input,key);expect(response.statusCode,response.body).toBe(200);
    expect((await s.post(input,key)).json()).toEqual(response.json());expect((await s.post(s.input('另一內容'),key)).statusCode).toBe(409);
    const active=MusicShouts.parse((await s.read()).json());expect(active.mine).toMatchObject({id:response.json().id,text:'第一則 找搭子 👩🏽‍🎤',mine:true});expect(active.nextAllowedAt).toBe(1794988800);
    expect((await s.post()).statusCode).toBe(429);s.clock('2026-11-18T07:59:59.999Z');expect((await s.post()).statusCode).toBe(429);
    s.clock('2026-11-18T08:00:00Z');expect((await s.post(s.input('下一日'))).statusCode).toBe(200);
    expect(s.db.prepare('SELECT count(*) n FROM music_shouts WHERE profile_id=? AND archived_at IS NULL').get(s.profile.id)).toEqual({n:1});
    expect(s.db.prepare('SELECT count(*) n FROM music_shouts WHERE profile_id=? AND archived_at IS NOT NULL').get(s.profile.id)).toEqual({n:1});
    expect(s.db.prepare('SELECT last_post_at FROM music_shout_authors WHERE profile_id=?').get(s.profile.id)).toEqual({last_post_at:1794988800});
  });
  it('rejects invalid text, forged authors, stale epochs, missing membership and unsafe requests without creating content',async()=>{
    const s=await setup();for(const text of ['  \n\t', '𠀀'.repeat(141)])expect((await s.post(s.input(text))).statusCode).toBe(400);
    expect((await s.post({...s.input(),profileId:'other'})).statusCode).toBe(409);expect((await s.post({...s.input(),musicEpoch:99})).statusCode).toBe(409);
    expect((await s.app.inject({method:'POST',url:'/api/v2/me/music/shouts',headers:{...s.headers,'idempotency-key':randomUUID()},payload:{...s.input(),qq:'bob'}})).statusCode).toBe(400);
    for(const patch of [{cookie:''},{'x-account-scope':'wrong'},{origin:'https://evil.example'},{'x-csrf-token':'wrong'}])expect((await s.app.inject({method:'POST',url:'/api/v2/me/music/shouts',headers:{...s.headers,...patch,'idempotency-key':randomUUID()},payload:s.input()})).statusCode).toBeGreaterThanOrEqual(400);
    expect(s.db.prepare('SELECT count(*) n FROM music_shouts WHERE profile_id=?').get(s.profile.id)).toEqual({n:0});
    for(const query of ['?qq=bob','?limit=51','?offset=-1','?limit=10&limit=20'])expect((await s.read('/api/v2/music/shouts'+query)).statusCode).toBe(400);
    expect((await s.app.inject({url:'/api/v2/music/shouts',headers:{...s.headers,cookie:''}})).statusCode).toBe(401);
    s.db.prepare("UPDATE music_profiles SET user_id=NULL WHERE user_id='alice'").run();expect((await s.read()).statusCode).toBe(403);
  });
  it('bounds newly archived history to 500, retains same-time order and clears pruned original documents',async()=>{
    const s=await setup();s.db.exec('DELETE FROM music_shouts; DELETE FROM music_documents');
    for(let i=0;i<503;i++)s.db.prepare('INSERT INTO music_shouts VALUES(?,NULL,?,?,?,?,?,?)').run('old-'+i,'','old','舊內容',100,i===502?null:0,i);
    s.db.prepare("INSERT INTO music_documents VALUES('shoutHistory',0,?)").run(JSON.stringify({id:'old-501',qq:'legacy',text:'應清除的副本',createdAt:100}));
    const result=MusicShouts.parse((await s.read('/api/v2/music/shouts/history?limit=50')).json());expect(result.total).toBe(500);expect(result.items.map(x=>x.id)).toEqual(Array.from({length:50},(_,i)=>'old-'+i));
    expect(s.db.prepare('SELECT * FROM music_documents').all()).toEqual([]);expect(s.db.prepare("SELECT * FROM music_shouts WHERE id='old-501'").get()).toBeUndefined();
  });
  it('checks administrator authority and revision, deletes both copies once and does not retain author content in audit or replay receipts',async()=>{
    const s=await setup(),list=AdminMusicShouts.parse((await s.read('/api/v2/admin/shouts')).json()),item=list.items[0]!;
    const url='/api/v2/admin/shouts/'+item.id+'/delete',key=randomUUID(),payload={revision:item.revision,confirm:true};
    expect((await s.app.inject({method:'POST',url,headers:{...s.headers,'idempotency-key':key},payload})).statusCode).toBe(403);
    expect((await s.app.inject({method:'POST',url,headers:{...s.admin,'idempotency-key':randomUUID()},payload:{...payload,revision:'0'.repeat(64)}})).statusCode).toBe(409);
    for(let i=0;i<2;i++)expect((await s.app.inject({method:'POST',url,headers:{...s.admin,'idempotency-key':key},payload})).statusCode).toBe(200);
    expect((await s.read('/api/v2/music/shouts/'+item.id)).statusCode).toBe(404);expect(s.db.prepare('SELECT count(*) n FROM music_shout_deletions').get()).toEqual({n:1});
    expect(JSON.stringify(s.db.prepare('SELECT * FROM music_shout_deletions').all())).not.toMatch(/週末|找搭子乙|234567/);expect(s.db.prepare("SELECT * FROM music_documents WHERE json_extract(payload_json,'$.id')=?").all(item.id)).toEqual([]);
    s.db.prepare("UPDATE user_admin_roles SET is_admin=0,revision=revision+1 WHERE user_id='alice'").run();expect((await s.read('/api/v2/admin/shouts')).statusCode).toBe(403);
    expect((await s.app.inject({method:'POST',url,headers:{...s.admin,'idempotency-key':key},payload})).statusCode).toBe(403);
  });
  it('erases native active/history/last-post metadata and sanitizes retries without deleting unrelated authors',async()=>{
    const s=await setup(),key=randomUUID(),input=s.input('刪除測試內容');expect((await s.post(input,key)).statusCode).toBe(200);
    s.db.prepare("INSERT INTO music_documents VALUES('shouts',2,?)").run(JSON.stringify({id:'native-import',qq:s.profile.id,name:'不得殘留名字',text:'不得殘留副本',createdAt:1}));
    s.db.prepare("INSERT INTO music_documents VALUES('shoutHistory',30,?)").run(JSON.stringify({id:'native-history',qq:s.profile.id,name:'不得殘留名字',text:'不得殘留歷史副本',createdAt:1,archivedAt:2}));
    for(const [id,archived] of [['native-import',null],['native-history',2]] as const)s.db.prepare('INSERT INTO music_shouts VALUES(?,?,?, ?,?,?,?,?)').run(id,s.profile.id,s.profile.id,'不得殘留名字','不得殘留副本',1,archived,100);
    for(const [kind,position,id] of [['shouts','2','native-import'],['shoutHistory','30','native-history']])s.db.prepare("INSERT INTO migration_map VALUES('music',?,?,?,?,?,'imported')").run(kind,position,id,'','');
    const profile=(await s.app.inject({url:'/api/v2/me/music',headers:s.headers})).json();
    expect((await s.app.inject({method:'POST',url:'/api/v2/me/privacy/erase',headers:s.headers,payload:{target:'music',profileId:profile.id,profileRevision:profile.revision,requestId:randomUUID(),secret:'a'.repeat(64),confirm:true}})).statusCode).toBe(200);
    expect(s.db.prepare('SELECT * FROM music_shouts WHERE profile_id=?').all(profile.id)).toEqual([]);expect(s.db.prepare('SELECT * FROM music_shout_authors').all()).toEqual([]);
    expect((await s.post(input,key)).statusCode).toBe(410);expect((await s.read()).statusCode).toBe(403);expect(s.db.prepare('SELECT count(*) n FROM music_shouts').get()).not.toEqual({n:0});
    expect(JSON.stringify(s.db.prepare('SELECT * FROM music_documents').all())).not.toMatch(/不得殘留/);
    expect(s.db.prepare("SELECT status FROM migration_map WHERE source='music' AND source_id IN ('2','30')").all()).toEqual([{status:'erased'},{status:'erased'}]);
  });
  it('keeps actual Python bot reads, all compatibility tables and every delivery state unchanged through archive, publish and moderation',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'qgroup-shouts-')),path=join(dir,'synthetic.db');cleanup.push(async()=>rmSync(dir,{recursive:true,force:true}));const s=await setup(openDatabase(path));
    for(const [i,status] of ['pending','sending','sent','failed','skipped'].entries())s.db.prepare(`INSERT INTO bot_outbox(event_id,kind,dedupe_key,target,payload_json,status,attempts,claim_token,retry_at,simulated_at,created_at) VALUES('listen','synthetic',?,'synthetic','{}',?,2,?,'retry-time','simulated','before')`).run('key-'+i,status,'claim-'+i);
    const names=(s.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'music_%' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('request_results','auth_requests') ORDER BY name").all() as {name:string}[]).map(r=>r.name),snapshot=()=>names.map(name=>s.db.prepare('SELECT * FROM "'+name+'"').all()),before=snapshot();
    const probe=()=>JSON.parse(execFileSync('python3',['tools/rebuild/probe-auth-bot.py',path],{encoding:'utf8'})),bot=probe();
    await s.read();const posted=await s.post(),row=AdminMusicShouts.parse((await s.read('/api/v2/admin/shouts')).json()).items.find(x=>x.id===posted.json().id)!;
    expect((await s.app.inject({method:'POST',url:'/api/v2/admin/shouts/'+row.id+'/delete',headers:{...s.admin,'idempotency-key':randomUUID()},payload:{revision:row.revision,confirm:true}})).statusCode).toBe(200);
    expect(probe()).toEqual(bot);expect(snapshot()).toEqual(before);
  });
});
