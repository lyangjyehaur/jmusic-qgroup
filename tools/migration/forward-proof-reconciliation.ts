import Database from 'better-sqlite3';
import {createMusicClaims} from '../../apps/api/src/music-claim';
import {accountScope,hash,type Device} from '../../apps/api/src/security';
import {schemaObjects} from './board-reconciliation';
import {assertRollbackSource} from './rollback-source';
import {copyForwardProofInput,openForwardProofSources,proofInputPins,type ForwardProofInput} from './forward-proof-source';
import {forwardOwnershipObservations,forwardClaimReasons,proofRowDigest,reassignedMusicResult,type ProofDisposition} from './forward-proof-policy';
import {forwardRows,forwardEqual,forwardCanonical,forwardHash,assertForwardImage,type ForwardRow} from './forward-board-storage';

const reject=():never=>{throw Error('Forward proof reconciliation failed; retain original business and every source');};
/** Independent output-row verifier. The frozen policy evaluator is shared; the
 * writer/change lists are not. It additionally probes actual native claim reads
 * with each original device scope and compares the entire database inventory. */
export function verifyForwardProofs(input:ForwardProofInput,image:Buffer){
  const held=copyForwardProofInput(input);assertForwardImage(image);const s=openForwardProofSources(held);let db:typeof s.business;
  try{db=new Database(Buffer.from(image));}catch(error){s.close();throw error;}
  try{
    db.transaction(()=>assertRollbackSource(db)).immediate();if(!forwardEqual(schemaObjects(s.business),schemaObjects(db)))reject();for(const key of ['user_version','application_id','encoding'])if(db.pragma(key,{simple:true})!==s.business.pragma(key,{simple:true}))reject();
    const pins=proofInputPins(held),run=forwardHash('qgroup:forward-proofs:v1:'+forwardCanonical({pins,reconstructedAt:held.reconstructedAt,reconciledAt:held.reconciledAt})),observations=forwardOwnershipObservations(s),expected=new Map<string,ForwardRow[]>(),claims:ProofDisposition[]=[],failed=new Set<string>(),receiptRows:string[]=[],profileRows:string[]=[],epochRows:string[]=[];
    for(const table of schemaObjects(s.business).filter(row=>row.type==='table').map(row=>row.name))expected.set(table,[...forwardRows(s.business,table)]);
    expected.set('sqlite_sequence',[...forwardRows(s.business,'sqlite_sequence')]);
    for(const row of expected.get('music_profiles')!){if(!observations.profiles.has(String(row.id)))continue;const original=s.original.board.native.prepare('SELECT revision FROM music_profiles WHERE id=?').safeIntegers(true).get(row.id) as {revision:bigint}|undefined;if(original&&original.revision===row.revision){if(original.revision>=BigInt(Number.MAX_SAFE_INTEGER))reject();row.revision=(row.revision as bigint)+1n;row.updated_at=held.reconciledAt;profileRows.push(row.__forward_rowid__.toString());}}
    const epochs=expected.get('music_account_epochs')!,bumped=new Map<string,string>();let epochHigh=epochs.map(row=>row.__forward_rowid__).reduce((high,id)=>high>id?high:id,0n);
    for(const id of observations.owners){const original=(s.original.board.native.prepare('SELECT epoch FROM music_account_epochs WHERE user_id=?').safeIntegers(true).get(id) as {epoch:bigint}|undefined)?.epoch??0n,row=epochs.find(row=>row.user_id===id);if((row?.epoch??0n)!==original)continue;if(original>=BigInt(Number.MAX_SAFE_INTEGER))reject();if(row){row.epoch=(row.epoch as bigint)+1n;bumped.set(id,row.__forward_rowid__.toString());}else{const rid=++epochHigh;epochs.push({__forward_rowid__:rid,user_id:id,epoch:1n,__forward_type_0:'text',__forward_type_1:'integer'});bumped.set(id,rid.toString());}}
    for(const id of observations.owners)if(bumped.has(id))epochRows.push(bumped.get(id)!);
    const nativeClaims=createMusicClaims(db,()=>new Date(held.reconciledAt));
    const claimRows=expected.get('music_claim_intents')!,kept:ForwardRow[]=[];
    for(const row of claimRows){const reasons=forwardClaimReasons(s.business,row,observations.profiles,observations.owners,held.reconciledAt),action=reasons.length?row.stage==='completed'?'detach_completed':'retire_pending':'retain',record:ProofDisposition={id:String(row.id),rowid:row.__forward_rowid__.toString(),beforeSha256:proofRowDigest(row),action,reasons};
      let device:Device;if(row.target_user_id)device={kind:'member',id:String(row.target_user_id),nickname:'',tokenHash:String(row.current_token_hash),scope:accountScope(String(row.target_user_id))};else device={kind:'visitor',tokenHash:String(row.current_token_hash),scope:hash('kanban-visitor-v1:'+row.current_token_hash)};
      if(action==='retain'){kept.push(row);const status=nativeClaims.status(device,String(row.id));if(status.status!==row.stage)reject();}
      else{if(nativeClaims.status(device,String(row.id)).status!=='none')reject();if(action==='detach_completed'){record.detachedTokenHash=forwardHash('qgroup:forward-retired-proof:v1:'+run+':'+row.id);kept.push({...row,current_token_hash:record.detachedTokenHash});}else if(row.attempt_id){const attempt=expected.get('login_attempts')!.find(attempt=>attempt.id===row.attempt_id);if(attempt&&['pending','exchanging','verified'].includes(String(attempt.status)))failed.add(String(row.attempt_id));}}
      claims.push(record);
    }
    expected.set('music_claim_intents',kept);
    for(const row of expected.get('login_attempts')!)if(failed.has(String(row.id))){row.status='failed';row.union_id='';}
    const receipts=expected.get('music_profile_receipts')!;for(const row of expected.get('request_results')!){const mapping=receipts.find(receipt=>receipt.user_id===row.user_id&&receipt.request_key===row.request_key);if(mapping&&observations.receiptProfiles.has(String(mapping.profile_id))&&!(row.response_status===410n&&row.response_json===reassignedMusicResult)){row.response_status=410n;row.response_json=reassignedMusicResult;receiptRows.push(row.__forward_rowid__.toString());}}
    profileRows.sort((a,b)=>BigInt(a)<BigInt(b)?-1:1);
    const manifest={version:1,kind:'forward_proofs',sourcePins:pins,reconstructedAt:held.reconstructedAt,reconciledAt:held.reconciledAt,retainedBusinessImageSha256:held.businessImage.sha256},report={claims,failedAttempts:[...failed],receiptRows,profileRows,epochRows,sourceRebaseRequired:true,latestErasureReplayRequired:true,externalRetentionRequired:true,releaseEligible:false};
    const runs=expected.get('migration_runs')!,high=runs.map(row=>row.__forward_rowid__).reduce((high,id)=>high>id?high:id,0n);runs.push({__forward_rowid__:high+1n,source_digest:run,manifest_json:JSON.stringify(manifest),report_json:JSON.stringify(report),created_at:held.reconciledAt,__forward_type_0:'text',__forward_type_1:'text',__forward_type_2:'text',__forward_type_3:'text'});
    const counts:Record<string,number>={},digests:Record<string,string>={};for(const [table,rows] of expected){const actual=[...forwardRows(db,table)];if(!forwardEqual(rows.sort((a,b)=>a.__forward_rowid__<b.__forward_rowid__?-1:1),actual))reject();counts[table]=actual.length;digests[table]=forwardHash(forwardCanonical(actual));}
    if((db.prepare('SELECT recovery_required FROM rebuild_storage').get() as {recovery_required:number}).recovery_required!==1)reject();
    return {version:1 as const,sourcePins:pins,sourceDigest:run,checkedTables:counts,rowsDigest:forwardHash(forwardCanonical(digests)),nativeClaimReadsVerified:true as const,originalBusinessEvidenceRequired:true as const,recoveryRequired:true as const,releaseEligible:false as const};
  }finally{db.close();s.close();}
}
/** A parent package must verify the retained bytes too; a clean native image
 * alone cannot prove that the superseded private proof/receipt was preserved. */
export function verifyForwardProofBundle(input:ForwardProofInput,bundle:{nativeImage:Buffer;nativeJournal:Buffer;retainedBusinessImage:Buffer;musicSources:Buffer;identitySources:Buffer}){
  const held=copyForwardProofInput(input);
  for(const [actual,expected] of [[bundle.nativeJournal,held.sources.nativeJournal.bytes],[bundle.retainedBusinessImage,held.businessImage.bytes],[bundle.musicSources,held.musicSources.bytes],[bundle.identitySources,held.identitySources.bytes]])if(!Buffer.isBuffer(actual)||!actual.equals(expected!))reject();
  return {...verifyForwardProofs(held,bundle.nativeImage),retainedBusinessImageVerified:true as const,pairedSourceBytesVerified:true as const};
}
