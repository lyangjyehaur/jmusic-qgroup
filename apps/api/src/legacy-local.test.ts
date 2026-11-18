import { afterEach,describe,it,expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { openDatabase } from '@qgroup/database';
import { createApp,accountScope } from './app';
import { fixture } from '../testsupport/fixture';
import { timePollFixture } from '../testsupport/time-poll-fixture';
import { originalJSON,originalRequestSignature } from './legacy-local';
const close:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const cleanup of close.splice(0).reverse())await cleanup();});
async function setup(){
  const db=openDatabase(':memory:');fixture(db);timePollFixture(db);const origin='https://rebuild.example',app=createApp({db,origin});await app.ready();
  close.push(async()=>{await app.close();db.close();});
  const user=async(id='alice')=>(await app.inject({url:'/api/v2/session',headers:{cookie:'kanban_session=fixture-'+id}})).json();
  const alice=await user();
  const input={requestKey:'a'.repeat(64),method:'POST' as const,path:'/api/events',data:{client_intent:'original-intent',title:'原活動',base_revision:2}};
  const insert=(result:object,data=input,owner='alice',signature=originalRequestSignature(data.method,data.path,data.data))=>db.prepare('INSERT INTO request_results VALUES(?,?,?,?,?,?)').run(owner,data.requestKey,signature,JSON.stringify(result),200,'before');
  const send=(data:object=input,headers={})=>app.inject({method:'POST',url:'/api/v2/me/legacy-requests/check',payload:data,headers:{cookie:'kanban_session=fixture-alice',origin,'x-account-scope':alice.scope,'x-csrf-token':alice.csrf,...headers}});
  return{app,db,input,insert,send,user,origin};
}
describe('read-only original browser request receipts',()=>{
  it('matches Python sorted Unicode JSON signatures, including original float wire encodings',()=>{
    const values=[{title:'原文\\\n😀',fields:[false,null,2], '\u{10000}':'astral','\ue000':'bmp'},[0.000001,0.00001,0.0001,0.001,1.234e-7,1e21,1.12e22,1e-12,1000000000000000100,1.25,0,-0],{x:{c:true,a:'值'},b:[]}];
    const expected=JSON.parse(execFileSync('python3',['-c','import json,sys; print(json.dumps([json.dumps(v,sort_keys=True,ensure_ascii=False) for v in json.load(sys.stdin)],ensure_ascii=False))'],{input:JSON.stringify(values),encoding:'utf8'}));
    expect(values.map(originalJSON)).toEqual(expected);
  });
  it('uses exact original keys and payload, gives a current destination without exposing a frozen owner response',async()=>{
    const s=await setup();s.insert({id:'listen',starts_at:'before',participants:[{private:'must not return'}],invite_token:'private'});const before=s.db.prepare('SELECT * FROM request_results').all(),outbox=s.db.prepare('SELECT * FROM bot_outbox').all();
    expect((await s.send()).json()).toEqual({committed:true,target:{kind:'activity',id:'listen'}});expect((await s.send()).json()).toEqual({committed:true,target:{kind:'activity',id:'listen'}});
    expect(s.db.prepare('SELECT * FROM request_results').all()).toEqual(before);expect(s.db.prepare('SELECT * FROM bot_outbox').all()).toEqual(outbox);
  });
  it('missing receipts never authorize a replacement or create business data',async()=>{
    const s=await setup(),before=s.db.prepare('SELECT * FROM events').all();expect((await s.send()).json()).toEqual({committed:false});expect(s.db.prepare('SELECT * FROM events').all()).toEqual(before);
  });
  it('rejects changed original content, method and route and never treats a v2 receipt as the original',async()=>{
    const s=await setup();s.insert({id:'listen',starts_at:'before'});
    for(const patch of [{data:{...s.input.data,title:'changed'}},{method:'PUT'},{path:'/api/time-polls'}])expect((await s.send({...s.input,...patch})).statusCode).toBe(409);
    s.db.prepare("UPDATE request_results SET signature='activity-draft:v2'").run();expect((await s.send()).statusCode).toBe(409);
  });
  it('isolates accounts and requires live scope, origin and CSRF even for original queries',async()=>{
    const s=await setup();s.insert({id:'listen',starts_at:'before'},s.input,'bob');expect((await s.send()).json()).toEqual({committed:false});
    for(const patch of [{'x-account-scope':accountScope('bob')},{origin:'https://elsewhere.example'},{'x-csrf-token':'x'}, {cookie:''}])expect((await s.send(s.input,patch)).statusCode).toBeGreaterThanOrEqual(400);
  });
  it('rechecks private/deleted destinations and deleted polls, while non-resource receipts return only completion',async()=>{
    const s=await setup();s.insert({id:'invite',starts_at:'before'});s.db.prepare("UPDATE events SET owner_id='bob' WHERE id='invite'").run();expect((await s.send()).statusCode).toBe(404);
    s.db.prepare("UPDATE request_results SET response_json=?").run(JSON.stringify({id:'deleted',starts_at:'before'}));expect((await s.send()).statusCode).toBe(404);
    s.db.prepare("UPDATE request_results SET response_json=?").run(JSON.stringify({nickname:'private original',token:'secret'}));expect((await s.send()).json()).toEqual({committed:true});
    const poll=(s.db.prepare("SELECT id FROM time_polls LIMIT 1").get() as {id:string}).id;s.db.prepare("UPDATE request_results SET response_json=?").run(JSON.stringify({id:poll,time_poll:true,private:'hidden'}));
    expect((await s.send()).json()).toEqual({committed:true,target:{kind:'poll',id:poll}});s.db.prepare("UPDATE time_polls SET status='deleted' WHERE id=?").run(poll);expect((await s.send()).statusCode).toBe(404);
  });
  it('rejects malformed paths, unsafe keys and unsupported request bodies',async()=>{
    const s=await setup();for(const patch of [{requestKey:'short'},{path:'//elsewhere'},{path:'/api/events?token=secret'},{method:'GET'},{data:[]},{extra:true}])expect((await s.send({...s.input,...patch})).statusCode).toBe(400);
  });
});
