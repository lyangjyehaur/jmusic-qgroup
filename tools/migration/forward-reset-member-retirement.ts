import Database from 'better-sqlite3';
import {z} from 'zod';
import {musicRetirementSchema,musicRetirementManifestSchema,musicRetirementDigest,readMusicRetirements,type DB} from '@qgroup/database';
import {readVerifiedErasureJournal,decodeErasureJournal} from '../../apps/api/src/erasure-journal';
import {readRollbackErasureAuthority} from '../../apps/api/src/erasure-authority-protocol';
import {pinRollbackTree} from '../../packages/runtime/src/private-source-files';
import {assertRollbackSource} from './rollback-source';
import {rollbackMusicKeys} from './rollback-music';
import {schemaObjects,quoted} from './board-reconciliation';
import {assertForwardImage,forwardHash,forwardRows,forwardEqual,forwardCanonical,forwardLineage,forwardSequences,type PinnedForwardBytes,type ForwardRow} from './forward-board-storage';
import {prepareForwardLegacyResetMemberDisposition,verifyForwardLegacyResetMemberDisposition,type LegacyResetMemberDispositionBundle} from './forward-legacy-reset-member-disposition';
import type {LegacyResetIdentityMemberInput} from './forward-legacy-reset-identity-members';

export type ResetMemberRetirementInput={members:LegacyResetIdentityMemberInput;checkpoint:PinnedForwardBytes;nativeImage:PinnedForwardBytes;nativeJournal:PinnedForwardBytes;retiredAt:string};
const invalidatedResult=JSON.stringify({code:'PROFILE_RESET_REMOVED',message:'原成分已在重設後失效，請核對目前成分再保存'});
const pin=(row:PinnedForwardBytes,image=false)=>{if(!Buffer.isBuffer(row.bytes)||forwardHash(row.bytes)!==row.sha256)throw Error('Reset retirement source pin differs');if(image)assertForwardImage(row.bytes);return {bytes:Buffer.from(row.bytes),sha256:row.sha256};};
function sources(input:ResetMemberRetirementInput,bundle:LegacyResetMemberDispositionBundle,boundary?:()=>void){
  const s={members:{vault:{...input.members.vault},music:pin(input.members.music),identity:pin(input.members.identity,true)},checkpoint:pin(input.checkpoint,true),nativeImage:pin(input.nativeImage,true),nativeJournal:pin(input.nativeJournal),retiredAt:z.iso.datetime().parse(input.retiredAt)};
  if(s.nativeJournal.bytes.length>64*1024*1024)throw Error('Reset retirement journal exceeds capacity');
  const authority=readRollbackErasureAuthority(s.members.vault.authorityRoot,s.members.vault.manifestSha256),tree=pinRollbackTree(s.members.vault.vaultRoot);
  if(s.checkpoint.sha256!==authority.manifest.checkpointSha256)throw Error('Reset retirement checkpoint differs from original authority');
  if(authority.records.some(row=>row.version===2&&Date.parse(s.retiredAt)/1000<Number(JSON.parse(row.operation.erasedAtJson))))throw Error('Reset retirement predates the recorded reset');
  const guard=()=>{const value:unknown=boundary?.();if(value!==null&&(typeof value==='object'||typeof value==='function')&&'then' in value)throw Error('Reset retirement boundary must be synchronous');
    for(const name of ['checkpoint','nativeImage','nativeJournal'] as const)if(input[name].sha256!==s[name].sha256||!input[name].bytes.equals(s[name].bytes))throw Error('Reset retirement source changed');
    for(const name of ['music','identity'] as const)if(input.members[name].sha256!==s.members[name].sha256||!input.members[name].bytes.equals(s.members[name].bytes))throw Error('Reset retirement member source changed');
    for(const name of Object.keys(s.members.vault) as (keyof typeof s.members.vault)[])if(input.members.vault[name]!==s.members.vault[name])throw Error('Reset retirement vault changed');if(input.retiredAt!==s.retiredAt)throw Error('Reset retirement time changed');authority.assertUnchanged();tree.assertUnchanged();};
  guard();verifyForwardLegacyResetMemberDisposition(s.members,bundle,guard);
  const checkpoint=new Database(s.checkpoint.bytes),native=new Database(s.nativeImage.bytes);
  try{for(const db of [checkpoint,native]){db.pragma('foreign_keys=ON');db.transaction(()=>assertRollbackSource(db)).immediate();readMusicRetirements(db);forwardSequences(db);}
    if(forwardLineage(checkpoint)!==forwardLineage(native))throw Error('Reset retirement native lineage differs');
    native.transaction(()=>readVerifiedErasureJournal(native,{read:()=>decodeErasureJournal(s.nativeJournal.bytes.toString()),append(){throw Error('Readonly retirement journal');}})).immediate();
    guard();return {s,guard,checkpoint,native,close(){native.close();checkpoint.close();}};
  }catch(error){native.close();checkpoint.close();throw error;}
}
/** Every directly referenced profile row is fenced, including future FK tables.
 * Additional legacy documents, receipts and proof attempts have explicit scope. */
