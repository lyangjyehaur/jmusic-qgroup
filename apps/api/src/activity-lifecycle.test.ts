import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { ActivityLifecycle } from '@qgroup/contracts';
import { fixture } from '../testsupport/fixture';
import { nicknameFixture } from '../testsupport/nickname-fixture';
import { createApp } from './app';
import { eventRow } from './activity-arrangements';
import { createActivityBot } from './activity-bot';
const stamp='2026-11-17T00:00:00+00:00',origin='https://rebuild.example';
const cleanups:(()=>Promise<unknown>)[]=[];afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();});
async function setup(cleanRemoval=false){
  const db=openDatabase(':memory:');fixture(db);if(!cleanRemoval)nicknameFixture(db);else db.exec("UPDATE events SET bot_enabled=1 WHERE id='listen'; INSERT INTO attendees(id,event_id,manager_id,user_id,name,payer_kind,status,created_at,updated_at) VALUES('self-listen','listen','alice','alice','小青','self','confirmed','before','before')");
  db.exec("DELETE FROM settlements; DELETE FROM bot_outbox; UPDATE events SET starts_at='2026-11-20T10:00:00+00:00',deadline='2026-11-19T10:00:00+00:00',revision=7,capacity=1,minimum_participants=3 WHERE id='listen'");
  db.prepare('UPDATE bot_settings SET config_json=?').run(JSON.stringify({enabled:true,groups:[{id:'synthetic-group',name:'測試',replies:true,broadcast:true}]}));
  const defaults={enabled:true,baseURL:origin,keyboard:true,personalQueue:true};
  createActivityBot(db,()=>new Date(stamp),defaults).schedule(eventRow(db,'listen')!);
  const app=createApp({db,origin,now:()=>new Date(stamp),activityBot:defaults});await app.ready();cleanups.push(async()=>{await app.close();db.close();});
  async function headers(user:string){const cookie='kanban_session=fixture-'+user,session=(await app.inject({url:'/api/v2/session',headers:{cookie}})).json();return {cookie,origin,'x-account-scope':session.scope,'x-csrf-token':session.csrf};}
  const alice=await headers('alice'),bob=await headers('bob');
  const change=(action:string,reason='',h=alice,key=randomUUID(),revision=eventRow(db,'listen')!.revision)=>app.inject({method:'POST',url:'/api/v2/activities/listen/lifecycle',headers:{...h,'idempotency-key':key},payload:{revision,action,reason,confirm:true}});
  return {db,app,alice,bob,change};
}
const tables=['events','attendees','roster_parties','attendee_consents','event_audit','notifications','bot_outbox','finance_entries'];
function state(db:ReturnType<typeof openDatabase>){return Object.fromEntries(tables.map(table=>[table,db.prepare('SELECT * FROM '+table+" WHERE "+(table==='events'?'id':'event_id')+"='listen' ORDER BY rowid").all().map(raw=>Object.fromEntries(Object.entries(raw as Record<string,unknown>).map(([key,value])=>[key,key.endsWith('_json')&&typeof value==='string'?JSON.parse(value):value])))]));}
async function differential(s:Awaited<ReturnType<typeof setup>>,actions:string[],run:()=>Promise<unknown>){
  const folder=mkdtempSync(join(tmpdir(),'qgroup-lifecycle-diff-')),path=join(folder,'synthetic.sqlite3');
  try{
    await s.db.backup(path);
    const expected=JSON.parse(execFileSync('python3',['-c',`import datetime,json,sqlite3,sys
from qgroup_core import events,conditions,roster,audit,bot_outbox,bot_settings,bot_views,lifecycle
db=sqlite3.connect(sys.argv[1]);db.row_factory=sqlite3.Row
for module in (events,conditions,roster,audit,bot_outbox,bot_settings,bot_views,lifecycle):module.now=lambda:'${stamp}'
class Frozen(datetime.datetime):
 @classmethod
 def now(cls,tz=None):return datetime.datetime.fromisoformat('${stamp}').astimezone(tz)
bot_outbox.datetime=Frozen
user=db.execute("SELECT * FROM users WHERE id='alice'").fetchone()
for action in ${JSON.stringify(actions)}:
 event=db.execute("SELECT * FROM events WHERE id='listen'").fetchone()
 events.patch(db,event,user,dict(action=action,reason='測試狀態原因',base_revision=event['revision']))
result={}
for table in ${JSON.stringify(tables)}:
 rows=[dict(row) for row in db.execute('SELECT * FROM '+table+' WHERE '+('id' if table=='events' else 'event_id')+"='listen' ORDER BY rowid")]
 for row in rows:
  for key in row:
   if key.endswith('_json') and isinstance(row[key],str):row[key]=json.loads(row[key])
 result[table]=rows
print(json.dumps(result))`,path],{encoding:'utf8',env:{...process.env,KANBAN_BOT_BASE_URL:origin,KANBAN_BOT_PERSONAL_QUEUE:'1',KANBAN_BOT_KEYBOARD:'1'}}));
    await run();expect(state(s.db)).toEqual(expected);
  }finally{rmSync(folder,{recursive:true,force:true});}
}
describe('explicit activity lifecycle with legacy bot compatibility',()=>{
  it.each([{actions:['pause','resume','formation','start','finish','archive','unarchive','cancel']},{actions:['finish','cancel','archive','unarchive']},{actions:['pause','resume']}])('matches original Python event, roster, finance, notice, audit and complete outbox for $actions',async({actions})=>{
    const s=await setup();
    await differential(s,actions,async()=>{for(const action of actions)expect((await s.change(action,'測試狀態原因')).statusCode).toBe(200);});
  });
  it('resumes strict FIFO only while actual registration is open, and emits one final promotion card',async()=>{
    const s=await setup();s.db.exec("UPDATE events SET registration_open=0,status='closed',capacity=2 WHERE id='listen'");
    await differential(s,['resume'],async()=>expect((await s.change('resume','測試狀態原因')).statusCode).toBe(200));
    expect(s.db.prepare("SELECT status FROM attendees WHERE id='managed-listen'").get()).toEqual({status:'confirmed'});
    expect(s.db.prepare("SELECT count(*) AS n FROM bot_outbox WHERE kind='registration_changed'").get()).toEqual({n:1});
  });
  it('does not let site administrators, roster helpers, unscoped cookies or invite outsiders operate',async()=>{
    const s=await setup();s.db.exec("INSERT INTO user_admin_roles VALUES('bob',1,1,'before'); INSERT INTO event_roles VALUES('helper','listen','bob','[\"roster\"]','before')");
    expect((await s.change('start','',s.bob)).statusCode).toBe(403);s.db.exec("UPDATE event_roles SET permissions_json='[\"schedule\"]' WHERE id='helper'");
    for(const action of ['formation','cancel','archive','unarchive','remove'])expect((await s.change(action,'原因',s.bob)).statusCode).toBe(403);
    expect((await s.change('start','',s.bob)).statusCode).toBe(200);
    expect((await s.app.inject({url:'/api/v2/activities/listen/lifecycle',headers:{cookie:s.alice.cookie}})).statusCode).toBe(409);
    s.db.exec("UPDATE events SET visibility='invitation' WHERE id='listen'");expect((await s.change('finish','',s.bob)).statusCode).toBe(404);
  });
  it('checks revisions, explicit confirmation, minimum reasons, deadlines and actual states without a blanket settlement lock',async()=>{
    const s=await setup();expect((await s.change('start','',s.alice,randomUUID(),0)).statusCode).toBe(409);
    expect((await s.app.inject({method:'POST',url:'/api/v2/activities/listen/lifecycle',headers:{...s.alice,'idempotency-key':randomUUID()},payload:{revision:7,action:'start'}})).statusCode).toBe(400);
    expect((await s.change('formation')).statusCode).toBe(400);expect((await s.change('cancel')).statusCode).toBe(400);
    s.db.exec("UPDATE events SET starts_at='2026-11-16T00:00:00+00:00',deadline='2026-11-15T00:00:00+00:00' WHERE id='listen'");
    const read=ActivityLifecycle.parse((await s.app.inject({url:'/api/v2/activities/listen/lifecycle',headers:s.alice})).json());expect(read.lifecycle).toBe('scheduled');expect(read.actualStartedAt).toBeNull();expect((await s.change('resume')).statusCode).toBe(409);
    s.db.exec("INSERT INTO settlements(event_id,total_cents,headcount,updated_at,note) VALUES('listen',0,1,'before','')");expect((await s.change('pause')).statusCode).toBe(409);
    for(const action of ['formation','start','finish','cancel','archive'])expect((await s.change(action,'原因')).statusCode).toBe(200);
    expect((await s.change('cancel','另一原因')).statusCode).toBe(409);expect((await s.change('unarchive')).statusCode).toBe(200);
  });
  it('dedupes manager and cohost recipients, includes invited people, excludes withdrawn people and does not invent owner notifications',async()=>{
    const s=await setup();s.db.exec("INSERT INTO event_roles VALUES('helper','listen','alice','[\"schedule\"]','before'); UPDATE attendees SET status='invited',manager_id='bob' WHERE id='managed-listen'");
    expect((await s.change('start')).statusCode).toBe(200);expect(s.db.prepare("SELECT user_id,kind FROM notifications WHERE event_id='listen' ORDER BY user_id").all()).toEqual([{user_id:'alice',kind:'event_started'},{user_id:'bob',kind:'event_started'}]);
    s.db.exec("DELETE FROM notifications; DELETE FROM event_roles; UPDATE attendees SET status='withdrawn' WHERE event_id='listen'");expect((await s.change('finish')).statusCode).toBe(200);expect(s.db.prepare("SELECT * FROM notifications WHERE event_id='listen'").all()).toEqual([]);
  });
  it('dedupes actual transitions and exact-key replays, retains earlier actual times and reauthorizes receipts',async()=>{
    const s=await setup(),key=randomUUID();expect((await s.change('start','',s.alice,key,7)).statusCode).toBe(200);const before=state(s.db);
    expect((await s.change('start','',s.alice,key,7)).statusCode).toBe(200);expect((await s.change('start')).statusCode).toBe(200);expect(state(s.db)).toEqual(before);
    expect((await s.change('start','changed',s.alice,key,7)).statusCode).toBe(409);
    expect((await s.app.inject({url:'/api/v2/activities/lifecycle-results/'+key,headers:s.alice})).json()).toMatchObject({state:'completed'});
    s.db.exec("INSERT INTO event_roles VALUES('helper','listen','bob','[\"schedule\"]','before')");const other=randomUUID();expect((await s.change('finish','',s.bob,other)).statusCode).toBe(200);s.db.exec("DELETE FROM event_roles");expect((await s.app.inject({url:'/api/v2/activities/lifecycle-results/'+other,headers:s.bob})).statusCode).toBe(403);
  });
  it('blocks removal with any third-party or financial history, but safely recovers an eligible soft removal and skips all queued channels',async()=>{
    const blocked=await setup();expect((await blocked.change('remove')).statusCode).toBe(409);
    const s=await setup(true);s.db.exec("INSERT INTO attendees(id,event_id,manager_id,name,payer_kind,status,created_at,updated_at) VALUES('other','listen','alice','guest','manager','withdrawn','before','before')");expect((await s.change('remove')).statusCode).toBe(409);s.db.exec("DELETE FROM attendees WHERE id='other'");
    s.db.exec("INSERT INTO bot_outbox(event_id,kind,dedupe_key,channel,target,payload_json,status,created_at) VALUES('listen','synthetic','private-pending','private','','{\"frozen\":true}','sending','before')");
    await differential(s,['remove'],async()=>expect((await s.change('remove','測試狀態原因',s.alice,'d330808e-f552-4f59-a100-798cbacb51b9',7)).statusCode).toBe(200));
    expect((await s.change('remove','測試狀態原因',s.alice,'d330808e-f552-4f59-a100-798cbacb51b9',7)).statusCode).toBe(200);
    expect((await s.app.inject({url:'/api/v2/activities/lifecycle-results/d330808e-f552-4f59-a100-798cbacb51b9',headers:s.alice})).json()).toMatchObject({state:'completed',result:{removed:true}});
    expect((await s.app.inject({url:'/api/v2/activities/listen/lifecycle',headers:s.bob})).statusCode).toBe(404);expect((await s.app.inject({url:'/api/v2/activities/listen',headers:s.alice})).statusCode).toBe(404);
  });
  it('rolls back necessary notices, audit, receipts and skipped work atomically, while isolating optional bot failures',async()=>{
    const s=await setup(),before=state(s.db);
    for(const table of ['notifications','event_audit','request_results']){s.db.exec("CREATE TRIGGER synthetic_failure BEFORE INSERT ON "+table+" BEGIN SELECT RAISE(ABORT,'synthetic'); END");expect((await s.change('finish')).statusCode).toBe(500);expect(state(s.db)).toEqual(before);s.db.exec('DROP TRIGGER synthetic_failure');}
    s.db.exec("CREATE TRIGGER synthetic_failure BEFORE INSERT ON bot_outbox BEGIN SELECT RAISE(ABORT,'synthetic'); END");expect((await s.change('finish')).statusCode).toBe(200);expect(eventRow(s.db,'listen')!.lifecycle).toBe('ended');expect(s.db.prepare("SELECT status FROM bot_outbox WHERE event_id='listen'").all()).toEqual([{status:'pending'},{status:'pending'}]);
  });
  it.each(['pause','resume','formation','start','finish','cancel'])('lets the retained Python worker consume native %s cards with a network-free transport in plain, rich and simulation modes',async(action)=>{
      const s=await setup();if(action==='resume')s.db.exec("UPDATE events SET registration_open=0,status='closed' WHERE id='listen'");
      expect((await s.change(action,'測試狀態原因')).statusCode).toBe(200);
      const folder=mkdtempSync(join(tmpdir(),'qgroup-lifecycle-worker-'));
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
print(json.dumps(dict(first=first,second=second,calls=api.post.call_count,rows=[dict(r) for r in db.execute('SELECT kind,status,simulated_at,delivered_payload_json FROM bot_outbox ORDER BY id')],event=dict(db.execute("SELECT lifecycle,revision FROM events WHERE id='listen'").fetchone()))))`,path,mode],{encoding:'utf8',env:{...process.env,QQBOT_APP_ID:'',QQBOT_APP_SECRET:'',KANBAN_BOT_ENV:'',KANBAN_BOT_BASE_URL:origin}}));
        expect(result.first).toMatchObject({claimed:1,sent:mode==='dry-run'?0:1,simulated:mode==='dry-run'?1:0,failed:0});expect(result.second.claimed).toBe(0);expect(result.calls).toBe(mode==='dry-run'?0:1);expect(result.event.revision).toBe(8);
        const delivered=result.rows.at(-1);expect(delivered.status).toBe(mode==='dry-run'?'skipped':'sent');expect(delivered.simulated_at).toBe(mode==='dry-run'?stamp:null);expect(JSON.parse(delivered.delivered_payload_json).msg_type).toBe(mode==='plain'?0:2);
        expect(result.rows.slice(0,2).map((row:{status:string})=>row.status)).toEqual(['finish','cancel'].includes(action)?['skipped','skipped']:['pending','pending']);
      }}finally{rmSync(folder,{recursive:true,force:true});}
  });
});
