import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { decodeLegacyRooms } from '@qgroup/contracts';
import { fixture } from '../testsupport/fixture';
import { createApp } from './app';
import { accountKey } from './finance-context';
import { eventRow } from './activity-arrangements';
import { originalRequestSignature } from './legacy-local';
const origin='https://rebuild.example',stamp='2026-11-17T00:00:00+00:00',a=accountKey('listen','alice'),b=accountKey('listen','bob'),p1='aaaaaaaaaaaaaaaa',p2='bbbbbbbbbbbbbbbb',r1='1111111111111111';
const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function setup(){
 const db=openDatabase(':memory:');fixture(db);
 db.exec(`UPDATE events SET bot_enabled=1 WHERE id='listen'; INSERT INTO event_roles VALUES('helper','listen','bob','["settlement"]','before'); INSERT INTO attendees(id,event_id,manager_id,user_id,name,payer_kind,status,created_at,updated_at) VALUES('${p1}','listen','alice','alice','','self','confirmed','before','before'),('${p2}','listen','bob','bob','','self','waiting','before','before')`);
 const app=createApp({db,origin,now:()=>new Date(stamp)});await app.ready();cleanup.push(async()=>{await app.close();db.close();});
 async function headers(id:string){const cookie='kanban_session=fixture-'+id,s=(await app.inject({url:'/api/v2/session',headers:{cookie}})).json();return {cookie,origin,'x-account-scope':s.scope,'x-csrf-token':s.csrf};}
 const alice=await headers('alice'),bob=await headers('bob');
 const input=(patch:object={})=>({requestKey:randomBytes(16).toString('hex'),method:'PUT' as const,path:'/api/events/listen/rooms',data:{base_revision:eventRow(db,'listen')!.revision,rooms:[{id:r1,name:' 原包間 ',payer_id:a,person_ids:[p2,p1],payer_name:'原顯示姓名',payer_label:{ignored:true}}],reason:' 原分配依據 ',...patch}});
 const send=(body:object,mode='inspect',h=alice)=>app.inject({method:'POST',url:'/api/v2/me/legacy-requests/rooms/'+mode,headers:h,payload:body});
 const snapshot=()=>db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>{const name=(row as {name:string}).name;return [name,db.prepare('SELECT * FROM "'+name+'"').all()];});
 const view=()=>app.inject({url:'/api/v2/activities/listen/rooms',headers:alice});
 return {db,app,alice,bob,input,send,snapshot,view};
}
type Setup=Awaited<ReturnType<typeof setup>>;
type Input=ReturnType<Setup['input']>;
async function prepared(s:Setup,input:Input){const before=s.snapshot(),p=await s.send(input);expect(p.statusCode,p.body).toBe(200);expect(p.json().state).toBe('retryable');expect(s.snapshot()).toEqual(before);return {...input,confirm:true,recovery_token:p.json().recovery_token};}
async function python(s:Setup,input:Input){
 const root=mkdtempSync(join(tmpdir(),'qgroup-original-room-recovery-')),path=join(root,'synthetic.sqlite3');
 try{await s.db.backup(path);return JSON.parse(execFileSync('python3',['-c',`import datetime,json,sqlite3,sys
from qgroup_core import rooms,audit,common
class Frozen(datetime.datetime):
 @classmethod
 def now(cls,tz=None):return datetime.datetime.fromisoformat('${stamp}').astimezone(tz)
common.datetime=Frozen
db=sqlite3.connect(sys.argv[1]);db.row_factory=sqlite3.Row
event=db.execute("SELECT * FROM events WHERE id='listen'").fetchone();user=db.execute("SELECT * FROM users WHERE id='alice'").fetchone();data=json.loads(sys.argv[2])
audit.require_revision(event,data);rooms.save_plan(db,event,user,data);db.commit()
print(json.dumps(dict(rooms=rooms.plan(db,'listen'),revision=db.execute("SELECT revision FROM events WHERE id='listen'").fetchone()[0],audit=[dict(r) for r in db.execute("SELECT action,before_json,after_json,reason FROM event_audit WHERE event_id='listen' ORDER BY version")],outbox=[dict(r) for r in db.execute('SELECT * FROM bot_outbox')])))`,path,JSON.stringify(input.data)],{encoding:'utf8',env:{PATH:process.env.PATH,LANG:'en_US.UTF-8'}}));}finally{rmSync(root,{recursive:true,force:true});}
}
describe('original room request recovery',()=>{
 it('preserves Python whitespace rules for room names and reasons through raw request recovery',async()=>{
  const s=await setup();
  for(const edge of ['\u0085','\u001c','\ufeff']) {
   const room=s.input().data.rooms[0]!,input=s.input({rooms:[{...room,name:edge+'房'+edge}],reason:edge+'核對'+edge}),expected=await python(s,input),body=await prepared(s,input);
   const result=await s.send(body,'retry');expect(result.statusCode,result.body).toBe(200);
   expect((await s.view()).json().rooms).toEqual(expected.rooms);
   const rows=s.db.prepare("SELECT action,before_json,after_json,reason FROM event_audit WHERE event_id='listen' ORDER BY version").all();
   expect(rows.map((r:any)=>({...r,before_json:JSON.parse(r.before_json),after_json:JSON.parse(r.after_json)})))
    .toEqual(expected.audit.map((r:any)=>({...r,before_json:JSON.parse(r.before_json),after_json:JSON.parse(r.after_json)})));
  }
 });
 it('matches original Python persistence, ordering, audit and bot work with raw signatures and labels preserved',async()=>{
  const s=await setup(),input=s.input(),expected=await python(s,input),body=await prepared(s,input),inspection=(await s.send(input)).json();
  expect(inspection.rooms).toEqual(expected.rooms);expect(inspection.rooms[0].person_ids).toEqual([p1,p2]);expect(inspection.current.rooms).toEqual([]);
  expect((await s.send(body,'retry')).statusCode).toBe(200);expect((await s.view()).json().rooms).toEqual(expected.rooms);expect(eventRow(s.db,'listen')!.revision).toBe(expected.revision);
  const audit=s.db.prepare("SELECT action,before_json,after_json,reason FROM event_audit WHERE event_id='listen' ORDER BY version").all();expect(audit.map(row=>{const r=row as {before_json:string;after_json:string};return {...r,before_json:JSON.parse(r.before_json),after_json:JSON.parse(r.after_json)};})).toEqual(expected.audit.map((r:{before_json:string;after_json:string})=>({...r,before_json:JSON.parse(r.before_json),after_json:JSON.parse(r.after_json)})));
  expect(s.db.prepare('SELECT * FROM bot_outbox').all()).toEqual(expected.outbox);
  const receipt=s.db.prepare('SELECT signature,response_json FROM request_results WHERE request_key=?').get(input.requestKey) as {signature:string;response_json:string};expect(receipt.signature).toBe(originalRequestSignature(input.method,input.path,input.data));expect(JSON.parse(receipt.response_json)).toEqual({id:'listen',starts_at:eventRow(s.db,'listen')!.starts_at});
 });
 it('matches Python no-op and appends only receipts when the original plan is unchanged',async()=>{
  const s=await setup(),first=s.input();expect((await s.send(await prepared(s,first),'retry')).statusCode).toBe(200);const input=s.input(),expected=await python(s,input),body=await prepared(s,input);expect((await s.send(input)).json().changed).toBe(false);expect((await s.send(body,'retry')).statusCode).toBe(200);expect(eventRow(s.db,'listen')!.revision).toBe(expected.revision);expect(s.db.prepare('SELECT * FROM event_room_plans').all()).toHaveLength(1);expect(s.db.prepare("SELECT * FROM event_audit WHERE action='rooms_updated'").all()).toHaveLength(1);
 });
 it('serializes concurrent retries and never mutates again when a matching original receipt exists',async()=>{
  const s=await setup(),input=s.input(),body=await prepared(s,input);expect((await Promise.all([s.send(body,'retry'),s.send(body,'retry')])).map(r=>r.statusCode)).toEqual([200,200]);const before=s.snapshot();s.db.exec("UPDATE events SET lifecycle='cancelled',revision=revision+1 WHERE id='listen'");const committed=s.snapshot();for(const mode of ['inspect','retry']){const r=await s.send(mode==='inspect'?input:body,mode);expect(r.statusCode,r.body).toBe(200);expect(r.json()).toMatchObject(mode==='inspect'?{state:'committed'}:{committed:true});}expect(s.snapshot()).toEqual(committed);expect(before).not.toEqual(committed);expect(s.db.prepare('SELECT * FROM event_room_plans').all()).toHaveLength(1);
 });
 it('does not expose frozen private results and refuses corrupt or wrong-target receipts',async()=>{
  const s=await setup(),input=s.input(),body=await prepared(s,input),signature=originalRequestSignature(input.method,input.path,input.data);s.db.prepare('INSERT INTO request_results VALUES(?,?,?,?,?,?)').run('alice',input.requestKey,signature,JSON.stringify({id:'listen',starts_at:'before',private_note:'PRIVATE'}),200,'before');const saved=s.snapshot();for(const mode of ['inspect','retry']){const result=await s.send(mode==='inspect'?input:body,mode);expect(result.statusCode).toBe(200);expect(result.body).not.toContain('PRIVATE');}expect(s.snapshot()).toEqual(saved);
  for(const raw of ['{','null','[]','{"id":"karaoke"}']){s.db.prepare('UPDATE request_results SET response_json=? WHERE request_key=?').run(raw,input.requestKey);const before=s.snapshot();for(const mode of ['inspect','retry'])expect((await s.send(mode==='inspect'?input:body,mode)).statusCode).toBe(409);expect(s.snapshot()).toEqual(before);}
 });
 it('rejects changed original bytes, reused native keys and missing explicit recovery confirmation',async()=>{
  const s=await setup(),input=s.input(),body=await prepared(s,input),before=s.snapshot();for(const raw of [input,{...body,confirm:false},{...body,recovery_token:'0'.repeat(64)},{...body,data:{...input.data,reason:'different reason'}},{...body,requestKey:'f'.repeat(32)}])expect((await s.send(raw,'retry')).statusCode).toBeGreaterThanOrEqual(400);expect(s.snapshot()).toEqual(before);
  expect((await s.send(body,'retry')).statusCode).toBe(200);const saved=s.snapshot();expect((await s.send({...body,data:{...input.data,reason:'changed'}},'retry')).statusCode).toBe(409);expect(s.snapshot()).toEqual(saved);s.db.prepare('UPDATE request_results SET signature=? WHERE request_key=?').run('rooms:native',input.requestKey);expect((await s.send(body,'retry')).statusCode).toBe(409);
 });
 it('refuses a real native receipt using the same UUID without replacing either request',async()=>{const s=await setup(),input={...s.input(),requestKey:randomUUID()},native=decodeLegacyRooms(input);const r=await s.app.inject({method:'POST',url:'/api/v2/activities/listen/rooms',headers:{...s.alice,'idempotency-key':input.requestKey},payload:native.input});expect(r.statusCode,r.body).toBe(200);const before=s.snapshot();expect((await s.send(input)).statusCode).toBe(409);expect(s.snapshot()).toEqual(before);});
 it('rejects stale revisions and fences changed review names without silently updating the original payload',async()=>{
  const s=await setup(),input=s.input(),body=await prepared(s,input);s.db.exec("UPDATE users SET nickname='新稱呼' WHERE id='bob'");const before=s.snapshot();expect((await s.send(body,'retry')).statusCode).toBe(409);expect(s.snapshot()).toEqual(before);const fresh=await prepared(s,input);expect(fresh.data).toEqual(input.data);s.db.exec("UPDATE events SET revision=revision+1 WHERE id='listen'");const stale=s.snapshot();for(const mode of ['inspect','retry'])expect((await s.send(mode==='inspect'?input:fresh,mode)).statusCode).toBe(409);expect(s.snapshot()).toEqual(stale);
 });
 it('enforces current owner, activity access, origin, CSRF and account scope for preparation and cached recovery',async()=>{
  const s=await setup(),input=s.input(),body=await prepared(s,input),before=s.snapshot();for(const h of [s.bob,{...s.alice,cookie:''},{...s.alice,origin:'https://elsewhere.example'},{...s.alice,'x-csrf-token':'invalid'},{...s.alice,'x-account-scope':s.bob['x-account-scope']}])for(const mode of ['inspect','retry'])expect((await s.send(mode==='inspect'?input:body,mode,h)).statusCode).toBeGreaterThanOrEqual(400);expect(s.snapshot()).toEqual(before);expect((await s.send(body,'retry')).statusCode).toBe(200);s.db.exec("UPDATE events SET owner_id='bob' WHERE id='listen'");const saved=s.snapshot();for(const mode of ['inspect','retry'])expect((await s.send(mode==='inspect'?input:body,mode)).statusCode).toBe(403);expect(s.snapshot()).toEqual(saved);
 });
 for(const change of ["lifecycle='draft'","lifecycle='cancelled'","archived_at='before'"])it('blocks an uncommitted original request for '+change,async()=>{const s=await setup(),input=s.input(),body=await prepared(s,input);s.db.exec("UPDATE events SET "+change+" WHERE id='listen'");const before=s.snapshot();for(const mode of ['inspect','retry'])expect((await s.send(mode==='inspect'?input:body,mode)).statusCode).toBe(409);expect(s.snapshot()).toEqual(before);});
 it('blocks original plan recovery after a bill has been published',async()=>{const s=await setup(),input=s.input(),body=await prepared(s,input);s.db.exec("INSERT INTO settlement_history(event_id,version,total_cents,headcount,note,updated_at,actor_id,actor_name,kind,changed_fields) VALUES('listen',1,0,1,'','before','alice','小青','published','[]')");const before=s.snapshot();for(const mode of ['inspect','retry'])expect((await s.send(mode==='inspect'?input:body,mode)).statusCode).toBe(409);expect(s.snapshot()).toEqual(before);});
 it('blocks invalid members, duplicate Unicode names, foreign payers, unknown fields and final settlement payloads',async()=>{
  const s=await setup(),input=s.input(),room=input.data.rooms[0]!,before=s.snapshot();for(const rooms of [[{...room,person_ids:[p1,p1]}],[{...room,person_ids:['foreign']}],[{...room,payer_id:'account:0000000000000000'}],[{...room,name:'Straße'},{...room,id:'2222222222222222',name:'STRASSE',person_ids:[]}],[{...room,amount:'10'}]])expect((await s.send(s.input({rooms}))).statusCode).toBe(400);expect((await s.send(s.input({future_rule:true}))).statusCode).toBe(400);expect(()=>decodeLegacyRooms({...input,method:'POST'})).toThrow();s.db.exec(`UPDATE attendees SET status='withdrawn' WHERE id='${p2}'`);expect((await s.send(input)).statusCode).toBe(400);expect(before).not.toEqual(s.snapshot());
 });
 it('keeps room IDs referenced by money and rolls back plan/audit/receipt atomically on receipt failure',async()=>{
  const s=await setup(),input=s.input(),body=await prepared(s,input);s.db.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON request_results BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");const before=s.snapshot();expect((await s.send(body,'retry')).statusCode).toBe(500);expect(s.snapshot()).toEqual(before);s.db.exec('DROP TRIGGER reject_receipt');expect((await s.send(body,'retry')).statusCode).toBe(200);
  const view=(await s.app.inject({url:'/api/v2/activities/listen/finance',headers:s.alice})).json(),operation={command:'record',id:'cccccccccccccccc',transaction:{kind:'expense',amount:'1',occurred_at:'2026-11-17T00:00:00Z',funding:'payer',payer_id:a,merchant:'店家',room_id:r1,note:'',reason:'',method:'other'}},p=await s.app.inject({method:'POST',url:'/api/v2/activities/listen/finance/preview',headers:s.alice,payload:{revision:view.revision,operation}});expect(p.statusCode,p.body).toBe(200);const written=await s.app.inject({method:'POST',url:'/api/v2/activities/listen/finance',headers:{...s.alice,'idempotency-key':randomUUID()},payload:{revision:view.revision,operation,preview_token:p.json().preview_token,confirm:true}});expect(written.statusCode,written.body).toBe(200);
  const removed=s.input({rooms:[]}),saved=s.snapshot();expect((await s.send(removed)).statusCode).toBe(409);expect(s.snapshot()).toEqual(saved);expect(()=>s.db.exec("DELETE FROM event_room_plans")).toThrow(/append-only/);expect(b).not.toBe(a);
 });
});
