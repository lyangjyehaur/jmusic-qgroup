import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { RegistrationContext, RegistrationPreview } from '@qgroup/contracts';
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
  return {db,app,alice,bob,write,values,preview,signup,change,people};
}
const guest=(name:string,payerKind='manager')=>({isSelf:false,name,note:'同行備註',payerKind});
const tables=['events','attendees','roster_parties','attendee_consents','event_audit','notifications','bot_outbox','finance_entries','attendee_payment_origins','event_access'];
function state(db:ReturnType<typeof openDatabase>){return Object.fromEntries(tables.map(table=>[table,db.prepare('SELECT * FROM '+table+" WHERE "+(table==='events'?'id':table==='attendee_payment_origins'?'attendee_id IN (SELECT id FROM attendees WHERE event_id':'event_id')+(table==='attendee_payment_origins'?"='listen')":"='listen'")+" ORDER BY rowid").all()]));}
function normalize(input:Record<string,unknown>){
  let text=JSON.stringify(input);
  for(const [index,row] of (input.attendees as {id:string}[]).entries())text=text.replaceAll(row.id,'PERSON_'+index);
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
describe('registration, party queues and individual management',()=>{
  it.each(['scheduled','ongoing'])('accepts signup and FIFO promotion during %s until the cutoff or end',async(lifecycle)=>{
    const s=await setup();s.db.prepare("UPDATE events SET starts_at='2026-11-16T23:00:00+00:00',deadline='2026-11-17T02:00:00+00:00',duration_hours=3,capacity=1,lifecycle=? WHERE id='listen'").run(lifecycle);
    expect((await s.signup()).statusCode).toBe(200);expect((await s.signup(s.values(),s.bob)).statusCode).toBe(200);
    expect(s.people().map(p=>p.status)).toEqual(['confirmed','waiting']);
    expect((await s.change(s.people()[0]!.id,'withdraw')).statusCode).toBe(200);
    expect(s.people().map(p=>p.status)).toEqual(['withdrawn','confirmed']);
    for(const patch of ["deadline='2026-11-17T00:00:00+00:00'","deadline='2026-11-17T02:00:00+00:00',duration_hours=1"]){
      s.db.exec("UPDATE events SET "+patch+" WHERE id='listen'");expect((await s.preview(s.values([guest('截止後')]))).statusCode).toBe(409);
    }
  });
  it('matches the exact original preview digest for Unicode, multiline notes, party intention and mixed allocations',async()=>{
    const s=await setup(),data=s.values([guest('同行 😀'),{isSelf:true,name:'ignored',note:'逐行\n原文',payerKind:'self'}]);s.db.exec("UPDATE events SET capacity=1 WHERE id='listen'");
    const expected=JSON.parse(execFileSync('python3',['-c',`import json,sys
from qgroup_core import roster
class DB:
 def execute(self,*a):return self
 def fetchone(self):return None
roster.rows=lambda db,id:[];roster.is_open=lambda event:True
event=dict(id='listen',revision=3,conditions_version=1,fee_policy='',capacity=1)
print(json.dumps(roster.preview(DB(),event,dict(id='alice',nickname='小青'),json.load(sys.stdin))))`,],{input:JSON.stringify({base_revision:3,people:data.people.map(p=>({is_self:p.isSelf,name:p.name,note:p.note,payer_kind:p.payerKind})),queue_mode:'individual',intent:'registered'}),encoding:'utf8'}));
    const actual=RegistrationPreview.parse((await s.preview(data)).json());expect(actual).toEqual({revision:expected.base_revision,conditionsVersion:expected.conditions_version,token:expected.preview_token,allocation:expected.allocation});
    await differential(s,"roster.add_party(db,event,user,dict(people=[dict(name='同行 😀',note='同行備註',payer_kind='manager'),dict(is_self=True,note='逐行\\n原文')],accept_partial=True),require_preview=False)",async()=>expect((await s.signup(data)).statusCode).toBe(200));
  });
  it('keeps tentative people seatless, confirms a together party at a new queue ticket, and splits without jumping the queue',async()=>{
    const s=await setup();expect((await s.signup(s.values([guest('甲'),guest('乙')],{intent:'tentative',queueMode:'together'}))).statusCode).toBe(200);const first=s.people()[0]!;
    expect(s.people().map(p=>p.status)).toEqual(['tentative','tentative']);expect(s.db.prepare("SELECT 1 FROM bot_outbox WHERE kind='registration_added'").get()).toBeUndefined();
    expect((await s.signup(s.values([{isSelf:true,name:'',note:'',payerKind:'self'}]))).statusCode).toBe(200);
    await differential(s,`roster.change_person(db,event,user,'${first.id}',dict(action='confirm'))`,async()=>expect((await s.change(first.id,'confirm')).statusCode).toBe(200));
    expect(s.people().map(p=>p.status)).toEqual(['waiting','waiting','confirmed']);expect(s.people()[0]!.party_id).not.toBe(first.party_id);
    await differential(s,`roster.change_person(db,event,user,'${first.id}',dict(action='split'))`,async()=>expect((await s.change(first.id,'split')).statusCode).toBe(200));expect(s.people().map(p=>p.status)).toEqual(['confirmed','waiting','confirmed']);
  });
  it('matches guest edits and no-op versions while protecting linked names and frozen payment responsibility',async()=>{
    const s=await setup();await s.signup(s.values([guest('同行')]));const person=s.people()[0]!;
    await differential(s,`roster.change_person(db,event,user,'${person.id}',dict(name='更正同行',note='新的公開備註',payer_kind='self'))`,async()=>expect((await s.change(person.id,'edit',{name:'更正同行',note:'新的公開備註'})).statusCode).toBe(200));
    const revision=eventRow(s.db,'listen')!.revision;expect((await s.change(person.id,'edit',{name:'更正同行',note:'新的公開備註'})).statusCode).toBe(200);expect(eventRow(s.db,'listen')!.revision).toBe(revision);
    s.db.prepare("INSERT INTO attendee_payment_origins(attendee_id,payer_id,payer_name,claimant_owns,payer_user_id) VALUES(?,'alice','小青',0,'alice')").run(person.id);
    expect((await s.change(person.id,'edit',{payerKind:'manager'})).statusCode).toBe(409);
    await s.signup();const self=s.people().find(p=>p.user_id==='alice')!;expect((await s.change(self.id,'edit',{name:'不能改本人',payerKind:'manager'})).statusCode).toBe(400);expect((await s.change(self.id,'edit',{name:'不能改本人',note:'本人備註'})).statusCode).toBe(200);expect(s.people().find(p=>p.id===self.id)!.name).toBe('小青');
  });
  it('matches withdrawal and final promotion in one broadcast, preserves consents and permits re-registration at a new ticket',async()=>{
    const s=await setup();s.db.exec("UPDATE events SET capacity=1 WHERE id='listen'");await s.signup();await s.signup(s.values([guest('等候甲'),guest('等候乙')]));const self=s.people()[0]!;
    await differential(s,`roster.withdraw(db,event,user,'${self.id}',dict(reason='提前退出'))`,async()=>expect((await s.change(self.id,'withdraw',{reason:'提前退出'})).statusCode).toBe(200));
    expect(s.people().map(p=>p.status)).toEqual(['withdrawn','confirmed','waiting']);expect(s.db.prepare("SELECT count(*) AS n FROM bot_outbox WHERE kind='registration_changed'").get()).toEqual({n:1});
    expect((await s.signup()).statusCode).toBe(200);expect(s.people().at(-1)!.status).toBe('waiting');expect(s.db.prepare("SELECT count(*) AS n FROM attendee_consents WHERE attendee_id=?").get(self.id)).toEqual({n:1});
  });
  it('matches late withdrawal requests, rejection and approval while keeping the seat until approval and refusing promotions after closing',async()=>{
    const s=await setup();await s.signup(s.values(),s.bob);const person=s.people()[0]!;s.db.exec("UPDATE events SET withdrawal_deadline='2026-11-16T00:00:00+00:00' WHERE id='listen'");
    expect((await s.change(person.id,'withdraw',{},s.bob)).statusCode).toBe(400);
    await differential(s,`user=db.execute("SELECT * FROM users WHERE id='bob'").fetchone();roster.withdraw(db,event,user,'${person.id}',dict(reason='行程衝突'))`,async()=>expect((await s.change(person.id,'withdraw',{reason:'行程衝突'},s.bob)).statusCode).toBe(200));expect(s.people()[0]!.status).toBe('confirmed');
    await differential(s,`roster.withdraw(db,event,user,'${person.id}',dict(reason='請先協調'),decision='reject')`,async()=>expect((await s.change(person.id,'reject',{reason:'請先協調'})).statusCode).toBe(200));
    await s.change(person.id,'withdraw',{reason:'已協調'},s.bob);s.db.exec("UPDATE events SET registration_open=0,status='closed' WHERE id='listen'");
    await differential(s,`roster.withdraw(db,event,user,'${person.id}',dict(reason='同意退出'),decision='approve')`,async()=>expect((await s.change(person.id,'approve',{reason:'同意退出'})).statusCode).toBe(200));
    const personal=s.db.prepare("SELECT payload_json FROM bot_outbox WHERE channel='private'").all() as {payload_json:string}[];expect(JSON.stringify(personal)).not.toContain('行程衝突');
  });
  it('requires reasons for roster assistance, rejects unrelated identity and permits late waiting withdrawals without review',async()=>{
    const s=await setup();s.db.exec("UPDATE events SET capacity=1 WHERE id='listen'");await s.signup(s.values([guest('同名'),guest('同名')]));const [a,b]=s.people();
    expect((await s.change(a!.id,'edit',{},s.bob)).statusCode).toBe(403);s.db.exec("INSERT INTO user_admin_roles VALUES('bob',1,1,'before')");expect((await s.change(a!.id,'withdraw',{},s.bob)).statusCode).toBe(403);
    s.db.exec("INSERT INTO event_roles VALUES('helper','listen','bob','[\"roster\"]','before')");expect((await s.change(a!.id,'edit',{},s.bob)).statusCode).toBe(400);expect((await s.change(a!.id,'withdraw',{reason:'取消代報'},s.bob)).statusCode).toBe(200);
    s.db.exec("UPDATE events SET withdrawal_deadline='2026-11-16T00:00:00+00:00',registration_open=0,status='closed' WHERE id='listen'; UPDATE attendees SET status='waiting' WHERE id='"+b!.id+"'");expect((await s.change(b!.id,'withdraw')).statusCode).toBe(200);
  });
  it('binds preview to all submitted fields, current rules and queue revision; rejects partial acceptance and enforces 1–20 people',async()=>{
    const s=await setup();s.db.exec("UPDATE events SET capacity=1 WHERE id='listen'");const data=s.values([guest('甲'),guest('乙')]),p=(await s.preview(data)).json(),input={...data,previewToken:p.token,conditionsVersion:1,acceptConditions:true,acceptPartial:false,confirm:true};
    expect((await s.write('registration',input)).statusCode).toBe(409);expect((await s.write('registration',{...input,acceptPartial:true,people:[guest('不同'),guest('乙')]})).statusCode).toBe(409);expect((await s.write('registration',{...input,acceptPartial:true,conditionsVersion:2})).statusCode).toBe(409);expect((await s.write('registration',{...input,acceptConditions:false})).statusCode).toBe(400);
    for(const people of [[],Array.from({length:21},()=>guest('人')),[{isSelf:true,name:'',note:'',payerKind:'self'},{isSelf:true,name:'',note:'',payerKind:'self'}]])expect((await s.preview(s.values(people))).statusCode).toBe(400);
    expect((await s.write('registration',{...input,acceptPartial:true})).statusCode).toBe(200);expect((await s.write('registration',{...input,acceptPartial:true})).statusCode).toBe(409);
    expect(s.people()).toHaveLength(2);expect(s.people().map(p=>p.status)).toEqual(['confirmed','waiting']);
  });
  it('recovers signup and withdrawal receipts without duplicate people and reauthorizes current managers and decision roles',async()=>{
    const s=await setup(),key=randomUUID(),data=s.values(),p=(await s.preview(data)).json(),input={...data,previewToken:p.token,conditionsVersion:1,acceptConditions:true,acceptPartial:true,confirm:true};expect((await s.write('registration',input,s.alice,key)).statusCode).toBe(200);expect((await s.write('registration',input,s.alice,key)).statusCode).toBe(200);expect(s.people()).toHaveLength(1);
    const self=s.people()[0]!,withdraw=randomUUID(),body={revision:4,action:'withdraw',name:'',note:'',payerKind:'self',reason:'',confirm:true};expect((await s.write('attendees/'+self.id+'/registration',body,s.alice,withdraw)).statusCode).toBe(200);expect((await s.write('attendees/'+self.id+'/registration',body,s.alice,withdraw)).statusCode).toBe(200);
    expect((await s.app.inject({url:'/api/v2/activities/registration-results/'+withdraw,headers:s.alice})).json()).toMatchObject({state:'completed'});
    s.db.prepare("UPDATE attendees SET manager_id='bob' WHERE id=?").run(self.id);s.db.exec("UPDATE events SET owner_id='bob' WHERE id='listen'");expect((await s.app.inject({url:'/api/v2/activities/registration-results/'+withdraw,headers:s.alice})).statusCode).toBe(403);
    expect((await s.write('registration',{...input,people:[guest('另一人')]},s.alice,key)).statusCode).toBe(409);
  });
  it('exposes only scoped manageable people and preserves access, payment and mutability boundaries',async()=>{
    const s=await setup();await s.signup(s.values([guest('純代報')]));const alice=RegistrationContext.parse((await s.app.inject({url:'/api/v2/activities/listen/registration',headers:s.alice})).json());expect(alice.people).toHaveLength(1);expect(alice.selfRegistered).toBe(false);
    const bob=RegistrationContext.parse((await s.app.inject({url:'/api/v2/activities/listen/registration',headers:s.bob})).json());expect(bob.people).toEqual([]);expect((await s.app.inject({url:'/api/v2/activities/listen/registration',headers:{cookie:s.alice.cookie}})).statusCode).toBe(409);
    s.db.exec("UPDATE events SET visibility='invitation' WHERE id='listen'");expect((await s.preview(s.values(),s.bob)).statusCode).toBe(404);
    s.db.exec("INSERT INTO settlements(event_id,total_cents,headcount,updated_at,note) VALUES('listen',0,1,'before','')");expect((await s.signup()).statusCode).toBe(409);expect((await s.change(s.people()[0]!.id,'withdraw')).statusCode).toBe(409);
  });
  it('rolls back all roster, consent, notifications and audit on necessary failure, isolating optional bot failures',async()=>{
    const s=await setup(),before=normalize(state(s.db));
    for(const table of ['attendee_consents','event_audit','request_results']){s.db.exec("CREATE TRIGGER synthetic_failure BEFORE INSERT ON "+table+" BEGIN SELECT RAISE(ABORT,'synthetic'); END");expect((await s.signup()).statusCode).toBe(500);expect(normalize(state(s.db))).toEqual(before);s.db.exec('DROP TRIGGER synthetic_failure');}
    s.db.exec("CREATE TRIGGER synthetic_failure BEFORE INSERT ON bot_outbox BEGIN SELECT RAISE(ABORT,'synthetic'); END");expect((await s.signup()).statusCode).toBe(200);expect(s.people()).toHaveLength(1);expect(s.db.prepare('SELECT * FROM bot_outbox').all()).toEqual([]);
  });
  it('serializes concurrent submissions, prevents overselling and requires the second client to preview the new queue',async()=>{
    const s=await setup();s.db.exec("UPDATE events SET capacity=1 WHERE id='listen'");
    const data=s.values(),alice=(await s.preview(data)).json(),bob=(await s.preview(data,s.bob)).json();
    const body=(p:typeof alice)=>({...data,previewToken:p.token,conditionsVersion:1,acceptConditions:true,acceptPartial:true,confirm:true});
    const results=await Promise.all([s.write('registration',body(alice)),s.write('registration',body(bob),s.bob)]);expect(results.map(r=>r.statusCode).sort()).toEqual([200,409]);expect(s.people().filter(p=>p.status==='confirmed')).toHaveLength(1);
    expect((await s.signup(s.values(),s.bob)).statusCode).toBe(200);expect(s.people().map(p=>p.status)).toEqual(['confirmed','waiting']);
  });
  it('reauthorizes decision receipt replay after roster scope revocation and atomically restores notifications and queue state on failure',async()=>{
    const s=await setup();await s.signup();const person=s.people()[0]!;s.db.exec("UPDATE events SET withdrawal_deadline='2026-11-16T00:00:00+00:00' WHERE id='listen'; INSERT INTO event_roles VALUES('helper','listen','bob','[\"roster\"]','before')");
    await s.change(person.id,'withdraw',{reason:'需退出'});const before=normalize(state(s.db));s.db.exec("CREATE TRIGGER synthetic_notice BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT,'synthetic'); END");expect((await s.change(person.id,'approve',{reason:'同意'},s.bob)).statusCode).toBe(500);expect(normalize(state(s.db))).toEqual(before);s.db.exec('DROP TRIGGER synthetic_notice');
    const key=randomUUID(),body={revision:eventRow(s.db,'listen')!.revision,action:'approve',name:'',note:'',payerKind:'self',reason:'同意',confirm:true};expect((await s.write('attendees/'+person.id+'/registration',body,s.bob,key)).statusCode).toBe(200);
    // Retain manager authority while removing only decision scope.
    s.db.prepare("UPDATE attendees SET manager_id='bob' WHERE id=?").run(person.id);s.db.exec("DELETE FROM event_roles WHERE id='helper'");expect((await s.write('attendees/'+person.id+'/registration',body,s.bob,key)).statusCode).toBe(403);expect((await s.app.inject({url:'/api/v2/activities/registration-results/'+key,headers:s.bob})).statusCode).toBe(403);
  });
});
