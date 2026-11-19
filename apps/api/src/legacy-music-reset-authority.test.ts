import * as fs from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {afterEach,expect,it} from 'vitest';
import {legacyResetFixture} from '../testsupport/legacy-reset-fixture';
import {readRollbackErasureAuthority,ErasureAuthorityRecord,encode} from './erasure-authority-protocol';
import {createRetainedErasureJournal} from './retained-erasure-journal';
import {acquireInheritedAuthorityLock} from './erasure-authority-lock';
import {erasureJournalPath} from './erasure-journal';
import {projectNativeForwardErasures} from '../../../tools/migration/forward-erasure-projection';
import {readRollbackPackage} from '../../../tools/migration/rollback-package';
import {digest} from '../../../packages/runtime/src/strict-json';

const cleanup:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function setup(empty=false){const s=await legacyResetFixture();cleanup.push(()=>s.close());if(empty){const value=JSON.parse(fs.readFileSync(join(s.music,'data.json'),'utf8'));value.members={};fs.writeFileSync(join(s.music,'data.json'),JSON.stringify(value)+'\n');}return s;}
const preamble=`import json,os,sys,hashlib
from pathlib import Path
from tools.migration.rollback_erasure_authority import ErasureAuthority
root,pin,music,case=sys.argv[1:]
os.umask(0o077)
client=ErasureAuthority(root,pin,{'music':str(Path(music)/'erasures.jsonl')},sqlite_files=[str(Path(music)/'identity.sqlite3')])
`;
function python(s:Awaited<ReturnType<typeof setup>>,body:string,scenario='normal'){return execFileSync('python3',['-c',preamble+body,s.authority,s.pin,s.music,scenario],{timeout:30000,encoding:'utf8',stdio:['ignore','pipe','pipe']});}
const service=`os.environ['KANBAN_ORIGIN']='https://fixture.invalid'
os.environ['KANBAN_MUSIC_PROXY_KEY']='synthetic-proxy-key-'+('a'*32)
from music_site import service,maintenance
from tools.migration.rollback_erasure_runtime import install_legacy_erasure_authority
service.ORIGIN='https://fixture.invalid'
service.upstream.DATA_FILE=str(Path(music)/'data.json');service.upstream.BACKUP_DIR=str(Path(music)/'backups');service.STORE=service.Store(Path(music)/'identity.sqlite3')
service.upstream.data=json.loads(Path(service.upstream.DATA_FILE).read_text())
original_erase=service.administration.erase
uninstall=install_legacy_erasure_authority(client,music_service=service)
`;
const http=`import base64,http.client,threading
server=service.ThreadingHTTPServer(('127.0.0.1',0),service.Handler);thread=threading.Thread(target=server.serve_forever);thread.start()
def request(path,body=None,admin=True,key=True):
 headers={'X-Music-Identity':base64.urlsafe_b64encode(json.dumps({'admin_actor':'synthetic-admin'} if admin else {'user_id':'synthetic-member'}).encode()).decode()}
 if key:headers['X-Music-Proxy-Key']=os.environ['KANBAN_MUSIC_PROXY_KEY']
 if body is not None:headers.update({'Origin':service.ORIGIN,'Content-Type':'application/json'})
 conn=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=5)
 try:
  conn.request('POST' if body is not None else 'GET',path,body=json.dumps(body) if body is not None else None,headers=headers)
  response=conn.getresponse();return response.status,json.loads(response.read())
 finally:conn.close()
`;
const lowLevelReset=`from tools.migration.rollback_music_reset import capture_legacy_music_reset
source=Path(music,'data.json').read_bytes();loaded=json.loads(source)
operation=capture_legacy_music_reset(source,loaded,1001.25)
suffix=''.join(json.dumps({'qq':qq,'erased_at':1001.25})+'\\n' for qq in loaded['members']).encode()
client.record('music',suffix,operation=operation)
`;
it.each([false,true])('captures actual original HTTP reset scope with empty members=%s and preserves all native and bot data',async empty=>{
  const s=await setup(empty),output=python(s,service+`
service.replay(Path(music),service.STORE);service.upstream.load()
before=Path(music,'data.json').read_bytes();loaded=json.loads(json.dumps(service.upstream.data));settings=dict(service.upstream.data['settings'])
`+http+`
try:
 assert request('/api/admin/reset',{'confirm':'RESET'},admin=False)[0]==401
 assert request('/api/admin/reset',{'confirm':'RESET'},key=False)[0]==403
 assert request('/api/admin/reset',{'confirm':'WRONG'})[0]==400
 assert client.snapshot()[0]['sequence']==0
 assert request('/api/admin/reset',{'confirm':'RESET'})[0]==200
 records=client.music_reset_records();assert len(records)==1
 op=records[0]['operation'];assert op['source']=={'size':len(before),'sha256':hashlib.sha256(before).hexdigest()}
 def row_hash(value):return hashlib.sha256((json.dumps(value,ensure_ascii=False,separators=(',',':'))+'\\n').encode()).hexdigest()
 assert op['loadedSha256']==row_hash(loaded)
 for scope_name,value in [('scope',json.loads(before)),('loadedScope',loaded)]:
  for name in ('entries','members'):
   assert op[scope_name][name]==[{'key':key,'sha256':row_hash(row)} for key,row in value[name].items()]
  for name in ('shouts','shoutHistory','trend'):
   assert op[scope_name][name]==[{'index':i,'sha256':row_hash(row)} for i,row in enumerate(value[name])]
 assert service.upstream.data['settings']==settings
 assert all(not service.upstream.data[name] for name in ('entries','members','shouts','shoutHistory','trend'))
 for url in ('/api/export','/api/admin/backup'):
  status,value=request(url);assert status==503 and root not in json.dumps(value) and music not in json.dumps(value)
 assert request('/api/admin/create',{'text':'真正後續新增','kind':'sub'})[0]==200
 newer=dict(service.upstream.data['entries']);assert len(newer)==1
 service.replay(Path(music),service.STORE);service.upstream.load();assert service.upstream.data['entries']==newer
 assert request('/api/admin/reset',{'confirm':'RESET'})[0]==200
 assert len(client.music_reset_records())==2 and len(client.music_reset_records()[1]['operation']['scope']['entries'])==1
 print(json.dumps({'http':True,'memberCount':len(loaded['members']),'entryCount':len(loaded['entries']),'resetRecords':2,'originalSettingsPreserved':True,'postResetWritePreserved':True}))
finally:
 server.shutdown();server.server_close();thread.join();uninstall();assert service.administration.erase is original_erase;client.close()
`);
  expect(JSON.parse(output)).toMatchObject({http:true,resetRecords:2,originalSettingsPreserved:true,postResetWritePreserved:true});
  const saved=readRollbackErasureAuthority(s.authority,s.pin);expect(saved.head.sequence).toBe(2);expect(saved.records.map(row=>row.version)).toEqual([2,2]);expect(saved.records[0]!.domain).toBe('music');expect(saved.ledgers.music).toEqual(fs.readFileSync(join(s.music,'erasures.jsonl')));if(empty)expect(saved.ledgers.music).toEqual(Buffer.alloc(0));saved.assertUnchanged();expect(s.db.serialize()).toEqual(s.before);expect(s.db.prepare('SELECT * FROM bot_outbox ORDER BY id').all()).toEqual(s.bot);readRollbackPackage(s.packageRoot,s.packagePin).assertUnchanged();
},20000);
it('records every reset container and unknown fields without putting source content in the authority',async()=>{
  const s=await setup(true),value=JSON.parse(fs.readFileSync(join(s.music,'data.json'),'utf8'));value.entries['unknown-key']={extension:{nested:['synthetic-private-text',1]}};value.shouts.push({extension:'synthetic-private-text'});value.shoutHistory.push({extension:'synthetic-private-text'});value.trend.push(['synthetic-private-text',{count:3}]);fs.writeFileSync(join(s.music,'data.json'),JSON.stringify(value)+'\n');
  python(s,lowLevelReset+'client.close()');const saved=readRollbackErasureAuthority(s.authority,s.pin),record=saved.records[0]!;expect(record.version).toBe(2);if(record.version!==2)throw Error('Expected reset');expect(record.operation.scope).toMatchObject({entries:expect.arrayContaining([{key:'unknown-key',sha256:expect.stringMatching(/^[a-f0-9]{64}$/)}]),members:[],trend:[{index:0,sha256:expect.any(String)},{index:1,sha256:expect.any(String)}]});expect(encode(record).toString()).not.toContain('synthetic-private-text');saved.assertUnchanged();
});
it.each(['persisted-only','loaded-only'])('records distinct original source and memory scopes for %s data without inventing identity erasures',async shape=>{
  const s=await setup(),output=python(s,service+`
source=Path(music,'data.json');persisted=json.loads(source.read_bytes())
key='19999' if case=='persisted-only' else '18888'
target=persisted if case=='persisted-only' else service.upstream.data
target['entries']['different-generation']={'id':'different-generation','text':'合成範圍差異','createdBy':key}
target['members'][key]={'name':'合成範圍差異','selection':[]}
target['shouts'].append({'id':'extra','qq':key,'text':'合成範圍差異'})
target['shoutHistory'].append({'id':'extra-history','qq':key,'text':'合成範圍差異'})
target['trend'].append({'t':1234,'counts':{'different-generation':1}})
if case=='persisted-only':source.write_text(json.dumps(persisted))
db=service.STORE.connect()
try:db.execute('INSERT INTO profile_contacts VALUES(?,?,?)',(key,key,1000));db.commit()
finally:db.close()
loaded=json.loads(json.dumps(service.upstream.data));raw=source.read_bytes()
try:
 with service.upstream._lock:assert service.administration.erase(Path(music),service.STORE,{'confirm':'RESET'},reset=True)['ok']
 op=client.music_reset_records()[0]['operation']
 assert op['source']['sha256']==hashlib.sha256(raw).hexdigest()
 assert [row['key'] for row in op['scope']['members']]==list(persisted['members'])
 assert [row['key'] for row in op['loadedScope']['members']]==list(loaded['members'])
 for name in ('entries','members'):
  assert len(op['scope'][name])==len(persisted[name]) and len(op['loadedScope'][name])==len(loaded[name])
 for name in ('shouts','shoutHistory','trend'):
  assert len(op['scope'][name])==len(persisted[name]) and len(op['loadedScope'][name])==len(loaded[name])
 ledger=[json.loads(line)['qq'] for line in Path(music,'erasures.jsonl').read_text().splitlines()]
 assert ledger==list(loaded['members'])
 assert all(not json.loads(source.read_bytes())[name] for name in ('entries','members','shouts','shoutHistory','trend'))
 db=service.STORE.connect()
 try:assert bool(db.execute('SELECT 1 FROM profile_contacts WHERE qq=?',(key,)).fetchone())==(case=='persisted-only')
 finally:db.close()
 print(json.dumps({'distinctScopesPreserved':True,'originalIdentityScopePreserved':True}))
finally:uninstall();client.close()
`,shape);expect(JSON.parse(output)).toEqual({distinctScopesPreserved:true,originalIdentityScopePreserved:true});const saved=readRollbackErasureAuthority(s.authority,s.pin);saved.assertUnchanged();expect(s.db.serialize()).toEqual(s.before);
});
it.each([false,true])('blocks native startup and erasure-only forward projection with empty members=%s without changing either source',async empty=>{
  const s=await setup(empty);python(s,lowLevelReset+'client.close()');const beforeLedger=fs.readFileSync(erasureJournalPath(s.db.name)),head=fs.readFileSync(join(s.authority,'authority-head.json')),music=fs.readFileSync(join(s.music,'data.json'));
  const helper="import fcntl,sys\nfcntl.flock(3,fcntl.LOCK_EX|fcntl.LOCK_NB)\nprint('locked',flush=True)\nsys.stdin.read()";
  await expect(createRetainedErasureJournal(s.db,s.config,{acquireLock:path=>acquireInheritedAuthorityLock(path,'python3',['-c',helper])})).rejects.toThrow('Latest old-service erasures require forward projection');
  expect(()=>projectNativeForwardErasures({authorityRoot:s.authority,manifestSha256:s.pin,checkpoint:s.media.checkpointImage,nativeImage:s.media.checkpointImage,nativeImageSha256:digest(s.media.checkpointImage),nativeJournal:beforeLedger,nativeJournalSha256:digest(beforeLedger)})).toThrow('Structured old reset requires source generation');
  expect(fs.readFileSync(erasureJournalPath(s.db.name))).toEqual(beforeLedger);expect(fs.readFileSync(join(s.authority,'authority-head.json'))).toEqual(head);expect(fs.readFileSync(join(s.music,'data.json'))).toEqual(music);expect(s.db.serialize()).toEqual(s.before);
});
it.each(['record_fsynced','head_published','before_source','source_fsynced'])('retains an empty-member reset after actual Python exit at %s and blocks unsupported restart replay',async stage=>{
  const s=await setup(true);let status:number|null=null;
  try{python(s,service+`
client.fault_hook=lambda reached:os._exit(77) if reached==case else None
with service.upstream._lock:service.administration.erase(Path(music),service.STORE,{'confirm':'RESET'},reset=True)
`,stage);}catch(error){status=(error as {status:number|null}).status;}expect(status).toBe(77);
  const saved=readRollbackErasureAuthority(s.authority,s.pin,{includeUnpublished:true});expect(saved.head.sequence).toBe(1);expect(saved.pendingPublication).toBe(stage==='record_fsynced');expect(saved.ledgers.music).toEqual(Buffer.alloc(0));
  const current=fs.readFileSync(join(s.music,'data.json')),identity=fs.readFileSync(join(s.music,'identity.sqlite3')),output=python(s,service+`
try:
 for _ in range(2):
  client.snapshot();assert len(client.music_reset_records())==1
  try:service.replay(Path(music),service.STORE)
  except service.Rejected as error:assert error.status==503
  else:raise AssertionError('Reset restart replay was silently treated as profile erasure')
  try:
   with client.guard('music'):pass
  except ValueError:pass
  else:raise AssertionError('History export omitted reset')
 print(json.dumps({'records':client.snapshot()[0]['sequence'],'restartBlocked':True}))
finally:uninstall();client.close()
`);expect(JSON.parse(output)).toEqual({records:1,restartBlocked:true});expect(fs.readFileSync(join(s.music,'data.json'))).toEqual(current);expect(fs.readFileSync(join(s.music,'identity.sqlite3'))).toEqual(identity);expect(readRollbackErasureAuthority(s.authority,s.pin).head.sequence).toBe(1);expect(s.db.serialize()).toEqual(s.before);
},20000);
it('blocks authority-aware offline recovery after a reset and preserves business and identity bytes',async()=>{
  const s=await setup(true);python(s,lowLevelReset+'client.close()');const data=fs.readFileSync(join(s.music,'data.json')),identity=fs.readFileSync(join(s.music,'identity.sqlite3'));
  let status:number|null=null;try{execFileSync('python3',['-m','tools.migration.rollback_music_maintenance','recover','--folder',s.music,'--authority',s.authority,'--manifest-sha256',s.pin],{timeout:10000,stdio:['ignore','pipe','pipe']});}catch(error){status=(error as {status:number|null}).status;}expect(status).toBe(1);expect(fs.readFileSync(join(s.music,'data.json'))).toEqual(data);expect(fs.readFileSync(join(s.music,'identity.sqlite3'))).toEqual(identity);
});
it('preserves original invalid confirmation and requires the actual service lock before recording reset',async()=>{
  const s=await setup(),data=fs.readFileSync(join(s.music,'data.json')),output=python(s,service+`
try:
 for body,status in [({'confirm':'WRONG'},400),({'confirm':'RESET'},503)]:
  try:service.administration.erase(Path(music),service.STORE,body,reset=True)
  except service.Rejected as error:assert error.status==status
  else:raise AssertionError('Reset accepted without confirmation or lock')
 assert client.snapshot()[0]['sequence']==0
 print(json.dumps({'invalidConfirmationPreserved':True,'unlockedResetBlocked':True}))
finally:uninstall();client.close()
`);expect(JSON.parse(output)).toEqual({invalidConfirmationPreserved:true,unlockedResetBlocked:true});expect(fs.readFileSync(join(s.music,'data.json'))).toEqual(data);
});
it('rejects reset source aliasing live SQLite without opening a raw descriptor or releasing its lock',async()=>{
  const s=await setup(),output=python(s,service+`
import subprocess
source=Path(music,'data.json');raw=source.read_bytes();database=Path(music,'identity.sqlite3')
db=service.STORE.connect();db.execute('BEGIN EXCLUSIVE')
probe='import sqlite3,sys\\nd=sqlite3.connect(sys.argv[1],timeout=0)\\ntry:d.execute("BEGIN EXCLUSIVE")\\nexcept sqlite3.OperationalError:sys.exit(23)\\nelse:d.rollback();sys.exit(0)'
def blocked():return subprocess.run([sys.executable,'-c',probe,str(database)],capture_output=True,timeout=5).returncode==23
try:
 assert blocked()
 source.unlink();os.link(database,source)
 with service.upstream._lock:
  try:service.administration.erase(Path(music),service.STORE,{'confirm':'RESET'},reset=True)
  except service.Rejected as error:assert error.status==503
  else:raise AssertionError('Reset source aliased SQLite')
 assert blocked() and client.snapshot()[0]['sequence']==0
 print(json.dumps({'sqliteAliasBlocked':True,'liveLockPreserved':True}))
finally:
 source.unlink();source.write_bytes(raw);db.rollback();db.close();uninstall();client.close()
`);expect(JSON.parse(output)).toEqual({sqliteAliasBlocked:true,liveLockPreserved:true});expect(s.db.serialize()).toEqual(s.before);
});
it('rejects a source change after reset authority publication and keeps the recorded scope for recovery',async()=>{
  const s=await setup(true),output=python(s,service+`
source=Path(music,'data.json');before=source.read_bytes()
def fault(stage):
 if stage=='source_fsynced':source.write_bytes(before+b' ')
client.fault_hook=fault
try:
 with service.upstream._lock:
  try:service.administration.erase(Path(music),service.STORE,{'confirm':'RESET'},reset=True)
  except service.Rejected as error:assert error.status==503
  else:raise AssertionError('Changed reset source accepted')
 assert client.snapshot()[0]['sequence']==1
 assert client.music_reset_records()[0]['operation']['source']['sha256']==hashlib.sha256(before).hexdigest()
 assert json.loads(source.read_bytes())['entries']
 try:service.replay(Path(music),service.STORE)
 except service.Rejected as error:assert error.status==503
 else:raise AssertionError('Failed reset treated as complete')
 print(json.dumps({'sourceChangeBlocked':True,'resetScopeRetained':True}))
finally:uninstall();client.close()
`);expect(JSON.parse(output)).toEqual({sourceChangeBlocked:true,resetScopeRetained:true});expect(s.db.serialize()).toEqual(s.before);
});
type RawRecord={version:number;domain:string;operation:{kind:string;source:{size:number;sha256:string};loadedSha256:string;erasedAtJson:string;scope:{entries:{key:string;sha256:string}[];members:{key:string;sha256:string}[];shouts:{index:number;sha256:string}[];shoutHistory:{index:number;sha256:string}[];trend:{index:number;sha256:string}[]};loadedScope:{members:{key:string;sha256:string}[]}};suffixBase64:string;previousRecordSha256:string;sequence:number;ledgerSha256:string};
const mutations:{name:string;change:(record:RawRecord)=>void}[]=[
  {name:'unknown record version',change:row=>{row.version=3;}},
  {name:'wrong reset domain',change:row=>{row.domain='board';}},
  {name:'unsupported operation',change:row=>{row.operation.kind='invented';}},
  {name:'negative source size',change:row=>{row.operation.source.size=-1;}},
  {name:'invalid loaded digest',change:row=>{row.operation.loadedSha256='private';}},
  {name:'non-numeric reset time',change:row=>{row.operation.erasedAtJson='"old"';}},
  {name:'negative reset time',change:row=>{row.operation.erasedAtJson='-1';}},
  {name:'boolean reset time',change:row=>{row.operation.erasedAtJson='true';}},
  {name:'reset time differs from ledger',change:row=>{row.operation.erasedAtJson='1002';}},
  {name:'duplicate member key',change:row=>{row.operation.scope.members.push(row.operation.scope.members[0]!);}},
  {name:'invalid member key',change:row=>{row.operation.scope.members[0]!.key='account:alice';}},
  {name:'missing ledger member scope',change:row=>{row.operation.loadedScope.members=[];}},
  {name:'duplicate entry key',change:row=>{row.operation.scope.entries.push(row.operation.scope.entries[0]!);}},
  {name:'unpaired surrogate entry key',change:row=>{row.operation.scope.entries[0]!.key=String.fromCharCode(0xd800);}},
  {name:'entry digest invalid',change:row=>{row.operation.scope.entries[0]!.sha256='x';}},
  {name:'shout position gap',change:row=>{row.operation.scope.shouts[0]!.index=1;}},
  {name:'history position gap',change:row=>{row.operation.scope.shoutHistory[0]!.index=1;}},
  {name:'trend position gap',change:row=>{row.operation.scope.trend[0]!.index=1;}},
  {name:'noncanonical base64',change:row=>{row.suffixBase64+='\n';}},
  {name:'missing member suffix',change:row=>{row.suffixBase64='';}},
  {name:'wrong previous record',change:row=>{row.previousRecordSha256='0'.repeat(64);}},
  {name:'wrong sequence',change:row=>{row.sequence=2;}},
  {name:'wrong ledger digest',change:row=>{row.ledgerSha256='0'.repeat(64);}},
];
it.each(mutations)('both independent readers reject reset metadata with $name',async({change})=>{
  const s=await setup();python(s,lowLevelReset+'client.close()');const path=join(s.authority,'records','000000000001.json'),row=JSON.parse(fs.readFileSync(path,'utf8')) as RawRecord;change(row);const bytes=encode(row);fs.writeFileSync(path,bytes);const headPath=join(s.authority,'authority-head.json'),head=JSON.parse(fs.readFileSync(headPath,'utf8'));head.recordSha256=digest(bytes);fs.writeFileSync(headPath,encode(head));
  expect(()=>readRollbackErasureAuthority(s.authority,s.pin)).toThrow();let failure:unknown;try{python(s,'try:client.snapshot()\nfinally:client.close()');}catch(error){failure=error;}expect((failure as {status:number|null}).status).toBe(1);expect(s.db.serialize()).toEqual(s.before);
});
it('detects mutation of structured scope in a saved snapshot and retains canonical v1 semantics',async()=>{
  const s=await setup();python(s,lowLevelReset+'client.close()');const saved=readRollbackErasureAuthority(s.authority,s.pin),row=saved.records[0]!;if(row.version!==2)throw Error('Expected reset');row.operation.scope.entries=[];expect(()=>saved.assertUnchanged()).toThrow('Authority snapshot view changed');
  const original={version:1,authoritySha256:s.pin,sequence:1,previousRecordSha256:s.pin,domain:'music',suffixBase64:Buffer.from('{"qq":"10001","erased_at":1}\n').toString('base64'),ledgerSize:30,ledgerSha256:'0'.repeat(64)};expect(encode(ErasureAuthorityRecord.parse(original))).toEqual(encode(original));
});
it('keeps ordinary v1 empty suffixes invalid after adding v2 empty reset records',async()=>{
  const s=await setup(true);python(s,lowLevelReset+'client.close()');const path=join(s.authority,'records','000000000001.json'),row=JSON.parse(fs.readFileSync(path,'utf8'));row.version=1;delete row.operation;const bytes=encode(row);fs.writeFileSync(path,bytes);const headPath=join(s.authority,'authority-head.json'),head=JSON.parse(fs.readFileSync(headPath,'utf8'));head.recordSha256=digest(bytes);fs.writeFileSync(headPath,encode(head));
  expect(()=>readRollbackErasureAuthority(s.authority,s.pin)).toThrow('Invalid authority suffix');let failure:unknown;try{python(s,'try:client.snapshot()\nfinally:client.close()');}catch(error){failure=error;}expect((failure as {status:number|null}).status).toBe(1);
});
