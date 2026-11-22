import assert from 'node:assert/strict';
import { createHash,randomBytes,randomUUID } from 'node:crypto';
import { execFileSync,spawn } from 'node:child_process';
import { mkdtempSync,mkdirSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import Database from 'better-sqlite3';
import { openDatabase } from '../../.rebuild-dist/api/database.mjs';
const commit='8da877857f163853c449474e168534e2e493121b',root=mkdtempSync(join(tmpdir(),'qgroup-retained-python-poll-')),source=join(root,'original-python'),database=join(root,'synthetic.sqlite3'),hash=v=>createHash('sha256').update(v).digest('hex');
let child,closed;
try {
 mkdirSync(source);execFileSync('tar',['-xf','-','-C',source],{input:execFileSync('git',['archive',commit,'qgroup_core','qgroup_bot'],{maxBuffer:32*1024*1024})});
 const sourcePins=execFileSync('git',['ls-tree','-r','--name-only',commit,'--','qgroup_core','qgroup_bot'],{encoding:'utf8'}).trim().split('\n').map(path=>{const raw=readFileSync(join(source,path));assert(raw.equals(execFileSync('git',['show',commit+':'+path],{maxBuffer:16*1024*1024})));return {path,sha256:hash(raw)};});
 const runtimePins=['api/start.mjs','api/database.mjs'].map(path=>({path,sha256:hash(readFileSync('.rebuild-dist/'+path))}));
 const db=openDatabase(database);
 try {
  for(const id of ['alice','bob']){db.prepare('INSERT INTO users(id,token_hash,nickname,created_at) VALUES(?,?,?,?)').run(id,hash('synthetic-poll-'+id),id,'before');db.prepare('INSERT INTO browser_sessions VALUES(?,?,?)').run(hash('synthetic-poll-'+id),id,'before');}
  db.prepare('UPDATE bot_settings SET config_json=?').run(JSON.stringify({enabled:true,groups:[{id:'synthetic-group',name:'',replies:true,broadcast:true}]}));
 }finally{db.close();}
 const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));const origin='http://127.0.0.1:'+port;
 child=spawn(process.execPath,['.rebuild-dist/api/start.mjs'],{env:{PATH:process.env.PATH,REBUILD_DB:database,REBUILD_ORIGIN:origin,REBUILD_HOST:'127.0.0.1',REBUILD_PORT:String(port),REBUILD_BOT_ENABLED:'1',REBUILD_BOT_KEYBOARD:'1',REBUILD_BOT_SCHEDULE:'0',REBUILD_QQ_APP_ID:'',REBUILD_QQ_APP_KEY:''},stdio:['ignore','pipe','pipe']});
 let logs='';child.stdout.on('data',v=>logs=(logs+v).slice(-2000));child.stderr.on('data',v=>logs=(logs+v).slice(-2000));closed=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
 let ready=false;for(let i=0;i<100;i++){try{ready=(await fetch(origin+'/api/v2/health')).ok;}catch{}if(ready)break;await new Promise(resolve=>setTimeout(resolve,100));}assert(ready,logs);
 const cookie='kanban_session=synthetic-poll-alice',session=await(await fetch(origin+'/api/v2/session',{headers:{Cookie:cookie}})).json(),headers={Cookie:cookie,Origin:origin,'X-Account-Scope':session.scope,'X-CSRF-Token':session.csrf,'Content-Type':'application/json'};
 const row=(sql,...args)=>{const db=new Database(database,{readonly:true});try{return db.prepare(sql).all(...args);}finally{db.close();}};
 const bobCookie='kanban_session=synthetic-poll-bob',bobSession=await(await fetch(origin+'/api/v2/session',{headers:{Cookie:bobCookie}})).json(),bobHeaders={...headers,Cookie:bobCookie,'X-Account-Scope':bobSession.scope,'X-CSRF-Token':bobSession.csrf};
 const post=async(path,body,h=headers)=>{const r=await fetch(origin+path,{method:'POST',headers:h,body:JSON.stringify(body)}),text=await r.text();assert.equal(r.status,200,text);return JSON.parse(text);};
 const read=async id=>{const r=await fetch(origin+'/api/v2/time-polls/'+id+'/manage',{headers});assert.equal(r.status,200);return r.json();};
 const original=(id,action,data)=>({method:action==='vote'?'PUT':'PATCH',path:'/api/time-polls/'+id+(action==='vote'?'/votes':''),requestKey:randomBytes(16).toString('hex'),data:{base_revision:1,...(action==='vote'?{}:{action}),...data}});
 async function recover(request,h=headers){const before=row('SELECT * FROM request_results'),p=await post('/api/v2/me/legacy-requests/time-poll/inspect',request,h);assert.equal(p.state,'retryable');assert.deepEqual(row('SELECT * FROM request_results'),before);const body={...request,confirm:true,recovery_token:p.recovery_token};assert((await post('/api/v2/me/legacy-requests/time-poll/retry',body,h)).committed);const saved=row('SELECT * FROM request_results');assert((await post('/api/v2/me/legacy-requests/time-poll/retry',body,h)).committed);assert.deepEqual(row('SELECT * FROM request_results'),saved);return body;}
 const python=(code,...args)=>JSON.parse(execFileSync('python3',['-c',code,source,database,...args],{encoding:'utf8',timeout:15000,env:{PATH:process.env.PATH,PYTHONDONTWRITEBYTECODE:'1',KANBAN_BOT_ENABLED:'1',KANBAN_BOT_BASE_URL:origin,KANBAN_BOT_KEYBOARD:'1'}}));
 const worker=`import datetime,json,socket,sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
sys.path.insert(0,sys.argv[1]);socket.socket=lambda *a,**k:(_ for _ in ()).throw(AssertionError('No network'))
from qgroup_bot import worker
config=SimpleNamespace(db=Path(sys.argv[2]),group='synthetic-group',dry_run=False,sandbox=False,claim_timeout=600,batch=100,max_attempts=5,markdown_replies=False,allowed_link_hosts=('127.0.0.1',),log_dir=Path(sys.argv[2]).parent/'isolated-logs',log_content=False)
api=Mock()
def transport(path,body):
 assert path=='/v2/groups/synthetic-group/messages'
 return True,0,dict(id='SYNTHETIC_ONLY')
api.post.side_effect=transport;consumer=worker.OutboxWorker(config,api)
print(json.dumps(dict(first=consumer.poll_once(),second=consumer.poll_once(),calls=[dict(path=c.args[0],body=c.args[1]) for c in api.post.call_args_list])))`;
 const recoveredCreations=[];
 for(const mode of ['date','exact']){
  const intent=randomBytes(8).toString('hex'),canonical=hash('create time-poll '+intent),request={method:'POST',path:'/api/time-polls',requestKey:mode==='date'?canonical:randomBytes(16).toString('hex'),data:{title:'合成原建立 '+mode,category:'约K',location:'合成場地',capacity:4,timezone:'Asia/Taipei',deadline:'2099-12-10T00:00:00Z',time_mode:mode,duration_hours:mode==='date'?'original ignored field':4,client_intent:intent,options:mode==='date'?[{date:'2099-12-11'},{date:'2099-12-12'}]:[{starts_at:'2099-12-11T18:00:00+08:00'},{starts_at:'2099-12-12T18:00:00+08:00'}]}};
  const before=row('SELECT * FROM time_polls'),review=await post('/api/v2/me/legacy-requests/time-poll-create/inspect',request);assert.equal(review.state,'retryable');assert.deepEqual(row('SELECT * FROM time_polls'),before);assert(review.group_preview.includes('（建立後的投票連結）'));
  const body={...request,confirm:true,recovery_token:review.recovery_token},done=await post('/api/v2/me/legacy-requests/time-poll-create/retry',body);assert.equal(done.state,'committed');const id=done.receipt.target.id;
  assert.equal(row('SELECT * FROM events').length,0);assert.equal(row('SELECT * FROM attendees').length,0);assert.equal(row('SELECT * FROM time_poll_options WHERE poll_id=?',id).length,2);
  const oldReader=python(`import json,socket,sqlite3,sys
sys.path.insert(0,sys.argv[1]);socket.socket=lambda *a,**k:(_ for _ in ()).throw(AssertionError('No network'))
from qgroup_core import time_polls
db=sqlite3.connect('file:'+sys.argv[2]+'?mode=ro',uri=True);db.row_factory=sqlite3.Row
receipt=db.execute('SELECT response_status,response_json FROM request_results WHERE request_key=?',(sys.argv[3],)).fetchone();assert receipt['response_status']==201
print(json.dumps(time_polls.serialize(db,time_polls.get(db,json.loads(receipt['response_json'])['id']),'alice')))`,request.requestKey);assert.equal(oldReader.id,id);assert.equal(oldReader.time_mode,mode);
  const snapshot=JSON.stringify(['time_polls','time_poll_options','time_poll_history','bot_outbox','request_results'].map(t=>row('SELECT * FROM '+t)));assert.equal((await post('/api/v2/me/legacy-requests/time-poll-create/retry',body)).state,'committed');assert.equal(JSON.stringify(['time_polls','time_poll_options','time_poll_history','bot_outbox','request_results'].map(t=>row('SELECT * FROM '+t))),snapshot);
  const alias=await post('/api/v2/me/legacy-requests/time-poll-create/inspect',{...request,requestKey:randomBytes(16).toString('hex')});assert.deepEqual(alias,{state:'existing',target:{kind:'poll',id}});recoveredCreations.push({id,body});
 }
 const creationNotices=python(worker);assert.equal(creationNotices.first.sent,2);assert.equal(creationNotices.second.claimed,0);assert.equal(creationNotices.calls.length,2);for(const creation of recoveredCreations)assert(creationNotices.calls.some(c=>JSON.stringify(c.body).includes('/?poll='+creation.id)));
 let sentPolls=0;
 const results=[];
 for(const mode of ['exact','date']) {
  const created=await post('/api/v2/time-polls',{title:'合成原投票 '+mode,category:'约K',location:'合成場地',timezone:'Asia/Taipei',capacity:4,minimum_participants:1,description:'原完整安排',fee_policy:'依實際分攤',deadline:'2099-12-10T00:00:00Z',time_mode:mode,...(mode==='exact'?{duration_hours:3,options:[{starts_at:'2099-12-11T18:00:00+08:00'},{starts_at:'2099-12-12T18:00:00+08:00'}]}:{options:[{date:'2099-12-11'},{date:'2099-12-12'}]})},{...headers,'Idempotency-Key':randomUUID()});
  const id=created.id,p=await read(id),vote=original(id,'vote',{choices:p.options.map(o=>({option_id:o.id,choice:'yes'}))});
  await recover(vote,bobHeaders);assert.equal((await read(id)).vote_revision,1);
  let revision=1;
  if(mode==='exact') {
   const job=row('SELECT id FROM bot_outbox WHERE poll_id=?',id)[0];const db=new Database(database);try{db.prepare("UPDATE bot_outbox SET status='failed',last_error='synthetic known reject' WHERE id=?").run(job.id);}finally{db.close();}
   const retry=original(id,'bot_retry',{outbox_id:job.id});await recover(retry);revision=2;
   const beforeJobs=row('SELECT * FROM bot_outbox WHERE poll_id=?',id),consumed=python(worker);assert.equal(consumed.first.sent,1);assert.equal(consumed.second.claimed,0);assert.equal(consumed.calls.length,1);assert(JSON.stringify(consumed.calls[0].body).includes('/?poll='+id));sentPolls++;
   const committed=await post('/api/v2/me/legacy-requests/time-poll/inspect',retry);assert.equal(committed.state,'committed');assert.equal(row('SELECT * FROM bot_outbox WHERE poll_id=?',id).length,beforeJobs.length);
  }
  const f=original(id,'finalize',{base_revision:revision,base_vote_revision:1,option_id:p.options[0].id,registration_deadline:'2099-12-10T00:00:00Z',accept_terms:true,reason:'原場地確認',...(mode==='date'?{starts_at:'2099-12-11T18:00:00+08:00',duration_hours:4}:{starts_at:'original inactive input',duration_hours:'original inactive input'})});
  const b=await recover(f),final=await read(id);assert.equal(final.status,'finalized');assert.equal(row('SELECT * FROM attendees WHERE event_id=?',final.event_id).length,1);assert.equal(row('SELECT * FROM notifications WHERE event_id=?',final.event_id).length,1);assert.equal(row('SELECT * FROM event_conditions WHERE event_id=?',final.event_id).length,1);
  const oldReader=python(`import json,socket,sqlite3,sys
sys.path.insert(0,sys.argv[1]);socket.socket=lambda *a,**k:(_ for _ in ()).throw(AssertionError('No network'))
from qgroup_core import time_polls
db=sqlite3.connect('file:'+sys.argv[2]+'?mode=ro',uri=True);db.row_factory=sqlite3.Row
receipt=json.loads(db.execute('SELECT response_json FROM request_results WHERE request_key=?',(sys.argv[3],)).fetchone()[0]);assert receipt['time_poll'] is True
print(json.dumps(time_polls.serialize(db,time_polls.get(db,receipt['id']),'alice')))`,f.requestKey);
  assert.equal(oldReader.event_id,final.event_id);assert.equal(oldReader.status,'finalized');assert.equal(oldReader.vote_revision,1);
  results.push({id,event:final.event_id,body:b});
 }
 const consumed=python(worker);assert.equal(consumed.first.sent,2);assert.equal(consumed.second.claimed,0);assert.equal(consumed.calls.length,2);
 const saved=row('SELECT * FROM bot_outbox');for(const r of results)assert((await post('/api/v2/me/legacy-requests/time-poll/retry',r.body)).committed);assert.deepEqual(row('SELECT * FROM bot_outbox'),saved);assert.equal(row('SELECT * FROM events').length,2);assert.equal(row('SELECT * FROM request_results').length,10);assert.equal(row('SELECT * FROM time_polls').length,4);
 child.kill('SIGTERM');assert.equal((await closed).code,0,logs);child=undefined;
 for(const pin of runtimePins)assert.equal(hash(readFileSync('.rebuild-dist/'+pin.path)),pin.sha256);for(const pin of sourcePins)assert.equal(hash(readFileSync(join(source,pin.path))),pin.sha256);
 console.log(JSON.stringify({version:1,pythonCommit:commit,sourcePins,runtimePins,compiledRecoveryVerified:true,originalReceiptReaderVerified:true,activityCreates:2,ownerSignups:2,voterNotifications:2,originalPollNoticeSent:sentPolls+2,originalPollCreates:2,originalCreationReceipts:2,creationAliasReceipts:1,originalActivityNoticesSent:2,originalReceipts:7,nativeCreateReceipts:2,originalReplayWrites:0,networkTransport:'denied',actualQQ:false,releaseEligible:false,scope:'none',deployment:'none'}));
}finally{if(child){child.kill('SIGTERM');await closed;}rmSync(root,{recursive:true,force:true});}
