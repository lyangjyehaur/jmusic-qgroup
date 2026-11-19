import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { legacyHistoryFixture } from '../testsupport/legacy-history-fixture';
import { createLegacyMusicHistory } from './legacy-music-history';
import { createApp, hash } from './app';
import { exportMusic } from './music-export';
import { createPrivacy } from './privacy';
import { erasureJournal, readVerifiedErasureJournal, type ErasureIntent } from './erasure-journal';
import { profileId } from '../../../tools/migration/music-codec';
const cleanup:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function setup(){
  const s=await legacyHistoryFixture();cleanup.push(()=>s.close());s.db.prepare("INSERT INTO user_admin_roles VALUES('alice',1,1,'synthetic')").run();
  const journal=erasureJournal(s.db),app=createApp({db:s.db,origin:'https://rebuild.example',pairedBackupScheduling:false,legacyHistory:s.config});await app.ready();cleanup.push(()=>app.close());
  const cookie='kanban_session=fixture-alice',viewer=(await app.inject({url:'/api/v2/session',headers:{cookie}})).json();
  const headers={cookie,'x-account-scope':viewer.scope};
  const read=(id='legacy-pair-'+s.stamp,h=headers)=>app.inject({url:'/api/v2/admin/music-export?backup='+id,headers:h});
  const history=createLegacyMusicHistory(s.db,s.config);
  const submit=(fields:Omit<Extract<ErasureIntent,{version:1}>,'version'|'requestId'|'secretHash'|'signature'|'createdAt'>|Omit<Extract<ErasureIntent,{version:2}>,'version'|'requestId'|'secretHash'|'signature'|'createdAt'>)=>{
    const privacy=createPrivacy(s.db,journal);s.db.transaction(()=>privacy.submit({...fields,version:'command' in fields?2:1,requestId:randomUUID(),secretHash:hash('secret'),signature:hash('command'),createdAt:'2026-11-19T08:00:00.000Z'} as ErasureIntent)).immediate();privacy.guard();
  };
  return {...s,app,headers,read,history,journal,submit};
}
it('lists both original formats with collision-free IDs, provenance and unknown timezone/schema, and applies latest identity only',async()=>{
  const s=await setup(),originals=new Map<string,Buffer>();
  function walk(path:string,prefix=''){for(const item of readdirSync(path,{withFileTypes:true})){const name=prefix+item.name;if(item.isDirectory())walk(join(path,item.name),name+'/');else originals.set(name,readFileSync(join(path,item.name)));}}walk(s.capture);
  s.db.prepare("UPDATE music_profiles SET user_id=NULL WHERE id=?").run(profileId('10002'));
  s.db.prepare("UPDATE music_legacy_profiles SET pin_hash='latest-pin' WHERE profile_id=?").run(profileId('10002'));
  s.db.prepare("UPDATE music_profile_contacts SET contact_qq='' WHERE profile_id=?").run(profileId('10002'));
  s.db.prepare("UPDATE music_profile_fields SET name='最新稱呼' WHERE profile_id=?").run(profileId('10002'));
  const live=exportMusic(s.db),bot=s.db.prepare('SELECT * FROM bot_outbox').all(),identities=s.db.prepare('SELECT * FROM external_identities').all();
  const list=await s.app.inject({url:'/api/v2/admin/backups',headers:s.headers});expect(list.statusCode,list.body).toBe(200);
  expect(list.json().backups).toEqual(s.history.list());expect(list.json().backups.map((item:{id:string})=>item.id)).toEqual(['legacy-json-'+s.stamp,'legacy-pair-'+s.stamp]);
  expect(list.json().backups.every((item:{createdAt:unknown;schema:unknown})=>item.createdAt===null&&item.schema===null)).toBe(true);
  for(const item of s.history.list()){
    const response=await s.read(item.id);expect(response.statusCode,response.body).toBe(200);expect(response.headers['cache-control']).toBe('no-store');expect(response.headers['content-disposition']).toContain(item.id);
    const body=response.json();expect(body.members['10002']).toMatchObject({name:'原稱呼bob',note:'歷史私人留言',pinHash:'latest-pin',boardUserId:'',contactQQ:'',selection:[{id:'e',level:4},{id:'e',level:'2'}]});
    expect(body.members['10004']).toMatchObject({name:'歷史獨有成分',pinHash:'',boardUserId:'',contactQQ:''});expect(body.settings).toEqual({});expect(body.trend).toEqual(s.historical.trend);
    expect(response.body).not.toMatch(/HISTORICAL-PIN-NEVER-EXPORTED|HISTORICAL-ADMIN-NEVER-EXPORTED|token_hash|fixture-alice/);
  }
  for(const [path,bytes] of originals)expect(readFileSync(join(s.capture,path))).toEqual(bytes);
  expect(exportMusic(s.db)).toEqual(live);expect(s.db.prepare('SELECT * FROM bot_outbox').all()).toEqual(bot);expect(s.db.prepare('SELECT * FROM external_identities').all()).toEqual(identities);
  expect(readdirSync(join(s.capture,s.pair))).toEqual(['data.json','identity.sqlite3','walls']);
});
it.each(['music','both','account'] as const)('replays %s privacy scope across both legacy history formats',async(kind)=>{
  const s=await setup();s.submit({kind,userId:'bob',profileId:profileId('10002')});
  for(const item of s.history.list()){
    const response=await s.read(item.id);expect(response.statusCode,response.body).toBe(200);
    if(kind==='account'){expect(response.json().members['10002']).toMatchObject({boardUserId:'',name:'原稱呼bob'});expect(response.body).toContain('歷史私人喊話');}
    else{expect(response.json().members['10002']).toBeUndefined();expect(response.body).not.toContain('歷史私人喊話');expect(response.json().entries.e.createdBy).toBe('');}
    expect(response.json().members['10004']).toBeDefined();
  }
});
it.each(['delete_profile','reset_music'] as const)('applies captured IDs for administrative %s, including orphan history and private creators',async(command)=>{
  const s=await setup();s.submit({kind:'admin_music',command,actorRef:'account:alice',profiles:[{id:profileId('10002'),userId:'bob'}],entries:command==='reset_music'?['e']:[]});
  for(const item of s.history.list()){
    const response=await s.read(item.id);expect(response.statusCode,response.body).toBe(200);const body=response.json();expect(body.members['10002']).toBeUndefined();expect(body.members['10004']).toBeDefined();
    if(command==='reset_music'){expect(body.entries).toEqual({});expect(body.shouts).toEqual([]);expect(body.shoutHistory).toEqual([]);expect(body.trend).toEqual([]);expect(body.members['10004'].selection).toEqual([]);expect(body.members['10004'].created).toEqual([]);}
    else expect(body.entries.e.createdBy).toBe('');
  }
});
it('applies the latest legacy erasure keys, including history-only profiles and profile-ID creators',async()=>{
  const s=await setup();s.db.prepare('INSERT INTO music_legacy_erasures VALUES(?,?)').run('10004','123');s.db.prepare('INSERT INTO music_legacy_erasures VALUES(?,?)').run('10002','123');
  const data=structuredClone(s.historical);data.entries.e.createdBy=profileId('10002');s.save(s.pair+'/data.json',data);const history=createLegacyMusicHistory(s.db,s.repin());
  const result=history.export('legacy-pair-'+s.stamp,readVerifiedErasureJournal(s.db,s.journal));expect(result.members).not.toHaveProperty('10004');expect(result.members).not.toHaveProperty('10002');
  // Deterministic profile-ID references must be scrubbed together with legacy keys.
  expect((result.entries as Record<string,{createdBy:string}>).e!.createdBy).toBe('');
});
it('requires a current administrator and account scope for lists and downloads; names cannot address source paths',async()=>{
  const s=await setup();expect((await s.app.inject({url:'/api/v2/admin/backups'})).statusCode).toBe(401);expect((await s.app.inject({url:'/api/v2/admin/music-export?backup=legacy-pair-'+s.stamp})).statusCode).toBe(401);
  expect((await s.read(undefined,{...s.headers,'x-account-scope':'wrong'})).statusCode).toBe(409);
  for(const query of ['legacy-pair-../identity.sqlite3','legacy-pair-'+s.stamp+'&extra=x'])expect((await s.read(query)).statusCode).toBe(400);
  expect((await s.read('legacy-json-20260101-000000')).statusCode).toBe(404);s.db.prepare("UPDATE user_admin_roles SET is_admin=0 WHERE user_id='alice'").run();expect((await s.read()).statusCode).toBe(403);
});
it.each(['bytes','pin','missing pair','symlink file','symlink directory','extra file','foreign capture','unknown field','duplicate JSON key','unsafe number','broken identity','missing wall'])('rejects %s with a redacted error and preserves live data',async(kind)=>{
  const s=await setup(),live=exportMusic(s.db);let history=s.history;
  if(kind==='bytes')s.save(s.pair+'/data.json','PRIVATE-CORRUPT');
  if(kind==='pin')s.save('capture-manifest.json','PRIVATE-CORRUPT');
  if(kind==='missing pair')rmSync(join(s.capture,s.pair,'identity.sqlite3'));
  if(kind==='symlink file'){rmSync(join(s.capture,s.pair,'data.json'));symlinkSync(join(s.capture,'current/music/data.json'),join(s.capture,s.pair,'data.json'));}
  if(kind==='symlink directory'){rmSync(join(s.capture,s.pair,'walls'),{recursive:true});symlinkSync(join(s.capture,'current/music/walls'),join(s.capture,s.pair,'walls'));}
  if(kind==='extra file')s.save(s.pair+'/unknown.env','PRIVATE-CORRUPT');
  if(kind==='foreign capture')s.db.prepare('DELETE FROM migration_runs').run();
  if(kind==='unknown field'){s.save(s.pair+'/data.json',{...s.historical,credentials:'PRIVATE-CORRUPT'});history=createLegacyMusicHistory(s.db,s.repin());}
  if(kind==='duplicate JSON key'){s.save(s.pair+'/data.json','{"members":{},"members":{},"entries":{}}');history=createLegacyMusicHistory(s.db,s.repin());}
  if(kind==='unsafe number'){s.save(s.pair+'/data.json','{"members":{},"entries":{},"secret":9007199254740993}');history=createLegacyMusicHistory(s.db,s.repin());}
  if(kind==='broken identity'){s.save(s.pair+'/identity.sqlite3',Buffer.from('PRIVATE-CORRUPT'));history=createLegacyMusicHistory(s.db,s.repin());}
  if(kind==='missing wall'){s.save(s.pair+'/walls/manifest.json',{items:[{src:'/walls/missing.png'}]});history=createLegacyMusicHistory(s.db,s.repin());}
  expect(()=>history.export('legacy-pair-'+s.stamp,[])).toThrow();expect(exportMusic(s.db)).toEqual(live);
  const response=await s.read();expect(response.statusCode,response.body).toBe(503);expect(response.body).not.toMatch(/PRIVATE-CORRUPT|\/tmp|\/Users|token_hash/);
});
it('blocks history when latest erasure receipts are lost, and resumes only after recovery',async()=>{
  const s=await setup();s.submit({kind:'music',userId:'bob',profileId:profileId('10002')});const path=join(s.root,'candidate/unified.erasures.jsonl'),bytes=readFileSync(path);rmSync(path);
  expect((await s.read()).statusCode).toBe(503);s.save('../candidate/unified.erasures.jsonl',bytes);expect((await s.read()).statusCode).toBe(200);
});
it('preserves legacy account-only closure behavior and refuses a captured intent missing from the latest ledger',async()=>{
  const s=await setup(),intent={user_id:'bob',request_id:'legacy-close',created_at:'source'};
  s.save('../candidate/unified.erasures.jsonl',JSON.stringify(intent)+'\n');createPrivacy(s.db,s.journal);
  const response=await s.read();expect(response.statusCode,response.body).toBe(200);expect(response.json().members['10002']).toMatchObject({boardUserId:'',name:'原稱呼bob'});
  // Changing a capture's current source requires a matching committed import,
  // even if an operator computes a new manifest pin.
  s.save('current/board.erasures.jsonl',JSON.stringify(intent)+'\n');
  const history=createLegacyMusicHistory(s.db,s.repin());expect(()=>history.list()).toThrow('this imported source');
});
it('verifies acquisition-time erasure provenance and scrubs history-only profiles without importing their credentials',async()=>{
  const intent={user_id:'bob',request_id:'captured-account-close',created_at:'source'};
  const s=await legacyHistoryFixture({boardLedger:JSON.stringify(intent)+'\n',musicLedger:JSON.stringify({qq:'10004',erased_at:123})+'\n'});cleanup.push(()=>s.close());
  const history=createLegacyMusicHistory(s.db,s.config);expect(()=>history.export('legacy-pair-'+s.stamp,[])).toThrow('intent was lost');
  const body=history.export('legacy-pair-'+s.stamp,[intent]);expect(body.members).not.toHaveProperty('10004');expect(body.members).toHaveProperty('10002.boardUserId','');
});
it('rejects nested unclassified fields rather than exposing opaque credentials in known historical containers',async()=>{
  const s=await setup();
  for(const mutate of [
    (data:Record<string,any>)=>{data.members['10002'].selection[0].level={token:'PRIVATE-UNKNOWN'};},
    (data:Record<string,any>)=>{data.members['10002'].noteAt={token:'PRIVATE-UNKNOWN'};},
    (data:Record<string,any>)=>{data.entries.e.aliases=[{token:'PRIVATE-UNKNOWN'}];},
    (data:Record<string,any>)=>{data.trend[0].counts={e:{token:'PRIVATE-UNKNOWN'}};},
  ]){
    const data=structuredClone(s.historical);mutate(data);s.save(s.pair+'/data.json',data);const history=createLegacyMusicHistory(s.db,s.repin());expect(()=>history.export('legacy-pair-'+s.stamp,[])).toThrow();
  }
});
it('accepts optional paired erasure ledgers and checks them against latest durable erasures',async()=>{
  const s=await legacyHistoryFixture({musicLedger:'{"qq":"10004","erased_at":123}\n'});cleanup.push(()=>s.close());
  s.save(s.pair+'/erasures.jsonl','{"qq":"10004","erased_at":122}\n');
  const history=createLegacyMusicHistory(s.db,s.repin());expect(history.list()).toHaveLength(2);expect(history.export('legacy-pair-'+s.stamp,[]).members).not.toHaveProperty('10004');
});
it.each(['missing latest marker','incomplete ledger'])('rejects optional paired erasure ledger with %s',async(change)=>{
  const s=await setup();s.save(s.pair+'/erasures.jsonl',change==='missing latest marker'?'{"qq":"10004","erased_at":123}\n':'{"qq":"10004","erased_at":123}');
  const history=createLegacyMusicHistory(s.db,s.repin());expect(history.list()).toHaveLength(2);expect(()=>history.export('legacy-pair-'+s.stamp,[])).toThrow();
});
