import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync,mkdirSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach,it,expect } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { LegacyPersonalInspection } from '@qgroup/contracts';
import { createApp } from './app';
import { fixture } from '../testsupport/fixture';
import { nicknameFixture } from '../testsupport/nickname-fixture';
import { testPNG } from '../testsupport/payment-fixture';
import { eventRow } from './activity-arrangements';
import { originalRequestSignature } from './legacy-local';
const origin='https://rebuild.example',stamp='2026-11-17T08:00:00.000Z',sourceId='a'.repeat(16),codeId='b'.repeat(16);
const tables=['users','events','event_audit','account_audit','attendees','notifications','user_payment_codes','image_assets','request_results','settlement_history','bot_outbox'];
const cleanups:(()=>Promise<unknown>)[]=[];afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();});
async function setup(){
 const root=mkdtempSync(join(tmpdir(),'qgroup-original-personal-')),db=openDatabase(join(root,'state.db'));fixture(db);nicknameFixture(db);
 for(const user of ['alice','bob'])db.prepare("INSERT INTO notifications(user_id,event_id,kind,message,created_at) VALUES(?,'listen','claim_requested','原消息',?)").run(user,stamp);
 const e={...eventRow(db,'past')!,id:sourceId};db.prepare('INSERT INTO events('+Object.keys(e).join(',')+') VALUES('+Object.keys(e).map(()=>'?').join(',')+')').run(...Object.values(e));
 db.prepare("INSERT INTO settlement_history(event_id,version,total_cents,headcount,note,qr_image,updated_at,actor_id,actor_name,kind,changed_fields) VALUES(?,1,100,1,'',?,?,'alice','小青','detailed_published','[]')").run(sourceId,testPNG(),stamp);
 const app=createApp({db,origin,now:()=>new Date(stamp)});await app.ready();cleanups.push(async()=>{await app.close();db.close();rmSync(root,{recursive:true,force:true});});
 async function headers(user='alice'){const cookie='kanban_session=fixture-'+user,s=(await app.inject({url:'/api/v2/session',headers:{cookie}})).json();return {cookie,origin,'x-account-scope':s.scope,'x-csrf-token':s.csrf};}
 const alice=await headers(),bob=await headers('bob');const input=(path='/api/profile',data:Record<string,unknown>={nickname:'原新稱呼'},method:'POST'|'DELETE'='POST')=>({path,data,method,requestKey:randomBytes(16).toString('hex')});
 const send=(body:unknown,action='inspect',auth=alice)=>app.inject({method:'POST',url:'/api/v2/me/legacy-requests/personal/'+action,headers:auth,payload:body as Record<string,unknown>});
 const snapshot=()=>Object.fromEntries(tables.map(t=>[t,db.prepare('SELECT * FROM '+t+' ORDER BY rowid').all()]));
 async function prepared(i:ReturnType<typeof input>,auth=alice){const before=snapshot(),r=await send(i,'inspect',auth);expect(r.statusCode,r.body).toBe(200);expect(snapshot()).toEqual(before);const p=LegacyPersonalInspection.parse(r.json());if(p.state!=='retryable')throw Error('retryable');expect(r.body).not.toContain(testPNG().toString('base64'));return {...i,confirm:true,recovery_token:p.recovery_token};}
 return {root,db,app,alice,bob,input,send,snapshot,prepared,headers};
}
type Setup=Awaited<ReturnType<typeof setup>>;
async function complete(s:Setup,i:ReturnType<Setup['input']>,auth=s.alice){const retry=await s.prepared(i,auth),r=await s.send(retry,'retry',auth);expect(r.statusCode,r.body).toBe(200);expect(r.json().state).toBe('committed');const row=s.db.prepare('SELECT signature,response_status FROM request_results WHERE user_id=? AND request_key=?').get(auth===s.bob?'bob':'alice',i.requestKey);expect(row).toEqual({signature:originalRequestSignature(i.method,i.path,i.data),response_status:i.path==='/api/payment-codes'?201:200});const before=s.snapshot();expect((await s.send(retry,'retry',auth)).json()).toEqual(r.json());expect(s.snapshot()).toEqual(before);return r;}
const upload={kind:'wechat',name:'\u0085\ufeff原码\u001c',image:testPNG().toString('base64')};
it('restores original nickname with Python stripping, roster audit and original scope receipt',async()=>{const s=await setup(),before=s.db.prepare('SELECT id,status,payer_kind,party_id FROM attendees ORDER BY id').all();await complete(s,s.input('/api/profile',{nickname:'\u001c\ufeff原称呼\u0085'}));expect(s.db.prepare('SELECT nickname FROM users WHERE id=?').get('alice')).toEqual({nickname:'\ufeff原称呼'});expect(s.db.prepare('SELECT id,status,payer_kind,party_id FROM attendees ORDER BY id').all()).toEqual(before);expect(s.db.prepare('SELECT action FROM account_audit').all()).toEqual([{action:'nickname_changed'}]);expect(s.db.prepare('SELECT response_json FROM request_results').get()).toEqual({response_json:JSON.stringify({nickname:'\ufeff原称呼',draft_scope:s.alice['x-account-scope']})});});
it('unchanged original nickname is a business no-op with an exact receipt',async()=>{const s=await setup();await complete(s,s.input('/api/profile',{nickname:' 小青 '}));expect(s.db.prepare('SELECT * FROM event_audit').all()).toEqual([]);expect(s.db.prepare('SELECT * FROM account_audit').all()).toEqual([]);});
it('marks only owned original integer notification IDs, preserves read timestamps and ignores missing IDs',async()=>{const s=await setup();s.db.exec("UPDATE notifications SET read_at='before' WHERE id=1");await complete(s,s.input('/api/notifications/read',{ids:[1,2,999,-1,1]}));expect(s.db.prepare('SELECT user_id,read_at FROM notifications ORDER BY id').all()).toEqual([{user_id:'alice',read_at:'before'},{user_id:'bob',read_at:null}]);});
it('empty original notification list still records its no-op receipt',async()=>{const s=await setup();await complete(s,s.input('/api/notifications/read',{ids:[]}));expect(s.db.prepare('SELECT read_at FROM notifications').all()).toEqual([{read_at:null},{read_at:null}]);});
it('saves original image once with Python name semantics and a 201 legacy receipt',async()=>{const s=await setup();await complete(s,s.input('/api/payment-codes',upload));await complete(s,s.input('/api/payment-codes',upload));expect(s.db.prepare('SELECT name FROM user_payment_codes').all()).toEqual([{name:'\ufeff原码'}]);expect(s.db.prepare('SELECT count(*) AS n FROM image_assets').get()).toEqual({n:1});const code=(await s.app.inject({url:'/api/v2/me/payment-codes',headers:s.alice})).json().codes[0];expect((await s.app.inject({url:code.url,headers:s.alice})).rawPayload).toEqual(testPNG());expect((await s.app.inject({url:code.url,headers:s.bob})).statusCode).toBe(404);});
it('restores original source code only from the actor own published settlement, with exact original kind and name',async()=>{const s=await setup(),i=s.input('/api/payment-codes',{kind:'alipay',name:' 原版 ',source:{event_id:sourceId,version:1,kind:'other'}});await complete(s,i);expect(s.db.prepare('SELECT kind,name FROM user_payment_codes').all()).toEqual([{kind:'alipay',name:'原版'}]);const before=s.snapshot();expect((await s.send({...i,requestKey:randomBytes(16).toString('hex')},'inspect',s.bob)).statusCode).toBe(403);expect(s.snapshot()).toEqual(before);});
it('archives original code without deleting frozen settlement image and acknowledges its receipt after archive',async()=>{const s=await setup();await complete(s,s.input('/api/payment-codes',upload));const id=(s.db.prepare('SELECT id FROM user_payment_codes').get() as {id:string}).id;await complete(s,s.input('/api/payment-codes/'+id,{},'DELETE'));expect((s.db.prepare('SELECT archived_at FROM user_payment_codes').get() as {archived_at:string}).archived_at).toBeTruthy();expect((s.db.prepare('SELECT qr_image FROM settlement_history WHERE event_id=?').get(sourceId) as {qr_image:Buffer}).qr_image).toEqual(testPNG());});
for(const change of ["UPDATE users SET nickname='其他稱呼' WHERE id='alice'","UPDATE events SET revision=revision+1 WHERE id='listen'","UPDATE attendees SET note='變更' WHERE event_id='listen'","UPDATE bot_settings SET config_json='{\"enabled\":false}'"])it('fences original nickname review after '+change,async()=>{const s=await setup(),retry=await s.prepared(s.input());s.db.exec(change);const before=s.snapshot();expect((await s.send(retry,'retry')).statusCode).toBe(409);expect(s.snapshot()).toEqual(before);});
it('fences notification review after read state change',async()=>{const s=await setup(),retry=await s.prepared(s.input('/api/notifications/read',{ids:[1]}));s.db.exec("UPDATE notifications SET read_at='another-tab' WHERE id=1");const before=s.snapshot();expect((await s.send(retry,'retry')).statusCode).toBe(409);expect(s.snapshot()).toEqual(before);});
it('fences payment review after source authority and library changes',async()=>{const s=await setup(),retry=await s.prepared(s.input('/api/payment-codes',{kind:'other',source:{event_id:sourceId,version:1,kind:'other'}}));s.db.prepare("UPDATE events SET status='deleted' WHERE id=?").run(sourceId);const before=s.snapshot();expect((await s.send(retry,'retry')).statusCode).toBe(403);expect(s.snapshot()).toEqual(before);});
for(const table of ['event_audit','account_audit','request_results'])it('rolls back nickname and roster revisions when required '+table+' insertion fails',async()=>{const s=await setup(),retry=await s.prepared(s.input()),before=s.snapshot();s.db.exec("CREATE TRIGGER synthetic_fail BEFORE INSERT ON "+table+" BEGIN SELECT RAISE(ABORT,'synthetic'); END");expect((await s.send(retry,'retry')).statusCode).toBe(500);expect(s.snapshot()).toEqual(before);});
it('rolls back payment references on receipt failure; unreachable durable bytes do not become a saved code',async()=>{const s=await setup(),retry=await s.prepared(s.input('/api/payment-codes',upload)),before=s.snapshot();s.db.exec("CREATE TRIGGER synthetic_fail BEFORE INSERT ON request_results BEGIN SELECT RAISE(ABORT,'synthetic'); END");expect((await s.send(retry,'retry')).statusCode).toBe(500);expect(s.snapshot()).toEqual(before);});
it('blocks unknown fields, unsafe credentials, unsupported methods, invalid integer lists and non-PNG without writes',async()=>{const s=await setup(),before=s.snapshot();const inputs=[s.input('/api/profile',{nickname:'ok',secret:'credential'}),s.input('/api/notifications/read',{ids:[true]}),s.input('/api/notifications/read',{ids:['1']}),s.input('/api/notifications/read',{ids:[Number.MAX_SAFE_INTEGER+1]}),s.input('/api/payment-codes',{...upload,image:'not PNG'}),s.input('/api/payment-codes/'+codeId,{confirm:true},'DELETE'),s.input('/api/auth/logout',{}),s.input('/api/profile',{nickname:'a'.repeat(25)})];for(const i of inputs)expect((await s.send(i)).statusCode).toBeGreaterThanOrEqual(400);expect(s.snapshot()).toEqual(before);});
it('binds confirmation to exact original key, body, account and current scope, Origin and CSRF',async()=>{const s=await setup(),i=s.input(),retry=await s.prepared(i),before=s.snapshot();for(const bad of [{...retry,confirm:false},{...retry,requestKey:randomBytes(16).toString('hex')},{...retry,data:{nickname:'other'}}])expect((await s.send(bad,'retry')).statusCode).toBeGreaterThanOrEqual(400);for(const auth of [{...s.alice,cookie:''},{...s.alice,'x-csrf-token':'bad'},{...s.alice,'x-account-scope':s.bob['x-account-scope']},{...s.alice,origin:'https://other.example'}])expect((await s.send(i,'inspect',auth)).statusCode).toBeGreaterThanOrEqual(400);expect(s.snapshot()).toEqual(before);});
it('checks exact actor-scoped original receipt metadata and current code ownership',async()=>{const s=await setup(),i=s.input('/api/payment-codes',upload);await complete(s,i);s.db.exec("UPDATE user_payment_codes SET user_id='bob'");const before=s.snapshot();expect((await s.send(i)).statusCode).toBe(404);expect(s.snapshot()).toEqual(before);});
it('rejects damaged or mismatched original receipts without repeating a committed mutation',async()=>{const s=await setup(),i=s.input();await complete(s,i);for(const payload of ['{',JSON.stringify({nickname:'other',draft_scope:s.alice['x-account-scope']}),JSON.stringify({nickname:'原新稱呼',draft_scope:s.bob['x-account-scope']})]){s.db.prepare('UPDATE request_results SET response_json=?').run(payload);const before=s.snapshot();expect((await s.send(i)).statusCode).toBe(409);expect(s.snapshot()).toEqual(before);}});
it('matches immutable original Python profile, notifications and payment business results',async()=>{
 const root=mkdtempSync(join(tmpdir(),'qgroup-personal-diff-')),source=join(root,'source');mkdirSync(source);
 try{
  execFileSync('tar',['-xf','-','-C',source],{input:execFileSync('git',['archive','8da877857f163853c449474e168534e2e493121b','qgroup_core','server.py'])});
  for(const kind of ['profile','notifications','code-create','code-source','code-archive']){
   const s=await setup();let i=s.input();if(kind==='notifications')i=s.input('/api/notifications/read',{ids:[1,2,999]});
   if(kind==='code-create')i=s.input('/api/payment-codes',upload);if(kind==='code-source')i=s.input('/api/payment-codes',{kind:'alipay',name:' 原版 ',source:{event_id:sourceId,version:1,kind:'other'}});
   if(kind==='code-archive'){await complete(s,s.input('/api/payment-codes',upload));i=s.input('/api/payment-codes/'+(s.db.prepare('SELECT id FROM user_payment_codes').get() as {id:string}).id,{},'DELETE');}
   const path=join(s.root,'original.db');await s.db.backup(path);const compared=['users','events','event_audit','attendees','notifications','user_payment_codes','image_assets','settlement_history'];
   const prior=JSON.parse(execFileSync('python3',['-c',`import json,sqlite3,sys,socket,textwrap
sys.path.insert(0,sys.argv[1]);socket.socket=lambda *a,**k:(_ for _ in ()).throw(AssertionError('network denied'))
from qgroup_core import payment_codes,roster
from qgroup_core.common import string
for name,module in list(sys.modules.items()):
 if name.startswith('qgroup_core') and hasattr(module,'now'):module.now=lambda:sys.argv[5]
db=sqlite3.connect(sys.argv[2]);db.row_factory=sqlite3.Row;user=db.execute("SELECT * FROM users WHERE id='alice'").fetchone();data=json.loads(sys.argv[3]);kind=sys.argv[4]
if kind=='profile':
 raw=open(sys.argv[1]+'/server.py').read();snippet=raw.split("elif self.command=='POST' and path=='/api/profile':",1)[1].split("elif self.command=='POST' and path=='/api/notifications/read':",1)[0];draft_scope=lambda u:__import__('hashlib').sha256(('kanban-drafts-v1:'+u['id']).encode()).hexdigest();exec(textwrap.dedent(snippet))
elif kind=='notifications':
 for uid in data['ids']:db.execute('UPDATE notifications SET read_at=COALESCE(read_at,?) WHERE id=? AND user_id=?',(sys.argv[5],uid,user['id']))
elif kind=='code-archive':payment_codes.archive(db,user,sys.argv[6].split('/')[-1])
else:payment_codes.create(db,user,data)
def wire(v):return list(v) if isinstance(v,bytes) else v
print(json.dumps({t:[{k:wire(v) for k,v in dict(r).items()} for r in db.execute('SELECT * FROM '+t+' ORDER BY rowid')] for t in json.loads(sys.argv[7])}))`,source,path,JSON.stringify(i.data),kind,kind==='profile'?stamp:'2026-11-17T08:00:00+00:00',i.path,JSON.stringify(compared)],{encoding:'utf8',timeout:15000}));
   await complete(s,i);const current=Object.fromEntries(compared.map(t=>[t,s.db.prepare('SELECT * FROM '+t+' ORDER BY rowid').all().map(r=>Object.fromEntries(Object.entries(r as object).map(([k,v])=>[k,Buffer.isBuffer(v)?Array.from(v):v])))]));
   if(kind==='code-create'||kind==='code-source'){for(const obj of [current,prior])for(const row of obj.user_payment_codes as {id:string}[])row.id='random-code';}
   for(const obj of [current,prior])for(const row of obj.event_audit as {before_json:unknown;after_json:unknown}[]){row.before_json=JSON.parse(row.before_json as string);row.after_json=JSON.parse(row.after_json as string);}
   expect(current,kind).toEqual(prior);
  }
 }finally{rmSync(root,{recursive:true,force:true});}
});
