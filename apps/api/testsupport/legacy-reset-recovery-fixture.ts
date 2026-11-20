import Database from 'better-sqlite3';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {legacyResetGenerationFixture,type NumericResetMemberMode} from './legacy-reset-generation-fixture';
import {saveProfile} from '../src/repositories';
import {hash} from '../src/security';
import {forwardHash} from '../../../tools/migration/forward-board-storage';
import type {LegacyResetRecoveryInput} from '../../../tools/migration/forward-legacy-reset-recovery';
import type {ResetRetirementProofStage} from './reset-retirement-proof';

/** Real original reset/Store/save flow, followed by separate native additions.
 * All credentials, people, messages and images are isolated synthetic fixtures. */
export async function legacyResetRecoveryFixture(nativeFork=true,persistedOnlyProfile=false,numericMemberMode:NumericResetMemberMode|null=null,proofStage?:ResetRetirementProofStage){
  const s=await legacyResetGenerationFixture(true,'e','',false,persistedOnlyProfile,numericMemberMode,proofStage);let native:Database.Database|undefined;
  try{
    execFileSync('python3',['-c',`import os,json,sys
from pathlib import Path
os.umask(0o077);os.environ['KANBAN_ORIGIN']='https://fixture.invalid';os.environ['KANBAN_MUSIC_PROXY_KEY']='synthetic-'+('a'*40)
from music_site import service
folder=Path(sys.argv[1]);service.upstream.DATA_FILE=str(folder/'data.json');service.upstream.BACKUP_DIR=str(folder/'backups');service.STORE=service.Store(folder/'identity.sqlite3');service.upstream.data=json.loads((folder/'data.json').read_bytes())
service.upstream.data.pop('unclassified',None)
service.upstream.data.update(entries={'e':dict(id='e',text='later old catalog',kind='sub',category='歌手',aliases=['original alias'],createdBy='38888',createdAt=4.0)},members={'38888':dict(qq='38888',name='later old member',consent=True,created=['e'],selection=[dict(id='e',level=4)],boardUserId='',pinHash='SYNTHETIC-OLD-PIN',note='old source note')},shouts=[dict(id='reused-shout',qq='38888',name='old author',text='later old shout',createdAt=5.0)],shoutHistory=[dict(id='archive-shout',qq='38888',name='old archive',text='later old archive',createdAt=4.0,archivedAt=5.0)],trend=[dict(t=5.0,counts={'e':1})])
service.upstream.save()
`,s.music],{timeout:30000,stdio:'pipe'});
    const latest=readFileSync(join(s.music,'data.json')),identity=readFileSync(join(s.music,'identity.sqlite3')),pin=(bytes:Buffer)=>({bytes:Buffer.from(bytes),sha256:forwardHash(bytes)});
    native=new Database(s.input.nativeImage.bytes);native.pragma('foreign_keys = ON');let nativeProfile:string|undefined;
    if(nativeFork){
      native.prepare("INSERT INTO users VALUES('later-native-user',?,'later native member','synthetic')").run(hash('synthetic-native-secret'));
      native.prepare("INSERT INTO music_entries VALUES('native-added-entry','later native catalog','sub')").run();
      nativeProfile=saveProfile(native,'later-native-user',{profileId:null,revision:0,musicEpoch:0,selections:[{entryId:'native-added-entry',level:2}]},new Date('2026-11-20T20:00:00.000Z')).id;
      native.prepare("INSERT INTO music_shouts VALUES('native-added-shout',?,'','native author','native body',8,NULL,999)").run(nativeProfile);
      native.prepare("INSERT INTO music_documents VALUES('trend_sample',0,'{\"t\":8,\"counts\":{\"native-added-entry\":1}}')").run();
    }
    const image=native.serialize(),recoveryInput:LegacyResetRecoveryInput={erasures:{authorityRoot:s.authority,manifestSha256:s.pin,checkpoint:Buffer.from(s.input.checkpoint.bytes),nativeImage:image,nativeImageSha256:forwardHash(image),nativeJournal:Buffer.alloc(0),nativeJournalSha256:forwardHash(Buffer.alloc(0)),resetSourceVault:{vaultRoot:s.vault,vaultManifestSha256:s.input.vault.vaultManifestSha256}},latestMusic:pin(latest),latestIdentity:pin(identity),latestBoard:pin(s.state.boardImage),reconstructedAt:'2026-11-21T00:10:00.000Z',reconciledAt:'2026-11-21T00:11:00.000Z',rebasedAt:'2026-11-21T00:12:00.000Z'};
    return {...s,latest,originalOpaqueLatest:s.latest,native,nativeProfile,recoveryInput,close(){native!.close();s.close();}};
  }catch(error){native?.close();s.close();throw error;}
}
