import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import Database from 'better-sqlite3';
import { openDatabase } from '../../.rebuild-dist/api/database.mjs';
const commit='8da877857f163853c449474e168534e2e493121b',root=mkdtempSync(join(tmpdir(),'qgroup-retained-python-invoice-')),source=join(root,'original-python'),database=join(root,'synthetic.sqlite3'),hash=v=>createHash('sha256').update(v).digest('hex');
let child,closed;
try {
 mkdirSync(source);execFileSync('tar',['-xf','-','-C',source],{input:execFileSync('git',['archive',commit,'qgroup_core','qgroup_bot'],{maxBuffer:32*1024*1024})});
 const sourcePins=execFileSync('git',['ls-tree','-r','--name-only',commit,'--','qgroup_core','qgroup_bot'],{encoding:'utf8'}).trim().split('\n').map(path=>{const raw=readFileSync(join(source,path));assert(raw.equals(execFileSync('git',['show',commit+':'+path],{maxBuffer:16*1024*1024})));return {path,sha256:hash(raw)};});
 const runtimePins=['api/start.mjs','api/database.mjs'].map(path=>({path,sha256:hash(readFileSync('.rebuild-dist/'+path))}));
 const db=openDatabase(database);
 try{
  db.prepare('INSERT INTO users(id,token_hash,nickname,created_at) VALUES(?,?,?,?)').run('alice',hash('synthetic-legacy-settlement'),'合成付款人','before');
  db.prepare('INSERT INTO browser_sessions VALUES(?,?,?)').run(hash('synthetic-legacy-settlement'),'alice','before');
  db.exec("INSERT INTO events(id,owner_id,title,category,location,starts_at,deadline,capacity,description,status,created_at,lifecycle,bot_enabled) VALUES('synthetic','alice','合成逐人結算','其他','合成地點','2026-11-16T00:00:00+00:00','2026-11-15T00:00:00+00:00',2,'','open','before','ended',1); INSERT INTO attendees(id,event_id,manager_id,user_id,name,payer_kind,status,created_at,updated_at) VALUES('aaaaaaaaaaaaaaaa','synthetic','alice','alice','','self','confirmed','before','before')");
  db.prepare('UPDATE bot_settings SET config_json=?').run(JSON.stringify({enabled:true,groups:[{id:'synthetic-group',name:'',replies:true,broadcast:true}]}));
 }finally{db.close();}
 const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));const origin='http://127.0.0.1:'+port;
 child=spawn(process.execPath,['.rebuild-dist/api/start.mjs'],{env:{PATH:process.env.PATH,REBUILD_DB:database,REBUILD_ORIGIN:origin,REBUILD_HOST:'127.0.0.1',REBUILD_PORT:String(port),REBUILD_BOT_ENABLED:'1',REBUILD_BOT_KEYBOARD:'1',REBUILD_QQ_APP_ID:'',REBUILD_QQ_APP_KEY:''},stdio:['ignore','pipe','pipe']});
 let logs='';child.stdout.on('data',v=>logs=(logs+v).slice(-2000));child.stderr.on('data',v=>logs=(logs+v).slice(-2000));closed=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
 let ready=false;for(let i=0;i<100;i++){try{ready=(await fetch(origin+'/api/v2/health')).ok;}catch{}if(ready)break;await new Promise(resolve=>setTimeout(resolve,100));}assert(ready,logs);
 const cookie='kanban_session=synthetic-legacy-settlement',session=await(await fetch(origin+'/api/v2/session',{headers:{Cookie:cookie}})).json(),headers={Cookie:cookie,Origin:origin,'X-Account-Scope':session.scope,'X-CSRF-Token':session.csrf,'Content-Type':'application/json'};
 const row=(sql,...args)=>{const db=new Database(database,{readonly:true});try{return db.prepare(sql).all(...args);}finally{db.close();}};
 const image='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC';
 const data={base_revision:0,base_version:0,reviewed_roster:true,people:[{id:'aaaaaaaaaaaaaaaa'}],items:[{id:'1111111111111111',name:'原消費',amount:'10.03',receipt:image}],merchant_payment:{mode:'paid',amount:'8',payer_id:'account:'+hash('synthetic:alice').slice(0,16),occurred_at:'2026-11-17T00:00:00Z',merchant:'合成店家'},group_notice:true,payment_codes:['wechat','alipay','other'].map(kind=>({kind,image,name:''}))};
 // Fixed public Git sources calculate the actual old proof against a synthetic copy.
 const proof=JSON.parse(execFileSync('python3',['-c',`import json,sqlite3,socket,sys
sys.path.insert(0,sys.argv[1]);socket.socket=lambda *a,**k:(_ for _ in ()).throw(AssertionError('No network'))
from qgroup_core import settlements
db=sqlite3.connect('file:'+sys.argv[2]+'?mode=ro',uri=True);db.row_factory=sqlite3.Row
event=db.execute("SELECT * FROM events WHERE id='synthetic'").fetchone();user=db.execute("SELECT * FROM users WHERE id='alice'").fetchone()
print(json.dumps(settlements.preview(db,event,user,json.loads(sys.argv[3]))))`,source,database,JSON.stringify(data)],{env:{PATH:process.env.PATH,PYTHONDONTWRITEBYTECODE:'1'},encoding:'utf8'}));
 const original={method:'PUT',path:'/api/events/synthetic/settlement/detailed',requestKey:randomBytes(16).toString('hex'),data:{...data,preview_token:proof.preview_token}};
 const post=async(mode,body)=>{const r=await fetch(origin+'/api/v2/me/legacy-requests/settlement/'+mode,{method:'POST',headers,body:JSON.stringify(body)}),text=await r.text();assert.equal(r.status,200,text);return JSON.parse(text);};
 const before=row('SELECT * FROM settlement_history'),inspect=await post('inspect',original);assert.deepEqual(row('SELECT * FROM settlement_history'),before);assert.equal(inspect.preview.preview_token,proof.preview_token);assert.deepEqual(inspect.preview.snapshot,{...proof.snapshot,journal_seq:String(proof.snapshot.journal_seq)});
 const retry={...original,confirm:true,recovery_token:inspect.recovery_token};assert((await post('retry',retry)).committed);assert((await post('retry',retry)).committed);assert.equal(row('SELECT * FROM settlement_history').length,1);assert.equal(row('SELECT * FROM finance_entries').length,1);assert.equal(row('SELECT * FROM request_results').length,1);assert.equal(row('SELECT * FROM bot_outbox').length,4);assert.equal((await post('inspect',original)).state,'committed');
 const consume=JSON.parse(execFileSync('python3',[resolve('tools/rebuild/retained-python-fixture.py'),source,database,'plain','synthetic',origin],{env:{PATH:process.env.PATH,PYTHONDONTWRITEBYTECODE:'1',KANBAN_BOT_BASE_URL:origin},encoding:'utf8',timeout:15000}));assert.equal(consume.first.sent,4);assert.equal(consume.second.claimed,0);const uploads=consume.calls.filter(c=>c.path.endsWith('/files'));assert.equal(uploads.length,3);for(const upload of uploads)assert.equal(upload.body.file_data,image);const saved=row('SELECT * FROM bot_outbox');assert(saved.every(r=>r.status==='sent'));assert((await post('retry',retry)).committed);assert.deepEqual(row('SELECT * FROM bot_outbox'),saved);
 child.kill('SIGTERM');assert.equal((await closed).code,0,logs);child=undefined;
 for(const pin of runtimePins)assert.equal(hash(readFileSync('.rebuild-dist/'+pin.path)),pin.sha256);for(const pin of sourcePins)assert.equal(hash(readFileSync(join(source,pin.path))),pin.sha256);
 console.log(JSON.stringify({version:1,pythonCommit:commit,sourcePins,runtimePins,originalProofVerified:true,compiledRecoveryVerified:true,historyVersions:1,financeEntries:1,originalReceipts:1,originalWorkerSent:4,originalImagesUploaded:3,originalReplayWrites:0,networkTransport:'denied',actualQQ:false,releaseEligible:false,scope:'none',deployment:'none'}));
}finally{if(child){child.kill('SIGTERM');await closed;}rmSync(root,{recursive:true,force:true});}
