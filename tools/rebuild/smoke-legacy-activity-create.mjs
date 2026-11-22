import assert from 'node:assert/strict';
import { createHash,randomBytes,randomUUID } from 'node:crypto';
import { execFileSync,spawn } from 'node:child_process';
import { mkdtempSync,mkdirSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import Database from 'better-sqlite3';
import { openDatabase } from '../../.rebuild-dist/api/database.mjs';
const commit='07defc429d619a7558ab7218372886f531813ae3',root=mkdtempSync(join(tmpdir(),'qgroup-retained-python-poll-')),source=join(root,'original-python'),database=join(root,'synthetic.sqlite3'),hash=v=>createHash('sha256').update(v).digest('hex');
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
 const post=async(path,body,h=headers)=>{const r=await fetch(origin+path,{method:'POST',headers:h,body:JSON.stringify(body)}),text=await r.text();assert.equal(r.status,200,text);return JSON.parse(text);};
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
 const recovered=[];
 const snapshot=()=>JSON.stringify(['events','event_access','event_conditions','event_audit','roster_parties','attendees','attendee_consents','bot_outbox','request_results'].map(t=>row('SELECT * FROM '+t)));
 for(const lifecycle of ['draft','scheduled'])for(const visibility of ['public','invitation'])for(const joinOwner of [true,false]){
  const intent=randomBytes(8).toString('hex'),canonical=hash('create '+intent),request={method:'POST',path:'/api/events',requestKey:joinOwner?canonical:randomBytes(16).toString('hex'),data:{title:'合成原活動 '+lifecycle+' '+visibility+' '+joinOwner,category:'约K',location:'合成場地',capacity:4,timezone:null,deadline:'2099-12-10T00:00:00Z',starts_at:'2099-12-11T18:00:00+08:00',duration_hours:4,client_intent:intent,lifecycle,visibility,join_owner:joinOwner,bot_enabled:visibility==='public',fee_policy:'依實際分攤',reason:'原不生效欄位'}};
  const before=snapshot(),review=await post('/api/v2/me/legacy-requests/activity-create/inspect',request);assert.equal(review.state,'retryable');assert.equal(snapshot(),before);
  const notice=lifecycle==='scheduled'&&visibility==='public';assert.equal(review.group_target!==null,notice);if(notice){assert(review.group_preview.includes('（建立後的活動連結）'));assert.equal(review.group_preview.includes('alice'),joinOwner);}
  const body={...request,confirm:true,recovery_token:review.recovery_token},done=await post('/api/v2/me/legacy-requests/activity-create/retry',body);assert.equal(done.state,'committed');const id=done.receipt.target.id;assert.equal(done.route,lifecycle==='draft'?'draft':'arrangements');
  const enrolled=lifecycle==='scheduled'&&joinOwner;assert.equal(row('SELECT * FROM attendees WHERE event_id=?',id).length,Number(enrolled));assert.equal(row('SELECT * FROM attendee_consents WHERE event_id=?',id).length,Number(enrolled));assert.equal(row('SELECT * FROM event_conditions WHERE event_id=?',id).length,Number(lifecycle==='scheduled'));assert.equal(row('SELECT * FROM bot_outbox WHERE event_id=?',id).length,Number(notice));
  const old=python(`import json,socket,sqlite3,sys
sys.path.insert(0,sys.argv[1]);socket.socket=lambda *a,**k:(_ for _ in ()).throw(AssertionError('No network'))
from qgroup_core import events,roster,conditions
db=sqlite3.connect('file:'+sys.argv[2]+'?mode=ro',uri=True);db.row_factory=sqlite3.Row
receipt=db.execute('SELECT response_status,response_json FROM request_results WHERE request_key=?',(sys.argv[3],)).fetchone();assert receipt['response_status']==201
uid=json.loads(receipt['response_json'])['id'];e=db.execute('SELECT * FROM events WHERE id=?',(uid,)).fetchone()
print(json.dumps(dict(id=uid,event=events.public_snapshot(e),roster=[dict(r) for r in roster.rows(db,uid)],conditions=conditions.current(db,e))))`,request.requestKey);assert.equal(old.id,id);assert.equal(old.event.lifecycle,lifecycle);assert.equal(old.event.visibility,visibility);assert.equal(old.roster.length,Number(enrolled));if(enrolled)assert.equal(old.roster[0].accepted_conditions_version,1);
  const saved=snapshot();assert.equal((await post('/api/v2/me/legacy-requests/activity-create/retry',body)).state,'committed');assert.equal(snapshot(),saved);assert.equal((await post('/api/v2/me/legacy-requests/activity-create/inspect',{...request,requestKey:randomBytes(16).toString('hex')})).state,'existing');assert.equal(snapshot(),saved);
  const url=origin+'/?event='+id+(notice?'&action=join':'');const deep=await fetch(url,{headers});assert.equal(deep.status,200);assert((await deep.text()).includes('id="root"'));recovered.push({id,body,notice,enrolled});
 }
 const consumed=python(worker);assert.equal(consumed.first.sent,2);assert.equal(consumed.second.claimed,0);assert.equal(consumed.calls.length,2);for(const creation of recovered.filter(c=>c.notice))assert(consumed.calls.some(c=>JSON.stringify(c.body).includes('/?event='+creation.id)));
 const saved=snapshot();for(const creation of recovered)assert.equal((await post('/api/v2/me/legacy-requests/activity-create/retry',creation.body)).state,'committed');assert.equal(snapshot(),saved);assert.equal(row('SELECT * FROM events').length,8);assert.equal(row('SELECT * FROM request_results').length,12);
 child.kill('SIGTERM');assert.equal((await closed).code,0,logs);child=undefined;
 for(const pin of runtimePins)assert.equal(hash(readFileSync('.rebuild-dist/'+pin.path)),pin.sha256);for(const pin of sourcePins)assert.equal(hash(readFileSync(join(source,pin.path))),pin.sha256);
 console.log(JSON.stringify({version:1,pythonCommit:commit,sourcePins,runtimePins,compiledRecoveryVerified:true,originalReceiptReaderVerified:true,originalActivityCreates:8,ownerSignups:2,conditions:4,originalActivityNoticesSent:2,originalReceipts:8,creationAliasReceipts:4,originalReplayWrites:0,deepLinks:8,networkTransport:'denied',actualQQ:false,releaseEligible:false,scope:'none',deployment:'none'}));
}finally{if(child){child.kill('SIGTERM');await closed;}rmSync(root,{recursive:true,force:true});}
