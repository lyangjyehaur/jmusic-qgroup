import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {legacyResetFixture} from './legacy-reset-fixture';
import {forwardHash} from '../../../tools/migration/forward-board-storage';
import type {LegacyResetGenerationInput} from '../../../tools/migration/forward-legacy-reset-generations';

/** Two real original resets and a later old-source generation. No native writes,
 * real credentials, workers, HTTP traffic or bot deliveries are involved. */
export async function legacyResetGenerationFixture(completed=true,middleKey='e',firstLoadedEntryKey='',prunePersistedFirst=false){
  const s=await legacyResetFixture(),vault=join(s.root,'generation-vault');
  try{
    const output=execFileSync('python3',['-c',`import json,os,sys
from pathlib import Path
os.umask(0o077);os.environ['KANBAN_ORIGIN']='https://fixture.invalid';os.environ['KANBAN_MUSIC_PROXY_KEY']='synthetic-'+('a'*40)
from music_site import service
from tools.migration.rollback_erasure_authority import ErasureAuthority
from tools.migration.rollback_erasure_runtime import install_legacy_erasure_authority
from tools.migration.rollback_reset_source_vault import prepare_reset_source_vault,ResetSourceVault
root,pin,folder,vault_root,completed,middle_key,loaded_key,prune_persisted=sys.argv[1:];folder=Path(folder)
service.ORIGIN='https://fixture.invalid';service.upstream.DATA_FILE=str(folder/'data.json');service.upstream.BACKUP_DIR=str(folder/'backups');service.STORE=service.Store(folder/'identity.sqlite3');service.upstream.data=json.loads((folder/'data.json').read_bytes())
a=ErasureAuthority(root,pin,{'music':folder/'erasures.jsonl'},sqlite_files=[folder/'identity.sqlite3']);saved=prepare_reset_source_vault(Path(vault_root),a,now='2026-11-20T12:00:00.000Z');vault=ResetSourceVault(vault_root,saved['manifestSha256'],a)
if loaded_key:service.upstream.data['entries']={loaded_key:dict(id=loaded_key,text='loaded only',kind='sub')}
if prune_persisted=='true':
 from tools.migration.rollback_music_reset import _encode
 persisted=json.loads((folder/'data.json').read_bytes());persisted.update(entries={},shouts=[],shoutHistory=[],trend=[]);(folder/'data.json').write_bytes(_encode(persisted))
undo=install_legacy_erasure_authority(a,music_service=service,reset_source_vault=vault)
try:
 with service.upstream._lock:assert service.administration.erase(folder,service.STORE,{'confirm':'RESET'},reset=True)['ok']
 service.upstream.data['entries']={middle_key:dict(id=middle_key,text='middle generation',kind='sub')};service.upstream.data['shouts']=[dict(id='reused-shout',qq='',text='middle shout',createdAt=1.0)];service.upstream.save()
 if completed=='false':
  original=vault.capture
  def partial(*args):
   result=original(*args);result['complete']=lambda *args:(_ for _ in ()).throw(ValueError('Synthetic incomplete endpoint'));return result
  vault.capture=partial
 with service.upstream._lock:
  try:assert service.administration.erase(folder,service.STORE,{'confirm':'RESET'},reset=True)['ok']
  except service.Rejected:
   if completed!='false':raise
 service.upstream.data.update(entries={
  'e':dict(id='e',text='new generation e',kind='main',aliases=['e'],opaque=[1.0,-0.0,1e-7]),
  '1':dict(id='1',text='numeric key',kind='sub'),
  'true':dict(id='true',text='boolean reference',kind='sub'),
  '[object Object]':dict(id='[object Object]',text='object reference',kind='sub'),
  '聲:[]/詞':dict(id='聲:[]/詞',text='unicode key',kind='sub')},
  members={'38888':dict(qq='38888',name='new member',consent=True,boardUserId='',created=['e','聲:[]/詞','1','e'],selection=['e',dict(id='e',entryId='ignored',level=1.0),dict(id='',entryId='e',level=-0.0),dict(id=1,level='2'),dict(id=True,level=True),dict(id=['e'],level=2.9),dict(id={},level=False),dict(id=[],entryId='ignored',level=1),''])},
  shouts=[dict(id='reused-shout',qq='38888',text='new shout',createdAt=2.0)],
  shoutHistory=[dict(id='archive-shout',qq='38888',text='new archived shout',createdAt=2.0,archivedAt=3.0)],
  trend=[dict(t=1.0,counts={'e':1.0,'historic-gone':-0.0,'1':1e-7},opaque='e')],
  unclassified=dict(literal='e',negative=-0.0,integerFloat=1.0))
 service.upstream.save();print(json.dumps(dict(pin=saved['manifestSha256'])))
finally:undo();a.close()
`,s.authority,s.pin,s.music,vault,String(completed),middleKey,firstLoadedEntryKey,String(prunePersistedFirst)],{encoding:'utf8',timeout:30000,stdio:'pipe'});
    const pin=(JSON.parse(output) as {pin:string}).pin,latest=readFileSync(join(s.music,'data.json'));
    // No native business changes occur after the verified checkpoint. Reuse its
    // complete standalone image; the live DB serialize header may declare WAL.
    const input:LegacyResetGenerationInput={vault:{authorityRoot:s.authority,manifestSha256:s.pin,vaultRoot:vault,vaultManifestSha256:pin},checkpoint:{bytes:Buffer.from(s.state.checkpointImage),sha256:forwardHash(s.state.checkpointImage)},latestMusic:{bytes:Buffer.from(latest),sha256:forwardHash(latest)},nativeImage:{bytes:Buffer.from(s.state.checkpointImage),sha256:forwardHash(s.state.checkpointImage)}};
    return {...s,vault,latest,input};
  }catch(error){s.close();throw error;}
}
