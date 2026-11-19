import * as fs from 'node:fs';
import {dirname,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {afterEach,expect,it} from 'vitest';
import {legacyHistoryFixture} from '../testsupport/legacy-history-fixture';
import {erasureJournal} from './erasure-journal';
import {createPrivacy} from './privacy';
import {hash} from './security';
import {profileId,digest} from '../../../tools/migration/music-codec';
import {captureRollbackMedia} from '../../../tools/migration/rollback-media';
import {projectRollbackStateFromCheckpoint} from '../../../tools/migration/rollback-state';
import {projectRollbackHistory} from '../../../tools/migration/rollback-history';
import {assembleRollbackPackage,pinRollbackPackageSource} from '../../../tools/migration/rollback-package-codec';
import {readRollbackPackage,writeRollbackPackage} from '../../../tools/migration/rollback-package';
import {writeRollbackHistoryCatalog} from '../../../tools/migration/rollback-history-catalog';
import {readRollbackErasureAuthority,writeRollbackErasureAuthority} from '../../../tools/migration/rollback-erasure-authority';
const cleanup:(()=>void)[]=[];afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();});
const stamp=new Date('2026-11-19T12:00:00Z');
async function setup(){
  const s=await legacyHistoryFixture();cleanup.push(()=>s.close());const data=dirname(s.db.name),journal=erasureJournal(s.db);
  for(const [i,status] of ['pending','sending','sent','failed','skipped'].entries())s.db.prepare("INSERT INTO bot_outbox(event_id,kind,dedupe_key,target,payload_json,status,claim_token,retry_at,simulated_at,delivered_payload_json,created_at) VALUES('listen','authority',?,'synthetic','{}',?,?,?,?,?,'historical')").run('authority-'+i,status,status==='sending'?'original-uncertain':'',status==='failed'?'original-retry':null,status==='skipped'?'original-simulation':null,status==='sent'?'original-sent':null);
  const privacy=createPrivacy(s.db,journal),intent={version:1 as const,kind:'both' as const,userId:'bob',profileId:profileId('10002'),requestId:randomUUID(),createdAt:'2026-11-19T01:00:00.000Z',secretHash:hash('synthetic-secret'),signature:hash('synthetic-signature')};s.db.transaction(()=>privacy.submit(intent)).immediate();privacy.guard();
  const media=captureRollbackMedia(s.db,journal),state=projectRollbackStateFromCheckpoint(media.checkpointImage,media.journal),history=projectRollbackHistory(state,{capture:s.config,native:{root:join(data,'paired-backups'),manifests:[]}}),pkg=assembleRollbackPackage(state,media,history,pinRollbackPackageSource(media,{captureManifestSha256:s.config.manifestSha256,native:[]})),packageRoot=join(s.root,'package'),packagePin=writeRollbackPackage(pkg,packageRoot,[s.capture,data],stamp).manifestSha256,authority=join(s.root,'authority'),board=join(s.root,'old-board'),music=join(s.root,'old-music'),unified=join(s.root,'old-unified'),catalog=join(s.root,'catalog');
  for(const folder of [board,music,unified])fs.mkdirSync(folder,{mode:0o700});
  fs.writeFileSync(join(board,'board.sqlite3'),state.boardImage,{mode:0o600});fs.writeFileSync(join(board,'board.erasures.jsonl'),state.erasures.boardJournal,{mode:0o600});
  fs.writeFileSync(join(music,'data.json'),JSON.stringify(state.music.data)+'\n',{mode:0o600});fs.writeFileSync(join(music,'identity.sqlite3'),state.identityImage,{mode:0o600});fs.writeFileSync(join(music,'erasures.jsonl'),state.erasures.musicJournal,{mode:0o600});
  fs.writeFileSync(join(unified,'unified.erasures.jsonl'),state.erasures.unifiedJournal,{mode:0o600});fs.mkdirSync(join(music,'paired-backups',s.stamp),{recursive:true,mode:0o700});fs.writeFileSync(join(music,'paired-backups',s.stamp,'data.json'),JSON.stringify(history.projections.find(row=>row.source==='legacy_pair')!.data)+'\n',{mode:0o600});
  const prepare=(guard?:()=>void)=>writeRollbackErasureAuthority(packageRoot,packagePin,authority,stamp,guard);
  return {...s,data,state,packageRoot,packagePin,authority,board,music,unified,catalog,prepare};
}
const preamble=`import json,os,sys
from pathlib import Path
from tools.migration.rollback_erasure_authority import ErasureAuthority
root,pin,board,music,unified,case=sys.argv[1:]
sources={'board':str(Path(board)/'board.erasures.jsonl'),'music':str(Path(music)/'erasures.jsonl'),'unified':str(Path(unified)/'unified.erasures.jsonl')}
client=ErasureAuthority(root,pin,sources,sqlite_files=[str(Path(board)/'board.sqlite3'),str(Path(music)/'identity.sqlite3')])
`;
function python(s:Awaited<ReturnType<typeof setup>>,pin:string,body:string,scenario='normal'){
  return execFileSync('python3',['-c',preamble+body,s.authority,pin,s.board,s.music,s.unified,scenario],{timeout:30000,encoding:'utf8',stdio:['ignore','pipe','pipe']});
}
it('prepares all original latest ledgers from the complete package in an exclusive private authority, without touching bot/source data',async()=>{
  const s=await setup(),before=s.db.serialize(),saved=s.prepare(),read=readRollbackErasureAuthority(s.authority,saved.manifestSha256);
  expect(read.head.sequence).toBe(0);expect(read.manifest.sourcePackageSha256).toBe(s.packagePin);expect(read.ledgers).toEqual({board:Buffer.from(s.state.erasures.boardJournal),music:Buffer.from(s.state.erasures.musicJournal),unified:Buffer.from(s.state.erasures.unifiedJournal)});
  expect(fs.statSync(s.authority).mode&0o7777).toBe(0o700);expect(read.rollbackEligible).toBe(false);read.assertUnchanged();readRollbackPackage(s.packageRoot,s.packagePin).assertUnchanged();expect(s.db.serialize()).toEqual(before);
});
it('round-trips exact old Python JSON bytes through chained write-ahead records for all three domains and an independent TS reader',async()=>{
  const s=await setup(),before=s.db.serialize(),saved=s.prepare(),stdout=python(s,saved.manifestSha256,`try:
 board=(json.dumps({'user_id':'contact-owner','request_id':'original-account-request','created_at':'original-unknown-zone'},separators=(',',':'))+'\\n').encode()
 music=(json.dumps({'qq':'10001','erased_at':1001.25})+'\\n').encode()
 unified=(json.dumps({'user_id':'alice','request_id':'another-native-request','created_at':'original-time'},separators=(',',':'))+'\\n').encode()
 for domain,raw in [('board',board),('music',music),('unified',unified)]:client.record(domain,raw)
 head,ledgers=client.snapshot();assert head['sequence']==3
 for domain in sources:
  with client.guard(domain) as raw:assert raw==ledgers[domain]
 print(json.dumps({'records':3,'rollbackEligible':False}))
finally:client.close()
`);expect(JSON.parse(stdout)).toEqual({records:3,rollbackEligible:false});
  const read=readRollbackErasureAuthority(s.authority,saved.manifestSha256);expect(read.head.sequence).toBe(3);for(const domain of ['board','music','unified'] as const)expect(read.ledgers[domain]).toEqual(fs.readFileSync(domain==='board'?join(s.board,'board.erasures.jsonl'):domain==='music'?join(s.music,'erasures.jsonl'):join(s.unified,'unified.erasures.jsonl')));read.assertUnchanged();expect(s.db.serialize()).toEqual(before);
});
const originalScript=`from qgroup_core import privacy,storage
from music_site import service
from tools.migration.rollback_erasure_runtime import install_legacy_erasure_authority
os.environ['KANBAN_ORIGIN']='https://fixture.invalid'
service.upstream.DATA_FILE=str(Path(music)/'data.json');service.upstream.BACKUP_DIR=str(Path(music)/'backups');service.STORE=service.Store(Path(music)/'identity.sqlite3');service.upstream.data=json.loads(Path(service.upstream.DATA_FILE).read_text())
uninstall=install_legacy_erasure_authority(client,music_service=service,board_privacy=privacy,board_database=str(Path(board)/'board.sqlite3'))
try:
 privacy.recover(Path(board)/'board.sqlite3');service.replay(Path(music),service.STORE);service.upstream.load()
 if case=='write':
  with storage.connect(Path(board)/'board.sqlite3') as db:
   db.execute('BEGIN IMMEDIATE');user=db.execute("SELECT * FROM users WHERE id='contact-owner'").fetchone();result=privacy.close(db,user,{'confirm_close':True});assert result['status']=='completed'
  with service.upstream._lock:service.administration.erase(Path(music),service.STORE,{'qq':'10001','confirm':'DELETE'})
 else:
  for _ in range(2):privacy.recover(Path(board)/'board.sqlite3');service.replay(Path(music),service.STORE)
  with storage.connect(Path(board)/'board.sqlite3') as db:
   assert db.execute("SELECT nickname FROM users WHERE id='contact-owner'").fetchone()[0]=='已注销用户'
   assert db.execute("SELECT 1 FROM browser_sessions WHERE user_id='contact-owner'").fetchone() is None
   assert [r[0] for r in db.execute('SELECT status FROM bot_outbox ORDER BY id')]==['pending','sending','sent','failed','skipped']
  data=json.loads((Path(music)/'data.json').read_text());assert '10001' not in data['members'] and '10002' not in data['members']
  with service.STORE.connect() as db:assert db.execute("SELECT 1 FROM prelinks WHERE qq='10001'").fetchone() is None
 print(json.dumps({'case':case,'originalPrivacy':True,'originalMusic':True,'records':client.snapshot()[0]['sequence'],'workerStarted':False}))
finally:uninstall();client.close()
`;
it.each(['baseline','missing','partial'] as const)('restores %s old-service ledgers after a real process restart, replays original privacy/music twice and preserves bot work',async shape=>{
  const s=await setup(),before=s.db.serialize(),saved=s.prepare();expect(JSON.parse(python(s,saved.manifestSha256,originalScript,'write'))).toMatchObject({records:2,workerStarted:false});
  const paths=[join(s.board,'board.erasures.jsonl'),join(s.music,'erasures.jsonl')],baseline=[s.state.erasures.boardJournal,s.state.erasures.musicJournal];
  paths.forEach((path,i)=>{if(shape==='missing')fs.rmSync(path);else if(shape==='partial'){const bytes=fs.readFileSync(path);fs.writeFileSync(path,bytes.subarray(0,bytes.length-3));}else fs.writeFileSync(path,baseline[i]!);});
  fs.writeFileSync(join(s.board,'board.sqlite3'),s.state.boardImage);fs.writeFileSync(join(s.music,'data.json'),JSON.stringify(s.state.music.data)+'\n');fs.writeFileSync(join(s.music,'identity.sqlite3'),s.state.identityImage);
  expect(JSON.parse(python(s,saved.manifestSha256,originalScript,'recover'))).toMatchObject({records:2,originalPrivacy:true,originalMusic:true,workerStarted:false});
  const read=readRollbackErasureAuthority(s.authority,saved.manifestSha256);expect(fs.readFileSync(paths[0]!)).toEqual(read.ledgers.board);expect(fs.readFileSync(paths[1]!)).toEqual(read.ledgers.music);read.assertUnchanged();expect(s.db.serialize()).toEqual(before);readRollbackPackage(s.packageRoot,s.packagePin).assertUnchanged();
},20000);
it.each(['record_fsynced','head_published','before_source','source_fsynced'])('recovers an actual exit after %s without losing or duplicating the old account intent',async stage=>{
  const s=await setup(),saved=s.prepare();let exitStatus:number|null=null;
  try{python(s,saved.manifestSha256,`from qgroup_core import privacy,storage
from tools.migration.rollback_erasure_runtime import install_legacy_erasure_authority
client.fault_hook=lambda reached:os._exit(77) if reached==case else None
install_legacy_erasure_authority(client,board_privacy=privacy,board_database=str(Path(board)/'board.sqlite3'))
with storage.connect(Path(board)/'board.sqlite3') as db:
 db.execute('BEGIN IMMEDIATE');privacy.close(db,db.execute("SELECT * FROM users WHERE id='contact-owner'").fetchone(),{'confirm_close':True})
`,stage);}catch(error){exitStatus=(error as {status:number|null}).status;}expect(exitStatus).toBe(77);
  const output=python(s,saved.manifestSha256,`from qgroup_core import privacy,storage
from tools.migration.rollback_erasure_runtime import install_legacy_erasure_authority
try:
 install_legacy_erasure_authority(client,board_privacy=privacy,board_database=str(Path(board)/'board.sqlite3'))
 for _ in range(2):privacy.recover(Path(board)/'board.sqlite3')
 with storage.connect(Path(board)/'board.sqlite3') as db:
  assert db.execute("SELECT nickname FROM users WHERE id='contact-owner'").fetchone()[0]=='已注销用户'
  assert db.execute("SELECT count(*) FROM privacy_requests WHERE user_id='contact-owner'").fetchone()[0]==1
 assert client.snapshot()[0]['sequence']==1
 print(json.dumps({'recordCount':1,'recoverCount':2}))
finally:client.close()
`);expect(JSON.parse(output)).toEqual({recordCount:1,recoverCount:2});expect(readRollbackErasureAuthority(s.authority,saved.manifestSha256).head.sequence).toBe(1);
},20000);
const httpScript=`import base64,http.client,threading,subprocess
from urllib.parse import quote
os.environ['KANBAN_MUSIC_PROXY_KEY']='synthetic-proxy-key-'+('a'*32)
os.environ['KANBAN_ORIGIN']='https://fixture.invalid'
from music_site import service
from tools.migration.rollback_erasure_runtime import install_legacy_erasure_authority
from tools.migration.rollback_history_runtime import install_rollback_history_adapter
service.ORIGIN='https://fixture.invalid';service.upstream.DATA_FILE=str(Path(music)/'data.json');service.upstream.BACKUP_DIR=str(Path(music)/'backups');service.STORE=service.Store(Path(music)/'identity.sqlite3');service.upstream.data=json.loads(Path(service.upstream.DATA_FILE).read_text())
uninstall=install_legacy_erasure_authority(client,music_service=service)
service.replay(Path(music),service.STORE);service.upstream.load()
catalog_root,catalog_pin=sys.argv[-2:]
catalog=install_rollback_history_adapter(service,catalog_root,catalog_pin,authority=client)
server=service.ThreadingHTTPServer(('127.0.0.1',0),service.Handler);thread=threading.Thread(target=server.serve_forever);thread.start()
def request(path,body=None,admin=True,key=True):
 headers={'X-Music-Identity':base64.urlsafe_b64encode(json.dumps({'admin_actor':'synthetic-admin'} if admin else {'user_id':'synthetic-member'}).encode()).decode()}
 if key:headers['X-Music-Proxy-Key']=os.environ['KANBAN_MUSIC_PROXY_KEY']
 if body is not None:headers.update({'Origin':service.ORIGIN,'Content-Type':'application/json'})
 conn=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=5)
 try:
  conn.request('POST' if body is not None else 'GET',path,body=json.dumps(body) if body is not None else None,headers=headers)
  response=conn.getresponse();raw=response.read();return response.status,dict(response.getheaders()),json.loads(raw)
 finally:conn.close()
helper=None
try:
 manifest,_=catalog.read();names=[row['id'] for row in manifest['histories']];urls=['/api/admin/backup?name='+quote(name) for name in names]+['/api/admin/backup?name=20261118-010203','/api/export']
 assert request('/api/admin/backups',admin=False)[0]==401 and request(urls[0],key=False)[0]==403
 before=client.snapshot()[0]['sequence'];assert request('/api/admin/member/delete',{'qq':'10001','confirm':'WRONG'})[0]==400;assert client.snapshot()[0]['sequence']==before
 if case=='delete':
  assert request('/api/admin/member/delete',{'qq':'10001','confirm':'DELETE'})[0]==200
  assert client.snapshot()[0]['sequence']==1
  for url in urls:
   status,headers,data=request(url);assert status==200 and '10001' not in data['members'] and '10002' not in data['members'];assert headers['Cache-Control']=='no-store'
 elif case=='current authority':
  service.upstream.data['members']['10001']['pinHash']='NEW-CURRENT-PIN'
  with service.STORE.connect() as db:
   db.execute("DELETE FROM prelinks WHERE qq='10001'");db.execute("INSERT OR REPLACE INTO link_overrides VALUES('10001','',1,1000)")
  for url in urls:
   status,_,data=request(url);assert status==200 and data['members']['10001']['pinHash']=='NEW-CURRENT-PIN' and data['members']['10001']['boardUserId']==''
 elif case=='lost source':
  client.record('music',(json.dumps({'qq':'10001','erased_at':1001})+'\\n').encode());(Path(music)/'erasures.jsonl').write_bytes(Path(root,'baseline/music.erasures.jsonl').read_bytes())
  for url in urls:
   status,_,data=request(url);assert status==503 and root not in json.dumps(data) and music not in json.dumps(data)
 elif case=='competing process':
  code='from tools.migration.rollback_erasure_authority import ErasureAuthority\\nimport sys\\nc=ErasureAuthority(sys.argv[1],sys.argv[2])\\nwith c._held():\\n print("held",flush=True)\\n sys.stdin.read(1)\\nc.close()'
  helper=subprocess.Popen([sys.executable,'-c',code,root,pin],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True);assert helper.stdout.readline().strip()=='held'
  for url in urls:assert request(url)[0]==503
  helper.communicate('x',timeout=5);assert helper.returncode==0;helper=None
  for url in urls:assert request(url)[0]==200
 else:raise AssertionError('Unknown private scenario')
 print(json.dumps({'case':case,'oldHttp':True,'namespaceCount':len(names),'rollbackEligible':False,'workerStarted':False}))
finally:
 if helper is not None:
  helper.communicate('x',timeout=5)
 server.shutdown();server.server_close();thread.join();uninstall();client.close()
`;
it.each(['delete','current authority','lost source','competing process'])('uses the actual isolated old HTTP Handler for %s across namespace, ordinary history and current exports',async scenario=>{
  const s=await setup(),before=s.db.serialize(),saved=s.prepare(),catalog=writeRollbackHistoryCatalog(s.packageRoot,s.packagePin,s.catalog,stamp),script=preamble.replace('root,pin,board,music,unified,case=sys.argv[1:]','root,pin,board,music,unified,case=sys.argv[1:7]')+httpScript;
  const stdout=execFileSync('python3',['-c',script,s.authority,saved.manifestSha256,s.board,s.music,s.unified,scenario,s.catalog,catalog.manifestSha256],{timeout:30000,encoding:'utf8',stdio:['ignore','pipe','pipe']});expect(JSON.parse(stdout)).toMatchObject({oldHttp:true,namespaceCount:2,rollbackEligible:false,workerStarted:false});
  expect(s.db.serialize()).toEqual(before);readRollbackPackage(s.packageRoot,s.packagePin).assertUnchanged();readRollbackErasureAuthority(s.authority,saved.manifestSha256).assertUnchanged();
},20000);
it.each(['missing head','missing record','changed record','partial record','foreign source','replaced lock','replaced root'])('rejects %s without silently regenerating authority or losing the private intent',async change=>{
  const s=await setup(),saved=s.prepare();python(s,saved.manifestSha256,`try:client.record('music',(json.dumps({'qq':'10001','erased_at':1001})+'\\n').encode())
finally:client.close()
`);
  const head=join(s.authority,'authority-head.json'),record=join(s.authority,'records/000000000001.json'),source=join(s.music,'erasures.jsonl');
  if(change==='missing head')fs.rmSync(head);if(change==='missing record')fs.rmSync(record);if(change==='changed record'){const row=JSON.parse(fs.readFileSync(record,'utf8'));row.previousRecordSha256='0'.repeat(64);fs.writeFileSync(record,JSON.stringify(row)+'\n');}if(change==='partial record')fs.appendFileSync(record,' ');if(change==='foreign source')fs.appendFileSync(source,'{"qq":"10003","erased_at":9}\n');
  if(change==='replaced lock'||change==='replaced root'){
    const stdout=python(s,saved.manifestSha256,`try:
 path=Path(root)/'.authority.lock' if case=='replaced lock' else Path(root)
 path.rename(str(path)+'-saved')
 if case=='replaced lock':path.write_bytes(b'');path.chmod(0o600)
 else:path.mkdir(mode=0o700)
 try:client.recover('music')
 except (ValueError,OSError):pass
 else:raise AssertionError('Replacement accepted')
 print(json.dumps({'rejected':True}))
finally:client.close()
`,change);expect(JSON.parse(stdout)).toEqual({rejected:true});
  }else expect(()=>python(s,saved.manifestSha256,`try:client.recover('music')
finally:client.close()
`)).toThrow();
  if(change!=='foreign source'&&change!=='replaced lock'&&change!=='replaced root')expect(()=>readRollbackErasureAuthority(s.authority,saved.manifestSha256)).toThrow();
});
it('detects a rehashed bad record using the retained chain and verifies the source remains unchanged',async()=>{
  const s=await setup(),saved=s.prepare();python(s,saved.manifestSha256,`try:client.record('music',(json.dumps({'qq':'10001','erased_at':1001})+'\\n').encode())
finally:client.close()
`);const path=join(s.authority,'records/000000000001.json'),row=JSON.parse(fs.readFileSync(path,'utf8'));row.ledgerSha256='0'.repeat(64);const bytes=Buffer.from(JSON.stringify(row)+'\n');fs.writeFileSync(path,bytes);const headPath=join(s.authority,'authority-head.json'),head=JSON.parse(fs.readFileSync(headPath,'utf8'));head.recordSha256=digest(bytes);fs.writeFileSync(headPath,JSON.stringify(head)+'\n');expect(()=>readRollbackErasureAuthority(s.authority,saved.manifestSha256)).toThrow('ledger differs');
});
it.each([1,2,3])('fences changed package bytes at authority preparation guard %i and preserves late failures as incomplete',async stage=>{
  const s=await setup();let calls=0;expect(()=>s.prepare(()=>{if(++calls===stage)fs.appendFileSync(join(s.packageRoot,'projection/music/data.json'),' ');})).toThrow();if(stage===1)expect(fs.existsSync(s.authority)).toBe(false);else expect(fs.existsSync(join(s.authority,'incomplete.json'))).toBe(true);
});
it.each(['root','parent','baseline','records'])('fences a replaced authority %s at the final guard without writing into replacement ownership',async change=>{
  const s=await setup(),parent=join(s.root,'authority-parent'),destination=join(parent,'authority');fs.mkdirSync(parent,{mode:0o700});let calls=0;
  expect(()=>writeRollbackErasureAuthority(s.packageRoot,s.packagePin,destination,stamp,()=>{if(++calls!==3)return;const path=change==='root'?destination:change==='parent'?parent:join(destination,change);fs.renameSync(path,path+'-saved');fs.mkdirSync(path,{mode:0o700});if(change==='parent')fs.mkdirSync(destination,{mode:0o700});fs.writeFileSync(join(change==='baseline'||change==='records'?path:destination,'keep'),'other',{mode:0o600});})).toThrow();
  if(change==='baseline'||change==='records')expect(fs.existsSync(join(destination,'incomplete.json'))).toBe(true);else expect(fs.readdirSync(destination)).toEqual(['keep']);
});
it.each(['conflicting account ID','invalid key','partial suffix','foreign binding','async fault hook'])('rejects %s without silently losing an intent or changing original data',async change=>{
  const s=await setup(),saved=s.prepare(),original=fs.readFileSync(join(s.board,'board.erasures.jsonl'));
  const stdout=python(s,saved.manifestSha256,`try:
 raw=(json.dumps({'user_id':'contact-owner','request_id':'shared-fixture-request','created_at':'original'})+'\\n').encode()
 if case=='conflicting account ID':
  client.record('board',raw);raw=(json.dumps({'user_id':'alice','request_id':'shared-fixture-request','created_at':'original'})+'\\n').encode()
 if case=='invalid key':raw=(json.dumps({'qq':'../../other','erased_at':1})+'\\n').encode()
 if case=='partial suffix':raw=raw[:-1]
 if case=='foreign binding':client.sources['board']=Path(music)/'erasures.jsonl'
 if case=='async fault hook':
  async def hook(stage):return None
  client.fault_hook=hook
 try:client.record('music' if case=='invalid key' else 'board',raw)
 except (ValueError,OSError):pass
 else:raise AssertionError('Invalid authority write accepted')
 print(json.dumps({'rejected':True}))
finally:client.close()
`,change);expect(JSON.parse(stdout)).toEqual({rejected:true});
  if(change!=='conflicting account ID')expect(fs.readFileSync(join(s.board,'board.erasures.jsonl'))).toEqual(original);
  readRollbackPackage(s.packageRoot,s.packagePin).assertUnchanged();
});
it('retains real Python SQLite writer exclusion when an authority source is renamed onto its held DB inode',async()=>{
  const s=await setup(),saved=s.prepare(),stdout=python(s,saved.manifestSha256,`import sqlite3,subprocess
path=Path(board)/'board.sqlite3';ledger=Path(sources['board']);saved=ledger.with_name('original-ledger')
db=sqlite3.connect(path,timeout=0)
try:
 db.execute('BEGIN IMMEDIATE');ledger.rename(saved);path.rename(ledger)
 try:client.recover('board')
 except ValueError as error:assert 'SQLite inode' in str(error)
 else:raise AssertionError('Live SQLite alias opened')
 code='import sqlite3,sys\\nc=sqlite3.connect(sys.argv[1],timeout=0)\\ntry:\\n c.execute("BEGIN IMMEDIATE")\\nexcept sqlite3.OperationalError as e:\\n assert "locked" in str(e)\\nelse:\\n raise AssertionError("Writer lock was lost")\\nfinally:\\n c.close()'
 subprocess.run([sys.executable,'-c',code,str(ledger)],check=True,timeout=5,capture_output=True)
 print(json.dumps({'rawSQLiteOpened':False,'competingWriterExcluded':True}))
finally:
 db.rollback();db.close();ledger.rename(path);saved.rename(ledger);client.close()
`);expect(JSON.parse(stdout)).toEqual({rawSQLiteOpened:false,competingWriterExcluded:true});
});
it('retains exclusion for a newly restored SQLite inode first observed after authority installation',async()=>{
  const s=await setup(),saved=s.prepare(),stdout=python(s,saved.manifestSha256,`import sqlite3,subprocess
path=Path(board)/'board.sqlite3';original=path.with_name('original-database');ledger=Path(sources['board']);saved=ledger.with_name('original-ledger')
path.rename(original);db=sqlite3.connect(path,timeout=0);path.chmod(0o600)
try:
 db.execute('CREATE TABLE isolated(value)');db.execute('BEGIN IMMEDIATE');client.snapshot()
 ledger.rename(saved);path.rename(ledger)
 try:client.recover('board')
 except ValueError as error:assert 'SQLite inode' in str(error)
 else:raise AssertionError('Restored SQLite inode opened as ledger')
 code='import sqlite3,sys\\nc=sqlite3.connect(sys.argv[1],timeout=0)\\ntry:\\n c.execute("BEGIN IMMEDIATE")\\nexcept sqlite3.OperationalError as e:\\n assert "locked" in str(e)\\nelse:\\n raise AssertionError("Restored writer lock was lost")\\nfinally:\\n c.close()'
 subprocess.run([sys.executable,'-c',code,str(ledger)],check=True,timeout=5,capture_output=True)
 print(json.dumps({'restoredInodeProtected':True,'competingWriterExcluded':True}))
finally:
 db.rollback();db.close();ledger.rename(path);saved.rename(ledger);path.unlink();original.rename(path);client.close()
`);expect(JSON.parse(stdout)).toEqual({restoredInodeProtected:true,competingWriterExcluded:true});
});
it.each(['existing','overlap','relative','wrong pin','async guard'])('rejects %s authority preparation without overwriting sources',async change=>{
  const s=await setup();let root=s.authority,pin=s.packagePin;if(change==='existing'){fs.mkdirSync(root);fs.writeFileSync(join(root,'keep'),'other');}if(change==='overlap')root=join(s.packageRoot,'authority');if(change==='relative')root='relative';if(change==='wrong pin')pin='0'.repeat(64);
  expect(()=>writeRollbackErasureAuthority(s.packageRoot,pin,root,stamp,change==='async guard'?async()=>{}:undefined)).toThrow();if(change!=='existing')expect(fs.existsSync(root)).toBe(false);
});
it.each(['baseline bytes','head bytes','extra file','public file','wrong pin','head view','ledger view'])('independently rejects authority %s changes',async change=>{
  const s=await setup(),saved=s.prepare(),read=readRollbackErasureAuthority(s.authority,saved.manifestSha256);let pin=saved.manifestSha256;
  if(change==='baseline bytes')fs.appendFileSync(join(s.authority,'baseline/board.erasures.jsonl'),' ');if(change==='head bytes')fs.appendFileSync(join(s.authority,'authority-head.json'),' ');if(change==='extra file')fs.writeFileSync(join(s.authority,'extra'),'x',{mode:0o600});if(change==='public file')fs.chmodSync(join(s.authority,'.authority.lock'),0o644);if(change==='wrong pin')pin='0'.repeat(64);if(change==='head view')read.head.sequence=1;if(change==='ledger view')read.ledgers.board.fill(0);
  if(change.endsWith('view'))expect(()=>read.assertUnchanged()).toThrow();else expect(()=>readRollbackErasureAuthority(s.authority,pin)).toThrow();
});
it('returns only redacted CLI pins/counts when preparing the private authority',async()=>{
  const s=await setup(),stdout=execFileSync(process.execPath,['--import','tsx','tools/migration/rollback-erasure-authority.ts',s.packageRoot,s.packagePin,s.authority],{encoding:'utf8',timeout:20000}),result=JSON.parse(stdout);expect(result).toMatchObject({status:'prepared_private_erasure_authority',records:0,rollbackEligible:false});expect(stdout).not.toMatch(/synthetic-secret|original-uncertain|10001|\/Users|\/tmp/);readRollbackErasureAuthority(s.authority,result.manifestSha256).assertUnchanged();
});

