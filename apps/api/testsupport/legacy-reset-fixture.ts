import {mkdirSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {legacyHistoryFixture} from './legacy-history-fixture';
import {erasureJournal,erasureJournalPath} from '../src/erasure-journal';
import {captureRollbackMedia} from '../../../tools/migration/rollback-media';
import {projectRollbackStateFromCheckpoint} from '../../../tools/migration/rollback-state';
import {projectRollbackHistory} from '../../../tools/migration/rollback-history';
import {assembleRollbackPackage,pinRollbackPackageSource} from '../../../tools/migration/rollback-package-codec';
import {writeRollbackPackage} from '../../../tools/migration/rollback-package';
import {writeRollbackErasureAuthority} from '../../../tools/migration/rollback-erasure-authority';
import {digest} from '../../../packages/runtime/src/strict-json';

export async function legacyResetFixture(){
  const s=await legacyHistoryFixture();
  try{
    for(const [i,status] of ['pending','sending','sent','failed','skipped'].entries())s.db.prepare("INSERT INTO bot_outbox(event_id,kind,dedupe_key,target,payload_json,status,claim_token,retry_at,simulated_at,delivered_payload_json,created_at) VALUES('listen','reset',?,'synthetic','{}',?,?,?,?,?,'historical')").run('reset-'+i,status,status==='sending'?'uncertain-fixture':'',status==='failed'?'retry-fixture':null,status==='skipped'?'simulation-fixture':null,status==='sent'?'sent-fixture':null);
    const data=dirname(s.db.name),journal=erasureJournal(s.db);
    writeFileSync(erasureJournalPath(s.db.name),'',{mode:0o600});
    const media=captureRollbackMedia(s.db,journal),state=projectRollbackStateFromCheckpoint(media.checkpointImage,media.journal),history=projectRollbackHistory(state,{capture:s.config,native:{root:join(data,'paired-backups'),manifests:[]}}),pkg=assembleRollbackPackage(state,media,history,pinRollbackPackageSource(media,{captureManifestSha256:s.config.manifestSha256,native:[]})),packageRoot=join(s.root,'package'),stamp=new Date('2026-11-20T00:00:00Z'),packagePin=writeRollbackPackage(pkg,packageRoot,[s.capture,data],stamp).manifestSha256,authority=join(s.root,'authority'),music=join(s.root,'old-music');
    mkdirSync(music,{mode:0o700});writeFileSync(join(music,'data.json'),JSON.stringify(state.music.data)+'\n',{mode:0o600});writeFileSync(join(music,'identity.sqlite3'),state.identityImage,{mode:0o600});writeFileSync(join(music,'erasures.jsonl'),state.erasures.musicJournal,{mode:0o600});
    const pin=writeRollbackErasureAuthority(packageRoot,packagePin,authority,stamp,undefined,{database:s.db.name,sha256:digest(Buffer.alloc(0))}).manifestSha256;
    return {...s,media,state,packageRoot,packagePin,authority,music,pin,config:{root:authority,manifestSha256:pin,sourceCheckpoint:join(packageRoot,'private/latest/unified.sqlite3')},before:s.db.serialize(),bot:s.db.prepare('SELECT * FROM bot_outbox ORDER BY id').all()};
  }catch(error){s.close();throw error;}
}
