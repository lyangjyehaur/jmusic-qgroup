import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach,describe,expect,it } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { BotDeliveries,BotDeliveryReview } from '@qgroup/contracts';
import { defaultBotPolicy } from '@qgroup/domain';
import { createApp,hash } from './app';
import { fixture } from '../testsupport/fixture';
import { timePollFixture } from '../testsupport/time-poll-fixture';
import { createActivityBot } from './activity-bot';
import { eventRow } from './activity-arrangements';
import { BotOutboxWorker } from '../../bot/src/outbox';
import { loadBotConfig } from '../../bot/src/config';
import { attachPaymentCodes } from './payment-codes';
import { imageDigest } from './payment-media';
import { testPNG } from '../testsupport/payment-fixture';
const origin='https://rebuild.example',stamp='2026-11-18T10:00:00+00:00',cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function setup(fileBacked=false){
  const folder=fileBacked?mkdtempSync(join(tmpdir(),'qgroup-delivery-images-')):null;if(folder)cleanup.push(async()=>rmSync(folder,{recursive:true,force:true}));
  const db=openDatabase(folder?join(folder,'synthetic.sqlite3'):':memory:');fixture(db);timePollFixture(db);db.exec("UPDATE events SET bot_enabled=1; INSERT INTO user_admin_roles VALUES('alice',1,1,'synthetic')");
  db.prepare('UPDATE bot_settings SET config_json=?').run(JSON.stringify(defaultBotPolicy({enabled:true,dry_run:false,groups:[{id:'synthetic-group',name:'合成群',replies:true,broadcast:true}]})));
  const app=createApp({db,origin,now:()=>new Date(stamp),activityBot:{baseURL:'https://example.test'}});await app.ready();cleanup.push(async()=>{await app.close();db.close();});
  async function headers(user='alice'){const cookie='kanban_session=fixture-'+user,viewer=(await app.inject({url:'/api/v2/session',headers:{cookie}})).json();return {cookie,origin,'x-account-scope':viewer.scope,'x-csrf-token':viewer.csrf};}
  const alice=await headers(),bob=await headers('bob'),access=(await app.inject({url:'/api/v2/admin/session',headers:alice})).json(),admin={...alice,'x-admin-csrf':access.adminCsrf};
  const insert=(patch:Record<string,unknown>={})=>{
    const row={event_id:'listen',poll_id:null,kind:'activity_published',dedupe_key:randomUUID(),target:'synthetic-group',payload_json:JSON.stringify({text:'原群通知',private_secret:'NEVER EXPOSE RAW PAYLOAD'}),status:'failed',created_at:'before',...patch};
    return (db.prepare(`INSERT INTO bot_outbox(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')}) RETURNING CAST(id AS TEXT) id`).get(...Object.values(row)) as {id:string}).id;
  };
  const base=(entity='activities',id='listen')=>`/api/v2/${entity}/${id}/bot-deliveries`;
  const get=(url:string,h=alice)=>app.inject({url,headers:h});
  const review=async(id:string,root=base(),h=alice)=>BotDeliveryReview.parse((await get(root+'/'+id,h)).json());
  const post=(id:string,token:string,key=randomUUID(),root=base(),h=alice)=>app.inject({method:'POST',url:root+'/'+id+'/retry',headers:{...h,'idempotency-key':key},payload:{reviewToken:token,confirm:true}});
  const policy=(patch:object)=>{const row=db.prepare('SELECT config_json FROM bot_settings').get() as {config_json:string};db.prepare('UPDATE bot_settings SET revision=revision+1,config_json=?').run(JSON.stringify({...JSON.parse(row.config_json),...patch}));};
  return {db,app,alice,bob,admin,headers,insert,base,get,review,post,policy};
}
describe('bot delivery administration and explicit retry',()=>{
  it('lists only group metadata with numeric cursor/filtering, keeps large IDs exact and exposes no arbitrary payload or claim secrets',async()=>{
    const s=await setup();for(let i=0;i<53;i++)s.insert({status:i%2?'sent':'failed'});s.insert({channel:'private',recipient_user_id:'bob',payload_json:'{"text":"PRIVATE TEXT"}'});
    const large=s.insert({id:9007199254740995n,claim_token:'PRIVATE CLAIM',last_error:'code=1 https://private.test/?invite_token=SECRET Bearer SECRET',status:'failed'});
    const response=await s.get('/api/v2/admin/bot/deliveries',s.admin),page=BotDeliveries.parse(response.json());expect(page.entries).toHaveLength(50);expect(page.entries[0]!.id).toBe(large);expect(page.nextBefore).not.toBeNull();expect(response.headers['cache-control']).toBe('no-store');
    const rest=BotDeliveries.parse((await s.get('/api/v2/admin/bot/deliveries?before='+page.nextBefore,s.admin)).json());expect(rest.entries).toHaveLength(4);expect(new Set([...page.entries,...rest.entries].map(r=>r.id)).size).toBe(54);
    const filtered=BotDeliveries.parse((await s.get('/api/v2/admin/bot/deliveries?status=sent&kind=activity_published',s.admin)).json());expect(filtered.entries).toHaveLength(26);expect(filtered.entries.every(r=>r.status==='sent')).toBe(true);
    expect(response.body).not.toMatch(/PRIVATE|NEVER EXPOSE|SECRET|payload_json|claim_token|recipient_user/);
    const detail=await s.get('/api/v2/admin/bot/deliveries/'+large,s.admin);expect(detail.json().reviewToken).toBeNull();expect(detail.body).not.toContain('PRIVATE CLAIM');
    expect((await s.get('/api/v2/admin/bot/deliveries?before=1 OR 1=1',s.admin)).statusCode).toBe(400);
  });
  it('enforces owner/settlement scopes independently from site admin and rechecks revoked permissions for receipt recovery',async()=>{
    const s=await setup(),one=s.insert(),settlement=s.insert({kind:'settlement_updated'});
    expect((await s.get(s.base(),s.bob)).statusCode).toBe(403);expect((await s.get('/api/v2/admin/bot/deliveries',s.bob)).statusCode).toBe(403);
    s.db.exec("INSERT INTO user_admin_roles VALUES('bob',1,1,'synthetic')");expect((await s.get('/api/v2/admin/bot/deliveries',s.bob)).statusCode).toBe(200);expect((await s.get(s.base(),s.bob)).statusCode).toBe(403);
    s.db.prepare("INSERT INTO event_roles(event_id,user_id,permissions_json,created_at) VALUES('listen','bob',?,'before')").run('["settlement"]');
    const list=BotDeliveries.parse((await s.get(s.base(),s.bob)).json());expect(list.entries.map(r=>r.id)).toEqual([settlement]);expect((await s.get(s.base()+'/'+one,s.bob)).statusCode).toBe(403);
    const checked=await s.review(settlement,s.base(),s.bob),key=randomUUID();expect((await s.post(settlement,checked.reviewToken!,key,s.base(),s.bob)).statusCode).toBe(200);
    s.db.exec("DELETE FROM event_roles WHERE user_id='bob'");expect((await s.get('/api/v2/bot-delivery-results/'+key,s.bob)).statusCode).toBe(403);
  });
  it('creates an immutable new intent without replaying business, returns exact receipts and consumes only the new work',async()=>{
    const s=await setup(),id=s.insert(),before=s.db.prepare('SELECT * FROM bot_outbox').get(),people=s.db.prepare('SELECT * FROM attendees').all(),finances=s.db.prepare('SELECT * FROM finance_entries').all(),checked=await s.review(id),key=randomUUID();
    expect(checked.preparedText).toBe('原群通知');expect(checked).not.toHaveProperty('private_secret');
    const sent=await s.post(id,checked.reviewToken!,key);expect(sent.statusCode,sent.body).toBe(200);const result=sent.json();expect(result.originalId).toBe(id);expect(result.queuedId).not.toBe(id);
    expect(s.db.prepare('SELECT * FROM bot_outbox WHERE id=?').get(id)).toEqual(before);expect(s.db.prepare('SELECT * FROM attendees').all()).toEqual(people);expect(s.db.prepare('SELECT * FROM finance_entries').all()).toEqual(finances);
    const clone=s.db.prepare('SELECT status,attempts,payload_json,target,due_at FROM bot_outbox WHERE id=?').get(result.queuedId);expect(clone).toEqual({status:'pending',attempts:0,payload_json:(before as {payload_json:string}).payload_json,target:'synthetic-group',due_at:null});
    expect((await s.post(id,checked.reviewToken!,key)).json()).toEqual(result);expect((await s.post(id,'b'.repeat(64),key)).statusCode).toBe(409);expect((await s.get('/api/v2/bot-delivery-results/'+key)).json()).toEqual({state:'completed',result});expect((await s.get('/api/v2/bot-delivery-results/'+key,s.bob)).json()).toEqual({state:'not_found'});
    let posts=0;const config={...loadBotConfig({KANBAN_BOT_DRY_RUN:'0'}),group:'synthetic-group'},worker=new BotOutboxWorker(s.db,config,{post:async()=>{posts++;return {ok:true,code:null,data:{id:'synthetic'},status:200,kind:'ok',platformTrace:null};}},{now:()=>new Date(stamp)});
    await worker.pollOnce();expect(posts).toBe(1);expect((s.db.prepare('SELECT status FROM bot_outbox WHERE id=?').get(id) as {status:string}).status).toBe('failed');expect((s.db.prepare('SELECT status FROM bot_outbox WHERE id=?').get(result.queuedId) as {status:string}).status).toBe('sent');
  });
  it('never replays a simulation on mode switch; only an explicit new reviewed intent can send',async()=>{
    const s=await setup();s.policy({dry_run:true});const id=s.insert({status:'skipped',last_error:'dry-run',simulated_at:'before',delivered_payload_json:JSON.stringify({_group_ref:hash('synthetic-group').slice(0,20),content:'模擬內容'})}),before=s.db.prepare('SELECT * FROM bot_outbox').get();
    const checked=await s.review(id);s.policy({dry_run:false});expect((await s.post(id,checked.reviewToken!)).json().code).toBe('BOT_DELIVERY_CHANGED');expect(s.db.prepare('SELECT * FROM bot_outbox').all()).toEqual([before]);
    const current=await s.review(id);expect((await s.post(id,current.reviewToken!)).statusCode).toBe(200);expect(s.db.prepare('SELECT * FROM bot_outbox WHERE id=?').get(id)).toEqual(before);
  });
  it('blocks sent, active, uncertain, invalidated and private rows without rewriting their state',async()=>{
    const s=await setup();
    for(const patch of [{status:'sent',sent_at:'before'},{status:'pending'},{status:'sending'},{status:'skipped',last_error:'平台返回异步结果，未确认送出，需人工核对'},{status:'failed',last_error:'unconfirmed'},{status:'skipped',last_error:'关闭群同步'}]){
      const id=s.insert(patch),before=s.db.prepare('SELECT * FROM bot_outbox WHERE id=?').get(id),checked=await s.review(id);expect(checked.blocker).not.toBeNull();expect(checked.reviewToken).toBeNull();expect((await s.post(id,'a'.repeat(64))).statusCode).toBe(409);expect(s.db.prepare('SELECT * FROM bot_outbox WHERE id=?').get(id)).toEqual(before);
    }
    const id=s.insert({channel:'private'});expect((await s.get(s.base()+'/'+id)).statusCode).toBe(404);expect((await s.post(id,'a'.repeat(64))).statusCode).toBe(404);
  });
  it('rejects stale row/entity/policy reviews, changed groups, malformed payloads and disabled kinds',async()=>{
    const s=await setup(),id=s.insert();const first=await s.review(id);s.db.exec('UPDATE events SET revision=revision+1');expect((await s.post(id,first.reviewToken!)).json().code).toBe('BOT_DELIVERY_CHANGED');
    const next=await s.review(id);s.db.exec("UPDATE bot_outbox SET attempts=1 WHERE status='failed'");expect((await s.post(id,next.reviewToken!)).statusCode).toBe(409);
    s.policy({enabled:false});expect((await s.review(id)).blocker).toContain('关闭');s.policy({enabled:true,groups:[]});expect((await s.review(id)).blocker).toContain('目标群');s.policy({groups:[{id:'other',name:'',replies:true,broadcast:true}]});expect((await s.review(id)).blocker).toContain('目标群');
    const inherited=s.insert({target:'',status:'skipped',last_error:'dry-run',delivered_payload_json:JSON.stringify({_group_ref:hash('synthetic-group').slice(0,20)})});expect((await s.review(inherited)).blocker).toContain('目標群');
    expect((await s.review(s.insert({payload_json:'bad'}))).blocker).toContain('無法驗證');expect((await s.get(s.base()+'/'+id,s.bob)).statusCode).toBe(403);
    expect((await s.post(id,'a'.repeat(64),randomUUID(),s.base(),{...s.alice,origin:'https://evil.test'})).statusCode).toBe(403);
  });
  it('retries only a still-current reminder plan and preserves its original due date',async()=>{
    const s=await setup(),bot=createActivityBot(s.db,()=>new Date(stamp));bot.schedule(eventRow(s.db,'listen')!);
    const original=s.db.prepare("SELECT CAST(id AS TEXT) id,due_at FROM bot_outbox WHERE event_id='listen' AND kind='deadline_reminder'").get() as {id:string;due_at:string};s.db.exec("UPDATE bot_outbox SET status='failed'");
    const checked=await s.review(original.id);expect(checked.blocker).toBeNull();const response=await s.post(original.id,checked.reviewToken!);expect(response.statusCode,response.body).toBe(200);expect(s.db.prepare('SELECT due_at FROM bot_outbox WHERE id=?').get(response.json().queuedId)).toEqual({due_at:original.due_at});
    s.db.exec("UPDATE bot_outbox SET status='failed'; UPDATE events SET deadline='2099-12-10T05:00:00+00:00' WHERE id='listen'");expect((await s.review(original.id)).blocker).toContain('旧提醒');
    s.db.exec("UPDATE events SET archived_at='before' WHERE id='listen'");expect((await s.review(original.id)).blocker).toContain('歸檔');
  });
  it('rebuilds poll retries with current valid candidates and never re-executes voting/finalization',async()=>{
    const s=await setup(),root=s.base('time-polls','poll-exact'),id=s.insert({event_id:null,poll_id:'poll-exact',kind:'time_poll_published'}),votes=s.db.prepare('SELECT * FROM time_poll_votes').all();
    const checked=await s.review(id,root);expect(checked.preparedText).toContain('共 2 个候选');expect(checked.preparedText).not.toContain('2020-01-01');
    const response=await s.post(id,checked.reviewToken!,randomUUID(),root);expect(response.statusCode,response.body).toBe(200);expect(s.db.prepare('SELECT * FROM time_poll_votes').all()).toEqual(votes);expect(s.db.prepare('SELECT count(*) n FROM events').get()).toEqual({n:6});
    expect((await s.review(id,root)).blocker).toContain('待送');s.db.exec("UPDATE bot_outbox SET status='failed'; UPDATE time_polls SET status='closed' WHERE id='poll-exact'");expect((await s.review(id,root)).blocker).toContain('投票');expect((await s.get(root,s.bob)).statusCode).toBe(403);
  });
  it('rolls back a new delivery and receipt if its required audit fails',async()=>{
    const s=await setup(),id=s.insert(),checked=await s.review(id),key=randomUUID();s.db.exec("CREATE TRIGGER synthetic_audit_failure BEFORE INSERT ON event_audit BEGIN SELECT RAISE(ABORT,'synthetic');END;");
    expect((await s.post(id,checked.reviewToken!,key)).statusCode).toBe(500);expect(s.db.prepare('SELECT count(*) n FROM bot_outbox').get()).toEqual({n:1});expect((await s.get('/api/v2/bot-delivery-results/'+key)).json()).toEqual({state:'not_found'});
  });
  it('invalidates the review when regenerated poll content changes without a parent-row revision',async()=>{
    const s=await setup(),root=s.base('time-polls','poll-exact'),id=s.insert({event_id:null,poll_id:'poll-exact',kind:'time_poll_published'}),checked=await s.review(id,root);
    s.db.exec("UPDATE time_poll_options SET starts_at='2099-12-15T00:00:00+00:00' WHERE id='poll-exact-1'");
    const response=await s.post(id,checked.reviewToken!,randomUUID(),root);expect(response.statusCode).toBe(409);expect(response.json().code).toBe('BOT_DELIVERY_CHANGED');expect(s.db.prepare('SELECT count(*) n FROM bot_outbox').get()).toEqual({n:1});
  });
  it('requires the current settlement version, frozen code and publisher authority at retry confirmation',async()=>{
    const s=await setup(true),raw=testPNG(),image={kind:'wechat' as const,name:'微信',digest:imageDigest(raw)};
    s.db.exec("INSERT INTO event_roles(event_id,user_id,permissions_json,created_at) VALUES('listen','bob','[\"settlement\"]','before'); INSERT INTO settlement_history(event_id,version,total_cents,headcount,note,updated_at,actor_id,actor_name,kind,changed_fields) VALUES('listen',1,100,1,'','before','bob','收款人','detailed_published','[]'); INSERT INTO settlement_details VALUES('listen',1,'{\"group_notice\":true}')");
    attachPaymentCodes(s.db,'listen',1,[{meta:image,raw}],new Date(stamp));
    const id=s.insert({kind:'settlement_updated',payload_json:JSON.stringify({msg_type:7,_settlement_version:1,_settlement_image:image})}),checked=await s.review(id),before=s.db.prepare('SELECT * FROM bot_outbox WHERE id=?').get(id);
    expect(checked.imageName).toBe('微信');expect(checked.blocker).toBeNull();
    s.db.exec("DELETE FROM event_roles WHERE user_id='bob'");expect((await s.post(id,checked.reviewToken!)).json().message).toContain('权限已撤销');
    s.db.exec("INSERT INTO event_roles(event_id,user_id,permissions_json,created_at) VALUES('listen','bob','[\"settlement\"]','before')");
    const mismatch=s.insert({kind:'settlement_updated',payload_json:JSON.stringify({msg_type:7,_settlement_version:1,_settlement_image:{...image,digest:'a'.repeat(64)}})});expect((await s.review(mismatch)).blocker).toContain('收款码');
    const success=await s.post(id,(await s.review(id,s.base(),s.bob)).reviewToken!,randomUUID(),s.base(),s.bob);expect(success.statusCode,success.body).toBe(200);expect(s.db.prepare('SELECT payload_json FROM bot_outbox WHERE id=?').get(success.json().queuedId)).toEqual({payload_json:(before as {payload_json:string}).payload_json});
    s.db.exec("UPDATE bot_outbox SET status='failed'; INSERT INTO settlement_history(event_id,version,total_cents,headcount,note,updated_at,actor_id,actor_name,kind,changed_fields) VALUES('listen',2,200,1,'','before','alice','收款人','detailed_edited','[]')");
    expect((await s.review(id)).blocker).toContain('旧版通知作废');expect(s.db.prepare('SELECT * FROM bot_outbox WHERE id=?').get(id)).toEqual(before);
  });
  it('keeps the legacy poll retry endpoint compatible while blocking sent and uncertain outcomes',async()=>{
    const s=await setup(),id=s.insert({event_id:null,poll_id:'poll-exact',kind:'time_poll_published'});
    for(const patch of [{status:'failed',last_error:'unconfirmed',sent_at:null},{status:'sent',last_error:'dry-run',sent_at:'before'},{status:'sending',last_error:'dry-run',sent_at:null}]){
      s.db.prepare('UPDATE bot_outbox SET status=?,last_error=?,sent_at=? WHERE id=?').run(patch.status,patch.last_error,patch.sent_at,id);
      const revision=(s.db.prepare("SELECT revision FROM time_polls WHERE id='poll-exact'").get() as {revision:number}).revision;
      const response=await s.app.inject({method:'POST',url:'/api/v2/time-polls/poll-exact/manage',headers:{...s.alice,'idempotency-key':randomUUID()},payload:{action:'bot_retry',revision,outbox_id:Number(id),reason:'',confirm:true}});expect(response.statusCode,response.body).toBe(409);
    }
    expect(s.db.prepare('SELECT count(*) n FROM bot_outbox').get()).toEqual({n:1});
  });
  it('lets the retained Python consumer deliver native retry rows identically without replaying business records',async()=>{
    const s=await setup(),event=s.insert(),poll=s.insert({event_id:null,poll_id:'poll-exact',kind:'time_poll_published'});
    expect((await s.post(event,(await s.review(event)).reviewToken!)).statusCode).toBe(200);
    const root=s.base('time-polls','poll-exact');expect((await s.post(poll,(await s.review(poll,root)).reviewToken!,randomUUID(),root)).statusCode).toBe(200);
    const folder=mkdtempSync(join(tmpdir(),'qgroup-retry-python-')),path=join(folder,'synthetic.sqlite3');cleanup.push(async()=>rmSync(folder,{recursive:true,force:true}));await s.db.backup(path);
    const expected=JSON.parse(execFileSync('python3',['-c',`import datetime,json,sqlite3,sys
from pathlib import Path
from types import SimpleNamespace
from qgroup_bot import worker
from qgroup_core import bot_outbox,time_polls
stamp=sys.argv[2]
class Frozen(datetime.datetime):
 @classmethod
 def now(cls,tz=None):return datetime.datetime.fromisoformat(stamp).astimezone(tz)
worker.datetime=Frozen;bot_outbox.datetime=Frozen;worker.now=lambda:stamp;bot_outbox.now=lambda:stamp;time_polls.now=lambda:stamp;worker.obs.event=lambda *a,**kw:None
calls=[]
class API:
 def post(self,path,body):
  calls.append(dict(path=path,body=body));return True,0,dict(id='synthetic')
config=SimpleNamespace(db=Path(sys.argv[1]),group='synthetic-group',dry_run=False,claim_timeout=600,batch=10,max_attempts=5,markdown_replies=False,allowed_link_hosts=('example.test',),log_dir=Path(sys.argv[1]).parent/'logs',log_content=False)
summary=worker.OutboxWorker(config,API()).poll_once()
db=sqlite3.connect(sys.argv[1]);db.row_factory=sqlite3.Row
print(json.dumps(dict(summary=summary,calls=calls,rows=[dict(r) for r in db.execute('SELECT id,status,attempts,last_error,sent_at,delivered_payload_json FROM bot_outbox ORDER BY id')],people=[dict(r) for r in db.execute('SELECT * FROM attendees')],votes=[dict(r) for r in db.execute('SELECT * FROM time_poll_votes')],finance=[dict(r) for r in db.execute('SELECT * FROM finance_entries')])))`,path,stamp],{encoding:'utf8',env:{PATH:process.env.PATH,PYTHONPATH:process.cwd(),KANBAN_BOT_BASE_URL:'https://example.test'},timeout:10000}));
    const calls:{path:string;body:unknown}[]=[],config={...loadBotConfig({KANBAN_BOT_DRY_RUN:'0',KANBAN_BOT_BASE_URL:'https://example.test',KANBAN_BOT_ALLOWED_HOSTS:'example.test'}),group:'synthetic-group'},worker=new BotOutboxWorker(s.db,config,{post:async(path,body)=>{calls.push({path,body});return {ok:true,code:0,data:{id:'synthetic'},status:200,kind:'ok',platformTrace:null};}},{now:()=>new Date(stamp),composition:{baseURL:'https://example.test',keyboard:false}});
    expect(await worker.pollOnce(),JSON.stringify(expected)).toEqual(expected.summary);expect(calls).toEqual(expected.calls);expect(calls).toHaveLength(2);
    const normalize=(rows:{delivered_payload_json:string|null}[])=>rows.map(row=>({...row,delivered_payload_json:row.delivered_payload_json?JSON.parse(row.delivered_payload_json):null}));
    expect(normalize(s.db.prepare('SELECT id,status,attempts,last_error,sent_at,delivered_payload_json FROM bot_outbox ORDER BY id').all() as {delivered_payload_json:string|null}[])).toEqual(normalize(expected.rows));
    expect(s.db.prepare('SELECT * FROM attendees').all()).toEqual(expected.people);expect(s.db.prepare('SELECT * FROM time_poll_votes').all()).toEqual(expected.votes);expect(s.db.prepare('SELECT * FROM finance_entries').all()).toEqual(expected.finance);
  });
});
