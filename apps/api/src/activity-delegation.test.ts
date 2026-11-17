import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { ActivityDelegation, ActivityDelegationPreview } from '@qgroup/contracts';
import { fixture } from '../testsupport/fixture';
import { createApp, hash } from './app';
import { redactRequestURL } from './request-log';
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
  const invite=(patch:Record<string,unknown>={},h=alice,key=randomUUID())=>write('delegation/invitations',{revision:eventRow(db,'listen')!.revision,kind:'cohost',targetName:'協辦',attendeeId:null,permissions:['attendance'],reason:'分擔現場管理',confirm:true,...patch},h,key);
  const context=async(h=alice)=>ActivityDelegation.parse((await app.inject({url:'/api/v2/activities/listen/delegation',headers:h})).json());
  const accept=(token:string,patch:Record<string,unknown>={},h=bob,key=randomUUID())=>write('delegation/preview/'+token+'/accept',{revision:eventRow(db,'listen')!.revision,acceptResponsibility:true,confirm:true,...patch},h,key);
  const revoke=(kind:string,itemId:string,patch:Record<string,unknown>={},h=alice,key=randomUUID())=>write('delegation/'+kind+'/'+itemId+'/revoke',{revision:eventRow(db,'listen')!.revision,reason:'重新協調分工',confirm:true,...patch},h,key);
  const tokenView=(token:string,h=bob)=>app.inject({url:'/api/v2/activities/listen/delegation/preview/'+token,headers:h});
  async function third(){db.prepare("INSERT INTO users VALUES('charlie',?,'第三位合成帳號','before')").run(hash('fixture-charlie'));db.prepare("INSERT INTO browser_sessions VALUES(?,'charlie','before')").run(hash('fixture-charlie'));return headers('charlie');}
  return {db,app,alice,bob,write,values,preview,signup,change,people,invite,context,accept,revoke,tokenView,third};
}
const guest=(name:string,payerKind='manager')=>({isSelf:false,name,note:'同行備註',payerKind});
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
from qgroup_core import events,conditions,roster,audit,bot_outbox,bot_settings,bot_views,lifecycle,management
db=sqlite3.connect(sys.argv[1]);db.row_factory=sqlite3.Row
for module in (events,conditions,roster,audit,bot_outbox,bot_settings,bot_views,lifecycle,management):module.now=lambda:'${stamp}'
class Frozen(datetime.datetime):
 @classmethod
 def now(cls,tz=None):return datetime.datetime.fromisoformat('${stamp}').astimezone(tz)