function scopedRows(db:DB,id:string,key:string,owner:string|null){
  const result:Record<string,ForwardRow[]>={},tables=schemaObjects(db).filter(row=>row.type==='table'&&!row.name.startsWith('sqlite_')).map(row=>row.name);
  for(const table of tables){
    const refs=(db.prepare(`PRAGMA foreign_key_list(${quoted(table)})`).all() as {table:string;from:string}[]).filter(row=>row.table==='music_profiles').map(row=>row.from);
    if(table==='music_profiles')refs.push('id');if(refs.length)result[table]=[...forwardRows(db,table)].filter(row=>refs.some(column=>row[column]===id));
  }
  result.music_documents=[...forwardRows(db,'music_documents')].filter(row=>row.kind==='profile_source'&&JSON.parse(String(row.payload_json)).profileId===id||row.kind==='profile_retirement'&&JSON.parse(String(row.payload_json)).profileId===id);
  result.music_legacy_identity=[...forwardRows(db,'music_legacy_identity')].filter(row=>JSON.parse(String(row.payload_json)).qq===key);
  result.migration_map=[...forwardRows(db,'migration_map')].filter(row=>row.source==='music'&&row.entity_type==='profile'&&row.target_id===id);
  result.music_entry_details=[...forwardRows(db,'music_entry_details')].filter(row=>row.created_by===id||row.created_by===key);
  const receipts=result.music_profile_receipts??[],intents=result.music_claim_intents??[];
  result.request_results=[...forwardRows(db,'request_results')].filter(row=>receipts.some(receipt=>receipt.user_id===row.user_id&&receipt.request_key===row.request_key));
  result.login_attempts=[...forwardRows(db,'login_attempts')].filter(row=>intents.some(intent=>intent.attempt_id===row.id));
  result.music_account_epochs=[...forwardRows(db,'music_account_epochs')].filter(row=>owner!==null&&row.user_id===owner);
  result.privacy_requests=[...forwardRows(db,'privacy_requests')].filter(row=>owner!==null&&row.user_id===owner);
  return result;
}
function manifest(h:ReturnType<typeof sources>,bundle:LegacyResetMemberDispositionBundle){
  const baseline=rollbackMusicKeys(h.checkpoint),native=rollbackMusicKeys(h.native),profiles=[];
  for(const retired of bundle.dispositions){
    const original=baseline.find(row=>row.legacyKey===retired.key),current=native.find(row=>row.legacyKey===retired.key);
    if(!original){if(current)throw Error('Persisted-only reset key conflicts with a new native profile');continue;}
    if(!current||original.erased||current.erased||original.profileId!==current.profileId||original.mode!==current.mode)throw Error('Reset retirement needs original mapping and latest erasure reconciliation');
    const p=h.checkpoint.prepare('SELECT user_id,revision FROM music_profiles WHERE id=?').safeIntegers(true).get(original.profileId) as {user_id:string|null;revision:bigint};
    if(p.revision>=BigInt(Number.MAX_SAFE_INTEGER))throw Error('Reset retirement revision capacity exhausted');
    if(!forwardEqual(scopedRows(h.checkpoint,original.profileId,original.legacyKey,p.user_id),scopedRows(h.native,current.profileId,current.legacyKey,p.user_id)))throw Error('Reset member has native writes requiring explicit reconciliation; retain both sources');
    if(readMusicRetirements(h.native).some(row=>row.profileId===current.profileId))throw Error('Retired source requires explicit source epoch reconciliation');
    const originalRow=[...forwardRows(h.checkpoint,'music_profiles')].find(row=>row.id===original.profileId)!;
    profiles.push({version:1 as const,kind:'legacy_reset_removed' as const,profileId:original.profileId,legacyKey:original.legacyKey,retiredAt:h.s.retiredAt,originalProfileSha256:forwardHash(forwardCanonical(originalRow)),occurrences:retired.occurrences.map(row=>({sequence:row.sequence,memberSha256:row.member.sha256,authorityRecordSha256:row.authorityRecordSha256,completionSha256:row.completionSha256}))});
  }
  const sourcePins={checkpoint:h.s.checkpoint.sha256,nativeImage:h.s.nativeImage.sha256,nativeJournal:h.s.nativeJournal.sha256,music:h.s.members.music.sha256,identity:h.s.members.identity.sha256,projectedMusic:bundle.projectedMusic.sha256,authority:h.s.members.vault.manifestSha256,vault:h.s.members.vault.vaultManifestSha256};
  return musicRetirementManifestSchema.parse({version:1,kind:'forward_reset_member_retirement',sourcePins,retiredAt:h.s.retiredAt,profiles});
}
function report(m:ReturnType<typeof manifest>,image:Buffer){return {version:1 as const,sourcePins:m.sourcePins,sourceDigest:musicRetirementDigest(m),nativeImageSha256:forwardHash(image),retiredProfiles:m.profiles.length,retainedHistoryOnlyKeys:m.profiles.map(row=>row.legacyKey),allOriginalNativeRowsVerified:true as const,nativeDispositionApplied:true as const,externalRetentionVerified:false as const,latestSourceAncestryVerified:false as const,recoveryRequired:true as const,releaseEligible:false as const};}
/** Native reset removal on a disposable image. All fields, choices and immutable
 * history stay in place. Ownership/epochs and saved responses are safely expired;
 * no original file, bot work, privacy intent or platform delivery is modified. */
