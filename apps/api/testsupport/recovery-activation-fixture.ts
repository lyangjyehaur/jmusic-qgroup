import * as fs from 'node:fs';
import {dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {legacyHistoryFixture} from './legacy-history-fixture';
import {hash} from '../src/security';
import {createPrivacy} from '../src/privacy';
import {erasureJournal,erasureJournalPath} from '../src/erasure-journal';
import {recoveryDeliveryReview,type RecoveryReview} from '../src/recovery-activation-protocol';
import {encode,readRollbackErasureAuthority} from '../src/erasure-authority-protocol';
import {captureRollbackMedia} from '../../../tools/migration/rollback-media';
import {projectRollbackStateFromCheckpoint} from '../../../tools/migration/rollback-state';
import {projectRollbackHistory} from '../../../tools/migration/rollback-history';
import {captureRollbackBotState} from '../../../tools/migration/rollback-bot-state';
import {assembleRollbackPackageV2,pinRollbackPackageSourceV2} from '../../../tools/migration/rollback-package-codec';
import {writeRollbackPackage,readRollbackPackage} from '../../../tools/migration/rollback-package';
import {writeRollbackErasureAuthority} from '../../../tools/migration/rollback-erasure-authority';
import {digest,profileId} from '../../../tools/migration/music-codec';
import type {RecoveryActivationInputValue} from '../../../tools/migration/activate-recovery-copy';

export const recoveryStamp=new Date('2026-11-22T00:00:00Z');
export async function recoveryActivationFixture(){
  const s=await legacyHistoryFixture();
  try{
    const data=dirname(s.db.name),journal=erasureJournal(s.db),privacy=createPrivacy(s.db,journal);
    const entry={version:1 as const,kind:'both' as const,userId:'bob',profileId:profileId('10002'),requestId:randomUUID(),createdAt:recoveryStamp.toISOString(),secretHash:hash('fixture-secret'),signature:hash('fixture-signature')};
    s.db.transaction(()=>privacy.submit(entry)).immediate();privacy.guard();
    for(const [i,status] of ['pending','sending','sent','failed','skipped','skipped'].entries())s.db.prepare("INSERT INTO bot_outbox(event_id,kind,dedupe_key,target,payload_json,status,claim_token,retry_at,simulated_at,delivered_payload_json,created_at) VALUES('listen','recovery',?,'synthetic','{}',?,?,?,?,?,'historical')").run('recovery-'+i,status,status==='sending'?'uncertain-fixture':'',status==='failed'?'retry-fixture':null,i===4?'simulation-fixture':null,status==='sent'?'sent-fixture':null);
    const logs=join(data,'bot-logs'),abbreviations=join(data,'bot-abbreviation-results');fs.mkdirSync(logs,{mode:0o700});fs.mkdirSync(abbreviations,{mode:0o700});
    fs.writeFileSync(join(logs,'bot-group-state.json'),'{"push_authorized":false}',{mode:0o600});fs.writeFileSync(join(logs,'bot-events.jsonl'),'{"event":"synthetic-history"}\n',{mode:0o600});
    const token='a'.repeat(24),groupHash=digest('synthetic-group');
    fs.writeFileSync(join(abbreviations,token+'.json'),JSON.stringify({group:groupHash,created:1000,offset:0,budget:2000,uncertain:true}),{mode:0o600});fs.writeFileSync(join(abbreviations,token+'.txt'),'continuation text',{mode:0o600});
    const words=join(data,'sensitive-words.json');fs.writeFileSync(words,'["合成屏蔽詞"]',{mode:0o600});
    s.db.exec('UPDATE rebuild_storage SET recovery_required=1 WHERE id=1');
    const media=captureRollbackMedia(s.db,journal),state=projectRollbackStateFromCheckpoint(media.checkpointImage,media.journal),history=projectRollbackHistory(state,{capture:s.config,native:{root:join(data,'paired-backups'),manifests:[]}}),bot=captureRollbackBotState({database:s.db.name,logDirectory:logs,sensitiveWordsFile:words},recoveryStamp);
    const pkg=assembleRollbackPackageV2(state,media,history,bot.state,pinRollbackPackageSourceV2(media,{captureManifestSha256:s.config.manifestSha256,native:[]},bot.state));
    const packageRoot=join(s.root,'package'),packagePin=writeRollbackPackage(pkg,packageRoot,[s.capture,data],recoveryStamp).manifestSha256;
    const originalJournal=fs.readFileSync(erasureJournalPath(s.db.name)),authorityRoot=join(s.root,'authority'),authorityPin=writeRollbackErasureAuthority(packageRoot,packagePin,authorityRoot,recoveryStamp,undefined,{database:s.db.name,sha256:digest(originalJournal)}).manifestSha256;
    const authority=readRollbackErasureAuthority(authorityRoot,authorityPin),source=readRollbackPackage(packageRoot,packagePin);
    const evidence=Object.fromEntries((['source','capture','versions','bot'] as const).map(name=>{const raw=encode({kind:'synthetic-private-'+name+'-review',accepted:true}),path=join(s.root,name+'-review.json');fs.writeFileSync(path,raw,{mode:0o600});return [name,{path,sha256:digest(raw)}];})) as RecoveryActivationInputValue['evidence'];
    const review:RecoveryReview={version:1,kind:'qgroup-private-recovery-review',reviewedAt:recoveryStamp.toISOString(),checkpointSha256:digest(source.state.checkpointImage),journalSha256:digest(originalJournal),authorityManifestSha256:authorityPin,authorityHeadSha256:digest(encode(authority.head)),lineageId:(s.db.prepare('SELECT lineage_id FROM rebuild_storage').get() as {lineage_id:string}).lineage_id,botStateSha256:bot.pin,
      services:{web:{runtime:'typescript',commit:'a'.repeat(40),imageId:'sha256:'+'1'.repeat(64)},bot:{runtime:'python',commit:'b'.repeat(40),imageId:'sha256:'+'2'.repeat(64)}},evidence:Object.fromEntries(Object.entries(evidence).map(([name,file])=>[name,file.sha256])) as RecoveryReview['evidence'],deliveries:recoveryDeliveryReview(s.db)};
    const path=join(s.root,'review.json');fs.writeFileSync(path,encode(review),{mode:0o600});
    const input:RecoveryActivationInputValue={packageRoot,packageSha256:packagePin,authorityRoot,authoritySha256:authorityPin,review:{path,sha256:digest(encode(review))},evidence,destination:join(s.root,'activated')};
    function replaceReview(value:RecoveryReview){const raw=encode(value);fs.writeFileSync(path,raw,{mode:0o600});input.review.sha256=digest(raw);}
    return {...s,data,entry,media,bot,packageRoot,packagePin,authorityRoot,authorityPin,authority,source,review,input,originalJournal,replaceReview};
  }catch(error){s.close();throw error;}
}
