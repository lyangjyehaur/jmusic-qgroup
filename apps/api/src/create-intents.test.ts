import { randomUUID, createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { CreateIntentResult } from '@qgroup/contracts';
import { fixture } from '../testsupport/fixture';
import { createApp } from './app';
import { createIntentKey } from './create-intents';
import { originalRequestSignature } from './legacy-local';
const origin='https://rebuild.example',stamp='2026-11-17T00:00:00+00:00';
const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function setup() {
  const db=openDatabase(':memory:');fixture(db);
  db.prepare("INSERT OR REPLACE INTO bot_settings VALUES(1,0,?,'before')").run(JSON.stringify({enabled:true,groups:[{id:'synthetic-group',name:'測試',replies:true,broadcast:true}]}));
  const app=createApp({db,origin,now:()=>new Date(stamp),activityBot:{enabled:true,baseURL:origin,keyboard:true,personalQueue:true}});await app.ready();
  cleanup.push(async()=>{await app.close();db.close();});
  async function account(id:string) {const cookie='kanban_session=fixture-'+id,session=(await app.inject({url:'/api/v2/session',headers:{cookie}})).json();return {cookie,origin,'x-account-scope':session.scope,'x-csrf-token':session.csrf};}
  const alice=await account('alice'),bob=await account('bob');
  const write=(url:string,payload:Record<string,unknown>,headers=alice,key=randomUUID())=>app.inject({method:'POST',url:'/api/v2/'+url,headers:{...headers,'idempotency-key':key},payload});
  const activity={values:{title:'原草稿',category:'约K',location:'台北',startsAt:'2099-12-23T18:00:00+08:00',deadline:'2099-12-22T18:00:00+08:00',capacity:0,description:'原文',durationHours:3,withdrawalDeadline:null,visibility:'public',timezone:'Asia/Taipei',minimumParticipants:0,feePolicy:'原費用',botEnabled:false,joinOwner:true},clientIntent:randomUUID()};
  const poll={title:'原投票',category:'约K',location:'台北',description:'原文',timezone:'Asia/Taipei',capacity:0,minimum_participants:0,fee_policy:'',deadline:'2099-12-22T18:00:00+08:00',bot_enabled:true,visibility:'public',client_intent:randomUUID(),time_mode:'exact',duration_hours:3,options:[{starts_at:'2099-12-23T18:00:00+08:00'},{starts_at:'2099-12-24T18:00:00+08:00'}]};
  const lookup=(kind:'activity'|'poll',intent:string,headers=alice)=>write('me/create-intents/view',{kind,intent},headers);
  const count=(table:string)=>db.prepare('SELECT count(*) AS n FROM '+table).get();
  return {db,app,alice,bob,write,activity,poll,lookup,count};
}
describe('durable original and native creation aliases',()=>{
  it('matches original key derivation and rejects non-UUID intents without partial writes',async()=>{
    const s=await setup();for(const [kind,text] of [['activity','create '],['poll','create time-poll ']] as const)expect(createIntentKey(kind,s.activity.clientIntent)).toBe(createHash('sha256').update(text+s.activity.clientIntent).digest('hex'));
    const before=s.count('events');expect((await s.write('activities/drafts',{...s.activity,clientIntent:'unknown'})).statusCode).toBe(400);expect((await s.write('time-polls',{...s.poll,client_intent:'unknown'})).statusCode).toBe(400);expect(s.count('events')).toEqual(before);expect(s.count('time_polls')).toEqual({n:0});expect(s.count('request_results')).toEqual({n:0});
  });
  it('binds independent request keys to one activity and preserves later edits without another audit',async()=>{
    const s=await setup(),first=await s.write('activities/drafts',s.activity);expect(first.statusCode).toBe(200);const {id}=first.json();
    expect((await s.write('activities/drafts',s.activity)).json()).toEqual(first.json());expect(s.db.prepare('SELECT count(*) AS n FROM events WHERE title=?').get('原草稿')).toEqual({n:1});expect(s.db.prepare('SELECT count(*) AS n FROM event_audit WHERE event_id=?').get(id)).toEqual({n:1});
    const saved=(await s.app.inject({url:'/api/v2/activities/'+id+'/draft',headers:s.alice})).json();expect((await s.app.inject({method:'PUT',url:'/api/v2/activities/'+id+'/draft',headers:{...s.alice,'idempotency-key':randomUUID()},payload:{revision:saved.revision,values:{...saved.values,title:'後續修改'}}})).statusCode).toBe(200);
    const before=s.count('request_results'),changed=await s.write('activities/drafts',{...s.activity,values:{...s.activity.values,title:'另一個本機版本'}});expect(changed.json().code).toBe('CREATE_INTENT_RESOLVED');expect(s.count('request_results')).toEqual(before);
    expect((await s.write('activities/drafts',s.activity)).json()).toEqual(first.json());expect(CreateIntentResult.parse((await s.lookup('activity',s.activity.clientIntent)).json())).toMatchObject({state:'existing',id,revision:2,route:'draft',canEdit:true});expect(s.db.prepare('SELECT title FROM events WHERE id=?').get(id)).toEqual({title:'後續修改'});
  });
  it('runs poll creation and its bot hook once across independent keys and exposes the current revision',async()=>{
    const s=await setup(),first=await s.write('time-polls',s.poll);expect(first.statusCode,first.body).toBe(200);const {id}=first.json();
    expect((await s.write('time-polls',s.poll)).json()).toEqual(first.json());expect(s.count('time_polls')).toEqual({n:1});expect(s.count('time_poll_options')).toEqual({n:2});expect(s.count('time_poll_history')).toEqual({n:1});expect(s.count('bot_outbox')).toEqual({n:1});
    const manage=await s.write('time-polls/'+id+'/manage',{action:'close',revision:1,confirm:true});expect(manage.statusCode,manage.body).toBe(200);
    expect((await s.write('time-polls',s.poll)).json().revision).toBe(2);const outbox=s.count('bot_outbox');expect((await s.write('time-polls',{...s.poll,title:'後續編輯'})).json().code).toBe('CREATE_INTENT_RESOLVED');expect(s.count('bot_outbox')).toEqual(outbox);expect(s.count('time_polls')).toEqual({n:1});expect((await s.lookup('poll',s.poll.client_intent)).json()).toMatchObject({state:'existing',id,revision:2,route:'poll',canEdit:false});
  });
  it('resolves imported Python event/poll receipts without rewriting their signature or creating entities',async()=>{
    const s=await setup();const p=(await s.write('time-polls',{...s.poll,client_intent:undefined})).json();
    const originals=[{kind:'activity' as const,intent:s.activity.clientIntent,path:'/api/events',result:{id:'listen',starts_at:'2099-12-12T06:00:00+00:00',owner_id:'PRIVATE_OWNER',invite_token:'PRIVATE_INVITE'}},{kind:'poll' as const,intent:s.poll.client_intent,path:'/api/time-polls',result:{id:p.id,time_poll:true,owner_id:'PRIVATE_OWNER'}}];
    for(const old of originals){const data={client_intent:old.intent,title:'原 Python 內容'},signature=originalRequestSignature('POST',old.path,data),key=createIntentKey(old.kind,old.intent),raw=JSON.stringify(old.result);s.db.prepare('INSERT INTO request_results VALUES(?,?,?,?,?,?)').run('alice',key,signature,raw,200,stamp);
      const result=await s.lookup(old.kind,old.intent);expect(result.statusCode,result.body).toBe(200);expect(result.json()).toMatchObject({state:'existing',id:old.result.id});expect(result.body).not.toMatch(/PRIVATE_|owner_id|invite_token/);
      expect((await s.write(old.kind==='activity'?'activities/drafts':'time-polls',old.kind==='activity'?s.activity:s.poll)).json().code).toBe('CREATE_INTENT_RESOLVED');expect(s.db.prepare('SELECT signature,response_json FROM request_results WHERE user_id=? AND request_key=?').get('alice',key)).toEqual({signature,response_json:raw});
    }expect(s.count('events')).toEqual({n:6});expect(s.count('time_polls')).toEqual({n:1});
  });
  it('does not infer missing from deleted targets, removed authority or an unknown original result',async()=>{
    const s=await setup(),a=(await s.write('activities/drafts',s.activity)).json(),p=(await s.write('time-polls',s.poll)).json(),events=s.count('events');
    s.db.prepare("UPDATE events SET status='deleted' WHERE id=?").run(a.id);expect((await s.lookup('activity',s.activity.clientIntent)).statusCode).toBe(404);expect((await s.write('activities/drafts',s.activity)).statusCode).toBe(404);expect(s.count('events')).toEqual(events);
    s.db.prepare("UPDATE events SET status='closed',owner_id='bob' WHERE id=?").run(a.id);expect((await s.lookup('activity',s.activity.clientIntent)).statusCode).toBe(404);expect((await s.write('activities/drafts',s.activity)).statusCode).toBe(404);
    s.db.prepare("UPDATE time_polls SET owner_id='bob' WHERE id=?").run(p.id);expect((await s.lookup('poll',s.poll.client_intent)).statusCode).toBe(403);expect((await s.write('time-polls',s.poll)).statusCode).toBe(403);s.db.prepare("UPDATE time_polls SET status='deleted' WHERE id=?").run(p.id);expect((await s.lookup('poll',s.poll.client_intent)).statusCode).toBe(404);expect(s.count('time_polls')).toEqual({n:1});
    s.db.prepare('UPDATE request_results SET response_json=? WHERE request_key=?').run('{"unexpected":true}',createIntentKey('activity',s.activity.clientIntent));expect((await s.lookup('activity',s.activity.clientIntent)).json().code).toBe('CREATE_INTENT_CONFLICT');expect((await s.write('activities/drafts',s.activity)).json().code).toBe('CREATE_INTENT_CONFLICT');expect(s.count('events')).toEqual(events);
  });
  it('isolates account aliases and enforces origin, scope and CSRF on read-only lookups',async()=>{
    const s=await setup();const first=(await s.write('activities/drafts',s.activity)).json();expect((await s.lookup('activity',s.activity.clientIntent,s.bob)).json()).toEqual({state:'missing'});
    const second=(await s.write('activities/drafts',s.activity,s.bob)).json();expect(second.id).not.toBe(first.id);expect((await s.lookup('activity',s.activity.clientIntent,s.alice)).json().id).toBe(first.id);expect((await s.lookup('activity',s.activity.clientIntent,s.bob)).json().id).toBe(second.id);
    const receipts=s.count('request_results');for(const patch of [{origin:'https://other.example'},{'x-account-scope':s.bob['x-account-scope']},{'x-csrf-token':'bad'},{cookie:''}])expect((await s.lookup('activity',s.activity.clientIntent,{...s.alice,...patch})).statusCode).toBeGreaterThanOrEqual(400);expect(s.count('request_results')).toEqual(receipts);
  });
  it('rolls back entity, audit, access, options, bot outbox and both receipts if the durable alias cannot commit',async()=>{
    const s=await setup(),before=['events','event_access','event_audit','request_results'].map(s.count);
    s.db.exec("CREATE TRIGGER reject_alias BEFORE INSERT ON request_results WHEN length(NEW.request_key)=64 BEGIN SELECT RAISE(ABORT,'synthetic alias failure'); END;");
    expect((await s.write('activities/drafts',s.activity)).statusCode).toBe(500);expect(['events','event_access','event_audit','request_results'].map(s.count)).toEqual(before);
    expect((await s.write('time-polls',s.poll)).statusCode).toBe(500);for(const table of ['time_polls','time_poll_options','time_poll_history','bot_outbox','request_results'])expect(s.count(table)).toEqual({n:0});
    s.db.exec('DROP TRIGGER reject_alias');expect((await s.write('activities/drafts',s.activity)).statusCode).toBe(200);expect((await s.write('time-polls',s.poll)).statusCode).toBe(200);
  });
});
