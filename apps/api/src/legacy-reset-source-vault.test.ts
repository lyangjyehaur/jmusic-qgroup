import {afterEach,expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {readFileSync,readdirSync,writeFileSync,renameSync,symlinkSync,linkSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {legacyResetFixture} from '../testsupport/legacy-reset-fixture';
import {readForwardLegacyResetVault,type LegacyResetVaultInput} from '../../../tools/migration/forward-legacy-reset-vault';
import {readRollbackErasureAuthority} from './erasure-authority-protocol';
const cleanup:(()=>void)[]=[];afterEach(()=>cleanup.splice(0).reverse().forEach(close=>close()));
const preamble=`import os,json,sys
from pathlib import Path
os.umask(0o077)
os.environ['KANBAN_ORIGIN']='https://fixture.invalid';os.environ['KANBAN_MUSIC_PROXY_KEY']='synthetic-proxy-key-'+('a'*32)
from music_site import service
from tools.migration.rollback_erasure_authority import ErasureAuthority
from tools.migration.rollback_erasure_runtime import install_legacy_erasure_authority
from tools.migration.rollback_reset_source_vault import prepare_reset_source_vault,ResetSourceVault
root,pin,music,vault_root,declaration,case=sys.argv[1:];music=Path(music);vault_root=Path(vault_root)
service.ORIGIN='https://fixture.invalid';service.upstream.DATA_FILE=str(music/'data.json');service.upstream.BACKUP_DIR=str(music/'backups');service.STORE=service.Store(music/'identity.sqlite3');service.upstream.data=json.loads(Path(service.upstream.DATA_FILE).read_bytes())
a=ErasureAuthority(root,pin,{'music':str(music/'erasures.jsonl')},sqlite_files=[str(music/'identity.sqlite3')])
saved=prepare_reset_source_vault(vault_root,a,now='2026-11-20T10:00:00.000Z');Path(declaration).write_text(json.dumps(saved))
`;
async function setup(scenario='normal'){
  const s=await legacyResetFixture();cleanup.push(()=>s.close());const vault=join(s.root,'reset-source-vault'),declaration=join(s.root,'vault-declaration.json'),source=readFileSync(join(s.music,'data.json')),identity=readFileSync(join(s.music,'identity.sqlite3'));
  let status:number|null=0;
  try{execFileSync('python3',['-c',preamble+`
if case in ('prior incomplete','capture capacity','source metadata limit'):
 for i in range(1000 if case=='capture capacity' else 1):
  folder=vault_root/('capture-'+format(i,'032x'));folder.mkdir(mode=0o700);(folder/'persisted.json').write_bytes(b'{}')
  if case=='source metadata limit':
   (folder/'loaded.json').write_bytes(b'{}');(folder/'snapshot.json').write_bytes(b'{}')
   with (folder/'persisted.json').open('r+b') as file:file.truncate(64*1024*1024+1)
if case=='total capacity':
 import tools.migration.rollback_reset_source_vault as module
 module.TOTAL=1
def fault(stage,path):
 if case==stage:os._exit(77)
 if case=='vault write failure' and stage=='before_persisted':(path/'persisted.json').symlink_to(music/'identity.sqlite3')
 if case=='unsafe result permissions' and stage=='snapshot_fsynced':os.umask(0o022)
 if case=='completion write failure' and stage=='before_result':(path/'result.json').symlink_to(music/'identity.sqlite3')
 if case=='completion capacity' and stage=='snapshot_fsynced':
  import tools.migration.rollback_reset_source_vault as module
  module.TOTAL=(path/'persisted.json').stat().st_size+(path/'loaded.json').stat().st_size
 if case=='late result source' and stage=='before_result':(music/'data.json').write_bytes(b'{}')
vault=ResetSourceVault(vault_root,saved['manifestSha256'],a,fault_hook=fault)
if case in ('uncleared result','loaded result differs'):
 original_save=service.upstream.save
 def changed_save():
  original_save()
  if case=='uncleared result':
   value=json.loads((music/'data.json').read_bytes());value['entries']={'unexpected':{'text':'synthetic'}};(music/'data.json').write_text(json.dumps(value))
  else:service.upstream.data['settings']['syntheticAfterSave']=True
 service.upstream.save=changed_save
if case in ('record_fsynced','head_published','before_source','source_fsynced'):a.fault_hook=lambda stage:os._exit(77) if stage==case else None
undo=install_legacy_erasure_authority(a,music_service=service,reset_source_vault=vault)
try:
 if case=='normal':
  service.upstream.data['members']['18888']={'name':'記憶體獨有會員','selection':[],'opaque':[1.0,-0.0,1e-7]}
 with service.upstream._lock:
  try:assert service.administration.erase(music,service.STORE,{'confirm':'RESET'},reset=True)['ok']
  except service.Rejected:
   if case not in ('vault write failure','prior incomplete','capture capacity','source metadata limit','total capacity','unsafe result permissions','completion write failure','completion capacity','late result source','uncleared result','loaded result differs'):raise
   assert a.snapshot()[0]['sequence']==(1 if case in ('unsafe result permissions','completion write failure','completion capacity','late result source','uncleared result','loaded result differs') else 0)
 if case=='normal':
  service.upstream.data['entries']['after-first-reset']={'id':'after-first-reset','text':'重置後新詞條','kind':'sub'};service.upstream.save()
  with service.upstream._lock:assert service.administration.erase(music,service.STORE,{'confirm':'RESET'},reset=True)['ok']
finally:undo();a.close()
`,s.authority,s.pin,s.music,vault,declaration,scenario],{timeout:30000,stdio:'pipe'});}catch(error){status=(error as {status:number|null}).status;if(status!==77)throw error;}
  const saved=JSON.parse(readFileSync(declaration,'utf8')) as {manifestSha256:string};const input:LegacyResetVaultInput={authorityRoot:s.authority,manifestSha256:s.pin,vaultRoot:vault,vaultManifestSha256:saved.manifestSha256};
  return {...s,vault,input,status,source,identity};
}
it('durably captures both original generations before actual resets, reloads all bytes into the TS verifier and preserves native/bot data',async()=>{
  const s=await setup(),head=readFileSync(join(s.authority,'authority-head.json')),result=readForwardLegacyResetVault(s.input);
  expect(result.verification).toMatchObject({allOriginalResetSourcesVerified:true,headSequence:2,resetGenerationsReconciled:false,releaseEligible:false});expect(result.sources.resets).toHaveLength(2);expect(result.sources.resets[0]!.persisted.bytes).toEqual(s.source);
  const first=JSON.parse(result.sources.resets[0]!.loaded.bytes.toString()) as {members:Record<string,unknown>};expect(first.members).toHaveProperty('18888');expect(result.sources.resets[0]!.loaded.bytes.toString()).toContain('[1.0,-0.0,1e-07]');
  const second=JSON.parse(result.sources.resets[1]!.persisted.bytes.toString()) as {members:Record<string,unknown>;entries:Record<string,unknown>};expect(second.entries).toHaveProperty('after-first-reset');expect(second.members).toEqual({});expect(result.vaultEvidence).toMatchObject({allRecordedResetSourcesPresent:true,unboundOrDuplicateCapturesRetained:0,externalRetentionVerified:false,releaseEligible:false});expect(result.vaultEvidence.captures).toHaveLength(2);
  expect(result.vaultEvidence.allRecordedResetCompletionsPresent).toBe(true);expect(result.completionSources).toHaveLength(2);
  for(const completed of result.completionSources)expect(JSON.parse(completed.bytes.toString())).toMatchObject({entries:{},members:{},shouts:[],shoutHistory:[],trend:[]});
  expect(readFileSync(join(s.authority,'authority-head.json'))).toEqual(head);expect(s.db.serialize()).toEqual(s.before);expect(s.db.prepare('SELECT * FROM bot_outbox ORDER BY id').all()).toEqual(s.bot);
});
it.each(['result_fsynced','completion_fsynced'])('retains the completed real reset and distinguishes completion durability after an actual exit at %s',async stage=>{
  const s=await setup(stage);expect(s.status).toBe(77);expect(readRollbackErasureAuthority(s.authority,s.pin).head.sequence).toBe(1);expect(JSON.parse(readFileSync(join(s.music,'data.json'),'utf8'))).toMatchObject({entries:{},members:{},shouts:[],shoutHistory:[],trend:[]});expect(s.db.serialize()).toEqual(s.before);expect(s.db.prepare('SELECT * FROM bot_outbox ORDER BY id').all()).toEqual(s.bot);
  const folder=join(s.vault,readdirSync(s.vault).find(name=>name.startsWith('capture-'))!);expect(readFileSync(join(folder,'persisted.json'))).toEqual(s.source);
  if(stage==='result_fsynced')expect(()=>readForwardLegacyResetVault(s.input)).toThrow('vault verification failed');
  else{const result=readForwardLegacyResetVault(s.input);expect(result.vaultEvidence.allRecordedResetCompletionsPresent).toBe(true);expect(result.completionSources).toHaveLength(1);expect(result.completionSources[0]!.bytes).toEqual(readFileSync(join(s.music,'data.json')));}
});
it.each(['unsafe result permissions','completion write failure','completion capacity','late result source','uncleared result','loaded result differs'])('retains original sources and the recorded reset when completion rejects %s',async cause=>{
  const s=await setup(cause);expect(s.status).toBe(0);expect(readRollbackErasureAuthority(s.authority,s.pin).head.sequence).toBe(1);const folder=join(s.vault,readdirSync(s.vault).find(name=>name.startsWith('capture-'))!);expect(readFileSync(join(folder,'persisted.json'))).toEqual(s.source);expect(s.db.serialize()).toEqual(s.before);expect(s.db.prepare('SELECT * FROM bot_outbox ORDER BY id').all()).toEqual(s.bot);
  if(cause==='completion write failure')expect(()=>readForwardLegacyResetVault(s.input)).toThrow();
  else{const result=readForwardLegacyResetVault(s.input);expect(result.vaultEvidence.allRecordedResetCompletionsPresent).toBe(cause==='late result source');expect(result.completionSources).toHaveLength(cause==='late result source'?1:0);expect(result.verification.resetGenerationsReconciled).toBe(false);}
});
it.each(['result bytes','record binding','snapshot binding','missing result','result symlink','self-consistent uncleared result'])('rejects retained completion corruption: %s',async change=>{
  const s=await setup(),folder=join(s.vault,readdirSync(s.vault).find(name=>name.startsWith('capture-'))!);
  execFileSync('python3',['-c',`import hashlib,sys
from pathlib import Path
from tools.migration.rollback_music_reset import _json,_encode
folder=Path(sys.argv[1]);case=sys.argv[2];path=folder/'completion.json';value=_json(path.read_bytes())
if case=='result bytes':(folder/'result.json').write_bytes(b'{}')
elif case=='record binding':value['authorityRecordSha256']='f'*64;path.write_bytes(_encode(value))
elif case=='snapshot binding':value['snapshotSha256']='f'*64;path.write_bytes(_encode(value))
elif case=='missing result':(folder/'result.json').rename(folder.parent.parent/'retained-result.json')
elif case=='result symlink':
 retained=folder.parent.parent/'retained-result.json';(folder/'result.json').rename(retained);(folder/'result.json').symlink_to(retained)
else:
 raw=_encode(dict(entries={'revived':{}},members={},shouts=[],shoutHistory=[],trend=[]));(folder/'result.json').write_bytes(raw);value['result']=dict(size=len(raw),sha256=hashlib.sha256(raw).hexdigest());path.write_bytes(_encode(value))
`,folder,change],{timeout:10000,stdio:'pipe'});
  expect(()=>readForwardLegacyResetVault(s.input)).toThrow();expect(s.db.serialize()).toEqual(s.before);expect(s.db.prepare('SELECT * FROM bot_outbox ORDER BY id').all()).toEqual(s.bot);
});
it.each(['persisted_fsynced','loaded_fsynced','snapshot_fsynced','record_fsynced','head_published','before_source','source_fsynced'])('retains the real source and vault at an actual Python exit after %s',async stage=>{
  const s=await setup(stage);expect(s.status).toBe(77);expect(readFileSync(join(s.music,'data.json'))).toEqual(s.source);expect(readFileSync(join(s.music,'identity.sqlite3'))).toEqual(s.identity);expect(s.db.serialize()).toEqual(s.before);expect(s.db.prepare('SELECT * FROM bot_outbox ORDER BY id').all()).toEqual(s.bot);
  const captures=readdirSync(s.vault).filter(name=>name.startsWith('capture-'));expect(captures).toHaveLength(1);expect(readFileSync(join(s.vault,captures[0]!,'persisted.json'))).toEqual(s.source);
  if(stage==='persisted_fsynced'||stage==='loaded_fsynced'){expect(()=>readForwardLegacyResetVault(s.input)).toThrow('vault verification failed');expect(readRollbackErasureAuthority(s.authority,s.pin).head.sequence).toBe(0);}
  else if(stage==='snapshot_fsynced'){const result=readForwardLegacyResetVault(s.input);expect(result.sources.resets).toEqual([]);expect(result.vaultEvidence.unboundOrDuplicateCapturesRetained).toBe(1);expect(readRollbackErasureAuthority(s.authority,s.pin).head.sequence).toBe(0);}
  else{
   execFileSync('python3',['-c',"from tools.migration.rollback_erasure_authority import ErasureAuthority\nimport sys\na=ErasureAuthority(sys.argv[1],sys.argv[2]);a.snapshot();a.close()",s.authority,s.pin],{timeout:10000,stdio:'pipe'});
   const result=readForwardLegacyResetVault(s.input);expect(result.sources.resets).toHaveLength(1);expect(result.sources.resets[0]!.persisted.bytes).toEqual(s.source);expect(result.verification.allOriginalResetSourcesVerified).toBe(true);
  }
});
it('refuses reset before any authority or business write when an existing vault target prevents exclusive creation',async()=>{
  const s=await setup('vault write failure');expect(s.status).toBe(0);expect(readRollbackErasureAuthority(s.authority,s.pin).head.sequence).toBe(0);expect(readFileSync(join(s.music,'data.json'))).toEqual(s.source);expect(readFileSync(join(s.music,'identity.sqlite3'))).toEqual(s.identity);expect(s.db.serialize()).toEqual(s.before);
});
it.each(['prior incomplete','capture capacity','source metadata limit','total capacity'])('blocks the actual reset before recording when the retained vault has %s',async cause=>{
  const s=await setup(cause);expect(s.status).toBe(0);expect(readRollbackErasureAuthority(s.authority,s.pin).head.sequence).toBe(0);expect(readFileSync(join(s.music,'data.json'))).toEqual(s.source);expect(readFileSync(join(s.music,'identity.sqlite3'))).toEqual(s.identity);expect(s.db.serialize()).toEqual(s.before);expect(s.db.prepare('SELECT * FROM bot_outbox ORDER BY id').all()).toEqual(s.bot);
  const count=readdirSync(s.vault).filter(name=>name.startsWith('capture-')).length;expect(count).toBe(cause==='capture capacity'?1000:cause==='total capacity'?0:1);
});
it('requires isolated roots, exclusive initialization, a pinned declaration and the same authority instance for installation',async()=>{
  const s=await legacyResetFixture();cleanup.push(()=>s.close());const vault=join(s.root,'binding-vault'),declaration=join(s.root,'binding-declaration.json');
  const output=execFileSync('python3',['-c',preamble+`
def rejects(action):
 try:action()
 except (ValueError,FileExistsError):return
 raise AssertionError('Invalid vault binding accepted')
for forbidden in [music,music/'nested-vault',Path(root)/'nested-vault',music.parent]:
 rejects(lambda:prepare_reset_source_vault(forbidden,a,now='2026-11-20T10:00:00.000Z'))
rejects(lambda:prepare_reset_source_vault(vault_root,a,now='2026-11-20T10:00:00.000Z'))
rejects(lambda:ResetSourceVault(vault_root,'f'*64,a))
other=ErasureAuthority(root,pin,{'music':str(music/'erasures.jsonl')},sqlite_files=[str(music/'identity.sqlite3')])
vault=ResetSourceVault(vault_root,saved['manifestSha256'],other)
rejects(lambda:install_legacy_erasure_authority(a,music_service=service,reset_source_vault=vault))
rejects(lambda:prepare_reset_source_vault(vault_root.parent/'declared-restore-vault',a,restore_roots=[vault_root.parent],now='2026-11-20T10:00:00.000Z'))
assert sorted(path.name for path in vault_root.iterdir())==['vault-manifest.json'];assert a.snapshot()[0]['sequence']==0
other.close();a.close();print(json.dumps({'invalidBindingsRejected':True}))
`,s.authority,s.pin,s.music,vault,declaration,'bindings'],{encoding:'utf8',timeout:30000,stdio:'pipe'});
  expect(JSON.parse(output)).toEqual({invalidBindingsRejected:true});expect(s.db.serialize()).toEqual(s.before);
});
it('retains the committed reset intent and original business data when a completed capture changes at the record boundary',async()=>{
  const s=await legacyResetFixture();cleanup.push(()=>s.close());const vault=join(s.root,'late-vault'),declaration=join(s.root,'late-declaration.json'),source=readFileSync(join(s.music,'data.json')),identity=readFileSync(join(s.music,'identity.sqlite3'));
  const output=execFileSync('python3',['-c',preamble+`
vault=ResetSourceVault(vault_root,saved['manifestSha256'],a)
def tamper(stage):
 if stage=='record_fsynced':
  folder=next(path for path in vault_root.iterdir() if path.name.startswith('capture-'));(folder/'loaded.json').write_bytes(b'{}')
a.fault_hook=tamper;undo=install_legacy_erasure_authority(a,music_service=service,reset_source_vault=vault)
try:
 with service.upstream._lock:
  try:service.administration.erase(music,service.STORE,{'confirm':'RESET'},reset=True)
  except service.Rejected:pass
  else:raise AssertionError('Changed completed capture accepted')
 a.fault_hook=None;assert a.snapshot()[0]['sequence']==1
 with service.upstream._lock:
  try:service.administration.erase(music,service.STORE,{'confirm':'RESET'},reset=True)
  except service.Rejected:pass
  else:raise AssertionError('Unreconciled reset retried')
 assert a.snapshot()[0]['sequence']==1
finally:undo();a.close()
print(json.dumps({'committedIntentRetained':True}))
`,s.authority,s.pin,s.music,vault,declaration,'late'],{encoding:'utf8',timeout:30000,stdio:'pipe'});
  expect(JSON.parse(output)).toEqual({committedIntentRetained:true});expect(readFileSync(join(s.music,'data.json'))).toEqual(source);expect(readFileSync(join(s.music,'identity.sqlite3'))).toEqual(identity);expect(s.db.serialize()).toEqual(s.before);expect(s.db.prepare('SELECT * FROM bot_outbox ORDER BY id').all()).toEqual(s.bot);
});
it.each(['source bytes','loaded bytes','snapshot binding','vault pin','missing generation','extra file','symlink','hardlink','directory replacement'])('rejects private capture corruption: %s',async change=>{
  const s=await setup(),folder=join(s.vault,readdirSync(s.vault).find(name=>name.startsWith('capture-'))!);
  if(change==='source bytes')writeFileSync(join(folder,'persisted.json'),'{}\n');if(change==='loaded bytes')writeFileSync(join(folder,'loaded.json'),'{}\n');
  if(change==='snapshot binding'){const path=join(folder,'snapshot.json'),value=JSON.parse(readFileSync(path,'utf8')) as {previousRecordSha256:string};value.previousRecordSha256='f'.repeat(64);writeFileSync(path,JSON.stringify(value)+'\n');}
  if(change==='vault pin')s.input.vaultManifestSha256='f'.repeat(64);
  if(change==='missing generation')renameSync(folder,join(s.root,'retained-missing-capture'));
  if(change==='extra file')writeFileSync(join(folder,'unexpected.txt'),'synthetic');
  if(change==='symlink'){renameSync(join(folder,'persisted.json'),join(s.root,'retained-source.json'));symlinkSync(join(s.root,'retained-source.json'),join(folder,'persisted.json'));}
  if(change==='hardlink')linkSync(join(folder,'persisted.json'),join(s.root,'source-alias.json'));
  if(change==='directory replacement'){renameSync(folder,join(s.root,'retained-folder'));mkdirSync(folder,{mode:0o700});}
  const head=readFileSync(join(s.authority,'authority-head.json'));expect(()=>readForwardLegacyResetVault(s.input)).toThrow();expect(readFileSync(join(s.authority,'authority-head.json'))).toEqual(head);expect(s.db.serialize()).toEqual(s.before);
});
it.each(['late capture','late identity','async boundary'])('retains original native data when its boundary rejects %s',async change=>{
  const s=await setup();let calls=0;const boundary=()=>{if(++calls!==2)return;if(change==='late identity')s.input.vaultManifestSha256='f'.repeat(64);else writeFileSync(join(s.vault,'unexpected.txt'),'synthetic');};
  expect(()=>readForwardLegacyResetVault(s.input,change==='async boundary'?(()=>Promise.resolve()) as unknown as ()=>void:boundary)).toThrow();expect(s.db.serialize()).toEqual(s.before);
});
it('keeps the parent SQLite writer lock when the declaration is replaced by its live inode before the isolated reader opens it',async()=>{
  const s=await legacyResetFixture();cleanup.push(()=>s.close());const vault=join(s.root,'lock-vault'),declaration=join(s.root,'lock-declaration.json');
  const output=execFileSync('python3',['-c',preamble+`
import sqlite3,subprocess
database=music/'small-lock.sqlite3';owner=sqlite3.connect(database);owner.execute('PRAGMA journal_mode=DELETE');owner.execute('CREATE TABLE synthetic(value TEXT)');owner.commit();assert database.stat().st_size<=16*1024;a.register_sqlite_files([database]);owner.execute('BEGIN IMMEDIATE')
def rival():
 code="import sqlite3,sys\\ndb=sqlite3.connect(sys.argv[1],timeout=0)\\ntry:db.execute('BEGIN IMMEDIATE')\\nexcept sqlite3.OperationalError as e:assert 'locked' in str(e);print('locked')\\nelse:raise AssertionError('Parent lock lost')\\nfinally:db.close()"
 assert subprocess.check_output([sys.executable,'-c',code,str(database)]).strip()==b'locked'
rival();header=vault_root/'vault-manifest.json';held=vault_root/'held-header.json'
os.rename(header,held);os.rename(database,header)
try:
 try:ResetSourceVault(vault_root,saved['manifestSha256'],a)
 except ValueError as error:assert str(error)=='Reset vault manifest pin differs'
 else:raise AssertionError('SQLite declaration alias accepted')
finally:os.rename(header,database);os.rename(held,header)
rival();owner.rollback();owner.close();a.close();print(json.dumps({'externalParentLockPreserved':True}))
`,s.authority,s.pin,s.music,vault,declaration,'lock'],{encoding:'utf8',timeout:30000,stdio:'pipe'});
  expect(JSON.parse(output)).toEqual({externalParentLockPreserved:true});expect(s.db.serialize()).toEqual(s.before);
});
