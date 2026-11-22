import { randomUUID, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { LegacyTimePollInspection, decodeLegacyTimePoll } from '@qgroup/contracts';
import { fixture } from '../testsupport/fixture';
import { createApp } from './app';
import { originalRequestSignature } from './legacy-local';
const origin = 'https://rebuild.example', stamp = '2026-11-17T00:00:00+00:00', commit = '8da877857f163853c449474e168534e2e493121b';
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {for (const close of cleanups.splice(0).reverse()) await close();});
async function setup(mode: 'exact'|'date' = 'exact') {
 const db = openDatabase(':memory:'); fixture(db);
 db.prepare('UPDATE bot_settings SET config_json=?').run(JSON.stringify({enabled:true,groups:[{id:'synthetic-group',name:'',broadcast:true,replies:true}]}));
 let moment = stamp;
 const app = createApp({db,origin,now:()=>new Date(moment),activityBot:{enabled:true,baseURL:origin,keyboard:true,personalQueue:true}});await app.ready();
 cleanups.push(async()=>{await app.close();db.close();});
 async function account(id:string){const cookie='kanban_session=fixture-'+id,s=(await app.inject({url:'/api/v2/session',headers:{cookie}})).json();return {cookie,origin,'x-account-scope':s.scope,'x-csrf-token':s.csrf};}
 const alice=await account('alice'),bob=await account('bob');
 const native=(path:string,data:unknown,h=alice,key=randomUUID())=>app.inject({method:'POST',url:'/api/v2/time-polls'+path,headers:{...h,'idempotency-key':key},payload:data as Record<string,unknown>});
 const r=await native('',{title:'原時間投票',category:'约K',location:'合成場地',timezone:'Asia/Taipei',capacity:8,minimum_participants:1,fee_policy:'依實際費用',description:'合成原安排',deadline:'2026-11-19T00:00:00Z',time_mode:mode,...(mode==='date'?{options:[{date:'2026-11-20'},{date:'2026-11-21'}]}:{duration_hours:3,options:[{starts_at:'2026-11-20T18:00:00+08:00'},{starts_at:'2026-11-21T18:00:00+08:00'}]})});expect(r.statusCode,r.body).toBe(200);const id=r.json().id as string;
 const read=async(h=alice)=>(await app.inject({url:'/api/v2/time-polls/'+id+(h===alice?'/manage':''),headers:h})).json();
 const p=await read();
 const input=(action='vote',patch:Record<string,unknown>={})=>({requestKey:randomBytes(16).toString('hex'),method:action==='vote'?'PUT' as const:'PATCH' as const,path:'/api/time-polls/'+id+(action==='vote'?'/votes':''),data:action==='vote'?{base_revision:1,choices:p.options.map((o:{id:string})=>({option_id:o.id,choice:'yes'})),...patch}:{base_revision:1,action,...patch}});
 const send=(payload:unknown,mode='inspect',h=alice)=>app.inject({method:'POST',url:'/api/v2/me/legacy-requests/time-poll/'+mode,headers:h,payload:payload as Record<string,unknown>});
 const snapshot=()=>Object.fromEntries(['time_polls','time_poll_options','time_poll_ballots','time_poll_votes','time_poll_history','events','event_access','event_conditions','attendees','roster_parties','attendee_consents','event_audit','notifications','bot_outbox','request_results'].map(t=>[t,db.prepare('SELECT * FROM '+t).all()]));
 const finalize=(patch:Record<string,unknown>={})=>input('finalize',{base_vote_revision:0,option_id:p.options[0].id,registration_deadline:'2026-11-19T00:00:00Z',accept_terms:true,reason:'場地可用',...(mode==='date'?{starts_at:'2026-11-20T18:00:00+08:00',duration_hours:3}:{}),...patch});
 return {db,app,alice,bob,id,p,input,send,snapshot,native,read,finalize,clock:(v:string)=>{moment=v;}};
}
async function prepared(s:Awaited<ReturnType<typeof setup>>,input:ReturnType<Awaited<ReturnType<typeof setup>>['input']>,h=s.alice){const before=s.snapshot(),r=await s.send(input,'inspect',h);expect(r.statusCode,r.body).toBe(200);const p=LegacyTimePollInspection.parse(r.json());expect(p.state).toBe('retryable');expect(s.snapshot()).toEqual(before);if(p.state!=='retryable')throw Error('not retryable');return {...input,confirm:true,recovery_token:p.recovery_token};}
describe('original time-poll operation recovery',()=>{
 it('keeps the original ballot body strict and refuses stale inspection after a newer native ballot',async()=>{
  const s=await setup(),original=s.input(),reviewed=await prepared(s,original,s.bob);
  expect((await s.send(s.input('vote',{ballot_token:(await s.read(s.bob)).ballot_token}),'inspect',s.bob)).statusCode).toBe(400);
  const p=await s.read(s.bob);
  expect((await s.native('/'+s.id+'/votes',{revision:p.revision,ballot_token:p.ballot_token,choices:p.options.map((o:{id:string})=>({option_id:o.id,choice:'no'}))},s.bob)).statusCode).toBe(200);
  const before=s.snapshot();expect((await s.send(reviewed,'retry',s.bob)).statusCode).toBe(409);expect(s.snapshot()).toEqual(before);
  const fresh=await prepared(s,original,s.bob);expect((await s.send(fresh,'retry',s.bob)).statusCode).toBe(200);
  expect(Object.values((await s.read(s.bob)).my_choices)).toEqual(['yes','yes']);
 });
 it('inspects without writes and preserves exact original ballot key/signature; repeated requests never increment votes twice',async()=>{
  const s=await setup(),i=s.input(),b=await prepared(s,i,s.bob);expect((await s.send(b,'retry',s.bob)).statusCode).toBe(200);const saved=s.snapshot();expect((await s.send(b,'retry',s.bob)).statusCode).toBe(200);expect(s.snapshot()).toEqual(saved);expect((await s.read()).vote_revision).toBe(1);expect(s.db.prepare('SELECT signature FROM request_results WHERE request_key=?').get(i.requestKey)).toEqual({signature:originalRequestSignature(i.method,i.path,i.data)});s.clock('2026-11-25T00:00:00Z');expect((await s.send(i,'inspect',s.bob)).json()).toMatchObject({state:'committed'});
 });
 it('retains expired votes while applying all active original choices without history or signup',async()=>{
  const s=await setup();await s.native('/'+s.id+'/votes',{revision:1,ballot_token:(await s.read(s.bob)).ballot_token,choices:s.p.options.map((o:{id:string})=>({option_id:o.id,choice:'maybe'}))},s.bob);
  s.db.prepare('UPDATE time_polls SET deadline=? WHERE id=?').run('2026-11-21T00:00:00+00:00',s.id);s.clock('2026-11-20T12:00:00Z');const before=s.snapshot(),i=s.input(),b=await prepared(s,i,s.bob);expect((await s.send(b,'retry',s.bob)).statusCode).toBe(200);expect((await s.read(s.bob)).my_choices).toEqual({[s.p.options[0].id]:'maybe',[s.p.options[1].id]:'yes'});expect(s.snapshot().time_poll_history).toEqual(before.time_poll_history);expect(s.snapshot().attendees).toEqual(before.attendees);
 });
 for(const action of ['close','extend','cancel','remove','bot_sync'])it('recovers '+action+' once with original arrangement revision and owner-only receipt',async()=>{
  const s=await setup(),i=s.input(action,action==='extend'?{deadline:'2026-11-20T00:00:00Z'}:action==='cancel'?{reason:'場地取消'}:action==='bot_sync'?{bot_enabled:false}:{}),b=await prepared(s,i);expect((await s.send(b,'retry')).statusCode).toBe(200);const saved=s.snapshot();expect((await s.send(b,'retry')).statusCode).toBe(200);expect(s.snapshot()).toEqual(saved);expect((await s.read()).revision).toBe(2);s.db.prepare('UPDATE time_polls SET owner_id=? WHERE id=?').run('bob',s.id);expect((await s.send(i)).statusCode).toBe(403);
 });
 it('inherits the current bot bit on omission and retains inactive exact/date fields only in the original signature',async()=>{
  const s=await setup(),i=s.input('bot_sync'),p=(await s.send(i)).json();expect(p.command.bot_enabled).toBe(true);const b=await prepared(s,i);s.db.prepare('UPDATE time_polls SET bot_enabled=0 WHERE id=?').run(s.id);const before=s.snapshot();expect((await s.send(b,'retry')).statusCode).toBe(409);expect(s.snapshot()).toEqual(before);
  const f=s.finalize({starts_at:'inactive invalid date',duration_hours:'inactive invalid duration'}),decoded=decodeLegacyTimePoll(f,{time_mode:'exact',bot_enabled:0});expect(decoded.input).not.toHaveProperty('starts_at');const fb=await prepared(s,f);expect((await s.send(fb,'retry')).statusCode).toBe(200);
 });
 for(const mode of ['exact','date'] as const)it('serializes concurrent '+mode+' finalization; creates one activity with owner consent and voter notification',async()=>{
  const s=await setup(mode);await s.native('/'+s.id+'/votes',{revision:1,ballot_token:(await s.read(s.bob)).ballot_token,choices:s.p.options.map((o:{id:string})=>({option_id:o.id,choice:'yes'}))},s.bob);const i=s.finalize({base_vote_revision:1}),b=await prepared(s,i);expect((await Promise.all([s.send(b,'retry'),s.send(b,'retry')])).map(r=>r.statusCode)).toEqual([200,200]);const p=await s.read(),event=p.event_id;expect(s.db.prepare('SELECT * FROM attendees WHERE event_id=?').all(event)).toMatchObject([{user_id:'alice',accepted_conditions_version:1,confirmation_state:'accepted'}]);expect(s.db.prepare("SELECT * FROM notifications WHERE event_id=? AND kind='time_poll_finalized'").all(event)).toMatchObject([{user_id:'bob'}]);const saved=s.snapshot();expect((await s.send(i)).json()).toMatchObject({state:'committed'});expect((await s.send(b,'retry')).statusCode).toBe(200);expect(s.snapshot()).toEqual(saved);
 });
 it('requires original term acceptance, exact vote revision, correct date and valid registration deadline before any creation',async()=>{
  const s=await setup('date'),before=s.snapshot();for(const patch of [{accept_terms:false},{base_vote_revision:1},{starts_at:'2026-11-22T18:00:00+08:00'},{duration_hours:0},{registration_deadline:'2026-11-25T00:00:00Z'},{reason:''}])expect((await s.send(s.finalize(patch))).statusCode).toBeGreaterThanOrEqual(400);expect(s.snapshot()).toEqual(before);
 });
 it('fences title, counts, owner name and policy changes without updating the original request',async()=>{
  for(const sql of ["UPDATE time_polls SET title='changed'", "UPDATE time_polls SET vote_revision=vote_revision+1", "UPDATE users SET nickname='changed' WHERE id='alice'", "UPDATE bot_settings SET config_json='{\"enabled\":false}'"]){const s=await setup(),i=s.finalize(),b=await prepared(s,i);s.db.exec(sql);const before=s.snapshot();expect((await s.send(b,'retry')).statusCode).toBe(409);expect(s.snapshot()).toEqual(before);}
 });
 it('rejects malformed, missing, duplicate, foreign or incomplete active choices and unknown original fields',async()=>{
  const s=await setup(),before=s.snapshot();for(const choices of [[],[{option_id:'foreign',choice:'yes'}],[{option_id:s.p.options[0].id,choice:'yes'},{option_id:s.p.options[0].id,choice:'yes'}],s.p.options.map((o:{id:string})=>({option_id:o.id,choice:'invalid'}))])expect((await s.send(s.input('vote',{choices}))).statusCode).toBeGreaterThanOrEqual(400);expect((await s.send(s.input('close',{future_rule:true}))).statusCode).toBe(400);expect(s.snapshot()).toEqual(before);
 });
 it('blocks unsupported routes, stale revisions, final polls, invalid confirmation and request conflicts',async()=>{
  const s=await setup(),i=s.input('close'),b=await prepared(s,i),before=s.snapshot();for(const raw of [i,{...b,confirm:false},{...b,recovery_token:'0'.repeat(64)},{...b,requestKey:'f'.repeat(32)},{...b,data:{...i.data,base_revision:2}},{...b,path:i.path+'/unsupported'}])expect((await s.send(raw,'retry')).statusCode).toBeGreaterThanOrEqual(400);expect(s.snapshot()).toEqual(before);expect((await s.send(b,'retry')).statusCode).toBe(200);const saved=s.snapshot();expect((await s.send({...b,data:{...i.data,reason:'changed'}},'retry')).statusCode).toBe(409);expect(s.snapshot()).toEqual(saved);
 });
 it('requires current member scope, origin, CSRF and current management owner before inspect and replay',async()=>{
  const s=await setup(),i=s.input('close'),b=await prepared(s,i),before=s.snapshot();for(const h of [s.bob,{...s.alice,cookie:''},{...s.alice,origin:'https://outside.example'},{...s.alice,'x-csrf-token':'invalid'},{...s.alice,'x-account-scope':s.bob['x-account-scope']}])for(const mode of ['inspect','retry'])expect((await s.send(mode==='inspect'?i:b,mode,h)).statusCode).toBeGreaterThanOrEqual(400);expect(s.snapshot()).toEqual(before);
 });
 it('acknowledges imported deleted owner receipts without exposing private frozen data or allowing uncommitted recreation',async()=>{
  const s=await setup(),i=s.input('remove'),b=await prepared(s,i);s.db.prepare('INSERT INTO request_results VALUES(?,?,?,?,?,?)').run('alice',i.requestKey,originalRequestSignature(i.method,i.path,i.data),JSON.stringify({id:s.id,status:'deleted',respondents:['PRIVATE']}),200,'before');s.db.prepare("UPDATE time_polls SET status='deleted',revision=revision+1 WHERE id=?").run(s.id);const before=s.snapshot();for(const mode of ['inspect','retry']){const r=await s.send(mode==='inspect'?i:b,mode);expect(r.statusCode).toBe(200);expect(r.body).not.toContain('PRIVATE');}expect(s.snapshot()).toEqual(before);expect((await s.send(s.input('remove'))).statusCode).toBe(404);
  for(const raw of ['{','null','[]','{"id":"foreign","time_poll":true}','{"id":"'+s.id+'"}']){s.db.prepare('UPDATE request_results SET response_json=? WHERE request_key=?').run(raw,i.requestKey);expect((await s.send(i)).statusCode).toBe(409);}
 });
 it('rolls back event, owner signup, history, notifications and receipt together on a required failure',async()=>{
  const s=await setup(),i=s.finalize(),b=await prepared(s,i);s.db.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON request_results BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");const before=s.snapshot();expect((await s.send(b,'retry')).statusCode).toBe(500);expect(s.snapshot()).toEqual(before);
 });
 it('isolates optional publication hooks while preserving required finalization and original receipt',async()=>{
  const s=await setup(),i=s.finalize(),b=await prepared(s,i);s.db.exec("CREATE TRIGGER reject_jobs BEFORE INSERT ON bot_outbox BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");expect((await s.send(b,'retry')).statusCode).toBe(200);expect((await s.read()).status).toBe('finalized');expect(s.db.prepare('SELECT * FROM request_results WHERE request_key=?').all(i.requestKey)).toHaveLength(1);
 });
 it('requires explicit eligible bot retry, queues once and does not turn uncertain or sent deliveries into a new send',async()=>{
  const s=await setup(),row=s.db.prepare('SELECT id FROM bot_outbox WHERE poll_id=?').get(s.id) as {id:number},i=s.input('bot_retry',{outbox_id:row.id});expect((await s.send(i)).statusCode).toBe(409);s.db.prepare("UPDATE bot_outbox SET status='skipped',simulated_at=?,last_error='dry-run' WHERE id=?").run(stamp,row.id);const b=await prepared(s,i);expect((await s.send(b,'retry')).statusCode).toBe(200);const saved=s.snapshot();expect((await s.send(b,'retry')).statusCode).toBe(200);expect(s.snapshot()).toEqual(saved);expect(s.db.prepare('SELECT * FROM bot_outbox WHERE poll_id=?').all(s.id)).toHaveLength(2);
  for(const status of ['sent','sending']){s.db.prepare('DELETE FROM bot_outbox WHERE poll_id=? AND id!=?').run(s.id,row.id);s.db.prepare('UPDATE bot_outbox SET status=?,simulated_at=NULL WHERE id=?').run(status,row.id);expect((await s.send(s.input('bot_retry',{base_revision:2,outbox_id:row.id}))).statusCode).toBe(409);}
 });
 it('fences retry targets/templates and rolls back required enqueue failure with no history or receipt',async()=>{
  const s=await setup(),row=s.db.prepare('SELECT id FROM bot_outbox WHERE poll_id=?').get(s.id) as {id:number};s.db.prepare("UPDATE bot_outbox SET status='failed',last_error='known reject' WHERE id=?").run(row.id);const i=s.input('bot_retry',{outbox_id:row.id}),b=await prepared(s,i);s.db.prepare('UPDATE bot_settings SET config_json=?').run(JSON.stringify({enabled:true,groups:[{id:'another-synthetic',name:'',broadcast:true,replies:true}]}));const before=s.snapshot();expect((await s.send(b,'retry')).statusCode).toBe(409);expect(s.snapshot()).toEqual(before);const fresh=await prepared(s,i);s.db.exec("CREATE TRIGGER reject_jobs BEFORE INSERT ON bot_outbox BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");expect((await s.send(fresh,'retry')).statusCode).toBe(500);expect(s.snapshot()).toEqual(before);
 });
 it('does not replace a native receipt with a legacy request using its UUID',async()=>{const s=await setup(),i={...s.input('close'),requestKey:randomUUID()};expect((await s.native('/'+s.id+'/manage',{revision:1,confirm:true,action:'close'},s.alice,i.requestKey)).statusCode).toBe(200);const before=s.snapshot();expect((await s.send(i)).statusCode).toBe(409);expect(s.snapshot()).toEqual(before);});
 it('matches fixed original Python votes and all management business records on synthetic source copies',async()=>{
  const root=mkdtempSync(join(tmpdir(),'qgroup-legacy-poll-diff-')),source=join(root,'original');mkdirSync(source);
  try {
   execFileSync('tar',['-xf','-','-C',source],{input:execFileSync('git',['archive',commit,'qgroup_core','qgroup_bot'],{maxBuffer:32*1024*1024})});
   for(const action of ['vote','close','extend','cancel','remove','bot_sync','bot_retry','finalize','date-finalize']) {
    const s=await setup(action==='date-finalize'?'date':'exact');let i=s.input(action==='date-finalize'?'finalize':action,action==='extend'?{deadline:'2026-11-20T00:00:00Z'}:action==='cancel'?{reason:'場地取消'}:action==='bot_sync'?{bot_enabled:false}:{});
    if(action.endsWith('finalize'))i=s.finalize();if(action==='bot_retry'){const row=s.db.prepare('SELECT id FROM bot_outbox WHERE poll_id=?').get(s.id) as {id:number};s.db.prepare("UPDATE bot_outbox SET status='failed',last_error='known reject' WHERE id=?").run(row.id);i=s.input(action,{outbox_id:row.id});}
    const path=join(root,action+'.sqlite3');await s.db.backup(path);
    const tables=['time_polls','time_poll_ballots','time_poll_votes','time_poll_history','events','event_access','event_conditions','attendees','roster_parties','attendee_consents','event_audit','notifications','bot_outbox'];
    const expected=JSON.parse(execFileSync('python3',['-c',`import datetime,json,sqlite3,socket,sys
sys.path.insert(0,sys.argv[1]);socket.socket=lambda *a,**k:(_ for _ in ()).throw(AssertionError('No network'))
from qgroup_core import time_polls,events,audit,conditions,roster,bot_outbox,bot_views,bot_settings,lifecycle
for module in (time_polls,events,audit,conditions,roster,bot_outbox,bot_views,bot_settings,lifecycle):module.now=lambda:'${stamp}'
class Frozen(datetime.datetime):
 @classmethod
 def now(cls,tz=None):return datetime.datetime.fromisoformat('${stamp}').astimezone(tz)
bot_outbox.datetime=Frozen
db=sqlite3.connect(sys.argv[2]);db.row_factory=sqlite3.Row
user=db.execute("SELECT * FROM users WHERE id='alice'").fetchone();poll=time_polls.get(db,sys.argv[3]);data=json.loads(sys.argv[4])
(time_polls.vote if sys.argv[5]=='vote' else time_polls.manage)(db,poll,user,data)
print(json.dumps({t:[dict(r) for r in db.execute('SELECT * FROM '+t)] for t in json.loads(sys.argv[6])}))`,source,path,s.id,JSON.stringify(i.data),action,JSON.stringify(tables)],{encoding:'utf8',timeout:15000,env:{PATH:process.env.PATH,PYTHONDONTWRITEBYTECODE:'1',KANBAN_BOT_ENABLED:'1',KANBAN_BOT_BASE_URL:origin,KANBAN_BOT_KEYBOARD:'1',KANBAN_BOT_PERSONAL_QUEUE:'1'}}));
    const b=await prepared(s,i);expect((await s.send(b,'retry')).statusCode).toBe(200);const actual=Object.fromEntries(tables.map(t=>[t,s.db.prepare('SELECT * FROM '+t).all()]));
    function normalize(value:Record<string,unknown>) {
     const events=value.events as {id:string;invite_token:string}[],event=events.find(e=>e.id === (value.time_polls as {event_id:string|null}[]).find(p=>p.event_id)?.event_id);let raw=JSON.stringify(value);
     if(event){const attendee=(value.attendees as {id:string;party_id:string;event_id:string}[]).find(a=>a.event_id===event.id)!;for(const [from,to] of [[event.id,'EVENT'],[event.invite_token,'INVITE'],[attendee.id,'PERSON'],[attendee.party_id,'PARTY']])raw=raw.replaceAll(from!,to!);}
     const v=JSON.parse(raw);for(const rows of Object.values(v))if(Array.isArray(rows))for(const row of rows)for(const key of ['snapshot_json','details_json','before_json','after_json','payload_json','result_json'])if(typeof row[key]==='string')row[key]=JSON.parse(row[key]);
     if(action==='bot_retry')v.bot_outbox.at(-1).dedupe_key='RANDOM_RETRY';return v;
    }
    expect(normalize(actual),action).toEqual(normalize(expected));
   }
  }finally{rmSync(root,{recursive:true,force:true});}
 });
});
