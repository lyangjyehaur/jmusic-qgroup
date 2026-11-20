import {randomUUID} from 'node:crypto';
import {afterEach,expect,it} from 'vitest';
import {openDatabase,type DB} from '@qgroup/database';
import {createApp} from './app';
import {hash} from './security';
import {fixture} from '../testsupport/fixture';
import {botDeliveryFixture} from '../testsupport/bot-delivery-fixture';
import {orphanMusicResetFixture} from '../testsupport/orphan-music-reset-fixture';
import {forwardRows} from '../../../tools/migration/forward-board-storage';
import type {StoredIntent} from './erasure-journal';
const cleanup:(()=>Promise<void>)[]=[];afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function setup(mode:'shouts'|'trend'|'empty'='empty'){
  const db=openDatabase(':memory:'),journal:StoredIntent[]=[],origin='https://rebuild.example';fixture(db);botDeliveryFixture(db);orphanMusicResetFixture(db,mode);
  db.prepare("INSERT INTO user_admin_roles VALUES('alice',1,1,'synthetic')").run();
  const app=createApp({db,origin,now:()=>new Date('2026-11-21T00:00:00.000Z'),erasureJournal:{read:()=>journal,append:entry=>{journal.push(entry);}}});await app.ready();cleanup.push(async()=>{await app.close();db.close();});
  const cookie='kanban_session=fixture-alice',viewer=(await app.inject({url:'/api/v2/session',headers:{cookie}})).json(),headers={cookie,origin,'x-account-scope':viewer.scope,'x-csrf-token':viewer.csrf};
  const admin=(await app.inject({url:'/api/v2/admin/session',headers})).json();
  const preview=async()=>{const response=await app.inject({url:'/api/v2/admin/music-reset',headers});expect(response.statusCode).toBe(200);return response.json();};
  const input=async()=>({revision:(await preview()).revision,confirm:'RESET',requestId:randomUUID(),secret:'ab'.repeat(32)});
  const send=(body:object)=>app.inject({method:'POST',url:'/api/v2/admin/music-reset',headers:{...headers,'x-admin-csrf':admin.adminCsrf},payload:body});
  return {db,app,journal,preview,input,send};
}
function rows(db:DB){return new Map((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string}[]).map(({name})=>[name,[...forwardRows(db,name)]]));}
const kinds=['current shout','archived shout','shout source','shout history source','legacy trend','native trend sample'] as const;
it.each(kinds)('resets an otherwise empty catalog containing only %s and preserves every unrelated typed row',async kind=>{
  const s=await setup();
  if(kind==='current shout'||kind==='archived shout')s.db.prepare("INSERT INTO music_shouts VALUES('only-orphan',NULL,'99999','原稱呼','原文',123.25,?,?)").run(kind==='archived shout'?124.5:null,kind==='archived shout'?1:0);
  else s.db.prepare('INSERT INTO music_documents VALUES(?,0,?)').run({'shout source':'shouts','shout history source':'shoutHistory','legacy trend':'trend','native trend sample':'trend_sample'}[kind],JSON.stringify({opaque:['original',false,null],t:123.25}));
  const preview=await s.preview(),before=rows(s.db),body=await s.input(),response=await s.send(body);
  expect(response.statusCode,response.body).toBe(200);expect(response.json()).toEqual({requestId:body.requestId,target:'admin_music',command:'reset_music',status:'completed',profiles:0,entries:0});
  expect(preview).toMatchObject({profiles:0,entries:0,shouts:kind.endsWith('shout')?1:0,historyRecords:kind.endsWith('shout')?0:1});
  for(const [table,original] of before){
    if(['music_shouts','privacy_receipts','erasure_applied','music_catalog_actions'].includes(table))continue;
    const expected=table==='music_documents'?original.filter(row=>!['shouts','shoutHistory','trend','trend_sample'].includes(String(row.kind))):original;
    expect([...forwardRows(s.db,table)],table).toEqual(expected);
  }
  expect(s.db.prepare('SELECT * FROM music_shouts').all()).toEqual([]);expect(s.journal).toHaveLength(1);
  expect(s.db.prepare('SELECT command,affected_profiles FROM music_catalog_actions').all()).toEqual([{command:'reset_music',affected_profiles:0}]);
  expect(s.db.prepare('SELECT request_id FROM erasure_applied').all()).toEqual([{request_id:body.requestId}]);
  expect(s.db.prepare('SELECT secret_hash,result_json FROM privacy_receipts').get()).toEqual({secret_hash:hash(body.secret),result_json:JSON.stringify(response.json())});
  const saved=rows(s.db);expect((await s.send(body)).json()).toEqual(response.json());expect(rows(s.db)).toEqual(saved);expect(s.journal).toHaveLength(1);expect(s.db.pragma('foreign_key_check')).toEqual([]);
});
it.each(['empty','settings only'] as const)('rejects %s without recording an erasure or touching bot work',async kind=>{
  const s=await setup();if(kind==='empty')s.db.prepare("DELETE FROM music_documents WHERE kind='settings'").run();const before=rows(s.db);
  expect((await s.send(await s.input())).json()).toMatchObject({code:'NO_MUSIC_DATA'});expect(rows(s.db)).toEqual(before);expect(s.journal).toEqual([]);
});
it.each(['history','shout limiter','mapping'] as const)('rejects a changed %s after orphan-history review before making an intent durable',async kind=>{
  const s=await setup('trend');
  s.db.prepare("INSERT INTO music_profiles VALUES('erased-owner',NULL,0,'before','before')").run();s.db.prepare("INSERT INTO music_shout_authors VALUES('erased-owner',123.25)").run();
  const body=await s.input();
  if(kind==='history')s.db.prepare("UPDATE music_documents SET payload_json=? WHERE kind='trend'").run(JSON.stringify({t:999}));
  if(kind==='shout limiter')s.db.prepare('UPDATE music_shout_authors SET last_post_at=124.5').run();
  if(kind==='mapping')s.db.prepare("UPDATE migration_map SET payload_digest='later-generation' WHERE entity_type='trend'").run();
  const before=rows(s.db),response=await s.send(body);expect(response.statusCode).toBe(409);expect(response.json().code).toBe('MUSIC_ERASURE_CHANGED');expect(rows(s.db)).toEqual(before);expect(s.journal).toEqual([]);
});
it('resets only remaining shout publication records while retaining the original profile tombstone and all bot rows',async()=>{
  const s=await setup();s.db.prepare("INSERT INTO music_profiles VALUES('erased-owner',NULL,0,'before','before')").run();s.db.prepare("INSERT INTO music_shout_authors VALUES('erased-owner',123.25)").run();
  expect(await s.preview()).toMatchObject({profiles:0,entries:0,shouts:0,historyRecords:1});const before=rows(s.db),body=await s.input(),response=await s.send(body);expect(response.statusCode,response.body).toBe(200);
  for(const [table,original] of before)if(!['music_shout_authors','privacy_receipts','erasure_applied','music_catalog_actions'].includes(table))expect([...forwardRows(s.db,table)],table).toEqual(original);
  expect(s.db.prepare('SELECT * FROM music_shout_authors').all()).toEqual([]);expect(s.db.prepare('SELECT * FROM music_profiles').all()).toEqual([{id:'erased-owner',user_id:null,revision:0,updated_at:'before',erased_at:'before'}]);expect(s.journal).toHaveLength(1);
});
it('clears mixed orphan history and its mappings without changing unknown source metadata or any bot delivery state',async()=>{
  const s=await setup('shouts'),before=rows(s.db),response=await s.send(await s.input());expect(response.statusCode,response.body).toBe(200);
  for(const [table,original] of before){
    if(['music_shouts','music_shout_authors','privacy_receipts','erasure_applied','music_catalog_actions'].includes(table))continue;
    const expected=table==='music_documents'?original.filter(row=>!['shouts','shoutHistory','trend','trend_sample'].includes(String(row.kind))):table==='migration_map'?original.map(row=>row.source==='music'&&['shouts','shoutHistory','trend'].includes(String(row.entity_type))?{...row,status:'deleted'}:row):original;
    expect([...forwardRows(s.db,table)],table).toEqual(expected);
  }
  expect(s.db.prepare("SELECT entity_type,status FROM migration_map ORDER BY entity_type").all()).toEqual([{entity_type:'trend',status:'deleted'},{entity_type:'unrelated',status:'imported'}]);expect(s.db.prepare('SELECT * FROM music_shouts').all()).toEqual([]);
});