function maintain(s:Awaited<ReturnType<typeof setup>>,pin:string,command='erase',extra=['--qq','10001']){
  return execFileSync('python3',['-m','tools.migration.rollback_music_maintenance',command,'--folder',s.music,'--authority',s.authority,'--manifest-sha256',pin,...extra],{encoding:'utf8',timeout:30000});
}
it('uses the real offline CLI to preserve erasure before replay, restore old files and recover twice without starting old HTTP or bot',async()=>{
  const s=await setup(),before=s.db.serialize(),saved=s.prepare();
  const result=JSON.parse(maintain(s,saved.manifestSha256));expect(result).toEqual({status:'completed_private_music_erase',records:1,rollbackEligible:false});
  expect(JSON.parse(fs.readFileSync(join(s.music,'data.json'),'utf8')).members).not.toHaveProperty('10001');
  fs.writeFileSync(join(s.music,'data.json'),JSON.stringify(s.state.music.data)+'\n');fs.writeFileSync(join(s.music,'identity.sqlite3'),s.state.identityImage);fs.rmSync(join(s.music,'erasures.jsonl'));
  for(let i=0;i<2;i++)expect(JSON.parse(maintain(s,saved.manifestSha256,'recover',[]))).toEqual({status:'completed_private_music_recover',records:1,rollbackEligible:false});
  expect(JSON.parse(fs.readFileSync(join(s.music,'data.json'),'utf8')).members).not.toHaveProperty('10001');
  const read=readRollbackErasureAuthority(s.authority,saved.manifestSha256);expect(read.head.sequence).toBe(1);expect(fs.readFileSync(join(s.music,'erasures.jsonl'))).toEqual(read.ledgers.music);read.assertUnchanged();expect(s.db.serialize()).toEqual(before);readRollbackPackage(s.packageRoot,s.packagePin).assertUnchanged();
});
it.each(['invalid key','wrong pin','foreign ledger','missing database','missing data','public service lock'])('rejects offline maintenance with %s, redacts the error and does not initialize missing service files',async change=>{
  const s=await setup(),saved=s.prepare();let pin=saved.manifestSha256,extra=['--qq','10001'];
  if(change==='invalid key')extra=['--qq','../../invalid-synthetic'];if(change==='wrong pin')pin='0'.repeat(64);if(change==='foreign ledger')fs.appendFileSync(join(s.music,'erasures.jsonl'),'{"qq":"10003","erased_at":1}\n');if(change==='missing database')fs.rmSync(join(s.music,'identity.sqlite3'));if(change==='missing data')fs.rmSync(join(s.music,'data.json'));if(change==='public service lock')fs.writeFileSync(join(s.music,'.service.lock'),'',{mode:0o644});
  const data=fs.existsSync(join(s.music,'data.json'))?fs.readFileSync(join(s.music,'data.json')):null,identity=fs.existsSync(join(s.music,'identity.sqlite3'))?fs.readFileSync(join(s.music,'identity.sqlite3')):null;let failure:unknown;
  try{maintain(s,pin,'erase',extra);}catch(error){failure=error;}expect(failure).toBeDefined();expect((failure as {status:number}).status).toBe(1);const stderr=String((failure as {stderr:string}).stderr);expect(stderr).toMatch(/^Private music maintenance rejected\./);expect(stderr).not.toMatch(/Traceback|10001|10003|synthetic|\/Users|\/tmp/);
  if(data)expect(fs.readFileSync(join(s.music,'data.json'))).toEqual(data);else expect(fs.existsSync(join(s.music,'data.json'))).toBe(false);if(identity)expect(fs.readFileSync(join(s.music,'identity.sqlite3'))).toEqual(identity);else expect(fs.existsSync(join(s.music,'identity.sqlite3'))).toBe(false);expect(readRollbackErasureAuthority(s.authority,saved.manifestSha256).head.sequence).toBe(0);readRollbackPackage(s.packageRoot,s.packagePin).assertUnchanged();
});
it.each(['service','authority'])('excludes an actual competing %s process from the authority-aware offline CLI without changing service data',async lock=>{
  const s=await setup(),saved=s.prepare(),before=fs.readFileSync(join(s.music,'data.json')),stdout=python(s,saved.manifestSha256,`import fcntl,subprocess
path=Path(music)/'.service.lock' if case=='service' else Path(root)/'.authority.lock'
if not path.exists():path.touch(mode=0o600)
with path.open('r+') as held:
 fcntl.flock(held,fcntl.LOCK_EX|fcntl.LOCK_NB)
 result=subprocess.run([sys.executable,'-m','tools.migration.rollback_music_maintenance','erase','--folder',music,'--authority',root,'--manifest-sha256',pin,'--qq','10001'],capture_output=True,text=True,timeout=10)
 assert result.returncode==1 and result.stdout=='' and result.stderr.startswith('Private music maintenance rejected.') and 'Traceback' not in result.stderr
 print(json.dumps({'competingMaintenanceExcluded':True}))
client.close()
`,lock);expect(JSON.parse(stdout)).toEqual({competingMaintenanceExcluded:true});expect(fs.readFileSync(join(s.music,'data.json'))).toEqual(before);expect(readRollbackErasureAuthority(s.authority,saved.manifestSha256).head.sequence).toBe(0);
});
it('independently verifies real appended authority records from the CLI and returns only pins and counts',async()=>{
  const s=await setup(),saved=s.prepare();maintain(s,saved.manifestSha256);
  const stdout=execFileSync(process.execPath,['--import','tsx','tools/migration/read-rollback-erasure-authority.ts',s.authority,saved.manifestSha256],{encoding:'utf8',timeout:20000});expect(JSON.parse(stdout)).toEqual({status:'verified_private_erasure_authority',manifestSha256:saved.manifestSha256,sourcePackageSha256:s.packagePin,records:1,rollbackEligible:false});expect(stdout).not.toMatch(/10001|synthetic|\/Users|\/tmp/);
  fs.appendFileSync(join(s.authority,'records/000000000001.json'),' ');let failure:unknown;try{execFileSync(process.execPath,['--import','tsx','tools/migration/read-rollback-erasure-authority.ts',s.authority,saved.manifestSha256],{encoding:'utf8',timeout:20000});}catch(error){failure=error;}expect((failure as {status:number}).status).toBe(1);expect(String((failure as {stderr:string}).stderr)).not.toMatch(/Traceback|10001|synthetic|\/Users|\/tmp/);
});
