import Database from 'better-sqlite3';
import type {DB} from '@qgroup/database';
import {join} from 'node:path';
import {z} from 'zod';
import {decodeErasureJournal,erasureRequestId,readVerifiedErasureJournal,type StoredIntent} from '../../apps/api/src/erasure-journal';
import {createPrivacy,replayMusicErasure} from '../../apps/api/src/privacy';
import {ErasureAuthorityRecord,privateFile,readRollbackErasureAuthority,validateAuthorityLedger} from '../../apps/api/src/erasure-authority-protocol';
import {digest,parseJson,type Json} from '../../packages/runtime/src/strict-json';
import {profileId} from '../../packages/database/src/legacy-music-codec';
import {projectRollbackStateFromCheckpoint} from './rollback-state';
import {rollbackMusicKeys} from './rollback-music';
import {assertRollbackSource} from './rollback-source';
import {repairAppliedAccountErasures} from './forward-account-erasures';
import {reconcileAppliedAccountRepair} from './forward-account-reconciliation';
import {importedLegacyMusicIntent} from '../../apps/api/src/legacy-music-intent';
import {readSourceRebaseEvidence,sourceRebaseDigest} from './source-rebase-evidence';

export type ForwardErasureInput={authorityRoot:string;manifestSha256:string;checkpoint:Buffer;nativeImage:Buffer;nativeImageSha256:string;nativeJournal:Buffer;nativeJournalSha256:string};
const sha=z.string().regex(/^[a-f0-9]{64}$/);
const text=(bytes:Buffer)=>new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
const rows=(bytes:Buffer)=>text(bytes).split('\n').filter(row=>row.trim()).map(row=>parseJson(row));
const canonical=(value:unknown)=>JSON.stringify(value,(_key,item:unknown)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item);
function image(bytes:Buffer){if(!Buffer.isBuffer(bytes)||bytes.length<100||bytes.length>512*1024*1024||bytes.subarray(0,16).toString('binary')!=='SQLite format 3\0'||bytes[18]!==1||bytes[19]!==1)throw Error('Forward erasures require standalone native image bytes');}
function lineage(db:DB){const row=db.prepare('SELECT lineage_id,recovery_required FROM rebuild_storage WHERE id=1').get() as {lineage_id:string;recovery_required:number}|undefined;if(!row||!/^[a-f0-9]{32}$/.test(row.lineage_id)||![0,1].includes(row.recovery_required))throw Error('Forward erasure lineage requires review');return row.lineage_id;}
/** A recorded old-service Unix timestamp is converted explicitly; arbitrary
 * opaque historical times are retained in the baseline, never guessed here. */
function nativeStamp(value:Json){if(typeof value==='string'&&z.iso.datetime().safeParse(value).success)return value;if(typeof value==='number'&&Number.isFinite(value)&&value>=0&&value*1000<=8640000000000000)return new Date(value*1000).toISOString();throw Error('Latest old music erasure time requires explicit review');}
function accountFootprint(db:DB,userIds:Iterable<string>){
  const privateTables=['music_profile_receipts','external_profiles','external_identities','qq_accounts','qq_attempts','login_attempts','privacy_consents','user_payment_codes','notifications','request_results','device_links','admin_user_metadata','browser_accounts','browser_sessions','time_poll_votes','time_poll_ballots','event_access','unified_privacy_consents','unified_privacy_receipts'];
  for(const id of userIds){const user=db.prepare('SELECT nickname FROM users WHERE id=?').get(id) as {nickname:string}|undefined;if(!user)continue;
    if(user.nickname!=='已注销用户'||!db.prepare('SELECT 1 FROM privacy_requests WHERE user_id=?').get(id)||db.prepare('SELECT 1 FROM user_admin_roles WHERE user_id=? AND is_admin=1').get(id)||db.prepare('SELECT 1 FROM music_profiles WHERE user_id=?').get(id)||db.prepare('SELECT 1 FROM music_claim_intents WHERE target_user_id=?').get(id))throw Error('Restored account erasure footprint requires repair');
    for(const table of privateTables)if(db.prepare(`SELECT 1 FROM ${table} WHERE user_id=? LIMIT 1`).get(id))throw Error('Restored account erasure footprint requires repair');
  }
}
/** Only deletion projection, never business merge or activation. All SQLite
 * sources are supplied as separately pinned immutable bytes and opened solely
 * in memory. The resulting native image remains recovery-blocked. The original
 * authority is read-only and old-service byte ledgers accompany the result. */