export function projectForwardResetMemberRetirements(input:ResetMemberRetirementInput,boundary?:()=>void){
  const retained=prepareForwardLegacyResetMemberDisposition(input.members,boundary),h=sources(input,retained,boundary),candidate=new Database(h.s.nativeImage.bytes);
  try{const m=manifest(h,retained),run=musicRetirementDigest(m);candidate.pragma('foreign_keys=ON');candidate.transaction(()=>{
    let rowHigh=[...forwardRows(candidate,'music_documents')].reduce((n,row)=>n>row.__forward_rowid__?n:row.__forward_rowid__,0n),position=(candidate.prepare("SELECT max(position) n FROM music_documents WHERE kind='profile_retirement'").safeIntegers(true).get() as {n:bigint|null}).n??-1n;
    for(const item of m.profiles){const before=candidate.prepare('SELECT user_id FROM music_profiles WHERE id=?').get(item.profileId) as {user_id:string|null};candidate.prepare('UPDATE music_profiles SET user_id=NULL,revision=revision+1,updated_at=? WHERE id=?').run(m.retiredAt,item.profileId);
      if(before.user_id){const epoch=candidate.prepare('SELECT epoch FROM music_account_epochs WHERE user_id=?').safeIntegers(true).get(before.user_id) as {epoch:bigint}|undefined;if(epoch&&epoch.epoch>=BigInt(Number.MAX_SAFE_INTEGER))throw Error('Reset retirement account epoch exhausted');if(epoch)candidate.prepare('UPDATE music_account_epochs SET epoch=epoch+1 WHERE user_id=?').run(before.user_id);else{const high=[...forwardRows(candidate,'music_account_epochs')].reduce((n,row)=>n>row.__forward_rowid__?n:row.__forward_rowid__,0n);if(high===9223372036854775807n)throw Error('Reset retirement epoch row capacity exhausted');candidate.prepare('INSERT INTO music_account_epochs(rowid,user_id,epoch) VALUES(?,?,1)').run(high+1n,before.user_id);}}
      candidate.prepare(`UPDATE request_results SET response_status=410,response_json=? WHERE (user_id,request_key) IN(SELECT user_id,request_key FROM music_profile_receipts WHERE profile_id=?)`).run(invalidatedResult,item.profileId);
      if(rowHigh===9223372036854775807n||position>=BigInt(Number.MAX_SAFE_INTEGER))throw Error('Reset retirement document capacity exhausted');candidate.prepare('INSERT INTO music_documents(rowid,kind,position,payload_json) VALUES(?,?,?,?)').run(++rowHigh,'profile_retirement',++position,JSON.stringify(musicRetirementSchema.parse({...item,runSha256:run})));
    }
    const high=[...forwardRows(candidate,'migration_runs')].reduce((n,row)=>n>row.__forward_rowid__?n:row.__forward_rowid__,0n);if(high===9223372036854775807n)throw Error('Reset retirement run capacity exhausted');
    candidate.prepare('INSERT INTO migration_runs(rowid,source_digest,manifest_json,report_json,created_at) VALUES(?,?,?,?,?)').run(high+1n,run,JSON.stringify(m),JSON.stringify({nativeDispositionApplied:true,retiredProfiles:m.profiles.length,releaseEligible:false}),m.retiredAt);candidate.prepare('UPDATE rebuild_storage SET recovery_required=1 WHERE id=1').run();
  }).immediate();const image=candidate.serialize(),bundle={nativeImage:image,nativeJournal:Buffer.from(h.s.nativeJournal.bytes),retainedNativeImage:Buffer.from(h.s.nativeImage.bytes),retained,report:report(m,image)};verifyForwardResetMemberRetirements(input,bundle,h.guard);h.guard();return bundle;
  }finally{candidate.close();h.close();}
}
export type ResetMemberRetirementBundle=ReturnType<typeof projectForwardResetMemberRetirements>;
/** Full original-row oracle: does not rerun a writer or accept report decisions.
 * It derives every allowed delta from original source rows and reset evidence. */
