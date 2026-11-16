import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { ActivityDraft, ActivityDraftList, ActivityDraftOperationResult } from '@qgroup/contracts';
import { fixture } from '../testsupport/fixture';
import { createApp } from './app';
import { activityDate, eventRow, eventSnapshot } from './activity-arrangements';
const origin='https://rebuild.example';const stamp='2026-11-17T00:00:00+00:00';
const input=()=>({title:'  草稿活動  ',category:'约K',location:'  台北  ',startsAt:'2026-10-12T14:30:25+08:00',deadline:'2026-10-11T08:30:00+02:00',capacity:0,description:'  說明\n第二行  ',durationHours:3,withdrawalDeadline:null,visibility:'public',timezone:'Asia/Taipei',minimumParticipants:2,feePolicy:'  依人數分攤  ',botEnabled:true,joinOwner:false});
const cleanups:(()=>Promise<unknown>)[]=[];
afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();});
async function setup(){
  const db=openDatabase(':memory:');fixture(db);db.exec("UPDATE events SET category='约K' WHERE id='draft'; INSERT INTO bot_settings VALUES(1,1,'{\"enabled\":true,\"schedule_enabled\":true}','before');");
  const app=createApp({db,origin,now:()=>new Date(stamp),botEnabledDefault:true});await app.ready();cleanups.push(async()=>{await app.close();db.close();});
  async function account(user:string){const cookie='kanban_session=fixture-'+user;const viewer=(await app.inject({url:'/api/v2/session',headers:{cookie}})).json();return {cookie,origin,'x-account-scope':viewer.scope,'x-csrf-token':viewer.csrf};}
  const alice=await account('alice'),bob=await account('bob');
  const write=(url:string,payload:Record<string,unknown>,headers=alice,key=randomUUID(),method:'POST'|'PUT'='POST')=>app.inject({method,url:'/api/v2/'+url,headers:{...headers,'idempotency-key':key},payload});
  const create=(values:unknown=input(),headers=alice,key=randomUUID())=>write('activities/drafts',{values},headers,key);
  const get=(url:string,headers=alice)=>app.inject({url:'/api/v2/'+url,headers});
  return {db,app,alice,bob,write,create,get};
}
describe('native activity draft authoring',()=>{
  it('creates a private draft with legacy IDs, normalized arrangements, owner access and first audit; no roster, conditions or bot side effects',async()=>{
    const s=await setup();const response=await s.create();expect(response.statusCode).toBe(200);const result=response.json();expect(result).toMatchObject({revision:1,removed:false});expect(result.id).toMatch(/^[a-f0-9]{16}$/);
    const event=eventRow(s.db,result.id)!;expect(event).toMatchObject({title:'草稿活動',location:'台北',starts_at:'2026-10-12T06:30:25+00:00',deadline:'2026-10-11T06:30:00+00:00',lifecycle:'draft',status:'closed',registration_open:0,bot_enabled:1,draft_join_owner:0});
    expect((s.db.prepare('SELECT invite_token FROM events WHERE id=?').get(result.id) as {invite_token:string}).invite_token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(s.db.prepare('SELECT user_id,created_at FROM event_access WHERE event_id=?').get(result.id)).toEqual({user_id:'alice',created_at:stamp});
    const audit=s.db.prepare('SELECT * FROM event_audit WHERE event_id=?').get(result.id) as {version:number;action:string;before_json:string;after_json:string};expect(audit.version).toBe(1);expect(audit.action).toBe('event_created');expect(JSON.parse(audit.before_json)).toEqual({});expect(JSON.parse(audit.after_json)).toEqual(eventSnapshot(event));
    for(const table of ['attendees','event_conditions','notifications','bot_outbox'])expect(s.db.prepare('SELECT 1 FROM '+table+' WHERE event_id=?').get(result.id)).toBeUndefined();
    const view=await s.get('activities/'+result.id+'/draft');expect(ActivityDraft.parse(view.json())).toMatchObject({id:result.id,isOwner:true,canEdit:true,canRemove:true,values:{feePolicy:'依人數分攤',joinOwner:false}});expect(view.body).not.toMatch(/token|owner_id|actor_id|user_id/);
    expect((await s.get('activities/'+result.id,{} as typeof s.alice)).statusCode).toBe(404);expect((await s.get('activities/'+result.id+'/draft',s.bob)).statusCode).toBe(404);
    expect(ActivityDraftList.parse((await s.get('me/activity-drafts')).json()).drafts.some(d=>d.id===result.id)).toBe(true);expect((await s.get('activities')).body).not.toContain(result.id);
  });
  it('preserves create intent on retries, global key conflicts, later edits and deletion without recreating the event',async()=>{
    const s=await setup(),key=randomUUID();const first=await s.create(input(),s.alice,key);const {id}=first.json();expect((await s.create(input(),s.alice,key)).body).toBe(first.body);
    expect((await s.create({...input(),title:'不同'},s.alice,key)).statusCode).toBe(409);
    const view=(await s.get('activities/'+id+'/draft')).json();const changed=await s.write('activities/'+id+'/draft',{revision:1,values:{...view.values,title:'較新草稿'}},s.alice,randomUUID(),'PUT');expect(changed.statusCode).toBe(200);
    expect((await s.create(input(),s.alice,key)).json().revision).toBe(1);expect(eventRow(s.db,id)!.title).toBe('較新草稿');
    const removeKey=randomUUID();const removed=await s.write('activities/'+id+'/draft/remove',{revision:2,confirm:true},s.alice,removeKey);expect(removed.statusCode).toBe(200);
    expect((await s.write('activities/'+id+'/draft/remove',{revision:2,confirm:true},s.alice,removeKey)).body).toBe(removed.body);
    expect((await s.create(input(),s.alice,key)).body).toBe(first.body);expect(s.db.prepare('SELECT count(*) AS n FROM events WHERE id=?').get(id)).toEqual({n:1});expect((await s.get('activities/'+id+'/draft')).statusCode).toBe(404);
    expect(ActivityDraftOperationResult.parse((await s.get('activities/draft-results/'+removeKey)).json())).toEqual({state:'completed',result:{id,revision:3,removed:true}});
    expect((await s.get('activities/draft-results/'+removeKey,s.bob)).json()).toEqual({state:'not_found'});expect((await s.get('activities/draft-results/'+randomUUID())).json()).toEqual({state:'not_found'});
  });
  it('audits real changes including draft-only participation, rejects stale revisions and leaves no-op versions stable',async()=>{
    const s=await setup();const {id}= (await s.create()).json();let view=(await s.get('activities/'+id+'/draft')).json();
    const noOp=await s.write('activities/'+id+'/draft',{revision:1,values:view.values},s.alice,randomUUID(),'PUT');expect(noOp.json().revision).toBe(1);
    const key=randomUUID(),payload={revision:1,values:{...view.values,joinOwner:true},reason:'本人參加'};
    const changed=await s.write('activities/'+id+'/draft',payload,s.alice,key,'PUT');expect(changed.json().revision).toBe(2);expect((await s.write('activities/'+id+'/draft',payload,s.alice,key,'PUT')).body).toBe(changed.body);
    expect((await s.write('activities/'+id+'/draft',{revision:1,values:{...view.values,title:'舊稿覆寫'}},s.alice,randomUUID(),'PUT')).json().code).toBe('ACTIVITY_CHANGED');
    view=(await s.get('activities/'+id+'/draft')).json();expect(view.values.joinOwner).toBe(true);
    expect((s.db.prepare('SELECT after_json FROM event_audit WHERE event_id=? AND version=2').get(id) as {after_json:string}).after_json).toContain('"draft_join_owner":1');
    expect(()=>s.db.prepare("UPDATE event_audit SET reason='rewrite' WHERE event_id=?").run(id)).toThrow(/append-only/);
    expect(s.db.prepare('SELECT 1 FROM event_conditions WHERE event_id=?').get(id)).toBeUndefined();
  });
  it('distinguishes draft visibility, event scopes and site admins; revalidates role removal even for successful receipts',async()=>{
    const s=await setup();const {id}= (await s.create()).json();s.db.prepare("INSERT INTO user_admin_roles VALUES('bob',1,0,'before')").run();
    expect((await s.get('activities/'+id+'/draft',s.bob)).statusCode).toBe(404);s.db.prepare("INSERT INTO event_access VALUES(?,'bob','before')").run(id);expect((await s.get('activities/'+id+'/draft',s.bob)).statusCode).toBe(404);
    s.db.prepare("INSERT INTO event_roles VALUES('role',?,'bob','[\"roster\"]','before')").run(id);const read=(await s.get('activities/'+id+'/draft',s.bob)).json();expect(read.canEdit).toBe(false);
    expect((await s.write('activities/'+id+'/draft',{revision:1,values:read.values},s.bob,randomUUID(),'PUT')).statusCode).toBe(403);
    s.db.prepare("UPDATE event_roles SET permissions_json='[\"schedule\"]'").run();
    const payload={revision:1,values:{...read.values,title:'協辦安排'},reason:'協辦修改'};const key=randomUUID();expect((await s.write('activities/'+id+'/draft',payload,s.bob,key,'PUT')).statusCode).toBe(200);
    const current=(await s.get('activities/'+id+'/draft',s.bob)).json();for(const patch of [{botEnabled:false},{feePolicy:'新規則'},{visibility:'invitation',botEnabled:false},{deadline:'2026-10-10T06:30:00+00:00'}])expect((await s.write('activities/'+id+'/draft',{revision:2,values:{...current.values,...patch}},s.bob,randomUUID(),'PUT')).statusCode).toBe(403);
    expect((await s.write('activities/'+id+'/draft/remove',{revision:2,confirm:true},s.bob)).statusCode).toBe(403);
    s.db.prepare("UPDATE event_roles SET permissions_json=' [ ] '").run();expect((await s.write('activities/'+id+'/draft',payload,s.bob,key,'PUT')).statusCode).toBe(404);expect((await s.get('activities/draft-results/'+key,s.bob)).statusCode).toBe(404);expect((await s.get('me/activity-drafts',s.bob)).json().drafts).toEqual([]);
  });
  it('rejects invalid calendars, naive or overflowing times, types, bounds, invite broadcasts and timezones without partial writes',async()=>{
    const s=await setup();const before=s.db.prepare('SELECT count(*) AS n FROM events').get();
    for(const patch of [{title:''},{category:'約K'},{capacity:true},{capacity:501},{capacity:3.5},{durationHours:0},{minimumParticipants:501},{capacity:1,minimumParticipants:2},{startsAt:'2026-02-30T10:00:00Z'},{startsAt:'2026-10-12T14:30:00'},{deadline:'2026-10-13T00:00:00Z'},{withdrawalDeadline:'2026-10-13T00:00:00Z'},{timezone:'not/a-zone'},{timezone:'asia/taipei'},{timezone:'+08:00'},{visibility:'invitation'},{joinOwner:0},{description:'𠀀'.repeat(3001)}])expect((await s.create({...input(),...patch})).statusCode).toBe(400);
    expect(s.db.prepare('SELECT count(*) AS n FROM events').get()).toEqual(before);expect(s.db.prepare('SELECT 1 FROM request_results').get()).toBeUndefined();
    expect(activityDate('2024-02-29T23:59:59.999999-03:30')).toBe('2024-03-01T03:29:59+00:00');for(const value of ['2023-02-29T00:00:00Z','2026-01-01T24:00:00Z','2026-01-01T00:00:00+24:00'])expect(()=>activityDate(value)).toThrow();
  });
  it('protects all business records and cancels only pending/sending work on explicit owner removal',async()=>{
    const s=await setup();const {id}= (await s.create()).json();
    s.db.prepare("INSERT INTO attendees(id,event_id,manager_id,name,payer_kind,status,created_at,updated_at) VALUES('other',?,'alice','同行','manager','withdrawn','before','before')").run(id);
    expect((await s.get('activities/'+id+'/draft')).json()).toMatchObject({canRemove:false});expect((await s.write('activities/'+id+'/draft/remove',{revision:1,confirm:true})).statusCode).toBe(409);
    s.db.prepare("DELETE FROM attendees WHERE id='other'").run();s.db.prepare("INSERT INTO event_roles VALUES('role',?,'bob','[\"schedule\"]','before')").run(id);expect((await s.write('activities/'+id+'/draft/remove',{revision:1,confirm:true})).statusCode).toBe(409);s.db.exec('DELETE FROM event_roles');
    for(const [index,status] of ['pending','sending','sent','failed','skipped'].entries())s.db.prepare("INSERT INTO bot_outbox(event_id,kind,dedupe_key,payload_json,created_at,due_at,status,channel) VALUES(?,'activity_published',?,'{}','before','before',?,?)").run(id,String(index),status,index%2?'private':'group');
    const result=await s.write('activities/'+id+'/draft/remove',{revision:1,confirm:true});expect(result.statusCode).toBe(200);
    expect((s.db.prepare('SELECT status FROM bot_outbox WHERE event_id=? ORDER BY id').all(id) as {status:string}[]).map(r=>r.status)).toEqual(['skipped','skipped','sent','failed','skipped']);
    expect(s.db.prepare('SELECT count(*) AS n FROM event_audit WHERE event_id=?').get(id)).toEqual({n:2});expect(s.db.prepare('SELECT 1 FROM event_access WHERE event_id=?').get(id)).toBeTruthy();
  });
  it('invalidates stale draft broadcasts and reminders with original errors; a failed optional hook rolls back only its own changes',async()=>{
    const s=await setup();const {id}= (await s.create()).json();
    for(const [kind,channel] of [['activity_published','group'],['deadline_reminder','group'],['estimated_over_reminder','private'],['promotion','private']])s.db.prepare("INSERT INTO bot_outbox(event_id,kind,dedupe_key,payload_json,created_at,due_at,status,channel) VALUES(?,?,?,'{\"frozen\":true}','before','before','pending',?)").run(id,kind,kind,channel);
    const view=(await s.get('activities/'+id+'/draft')).json();
    s.db.exec("CREATE TRIGGER synthetic_bot_failure BEFORE UPDATE ON bot_outbox WHEN NEW.channel='private' BEGIN SELECT RAISE(ABORT,'synthetic bot failure'); END;");
    const payload={revision:1,values:{...view.values,title:'通知失敗仍保存'}};expect((await s.write('activities/'+id+'/draft',payload,s.alice,randomUUID(),'PUT')).statusCode).toBe(200);expect(eventRow(s.db,id)!.title).toBe('通知失敗仍保存');expect(s.db.prepare("SELECT 1 FROM bot_outbox WHERE status!='pending'").get()).toBeUndefined();
    s.db.exec('DROP TRIGGER synthetic_bot_failure');expect((await s.write('activities/'+id+'/draft',{revision:2,values:{...view.values,title:'清理舊通知'}},s.alice,randomUUID(),'PUT')).statusCode).toBe(200);
    expect(s.db.prepare('SELECT kind,status,last_error,payload_json FROM bot_outbox ORDER BY id').all()).toEqual([
      {kind:'activity_published',status:'skipped',last_error:'活动已关闭公开群同步',payload_json:'{"frozen":true}'},
      {kind:'deadline_reminder',status:'skipped',last_error:'活动已关闭公开群同步',payload_json:'{"frozen":true}'},
      {kind:'estimated_over_reminder',status:'skipped',last_error:'安排或群同步设置已变更，旧提醒作废',payload_json:'{"frozen":true}'},
      {kind:'promotion',status:'pending',last_error:'',payload_json:'{"frozen":true}'},
    ]);
  });
  it('retains imported active draft agreements and requires a reason before an important change',async()=>{
    const s=await setup();const {id}= (await s.create()).json();s.db.prepare("INSERT INTO attendees(id,event_id,user_id,manager_id,name,payer_kind,status,accepted_conditions_version,confirmation_state,created_at,updated_at) VALUES('existing',?,'alice','alice','原稱呼','self','confirmed',1,'accepted','before','before')").run(id);
    const view=(await s.get('activities/'+id+'/draft')).json();const values={...view.values,location:'重要新地點'};
    expect((await s.write('activities/'+id+'/draft',{revision:1,values},s.alice,randomUUID(),'PUT')).json().code).toBe('ARRANGEMENT_REASON_REQUIRED');
    expect((await s.write('activities/'+id+'/draft',{revision:1,values,reason:'核對原報名安排'},s.alice,randomUUID(),'PUT')).statusCode).toBe(200);expect(s.db.prepare("SELECT status,confirmation_state,accepted_conditions_version FROM attendees WHERE id='existing'").get()).toEqual({status:'confirmed',confirmation_state:'accepted',accepted_conditions_version:1});expect(s.db.prepare('SELECT 1 FROM event_conditions WHERE event_id=?').get(id)).toBeUndefined();
  });
  it('rolls back event, grant, audit and result together if any append fails',async()=>{
    const s=await setup();const before=s.db.prepare('SELECT count(*) AS n FROM events').get();s.db.exec("CREATE TRIGGER synthetic_audit_failure BEFORE INSERT ON event_audit BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");const key=randomUUID();expect((await s.create(input(),s.alice,key)).statusCode).toBe(500);expect(s.db.prepare('SELECT count(*) AS n FROM events').get()).toEqual(before);expect(s.db.prepare('SELECT 1 FROM event_access').get()).toBeUndefined();expect(s.db.prepare('SELECT 1 FROM request_results').get()).toBeUndefined();
    s.db.exec('DROP TRIGGER synthetic_audit_failure');const {id}= (await s.create(input(),s.alice,key)).json();const view=(await s.get('activities/'+id+'/draft')).json();s.db.exec("CREATE TRIGGER synthetic_receipt_failure BEFORE INSERT ON request_results BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");expect((await s.write('activities/'+id+'/draft',{revision:1,values:{...view.values,title:'不能部分保存'}},s.alice,randomUUID(),'PUT')).statusCode).toBe(500);expect(eventRow(s.db,id)!.title).toBe('草稿活動');expect(eventRow(s.db,id)!.revision).toBe(1);
  });
  it('rejects unscoped, cross-origin, stale-account and revoked-device writes and does not accept the draft API for published activities',async()=>{
    const s=await setup();for(const headers of [{...s.alice,'x-account-scope':''},{...s.alice,origin:'https://evil.example'},{...s.alice,'x-csrf-token':'0'.repeat(64)},{...s.alice,cookie:s.bob.cookie}, {...s.alice,cookie:''}])expect((await s.create(input(),headers)).statusCode).toBeGreaterThanOrEqual(400);
    const {id}= (await s.create()).json();s.db.prepare("UPDATE events SET lifecycle='scheduled' WHERE id=?").run(id);expect((await s.get('activities/'+id+'/draft')).statusCode).toBe(409);expect((await s.write('activities/'+id+'/draft/remove',{revision:1,confirm:true})).statusCode).toBe(409);expect((await s.write('activities/'+id+'/draft/remove',{revision:1,confirm:true},s.bob)).statusCode).toBe(404);
    s.db.exec('DELETE FROM browser_sessions');expect((await s.create()).statusCode).toBe(401);
  });
  it('matches original Python draft creation/editing and leaves existing bot projections and pending work unchanged',async()=>{
    const s=await setup();const folder=mkdtempSync(join(tmpdir(),'qgroup-draft-diff-'));const path=join(folder,'synthetic.sqlite3');
    try{
      await s.db.backup(path);
      const expected=JSON.parse(execFileSync('python3',['-c',`import json,sqlite3,sys
from qgroup_core import events,audit,roster,conditions,bot_outbox
db=sqlite3.connect(sys.argv[1]);db.row_factory=sqlite3.Row
for module in (events,audit,roster,conditions,bot_outbox):module.now=lambda:'${stamp}'
user=db.execute("SELECT * FROM users WHERE id='alice'").fetchone()
data=dict(title='  草稿活動  ',category='约K',location='  台北  ',starts_at='2026-10-12T14:30:25+08:00',deadline='2026-10-11T08:30:00+02:00',capacity=0,description='  說明\\n第二行  ',duration_hours=3,withdrawal_deadline=None,visibility='public',timezone='Asia/Taipei',minimum_participants=2,fee_policy='  依人數分攤  ',bot_enabled=True,join_owner=False,lifecycle='draft')
uid=events.create(db,user,data)
created=events.public_snapshot(db.execute('SELECT * FROM events WHERE id=?',(uid,)).fetchone())
data.update(title='變更後的草稿',base_revision=1,reason='修改地點',location='新地點')
events.patch(db,db.execute('SELECT * FROM events WHERE id=?',(uid,)).fetchone(),user,data)
updated=events.public_snapshot(db.execute('SELECT * FROM events WHERE id=?',(uid,)).fetchone())
print(json.dumps(dict(created=created,updated=updated,audits=[dict(version=r['version'],action=r['action'],before=json.loads(r['before_json']),after=json.loads(r['after_json']),reason=r['reason']) for r in db.execute('SELECT * FROM event_audit WHERE event_id=? ORDER BY version',(uid,))],counts={t:db.execute('SELECT count(*) FROM '+t+' WHERE event_id=?',(uid,)).fetchone()[0] for t in ['attendees','event_conditions','bot_outbox','notifications']})))`,path],{encoding:'utf8',env:{...process.env,KANBAN_BOT_ENABLED:'1',KANBAN_BOT_GROUPS:'',QQ_APP_ID:'',QQ_APP_KEY:''}}));
      const probe=()=>JSON.parse(execFileSync('python3',['tools/rebuild/probe-auth-bot.py',path],{encoding:'utf8'}));const original=probe();const {id}= (await s.create()).json();expect(eventSnapshot(eventRow(s.db,id)!)).toEqual(expected.created);
      const view=(await s.get('activities/'+id+'/draft')).json();expect((await s.write('activities/'+id+'/draft',{revision:1,values:{...view.values,title:'變更後的草稿',location:'新地點'},reason:'修改地點'},s.alice,randomUUID(),'PUT')).statusCode).toBe(200);expect(eventSnapshot(eventRow(s.db,id)!)).toEqual(expected.updated);
      const audits=(s.db.prepare('SELECT version,action,before_json,after_json,reason FROM event_audit WHERE event_id=? ORDER BY version').all(id) as {version:number;action:string;before_json:string;after_json:string;reason:string}[]).map(r=>{const before=JSON.parse(r.before_json),after=JSON.parse(r.after_json);delete before.draft_join_owner;delete after.draft_join_owner;return {version:r.version,action:r.action,before,after,reason:r.reason};});expect(audits).toEqual(expected.audits);
      expect(expected.counts).toEqual({attendees:0,event_conditions:0,bot_outbox:0,notifications:0});await s.db.backup(path);expect(probe()).toEqual(original);
    }finally{rmSync(folder,{recursive:true,force:true});}
  });
});
