import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach,describe,it,expect } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { decodeLegacyFinance } from '@qgroup/contracts';
import { fixture } from '../testsupport/fixture';
import { createApp } from './app';
import { accountKey,financeEntries } from './finance-context';
import { eventRow } from './activity-arrangements';
import { originalRequestSignature } from './legacy-local';
const origin='https://rebuild.example',stamp='2026-11-17T00:00:00+00:00',a=accountKey('listen','alice'),b=accountKey('listen','bob'),uid=()=>randomBytes(8).toString('hex');
const cleanup:(()=>Promise<void>)[]=[];afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function setup(){
 const db=openDatabase(':memory:');fixture(db);db.exec("UPDATE events SET bot_enabled=1 WHERE id='listen'; INSERT INTO attendees(id,event_id,manager_id,user_id,name,payer_kind,status,created_at,updated_at) VALUES('aaaaaaaaaaaaaaaa','listen','alice','alice','','self','confirmed','before','before'),('bbbbbbbbbbbbbbbb','listen','bob','bob','','self','confirmed','before','before')");
 db.prepare('UPDATE bot_settings SET config_json=?').run(JSON.stringify({enabled:true,groups:[{id:'synthetic-group',name:'測試',replies:true,broadcast:true}]}));
 const app=createApp({db,origin,now:()=>new Date(stamp),activityBot:{enabled:true,baseURL:origin,keyboard:true,personalQueue:true}});await app.ready();cleanup.push(async()=>{await app.close();db.close();});
 async function headers(id:string){const cookie='kanban_session=fixture-'+id,session=(await app.inject({url:'/api/v2/session',headers:{cookie}})).json();return {cookie,origin,'x-account-scope':session.scope,'x-csrf-token':session.csrf};}
 const alice=await headers('alice'),bob=await headers('bob');
 const send=(input:object,mode='inspect',h=alice)=>app.inject({method:'POST',url:'/api/v2/me/legacy-requests/finance/'+mode,headers:h,payload:mode==='retry'?{...input,confirm:true}:input});
 const snapshot=()=>db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>{const name=(row as {name:string}).name;return [name,db.prepare('SELECT * FROM "'+name+'"').all()];});
 return {db,app,alice,bob,send,snapshot};
}
type Setup=Awaited<ReturnType<typeof setup>>;
async function original(s:Setup,operation:object,user='alice'){
 const folder=mkdtempSync(join(tmpdir(),'qgroup-original-finance-')),path=join(folder,'synthetic.sqlite3');
 try{await s.db.backup(path);const revision=eventRow(s.db,'listen')!.revision,data={...operation,base_revision:revision};
 const preview=JSON.parse(execFileSync('python3',['-c',`import datetime,json,sqlite3,sys
from qgroup_core import finance
class Frozen(datetime.datetime):
 @classmethod
 def now(cls,tz=None):return datetime.datetime.fromisoformat('${stamp}').astimezone(tz)
finance.datetime=Frozen
db=sqlite3.connect(sys.argv[1]);db.row_factory=sqlite3.Row
event=db.execute("SELECT * FROM events WHERE id='listen'").fetchone();user=db.execute("SELECT * FROM users WHERE id=?",(sys.argv[2],)).fetchone()
print(json.dumps(finance.preview(db,event,user,json.loads(sys.argv[3])),ensure_ascii=False))`,path,user,JSON.stringify(data)],{encoding:'utf8',env:{...process.env,QQ_APP_ID:'',QQ_SECRET:''}}));
 return {input:{requestKey:randomBytes(16).toString('hex'),method:'POST' as const,path:'/api/events/listen/finance',data:{...data,preview_token:preview.preview_token}},preview};
 }finally{rmSync(folder,{force:true,recursive:true});}
}
const tx=(kind:string,patch:Record<string,unknown>={})=>({kind,amount:'10.00',occurred_at:'2026-11-16T23:00:00Z',payer_id:a,custodian_id:a,funder_id:b,from_id:a,to_id:b,funding:'payer',merchant:' 原店家 ',reason:' 原依據 ',note:' 原備註 ',...patch});
async function recover(s:Setup,operation:object,user='alice'){
 const old=await original(s,operation,user),before=s.snapshot(),h=user==='alice'?s.alice:s.bob,inspection=await s.send(old.input,'inspect',h);expect(inspection.statusCode,inspection.body).toBe(200);const expected={...old.preview,command:{...old.preview.command,...(old.preview.command.last_seq!==undefined?{last_seq:String(old.preview.command.last_seq)}:{})}};expect(inspection.json()).toMatchObject({state:'retryable',preview:expected});expect(s.snapshot()).toEqual(before);
 const result=await s.send(old.input,'retry',h);expect(result.statusCode,result.body).toBe(200);expect(result.json()).toEqual({committed:true,target:{kind:'activity',id:'listen'}});
 const committed=s.snapshot();expect((await s.send(old.input,'retry',h)).statusCode).toBe(200);expect(s.snapshot()).toEqual(committed);return old.input;
}
describe('exact original finance request recovery',()=>{
 it('differentially previews and executes every original transaction kind with original keys, absent methods and inactive fields',async()=>{
  const s=await setup(),expense=uid(),deposit=uid(),apply=uid(),operations=[
   {command:'record',id:uid(),transaction:tx('collection',{amount:'50',payer_id:b,funding:'ignored original field',merchant:{dormant:true},actual_party_id:null})},
   {command:'record',id:expense,transaction:tx('expense',{amount:'20',funding:'pool'})},
   {command:'record',id:deposit,transaction:tx('deposit',{amount:'10'})},
   {command:'record',id:uid(),transaction:tx('deposit_return',{amount:'2',reference_id:deposit})},
   {command:'record',id:apply,transaction:tx('deposit_apply',{amount:'8',reference_id:deposit,funding:'dormant'})},
   {command:'record',id:uid(),transaction:tx('merchant_refund',{amount:'1',reference_id:apply})},
   {command:'record',id:uid(),transaction:tx('merchant_refund',{amount:'1',reference_id:expense,funding:'pool'})},
   {command:'record',id:uid(),transaction:tx('refund',{amount:'5',payer_id:b,funding:'pool'})},
   {command:'record',id:uid(),transaction:tx('reimbursement',{amount:'2',funding:'pool'})},
   {command:'record',id:uid(),transaction:tx('credit_transfer',{amount:'1',from_id:b,to_id:a})},
   {command:'record',id:uid(),transaction:tx('cash_transfer',{amount:'1'})},
   {command:'record',id:uid(),transaction:tx('refund',{amount:'1',payer_id:b,funder_id:a,funding:'payer'})},
  ];
  for(const operation of operations){const input=await recover(s,operation),row=s.db.prepare('SELECT signature,response_json FROM request_results WHERE user_id=? AND request_key=?').get('alice',input.requestKey) as {signature:string;response_json:string};expect(row.signature).toBe(originalRequestSignature(input.method,input.path,input.data));expect(JSON.parse(row.response_json)).toMatchObject({id:'listen',starts_at:eventRow(s.db,'listen')!.starts_at});}
  expect(financeEntries(s.db,'listen')).toHaveLength(operations.length);
 });
 it('keeps original public custom labels in the signature while ignoring them in operative party names',async()=>{
  const s=await setup(),id='custom:'+uid(),input=await recover(s,{command:'record',id:uid(),transaction:tx('expense',{payer_id:id,custom_parties:[{id,name:' 原人員 ',label:'原人員（本次新增）'}]})});
  expect(financeEntries(s.db,'listen')[0]?.payload.parties).toContainEqual({id,name:'原人員',label:'原人員'});
  const row=s.db.prepare('SELECT signature FROM request_results WHERE request_key=?').get(input.requestKey) as {signature:string};expect(row.signature).toBe(originalRequestSignature(input.method,input.path,input.data));
 });
 it('blocks mismatched or corrupt cached target receipts without acknowledging or repeating money',async()=>{
  const s=await setup(),old=await original(s,{command:'record',id:uid(),transaction:tx('expense')});
  s.db.prepare('INSERT INTO request_results VALUES(?,?,?,?,?,?)').run('alice',old.input.requestKey,originalRequestSignature(old.input.method,old.input.path,old.input.data),JSON.stringify({id:'karaoke',starts_at:'before'}),200,'before');const before=s.snapshot();
  for(const mode of ['inspect','retry'])expect((await s.send(old.input,mode)).statusCode).toBe(409);expect(s.snapshot()).toEqual(before);
  for(const raw of ['{','[]','null']){s.db.prepare('UPDATE request_results SET response_json=? WHERE request_key=?').run(raw,old.input.requestKey);const saved=s.snapshot();for(const mode of ['inspect','retry'])expect((await s.send(old.input,mode)).statusCode).toBe(409);expect(s.snapshot()).toEqual(saved);}
 });
 it('recovers own reports, manager acceptance/rejection, own withdrawal and original reversal reasons without repeating notifications',async()=>{
  const s=await setup();for(const action of ['accept','reject','withdraw']){const id=uid();await recover(s,{command:'report',id,transaction:tx('expense',{payer_id:b,amount:'1'})},'bob');await recover(s,{command:action,report_id:id,reason:action==='reject'?' 原退回原因 ':''},action==='withdraw'?'bob':'alice');}
  const id=uid();await recover(s,{command:'record',id,transaction:tx('expense',{amount:'1'})});await recover(s,{command:'reverse',entry_id:id,reason:' 原沖正依據 '});expect(s.db.prepare('SELECT decision FROM finance_report_actions ORDER BY seq').all()).toEqual([{decision:'accepted'},{decision:'rejected'},{decision:'withdrawn'}]);expect(financeEntries(s.db,'listen').at(-1)?.reversal_of).toBe(id);
 });
 it('recovers original close and reopen with unchanged bill/sequence proof and exactly one group job per transition',async()=>{
  const s=await setup(),detail={input:{custom_payers:[]},collector:{id:a,name:'小青'},total_cents:0,payers:[{id:a,name:'小青',label:'小青',amount_cents:0}],people:[],items:[]};
  s.db.exec("INSERT INTO settlement_history(event_id,version,total_cents,headcount,note,updated_at,actor_id,actor_name,kind,changed_fields) VALUES('listen',1,0,1,'','before','alice','小青','published','[]')");s.db.prepare("INSERT INTO settlement_details VALUES('listen',1,?)").run(JSON.stringify(detail));
  await recover(s,{command:'close',reason:' 原未採用欄位 '});await recover(s,{command:'reopen',reason:' 原重新核對依據 '});expect(financeEntries(s.db,'listen').map(e=>e.kind)).toEqual(['close','reopen']);expect(s.db.prepare("SELECT kind FROM bot_outbox WHERE channel='group' ORDER BY id").all()).toEqual([{kind:'finance_closed'},{kind:'finance_reopened'}]);

  await recover(s,{command:'record',id:uid(),transaction:tx('expense',{payer_id:b,amount:'1',note:'PRIVATE_BUSINESS_DETAIL'})});
  const folder=mkdtempSync(join(tmpdir(),'qgroup-finance-worker-')),path=join(folder,'synthetic.sqlite3');try{await s.db.backup(path);const result=JSON.parse(execFileSync('python3',['-c',`import datetime,json,sqlite3,sys
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
print(json.dumps(dict(first=first,second=second,calls=api.post.call_count,rows=[dict(r) for r in db.execute('SELECT kind,channel,status,payload_json FROM bot_outbox ORDER BY id')])))`,path],{encoding:'utf8',env:{...process.env,QQBOT_APP_ID:'',QQBOT_APP_SECRET:'',KANBAN_BOT_ENV:'',KANBAN_BOT_BASE_URL:origin}}));expect(result.first).toMatchObject({sent:2,failed:0});expect(result.second.claimed).toBe(0);expect(result.calls).toBe(2);const groups=result.rows.filter((r:{channel:string})=>r.channel==='group');expect(groups.map((r:{kind:string;status:string})=>[r.kind,r.status])).toEqual([['finance_closed','sent'],['finance_reopened','sent']]);expect(JSON.stringify(result.rows)).not.toContain('PRIVATE_BUSINESS_DETAIL');const personal=result.rows.filter((r:{channel:string})=>r.channel==='private');expect(personal).toHaveLength(1);expect(JSON.parse(personal[0].payload_json).text).toBe('款项记录有更新\n'+origin+'/?event=listen');}finally{rmSync(folder,{force:true,recursive:true});} });
 it('returns existing matching original receipts read-only even after revisions advance, without exposing cached private snapshots',async()=>{
  const s=await setup(),old=await original(s,{command:'record',id:uid(),transaction:tx('expense')}),response={id:'listen',starts_at:'before',private_note:'original owner secret',participants:[{user_id:'private'}]};
  s.db.prepare('INSERT INTO request_results VALUES(?,?,?,?,?,?)').run('alice',old.input.requestKey,originalRequestSignature(old.input.method,old.input.path,old.input.data),JSON.stringify(response),200,'before');s.db.exec("UPDATE events SET revision=revision+1 WHERE id='listen'");const before=s.snapshot();
  for(const mode of ['inspect','retry']){const result=await s.send(old.input,mode);expect(result.statusCode).toBe(200);expect(result.body).not.toMatch(/original owner secret|participants/);}expect(s.snapshot()).toEqual(before);
 });
 it('serializes concurrent retries, binds complete original bytes and prevents native receipts sharing an old key',async()=>{
  const s=await setup(),old=await original(s,{command:'record',id:uid(),transaction:tx('expense')}),race=await Promise.all([s.send(old.input,'retry'),s.send(old.input,'retry')]);expect(race.map(r=>r.statusCode)).toEqual([200,200]);expect(financeEntries(s.db,'listen')).toHaveLength(1);const before=s.snapshot();
  const changed={...old.input,data:{...old.input.data,transaction:{...tx('expense'),note:'changed'}}};expect((await s.send(changed,'retry')).statusCode).toBe(409);expect(s.snapshot()).toEqual(before);
  s.db.prepare('UPDATE request_results SET signature=? WHERE request_key=?').run('finance:native-v2',old.input.requestKey);expect((await s.send(old.input,'retry')).statusCode).toBe(409);
 });
 it('never replaces stale revisions or tokens, already-used money IDs or unknown original fields with new commands',async()=>{
  const s=await setup(),operation={command:'record',id:uid(),transaction:tx('expense')},old=await original(s,operation),before=s.snapshot();
  for(const patch of [{data:{...old.input.data,base_revision:999}},{data:{...old.input.data,preview_token:'0'.repeat(64)}},{data:{...old.input.data,future_rule:true}},{path:'/api/events/listen/settlement/detailed'},{method:'PUT'}])expect((await s.send({...old.input,...patch},'retry')).statusCode).toBeGreaterThanOrEqual(400);expect(s.snapshot()).toEqual(before);
  await recover(s,operation);const after=s.snapshot();expect((await s.send({...old.input,requestKey:uid()},'retry')).statusCode).toBe(409);expect(s.snapshot()).toEqual(after);
 });
 it('enforces current permissions, report ownership, session scope, origin and CSRF on both preparation and cached recovery',async()=>{
  const s=await setup(),old=await original(s,{command:'record',id:uid(),transaction:tx('expense')}),before=s.snapshot();
  for(const h of [s.bob,{...s.alice,origin:'https://elsewhere.example'},{...s.alice,'x-csrf-token':'invalid'},{...s.alice,'x-account-scope':s.bob['x-account-scope']},{...s.alice,cookie:''}])for(const mode of ['inspect','retry'])expect((await s.send(old.input,mode,h)).statusCode).toBeGreaterThanOrEqual(400);expect(s.snapshot()).toEqual(before);
  expect((await s.send(old.input,'retry')).statusCode).toBe(200);s.db.exec("UPDATE events SET owner_id='bob' WHERE id='listen'");const committed=s.snapshot();for(const mode of ['inspect','retry'])expect((await s.send(old.input,mode)).statusCode).toBe(403);expect(s.snapshot()).toEqual(committed);
 });
 it('receipt insertion failure rolls back ledger, audit, notifications, bot work and the original result together',async()=>{
  const s=await setup(),old=await original(s,{command:'record',id:uid(),transaction:tx('collection',{payer_id:b})});s.db.exec("CREATE TRIGGER reject_original_receipt BEFORE INSERT ON request_results BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END");const before=s.snapshot();expect((await s.send(old.input,'retry')).statusCode).toBe(500);expect(s.snapshot()).toEqual(before);s.db.exec('DROP TRIGGER reject_original_receipt');expect((await s.send(old.input,'retry')).statusCode).toBe(200);expect(financeEntries(s.db,'listen')).toHaveLength(1);
 });
 it('requires explicit confirmation for mutation and rejects active invalid fields while accepting original inactive known fields',async()=>{
  const s=await setup(),old=await original(s,{command:'record',id:uid(),transaction:tx('expense')}),before=s.snapshot();const raw=await s.app.inject({method:'POST',url:'/api/v2/me/legacy-requests/finance/retry',headers:s.alice,payload:old.input});expect(raw.statusCode).toBe(400);expect(s.snapshot()).toEqual(before);
  expect(()=>decodeLegacyFinance({...old.input,data:{...old.input.data,transaction:tx('expense',{funding:'wrong'})}})).toThrow();expect(()=>decodeLegacyFinance({...old.input,data:{...old.input.data,transaction:tx('expense',{future_amount:'20'})}})).toThrow();
 });
});