bot_outbox.datetime=Frozen;management.datetime=Frozen
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
async function invitation(s:Awaited<ReturnType<typeof setup>>,patch:Record<string,unknown>={}){expect((await s.invite(patch)).statusCode).toBe(200);return (await s.context()).invitations.at(-1)!;}
describe('activity delegation and ownership handoff',()=>{
  it('matches explicit cohost scope invitations, seven-day expiry and no access or authority before acceptance',async()=>{
    const s=await setup();await differential(s,"management.invite(db,event,user,dict(kind='cohost',target_name='協辦',permissions=['roster','attendance','roster'],reason='分擔現場管理'))",async()=>expect((await s.invite({permissions:['roster','attendance','roster']})).statusCode).toBe(200));const context=await s.context(),invite=context.invitations[0]!;expect(invite).toMatchObject({permissions:['attendance','roster'],expiresAt:'2026-11-24T00:00:00+00:00'});expect((await s.context(s.bob)).invitations).toEqual([]);expect(s.db.prepare('SELECT * FROM event_roles').all()).toEqual([]);expect(s.db.prepare("SELECT * FROM event_access WHERE user_id='bob'").all()).toEqual([]);
    const preview=ActivityDelegationPreview.parse((await s.tokenView(invite.token)).json());expect(Object.keys((await s.tokenView(invite.token)).json()).sort()).toEqual(Object.keys(preview).sort());expect(preview).toMatchObject({ownerName:'小青',targetName:'協辦',permissions:['attendance','roster'],isOwner:false});
    await differential(s,`user=db.execute("SELECT * FROM users WHERE id='bob'").fetchone();management.accept(db,event,user,'${invite.token}',dict(accept_responsibility=True))`,async()=>expect((await s.accept(invite.token)).statusCode).toBe(200));expect((await s.context(s.bob)).myScopes.sort()).toEqual(['attendance','roster']);expect((await s.tokenView(invite.token)).statusCode).toBe(404);
  });
  it('accepts an unbound private-event cohost without requiring attendance or leaking the private roster in the token preview',async()=>{
    const s=await setup();s.db.exec("UPDATE events SET visibility='invitation' WHERE id='listen'");const invite=await invitation(s);expect((await s.app.inject({url:'/api/v2/activities/listen',headers:s.bob})).statusCode).toBe(404);const preview=(await s.tokenView(invite.token)).json();for(const key of ['location','description','targets','roles','participants','invitations','share_token'])expect(preview).not.toHaveProperty(key);expect((await s.accept(invite.token)).statusCode).toBe(200);expect((await s.context(s.bob)).myScopes).toEqual(['attendance']);expect(s.people()).toHaveLength(0);expect((await s.app.inject({url:'/api/v2/activities/listen',headers:s.bob})).statusCode).toBe(200);
  });
  it('binds an attendee invitation to the true account, never its name or manager, and forbids the owner accepting',async()=>{
    const s=await setup();await s.signup(s.values(),s.bob);const person=s.people()[0]!;const invite=await invitation(s,{attendeeId:person.id,targetName:'顯示提示可不同'});const stranger=await s.third();expect((await s.tokenView(invite.token,stranger)).statusCode).toBe(403);expect((await s.app.inject({url:'/api/v2/activities/listen/delegation/preview/'+invite.token})).statusCode).toBe(403);expect((await s.accept(invite.token,{},stranger)).statusCode).toBe(403);expect((await s.accept(invite.token,{},s.alice)).statusCode).toBe(403);expect((await s.accept(invite.token)).statusCode).toBe(200);
    const generic=await invitation(s);expect((await s.accept(generic.token,{},s.alice)).statusCode).toBe(409);await s.signup(s.values([guest('未綁本人')]));expect((await s.invite({attendeeId:s.people().at(-1)!.id})).statusCode).toBe(400);await s.signup();expect((await s.invite({attendeeId:s.people().find(p=>p.user_id==='alice')!.id})).statusCode).toBe(400);
  });
  it('matches scope replacement for an existing cohost and limits each action to the granted scope',async()=>{
    const s=await setup();let invite=await invitation(s,{permissions:['schedule','roster']});await s.accept(invite.token);expect((await s.invite({},s.bob)).statusCode).toBe(403);expect((await s.write('lifecycle',{revision:eventRow(s.db,'listen')!.revision,action:'cancel',reason:'不能取消',confirm:true},s.bob)).statusCode).toBe(403);expect((await s.write('lifecycle',{revision:eventRow(s.db,'listen')!.revision,action:'pause',reason:'分工',confirm:true},s.bob)).statusCode).toBe(200);
    invite=await invitation(s,{permissions:['attendance']});await differential(s,`user=db.execute("SELECT * FROM users WHERE id='bob'").fetchone();management.accept(db,event,user,'${invite.token}',dict(accept_responsibility=True))`,async()=>expect((await s.accept(invite.token)).statusCode).toBe(200));expect((await s.context(s.bob)).myScopes).toEqual(['attendance']);expect((await s.write('lifecycle',{revision:eventRow(s.db,'listen')!.revision,action:'resume',reason:'失去安排權',confirm:true},s.bob)).statusCode).toBe(403);
  });
  it('matches appointment of one settlement person while preserving unrelated duties for both the former and new appointees',async()=>{
    const s=await setup(),charlie=await s.third();let invite=await invitation(s,{permissions:['schedule','settlement']});await s.accept(invite.token);invite=await invitation(s,{permissions:['attendance']});await s.accept(invite.token,{},charlie);invite=await invitation(s,{permissions:['settlement']});
    await differential(s,`user=db.execute("SELECT * FROM users WHERE id='charlie'").fetchone();management.accept(db,event,user,'${invite.token}',dict(accept_responsibility=True))`,async()=>expect((await s.accept(invite.token,{},charlie)).statusCode).toBe(200));expect((await s.context(s.bob)).myScopes).toEqual(['schedule']);expect((await s.context(charlie)).myScopes.sort()).toEqual(['attendance','settlement']);expect((await s.context()).roles.filter(role=>role.permissions.includes('settlement'))).toHaveLength(1);expect(s.db.prepare("SELECT message FROM notifications WHERE user_id='bob' AND kind='cohost_removed'").all()).toEqual([{message:'週末一起聽日系音樂 已另行指定结算人，你的结算权限已撤销'}]);
    invite=await invitation(s,{permissions:['settlement']});await differential(s,`user=db.execute("SELECT * FROM users WHERE id='bob'").fetchone();management.accept(db,event,user,'${invite.token}',dict(accept_responsibility=True))`,async()=>expect((await s.accept(invite.token)).statusCode).toBe(200));expect((await s.context(charlie)).myScopes).toEqual(['attendance']);expect((await s.context(s.bob)).myScopes.sort()).toEqual(['schedule','settlement']);
  });
  it('removes an appointee who has no other scopes, and revokes roles with a reason while retaining attendee management and access',async()=>{
    const s=await setup(),charlie=await s.third();await s.signup(s.values(),s.bob);let invite=await invitation(s,{permissions:['settlement']});await s.accept(invite.token);invite=await invitation(s,{permissions:['settlement','roster']});await s.accept(invite.token,{},charlie);expect((await s.context()).roles).toHaveLength(1);const role=(await s.context()).roles[0]!;
    await differential(s,`management.revoke_role(db,event,user,'${role.id}',dict(reason='重新協調分工'))`,async()=>expect((await s.revoke('roles',role.id)).statusCode).toBe(200));expect((await s.context(charlie)).myScopes).toEqual([]);expect((await s.context(s.bob)).myScopes).toEqual([]);expect((await s.app.inject({url:'/api/v2/activities/listen/registration',headers:s.bob})).json().people).toHaveLength(1);
  });
  it('matches transfer acceptance, removes a new-owner role, invalidates all old pending grants and preserves every roster, consent and finance row',async()=>{
    const s=await setup();await s.signup();await s.signup(s.values([guest('代報同行')]));await s.signup(s.values(),s.bob);s.db.exec("INSERT INTO event_roles VALUES('old-cohost','listen','bob','[\"schedule\"]','before'); INSERT INTO finance_reports(id,event_id,reporter_id,reporter_name,payload_json,created_at) VALUES('money-report','listen','alice','小青','{\"amount_cents\":5000}','before'); INSERT INTO finance_entries(id,event_id,kind,payload_json,occurred_at,actor_id,actor_name,created_at) VALUES('money-entry','listen','prepayment','{\"payer_id\":\"original-payer\",\"amount_cents\":5000}','before','alice','小青','before')");const kept=state(s.db),old=await invitation(s),transfer=await invitation(s,{kind:'transfer',permissions:[]});
    await differential(s,`user=db.execute("SELECT * FROM users WHERE id='bob'").fetchone();management.accept(db,event,user,'${transfer.token}',dict(accept_responsibility=True))`,async()=>expect((await s.accept(transfer.token)).statusCode).toBe(200));expect(eventRow(s.db,'listen')!.owner_id).toBe('bob');expect((await s.context(s.alice)).isOwner).toBe(false);expect((await s.context(s.bob)).isOwner).toBe(true);expect((await s.context(s.bob)).roles).toEqual([]);expect((await s.tokenView(old.token)).statusCode).toBe(404);
    for(const table of ['attendees','roster_parties','attendee_consents','finance_entries','finance_reports','attendee_payment_origins'])expect(state(s.db)[table],table).toEqual(kept[table]);expect((await s.app.inject({url:'/api/v2/activities/listen/registration',headers:s.alice})).json().people).toHaveLength(2);expect((await s.invite()).statusCode).toBe(403);expect(s.db.prepare("SELECT * FROM bot_outbox WHERE kind='ownership_changed'").all()).toHaveLength(1);
  });
  it('supersedes only prior transfers, allows current-owner revocation, and rejects expired, revoked or old-initiator tokens',async()=>{
    const s=await setup();const cohost=await invitation(s),old=await invitation(s,{kind:'transfer',permissions:[]}),next=await invitation(s,{kind:'transfer',permissions:[]});expect((await s.tokenView(old.token)).statusCode).toBe(404);expect((await s.tokenView(cohost.token)).statusCode).toBe(200);
    await differential(s,`management.revoke_invitation(db,event,user,'${next.id}',dict(reason='重新協調分工'))`,async()=>expect((await s.revoke('invitations',next.id)).statusCode).toBe(200));expect((await s.tokenView(next.token)).statusCode).toBe(404);s.db.prepare('UPDATE management_invitations SET expires_at=? WHERE id=?').run(stamp,cohost.id);expect((await s.tokenView(cohost.token)).statusCode).toBe(404);expect((await s.accept(cohost.token)).statusCode).toBe(404);
    const stale=await invitation(s);s.db.exec("UPDATE events SET owner_id='bob' WHERE id='listen'");expect((await s.tokenView(stale.token)).statusCode).toBe(404);
  });
  it('blocks new invitations when archived but preserves the source acceptance and revocation rules for existing invitations, including drafts and settled history',async()=>{
    const s=await setup(),invite=await invitation(s);s.db.exec("UPDATE events SET archived_at='before',lifecycle='ended' WHERE id='listen'; INSERT INTO settlements(event_id,total_cents,headcount,updated_at,note) VALUES('listen',0,1,'before','')");expect((await s.invite()).statusCode).toBe(409);await differential(s,`user=db.execute("SELECT * FROM users WHERE id='bob'").fetchone();management.accept(db,event,user,'${invite.token}',dict(accept_responsibility=True))`,async()=>expect((await s.accept(invite.token)).statusCode).toBe(200));expect((await s.revoke('roles',(await s.context()).roles[0]!.id)).statusCode).toBe(200);
    s.db.exec("UPDATE events SET archived_at=NULL,lifecycle='draft' WHERE id='listen'");const draft=await invitation(s);expect((await s.app.inject({url:'/api/v2/activities/listen/draft',headers:s.bob})).statusCode).toBe(404);expect((await s.accept(draft.token)).statusCode).toBe(200);expect((await s.app.inject({url:'/api/v2/activities/listen/draft',headers:s.bob})).statusCode).toBe(200);
  });
  it('requires owner authority, valid scopes, explicit responsibility, current revision and nonempty reasons',async()=>{
    const s=await setup();s.db.exec("INSERT INTO user_admin_roles VALUES('bob',1,1,'before')");expect((await s.invite({},s.bob)).statusCode).toBe(403);for(const patch of [{permissions:[]},{permissions:['owner']},{targetName:''},{targetName:'😀'.repeat(25)},{reason:''},{confirm:false}])expect((await s.invite(patch)).statusCode).toBe(400);expect((await s.invite({revision:0})).statusCode).toBe(409);const invite=await invitation(s);
    for(const patch of [{acceptResponsibility:false},{confirm:false}])expect((await s.accept(invite.token,patch)).statusCode).toBe(400);expect((await s.accept(invite.token,{revision:0})).statusCode).toBe(409);expect((await s.revoke('invitations',invite.id,{reason:''})).statusCode).toBe(400);expect((await s.revoke('invitations',invite.id,{},s.bob)).statusCode).toBe(403);
  });
  it('recovers exact accept receipts after tokens are consumed, rechecks owner authority for issuer receipts and never grants a revoked role through replay',async()=>{
    const s=await setup(),inviteKey=randomUUID(),body={revision:3,kind:'cohost',targetName:'協辦',attendeeId:null,permissions:['roster'],reason:'分擔現場管理',confirm:true};await s.write('delegation/invitations',body,s.alice,inviteKey);expect((await s.write('delegation/invitations',body,s.alice,inviteKey)).statusCode).toBe(200);expect((await s.context()).invitations).toHaveLength(1);const invite=(await s.context()).invitations[0]!,acceptKey=randomUUID(),accept={revision:eventRow(s.db,'listen')!.revision,acceptResponsibility:true,confirm:true};expect((await s.write('delegation/preview/'+invite.token+'/accept',accept,s.bob,acceptKey)).statusCode).toBe(200);const role=(await s.context()).roles[0]!;await s.revoke('roles',role.id);const replay=await s.write('delegation/preview/'+invite.token+'/accept',accept,s.bob,acceptKey);expect(replay.statusCode).toBe(200);expect(Object.keys(replay.json()).sort()).toEqual(['id','operationId','revision']);expect((await s.context(s.bob)).myScopes).toEqual([]);expect((await s.invite({},s.bob)).statusCode).toBe(403);expect((await s.write('delegation/preview/'+invite.token+'/accept',{...accept,revision:0},s.bob,acceptKey)).statusCode).toBe(409);
    const transfer=await invitation(s,{kind:'transfer',permissions:[]}),key=randomUUID(),input={revision:eventRow(s.db,'listen')!.revision,acceptResponsibility:true,confirm:true};expect((await s.write('delegation/preview/'+transfer.token+'/accept',input,s.bob,key)).statusCode).toBe(200);expect((await s.write('delegation/preview/'+transfer.token+'/accept',input,s.bob,key)).statusCode).toBe(200);expect((await s.write('delegation/invitations',body,s.alice,inviteKey)).statusCode).toBe(403);expect(JSON.stringify(s.db.prepare('SELECT * FROM request_results').all())).not.toContain(transfer.token);
  });
  it('serializes competing acceptances so only one account obtains an unbound cohost invitation',async()=>{
    const s=await setup(),charlie=await s.third(),invite=await invitation(s);const results=await Promise.all([s.accept(invite.token),s.accept(invite.token,{},charlie)]);expect(results.map(r=>r.statusCode).sort()).toEqual([200,404]);expect((await s.context()).roles).toHaveLength(1);expect(s.db.prepare("SELECT * FROM management_invitations WHERE status='accepted'").all()).toHaveLength(1);expect(s.db.prepare("SELECT * FROM notifications WHERE kind='cohost_accepted'").all()).toHaveLength(1);
  });
  it('keeps same-named accounts distinct and records a real ownership transfer even when display snapshots would otherwise be equal',async()=>{
    const s=await setup();s.db.exec("UPDATE users SET nickname='小青' WHERE id='bob'");const invite=await invitation(s,{kind:'transfer',permissions:[]}),before=eventRow(s.db,'listen')!.revision;expect((await s.accept(invite.token)).statusCode).toBe(200);expect(eventRow(s.db,'listen')).toMatchObject({owner_id:'bob',revision:before+1});expect(s.db.prepare("SELECT before_json,after_json FROM event_audit WHERE action='ownership_transferred'").get()).toMatchObject({before_json:JSON.stringify({owner_name:'小青',roles:[],owner_id:'alice'}),after_json:JSON.stringify({owner_name:'小青',roles:[],owner_id:'bob'})});expect(s.db.prepare("SELECT * FROM bot_outbox WHERE kind='ownership_changed'").all()).toHaveLength(1);
  });
  it('atomically rolls back invitations, scopes, owner, access, notices and audit on required failure while isolating optional bot failures',async()=>{
    const s=await setup();const initial=normalize(state(s.db));for(const table of ['event_audit','request_results']){s.db.exec("CREATE TRIGGER synthetic_failure BEFORE INSERT ON "+table+" BEGIN SELECT RAISE(ABORT,'synthetic'); END");expect((await s.invite()).statusCode).toBe(500);expect(normalize(state(s.db))).toEqual(initial);s.db.exec('DROP TRIGGER synthetic_failure');}
    const invite=await invitation(s,{kind:'transfer',permissions:[]}),before=normalize(state(s.db));for(const table of ['event_access','notifications','event_audit','request_results']){s.db.exec("CREATE TRIGGER synthetic_failure BEFORE INSERT ON "+table+" BEGIN SELECT RAISE(ABORT,'synthetic'); END");expect((await s.accept(invite.token)).statusCode).toBe(500);expect(normalize(state(s.db))).toEqual(before);s.db.exec('DROP TRIGGER synthetic_failure');}s.db.exec("CREATE TRIGGER synthetic_failure BEFORE INSERT ON bot_outbox BEGIN SELECT RAISE(ABORT,'synthetic'); END");expect((await s.accept(invite.token)).statusCode).toBe(200);expect(eventRow(s.db,'listen')!.owner_id).toBe('bob');
  });
  it('redacts native and legacy tokens plus queries from request logs without retaining the secret path segment',()=>{
    const token='synthetic-secret-token-0123456789';for(const path of ['/api/v2/activities/id/delegation/preview/','/activities/id/delegation/','/api/v2/activities/id/claims/preview/','/api/v2/activities/id/invitations/','/api/events/id/management/invitations/','/api/events/id/claims/']){const redacted=redactRequestURL(path+token+'/accept?secret=private');expect(redacted).not.toContain(token);expect(redacted).not.toContain('private');expect(redacted).toContain('[redacted]');}expect(redactRequestURL('/api/v2/activities/id/delegation/preview/%41encoded-secret/accept')).not.toContain('encoded-secret');expect(redactRequestURL('/api/v2/activities?page=2')).toBe('/api/v2/activities');
  });
  it('lets the retained Python worker consume ownership cards once in plain, rich and simulation modes without forwarding private notices to groups',async()=>{
    const s=await setup(),transfer=await invitation(s,{kind:'transfer',permissions:[]});await s.accept(transfer.token);const folder=mkdtempSync(join(tmpdir(),'qgroup-delegation-worker-'));
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
print(json.dumps(dict(first=first,second=second,calls=api.post.call_count,rows=[dict(r) for r in db.execute('SELECT kind,status,simulated_at,delivered_payload_json,last_error FROM bot_outbox ORDER BY id')],owner=db.execute("SELECT owner_id FROM events WHERE id='listen'").fetchone()[0])))`,path,mode],{encoding:'utf8',env:{...process.env,QQBOT_APP_ID:'',QQBOT_APP_SECRET:'',KANBAN_BOT_ENV:'',KANBAN_BOT_BASE_URL:origin}}));
      expect(result.first).toMatchObject({claimed:2,sent:mode==='dry-run'?0:1,simulated:mode==='dry-run'?1:0,failed:0});expect(result.second.claimed).toBe(0);expect(result.calls).toBe(mode==='dry-run'?0:1);expect(result.owner).toBe('bob');
      const group=result.rows.find((r:{kind:string})=>r.kind==='ownership_changed'),personal=result.rows.find((r:{kind:string})=>r.kind==='ownership_transferred');expect(group.status).toBe(mode==='dry-run'?'skipped':'sent');expect(JSON.parse(group.delivered_payload_json).msg_type).toBe(mode==='plain'?0:2);expect(group.delivered_payload_json).toContain('rebuild.example');expect(group.delivered_payload_json).not.toContain(transfer.token);expect(personal.status).toBe('skipped');expect(personal.last_error).toContain('不能改发到群');
    }}finally{rmSync(folder,{recursive:true,force:true});}
  });

  it('keeps the Python worker from sending a settlement published by a now-displaced appointee or former owner',async()=>{
    for(const kind of ['cohost','transfer']){
      const s=await setup(),actor=kind==='transfer'?'alice':'bob';
      if(kind==='cohost'){const first=await invitation(s,{permissions:['settlement']});await s.accept(first.token);}
      s.db.prepare("INSERT INTO settlement_history(event_id,version,total_cents,headcount,note,updated_at,actor_id,actor_name,kind,changed_fields) VALUES('listen',1,5000,1,'保留舊收款人',?,?,?,'published','[]')").run(stamp,actor,'原發布者');
      const invite=await invitation(s,{kind,permissions:kind==='transfer'?[]:['settlement']}),charlie=await s.third();await s.accept(invite.token,{},charlie);
      s.db.prepare("INSERT INTO bot_outbox(event_id,kind,dedupe_key,channel,target,payload_json,status,created_at) VALUES('listen','settlement_updated','old-settlement','group','synthetic-group',?,'pending',?)").run(JSON.stringify({text:'原版結算',msg_type:0,_settlement_version:1}),stamp);
      const folder=mkdtempSync(join(tmpdir(),'qgroup-delegation-settlement-')),path=join(folder,'synthetic.sqlite3');
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
config=SimpleNamespace(db=Path(sys.argv[1]),group='synthetic-group',dry_run=False,sandbox=False,claim_timeout=600,batch=10,max_attempts=5,markdown_replies=False,allowed_link_hosts=('rebuild.example',),log_dir=Path(sys.argv[1]).parent/'isolated-logs',log_content=False)
api=Mock();api.post.return_value=(True,0,dict(id='SYNTHETIC_ONLY'));consumer=worker.OutboxWorker(config,api)
first=consumer.poll_once();second=consumer.poll_once();db=sqlite3.connect(sys.argv[1]);db.row_factory=sqlite3.Row
print(json.dumps(dict(first=first,second=second,row=dict(db.execute("SELECT status,last_error,delivered_payload_json FROM bot_outbox WHERE dedupe_key='old-settlement'").fetchone()),calls=[str(c) for c in api.post.call_args_list])))`,path],{encoding:'utf8',env:{...process.env,QQBOT_APP_ID:'',QQBOT_APP_SECRET:'',KANBAN_BOT_ENV:'',KANBAN_BOT_BASE_URL:origin}}));
        expect(result.row).toMatchObject({status:'skipped',last_error:'原发布者的结算权限已撤销，请重新核对收款人并发布',delivered_payload_json:null});expect(result.second.claimed).toBe(0);expect(JSON.stringify(result.calls)).not.toContain('原版結算');expect(s.db.prepare("SELECT actor_id,total_cents FROM settlement_history WHERE event_id='listen' AND version=1").get()).toEqual({actor_id:actor,total_cents:5000});
      }finally{rmSync(folder,{recursive:true,force:true});}
    }
  });

});
