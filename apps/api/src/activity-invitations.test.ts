import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { ActivityInvitations, ActivityInvitationPreview } from '@qgroup/contracts';
import { fixture } from '../testsupport/fixture';
import { createApp } from './app';
import { eventRow } from './activity-arrangements';
const origin='https://rebuild.example',stamp='2026-11-17T00:00:00+00:00';
const cleanups:(()=>Promise<unknown>)[]=[];afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();});
async function setup(){
  const db=openDatabase(':memory:');fixture(db);db.exec("UPDATE events SET bot_enabled=1,capacity=2,revision=3,starts_at='2026-11-20T10:00:00+00:00',deadline='2026-11-19T10:00:00+00:00' WHERE id='listen'");
  db.prepare('UPDATE bot_settings SET config_json=?').run(JSON.stringify({enabled:true,groups:[{id:'synthetic-group',name:'測試',replies:true,broadcast:true}]}));
  const app=createApp({db,origin,now:()=>new Date(stamp),activityBot:{enabled:true,baseURL:origin,keyboard:true,personalQueue:true}});await app.ready();cleanups.push(async()=>{await app.close();db.close();});
  async function headers(user:string){const cookie='kanban_session=fixture-'+user,session=(await app.inject({url:'/api/v2/session',headers:{cookie}})).json();return {cookie,origin,'x-account-scope':session.scope,'x-csrf-token':session.csrf};}
  const alice=await headers('alice'),bob=await headers('bob');
  const write=(path:string,data:unknown,h=alice,key=randomUUID())=>app.inject({method:'POST',url:'/api/v2/activities/listen/'+path,headers:{...h,'idempotency-key':key},payload:data as object});
  const values=(people=[{isSelf:true,name:'',note:'',payerKind:'self'}],patch:Record<string,unknown>={})=>({revision:eventRow(db,'listen')!.revision,people,queueMode:'individual',intent:'registered',...patch});
  const preview=(data=values(),h=alice)=>write('registration/preview',data,h);
  const signup=async(data=values(),h=alice,key=randomUUID())=>{const p=await preview(data,h);expect(p.statusCode).toBe(200);return write('registration',{...data,previewToken:p.json().token,conditionsVersion:p.json().conditionsVersion,acceptConditions:true,acceptPartial:true,confirm:true},h,key);};
  const change=(personId:string,action:string,patch:Record<string,unknown>={},h=alice,key=randomUUID())=>write('attendees/'+personId+'/registration',{revision:eventRow(db,'listen')!.revision,action,name:'同行',note:'',payerKind:'self',reason:'',confirm:true,...patch},h,key);
  const people=()=>db.prepare("SELECT * FROM attendees WHERE event_id='listen' ORDER BY seq").all() as {id:string;party_id:string;status:string;name:string;manager_id:string;user_id:string|null}[];
  const invite=(people=[guest('受邀者')],patch:Record<string,unknown>={},h=alice,key=randomUUID())=>write('invitations',{revision:eventRow(db,'listen')!.revision,people,reason:'補報名核對',confirm:true,...patch},h,key);
  const list=async(h=alice)=>ActivityInvitations.parse((await app.inject({url:'/api/v2/activities/listen/invitations',headers:h})).json());
  const accept=async(token:string,patch:Record<string,unknown>={},h=bob,key=randomUUID())=>write('invitations/'+token+'/accept',{revision:eventRow(db,'listen')!.revision,conditionsVersion:1,acceptConditions:true,acceptWaiting:true,confirm:true,...patch},h,key);
  return {db,app,alice,bob,write,values,preview,signup,change,people,invite,list,accept};
}
const guest=(name:string,payerKind='manager')=>({isSelf:false,name,note:'同行備註',payerKind});
const tables=['events','attendees','roster_parties','attendee_consents','event_audit','notifications','bot_outbox','finance_entries','attendee_payment_origins','event_access'];
function state(db:ReturnType<typeof openDatabase>){return Object.fromEntries(tables.map(table=>[table,db.prepare('SELECT * FROM '+table+" WHERE "+(table==='events'?'id':table==='attendee_payment_origins'?'attendee_id IN (SELECT id FROM attendees WHERE event_id':'event_id')+(table==='attendee_payment_origins'?"='listen')":"='listen'")+" ORDER BY rowid").all()]));}
function normalize(input:Record<string,unknown>){
  let text=JSON.stringify(input);
  for(const [index,row] of (input.attendees as {id:string;invitation_token:string|null}[]).entries()){text=text.replaceAll(row.id,'PERSON_'+index);if(row.invitation_token)text=text.replaceAll(row.invitation_token,'TOKEN_'+index);}
  for(const [index,row] of (input.roster_parties as {id:string}[]).entries())text=text.replaceAll(row.id,'PARTY_'+index);
  const result=JSON.parse(text);for(const rows of Object.values(result) as Record<string,unknown>[][])for(const row of rows)for(const [key,value] of Object.entries(row))if(key.endsWith('_json')&&typeof value==='string')row[key]=JSON.parse(value);
  for(const row of result.event_audit)for(const key of ['before_json','after_json'])if(row[key].participants)row[key].participants.sort((a:{id:string},b:{id:string})=>a.id.localeCompare(b.id));return result;
}
async function differential(s:Awaited<ReturnType<typeof setup>>,action:string,run:()=>Promise<unknown>){
  const folder=mkdtempSync(join(tmpdir(),'qgroup-roster-diff-')),path=join(folder,'synthetic.sqlite3');
  try{
    await s.db.backup(path);const expected=JSON.parse(execFileSync('python3',['-c',`import datetime,json,sqlite3,sys
from qgroup_core import events,conditions,roster,audit,bot_outbox,bot_settings,bot_views,lifecycle
db=sqlite3.connect(sys.argv[1]);db.row_factory=sqlite3.Row
for module in (events,conditions,roster,audit,bot_outbox,bot_settings,bot_views,lifecycle):module.now=lambda:'${stamp}'
class Frozen(datetime.datetime):
 @classmethod
 def now(cls,tz=None):return datetime.datetime.fromisoformat('${stamp}').astimezone(tz)
bot_outbox.datetime=Frozen
event=db.execute("SELECT * FROM events WHERE id='listen'").fetchone();user=db.execute("SELECT * FROM users WHERE id='alice'").fetchone()
${action}
result={}
for table in ${JSON.stringify(tables)}:
 condition="attendee_id IN (SELECT id FROM attendees WHERE event_id='listen')" if table=='attendee_payment_origins' else ('id' if table=='events' else 'event_id')+"='listen'"
 result[table]=[dict(r) for r in db.execute('SELECT * FROM '+table+' WHERE '+condition+' ORDER BY rowid')]
print(json.dumps(result))`,path],{encoding:'utf8',env:{...process.env,KANBAN_BOT_BASE_URL:origin,KANBAN_BOT_KEYBOARD:'1',KANBAN_BOT_PERSONAL_QUEUE:'1'}}));
    await run();expect(normalize(state(s.db))).toEqual(normalize(expected));
  }finally{rmSync(folder,{recursive:true,force:true});}
}
describe('supplement signup invitations',()=>{
  it('matches original batch invitation rows, reasons, audit and no-seat/no-broadcast semantics',async()=>{
    const s=await setup();await differential(s,"roster.invite(db,event,user,dict(people=[dict(name='受邀甲',note='同行備註',payer_kind='manager'),dict(name='受邀乙',note='同行備註',payer_kind='self')],reason='補報名核對'))",async()=>expect((await s.invite([guest('受邀甲'),guest('受邀乙','self')])).statusCode).toBe(200));
    expect(s.people().map(p=>[p.status,p.party_id,p.user_id])).toEqual([['invited',null,null],['invited',null,null]]);expect(s.db.prepare('SELECT * FROM bot_outbox').all()).toEqual([]);expect(s.db.prepare('SELECT * FROM attendee_consents').all()).toEqual([]);
    const list=await s.list();expect(list.canIssue).toBe(true);expect(list.people.map(p=>p.token)).toHaveLength(2);expect(list.people.every(p=>/^[A-Za-z0-9_-]{32}$/.test(p.token))).toBe(true);expect(list.people[0]!.token).not.toBe(list.people[1]!.token);
    expect((await s.list(s.bob)).people).toEqual([]);s.db.exec("INSERT INTO user_admin_roles VALUES('bob',1,1,'before')");expect((await s.invite(undefined,{},s.bob)).statusCode).toBe(403);
  });
  it('matches acceptance of a private event without a prior access grant and exposes only the finite token preview',async()=>{
    const s=await setup();s.db.exec("UPDATE events SET visibility='invitation' WHERE id='listen'");await s.invite();const person=(await s.list()).people[0]!;
    expect((await s.app.inject({url:'/api/v2/activities/listen',headers:s.bob})).statusCode).toBe(404);
    const response=await s.app.inject({url:'/api/v2/activities/listen/invitations/'+person.token});expect(response.statusCode).toBe(200);expect(response.headers['cache-control']).toBe('no-store');const preview=ActivityInvitationPreview.parse(response.json());expect(Object.keys(response.json()).sort()).toEqual(Object.keys(preview).sort());expect(preview.name).toBe('受邀者');expect(JSON.stringify(preview)).not.toContain('同行備註');expect(preview.status).toBe('confirmed');expect(s.db.prepare("SELECT * FROM event_access WHERE user_id='bob'").all()).toEqual([]);
    await differential(s,`user=db.execute("SELECT * FROM users WHERE id='bob'").fetchone();roster.accept_invitation(db,event,user,'${person.token}',dict(accept_waiting=True))`,async()=>expect((await s.accept(person.token)).statusCode).toBe(200));
    expect(s.people()[0]).toMatchObject({id:person.id,user_id:'bob',manager_id:'bob',name:'小白',status:'confirmed'});expect((await s.app.inject({url:'/api/v2/activities/listen',headers:s.bob})).statusCode).toBe(200);expect((await s.app.inject({url:'/api/v2/activities/listen/invitations/'+person.token})).statusCode).toBe(404);expect((await s.accept(person.token)).statusCode).toBe(404);
  });
  it('preserves strict FIFO while open but deliberately fills free capacity when closed without promoting earlier together parties',async()=>{
    const s=await setup();await s.signup();await s.signup(s.values([guest('組甲'),guest('組乙')],{queueMode:'together'}));await s.invite();const person=(await s.list()).people[0]!;
    const get=()=>s.app.inject({url:'/api/v2/activities/listen/invitations/'+person.token});expect((await get()).json().status).toBe('waiting');expect((await s.accept(person.token,{acceptWaiting:false})).statusCode).toBe(409);
    s.db.exec("UPDATE events SET registration_open=0,status='closed' WHERE id='listen'");expect((await get()).json().status).toBe('confirmed');
    await differential(s,`user=db.execute("SELECT * FROM users WHERE id='bob'").fetchone();roster.accept_invitation(db,event,user,'${person.token}',dict(accept_waiting=True))`,async()=>expect((await s.accept(person.token)).statusCode).toBe(200));
    expect(s.people().map(p=>p.status)).toEqual(['confirmed','waiting','waiting','confirmed']);
  });
  it('requires explicit waiting consent and accepts at a new individual ticket without changing old invitation ID or notes',async()=>{
    const s=await setup();s.db.exec("UPDATE events SET capacity=1 WHERE id='listen'");await s.signup();await s.invite();const person=(await s.list()).people[0]!;
    expect((await s.accept(person.token,{acceptWaiting:false})).statusCode).toBe(409);
    await differential(s,`user=db.execute("SELECT * FROM users WHERE id='bob'").fetchone();roster.accept_invitation(db,event,user,'${person.token}',dict(accept_waiting=True))`,async()=>expect((await s.accept(person.token)).statusCode).toBe(200));
    const row=s.db.prepare('SELECT * FROM attendees WHERE id=?').get(person.id);expect(row).toMatchObject({status:'waiting',payer_kind:'self',note:'同行備註',accepted_conditions_version:1,confirmation_state:'accepted',invitation_token:null});expect(s.db.prepare('SELECT * FROM roster_parties WHERE id=(SELECT party_id FROM attendees WHERE id=?)').get(person.id)).toMatchObject({queue_mode:'individual',manager_id:'bob'});
  });
  it('requires current revision, current conditions, explicit confirmation, valid batches and separate roster permission',async()=>{
    const s=await setup();for(const [people,patch] of [[[],{}],[Array.from({length:21},()=>guest('人')),{}],[[{isSelf:true,name:'本人',note:'',payerKind:'self'}],{}],[[guest('')],{}],[[guest('😀'.repeat(25))],{}],[[guest('受邀者')],{reason:''}],[[guest('受邀者')],{confirm:false}]] as [ReturnType<typeof guest>[],Record<string,unknown>][])expect((await s.invite(people,patch)).statusCode).toBe(400);
    expect((await s.invite(undefined,{revision:2})).statusCode).toBe(409);await s.invite();const token=(await s.list()).people[0]!.token;
    for(const patch of [{revision:2},{conditionsVersion:2}])expect((await s.accept(token,patch)).statusCode).toBe(409);
    for(const patch of [{acceptConditions:false},{confirm:false}])expect((await s.accept(token,patch)).statusCode).toBe(400);
    expect((await s.app.inject({url:'/api/v2/activities/listen/invitations',headers:{cookie:s.alice.cookie}})).statusCode).toBe(409);
    expect((await s.write('invitations/'+token+'/accept',{revision:4,conditionsVersion:1,acceptConditions:true,acceptWaiting:true,confirm:true},{...s.bob,'x-csrf-token':'invalid'})).statusCode).toBe(403);
    s.db.exec("INSERT INTO event_roles VALUES('helper','listen','bob','[\"schedule\"]','before')");expect((await s.invite(undefined,{},s.bob)).statusCode).toBe(403);s.db.exec("UPDATE event_roles SET permissions_json='[\"roster\"]' WHERE id='helper'");expect((await s.invite(undefined,{},s.bob)).statusCode).toBe(200);
  });
  it('blocks duplicate self registrations, revoked tokens, terminal activities and settled rosters',async()=>{
    const s=await setup();await s.invite();const token=(await s.list()).people[0]!.token;await s.signup(s.values(),s.bob);expect((await s.accept(token)).statusCode).toBe(409);
    const person=(await s.list()).people[0]!;expect((await s.change(person.id,'withdraw',{reason:'撤銷邀請'})).statusCode).toBe(200);expect((await s.app.inject({url:'/api/v2/activities/listen/invitations/'+token})).statusCode).toBe(404);
    await s.invite();const next=(await s.list()).people[0]!.token;
    for(const lifecycle of ['draft','ended','cancelled']){s.db.prepare("UPDATE events SET lifecycle=? WHERE id='listen'").run(lifecycle);expect((await s.invite()).statusCode).toBe(409);expect((await s.accept(next)).statusCode).toBe(409);}
    s.db.exec("UPDATE events SET lifecycle='scheduled',archived_at='before' WHERE id='listen'");expect((await s.invite()).statusCode).toBe(409);s.db.exec("UPDATE events SET archived_at=NULL WHERE id='listen'; INSERT INTO settlements(event_id,total_cents,headcount,updated_at,note) VALUES('listen',0,1,'before','')");expect((await s.invite()).statusCode).toBe(409);expect((await s.accept(next)).statusCode).toBe(409);
  });
  it('recovers exact issue and acceptance operations after token consumption, without replaying signup cards or leaking tokens in receipts',async()=>{
    const s=await setup(),key=randomUUID(),input={revision:3,people:[guest('受邀者')],reason:'補報名核對',confirm:true};expect((await s.write('invitations',input,s.alice,key)).statusCode).toBe(200);expect((await s.write('invitations',input,s.alice,key)).statusCode).toBe(200);expect(s.people()).toHaveLength(1);
    const token=(await s.list()).people[0]!.token,acceptKey=randomUUID(),body={revision:4,conditionsVersion:1,acceptConditions:true,acceptWaiting:true,confirm:true};expect((await s.write('invitations/'+token+'/accept',body,s.bob,acceptKey)).statusCode).toBe(200);expect((await s.write('invitations/'+token+'/accept',body,s.bob,acceptKey)).statusCode).toBe(200);
    expect(s.people()).toHaveLength(1);expect(s.db.prepare("SELECT count(*) AS n FROM bot_outbox WHERE kind='registration_added'").get()).toEqual({n:1});expect(JSON.stringify(s.db.prepare('SELECT * FROM request_results').all())).not.toContain(token);expect((await s.write('invitations/'+token+'/accept',{...body,acceptWaiting:false},s.bob,acceptKey)).statusCode).toBe(409);
    s.db.exec("UPDATE attendees SET manager_id='alice' WHERE user_id='bob'");expect((await s.write('invitations/'+token+'/accept',body,s.bob,acceptKey)).statusCode).toBe(403);
  });
  it('serializes two users accepting the same token and reauthorizes invitation issuer receipt after permission removal',async()=>{
    const s=await setup();s.db.exec("INSERT INTO event_roles VALUES('helper','listen','bob','[\"roster\"]','before')");const key=randomUUID(),body={revision:3,people:[guest('受邀者')],reason:'補報名核對',confirm:true};expect((await s.write('invitations',body,s.bob,key)).statusCode).toBe(200);s.db.exec("DELETE FROM event_roles WHERE id='helper'");expect((await s.write('invitations',body,s.bob,key)).statusCode).toBe(403);expect((await s.list(s.bob)).people).toHaveLength(1);expect((await s.list(s.bob)).canIssue).toBe(false);
    const token=(await s.list()).people[0]!.token;const results=await Promise.all([s.accept(token,{},s.alice),s.accept(token,{},s.bob)]);expect(results.map(r=>r.statusCode).sort()).toEqual([200,409]);expect(s.people().filter(p=>p.user_id)).toHaveLength(1);expect(s.db.prepare('SELECT * FROM attendee_consents').all()).toHaveLength(1);
  });
  it('atomically rolls back required invitation, consent, access, audit and receipt failures but isolates optional bot writes',async()=>{
    const s=await setup(),before=normalize(state(s.db));for(const table of ['event_audit','request_results']){s.db.exec("CREATE TRIGGER synthetic_failure BEFORE INSERT ON "+table+" BEGIN SELECT RAISE(ABORT,'synthetic'); END");expect((await s.invite()).statusCode).toBe(500);expect(normalize(state(s.db))).toEqual(before);s.db.exec('DROP TRIGGER synthetic_failure');}
    await s.invite();const token=(await s.list()).people[0]!.token,invited=normalize(state(s.db));for(const table of ['attendee_consents','event_access','event_audit','request_results']){s.db.exec("CREATE TRIGGER synthetic_failure BEFORE INSERT ON "+table+" BEGIN SELECT RAISE(ABORT,'synthetic'); END");expect((await s.accept(token)).statusCode).toBe(500);expect(normalize(state(s.db))).toEqual(invited);s.db.exec('DROP TRIGGER synthetic_failure');}
    s.db.exec("CREATE TRIGGER synthetic_failure BEFORE INSERT ON bot_outbox BEGIN SELECT RAISE(ABORT,'synthetic'); END");expect((await s.accept(token)).statusCode).toBe(200);expect(s.db.prepare('SELECT * FROM bot_outbox').all()).toEqual([]);
  });
  it('lets the retained Python worker consume accepted invitation cards once in plain, rich and simulation modes',async()=>{
    const s=await setup();await s.invite();await s.accept((await s.list()).people[0]!.token);const folder=mkdtempSync(join(tmpdir(),'qgroup-invitation-worker-'));
    try{for(const mode of ['plain','rich','dry-run']){
      const path=join(folder,mode+'.sqlite3');await s.db.backup(path);
      const result=JSON.parse(execFileSync('python3',['-c',`import datetime,json,sqlite3,sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
from qgroup_bot import worker
from qgroup_core import bot_outbox
class Frozen(datetime.datetime):
 @classmethod
 def now(cls,tz=None):return datetime.datetime.fromisoformat('${stamp}').astimezone(tz)
worker.datetime=Frozen;bot_outbox.datetime=Frozen;worker.now=lambda:'${stamp}'
config=SimpleNamespace(db=Path(sys.argv[1]),group='synthetic-group',dry_run=sys.argv[2]=='dry-run',sandbox=False,claim_timeout=600,batch=10,max_attempts=5,markdown_replies=sys.argv[2]!='plain',allowed_link_hosts=('rebuild.example',),log_dir=Path(sys.argv[1]).parent/'isolated-logs',log_content=False)
api=Mock();api.post.return_value=(True,0,dict(id='SYNTHETIC_ONLY'))
consumer=worker.OutboxWorker(config,api);first=consumer.poll_once();second=consumer.poll_once()
db=sqlite3.connect(sys.argv[1]);db.row_factory=sqlite3.Row
print(json.dumps(dict(first=first,second=second,calls=api.post.call_count,rows=[dict(r) for r in db.execute('SELECT kind,status,simulated_at,delivered_payload_json FROM bot_outbox ORDER BY id')],people=[dict(r) for r in db.execute('SELECT id,user_id,status FROM attendees')])))`,path,mode],{encoding:'utf8',env:{...process.env,QQBOT_APP_ID:'',QQBOT_APP_SECRET:'',KANBAN_BOT_ENV:'',KANBAN_BOT_BASE_URL:origin}}));
      expect(result.first).toMatchObject({claimed:1,sent:mode==='dry-run'?0:1,simulated:mode==='dry-run'?1:0,failed:0});expect(result.second.claimed).toBe(0);expect(result.calls).toBe(mode==='dry-run'?0:1);expect(result.rows).toHaveLength(1);expect(result.rows[0]).toMatchObject({kind:'registration_added',status:mode==='dry-run'?'skipped':'sent'});expect(JSON.parse(result.rows[0].delivered_payload_json).msg_type).toBe(mode==='plain'?0:2);expect(result.people).toEqual(s.people().map(({id,user_id,status})=>({id,user_id,status})));
    }}finally{rmSync(folder,{recursive:true,force:true});}
  });

});
