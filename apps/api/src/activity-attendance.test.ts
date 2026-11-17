import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { ActivityAttendance } from '@qgroup/contracts';
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
  const values=(people=[{isSelf:true,name:'',note:'',payerKind:'self'}])=>({revision:eventRow(db,'listen')!.revision,people,queueMode:'individual',intent:'registered'});
  const signup=async(data=values(),h=alice)=>{const p=await write('registration/preview',data,h);expect(p.statusCode).toBe(200);expect((await write('registration',{...data,previewToken:p.json().token,conditionsVersion:p.json().conditionsVersion,acceptConditions:true,acceptPartial:true,confirm:true},h)).statusCode).toBe(200);};
  const people=()=>db.prepare("SELECT * FROM attendees WHERE event_id='listen' ORDER BY seq").all() as {id:string;status:string;attendance:string;user_id:string|null;party_id:string;manager_id:string;seq:number}[];
  const observe=(personId:string,patch:Record<string,unknown>={},h=alice,key=randomUUID())=>write('attendance/'+personId,{revision:eventRow(db,'listen')!.revision,attendance:'present',note:'到場備註',arrivedAt:null,leftAt:null,reason:'',confirm:true,...patch},h,key);
  const onsite=(patch:Record<string,unknown>={},h=alice,key=randomUUID())=>write('onsite',{revision:eventRow(db,'listen')!.revision,conditionsVersion:eventRow(db,'listen')!.conditions_version,people:[{isSelf:false,name:'現場同行',note:'現場公開備註',payerKind:'manager'}],reason:'現場核對補錄',acceptConditions:true,allowOverCapacity:false,overrideWaitlist:false,confirm:true,...patch},h,key);
  const context=async(h=alice)=>ActivityAttendance.parse((await app.inject({url:'/api/v2/activities/listen/attendance',headers:h})).json());
  const start=()=>db.exec("UPDATE events SET lifecycle='ongoing',actual_started_at='2026-11-16T23:00:00+00:00' WHERE id='listen'");
  return {db,app,alice,bob,write,values,signup,people,observe,onsite,context,start};
}
const guest=(name:string)=>({isSelf:false,name,note:'同行備註',payerKind:'manager'});
const tables=['events','attendees','roster_parties','attendee_consents','event_audit','notifications','bot_outbox','finance_entries','attendee_payment_origins','event_access','management_invitations','event_roles','settlements','settlement_history','settlement_details','settlement_receipts','finance_reports','finance_report_actions','settlement_code_images','settlement_receipt_images'];
function state(db:ReturnType<typeof openDatabase>){return Object.fromEntries(tables.map(table=>[table,db.prepare('SELECT * FROM '+table+" WHERE "+(table==='events'?'id':table==='attendee_payment_origins'?'attendee_id IN (SELECT id FROM attendees WHERE event_id':'event_id')+(table==='attendee_payment_origins'?"='listen')":"='listen'")+" ORDER BY rowid").all()]));}
function normalize(input:Record<string,unknown>){
  let text=JSON.stringify(input);
  for(const [index,row] of (input.attendees as {id:string}[]).entries())text=text.replaceAll(row.id,'PERSON_'+index);
  for(const [index,row] of (input.roster_parties as {id:string}[]).entries())text=text.replaceAll(row.id,'PARTY_'+index);
  for(const [index,row] of (input.management_invitations as {id:string;token:string}[]).entries())text=text.replaceAll(row.id,'INVITE_'+index).replaceAll(row.token,'TOKEN_'+index);
  for(const [index,row] of (input.event_roles as {id:string}[]).entries())text=text.replaceAll(row.id,'ROLE_'+index);
  const result=JSON.parse(text);for(const rows of Object.values(result) as Record<string,unknown>[][])for(const row of rows)for(const [key,value] of Object.entries(row))if(key.endsWith('_json')&&typeof value==='string')row[key]=JSON.parse(value);
  for(const row of result.event_audit)for(const key of ['before_json','after_json']){if(row[key].participants)row[key].participants.sort((a:{id:string},b:{id:string})=>a.id.localeCompare(b.id));if(row[key].roles)row[key].roles.sort((a:{id:string},b:{id:string})=>a.id.localeCompare(b.id));}return result;
}
async function differential(s:Awaited<ReturnType<typeof setup>>,action:string,run:()=>Promise<unknown>){
  const folder=mkdtempSync(join(tmpdir(),'qgroup-roster-diff-')),path=join(folder,'synthetic.sqlite3');
  try{
    await s.db.backup(path);const expected=JSON.parse(execFileSync('python3',['-c',`import datetime,json,sqlite3,sys
from qgroup_core import events,conditions,roster,audit,bot_outbox,bot_settings,bot_views,lifecycle,attendance
db=sqlite3.connect(sys.argv[1]);db.row_factory=sqlite3.Row
for module in (events,conditions,roster,audit,bot_outbox,bot_settings,bot_views,lifecycle,attendance):module.now=lambda:'${stamp}'
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
print(json.dumps(result,default=lambda value:dict(type='Buffer',data=list(value))))`,path],{encoding:'utf8',env:{...process.env,KANBAN_BOT_BASE_URL:origin,KANBAN_BOT_KEYBOARD:'1',KANBAN_BOT_PERSONAL_QUEUE:'1'}}));
    await run();expect(normalize(state(s.db))).toEqual(normalize(expected));
  }finally{rmSync(folder,{recursive:true,force:true});}
}
describe('attendance observations and onsite additions',()=>{
  it('matches the Python attendance states and actual UTC times without changing places, consent or payment responsibility',async()=>{
    const s=await setup();await s.signup();await s.signup(s.values([guest('同行')]));s.start();const person=s.people()[0]!,kept=state(s.db);
    for(const attendanceState of ['absent','late','left','unknown','present']){
      const timed=attendanceState==='late'||attendanceState==='left',arrived=timed?'2026-11-17T07:00:00+08:00':null,left=attendanceState==='left'?'2026-11-17T07:30:00+08:00':null;
      await differential(s,`attendance.change(db,event,user,'${person.id}',dict(attendance='${attendanceState}',attendance_note='到場備註',arrived_at=${arrived?"'"+arrived+"'":'None'},left_at=${left?"'"+left+"'":'None'},reason=''))`,async()=>expect((await s.observe(person.id,{attendance:attendanceState,arrivedAt:arrived,leftAt:left})).statusCode).toBe(200));
      expect((await s.context()).confirmed).toBe(2);
    }
    for(const table of ['roster_parties','attendee_consents','attendee_payment_origins','finance_entries'])expect(state(s.db)[table]).toEqual(kept[table]);expect(s.db.prepare("SELECT * FROM bot_outbox WHERE kind IN ('registration_changed','registration_added')").all()).toHaveLength(2);
  });
  it('requires attendance scope even for attendee managers and site administrators, and onsite additionally requires roster scope',async()=>{
    const s=await setup();await s.signup();s.start();const person=s.people()[0]!;s.db.exec("INSERT INTO user_admin_roles VALUES('bob',1,1,'before')");expect((await s.observe(person.id,{},s.bob)).statusCode).toBe(403);expect((await s.app.inject({url:'/api/v2/activities/listen/attendance',headers:s.bob})).statusCode).toBe(403);s.db.exec("INSERT INTO event_roles VALUES('attendance-helper','listen','bob','[\"attendance\"]','before')");expect((await s.observe(person.id,{},s.bob)).statusCode).toBe(200);expect((await s.context(s.bob)).canAdd).toBe(false);expect((await s.onsite({},s.bob)).statusCode).toBe(403);s.db.exec("UPDATE event_roles SET permissions_json='[\"attendance\",\"roster\"]' WHERE id='attendance-helper'");expect((await s.onsite({},s.bob)).statusCode).toBe(200);expect(s.people().at(-1)).toMatchObject({manager_id:'bob',attendance:'present',status:'confirmed'});
  });
  it('requires actual start or elapsed scheduled start, blocks archives and drafts, and retains corrections after end or cancellation with a reason',async()=>{
    const s=await setup();await s.signup();const person=s.people()[0]!;expect((await s.observe(person.id)).statusCode).toBe(409);expect((await s.onsite()).statusCode).toBe(409);
    s.db.exec("UPDATE events SET starts_at='2026-11-16T23:00:00+00:00' WHERE id='listen'");expect((await s.observe(person.id)).statusCode).toBe(200);
    for(const lifecycle of ['ended','cancelled']){s.db.prepare("UPDATE events SET lifecycle=? WHERE id='listen'").run(lifecycle);expect((await s.observe(person.id,{attendance:'late'})).statusCode).toBe(400);await differential(s,`attendance.change(db,event,user,'${person.id}',dict(attendance='late',attendance_note='到場備註',reason='本人核對更正'))`,async()=>expect((await s.observe(person.id,{attendance:'late',reason:'本人核對更正'})).statusCode).toBe(200));expect((await s.context()).reasonRequired).toBe(true);}
    expect((await s.onsite()).statusCode).toBe(409);s.db.exec("UPDATE events SET lifecycle='draft' WHERE id='listen'");expect((await s.observe(person.id)).statusCode).toBe(409);s.start();s.db.exec("UPDATE events SET archived_at='before' WHERE id='listen'");expect((await s.observe(person.id)).statusCode).toBe(409);expect((await s.onsite()).statusCode).toBe(409);
  });
  it('rejects invalid calendar, future, reversed and absent-state times while allowing partial historical observations',async()=>{
    const s=await setup();await s.signup();s.start();const person=s.people()[0]!;
    for(const patch of [{arrivedAt:'2026-02-30T00:00:00Z'},{arrivedAt:'2026-11-17T00:00:01Z'},{leftAt:'2026-11-18T00:00:00Z'},{arrivedAt:'2026-11-16T22:00:00Z',leftAt:'2026-11-16T21:00:00Z'},{arrivedAt:'2026-11-16T23:00:00'},{attendance:'absent',arrivedAt:'2026-11-16T23:00:00Z'},{attendance:'unknown',leftAt:'2026-11-16T23:00:00Z'},{attendance:'invalid'},{note:'😀'.repeat(201)},{confirm:false}])expect((await s.observe(person.id,patch)).statusCode,JSON.stringify(patch)).toBe(400);
    expect((await s.observe(person.id,{attendance:'left',leftAt:'2026-11-16T23:00:00Z'})).statusCode).toBe(200);expect((await s.context()).people[0]).toMatchObject({arrivedAt:null,leftAt:'2026-11-16T23:00:00+00:00'});
  });
  it('does not silently promote waiting or tentative attendees, but allows correcting previously observed withdrawn attendees',async()=>{
    const s=await setup();await s.signup(s.values([guest('正式甲'),guest('正式乙'),guest('候補')]));s.start();const people=s.people(),waiting=people[2]!;expect((await s.observe(waiting.id)).statusCode).toBe(409);expect((await s.context()).people).toHaveLength(2);s.db.prepare("UPDATE attendees SET status='tentative' WHERE id=?").run(waiting.id);expect((await s.observe(waiting.id)).statusCode).toBe(409);
    const person=people[0]!;await s.observe(person.id);s.db.prepare("UPDATE attendees SET status='withdrawn' WHERE id=?").run(person.id);expect((await s.observe(person.id,{attendance:'absent',reason:'更正退出後出席'})).statusCode).toBe(200);expect((await s.context()).people.find(p=>p.id===person.id)).toMatchObject({status:'withdrawn',attendance:'absent'});expect(s.people()[2]!.status).toBe('tentative');
  });
  it('keeps all published settlement and finance records immutable during post-end attendance correction and retains the same bill headcount',async()=>{
    const s=await setup();await s.signup(s.values([guest('應分攤甲'),guest('應分攤乙')]));s.start();s.db.exec("UPDATE events SET lifecycle='ended' WHERE id='listen'; INSERT INTO settlements(event_id,total_cents,headcount,updated_at,note) VALUES('listen',10000,2,'before','原帳單'); INSERT INTO settlement_history(event_id,version,total_cents,headcount,note,updated_at,actor_id,actor_name,kind,changed_fields) VALUES('listen',1,10000,2,'原帳單','before','alice','小青','published','[]'); INSERT INTO settlement_details VALUES('listen',1,'{\"kept\":true}'); INSERT INTO settlement_receipts VALUES('listen',1,'receipt',X'010203'); INSERT INTO finance_entries(id,event_id,kind,payload_json,occurred_at,actor_id,actor_name,created_at) VALUES('money','listen','prepayment','{\"amount_cents\":5000}','before','alice','小青','before')");const kept=state(s.db),person=s.people()[0]!;
    await differential(s,`attendance.change(db,event,user,'${person.id}',dict(attendance='absent',attendance_note='到場備註',reason='結束後本人核對缺席'))`,async()=>expect((await s.observe(person.id,{attendance:'absent',reason:'結束後本人核對缺席'})).statusCode).toBe(200));for(const table of ['settlements','settlement_history','settlement_details','settlement_receipts','finance_entries'])expect(state(s.db)[table]).toEqual(kept[table]);expect((await s.context()).confirmed).toBe(2);expect((await s.onsite()).statusCode).toBe(409);
  });
  it('matches explicit onsite additions, fee acceptance, individual party and current per-person consent without replaying signup broadcasts',async()=>{
    const s=await setup();await s.signup();s.start();const before=state(s.db),waitingBefore=s.people();await differential(s,"attendance.onsite(db,event,user,dict(people=[dict(is_self=False,name='現場同行',note='現場公開備註',payer_kind='manager')],reason='現場核對補錄',accept_terms=True,conditions_version=1))",async()=>expect((await s.onsite()).statusCode).toBe(200));const current=await s.context();expect(current.confirmed).toBe(2);expect(current.people.at(-1)).toMatchObject({attendance:'present',payerKind:'manager',payerName:'小青',arrivedAt:null});expect(s.people().slice(0,waitingBefore.length)).toEqual(waitingBefore);expect(state(s.db).bot_outbox).toEqual(before.bot_outbox);
  });
  it('requires separate excess-capacity and waiting-queue acknowledgements and leaves every old queue position unchanged',async()=>{
    const s=await setup();await s.signup(s.values([guest('正式甲'),guest('正式乙'),guest('候補')]));s.start();const before=s.people(),stateBefore=normalize(state(s.db));expect((await s.onsite()).statusCode).toBe(409);expect((await s.onsite({allowOverCapacity:true})).statusCode).toBe(409);expect(normalize(state(s.db))).toEqual(stateBefore);
    await differential(s,"attendance.onsite(db,event,user,dict(people=[dict(is_self=False,name='現場同行',note='現場公開備註',payer_kind='manager')],reason='現場核對補錄',accept_terms=True,conditions_version=1,allow_over_capacity=True,override_waitlist=True))",async()=>expect((await s.onsite({allowOverCapacity:true,overrideWaitlist:true})).statusCode).toBe(200));expect(s.people().slice(0,before.length)).toEqual(before);expect(await s.context()).toMatchObject({confirmed:3,waiting:1});
  });
  it('validates current conditions, one self per batch, existing self, true payer, capacity zero and ended historical onsite before any bill',async()=>{
    const s=await setup();s.start();for(const patch of [{acceptConditions:false},{confirm:false},{reason:''},{people:[]},{conditionsVersion:2},{people:[{isSelf:false,name:'',note:'',payerKind:'self'}]},{people:[{isSelf:true,name:'',note:'',payerKind:'manager'}]}])expect((await s.onsite(patch)).statusCode).toBe(patch.conditionsVersion?409:400);
    const own={isSelf:true,name:'自填名不當身分',note:'',payerKind:'self'};expect((await s.onsite({people:[own,own]})).statusCode).toBe(400);expect((await s.onsite({people:[own]})).statusCode).toBe(200);expect(s.people()[0]).toMatchObject({user_id:'alice',manager_id:'alice'});expect((await s.onsite({people:[own]})).statusCode).toBe(409);
    s.db.exec("UPDATE events SET capacity=0,lifecycle='ended' WHERE id='listen'");await differential(s,"attendance.onsite(db,event,user,dict(people=[dict(is_self=False,name='現場同行',note='現場公開備註',payer_kind='manager')],reason='現場核對補錄',accept_terms=True,conditions_version=1))",async()=>expect((await s.onsite()).statusCode).toBe(200));expect((await s.context()).canAdd).toBe(true);
  });
  it('returns exact idempotent receipts, treats unchanged attendance as a no-op and rechecks revoked scopes before replay',async()=>{
    const s=await setup();await s.signup();s.start();const person=s.people()[0]!,key=randomUUID(),input={revision:eventRow(s.db,'listen')!.revision,attendance:'present',note:'到場備註',arrivedAt:null,leftAt:null,reason:'',confirm:true};expect((await s.write('attendance/'+person.id,input,s.alice,key)).statusCode).toBe(200);const before=normalize(state(s.db));expect((await s.write('attendance/'+person.id,input,s.alice,key)).statusCode).toBe(200);expect(normalize(state(s.db))).toEqual(before);const revision=eventRow(s.db,'listen')!.revision;expect((await s.observe(person.id)).statusCode).toBe(200);expect(eventRow(s.db,'listen')!.revision).toBe(revision);expect((await s.write('attendance/'+person.id,{...input,note:'different'},s.alice,key)).statusCode).toBe(409);
    const onsiteKey=randomUUID(),body={revision,conditionsVersion:1,people:[guest('現場')],reason:'現場核對補錄',acceptConditions:true,allowOverCapacity:false,overrideWaitlist:false,confirm:true};expect((await s.write('onsite',body,s.alice,onsiteKey)).statusCode).toBe(200);expect((await s.write('onsite',body,s.alice,onsiteKey)).statusCode).toBe(200);expect(s.people()).toHaveLength(2);
    s.db.exec("INSERT INTO event_roles VALUES('helper','listen','bob','[\"attendance\"]','before')");const bobKey=randomUUID(),bobInput={...input,revision:eventRow(s.db,'listen')!.revision,attendance:'late'};expect((await s.write('attendance/'+person.id,bobInput,s.bob,bobKey)).statusCode).toBe(200);s.db.exec("DELETE FROM event_roles WHERE id='helper'");expect((await s.write('attendance/'+person.id,bobInput,s.bob,bobKey)).statusCode).toBe(403);
  });
  it('rejects stale observations and onsite writes and serializes duplicate-self races into one addition',async()=>{
    const s=await setup();s.start();expect((await s.onsite({revision:0})).statusCode).toBe(409);const own={isSelf:true,name:'',note:'',payerKind:'self'},revision=eventRow(s.db,'listen')!.revision,results=await Promise.all([s.onsite({revision,people:[own]}),s.onsite({revision,people:[own]})]);expect(results.map(r=>r.statusCode).sort()).toEqual([200,409]);expect(s.people()).toHaveLength(1);expect((await s.observe(s.people()[0]!.id,{revision:0})).statusCode).toBe(409);
  });
  it('rolls back required attendee, party, consent, audit and receipt failures while isolating optional bot failures',async()=>{
    const s=await setup();s.start();const before=normalize(state(s.db));for(const table of ['roster_parties','attendees','attendee_consents','event_audit','request_results']){s.db.exec("CREATE TRIGGER synthetic_failure BEFORE INSERT ON "+table+" BEGIN SELECT RAISE(ABORT,'synthetic'); END");expect((await s.onsite()).statusCode).toBe(500);expect(normalize(state(s.db))).toEqual(before);s.db.exec('DROP TRIGGER synthetic_failure');}
    await s.onsite();const person=s.people()[0]!,prior=normalize(state(s.db));for(const table of ['event_audit','request_results']){s.db.exec("CREATE TRIGGER synthetic_failure BEFORE INSERT ON "+table+" BEGIN SELECT RAISE(ABORT,'synthetic'); END");expect((await s.observe(person.id,{attendance:'absent'})).statusCode).toBe(500);expect(normalize(state(s.db))).toEqual(prior);s.db.exec('DROP TRIGGER synthetic_failure');}
    s.db.exec("UPDATE events SET visibility='invitation' WHERE id='listen'; CREATE TRIGGER synthetic_failure BEFORE UPDATE ON bot_outbox BEGIN SELECT RAISE(ABORT,'synthetic'); END");expect((await s.observe(person.id,{attendance:'absent'})).statusCode).toBe(200);
  });
  it('keeps private attendance behind scoped access and preserves an immutable claim payment origin in the context',async()=>{
    const s=await setup();await s.signup(s.values([guest('原代付同行')]));s.start();const person=s.people()[0]!;
    s.db.exec("UPDATE events SET visibility='invitation' WHERE id='listen'");
    expect((await s.app.inject({url:'/api/v2/activities/listen/attendance'})).statusCode).toBe(401);expect((await s.app.inject({url:'/api/v2/activities/listen/attendance',headers:{cookie:s.alice.cookie}})).statusCode).toBe(409);
    s.db.exec("INSERT INTO event_roles VALUES('helper','listen','bob','[\"attendance\"]','before')");expect((await s.app.inject({url:'/api/v2/activities/listen/attendance',headers:s.bob})).statusCode).toBe(404);
    s.db.prepare("INSERT INTO attendee_payment_origins VALUES(?,'fixed-original-payer','原付款管理人',0,'alice')").run(person.id);
    expect((await s.context()).people[0]).toMatchObject({payerName:'原付款管理人',payerKind:'manager'});
    expect((await s.write('attendance/'+person.id,{revision:eventRow(s.db,'listen')!.revision,attendance:'present',note:'',arrivedAt:null,leftAt:null,reason:'',confirm:true},{...s.alice,'x-csrf-token':'invalid'})).statusCode).toBe(403);
  });
  it('lets the retained Python worker consume preexisting roster cards once while attendance and onsite changes add no extra group messages',async()=>{
    const s=await setup();await s.signup();s.start();await s.observe(s.people()[0]!.id,{attendance:'absent'});await s.onsite();const queued=s.db.prepare('SELECT kind,status FROM bot_outbox').all();expect(queued).toEqual([{kind:'registration_added',status:'pending'}]);
    const folder=mkdtempSync(join(tmpdir(),'qgroup-attendance-worker-')),path=join(folder,'synthetic.sqlite3');
    try{await s.db.backup(path);const result=JSON.parse(execFileSync('python3',['-c',`import datetime,json,sqlite3,sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
from qgroup_bot import worker
from qgroup_core import bot_outbox
class Frozen(datetime.datetime):
 @classmethod
 def now(cls,tz=None):return datetime.datetime.fromisoformat('${stamp}').astimezone(tz)
worker.datetime=Frozen;bot_outbox.datetime=Frozen;worker.now=lambda:'${stamp}'
config=SimpleNamespace(db=Path(sys.argv[1]),group='synthetic-group',dry_run=False,sandbox=False,claim_timeout=600,batch=10,max_attempts=5,markdown_replies=True,allowed_link_hosts=('rebuild.example',),log_dir=Path(sys.argv[1]).parent/'isolated-logs',log_content=False)
api=Mock();api.post.return_value=(True,0,dict(id='SYNTHETIC_ONLY'));consumer=worker.OutboxWorker(config,api);first=consumer.poll_once();second=consumer.poll_once()
db=sqlite3.connect(sys.argv[1]);db.row_factory=sqlite3.Row
print(json.dumps(dict(first=first,second=second,calls=api.post.call_count,people=[dict(r) for r in db.execute('SELECT id,status,attendance FROM attendees ORDER BY seq')])))`,path],{encoding:'utf8',env:{...process.env,QQBOT_APP_ID:'',QQBOT_APP_SECRET:'',KANBAN_BOT_ENV:'',KANBAN_BOT_BASE_URL:origin}}));
      expect(result.first).toMatchObject({claimed:1,sent:1,failed:0});expect(result.second.claimed).toBe(0);expect(result.calls).toBe(1);expect(result.people).toEqual(s.people().map(({id,status,attendance})=>({id,status,attendance})));
    }finally{rmSync(folder,{recursive:true,force:true});}
  });

});
