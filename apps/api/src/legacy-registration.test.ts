import { randomBytes,randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync,mkdirSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach,expect,it } from 'vitest';
import { openDatabase,type DB } from '@qgroup/database';
import { LegacyRegistrationInspection } from '@qgroup/contracts';
import { fixture } from '../testsupport/fixture';
import { createApp } from './app';
import { arrangementSnapshot,eventRow } from './activity-arrangements';
import { originalRequestSignature } from './legacy-local';
const origin='https://rebuild.example',stamp='2026-11-17T00:00:00+00:00',target='1111111111111111',waiting='2222222222222222';
const tables=['events','event_access','event_conditions','event_audit','roster_parties','attendees','attendee_consents','notifications','bot_outbox','request_results'];
const cleanups:(()=>Promise<unknown>)[]=[];afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();});
async function setup(empty=false){
 const db=openDatabase(':memory:');fixture(db);db.exec("UPDATE events SET capacity=1,bot_enabled=1 WHERE id='listen'");
 db.prepare('INSERT INTO event_conditions VALUES(?,1,?,?,?,?)').run('listen',JSON.stringify(arrangementSnapshot(eventRow(db,'listen')!)),'初始安排','小青',stamp);
 if(!empty){
  for(const [person,user,status] of [[target,'alice','confirmed'],[waiting,'bob','waiting']]){
   db.prepare("INSERT INTO roster_parties(id,event_id,manager_id,queue_mode,created_at) VALUES(?,'listen',?,'individual',?)").run('party-'+person,user,stamp);
   db.prepare("INSERT INTO attendees(id,event_id,manager_id,user_id,party_id,name,note,payer_kind,status,created_at,updated_at,accepted_conditions_version,confirmation_state) VALUES(?,'listen',?,?,?,?, '原備註','self',?,?,?,1,'pending')").run(person,user,user,'party-'+person,user,status,stamp,stamp);
  }
 }
 db.prepare('UPDATE bot_settings SET config_json=?').run(JSON.stringify({enabled:true,groups:[{id:'synthetic-group',name:'',broadcast:true,replies:true}]}));
 let moment=stamp;const app=createApp({db,origin,now:()=>new Date(moment),activityBot:{enabled:true,baseURL:origin,keyboard:true,personalQueue:true}});await app.ready();cleanups.push(async()=>{await app.close();db.close();});
 const account=async(id:string)=>{const cookie='kanban_session=fixture-'+id,s=(await app.inject({url:'/api/v2/session',headers:{cookie}})).json();return {cookie,origin,'x-account-scope':s.scope,'x-csrf-token':s.csrf};};const alice=await account('alice'),bob=await account('bob');
 const input=(method:string,suffix:string,data:Record<string,unknown>={})=>({method,path:'/api/events/listen'+suffix,data:JSON.parse(JSON.stringify({base_revision:eventRow(db,'listen')!.revision,...data})) as Record<string,unknown>,requestKey:randomBytes(16).toString('hex')});
 const send=(body:unknown,mode='inspect',headers=alice)=>app.inject({method:'POST',url:'/api/v2/me/legacy-requests/registration/'+mode,headers,payload:body as Record<string,unknown>});
 const snapshot=()=>Object.fromEntries(tables.map(t=>[t,db.prepare('SELECT * FROM '+t).all()]));
 const prepared=async(i:ReturnType<typeof input>,headers=alice)=>{const before=snapshot(),r=await send(i,'inspect',headers);expect(r.statusCode,r.body).toBe(200);const p=LegacyRegistrationInspection.parse(r.json());expect(snapshot()).toEqual(before);if(p.state!=='retryable')throw Error('retryable');return {...i,confirm:true,recovery_token:p.recovery_token};};
 async function signup(data:Record<string,unknown>={}){const i=input('POST','/roster/parties',{people:[{is_self:true}],...data}),r=await app.inject({method:'POST',url:'/api/v2/activities/listen/registration/preview',headers:alice,payload:{revision:eventRow(db,'listen')!.revision,people:(i.data.people as Record<string,unknown>[]).map(p=>({isSelf:p.is_self??false,name:p.name??'',note:p.note??'',payerKind:p.payer_kind??(p.is_self?'self':'manager')})),queueMode:i.data.queue_mode??'individual',intent:i.data.intent??'registered'}});expect(r.statusCode,r.body).toBe(200);return {...i,data:{...i.data,preview_token:r.json().token,conditions_version:r.json().conditionsVersion,allocation:r.json().allocation}};}
 return {db,app,alice,bob,input,send,snapshot,prepared,signup,clock:(v:string)=>{moment=v;}};
}
async function completed(s:Awaited<ReturnType<typeof setup>>,i:ReturnType<Awaited<ReturnType<typeof setup>>['input']>,headers=s.alice){const b=await s.prepared(i,headers),r=await s.send(b,'retry',headers);expect(r.statusCode,r.body).toBe(200);expect(r.json()).toMatchObject({state:'committed',receipt:{target:{id:'listen',kind:'activity'}}});expect(s.db.prepare('SELECT signature,response_status FROM request_results WHERE request_key=?').get(i.requestKey)).toEqual({signature:originalRequestSignature(i.method,i.path,i.data),response_status:200});const before=s.snapshot();s.clock('2026-12-20T00:00:00Z');expect((await s.send(b,'retry',headers)).json()).toEqual(r.json());expect(s.snapshot()).toEqual(before);return r;}
for(const variant of ['self','guest','together','tentative'])it('recovers original '+variant+' signup with the original preview and consent',async()=>{
 const s=await setup(true),data=variant==='self'?{}:{people:[{name:'同行😀',note:'原備註'},{name:'朋友',payer_kind:'self'}],...(variant==='together'?{queue_mode:'together'}:variant==='tentative'?{intent:'tentative'}:{accept_partial:true})};
 const i=await s.signup(data);await completed(s,i);expect(s.db.prepare("SELECT count(*) AS n FROM attendee_consents WHERE event_id='listen'").get()).toEqual({n:variant==='self'?1:2});
});
it('does not invent a missing or stale original preview or accept partial allocation',async()=>{const s=await setup(true),i=await s.signup({people:[{name:'甲'},{name:'乙'}]});for(const data of [{...i.data,preview_token:undefined},{...i.data,preview_token:'0'.repeat(64)},i.data]){const before=s.snapshot();expect((await s.send({...i,data})).statusCode).toBe(409);expect(s.snapshot()).toEqual(before);}});
it('preserves the original ignored own name and reviews the actual retained name',async()=>{const s=await setup(),i=s.input('PATCH','/attendees/'+target,{name:false,note:'本人備註'});const p=(await s.send(i)).json();expect(p.command.name).toBe('alice');await completed(s,i);expect(s.db.prepare('SELECT name FROM attendees WHERE id=?').get(target)).toEqual({name:'alice'});});
it('preserves Python BOM and omitted payer while editing guest details',async()=>{const s=await setup();s.db.exec("UPDATE attendees SET user_id=NULL,name='同行',payer_kind='manager' WHERE id='"+target+"'");const i=s.input('PATCH','/attendees/'+target,{name:'\u0085\ufeff\u001f',note:'\u001c原備註\u0085'});await completed(s,i);expect(s.db.prepare('SELECT name,note,payer_kind FROM attendees WHERE id=?').get(target)).toEqual({name:'\ufeff',note:'原備註',payer_kind:'manager'});});
for(const action of ['confirm','split'])it('preserves party queue semantics for original '+action,async()=>{const s=await setup();s.db.exec("UPDATE attendees SET status='"+(action==='confirm'?'tentative':'waiting')+"' WHERE id='"+target+"'; UPDATE roster_parties SET queue_mode='together' WHERE id='party-"+target+"'");const i=s.input('PATCH','/attendees/'+target,{action});await completed(s,i);expect(s.db.prepare('SELECT status FROM attendees WHERE id=?').get(target)).toEqual({status:action==='confirm'?'waiting':'confirmed'});});
it('withdraws and promotes FIFO waiters with atomic receipt and personal notice',async()=>{const s=await setup(),i=s.input('DELETE','/attendees/'+target);await completed(s,i);expect(s.db.prepare('SELECT id,status FROM attendees WHERE event_id=? ORDER BY id').all('listen')).toEqual([{id:target,status:'withdrawn'},{id:waiting,status:'confirmed'}]);expect(s.db.prepare("SELECT kind FROM notifications WHERE event_id='listen'").all()).toContainEqual({kind:'promoted'});});
it('requires withdrawal approval after deadline and keeps registration until decision',async()=>{const s=await setup();s.db.exec("UPDATE events SET withdrawal_deadline='2026-11-16T00:00:00+00:00' WHERE id='listen'");const i=s.input('DELETE','/attendees/'+target,{reason:'無法到場'});const p=(await s.send(i)).json();expect(p.effect).toBe('withdrawal_request');await completed(s,i);expect(s.db.prepare('SELECT status,withdrawal_requested FROM attendees WHERE id=?').get(target)).toEqual({status:'confirmed',withdrawal_requested:1});});
for(const decision of ['approve','reject'])it('recovers original withdrawal '+decision+' and retains old receipt after review state changes',async()=>{const s=await setup();s.db.prepare('UPDATE attendees SET withdrawal_requested=1 WHERE id=?').run(target);await completed(s,s.input('PATCH','/attendees/'+target+'/withdrawal',{decision,reason:'已核對'}));expect(s.db.prepare('SELECT status,withdrawal_requested FROM attendees WHERE id=?').get(target)).toEqual({status:decision==='approve'?'withdrawn':'confirmed',withdrawal_requested:0});});
for(const decision of ['accepted','declined'])it('recovers original conditions '+decision+' while preserving prior agreement and roster',async()=>{const s=await setup();s.db.exec("UPDATE events SET conditions_version=2 WHERE id='listen'");await completed(s,s.input('PATCH','/attendees/'+target+'/conditions',{conditions_version:2,decision,reason:'核對安排'}));expect(s.db.prepare('SELECT status,accepted_conditions_version,confirmation_state FROM attendees WHERE id=?').get(target)).toEqual({status:'confirmed',accepted_conditions_version:decision==='accepted'?2:1,confirmation_state:decision});});
it('conditions no-op preserves consent and audit timestamps',async()=>{const s=await setup();s.db.prepare("UPDATE attendees SET confirmation_state='accepted' WHERE id=?").run(target);const before=s.db.prepare('SELECT * FROM attendees').all();await completed(s,s.input('PATCH','/attendees/'+target+'/conditions',{conditions_version:1,decision:'accepted'}));expect(s.db.prepare('SELECT * FROM attendees').all()).toEqual(before);expect(s.db.prepare('SELECT count(*) AS n FROM event_audit').get()).toEqual({n:0});});
for(const action of ['create','edit','delete','absent'])it('preserves old self registration '+action+' defaults without fabricated original revision',async()=>{const s=await setup(action==='create'||action==='absent'),i=s.input(action==='delete'||action==='absent'?'DELETE':'PUT','/registration',{note:'原本人備註',base_revision:undefined});await completed(s,i);if(action==='edit')expect(s.db.prepare('SELECT note FROM attendees WHERE id=?').get(target)).toEqual({note:'原本人備註'});});
it('old self signup requires original agreement version once fees or arrangements changed',async()=>{const s=await setup(true);s.db.exec("UPDATE events SET fee_policy='費用規則' WHERE id='listen'");const before=s.snapshot();expect((await s.send(s.input('PUT','/registration',{base_revision:undefined}))).statusCode).toBe(409);expect(s.snapshot()).toEqual(before);await completed(s,s.input('PUT','/registration',{conditions_version:1,base_revision:undefined}));});
it('requires original revision for all new original roster routes',async()=>{const s=await setup(),before=s.snapshot();for(const [method,path,data] of [['PATCH','/attendees/'+target,{note:'x'}],['DELETE','/attendees/'+target,{}],['PATCH','/attendees/'+target+'/conditions',{conditions_version:1,decision:'accepted'}]] as const)expect((await s.send(s.input(method,path,{...data,base_revision:undefined}))).statusCode).toBe(409);expect(s.snapshot()).toEqual(before);});
it('checks current person management and decision authority before receipt acknowledgement',async()=>{const s=await setup(),i=s.input('PATCH','/attendees/'+target,{note:'new'});await completed(s,i);s.db.exec("UPDATE attendees SET manager_id='bob' WHERE id='"+target+"'; UPDATE events SET owner_id='bob' WHERE id='listen'");const before=s.snapshot();expect((await s.send(i)).statusCode).toBe(403);expect(s.snapshot()).toEqual(before);});
it('owner cannot reply to another manager consent or decide without roster scope',async()=>{const s=await setup(),before=s.snapshot();expect((await s.send(s.input('PATCH','/attendees/'+waiting+'/conditions',{conditions_version:1,decision:'accepted'}))).statusCode).toBe(403);expect((await s.send(s.input('PATCH','/attendees/'+waiting+'/withdrawal',{decision:'approve',reason:'理由'}),'inspect',s.bob)).statusCode).toBe(403);expect(s.snapshot()).toEqual(before);});
for(const change of ["UPDATE events SET revision=revision+1 WHERE id='listen'","UPDATE attendees SET note='changed' WHERE id='"+target+"'","UPDATE users SET nickname='changed' WHERE id='alice'","UPDATE bot_settings SET config_json='{\"enabled\":false}'"])it('fences review after '+change,async()=>{const s=await setup(),b=await s.prepared(s.input('DELETE','/attendees/'+target));s.db.exec(change);const before=s.snapshot();expect((await s.send(b,'retry')).statusCode).toBe(409);expect(s.snapshot()).toEqual(before);});
it('rejects wrong method, raw body, key, receipt, confirmation and account boundary',async()=>{const s=await setup(),i=s.input('DELETE','/attendees/'+target),b=await s.prepared(i),before=s.snapshot();for(const body of [{...b,confirm:false},{...b,requestKey:randomUUID()},{...b,data:{...i.data,reason:'different'}},{...b,method:'PUT'},{...b,data:{...i.data,unexpected:true}}])expect((await s.send(body,'retry')).statusCode).toBeGreaterThanOrEqual(400);for(const headers of [{...s.alice,cookie:''},{...s.alice,origin:'https://other.example'},{...s.alice,'x-csrf-token':'bad'},{...s.alice,'x-account-scope':s.bob['x-account-scope']}])expect((await s.send(i,'inspect',headers)).statusCode).toBeGreaterThanOrEqual(400);expect(s.snapshot()).toEqual(before);await completed(s,i);s.db.exec("UPDATE request_results SET response_json='{\"id\":\"other\",\"starts_at\":\"old\"}'");expect((await s.send(i)).statusCode).toBe(409);});
for(const table of ['event_audit','notifications','request_results'])it('rolls back withdrawal, promotion and receipt on required '+table+' failure',async()=>{const s=await setup(),b=await s.prepared(s.input('DELETE','/attendees/'+target)),before=s.snapshot();s.db.exec("CREATE TRIGGER synthetic_fail BEFORE INSERT ON "+table+" BEGIN SELECT RAISE(ABORT,'synthetic'); END");expect((await s.send(b,'retry')).statusCode).toBe(500);expect(s.snapshot()).toEqual(before);});
it('rolls back signup on required consent failure and isolates optional bot failure',async()=>{const s=await setup(true),i=await s.signup(),b=await s.prepared(i),before=s.snapshot();s.db.exec("CREATE TRIGGER synthetic_fail BEFORE INSERT ON attendee_consents BEGIN SELECT RAISE(ABORT,'synthetic'); END");expect((await s.send(b,'retry')).statusCode).toBe(500);expect(s.snapshot()).toEqual(before);s.db.exec("DROP TRIGGER synthetic_fail; CREATE TRIGGER synthetic_bot_fail BEFORE INSERT ON bot_outbox BEGIN SELECT RAISE(ABORT,'synthetic bot'); END");expect((await s.send(b,'retry')).statusCode).toBe(200);expect(s.db.prepare("SELECT count(*) AS n FROM attendees WHERE event_id='listen'").get()).toEqual({n:1});});
it('does not change claimed payment origin through original edit',async()=>{const s=await setup();s.db.exec("INSERT INTO attendee_payment_origins(attendee_id,payer_id,payer_name,claimant_owns,payer_user_id) VALUES('"+target+"','account:bob','原付款者',0,'bob')");const before=s.snapshot();expect((await s.send(s.input('PATCH','/attendees/'+target,{payer_kind:'manager'}))).statusCode).toBe(409);expect(s.snapshot()).toEqual(before);});
it('matches immutable original Python roster, self-registration and conditions business snapshots',async()=>{
 const root=mkdtempSync(join(tmpdir(),'qgroup-original-registration-')),source=join(root,'source');mkdirSync(source);
 try{
  execFileSync('tar',['-xf','-','-C',source],{input:execFileSync('git',['archive','8da877857f163853c449474e168534e2e493121b','qgroup_core'])});
  const cases=[
   {kind:'signup',empty:true,data:{people:[{is_self:true}]}},
   {kind:'signup',empty:true,data:{people:[{name:'甲',note:'備註'},{name:'乙',payer_kind:'self'}],accept_partial:true}},
   {kind:'signup',empty:true,data:{people:[{name:'甲'},{name:'乙'}],queue_mode:'together'}},
   {kind:'signup',empty:true,data:{people:[{name:'甲'},{name:'乙'}],intent:'tentative'}},
   {kind:'edit',data:{note:'原修改'}},
   {kind:'edit',state:"UPDATE attendees SET user_id=NULL,name='同行',payer_kind='manager' WHERE id='"+target+"'",data:{name:'\u0085\ufeff\u001f',note:'\u001c備註\u0085'}},
   {kind:'confirm',state:"UPDATE attendees SET status='tentative' WHERE event_id='listen'; UPDATE roster_parties SET queue_mode='together'"},
   {kind:'split',state:"UPDATE attendees SET status='waiting' WHERE event_id='listen'; UPDATE roster_parties SET queue_mode='together'"},
   {kind:'withdraw'},
   {kind:'withdraw',state:"UPDATE events SET withdrawal_deadline='2026-11-16T00:00:00+00:00' WHERE id='listen'",data:{reason:'退出原因'}},
   ...['approve','reject'].map(kind=>({kind,state:'UPDATE attendees SET withdrawal_requested=1 WHERE id=\''+target+'\'',data:{reason:'審核原因'}})),
   ...['accepted','declined'].map(kind=>({kind,state:"UPDATE events SET conditions_version=2 WHERE id='listen'",data:{conditions_version:2,reason:'回覆原因'}})),
   {kind:'self-put',empty:true,data:{note:'本人備註'}},{kind:'self-put',data:{note:'本人修改'}},{kind:'self-delete'},{kind:'self-delete',empty:true},
  ];
  const names=['events','event_access','event_conditions','event_audit','roster_parties','attendees','attendee_consents','notifications'];
  for(const [n,c] of cases.entries()){
   const s=await setup(c.empty);if('state' in c&&c.state)s.db.exec(c.state);
   const i=c.kind==='signup'?await s.signup(c.data):s.input(c.kind==='withdraw'||c.kind==='self-delete'?'DELETE':c.kind==='self-put'?'PUT':'PATCH',c.kind.startsWith('self-')?'/registration':'/attendees/'+target+(['approve','reject'].includes(c.kind)?'/withdrawal':['accepted','declined'].includes(c.kind)?'/conditions':''),{...c.data,...(['accepted','declined','approve','reject'].includes(c.kind)?{decision:c.kind}:['confirm','split'].includes(c.kind)?{action:c.kind}:{})});
   const path=join(root,n+'.sqlite3');await s.db.backup(path);const b=await s.prepared(i),r=await s.send(b,'retry');expect(r.statusCode,r.body).toBe(200);
   const rows=(db:DB)=>Object.fromEntries(names.map(t=>[t,db.prepare('SELECT * FROM '+t+' WHERE '+(t==='events'?'id':'event_id')+'=? ORDER BY rowid').all('listen') as Record<string,unknown>[]]));
   const old=JSON.parse(execFileSync('python3',['-c',`import json,sys,sqlite3,socket
sys.path.insert(0,sys.argv[1]);socket.socket=lambda *a,**k:(_ for _ in ()).throw(AssertionError('network denied'))
from qgroup_core import roster,conditions,audit
for name,module in list(sys.modules.items()):
 if name.startswith('qgroup_core') and hasattr(module,'now'):module.now=lambda:'2026-11-17T00:00:00+00:00'
db=sqlite3.connect(sys.argv[3]);db.row_factory=sqlite3.Row
event=db.execute("SELECT * FROM events WHERE id='listen'").fetchone();user=dict(id='alice',nickname='小青');data=json.loads(sys.argv[2]);kind=sys.argv[5]
if kind=='signup':roster.add_party(db,event,user,data)
elif kind in ('accepted','declined'):conditions.respond(db,event,user,'1111111111111111',data)
elif kind in ('approve','reject'):roster.withdraw(db,event,user,'1111111111111111',data,decision=kind)
elif kind=='withdraw':roster.withdraw(db,event,user,'1111111111111111',data)
elif kind.startswith('self-'):
 person=db.execute("SELECT * FROM attendees WHERE event_id='listen' AND user_id='alice' AND status!='withdrawn'").fetchone()
 if kind=='self-put':
  if person:roster.change_person(db,event,user,person['id'],dict(note=data.get('note','')))
  else:roster.add_party(db,event,user,dict(people=[dict(is_self=True,note=data.get('note',''))]),require_preview=False)
 elif person:roster.withdraw(db,event,user,person['id'],data)
else:roster.change_person(db,event,user,'1111111111111111',data)
print(json.dumps({t:[dict(r) for r in db.execute('SELECT * FROM '+t+' WHERE '+('id' if t=='events' else 'event_id')+"='listen' ORDER BY rowid")] for t in json.loads(sys.argv[4])}))`,source,JSON.stringify(i.data),path,JSON.stringify(names),c.kind],{encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH,PYTHONDONTWRITEBYTECODE:'1',KANBAN_BOT_ENABLED:'0'}}));
   function normalize(input:Record<string,Record<string,unknown>[]>){
    const ids=new Map<string,string>();for(const t of ['roster_parties','attendees'])input[t]!.forEach((r,n)=>ids.set(r.id as string,t+':'+n));
    const walk=(v:unknown):unknown=>typeof v==='string'?(ids.get(v)??v):Array.isArray(v)?v.map(walk):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).filter(([k,x])=>k!=='id'||typeof x==='string').map(([k,x])=>[k,k.endsWith('_json')&&typeof x==='string'?walk(JSON.parse(x)):k==='participants'&&Array.isArray(x)?x.map(walk).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))):walk(x)])):v;return walk(input);
   }
   expect(normalize(rows(s.db)),c.kind).toEqual(normalize(old));
  }
 }finally{rmSync(root,{recursive:true,force:true});}
});
