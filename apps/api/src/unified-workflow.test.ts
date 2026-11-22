import { randomBytes,randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync,mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { it,expect } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { SettlementInput } from '@qgroup/contracts';
import { createApp } from './app';
import { fixture } from '../testsupport/fixture';
import { adminCatalogFixture } from '../testsupport/admin-catalog-fixture';
import { eventRow } from './activity-arrangements';

it('keeps one account, roster and payment identity through music, matching, activity, adopted rooms and settlement',async()=>{
 const root=mkdtempSync(join(tmpdir(),'qgroup-unified-workflow-')),db=openDatabase(join(root,'state.db')),origin='https://rebuild.example';fixture(db);adminCatalogFixture(db);
 const app=createApp({db,origin,now:()=>new Date('2026-11-17T08:00:00Z'),musicTrendSampling:false,pairedBackupScheduling:false});
 try{
  await app.ready();expect((await app.inject({url:'/api/v2/session'})).json().authenticated).toBe(false);
  const auth=async(user='alice')=>{const cookie='kanban_session=fixture-'+user,s=(await app.inject({url:'/api/v2/session',headers:{cookie}})).json();return {cookie,origin,'x-account-scope':s.scope,'x-csrf-token':s.csrf,'idempotency-key':randomUUID()};};
  const alice=await auth(),bob=await auth('bob');
  const get=async(url:string,headers=alice)=>{const r=await app.inject({url,headers});expect(r.statusCode,r.body).toBe(200);return r.json();};
  const post=async(url:string,payload:object,headers=alice)=>{const r=await app.inject({method:'POST',url,headers:{...headers,'idempotency-key':randomUUID()},payload});expect(r.statusCode,r.body).toBe(200);return r.json();};
  const prior=await get('/api/v2/me/music'),selections=[{entryId:'sub-0',level:4},{entryId:'main-0',level:4},{entryId:'sub-1',level:4}];
  const saved=await app.inject({method:'PUT',url:'/api/v2/me/music',headers:alice,payload:{profileId:prior.id,musicEpoch:0,revision:prior.revision,selections}});expect(saved.statusCode,saved.body).toBe(200);expect((await get('/api/v2/me/music')).selections).toEqual(selections);
  expect((await get('/api/v2/session')).scope).toBe(alice['x-account-scope']);await get('/api/v2/music/matches');await get('/api/v2/search?q='+encodeURIComponent('Aimer'));
  const draft=await post('/api/v2/activities/drafts',{values:{title:'統一流程活動',category:'约K',location:'合成場地',startsAt:'2099-12-11T18:00:00+08:00',deadline:'2099-12-10T00:00:00Z',timezone:'Asia/Taipei',capacity:3,joinOwner:true}}),id=draft.id as string,base='/api/v2/activities/'+id;
  await post(base+'/draft/publish',{revision:draft.revision,confirm:true,acceptConditions:true});
  for(const [headers,people] of [[bob,[{isSelf:true,name:'',note:'',payerKind:'self'}]],[alice,[{isSelf:false,name:'沒有成分的同行',note:'保留原付款責任',payerKind:'manager'}]]] as const){
   const values={revision:eventRow(db,id)!.revision,people,queueMode:'individual',intent:'registered'},preview=await post(base+'/registration/preview',values,headers);
   await post(base+'/registration',{...values,previewToken:preview.token,conditionsVersion:preview.conditionsVersion,acceptConditions:true,acceptPartial:true,confirm:true},headers);
  }
  const source=await get('/api/v2/music/rooms/source?eventId='+id),members=source.members as {id:string;profileId:string|null;name:string}[],selected=members.map(m=>m.id);
  expect(members).toHaveLength(3);expect(members.find(m=>m.name==='沒有成分的同行')?.profileId).toBeNull();
  const calculationSelected=members.filter(m=>m.profileId).map(m=>m.id);
  const split=await post('/api/v2/music/rooms/calculate?eventId='+id,{command:'split',sourceVersion:source.sourceVersion,selected:calculationSelected,config:{mode:'capacity',value:3},sameGender:false});
  expect(split.rooms.flatMap((r:{members:string[]})=>r.members).sort()).toEqual([...calculationSelected].sort());
  const ctx=await get(base+'/rooms'),roomId=randomBytes(8).toString('hex'),rooms=[{id:roomId,name:'包間一',payer_id:ctx.payers[0].id,person_ids:[...selected]}],roomInput={revision:ctx.revision,rooms,reason:'採用成分建議',music_source_version:source.sourceVersion,confirm:true};
  const denied=await app.inject({method:'POST',url:base+'/rooms',headers:{...bob,'idempotency-key':randomUUID()},payload:roomInput});expect(denied.statusCode).toBe(403);
  await post(base+'/rooms',roomInput);expect((await get(base+'/rooms')).rooms[0].person_ids.sort()).toEqual([...selected].sort());
  for(const action of ['start','finish'])await post(base+'/lifecycle',{revision:eventRow(db,id)!.revision,action,reason:'實際流程核對',confirm:true});
  const settlement=await get(base+'/settlement/context'),input=SettlementInput.parse({revision:settlement.revision,base_version:0,reviewed_roster:true,people:selected.map(personId=>({id:personId})),rooms:[{...rooms[0],amount:'9.00',merchant_mode:'unpaid'}],items:[]}),preview=await post(base+'/settlement/preview',input),key=randomUUID(),payload={...input,preview_token:preview.preview_token,confirm:true};
  const publish=()=>app.inject({method:'POST',url:base+'/settlement',headers:{...alice,'idempotency-key':key},payload});
  const bill=await publish();expect(bill.statusCode,bill.body).toBe(200);const before=db.prepare('SELECT total_changes() AS n').get();expect((await publish()).json()).toEqual(bill.json());expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
  const detail=(await get(base+'/settlement')).bill.detail;expect(detail.total_cents).toBe(900);expect(detail.people.map((p:{id:string})=>p.id).sort()).toEqual([...selected].sort());expect(detail.payers.reduce((n:number,p:{amount_cents:number})=>n+p.amount_cents,0)).toBe(900);expect([...detail.rooms[0].person_ids].sort()).toEqual([...selected].sort());
  await get(base+'/finance');await get('/api/v2/me/todos');expect((await get('/api/v2/me/music')).selections).toEqual(selections);expect((await get('/api/v2/session')).scope).toBe(alice['x-account-scope']);
  const sourceRoot=join(root,'python');mkdirSync(sourceRoot);const commit='07defc429d619a7558ab7218372886f531813ae3';execFileSync('tar',['-xf','-','-C',sourceRoot],{input:execFileSync('git',['archive',commit,'qgroup_core'])});const path=join(root,'retained.db'),snapshot=db.serialize();snapshot[18]=1;snapshot[19]=1;writeFileSync(path,snapshot);
  const old=JSON.parse(execFileSync('python3',['-c',`import json,sqlite3,sys,socket
sys.path.insert(0,sys.argv[1]);socket.socket=lambda *a,**k:(_ for _ in ()).throw(AssertionError('network denied'))
from qgroup_core import rooms,bot_views
db=sqlite3.connect('file:'+sys.argv[2]+'?mode=ro',uri=True);db.row_factory=sqlite3.Row
event=db.execute('SELECT * FROM events WHERE id=?',(sys.argv[3],)).fetchone()
print(json.dumps(dict(rooms=rooms.current(db,event['id']),counts=bot_views.counts(db,event['id']),settlement=json.loads(db.execute('SELECT snapshot_json FROM settlement_details WHERE event_id=? AND version=1',(event['id'],)).fetchone()[0]))))`,sourceRoot,path,id],{encoding:'utf8',timeout:15000}));
  expect(old.rooms).toEqual(detail.rooms);expect(old.counts).toEqual({confirmed:3,waiting:0,tentative:0,pending:0,declined:0,withdrawals:0});expect(old.settlement.total_cents).toBe(900);expect(old.settlement.people.map((p:{id:string})=>p.id).sort()).toEqual([...selected].sort());expect(old.settlement.payers).toEqual(detail.payers);expect(db.pragma('foreign_key_check')).toEqual([]);expect(db.pragma('integrity_check',{simple:true})).toBe('ok');
 }finally{await app.close();db.close();rmSync(root,{recursive:true,force:true});}
});
