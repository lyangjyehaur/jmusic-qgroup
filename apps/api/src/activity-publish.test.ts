import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { fixture } from '../testsupport/fixture';
import { createApp } from './app';
import { eventRow } from './activity-arrangements';
import { allocateActivity } from './activity-publish';
const origin='https://rebuild.example',stamp='2026-11-17T00:00:00+00:00';
const cleanups:(()=>Promise<unknown>)[]=[];afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();});
async function setup(enabled=true){
  const db=openDatabase(':memory:');fixture(db);db.prepare("INSERT OR REPLACE INTO bot_settings VALUES(1,0,?,'before')").run(JSON.stringify({enabled,groups:[{id:'synthetic-group',name:'測試',replies:true,broadcast:true}]}));
  const app=createApp({db,origin,now:()=>new Date(stamp),activityBot:{enabled,baseURL:origin,keyboard:true,personalQueue:true}});await app.ready();cleanups.push(async()=>{await app.close();db.close();});
  async function account(user:string){const cookie='kanban_session=fixture-'+user;const session=(await app.inject({url:'/api/v2/session',headers:{cookie}})).json();return {cookie,origin,'x-account-scope':session.scope,'x-csrf-token':session.csrf};}
  const alice=await account('alice'),bob=await account('bob');
  const write=(url:string,payload:Record<string,unknown>,headers=alice,key=randomUUID())=>app.inject({method:'POST',url:'/api/v2/'+url,headers:{...headers,'idempotency-key':key},payload});
  const create=async(patch:Record<string,unknown>={})=>{
    const result=await write('activities/drafts',{values:{title:'發布測試',category:'约K',location:'台北',startsAt:'2026-11-20T18:00:00+08:00',deadline:'2026-11-19T18:00:00+08:00',capacity:5,description:'安排原文',durationHours:3,withdrawalDeadline:null,visibility:'public',timezone:'Asia/Taipei',minimumParticipants:2,feePolicy:'依人數分攤',botEnabled:true,joinOwner:false,...patch}});expect(result.statusCode).toBe(200);return result.json().id as string;
  };
  const publish=(id:string,revision=1,headers=alice,key=randomUUID())=>write('activities/'+id+'/draft/publish',{revision,confirm:true,acceptConditions:true},headers,key);
  return {db,app,alice,bob,create,publish,write};
}
describe('atomic draft publication',()=>{
  it('publishes conditions and automatically registers the owner even for a stored false intention; queues one final-roster card and two reminders',async()=>{
    const s=await setup(),id=await s.create();const key=randomUUID();const result=await s.publish(id,1,s.alice,key);expect(result.statusCode).toBe(200);expect(result.json()).toEqual({id,revision:3,removed:false});expect((await s.publish(id,1,s.alice,key)).body).toBe(result.body);
    expect(eventRow(s.db,id)).toMatchObject({lifecycle:'scheduled',status:'open',registration_open:1,draft_join_owner:1,revision:3});
    expect(s.db.prepare('SELECT summary,actor_name FROM event_conditions WHERE event_id=?').get(id)).toEqual({summary:'初始安排',actor_name:'小青'});
    const people=s.db.prepare('SELECT user_id,manager_id,payer_kind,status,accepted_conditions_version,confirmation_state FROM attendees WHERE event_id=?').all(id);expect(people).toEqual([{user_id:'alice',manager_id:'alice',payer_kind:'self',status:'confirmed',accepted_conditions_version:1,confirmation_state:'accepted'}]);
    expect(s.db.prepare('SELECT version,decision,actor_id,reason FROM attendee_consents WHERE event_id=?').all(id)).toEqual([{version:1,decision:'accepted',actor_id:'alice',reason:'报名时接受当前安排'}]);
    expect((s.db.prepare('SELECT action FROM event_audit WHERE event_id=? ORDER BY version').all(id) as {action:string}[]).map(r=>r.action)).toEqual(['event_created','signup','event_publish']);
    const rows=s.db.prepare('SELECT kind,payload_json FROM bot_outbox WHERE event_id=? ORDER BY id').all(id) as {kind:string;payload_json:string}[];expect(rows.map(r=>r.kind)).toEqual(['deadline_reminder','estimated_over_reminder','activity_published']);const card=JSON.parse(rows[2]!.payload_json);expect(card.text).toContain('正式报名（1 人）：小青');expect(card._template_context.confirmed).toBe('1');expect(card.keyboard.content.rows[1].buttons[0].action.data).toBe('/名额 '+id);expect(card.text).not.toContain('join_owner');
    expect((await s.app.inject({url:'/api/v2/activities/'+id})).statusCode).toBe(200);expect((await s.app.inject({url:'/api/v2/activities/'+id+'/draft',headers:s.alice})).statusCode).toBe(409);
    const read=await s.app.inject({url:'/api/v2/activities/draft-results/'+key,headers:s.alice});expect(read.json()).toEqual({state:'completed',result:{id,revision:3,removed:false}});
    expect((await s.publish(id)).statusCode).toBe(409);expect(s.db.prepare('SELECT count(*) AS n FROM attendees WHERE event_id=?').get(id)).toEqual({n:1});
  });
  it('validates deadline, start, permission, revision and explicit acceptance without touching any publication data',async()=>{
    const s=await setup();const id=await s.create();expect((await s.publish(id,0)).statusCode).toBe(409);expect((await s.publish(id,1,s.bob)).statusCode).toBe(404);
    s.db.prepare("INSERT INTO event_roles VALUES('role',?,'bob','[\"schedule\"]','before')").run(id);expect((await s.publish(id,1,s.bob)).statusCode).toBe(403);
    expect((await s.write('activities/'+id+'/draft/publish',{revision:1,confirm:true})).statusCode).toBe(400);expect((await s.write('activities/'+id+'/draft/publish',{revision:1,confirm:false,acceptConditions:true})).statusCode).toBe(400);
    for(const patch of [{startsAt:'2026-10-01T18:00:00+08:00',deadline:'2026-09-30T18:00:00+08:00'},{deadline:'2026-11-16T18:00:00+08:00'}]){const old=await s.create(patch);expect((await s.publish(old)).statusCode).toBeGreaterThanOrEqual(400);expect(eventRow(s.db,old)!.lifecycle).toBe('draft');}
    for(const table of ['event_conditions','attendees','bot_outbox','notifications'])expect(s.db.prepare('SELECT 1 FROM '+table).get()).toBeUndefined();
  });
  it('keeps invitation publications private and disabled policies silent while preserving owner participation',async()=>{
    const s=await setup();const privateId=await s.create({visibility:'invitation',botEnabled:false});expect((await s.publish(privateId)).statusCode).toBe(200);expect(s.db.prepare('SELECT 1 FROM bot_outbox WHERE event_id=?').get(privateId)).toBeUndefined();expect((await s.app.inject({url:'/api/v2/activities/'+privateId})).statusCode).toBe(404);
    const id=await s.create();s.db.exec("UPDATE bot_settings SET config_json='{\"enabled\":false}'");expect((await s.publish(id)).statusCode).toBe(200);expect(s.db.prepare('SELECT 1 FROM bot_outbox WHERE event_id=?').get(id)).toBeUndefined();expect(s.db.prepare('SELECT count(*) AS n FROM attendees WHERE event_id=?').get(id)).toEqual({n:1});
  });
  it('rolls back conditions, automatic signup, promotion, audits, outbox and receipt as a single publication',async()=>{
    const s=await setup(),id=await s.create();s.db.exec("CREATE TRIGGER synthetic_consent_failure BEFORE INSERT ON attendee_consents BEGIN SELECT RAISE(ABORT,'synthetic'); END;");const key=randomUUID();expect((await s.publish(id,1,s.alice,key)).statusCode).toBe(500);expect(eventRow(s.db,id)).toMatchObject({lifecycle:'draft',revision:1});for(const table of ['event_conditions','attendees','roster_parties','bot_outbox','notifications'])expect(s.db.prepare('SELECT 1 FROM '+table+' WHERE event_id=?').get(id)).toBeUndefined();
    s.db.exec('DROP TRIGGER synthetic_consent_failure');s.db.exec("CREATE TRIGGER synthetic_receipt_failure BEFORE INSERT ON request_results BEGIN SELECT RAISE(ABORT,'synthetic'); END;");expect((await s.publish(id,1,s.alice,key)).statusCode).toBe(500);expect(eventRow(s.db,id)).toMatchObject({lifecycle:'draft',revision:1});expect(s.db.prepare('SELECT 1 FROM event_conditions WHERE event_id=?').get(id)).toBeUndefined();expect(s.db.prepare('SELECT 1 FROM bot_outbox WHERE event_id=?').get(id)).toBeUndefined();
    s.db.exec('DROP TRIGGER synthetic_receipt_failure');expect((await s.publish(id,1,s.alice,key)).statusCode).toBe(200);
  });
  it('preserves strict FIFO and group blocking, prior consents and promotion notifications for an imported draft roster',async()=>{
    const s=await setup(),id=await s.create({capacity:3});
    s.db.prepare("INSERT INTO roster_parties(id,event_id,manager_id,queue_mode,created_at) VALUES('older',?,'bob','together','before')").run(id);
    for(const name of ['甲','乙'])s.db.prepare("INSERT INTO attendees(id,event_id,manager_id,party_id,name,payer_kind,status,created_at,updated_at) VALUES(?,?,'bob','older',?,'manager','waiting','before','before')").run(name,id,name);
    expect((await s.publish(id)).statusCode).toBe(200);expect(s.db.prepare("SELECT status FROM attendees WHERE id IN ('甲','乙')").all()).toEqual([{status:'confirmed'},{status:'confirmed'}]);expect(s.db.prepare("SELECT count(*) AS n FROM notifications WHERE event_id=? AND kind='promoted'").get(id)).toEqual({n:2});expect(s.db.prepare("SELECT count(*) AS n FROM bot_outbox WHERE event_id=? AND kind='promoted'").get(id)).toEqual({n:1});
    const owner=s.db.prepare("SELECT status FROM attendees WHERE event_id=? AND user_id='alice'").get(id);expect(owner).toEqual({status:'confirmed'});
    const cases=[0,1,2,3,4].map(cap=>({cap,rows:[{id:'a',party_id:'confirmed',status:'confirmed',queue_mode:'individual'},{id:'b',party_id:'pair',status:'waiting',queue_mode:'together'},{id:'c',party_id:'pair',status:'waiting',queue_mode:'together'},{id:'d',party_id:'last',status:'waiting',queue_mode:'individual'}]}));
    const expected=JSON.parse(execFileSync('python3',['-c',`import json,sys
from qgroup_core.roster import allocate
print(json.dumps([allocate(c['rows'],c['cap'],['owner']) for c in json.load(sys.stdin)]))`],{input:JSON.stringify(cases),encoding:'utf8'}));expect(cases.map(c=>Object.fromEntries(allocateActivity(c.rows,c.cap,['owner'])))).toEqual(expected);
  });
  it('does not roll back publication or partially queue work if optional bot composition fails',async()=>{
    const s=await setup(),id=await s.create();s.db.exec("CREATE TRIGGER synthetic_bot_failure BEFORE INSERT ON bot_outbox WHEN NEW.kind='activity_published' BEGIN SELECT RAISE(ABORT,'synthetic'); END;");expect((await s.publish(id)).statusCode).toBe(200);expect(eventRow(s.db,id)!.lifecycle).toBe('scheduled');expect(s.db.prepare('SELECT 1 FROM bot_outbox WHERE event_id=?').get(id)).toBeUndefined();expect(s.db.prepare('SELECT count(*) AS n FROM event_audit WHERE event_id=?').get(id)).toEqual({n:3});
  });
  it('matches original Python publication records, consent, final roster audit and frozen old-bot work on the same synthetic draft',async()=>{
    const s=await setup(),id=await s.create();const folder=mkdtempSync(join(tmpdir(),'qgroup-publish-diff-')),path=join(folder,'synthetic.sqlite3');
    try{
      await s.db.backup(path);const expected=JSON.parse(execFileSync('python3',['-c',`import datetime,json,sqlite3,sys
from qgroup_core import events,audit,conditions,roster,bot_outbox,bot_views,bot_settings,lifecycle
db=sqlite3.connect(sys.argv[1]);db.row_factory=sqlite3.Row
for module in (events,audit,conditions,roster,bot_outbox,bot_views,bot_settings,lifecycle):module.now=lambda:'${stamp}'
class Frozen(datetime.datetime):
 @classmethod
 def now(cls,tz=None):return datetime.datetime.fromisoformat('${stamp}').astimezone(tz)
bot_outbox.datetime=Frozen
event=db.execute('SELECT * FROM events WHERE id=?',(sys.argv[2],)).fetchone()
user=db.execute("SELECT * FROM users WHERE id='alice'").fetchone()
events.patch(db,event,user,dict(action='publish',base_revision=1))
result={t:[dict(r) for r in db.execute('SELECT * FROM '+t+' WHERE event_id=?',(event['id'],))] for t in ['event_conditions','attendees','roster_parties','attendee_consents','event_audit','notifications','bot_outbox']}
result['event']=dict(db.execute('SELECT * FROM events WHERE id=?',(event['id'],)).fetchone())
print(json.dumps(result))`,path,id],{encoding:'utf8',env:{...process.env,KANBAN_BOT_BASE_URL:origin,KANBAN_BOT_KEYBOARD:'1',KANBAN_BOT_PERSONAL_QUEUE:'1'}}));
      expect((await s.publish(id)).statusCode).toBe(200);const actual:Record<string,unknown>={};for(const table of ['event_conditions','attendees','roster_parties','attendee_consents','event_audit','notifications','bot_outbox'])actual[table]=s.db.prepare('SELECT * FROM '+table+' WHERE event_id=?').all(id);actual.event=eventRow(s.db,id);
      function normalize(value:Record<string,unknown>){const people=value.attendees as {id:string;party_id:string}[];let text=JSON.stringify(value).replaceAll(people[0]!.id,'AUTO_ATTENDEE').replaceAll(people[0]!.party_id,'AUTO_PARTY');const decoded=JSON.parse(text);for(const table of ['event_conditions','event_audit','bot_outbox'])for(const row of decoded[table])for(const key of ['snapshot_json','before_json','after_json','payload_json'])if(typeof row[key]==='string')row[key]=JSON.parse(row[key]);return decoded;}
      expect(normalize(actual)).toEqual(normalize(expected));
    }finally{rmSync(folder,{recursive:true,force:true});}
  });
  it('lets the retained Python worker claim and consume native publication rows with a network-free transport, preserving future reminders and simulation state',async()=>{
    const s=await setup(),id=await s.create();expect((await s.publish(id)).statusCode).toBe(200);const folder=mkdtempSync(join(tmpdir(),'qgroup-worker-compat-'));
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
worker.datetime=Frozen;bot_outbox.datetime=Frozen
worker.now=lambda:'${stamp}'
config=SimpleNamespace(db=Path(sys.argv[1]),group='synthetic-group',dry_run=sys.argv[2]=='dry-run',sandbox=False,claim_timeout=600,batch=10,max_attempts=5,markdown_replies=sys.argv[2]!='plain',allowed_link_hosts=('rebuild.example',),log_dir=Path(sys.argv[1]).parent/'isolated-logs',log_content=False)
api=Mock();api.post.return_value=(True,0,dict(id='SYNTHETIC_ONLY'))
consumer=worker.OutboxWorker(config,api)
first=consumer.poll_once();second=consumer.poll_once()
db=sqlite3.connect(sys.argv[1]);db.row_factory=sqlite3.Row
print(json.dumps(dict(first=first,second=second,calls=api.post.call_count,body=api.post.call_args.args[1] if api.post.call_args else None,rows=[dict(r) for r in db.execute('SELECT kind,status,attempts,last_error,simulated_at,sent_at,delivered_payload_json FROM bot_outbox ORDER BY id')],event=dict(db.execute('SELECT lifecycle,revision FROM events WHERE id=?',(sys.argv[3],)).fetchone()))))`,path,mode,id],{encoding:'utf8',env:{...process.env,QQBOT_APP_ID:'',QQBOT_APP_SECRET:'',KANBAN_BOT_ENV:'',KANBAN_BOT_BASE_URL:origin}}));
      expect(result.first).toMatchObject({claimed:1,sent:mode==='dry-run'?0:1,simulated:mode==='dry-run'?1:0,failed:0});expect(result.second.claimed).toBe(0);expect(result.calls).toBe(mode==='dry-run'?0:1);expect(result.event).toEqual({lifecycle:'scheduled',revision:3});expect(result.rows.slice(0,2).map((r:{status:string})=>r.status)).toEqual(['pending','pending']);const delivered=result.rows[2];expect(delivered).toMatchObject({status:mode==='dry-run'?'skipped':'sent',attempts:0,last_error:mode==='dry-run'?'dry-run':''});expect(delivered.simulated_at).toBe(mode==='dry-run'?stamp:null);const payload=JSON.parse(delivered.delivered_payload_json);expect(payload.msg_type).toBe(mode==='plain'?0:2);if(mode==='plain')expect(payload).not.toHaveProperty('markdown');else expect(payload).not.toHaveProperty('content');
    }}finally{rmSync(folder,{recursive:true,force:true});}
  });
});