export function verifyForwardResetMemberRetirements(input:ResetMemberRetirementInput,bundle:ResetMemberRetirementBundle,boundary?:()=>void){
  const fingerprint=()=>JSON.stringify([forwardHash(bundle.nativeImage),forwardHash(bundle.nativeJournal),forwardHash(bundle.retainedNativeImage),bundle.report,bundle.retained]),original=fingerprint(),h=sources(input,bundle.retained,()=>{const value:unknown=boundary?.();if(value!==null&&(typeof value==='object'||typeof value==='function')&&'then' in value)throw Error('Reset retirement boundary must be synchronous');if(fingerprint()!==original)throw Error('Reset retirement output changed');}),candidate=new Database(bundle.nativeImage);
  try{const m=manifest(h,bundle.retained),run=musicRetirementDigest(m),ids=new Set(m.profiles.map(row=>row.profileId)),originalOwners=new Map((h.native.prepare('SELECT id,user_id FROM music_profiles').all() as {id:string;user_id:string|null}[]).map(row=>[row.id,row.user_id])),owners=new Set(m.profiles.map(row=>originalOwners.get(row.profileId)).filter((owner):owner is string=>typeof owner==='string'));
    if(!bundle.nativeJournal.equals(h.s.nativeJournal.bytes)||!bundle.retainedNativeImage.equals(h.s.nativeImage.bytes))throw Error('Reset retirement retained source differs');
    assertForwardImage(bundle.nativeImage);if(!forwardEqual(schemaObjects(candidate),schemaObjects(h.native))||candidate.pragma('integrity_check',{simple:true})!=='ok'||(candidate.pragma('foreign_key_check') as unknown[]).length)throw Error('Reset retirement schema or integrity differs');
    const receiptKeys=new Set([...forwardRows(h.native,'music_profile_receipts')].filter(row=>ids.has(String(row.profile_id))).map(row=>JSON.stringify([row.user_id,row.request_key])));
    const changed=(db:DB,table:string,row:ForwardRow,values:Record<string,unknown>)=>{const result={...row,...values},columns=db.prepare(`PRAGMA table_xinfo(${quoted(table)})`).all() as {name:string}[];for(const [index,column] of columns.entries())if(Object.hasOwn(values,column.name)){const value=values[column.name];result['__forward_type_'+index]=value===null?'null':typeof value==='bigint'?'integer':typeof value==='number'?'real':'text';}return result;};
    const tables=schemaObjects(h.native).filter(row=>row.type==='table'&&!row.name.startsWith('sqlite_')).map(row=>row.name);
    for(const table of tables){const before=[...forwardRows(h.native,table)],actual=[...forwardRows(candidate,table)],wanted=before.map(row=>{
      if(table==='music_profiles'&&ids.has(String(row.id)))return changed(h.native,table,row,{user_id:null,revision:(row.revision as bigint)+1n,updated_at:m.retiredAt});
      if(table==='music_account_epochs'&&owners.has(String(row.user_id)))return changed(h.native,table,row,{epoch:(row.epoch as bigint)+1n});
      if(table==='request_results'&&receiptKeys.has(JSON.stringify([row.user_id,row.request_key])))return changed(h.native,table,row,{response_status:410n,response_json:invalidatedResult});
      if(table==='rebuild_storage')return changed(h.native,table,row,{recovery_required:1n});return row;
    });
    if(table==='music_account_epochs'){let high=before.reduce((n,row)=>n>row.__forward_rowid__?n:row.__forward_rowid__,0n);for(const owner of owners)if(!before.some(row=>row.user_id===owner))wanted.push({__forward_rowid__:++high,user_id:owner,epoch:1n,__forward_type_0:'text',__forward_type_1:'integer'});}
    if(table==='music_documents'){let high=before.reduce((n,row)=>n>row.__forward_rowid__?n:row.__forward_rowid__,0n),position=before.filter(row=>row.kind==='profile_retirement').reduce((n,row)=>n>(row.position as bigint)?n:row.position as bigint,-1n);for(const item of m.profiles)wanted.push({__forward_rowid__:++high,kind:'profile_retirement',position:++position,payload_json:JSON.stringify(musicRetirementSchema.parse({...item,runSha256:run})),__forward_type_0:'text',__forward_type_1:'integer',__forward_type_2:'text'});}
    if(table==='migration_runs'){const high=before.reduce((n,row)=>n>row.__forward_rowid__?n:row.__forward_rowid__,0n);wanted.push({__forward_rowid__:high+1n,source_digest:run,manifest_json:JSON.stringify(m),report_json:JSON.stringify({nativeDispositionApplied:true,retiredProfiles:m.profiles.length,releaseEligible:false}),created_at:m.retiredAt,__forward_type_0:'text',__forward_type_1:'text',__forward_type_2:'text',__forward_type_3:'text'});}
    if(!forwardEqual(actual,wanted.sort((a,b)=>a.__forward_rowid__<b.__forward_rowid__?-1:1)))throw Error('Reset retirement native row relation differs: '+table);
    }
    if(!forwardEqual(forwardSequences(candidate),forwardSequences(h.native)))throw Error('Reset retirement sequence changed');readMusicRetirements(candidate);
    if(!forwardEqual(bundle.report,report(m,bundle.nativeImage)))throw Error('Reset retirement report differs');h.guard();return {retiredProfiles:m.profiles.length,allOriginalNativeRowsVerified:true as const,nativeDispositionApplied:true as const,releaseEligible:false as const};
  }finally{candidate.close();h.close();}
}
