import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { ActivityConditions, type SaveActivityDraft } from '@qgroup/contracts';
import type { z } from 'zod';
import { fixture } from '../testsupport/fixture';
import { nicknameFixture } from '../testsupport/nickname-fixture';
import { createApp } from './app';
import { arrangementSnapshot, eventRow, storedArrangement } from './activity-arrangements';
const stamp='2026-11-17T00:00:00+00:00',origin='https://rebuild.example';
const cleanups:(()=>Promise<unknown>)[]=[];afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();});
async function setup(){
  const db=openDatabase(':memory:');fixture(db);nicknameFixture(db);
  db.exec(`DELETE FROM settlements; DELETE FROM bot_outbox; UPDATE events SET starts_at='2026-11-20T10:00:00+00:00',deadline='2026-11-19T10:00:00+00:00',revision=7,capacity=1 WHERE id='listen'; UPDATE attendees SET accepted_conditions_version=1,confirmation_state='accepted' WHERE event_id='listen';`);
  db.prepare('UPDATE bot_settings SET config_json=?').run(JSON.stringify({enabled:true,groups:[{id:'synthetic-group',name:'測試',replies:true,broadcast:true}]}));
  db.prepare('INSERT INTO event_conditions VALUES(?,1,?,?,?,?)').run('listen',JSON.stringify(arrangementSnapshot(eventRow(db,'listen')!)),'初始安排','原發起者','before');
  const app=createApp({db,origin,now:()=>new Date(stamp),activityBot:{enabled:true,baseURL:origin,keyboard:true,personalQueue:true}});await app.ready();cleanups.push(async()=>{await app.close();db.close();});
  async function headers(user:string){const cookie='kanban_session=fixture-'+user,session=(await app.inject({url:'/api/v2/session',headers:{cookie}})).json();return {cookie,origin,'x-account-scope':session.scope,'x-csrf-token':session.csrf};}
  const alice=await headers('alice'),bob=await headers('bob');
  const input=(patch:Record<string,unknown>={},reason='核對新的安排')=>({revision:eventRow(db,'listen')!.revision,values:{...storedArrangement(eventRow(db,'listen')!),...patch},reason}) as z.infer<typeof SaveActivityDraft>;
  const edit=(data=input({location:'新地點'}),h=alice,key=randomUUID())=>app.inject({method:'PUT',url:'/api/v2/activities/listen/arrangements',headers:{...h,'idempotency-key':key},payload:data});
  const respond=(personId='self-listen',patch:Record<string,unknown>={},h=alice,key=randomUUID())=>app.inject({method:'POST',url:'/api/v2/activities/listen/attendees/'+personId+'/conditions',headers:{...h,'idempotency-key':key},payload:{revision:eventRow(db,'listen')!.revision,conditionsVersion:eventRow(db,'listen')!.conditions_version,decision:'accepted',reason:'',...patch}});
  return {db,app,alice,bob,input,edit,respond};
}
const tables=['events','attendees','roster_parties','event_conditions','attendee_consents','event_audit','notifications','bot_outbox','finance_entries'];
function state(db:ReturnType<typeof openDatabase>){const result:Record<string,unknown>={};for(const table of tables)result[table]=db.prepare('SELECT * FROM '+table+" WHERE "+(table==='events'?'id':'event_id')+"='listen' ORDER BY rowid").all().map(raw=>{const row=raw as Record<string,unknown>;return Object.fromEntries(Object.entries(row).map(([key,value])=>[key,key.endsWith('_json')&&typeof value==='string'?JSON.parse(value):value]));});return result;}
const python=`import datetime,json,sqlite3,sys
from qgroup_core import events,conditions,roster,audit,bot_outbox,bot_settings,bot_views,lifecycle
db=sqlite3.connect(sys.argv[1]);db.row_factory=sqlite3.Row
for module in (events,conditions,roster,audit,bot_outbox,bot_settings,bot_views,lifecycle):module.now=lambda:'${stamp}'
class Frozen(datetime.datetime):
 @classmethod
 def now(cls,tz=None):return datetime.datetime.fromisoformat('${stamp}').astimezone(tz)
bot_outbox.datetime=Frozen
event=db.execute("SELECT * FROM events WHERE id='listen'").fetchone()
user=db.execute("SELECT * FROM users WHERE id='alice'").fetchone()
`;
async function differential(s:Awaited<ReturnType<typeof setup>>,action:string,run:()=>Promise<unknown>){
  const folder=mkdtempSync(join(tmpdir(),'qgroup-arrange-diff-')),path=join(folder,'synthetic.sqlite3');
  try{
    await s.db.backup(path);const expected=JSON.parse(execFileSync('python3',['-c',python+action+`
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
describe('published arrangements and per-person consent',()=>{
  it('matches original Python revisions, immutable conditions, old consents, strict promotion, notices and frozen bot work',async()=>{
    const s=await setup(),data=s.input({location:'新的地點',feePolicy:'新的費用',capacity:3});
    await differential(s,"events.patch(db,event,user,dict(title=event['title'],category=event['category'],location='新的地點',starts_at=event['starts_at'],deadline=event['deadline'],capacity=3,description=event['description'],duration_hours=3,fee_policy='新的費用',reason='核對新的安排'))",async()=>{expect((await s.edit(data)).statusCode).toBe(200);});
    expect(s.db.prepare("SELECT status,confirmation_state,accepted_conditions_version FROM attendees WHERE id='managed-listen'").get()).toEqual({status:'confirmed',confirmation_state:'pending',accepted_conditions_version:1});
    const read=await s.app.inject({url:'/api/v2/activities/listen/conditions',headers:s.alice});expect(ActivityConditions.parse(read.json()).people).toHaveLength(2);expect(read.body).not.toContain('recipient_user_id');
  });
  it('matches original explicit decline/accept, keeps roster and money, and dedupes repeated decisions',async()=>{
    const s=await setup();await s.edit();
    await differential(s,"conditions.respond(db,event,user,'managed-listen',dict(conditions_version=event['conditions_version'],decision='declined',reason='無法接受新費用'))",async()=>{expect((await s.respond('managed-listen',{decision:'declined',reason:'無法接受新費用'})).statusCode).toBe(200);});
    expect(s.db.prepare("SELECT status,accepted_conditions_version FROM attendees WHERE id='managed-listen'").get()).toEqual({status:'waiting',accepted_conditions_version:1});
    const version=eventRow(s.db,'listen')!.revision;expect((await s.respond('managed-listen',{decision:'declined',reason:'另一個原因'})).statusCode).toBe(200);expect(eventRow(s.db,'listen')!.revision).toBe(version);
    await differential(s,"conditions.respond(db,event,user,'managed-listen',dict(conditions_version=event['conditions_version'],decision='accepted',reason=''))",async()=>{expect((await s.respond('managed-listen')).statusCode).toBe(200);});
    expect(s.db.prepare('SELECT count(*) AS n FROM finance_entries').get()).toEqual({n:1});
  });
  it('only versions important changes, uses the effective withdrawal deadline and preserves inactive consents',async()=>{
    const s=await setup();expect((await s.edit(s.input({title:'只改標題',capacity:2},''))).statusCode).toBe(200);expect(eventRow(s.db,'listen')!.conditions_version).toBe(1);
    expect((await s.edit(s.input({deadline:'2026-11-18T10:00:00+00:00'},''))).statusCode).toBe(400);
    expect((await s.edit(s.input({deadline:'2026-11-18T10:00:00+00:00'}))).statusCode).toBe(200);expect(eventRow(s.db,'listen')!.conditions_version).toBe(2);
    expect(s.db.prepare("SELECT confirmation_state,accepted_conditions_version FROM attendees WHERE id='guest-listen'").get()).toEqual({confirmation_state:'accepted',accepted_conditions_version:1});
    const before=state(s.db);expect((await s.edit(s.input({},''))).statusCode).toBe(200);expect(state(s.db)).toEqual(before);
    s.db.prepare("UPDATE events SET withdrawal_deadline=deadline WHERE id='listen'").run();expect((await s.edit(s.input({deadline:'2026-11-17T12:00:00+00:00'},''))).statusCode).toBe(200);expect(eventRow(s.db,'listen')!.conditions_version).toBe(2);
  });
  it('requires current revision, reasons, owner-only settings and original manager consent, even for administrators',async()=>{
    const s=await setup();expect((await s.edit(s.input(),s.bob)).statusCode).toBe(403);s.db.exec("INSERT INTO event_roles VALUES('schedule','listen','bob','[\"schedule\"]','before')");
    for(const patch of [{feePolicy:'他人費用'},{visibility:'invitation',botEnabled:false},{botEnabled:false},{deadline:'2026-11-18T10:00:00+00:00'}])expect((await s.edit(s.input(patch),s.bob)).statusCode).toBe(403);
    expect((await s.edit({...s.input(),revision:0})).statusCode).toBe(409);expect((await s.edit(s.input({capacity:0},''),s.bob)).statusCode).toBe(200);
    s.db.exec("INSERT INTO user_admin_roles VALUES('bob',1,1,'before')");expect((await s.edit(s.input({},''),s.bob)).statusCode).toBe(400);expect((await s.edit(s.input({deadline:'2026-11-18T10:00:00+00:00'}),s.bob)).statusCode).toBe(200);
    expect(s.db.prepare("SELECT 1 FROM notifications WHERE kind='admin_event_updated'").get()).toBeDefined();
    expect((await s.respond('managed-listen',{},s.bob)).statusCode).toBe(403);expect((await s.respond('self-listen',{conditionsVersion:1})).statusCode).toBe(409);expect((await s.respond('self-listen',{decision:'declined'})).statusCode).toBe(400);expect((await s.respond('guest-listen')).statusCode).toBe(404);
  });
  it('keeps permission and identity checks ahead of completed receipts and keeps private history private',async()=>{
    const s=await setup();s.db.exec("INSERT INTO event_roles VALUES('schedule','listen','bob','[\"schedule\"]','before')");const key=randomUUID(),data=s.input();expect((await s.edit(data,s.bob,key)).statusCode).toBe(200);s.db.exec("DELETE FROM event_roles WHERE id='schedule'");
    expect((await s.edit(data,s.bob,key)).statusCode).toBe(403);expect((await s.app.inject({url:'/api/v2/activities/management-results/'+key,headers:s.bob})).statusCode).toBe(403);
    const consentKey=randomUUID();expect((await s.respond('self-listen',{},s.alice,consentKey)).statusCode).toBe(200);s.db.exec("UPDATE attendees SET manager_id='bob' WHERE id='self-listen'");expect((await s.app.inject({url:'/api/v2/activities/management-results/'+consentKey,headers:s.alice})).statusCode).toBe(403);
    s.db.exec("UPDATE events SET visibility='invitation' WHERE id='listen'");expect((await s.app.inject({url:'/api/v2/activities/listen/conditions'})).statusCode).toBe(404);expect((await s.app.inject({url:'/api/v2/activities/listen/conditions',headers:s.bob})).statusCode).toBe(404);
    const owner=(await s.app.inject({url:'/api/v2/activities/listen/conditions',headers:s.alice})).json();expect(owner.people.map((p:{id:string})=>p.id)).not.toContain('self-listen');
  });
  it('rolls back condition history, roster states, notices, bot work, audit and receipts when a necessary write fails',async()=>{
    const s=await setup(),before=state(s.db);s.db.exec("CREATE TRIGGER synthetic_notice BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT,'synthetic'); END;");expect((await s.edit()).statusCode).toBe(500);expect(state(s.db)).toEqual(before);
    s.db.exec("DROP TRIGGER synthetic_notice; CREATE TRIGGER synthetic_result BEFORE INSERT ON request_results BEGIN SELECT RAISE(ABORT,'synthetic'); END;");expect((await s.edit()).statusCode).toBe(500);expect(state(s.db)).toEqual(before);s.db.exec('DROP TRIGGER synthetic_result');await s.edit();
    const revised=state(s.db);s.db.exec("CREATE TRIGGER synthetic_consent BEFORE INSERT ON attendee_consents BEGIN SELECT RAISE(ABORT,'synthetic'); END;");expect((await s.respond()).statusCode).toBe(500);expect(state(s.db)).toEqual(revised);
  });
  it('preserves arrangements when optional bot fails and blocks actual terminal/archive/settlement changes without guessing from planned time',async()=>{
    const s=await setup();s.db.exec("CREATE TRIGGER synthetic_bot BEFORE INSERT ON bot_outbox BEGIN SELECT RAISE(ABORT,'synthetic'); END;");expect((await s.edit()).statusCode).toBe(200);expect(s.db.prepare('SELECT * FROM bot_outbox').all()).toEqual([]);s.db.exec('DROP TRIGGER synthetic_bot');
    for(const lifecycle of ['ended','cancelled']){s.db.prepare("UPDATE events SET lifecycle=? WHERE id='listen'").run(lifecycle);expect((await s.edit()).statusCode).toBe(409);expect((await s.respond()).statusCode).toBe(409);}
    s.db.exec("UPDATE events SET lifecycle='scheduled',archived_at='before' WHERE id='listen'");expect((await s.edit()).statusCode).toBe(409);expect((await s.respond()).statusCode).toBe(409);
    s.db.exec("UPDATE events SET archived_at=NULL,starts_at='2026-11-16T00:00:00+00:00',deadline='2026-11-15T00:00:00+00:00' WHERE id='listen'");expect((await s.edit(s.input({title:'更正標題'},''))).statusCode).toBe(200);expect((await s.respond()).statusCode).toBe(200);
    s.db.exec("INSERT INTO settlements(event_id,total_cents,headcount,updated_at,note) VALUES('listen',0,1,'before','')");expect((await s.edit()).statusCode).toBe(409);
  });
  it('paginates every saved arrangement while visitors receive no managed identities or consent drafts',async()=>{
    const s=await setup(),snapshot=JSON.stringify(arrangementSnapshot(eventRow(s.db,'listen')!));for(let version=2;version<=25;version++)s.db.prepare('INSERT INTO event_conditions VALUES(?,?,?,?,?,?)').run('listen',version,snapshot,'歷史 '+version,'歷史操作人','before');s.db.exec("UPDATE events SET conditions_version=25 WHERE id='listen'");
    const page1=ActivityConditions.parse((await s.app.inject({url:'/api/v2/activities/listen/conditions'})).json());expect(page1.current.version).toBe(25);expect(page1.history.map(row=>row.version)).toEqual(Array.from({length:20},(_,i)=>25-i));expect(page1.people).toEqual([]);expect(page1.hasMore).toBe(true);
    const page2=ActivityConditions.parse((await s.app.inject({url:'/api/v2/activities/listen/conditions?page=2',headers:s.alice})).json());expect(page2.history.map(row=>row.version)).toEqual([5,4,3,2,1]);expect(page2.hasMore).toBe(false);expect(page2.people).toHaveLength(2);
    const key=randomUUID(),input={revision:7,conditionsVersion:25,decision:'accepted',reason:''};const response=await s.app.inject({method:'POST',url:'/api/v2/activities/listen/attendees/self-listen/conditions',headers:{...s.alice,'idempotency-key':key},payload:input});expect(response.statusCode).toBe(200);
    expect((await s.app.inject({url:'/api/v2/activities/management-results/'+key,headers:s.alice})).json()).toMatchObject({state:'completed',result:{id:'listen'}});expect((await s.app.inject({url:'/api/v2/activities/management-results/'+key,headers:s.bob})).json()).toEqual({state:'not_found'});
    expect((await s.app.inject({method:'POST',url:'/api/v2/activities/listen/attendees/self-listen/conditions',headers:{...s.alice,'idempotency-key':key},payload:{...input,reason:'different'}})).statusCode).toBe(409);
  });
});
