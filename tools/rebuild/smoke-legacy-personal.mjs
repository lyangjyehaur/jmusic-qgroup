import assert from 'node:assert/strict';
import { createHash,randomBytes,randomUUID } from 'node:crypto';
import { execFileSync,spawn } from 'node:child_process';
import { mkdtempSync,mkdirSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import Database from 'better-sqlite3';
import { deflateSync } from 'node:zlib';
import { openDatabase } from '../../.rebuild-dist/api/database.mjs';
const commit='07defc429d619a7558ab7218372886f531813ae3',root=mkdtempSync(join(tmpdir(),'qgroup-retained-python-personal-')),source=join(root,'original-python'),database=join(root,'synthetic.sqlite3'),hash=v=>createHash('sha256').update(v).digest('hex');
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
 const post=async(path,body,h=headers)=>{if(path.includes('/legacy-requests/personal/')){let w=windows.get(path);if(!w||Date.now()-w.at>=60000){w={at:Date.now(),count:0};windows.set(path,w);}if(w.count>=29){const delay=Math.max(1,60050-(Date.now()-w.at));for(let left=delay;left>0;left-=59999)await new Promise(resolve=>setTimeout(resolve,Math.min(left,59999)));w={at:Date.now(),count:0};windows.set(path,w);}w.count++;}const r=await fetch(origin+path,{method:'POST',headers:h,body:JSON.stringify(body)}),text=await r.text();assert.equal(r.status,200,text);return JSON.parse(text);};
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
 const snapshot=()=>JSON.stringify(['users','events','event_audit','attendees','notifications','user_payment_codes','image_assets','request_results','bot_outbox'].map(t=>row('SELECT * FROM '+t)));
 const commands=[];let notices=0;
 async function consume(){const result=python(worker);assert.equal(result.second.claimed,0);notices+=result.calls.length;}
 async function recover(path,data,method='POST'){
  const request={method,path,requestKey:randomBytes(16).toString('hex'),data},before=snapshot(),p=await post('/api/v2/me/legacy-requests/personal/inspect',request);assert.equal(p.state,'retryable');assert.equal(snapshot(),before);
  const body={...request,confirm:true,recovery_token:p.recovery_token},done=await post('/api/v2/me/legacy-requests/personal/retry',body);assert.equal(done.state,'committed');
  const old=python(`import json,sqlite3,socket,sys
sys.path.insert(0,sys.argv[1]);socket.socket=lambda *a,**k:(_ for _ in ()).throw(AssertionError('No network'))
from qgroup_core import payment_codes,roster
db=sqlite3.connect('file:'+sys.argv[2]+'?mode=ro',uri=True);db.row_factory=sqlite3.Row
r=db.execute('SELECT response_status,response_json FROM request_results WHERE user_id=? AND request_key=?',('alice',sys.argv[3])).fetchone();result=json.loads(r['response_json']);assert r['response_status']==(201 if sys.argv[4]=='/api/payment-codes' else 200)
print(json.dumps(dict(receipt=result,codes=payment_codes.library(db,'alice'),nickname=db.execute("SELECT nickname FROM users WHERE id='alice'").fetchone()[0])))`,request.requestKey,path);
  if(path==='/api/profile')assert.equal(old.receipt.nickname,data.nickname.trim());
  if(path==='/api/payment-codes')assert(old.codes.some(c=>c.id===old.receipt.id));
  if(typeof data.image==='string')assert(!JSON.stringify(p).includes(data.image));
  const saved=snapshot();assert.deepEqual(await post('/api/v2/me/legacy-requests/personal/retry',body),done);assert.equal(snapshot(),saved);assert.deepEqual(await post('/api/v2/me/legacy-requests/personal/inspect',request),done);assert.equal(snapshot(),saved);commands.push({path,kind:p.kind});await consume();return old;
 }
 const activityRequest={method:'POST',path:'/api/events',requestKey:randomBytes(16).toString('hex'),data:{title:'合成個人操作活動',category:'约K',location:'合成場地',capacity:2,deadline:'2099-12-10T00:00:00Z',starts_at:'2099-12-11T18:00:00+08:00',lifecycle:'scheduled',join_owner:true,bot_enabled:true}};
 const activityPlan=await post('/api/v2/me/legacy-requests/activity-create/inspect',activityRequest),activity=await post('/api/v2/me/legacy-requests/activity-create/retry',{...activityRequest,confirm:true,recovery_token:activityPlan.recovery_token}),id=activity.receipt.target.id;await consume();assert.equal(notices,1);
 await recover('/api/profile',{nickname:' 原新稱呼 '});assert.equal(row('SELECT nickname FROM users WHERE id=?','alice')[0].nickname,'原新稱呼');assert(row('SELECT action FROM event_audit WHERE event_id=?',id).some(r=>r.action==='nickname_changed'));assert.equal(notices,1);
 const notificationDb=openDatabase(database);let own,other;try{own=Number(notificationDb.prepare("INSERT INTO notifications(user_id,event_id,kind,message,created_at) VALUES('alice',?,'claim_requested','合成消息','before')").run(id).lastInsertRowid);other=Number(notificationDb.prepare("INSERT INTO notifications(user_id,event_id,kind,message,created_at) VALUES('bob',?,'claim_requested','合成私人消息','before')").run(id).lastInsertRowid);}finally{notificationDb.close();}
 await recover('/api/notifications/read',{ids:[own,other,-1]});assert(row('SELECT read_at FROM notifications WHERE id=?',own)[0].read_at);assert.equal(row('SELECT read_at FROM notifications WHERE id=?',other)[0].read_at,null);
 const chunk=(kind,payload)=>{const data=Buffer.concat([Buffer.from(kind),payload]);let crc=0xffffffff;for(const byte of data){crc^=byte;for(let bit=0;bit<8;bit++)crc=crc&1?(crc>>>1)^0xedb88320:crc>>>1;}const n=Buffer.alloc(4),c=Buffer.alloc(4);n.writeUInt32BE(payload.length);c.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([n,data,c]);};
 const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(1);ihdr.writeUInt32BE(1,4);ihdr[8]=8;ihdr[9]=2;const raw=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(Buffer.from([0,255,255,255]))),chunk('IEND',Buffer.alloc(0))]),image=raw.toString('base64');
 const code=(await recover('/api/payment-codes',{kind:'wechat',name:'合成原碼',image})).receipt;await recover('/api/payment-codes',{kind:'wechat',name:'合成原碼',image});assert.equal(row('SELECT id FROM user_payment_codes').length,1);
 const active=openDatabase(database);try{active.prepare("INSERT INTO settlement_history(event_id,version,total_cents,headcount,note,qr_image,updated_at,actor_id,actor_name,kind,changed_fields) VALUES(?,1,100,1,'',?,'before','alice','原新稱呼','detailed_published','[]')").run(id,raw);}finally{active.close();}
 await recover('/api/payment-codes',{kind:'alipay',name:'合成舊結算碼',source:{event_id:id,version:1,kind:'other'}});
 await recover('/api/payment-codes/'+code.id,{},'DELETE');assert(row('SELECT archived_at FROM user_payment_codes WHERE id=?',code.id)[0].archived_at);assert.equal(row('SELECT length(qr_image) AS size FROM settlement_history WHERE event_id=?',id)[0].size,raw.length);assert.equal(notices,1);assert.equal(commands.length,6);
 for(const path of ['/me/profile','/inbox','/me/payment-codes']){const r=await fetch(origin+path,{headers});assert.equal(r.status,200);assert((await r.text()).includes('id="root"'));}
 child.kill('SIGTERM');assert.equal((await closed).code,0,logs);child=undefined;
 for(const pin of runtimePins)assert.equal(hash(readFileSync('.rebuild-dist/'+pin.path)),pin.sha256);for(const pin of sourcePins)assert.equal(hash(readFileSync(join(source,pin.path))),pin.sha256);
 console.log(JSON.stringify({version:1,pythonCommit:commit,sourcePins,runtimePins,compiledRecoveryVerified:true,originalReceiptReaderVerified:true,originalPersonalCommands:commands.length,kinds:commands.map(c=>c.kind),mockConfirmedNotices:notices,originalReplayWrites:0,deepLinks:3,networkTransport:'denied',actualQQ:false,actualProductionImageCombination:false,releaseEligible:false,scope:'none',deployment:'none'}));
}finally{if(child){child.kill('SIGTERM');await closed;}rmSync(root,{recursive:true,force:true});}