export function projectNativeForwardErasures(input:ForwardErasureInput,assertBoundary?:()=>void){
  image(input.checkpoint);image(input.nativeImage);sha.parse(input.nativeImageSha256);sha.parse(input.nativeJournalSha256);
  if(digest(input.nativeImage)!==input.nativeImageSha256||digest(input.nativeJournal)!==input.nativeJournalSha256)throw Error('Forward native source pin differs');
  const held={checkpoint:Buffer.from(input.checkpoint),nativeImage:Buffer.from(input.nativeImage),nativeJournal:Buffer.from(input.nativeJournal)},authority=readRollbackErasureAuthority(input.authorityRoot,input.manifestSha256);
  if(digest(held.checkpoint)!==authority.manifest.checkpointSha256)throw Error('Forward authority checkpoint pin differs');
  function guarded(){const value:unknown=assertBoundary?.();if(value!==null&&(typeof value==='object'||typeof value==='function')&&'then' in value)throw Error('Forward erasure boundary must be synchronous');if(!input.checkpoint.equals(held.checkpoint)||!input.nativeImage.equals(held.nativeImage)||!input.nativeJournal.equals(held.nativeJournal))throw Error('Forward native source bytes changed');authority.assertUnchanged();}
  guarded();validateAuthorityLedger('unified',held.nativeJournal);
  if(!authority.ledgers.unified.subarray(0,held.nativeJournal.length).equals(held.nativeJournal))throw Error('Forward native journal has unrecorded bytes');
  const baselines=Object.fromEntries(authority.manifest.baseline.map(row=>{const file=privateFile(join(input.authorityRoot,row.path),64*1024*1024);if(!file.bytes||file.sha256!==row.sha256)throw Error('Forward authority baseline differs');file.assertUnchanged();return [row.domain,file.bytes];})) as Record<'board'|'music'|'unified',Buffer>;
  const baselineMusic=rows(baselines.music) as {qq:string;erased_at:Json}[],baselineTimes=new Map(baselineMusic.map(row=>[row.qq,row.erased_at]));
  const baselineIntents=decodeErasureJournal(text(baselines.unified)),baseline=projectRollbackStateFromCheckpoint(held.checkpoint,baselineIntents);
  if(digest(JSON.stringify(baselineIntents))!==authority.manifest.journalSha256||canonical(rows(baselines.board))!==canonical(rows(Buffer.from(baseline.erasures.boardJournal)))||canonical(rows(baselines.music))!==canonical(rows(Buffer.from(baseline.erasures.musicJournal))))throw Error('Forward baseline differs from complete checkpoint erasures');
  // A native writer refuses old-service additions until a full rebase. Hence
  // its source phase must precede resumed old writers in this authority epoch.
  let oldPhase=false;const oldMusic=new Map<string,Json>(),oldOrigins=new Map<string,{recordSequence:number;recordSha256:string;suffixSha256:string;rowIndex:number}>();
  for(let sequence=1;sequence<=authority.head.sequence;sequence++){
    const file=privateFile(join(input.authorityRoot,'records',String(sequence).padStart(12,'0')+'.json'),90*1024*1024),record=ErasureAuthorityRecord.parse(parseJson(text(file.bytes!)));file.assertUnchanged();
    if(record.version===2)throw Error('Structured old reset requires source generation and complete forward repair');
    if(record.domain==='unified'&&oldPhase)throw Error('Interleaved native and old-service writes require a complete rebase');
    if(record.domain!=='unified')oldPhase=true;
    if(record.domain==='music'){const suffix=Buffer.from(record.suffixBase64,'base64');for(const [rowIndex,row] of (rows(suffix) as {qq:string;erased_at:Json}[]).entries()){oldMusic.set(row.qq,row.erased_at);oldOrigins.set(row.qq,{recordSequence:sequence,recordSha256:file.sha256!,suffixSha256:digest(suffix),rowIndex});}}
  }
  const nativeIntents=decodeErasureJournal(text(authority.ledgers.unified)),merged=[...nativeIntents],byRequest=new Map(merged.map(entry=>[erasureRequestId(entry),entry])),added:StoredIntent[]=[],closures=new Set<string>();
  for(const entry of decodeErasureJournal(text(authority.ledgers.board))){if(!('user_id' in entry))throw Error('Original board closure required');closures.add(entry.user_id);const previous=byRequest.get(entry.request_id);
    if(previous){const closure='user_id' in previous?previous:previous.version===1&&previous.kind!=='music'?{user_id:previous.userId,request_id:previous.requestId,created_at:previous.createdAt}:null;if(canonical(closure)!==canonical(entry))throw Error('Forward account request identity conflicts');}
    else{byRequest.set(entry.request_id,entry);merged.push(entry);added.push(entry);}
  }
  let journal:Buffer;
  const fixed=new Database(held.checkpoint);let db:DB;
  try{db=new Database(held.nativeImage);}catch(error){fixed.close();throw error;}
  try{
    db.pragma('foreign_keys = ON');
    if(lineage(db)!==lineage(fixed))throw Error('Forward native source lineage differs');
    const mappings=new Map<string,string>(),ids=new Map<string,string>();
    db.transaction(()=>{
      assertRollbackSource(db);
      for(const key of [...baseline.music.keys,...rollbackMusicKeys(db)]){const prior=mappings.get(key.legacyKey),name=ids.get(key.profileId);if(prior&&prior!==key.profileId||name&&name!==key.legacyKey)throw Error('Forward music key mapping conflicts');mappings.set(key.legacyKey,key.profileId);ids.set(key.profileId,key.legacyKey);}
    }).immediate();
    const rebased=readSourceRebaseEvidence(db),imported=[] as ReturnType<typeof importedLegacyMusicIntent>[];
    for(const [legacyKey,raw] of oldMusic){
      const entry=importedLegacyMusicIntent({version:3,kind:'legacy_music',profileId:mappings.get(legacyKey)??profileId(legacyKey),legacyKey,createdAt:nativeStamp(raw),originalErasedAtJson:JSON.stringify(raw),origin:{authoritySha256:input.manifestSha256,checkpointSha256:authority.manifest.checkpointSha256,...oldOrigins.get(legacyKey)!,sourceRebaseSha256:rebased?sourceRebaseDigest(rebased):null}}),previous=byRequest.get(entry.markerId);
      if(previous){if(canonical(previous)!==canonical(entry))throw Error('Imported original music scope differs');}
      else{byRequest.set(entry.markerId,entry);merged.push(entry);added.push(entry);imported.push(entry);}
    }
    journal=Buffer.concat([authority.ledgers.unified,Buffer.from(added.map(entry=>JSON.stringify(entry)+'\n').join(''))]);validateAuthorityLedger('unified',journal);
    const mergedJournal={read:()=>merged,append(){throw Error('Forward projection journal is read-only');}};
    // Commit only in this disposable memory candidate. Serialized dirty pages
    // need not include unapplied transaction writes, so capture the verifier's
    // pre-repair source after the ordinary recovery transaction has committed.
    // Nothing is returned or published unless every subsequent check succeeds.
    createPrivacy(db,mergedJournal);
    const repairSource=new Database(db.serialize());
    let report;
    try{
      repairSource.pragma('foreign_keys = ON');
      report=db.transaction(()=>{
        assertRollbackSource(db);
        // Baseline tombstones also matter when an older native image predates
        // the original import. Its local journal alone cannot recreate them.
        const scope=new Map<string,{id:string;stamp:string;raw:Json}>();
        for(const key of baseline.music.keys.filter(row=>row.erased)){const stamp=(fixed.prepare('SELECT erased_at FROM music_profiles WHERE id=?').get(key.profileId) as {erased_at:string}).erased_at;if(!z.iso.datetime().safeParse(stamp).success)throw Error('Baseline native tombstone time requires review');if(!baselineTimes.has(key.legacyKey))throw Error('Baseline music scope lacks original ledger');scope.set(key.legacyKey,{id:key.profileId,stamp,raw:baselineTimes.get(key.legacyKey)!});}
        for(const row of baselineMusic)if(!scope.has(row.qq))throw Error('Baseline erased key lacks checkpoint mapping');
        for(const [key,raw] of oldMusic){const id=mappings.get(key)??profileId(key);if(ids.has(id)&&ids.get(id)!==key)throw Error('Forward music key mapping conflicts');scope.set(key,{id,stamp:nativeStamp(raw),raw});}
        const nativeScopes=new Map<string,string>();
        for(const intent of merged){
          if('user_id' in intent)closures.add(intent.user_id);
          else if(intent.version===1){if(intent.kind!=='music')closures.add(intent.userId);if(intent.kind!=='account'&&intent.profileId)nativeScopes.set(intent.profileId,intent.createdAt);}
          else if(intent.version===2)for(const profile of intent.profiles)nativeScopes.set(profile.id,intent.createdAt);
          else nativeScopes.set(intent.profileId,intent.createdAt);
        }
        repairAppliedAccountErasures(db,mergedJournal);
        const accountRepair=reconcileAppliedAccountRepair(repairSource,db,mergedJournal);
        accountFootprint(db,closures);
        // Receipts prove the intent, not a restored snapshot's private footprint.
        // Reapply native-only profile scopes without duplicating administration
        // audits or manufacturing a new intent. Full reset repair remains separate.
        const scopedIds=new Set([...scope.values()].map(value=>value.id));
        for(const [id,stamp] of nativeScopes)if(!scopedIds.has(id))replayMusicErasure(db,id,null,stamp);
        for(const intent of nativeIntents)if('version' in intent&&intent.version===2&&intent.command==='reset_music'){
          if(intent.entries.some(id=>db.prepare('SELECT 1 FROM music_entries WHERE id=?').get(id)))throw Error('Restored native reset footprint requires complete repair');
        }
        const projected:{legacyKey:string;profileId:string;stamp:string;originalTime:Json;source:'baseline'|'old-service'}[]=[];
        for(const [key,value] of scope){
          const prior=db.prepare("SELECT target_id FROM migration_map WHERE source='music' AND entity_type='profile' AND source_id=?").get(key) as {target_id:string}|undefined;
          if(prior&&prior.target_id!==value.id)throw Error('Forward music source mapping conflicts');
          if(!prior)db.prepare("INSERT INTO migration_map VALUES('music','profile',?,?,?,?,'erased')").run(key,value.id,'',digest(canonical({authority:input.manifestSha256,head:authority.head.recordSha256,key,profileId:value.id})));
          const current=db.prepare('SELECT erased_at FROM music_profiles WHERE id=?').get(value.id) as {erased_at:string|null}|undefined;
          const old=oldMusic.has(key),stamp=!old&&current?.erased_at?current.erased_at:nativeScopes.get(value.id)&&!old?nativeScopes.get(value.id)!:value.stamp;
          if(!z.iso.datetime().safeParse(stamp).success)throw Error('Current native tombstone time requires review');
          const originalTime=db.prepare('SELECT erased_at_json FROM music_legacy_erasures WHERE legacy_key=?').get(key) as {erased_at_json:string}|undefined;
          if(originalTime)parseJson(originalTime.erased_at_json);
          const savedTime=!old&&current?.erased_at&&originalTime?originalTime.erased_at_json:JSON.stringify(value.raw);
          replayMusicErasure(db,value.id,null,stamp);
          // Retain exact original JSON time independently from the native marker.
          db.prepare('INSERT INTO music_legacy_erasures VALUES(?,?) ON CONFLICT(legacy_key) DO UPDATE SET erased_at_json=excluded.erased_at_json').run(key,savedTime);
          projected.push({legacyKey:key,profileId:value.id,stamp,originalTime:value.raw,source:old?'old-service':'baseline'});
        }
        readVerifiedErasureJournal(db,{read:()=>merged,append(){throw Error('Forward projection journal is read-only');}});
        if(db.pragma('integrity_check',{simple:true})!=='ok'||(db.pragma('foreign_key_check') as unknown[]).length)throw Error('Forward erasure projection integrity failed');
        db.prepare('UPDATE rebuild_storage SET recovery_required=1 WHERE id=1 AND recovery_required<>1').run();
        return {accountClosures:closures.size,accountRepair,addedBoardIntents:added.filter(row=>'user_id' in row).length,importedLegacyMusicIntents:imported.length,nativeProfileScopes:nativeScopes.size,musicScopes:projected};
      }).immediate();
    }finally{repairSource.close();}
    guarded();const nativeImage=db.serialize();image(nativeImage);return {nativeImage,nativeJournal:journal,boardJournal:Buffer.from(authority.ledgers.board),musicJournal:Buffer.from(authority.ledgers.music),report:{version:1 as const,authoritySha256:input.manifestSha256,headSequence:authority.head.sequence,headRecordSha256:authority.head.recordSha256,checkpointSha256:authority.manifest.checkpointSha256,nativeSourceSha256:input.nativeImageSha256,nativeSourceJournalSha256:input.nativeJournalSha256,nativeImageSha256:digest(nativeImage),nativeJournalSha256:digest(journal),lineageId:lineage(db),...report,erasureOnly:true as const,recoveryRequired:true as const,rollbackEligible:false as const,releaseEligible:false as const,remaining:['complete_old_and_native_business_forward_merge','structured_old_reset_scope','fixed_web_music_bot_combination','media_and_browser_forward_restore','rebase_authority_and_external_retention','audited_recovery_activation']}};
  }finally{db.close();fixed.close();}
}
