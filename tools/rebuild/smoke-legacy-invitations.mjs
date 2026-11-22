import assert from 'node:assert/strict';
import { createHash,randomBytes,randomUUID } from 'node:crypto';
import { execFileSync,spawn } from 'node:child_process';
import { mkdtempSync,mkdirSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import Database from 'better-sqlite3';
import { openDatabase } from '../../.rebuild-dist/api/database.mjs';
const commit='07defc429d619a7558ab7218372886f531813ae3',root=mkdtempSync(join(tmpdir(),'qgroup-retained-python-invitations-')),source=join(root,'original-python'),database=join(root,'synthetic.sqlite3'),hash=v=>createHash('sha256').update(v).digest('hex');
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
 child=spawn(process.execPath,['.rebuild-dist/api/start.mjs'],{env:{PATH:process.env.PATH,REBUILD_DB:database,REBUILD_ORIGIN:origin,REBUILD_HOST:'127.0.0.1',REBUILD_PORT:String(port),REBUILD_BOT_ENABLED:'1',REBUILD_BOT_KEYBOARD:'1',REBUILD_BOT_PERSONAL_QUEUE:'1',REBUILD_BOT_SCHEDULE:'0',REBUILD_QQ_APP_ID:'',REBUILD_QQ_APP_KEY:''},stdio:['ignore','pipe','pipe']});
 let logs='';child.stdout.on('data',v=>logs=(logs+v).slice(-2000));child.stderr.on('data',v=>logs=(logs+v).slice(-2000));closed=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
 let ready=false;for(let i=0;i<100;i++){try{ready=(await fetch(origin+'/api/v2/health')).ok;}catch{}if(ready)break;await new Promise(resolve=>setTimeout(resolve,100));}assert(ready,logs);
 const cookie='kanban_session=synthetic-poll-alice',session=await(await fetch(origin+'/api/v2/session',{headers:{Cookie:cookie}})).json(),headers={Cookie:cookie,Origin:origin,'X-Account-Scope':session.scope,'X-CSRF-Token':session.csrf,'Content-Type':'application/json'};
 const row=(sql,...args)=>{const db=new Database(database,{readonly:true});try{return db.prepare(sql).all(...args);}finally{db.close();}};
 const windows=new Map();
 const post=async(path,body,h=headers)=>{if(path.includes('/legacy-requests/invitations/')){let w=windows.get(path);if(!w||Date.now()-w.at>=60000){w={at:Date.now(),count:0};windows.set(path,w);}if(w.count>=29){const delay=Math.max(1,60050-(Date.now()-w.at));for(let left=delay;left>0;left-=59999)await new Promise(resolve=>setTimeout(resolve,Math.min(left,59999)));w={at:Date.now(),count:0};windows.set(path,w);}w.count++;}const r=await fetch(origin+path,{method:'POST',headers:h,body:JSON.stringify(body)}),text=await r.text();assert.equal(r.status,200,text);return JSON.parse(text);};
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
 const snapshot=()=>JSON.stringify(['events','event_access','event_audit','roster_parties','attendees','attendee_consents','notifications','bot_outbox','request_results','event_roles','management_invitations'].map(t=>row('SELECT * FROM '+t)));
 const commands=[];let notices=0;
 async function consume(){const result=python(worker);assert.equal(result.second.claimed,0);for(const call of result.calls)assert.equal(call.path,'/v2/groups/synthetic-group/messages');notices+=result.calls.length;}
 async function create(capacity=3){const request={method:'POST',path:'/api/events',requestKey:randomBytes(16).toString('hex'),data:{title:'合成邀請活動',category:'约K',location:'合成場地',capacity,deadline:'2099-12-10T00:00:00Z',starts_at:'2099-12-11T18:00:00+08:00',lifecycle:'scheduled',join_owner:true,bot_enabled:true}};const p=await post('/api/v2/me/legacy-requests/activity-create/inspect',request),r=await post('/api/v2/me/legacy-requests/activity-create/retry',{...request,confirm:true,recovery_token:p.recovery_token});await consume();return r.receipt.target.id;}
 const bobCookie='kanban_session=synthetic-poll-bob',bobSession=await(await fetch(origin+'/api/v2/session',{headers:{Cookie:bobCookie}})).json(),bobHeaders={...headers,Cookie:bobCookie,'X-Account-Scope':bobSession.scope,'X-CSRF-Token':bobSession.csrf};
 async function recover(id,method,suffix,data={},h=headers){
  const event=row('SELECT * FROM events WHERE id=?',id)[0],request={method,path:'/api/events/'+id+suffix,requestKey:randomBytes(16).toString('hex'),data:{base_revision:event.revision,...data}},before=snapshot();
  const p=await post('/api/v2/me/legacy-requests/invitations/inspect',request,h);assert.equal(p.state,'retryable');assert.equal(snapshot(),before);
  const body={...request,confirm:true,recovery_token:p.recovery_token},done=await post('/api/v2/me/legacy-requests/invitations/retry',body,h);assert.equal(done.state,'committed');assert.equal(done.receipt.target.id,id);
  const old=python(`import json,socket,sqlite3,sys
sys.path.insert(0,sys.argv[1]);socket.socket=lambda *a,**k:(_ for _ in ()).throw(AssertionError('No network'))
from qgroup_core import roster,management
db=sqlite3.connect('file:'+sys.argv[2]+'?mode=ro',uri=True);db.row_factory=sqlite3.Row
r=db.execute('SELECT response_status,response_json FROM request_results WHERE request_key=?',(sys.argv[3],)).fetchone();assert r['response_status']==200
uid=json.loads(r['response_json'])['id'];event=db.execute('SELECT * FROM events WHERE id=?',(uid,)).fetchone()
print(json.dumps(dict(id=uid,people=[dict(r) for r in roster.rows(db,uid)],roles=management.visible_roles(db,event))))
`,request.requestKey);
  assert.equal(old.id,id);const saved=snapshot();assert.deepEqual(await post('/api/v2/me/legacy-requests/invitations/retry',body,h),done);assert.equal(snapshot(),saved);await consume();
  const after=snapshot();assert.deepEqual(await post('/api/v2/me/legacy-requests/invitations/inspect',request,h),done);assert.equal(snapshot(),after);commands.push({id,kind:p.command.kind});
 }
 const first=await create(2);
 await recover(first,'POST','/roster/invitations',{people:[{name:'合成受邀者',note:'原備註',payer_kind:'manager'}],queue_mode:'individual',intent:'registered',reason:'補邀請'});
 let invite=row('SELECT id,invitation_token FROM attendees WHERE event_id=? AND status=\'invited\'',first)[0];
 await recover(first,'POST','/invitations/'+invite.invitation_token+'/accept',{conditions_version:1,accept_waiting:true},bobHeaders);
 assert.equal(row('SELECT status,user_id,invitation_token FROM attendees WHERE id=?',invite.id)[0].user_id,'bob');
 await recover(first,'POST','/management/invitations',{kind:'cohost',target_name:'合成協辦',attendee_id:invite.id,permissions:['roster','settlement'],reason:'分擔責任'});
 invite=row('SELECT * FROM management_invitations WHERE event_id=? AND status=\'pending\'',first)[0];
 await recover(first,'POST','/management/invitations/'+invite.token+'/accept',{accept_responsibility:true},bobHeaders);
 const role=row('SELECT id FROM event_roles WHERE event_id=? AND user_id=?',first,'bob')[0];
 await recover(first,'DELETE','/management/roles/'+role.id,{reason:'已核對交接'});
 const second=await create();
 await recover(second,'POST','/management/invitations',{kind:'cohost',target_name:'合成協辦',permissions:['attendance'],reason:'邀請'});
 invite=row('SELECT * FROM management_invitations WHERE event_id=? AND status=\'pending\'',second)[0];
 await recover(second,'DELETE','/management/invitations/'+invite.id,{reason:'撤銷邀請'});
 const third=await create();
 await recover(third,'POST','/management/invitations',{kind:'transfer',target_name:'合成新發起者',permissions:[],reason:'轉交活動'});
 invite=row('SELECT * FROM management_invitations WHERE event_id=? AND status=\'pending\'',third)[0];
 await recover(third,'POST','/management/invitations/'+invite.token+'/accept',{accept_responsibility:true},bobHeaders);
 assert.equal(row('SELECT owner_id FROM events WHERE id=?',third)[0].owner_id,'bob');assert.equal(row('SELECT * FROM management_invitations WHERE event_id=? AND status=\'pending\'',third).length,0);
 assert.equal(commands.length,9);assert(notices>=3);
 for(const id of [first,second,third]){const r=await fetch(origin+'/?event='+id+'&action=join',{headers});assert.equal(r.status,200);assert((await r.text()).includes('id="root"'));}
 child.kill('SIGTERM');assert.equal((await closed).code,0,logs);child=undefined;
 for(const pin of runtimePins)assert.equal(hash(readFileSync('.rebuild-dist/'+pin.path)),pin.sha256);for(const pin of sourcePins)assert.equal(hash(readFileSync(join(source,pin.path))),pin.sha256);
 console.log(JSON.stringify({version:1,pythonCommit:commit,sourcePins,runtimePins,compiledRecoveryVerified:true,originalReceiptReaderVerified:true,originalInvitationCommands:commands.length,kinds:commands.map(c=>c.kind),mockConfirmedNotices:notices,originalReplayWrites:0,deepLinks:3,networkTransport:'denied',actualQQ:false,actualProductionImageCombination:false,releaseEligible:false,scope:'none',deployment:'none'}));
}finally{if(child){child.kill('SIGTERM');await closed;}rmSync(root,{recursive:true,force:true});}
