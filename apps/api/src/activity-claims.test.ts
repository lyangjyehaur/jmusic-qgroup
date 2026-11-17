import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { AttendeeClaimContext, AttendeeClaimPreview } from '@qgroup/contracts';
import { fixture } from '../testsupport/fixture';
import { createApp, hash } from './app';
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
  const context=async(h=alice)=>AttendeeClaimContext.parse((await app.inject({url:'/api/v2/activities/listen/claims',headers:h})).json());
  const issue=(attendeeId:string,patch:Record<string,unknown>={},h=alice,key=randomUUID())=>write('claims',{revision:eventRow(db,'listen')!.revision,attendeeId,reason:'本人核對',confirm:true,...patch},h,key);
  const claimRequest=(token:string,patch:Record<string,unknown>={},h=bob,key=randomUUID())=>write('claims/preview/'+token+'/request',{revision:eventRow(db,'listen')!.revision,confirmIdentity:true,keepPayment:true,confirm:true,...patch},h,key);
  const decide=(claimId:string,decision='approve',patch:Record<string,unknown>={},h=alice,key=randomUUID())=>write('claims/'+claimId,{revision:eventRow(db,'listen')!.revision,decision,reason:'已當面核對',confirmPerson:true,confirm:true,...patch},h,key);
  const tokenView=(token:string,h=bob)=>app.inject({url:'/api/v2/activities/listen/claims/preview/'+token,headers:h});
  return {db,app,alice,bob,write,values,preview,signup,change,people,context,issue,claimRequest,decide,tokenView};
}
const guest=(name:string,payerKind='manager')=>({isSelf:false,name,note:'同行備註',payerKind});
const tables=['events','attendees','roster_parties','attendee_consents','event_audit','notifications','bot_outbox','finance_entries','attendee_payment_origins','event_access','attendee_claims','settlements','settlement_history','settlement_details','settlement_receipts','finance_reports','finance_report_actions','settlement_code_images','settlement_receipt_images'];
function state(db:ReturnType<typeof openDatabase>){return Object.fromEntries(tables.map(table=>[table,db.prepare('SELECT * FROM '+table+" WHERE "+(table==='events'?'id':table==='attendee_payment_origins'?'attendee_id IN (SELECT id FROM attendees WHERE event_id':'event_id')+(table==='attendee_payment_origins'?"='listen')":"='listen'")+" ORDER BY rowid").all()]));}
function normalize(input:Record<string,unknown>){
  let text=JSON.stringify(input);
  for(const [index,row] of (input.attendees as {id:string}[]).entries())text=text.replaceAll(row.id,'PERSON_'+index);
  for(const [index,row] of (input.roster_parties as {id:string}[]).entries())text=text.replaceAll(row.id,'PARTY_'+index);
  for(const [index,row] of (input.attendee_claims as {id:string;token:string}[]).entries())text=text.replaceAll(row.id,'CLAIM_'+index).replaceAll(row.token,'CLAIM_TOKEN_'+index);
  const result=JSON.parse(text);for(const rows of Object.values(result) as Record<string,unknown>[][])for(const row of rows)for(const [key,value] of Object.entries(row))if(key.endsWith('_json')&&typeof value==='string')row[key]=JSON.parse(value);
  for(const row of result.event_audit)for(const key of ['before_json','after_json'])if(row[key].participants)row[key].participants.sort((a:{id:string},b:{id:string})=>a.id.localeCompare(b.id));return result;
}
async function differential(s:Awaited<ReturnType<typeof setup>>,action:string,run:()=>Promise<unknown>){
  const folder=mkdtempSync(join(tmpdir(),'qgroup-roster-diff-')),path=join(folder,'synthetic.sqlite3');
  try{
    await s.db.backup(path);const expected=JSON.parse(execFileSync('python3',['-c',`import datetime,json,sqlite3,sys
from qgroup_core import events,conditions,roster,audit,bot_outbox,bot_settings,bot_views,lifecycle,identity
db=sqlite3.connect(sys.argv[1]);db.row_factory=sqlite3.Row
for module in (events,conditions,roster,audit,bot_outbox,bot_settings,bot_views,lifecycle,identity):module.now=lambda:'${stamp}'
class Frozen(datetime.datetime):
 @classmethod
 def now(cls,tz=None):return datetime.datetime.fromisoformat('${stamp}').astimezone(tz)
bot_outbox.datetime=Frozen;identity.datetime=Frozen
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
async function prepared(s:Awaited<ReturnType<typeof setup>>,payerKind='manager'){
  await s.signup(s.values([guest('被代報者',payerKind)]));const person=s.people()[0]!;expect((await s.issue(person.id)).statusCode).toBe(200);const claim=(await s.context()).claims[0]!;return {person,claim};
}
function money(s:Awaited<ReturnType<typeof setup>>){
  const image=Buffer.from('synthetic-image-bytes');
  s.db.prepare("INSERT INTO settlements VALUES('listen',12000,1,?,'before','原帳單備註')").run(image);
  s.db.prepare("INSERT INTO settlement_history(event_id,version,total_cents,headcount,note,qr_image,updated_at,actor_id,actor_name,kind,changed_fields) VALUES('listen',1,12000,1,'原帳單備註',?,'before','alice','小青','detailed','[]')").run(image);
  s.db.prepare("INSERT INTO settlement_details VALUES('listen',1,?)").run(JSON.stringify({input:{custom_payers:[]},payers:[],people:[]}));s.db.prepare("INSERT INTO settlement_receipts VALUES('listen',1,'original-receipt',?)").run(image);
  s.db.exec("INSERT INTO image_assets VALUES('synthetic-digest',21,'image/png','before'); INSERT INTO settlement_code_images VALUES('listen',1,'wechat','原收款碼','synthetic-digest'); INSERT INTO settlement_receipt_images VALUES('listen',1,'original-receipt','synthetic-digest'); INSERT INTO finance_reports(id,event_id,reporter_id,reporter_name,payload_json,created_at) VALUES('original-report','listen','alice','小青','{\"amount_cents\":3000}','before'); INSERT INTO finance_report_actions(event_id,report_id,decision,actor_id,actor_name,reason,created_at) VALUES('listen','original-report','accepted','alice','小青','已核對','before'); INSERT INTO finance_entries(id,event_id,kind,payload_json,occurred_at,actor_id,actor_name,created_at,source_report_id) VALUES('original-money','listen','prepayment','{\"amount_cents\":3000,\"parties\":[]}','before','alice','小青','before','original-report')");
}
const moneyTables=['settlements','settlement_history','settlement_details','settlement_receipts','finance_entries','finance_reports','finance_report_actions','settlement_code_images','settlement_receipt_images'];
const moneyState=(s:Awaited<ReturnType<typeof setup>>)=>Object.fromEntries(moneyTables.map(table=>[table,s.db.prepare('SELECT * FROM '+table).all()]));
describe('attendee identity claims and immutable payment origins',()=>{
  it('matches issuance, seven-day expiry, superseding and token-free audit without registration notices',async()=>{
    const s=await setup();await s.signup(s.values([guest('被代報者')]));const person=s.people()[0]!;
    await differential(s,`identity.claim_command(db,event,user,'/claims',dict(attendee_id='${person.id}',reason='本人核對'))`,async()=>expect((await s.issue(person.id)).statusCode).toBe(200));let context=await s.context();expect(context.claims[0]).toMatchObject({expiresAt:'2026-11-24T00:00:00+00:00',status:'invited',canRevoke:true,canDecide:false});const old=context.claims[0]!;
    await differential(s,`identity.claim_command(db,event,user,'/claims',dict(attendee_id='${person.id}',reason='本人核對'))`,async()=>expect((await s.issue(person.id)).statusCode).toBe(200));context=await s.context();expect(context.claims.map(c=>c.status).sort()).toEqual(['invited','revoked']);expect((await s.tokenView(old.token!)).statusCode).toBe(404);expect(JSON.stringify(s.db.prepare('SELECT * FROM event_audit').all())).not.toContain(old.token);expect(s.db.prepare("SELECT * FROM notifications WHERE kind LIKE 'claim_%'").all()).toEqual([]);
  });
  it('matches a private finite preview and request without granting access until manager approval',async()=>{
    const s=await setup(),{person,claim}=await prepared(s);s.db.exec("UPDATE events SET visibility='invitation' WHERE id='listen'");const view=await s.tokenView(claim.token!);const parsed=AttendeeClaimPreview.parse(view.json());expect(parsed).toMatchObject({state:'open',name:'被代報者',payerName:'小青',duplicate:false,isManager:false});for(const key of ['participants','arrangement','description','location','settlement','share_token','token','requesterName'])expect(view.json()).not.toHaveProperty(key);
    await differential(s,`user=db.execute("SELECT * FROM users WHERE id='bob'").fetchone();identity.claim_command(db,event,user,'/claims/${claim.token}/request',dict(confirm_identity=True,keep_payment=True))`,async()=>expect((await s.claimRequest(claim.token!)).statusCode).toBe(200));expect((await s.tokenView(claim.token!)).json()).toMatchObject({claimStatus:'requested',requestedByMe:true});
    for(const suffix of ['', '/roster','/registration','/claims','/conditions'])expect((await s.app.inject({url:'/api/v2/activities/listen'+suffix,headers:s.bob})).statusCode).toBe(404);expect(s.db.prepare("SELECT * FROM event_access WHERE user_id='bob'").all()).toEqual([]);
    await differential(s,`identity.claim_command(db,event,user,'/claims/${claim.id}',dict(decision='approve',confirm_person=True,reason='已當面核對'))`,async()=>expect((await s.decide(claim.id)).statusCode).toBe(200));expect(s.people()[0]).toMatchObject({id:person.id,manager_id:'bob',user_id:'bob'});expect((await s.app.inject({url:'/api/v2/activities/listen',headers:s.bob})).statusCode).toBe(200);expect((await s.tokenView(claim.token!)).json()).toEqual({state:'claimed',id:'listen',title:'週末一起聽日系音樂',name:'小白'});expect((await s.tokenView(claim.token!,s.alice)).statusCode).toBe(404);
  });
  it.each(['self','manager'])('freezes %s payment responsibility after invoicing without changing any roster, consent, money, receipt or image field',async payerKind=>{
    const s=await setup(),{person,claim}=await prepared(s,payerKind);money(s);s.db.exec("UPDATE events SET lifecycle='ended' WHERE id='listen'");const beforePerson=s.db.prepare('SELECT * FROM attendees WHERE id=?').get(person.id) as Record<string,unknown>,beforeMoney=moneyState(s),beforeConsents=s.db.prepare('SELECT * FROM attendee_consents').all(),beforeParties=s.db.prepare('SELECT * FROM roster_parties').all();
    await s.claimRequest(claim.token!);await differential(s,`identity.claim_command(db,event,user,'/claims/${claim.id}',dict(decision='approve',confirm_person=True,reason='已當面核對'))`,async()=>expect((await s.decide(claim.id)).statusCode).toBe(200));
    const after=s.db.prepare('SELECT * FROM attendees WHERE id=?').get(person.id) as Record<string,unknown>;for(const key of Object.keys(beforePerson))if(!['user_id','manager_id','updated_at'].includes(key))expect(after[key],key).toEqual(beforePerson[key]);expect(moneyState(s)).toEqual(beforeMoney);expect(s.db.prepare('SELECT * FROM attendee_consents').all()).toEqual(beforeConsents);expect(s.db.prepare('SELECT * FROM roster_parties').all()).toEqual(beforeParties);
    const origin=s.db.prepare('SELECT * FROM attendee_payment_origins WHERE attendee_id=?').get(person.id) as {payer_id:string};expect(origin).toMatchObject({payer_id:payerKind==='self'?'person:'+person.id:'account:fac4a4ec05bafc49',payer_name:payerKind==='self'?'被代報者':'小青',claimant_owns:payerKind==='self'?1:0,payer_user_id:payerKind==='self'?null:'alice'});
    for(const sql of ['UPDATE attendee_payment_origins SET payer_name=payer_name','DELETE FROM attendee_payment_origins'])expect(()=>s.db.exec(sql)).toThrow();
    const folder=mkdtempSync(join(tmpdir(),'qgroup-claim-finance-'));try{const path=join(folder,'synthetic.sqlite3');await s.db.backup(path);const actual=JSON.parse(execFileSync('python3',['-c',`import json,sqlite3,sys
from qgroup_core import finance,settlements
db=sqlite3.connect(sys.argv[1]);db.row_factory=sqlite3.Row;event=db.execute("SELECT * FROM events WHERE id='listen'").fetchone()
print(json.dumps(dict(alice=sorted(finance.my_keys(db,event,'alice')),bob=sorted(finance.my_keys(db,event,'bob')),people=settlements.context(db,event,dict(id='alice'))['people'])))`,path],{encoding:'utf8'}));expect(actual.people[0].payer_id).toBe(origin.payer_id);expect((payerKind==='self'?actual.bob:actual.alice)).toContain(origin.payer_id);expect((payerKind==='self'?actual.alice:actual.bob)).not.toContain(origin.payer_id);}finally{rmSync(folder,{recursive:true,force:true});}
  });
  it('matches reject and revoke notifications without touching identity or payment, and allows a current manager to revoke after issuer loses scope',async()=>{
    const s=await setup(),{person,claim}=await prepared(s);await s.claimRequest(claim.token!);
    await differential(s,`identity.claim_command(db,event,user,'/claims/${claim.id}',dict(decision='reject',reason='已當面核對'))`,async()=>expect((await s.decide(claim.id,'reject')).statusCode).toBe(200));expect(s.people()[0]!.user_id).toBe(null);expect(s.db.prepare('SELECT * FROM attendee_payment_origins').all()).toEqual([]);
    await s.issue(person.id);const next=(await s.context()).claims.find(c=>c.status==='invited')!;await differential(s,`identity.claim_command(db,event,user,'/claims/${next.id}',dict(decision='revoke',reason='已當面核對'))`,async()=>expect((await s.decide(next.id,'revoke')).statusCode).toBe(200));expect((await s.tokenView(next.token!)).statusCode).toBe(404);
    s.db.exec("UPDATE events SET owner_id='bob' WHERE id='listen'");await s.issue(person.id);const lost=(await s.context()).claims.find(c=>c.status==='invited')!;s.db.prepare("UPDATE attendees SET manager_id='bob' WHERE id=?").run(person.id);expect((await s.tokenView(lost.token!)).statusCode).toBe(409);expect((await s.claimRequest(lost.token!)).statusCode).toBe(409);expect((await s.decide(lost.id,'revoke',{},s.bob)).statusCode).toBe(200);
  });
  it('requires double identity/payment confirmation, reasons, current revisions and real manager authority',async()=>{
    const s=await setup(),{person,claim}=await prepared(s);expect((await s.issue(person.id,{},s.bob)).statusCode).toBe(403);s.db.exec("INSERT INTO user_admin_roles VALUES('bob',1,1,'before')");expect((await s.issue(person.id,{},s.bob)).statusCode).toBe(403);expect((await s.claimRequest(claim.token!,{},s.alice)).statusCode).toBe(409);
    for(const patch of [{confirmIdentity:false},{keepPayment:false},{confirm:false}])expect((await s.claimRequest(claim.token!,patch)).statusCode).toBe(400);expect((await s.claimRequest(claim.token!,{revision:0})).statusCode).toBe(409);expect((await s.decide(claim.id,'approve')).statusCode).toBe(409);
    await s.claimRequest(claim.token!);expect((await s.decide(claim.id,'approve',{},s.bob)).statusCode).toBe(403);expect((await s.decide(claim.id,'approve',{confirmPerson:false})).statusCode).toBe(400);expect((await s.decide(claim.id,'approve',{reason:''})).statusCode).toBe(400);expect((await s.decide(claim.id,'approve',{revision:0})).statusCode).toBe(409);
    const previews=await s.tokenView(claim.token!,{...s.bob,'x-account-scope':'wrong'});expect(previews.statusCode).toBe(409);
  });
  it('rejects duplicate本人 at request and again at approval, without merging names, IDs or money',async()=>{
    const s=await setup(),{person,claim}=await prepared(s);await s.signup(s.values(),s.bob);expect((await s.tokenView(claim.token!)).json()).toMatchObject({duplicate:true});expect((await s.claimRequest(claim.token!)).statusCode).toBe(409);const self=s.people().find(p=>p.user_id==='bob')!;await s.change(self.id,'withdraw',{},s.bob);expect((await s.claimRequest(claim.token!)).statusCode).toBe(200);await s.signup(s.values(),s.bob);expect((await s.decide(claim.id)).statusCode).toBe(409);expect(s.people().find(p=>p.id===person.id)!.user_id).toBe(null);expect(s.db.prepare('SELECT * FROM attendee_payment_origins').all()).toEqual([]);
  });
  it('preserves a waiting ticket while rejecting together waiting/tentative, archived, linked and withdrawn claim targets',async()=>{
    const s=await setup();s.db.exec("UPDATE events SET capacity=1 WHERE id='listen'");await s.signup();await s.signup(s.values([guest('個別候補')]));const waiting=s.people()[1]!;await s.issue(waiting.id);const claim=(await s.context()).claims[0]!;await s.claimRequest(claim.token!);await s.decide(claim.id);expect(s.people().find(p=>p.id===waiting.id)).toMatchObject({party_id:waiting.party_id,status:'waiting',user_id:'bob'});expect((await s.issue(waiting.id)).statusCode).toBe(409);
    await s.signup(s.values([guest('整組甲'),guest('整組乙')],{queueMode:'together'}));const grouped=s.people().at(-1)!;expect((await s.issue(grouped.id)).statusCode).toBe(409);expect((await s.context()).people.find(p=>p.id===grouped.id)!.blocker).not.toBe('');
    await s.signup(s.values([guest('待確認')],{intent:'tentative'}));const tentative=s.people().at(-1)!;s.db.exec("UPDATE events SET archived_at='before' WHERE id='listen'");expect((await s.issue(tentative.id)).statusCode).toBe(409);s.db.exec("UPDATE events SET archived_at=NULL WHERE id='listen'");await s.change(tentative.id,'withdraw');expect((await s.issue(tentative.id)).statusCode).toBe(404);
  });
  it('derives expiry, hides other users tokens and rejects expired links or decisions without mutating them',async()=>{
    const s=await setup(),{claim}=await prepared(s);expect((await s.context(s.bob)).claims).toEqual([]);s.db.prepare("UPDATE attendee_claims SET expires_at=? WHERE id=?").run(stamp,claim.id);expect((await s.tokenView(claim.token!)).statusCode).toBe(404);expect((await s.claimRequest(claim.token!)).statusCode).toBe(404);expect((await s.decide(claim.id,'revoke')).statusCode).toBe(409);expect((await s.context()).claims[0]).toMatchObject({status:'expired',token:null,canDecide:false,canRevoke:false});expect(s.db.prepare('SELECT status FROM attendee_claims WHERE id=?').get(claim.id)).toEqual({status:'invited'});
  });
  it('recovers minimal exact receipts after approval transfers authority, but never authorizes a fresh decision or exposes a token',async()=>{
    const s=await setup();s.db.exec("UPDATE events SET owner_id='bob' WHERE id='listen'");const {person,claim}=await prepared(s);const key=randomUUID(),body={revision:eventRow(s.db,'listen')!.revision,confirmIdentity:true,keepPayment:true,confirm:true};expect((await s.write('claims/preview/'+claim.token+'/request',body,s.bob,key)).statusCode).toBe(200);expect((await s.write('claims/preview/'+claim.token+'/request',body,s.bob,key)).statusCode).toBe(200);
    const decisionKey=randomUUID(),decision={revision:eventRow(s.db,'listen')!.revision,decision:'approve',reason:'已當面核對',confirmPerson:true,confirm:true};expect((await s.write('claims/'+claim.id,decision,s.alice,decisionKey)).statusCode).toBe(200);const replay=await s.write('claims/'+claim.id,decision,s.alice,decisionKey);expect(replay.statusCode).toBe(200);expect(Object.keys(replay.json()).sort()).toEqual(['claimId','id','revision']);expect((await s.decide(claim.id)).statusCode).toBe(403);expect((await s.write('claims/'+claim.id,{...decision,reason:'不同內容'},s.alice,decisionKey)).statusCode).toBe(409);expect((await s.write('claims/preview/'+claim.token+'/request',body,s.bob,key)).statusCode).toBe(200);expect(s.db.prepare('SELECT * FROM attendee_payment_origins').all()).toHaveLength(1);expect(s.people()[0]!.id).toBe(person.id);expect(JSON.stringify(s.db.prepare('SELECT * FROM request_results').all())).not.toContain(claim.token);
  });
  it('serializes competing requesters, notifies the manager and distinct owner once, and uses only generic bot private reminders',async()=>{
    const s=await setup();await s.signup(s.values([guest('被代報者')]),s.bob);const person=s.people()[0]!;await s.issue(person.id,{},s.bob);const claim=(await s.context(s.bob)).claims[0]!;
    s.db.prepare("INSERT INTO users VALUES('charlie',?,'第三個合成帳號','before')").run(hash('fixture-charlie'));s.db.prepare("INSERT INTO browser_sessions VALUES(?,'charlie','before')").run(hash('fixture-charlie'));const cookie='kanban_session=fixture-charlie',viewer=(await s.app.inject({url:'/api/v2/session',headers:{cookie}})).json(),charlie={cookie,origin,'x-account-scope':viewer.scope,'x-csrf-token':viewer.csrf};
    const results=await Promise.all([s.claimRequest(claim.token!,{},s.alice),s.claimRequest(claim.token!,{},charlie)]);expect(results.map(r=>r.statusCode).sort()).toEqual([200,409]);expect(s.db.prepare("SELECT * FROM notifications WHERE kind='claim_requested'").all()).toHaveLength(2);
    const payloads=s.db.prepare("SELECT payload_json FROM bot_outbox WHERE kind LIKE 'claim_%'").all() as {payload_json:string}[];expect(payloads).toHaveLength(2);expect(payloads[0]!.payload_json).toContain('有一条报名认领申请待核对');expect(JSON.stringify(payloads)).not.toContain('被代報者');expect(s.db.prepare("SELECT * FROM bot_outbox WHERE channel='group' AND kind='registration_changed'").all()).toEqual([]);
  });
  it('rolls back binding, payment origins, notifications, audit and claim state on necessary failure while isolating bot failures',async()=>{
    const s=await setup(),{claim}=await prepared(s),before=normalize(state(s.db));s.db.exec("CREATE TRIGGER synthetic_failure BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT,'synthetic'); END");expect((await s.claimRequest(claim.token!)).statusCode).toBe(500);expect(normalize(state(s.db))).toEqual(before);s.db.exec('DROP TRIGGER synthetic_failure');await s.claimRequest(claim.token!);const requested=normalize(state(s.db));
    for(const table of ['attendee_payment_origins','event_access','event_audit','notifications','request_results']){s.db.exec("CREATE TRIGGER synthetic_failure BEFORE INSERT ON "+table+" BEGIN SELECT RAISE(ABORT,'synthetic'); END");expect((await s.decide(claim.id)).statusCode).toBe(500);expect(normalize(state(s.db))).toEqual(requested);s.db.exec('DROP TRIGGER synthetic_failure');}
    s.db.exec("CREATE TRIGGER synthetic_failure BEFORE INSERT ON bot_outbox BEGIN SELECT RAISE(ABORT,'synthetic'); END");expect((await s.decide(claim.id)).statusCode).toBe(200);expect(s.people()[0]!.user_id).toBe('bob');
  });
  it('switches roster music only to the approved real identity and never borrows the manager profile before approval',async()=>{
    const s=await setup(),{person,claim}=await prepared(s);s.db.exec("INSERT INTO music_profiles VALUES('synthetic-alice','alice',0,'before',NULL); INSERT INTO music_profiles VALUES('synthetic-bob','bob',0,'before',NULL); INSERT INTO music_selections VALUES('synthetic-alice','sub-0',4,0); INSERT INTO music_selections VALUES('synthetic-bob','sub-1',3,0)");const read=()=>s.app.inject({url:'/api/v2/activities/listen/attendees/'+person.id+'/music',headers:s.alice});
    expect((await read()).json()).toEqual({state:'unlinked'});await s.claimRequest(claim.token!);expect((await read()).json()).toEqual({state:'unlinked'});await s.decide(claim.id);expect((await read()).json()).toMatchObject({state:'ready',profileId:'synthetic-bob',picks:[{entryId:'sub-1',shared:false}]});expect((await read()).json().picks).toHaveLength(1);
  });
  it('keeps retained Python worker private delivery safeguards: skips unbound claim reminders once and never redirects them into a group',async()=>{
    const s=await setup();s.db.exec("UPDATE events SET visibility='invitation' WHERE id='listen'");const {claim}=await prepared(s);await s.claimRequest(claim.token!);await s.decide(claim.id);expect(s.db.prepare('SELECT * FROM bot_outbox').all()).toHaveLength(2);const folder=mkdtempSync(join(tmpdir(),'qgroup-claim-worker-'));
    try{const path=join(folder,'synthetic.sqlite3');await s.db.backup(path);const result=JSON.parse(execFileSync('python3',['-c',`import datetime,json,sqlite3,sys
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
api=Mock();api.post.side_effect=AssertionError('Private work must never be sent to a group')
consumer=worker.OutboxWorker(config,api);first=consumer.poll_once();second=consumer.poll_once()
db=sqlite3.connect(sys.argv[1]);db.row_factory=sqlite3.Row
print(json.dumps(dict(first=first,second=second,calls=api.post.call_count,rows=[dict(r) for r in db.execute('SELECT kind,status,last_error FROM bot_outbox ORDER BY id')],origins=[dict(r) for r in db.execute('SELECT * FROM attendee_payment_origins')])))`,path],{encoding:'utf8',env:{...process.env,QQBOT_APP_ID:'',QQBOT_APP_SECRET:'',KANBAN_BOT_ENV:'',KANBAN_BOT_BASE_URL:origin}}));expect(result.first).toMatchObject({claimed:2,sent:0,skipped:2,failed:0});expect(result.second.claimed).toBe(0);expect(result.calls).toBe(0);expect(result.rows.map((row:{kind:string;status:string})=>[row.kind,row.status])).toEqual([['claim_requested','skipped'],['claim_decided','skipped']]);expect(result.rows.every((row:{last_error:string})=>row.last_error.includes('no binding'))).toBe(true);expect(result.origins).toEqual(s.db.prepare('SELECT * FROM attendee_payment_origins').all());
    }finally{rmSync(folder,{recursive:true,force:true});}
  });

  it('checks current roster delegation for issuing and receipt replay, then rejects the old token after the original issuer loses that scope',async()=>{
    const s=await setup();await s.signup(s.values([guest('被代報者')]));const person=s.people()[0]!;s.db.exec("INSERT INTO event_roles VALUES('helper','listen','bob','[\"schedule\"]','before')");expect((await s.issue(person.id,{},s.bob)).statusCode).toBe(403);s.db.exec("UPDATE event_roles SET permissions_json='[\"roster\"]' WHERE id='helper'");const key=randomUUID(),body={revision:eventRow(s.db,'listen')!.revision,attendeeId:person.id,reason:'本人核對',confirm:true};expect((await s.write('claims',body,s.bob,key)).statusCode).toBe(200);const claim=(await s.context(s.bob)).claims[0]!;s.db.exec("DELETE FROM event_roles WHERE id='helper'");expect((await s.write('claims',body,s.bob,key)).statusCode).toBe(403);expect((await s.tokenView(claim.token!)).statusCode).toBe(409);expect((await s.claimRequest(claim.token!)).statusCode).toBe(409);expect((await s.decide(claim.id,'revoke')).statusCode).toBe(200);
  });

});
