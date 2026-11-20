import {afterEach,expect,it} from 'vitest';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {legacyResetFixture} from '../testsupport/legacy-reset-fixture';
import {verifyForwardLegacyResetSources,type LegacyResetSourceInput} from '../../../tools/migration/forward-legacy-reset-sources';
import {forwardHash} from '../../../tools/migration/forward-board-storage';
import {readRollbackErasureAuthority} from './erasure-authority-protocol';
const cleanup:(()=>void)[]=[];afterEach(()=>cleanup.splice(0).reverse().forEach(close=>close()));
const pinned=(bytes:Buffer)=>({bytes,sha256:forwardHash(bytes)});
async function setup(empty=false,count=1){
  const s=await legacyResetFixture();cleanup.push(()=>s.close());const folder=join(s.root,'original-reset-sources');mkdirSync(folder,{mode:0o700});
  execFileSync('python3',['-c',`import json,sys
from pathlib import Path
from tools.migration.rollback_erasure_authority import ErasureAuthority
from tools.migration.rollback_music_reset import capture_legacy_music_reset,_encode
root,pin,music,folder,empty,count=sys.argv[1:];folder=Path(folder);data=json.loads(Path(music,'data.json').read_bytes())
if empty=='yes':data['members']={}
a=ErasureAuthority(root,pin,{'music':str(Path(music,'erasures.jsonl'))})
try:
 for sequence in range(1,int(count)+1):
  persisted=json.loads(json.dumps(data));persisted['settings']['pythonNumbers']=[1.0,-0.0,1e-7];persisted['entries']['persisted-'+str(sequence)]={'opaque':{'generation':sequence,'unknown':[False,None,1.0]}}
  loaded=json.loads(json.dumps(persisted));loaded['entries']['loaded-'+str(sequence)]={'opaque':'原始不同記憶體世代'}
  if empty!='yes':loaded['members']['18888']={'opaque':'原始 loaded-only 範圍'}
  source=(json.dumps(persisted,ensure_ascii=False,indent=2)+'\\n').encode();memory=_encode(loaded);op=capture_legacy_music_reset(source,loaded,1001.25+sequence)
  (folder/(str(sequence)+'-persisted.json')).write_bytes(source);(folder/(str(sequence)+'-loaded.json')).write_bytes(memory)
  suffix=b''.join(_encode({'qq':key,'erased_at':1001.25+sequence}) for key in loaded['members']);a.record('music',suffix,operation=op)
finally:a.close()
`,s.authority,s.pin,s.music,folder,empty?'yes':'no',String(count)],{timeout:30000,stdio:'pipe'});
  const input:LegacyResetSourceInput={authorityRoot:s.authority,manifestSha256:s.pin,resets:Array.from({length:count},(_,index)=>({sequence:index+1,persisted:pinned(readFileSync(join(folder,String(index+1)+'-persisted.json'))),loaded:pinned(readFileSync(join(folder,String(index+1)+'-loaded.json')))}))};
  return {...s,input,folder};
}
it.each([false,true])('binds every original persisted and loaded container, Python numbers and unknown fields with empty members=%s',async empty=>{
  const s=await setup(empty,2),before=s.input.resets.map(row=>({persisted:Buffer.from(row.persisted.bytes),loaded:Buffer.from(row.loaded.bytes)})),head=readFileSync(join(s.authority,'authority-head.json')),result=verifyForwardLegacyResetSources(s.input);
  expect(result).toMatchObject({headSequence:2,allOriginalResetSourcesVerified:true,resetGenerationsReconciled:false,externalRetentionVerified:false,releaseEligible:false});
  for(const [index,row] of result.resets.entries()){
    expect(row).toMatchObject({sequence:index+1,persistedSha256:s.input.resets[index]!.persisted.sha256,loadedSha256:s.input.resets[index]!.loaded.sha256,bothOriginalSourcesVerified:true});expect(row.loadedContainers.entries).toBe(row.persistedContainers.entries+1);expect(row.loadedContainers.members-row.persistedContainers.members).toBe(empty?0:1);
    expect(s.input.resets[index]!.persisted.bytes).toEqual(before[index]!.persisted);expect(s.input.resets[index]!.loaded.bytes).toEqual(before[index]!.loaded);
  }
  expect(s.input.resets[0]!.loaded.bytes.toString()).toContain('[1.0,-0.0,1e-07]');expect(readFileSync(join(s.authority,'authority-head.json'))).toEqual(head);expect(s.db.serialize()).toEqual(s.before);expect(s.db.prepare('SELECT * FROM bot_outbox ORDER BY id').all()).toEqual(s.bot);
});
it('verifies both pre-operation snapshots from the actual original reset service and rejects its cleared post-reset file as a substitute',async()=>{
  const s=await legacyResetFixture();cleanup.push(()=>s.close());const folder=join(s.root,'actual-reset-originals');mkdirSync(folder,{mode:0o700});
  execFileSync('python3',['-c',`import os,json,sys
from pathlib import Path
os.environ['KANBAN_ORIGIN']='https://fixture.invalid';os.environ['KANBAN_MUSIC_PROXY_KEY']='synthetic-proxy-key-'+('a'*32)
from music_site import service
from tools.migration.rollback_erasure_authority import ErasureAuthority
from tools.migration.rollback_erasure_runtime import install_legacy_erasure_authority
from tools.migration.rollback_music_reset import _encode
root,pin,music,folder=sys.argv[1:];music=Path(music);folder=Path(folder)
service.ORIGIN='https://fixture.invalid';service.upstream.DATA_FILE=str(music/'data.json');service.upstream.BACKUP_DIR=str(music/'backups');service.STORE=service.Store(music/'identity.sqlite3')
service.upstream.data=json.loads(Path(service.upstream.DATA_FILE).read_bytes())
a=ErasureAuthority(root,pin,{'music':str(music/'erasures.jsonl')},sqlite_files=[str(music/'identity.sqlite3')]);undo=install_legacy_erasure_authority(a,music_service=service)
try:
 with service.upstream._lock:
  source=Path(service.upstream.DATA_FILE).read_bytes();loaded=_encode(service.upstream.data)
  (folder/'persisted.json').write_bytes(source);(folder/'loaded.json').write_bytes(loaded)
  assert service.administration.erase(music,service.STORE,{'confirm':'RESET'},reset=True)['ok']
 assert len(a.music_reset_records())==1
 assert all(not json.loads(Path(service.upstream.DATA_FILE).read_bytes())[name] for name in ('entries','members','shouts','shoutHistory','trend'))
finally:undo();a.close()
`,s.authority,s.pin,s.music,folder],{timeout:30000,stdio:'pipe'});
  const input:LegacyResetSourceInput={authorityRoot:s.authority,manifestSha256:s.pin,resets:[{sequence:1,persisted:pinned(readFileSync(join(folder,'persisted.json'))),loaded:pinned(readFileSync(join(folder,'loaded.json')))}]};
  expect(verifyForwardLegacyResetSources(input).allOriginalResetSourcesVerified).toBe(true);input.resets[0]!.persisted=pinned(readFileSync(join(s.music,'data.json')));expect(()=>verifyForwardLegacyResetSources(input)).toThrow('recorded generation');expect(s.db.serialize()).toEqual(s.before);expect(s.db.prepare('SELECT * FROM bot_outbox ORDER BY id').all()).toEqual(s.bot);
});
it.each(['missing generation','extra generation','wrong sequence','duplicate sequence','wrong source pin','persisted substitution','loaded substitution','swapped sources','loaded reencoding'])('rejects original reset source mismatch: %s',async change=>{
  const s=await setup(false,change==='duplicate sequence'?2:1),input=s.input;
  if(change==='missing generation')input.resets=[];if(change==='extra generation')input.resets.push({...input.resets[0]!,sequence:2});if(change==='wrong sequence')input.resets[0]!.sequence=2;if(change==='duplicate sequence')input.resets[1]!.sequence=1;
  if(change==='wrong source pin')input.resets[0]!.persisted.sha256='f'.repeat(64);
  if(change==='persisted substitution')input.resets[0]!.persisted=pinned(Buffer.from('{"entries":{},"members":{}}'));
  if(change==='loaded substitution')input.resets[0]!.loaded=pinned(Buffer.from('{"entries":{},"members":{}}\n'));
  if(change==='swapped sources'){const row=input.resets[0]!;[row.persisted,row.loaded]=[row.loaded,row.persisted];}
  if(change==='loaded reencoding')input.resets[0]!.loaded=pinned(Buffer.from(JSON.stringify(JSON.parse(input.resets[0]!.loaded.bytes.toString()))+'\n'));
  const head=readFileSync(join(s.authority,'authority-head.json'));expect(()=>verifyForwardLegacyResetSources(input)).toThrow();expect(readFileSync(join(s.authority,'authority-head.json'))).toEqual(head);expect(s.db.serialize()).toEqual(s.before);
});
it.each(['late bytes','late sequence','late inventory','late authority','async boundary'])('retains original sources when its synchronous boundary rejects %s',async change=>{
  const s=await setup(),head=readFileSync(join(s.authority,'authority-head.json'));let calls=0;
  const boundary=()=>{if(++calls!==2)return;if(change==='late bytes'){const bytes=s.input.resets[0]!.loaded.bytes;bytes[10]=bytes[10]!^1;}if(change==='late sequence')s.input.resets[0]!.sequence=9;if(change==='late inventory')s.input.resets=[];if(change==='late authority')writeFileSync(join(s.authority,'authority-head.json'),Buffer.concat([head,Buffer.from(' ')]));};
  expect(()=>verifyForwardLegacyResetSources(s.input,change==='async boundary'?(()=>Promise.resolve()) as unknown as ()=>void:boundary)).toThrow();expect(s.db.serialize()).toEqual(s.before);expect(s.db.prepare('SELECT * FROM bot_outbox ORDER BY id').all()).toEqual(s.bot);
});
it('checks original nested scope hashes and canonical loaded encoding with the Python producer after complete source pins match',async()=>{
  const s=await setup(),record=readRollbackErasureAuthority(s.authority,s.pin).records[0]!;if(record.version!==2)throw Error('Expected original reset');
  const result=execFileSync('python3',['-c',`import json,sys,hashlib,copy
from pathlib import Path
from tools.migration.rollback_music_reset import verify_legacy_music_reset_sources,_encode
folder=Path(sys.argv[1]);operation=json.loads(sys.argv[2]);source=(folder/'1-persisted.json').read_bytes();loaded=(folder/'1-loaded.json').read_bytes()
for kind in ('persisted scope','loaded scope','canonical encoding'):
 op=copy.deepcopy(operation);memory=loaded
 if kind=='persisted scope':op['scope']['entries'][0]['sha256']='f'*64
 elif kind=='loaded scope':op['loadedScope']['trend'][0]['sha256']='f'*64
 else:
  memory=json.dumps(json.loads(loaded),ensure_ascii=False,indent=2).encode();op['loadedSha256']=hashlib.sha256(memory).hexdigest()
 try:verify_legacy_music_reset_sources(op,source,memory)
 except ValueError:pass
 else:raise AssertionError(kind+' was accepted')
assert verify_legacy_music_reset_sources(operation,source,loaded)['bothOriginalSourcesVerified']
print(json.dumps({'nestedOriginalScopeVerified':True,'originalLoadedEncodingRequired':True}))
`,s.folder,JSON.stringify(record.operation)],{encoding:'utf8',timeout:10000});
  expect(JSON.parse(result)).toEqual({nestedOriginalScopeVerified:true,originalLoadedEncodingRequired:true});
});
