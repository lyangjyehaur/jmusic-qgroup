import Database from 'better-sqlite3';
import {join} from 'node:path';
import {readMusicRetirements,type DB} from '@qgroup/database';
import {privateFile,readRollbackErasureAuthority} from '../../apps/api/src/erasure-authority-protocol';
import {decodeErasureJournal} from '../../apps/api/src/erasure-journal';
import {projectForwardResetMemberRetirements,verifyForwardResetMemberRetirements,type ResetMemberRetirementInput,type ResetMemberRetirementBundle} from './forward-reset-member-retirement';
import {assertForwardIdentity} from './forward-music-sources';
import {forwardHash,forwardRows,forwardEqual,forwardSequences,assertForwardImage,type PinnedForwardBytes,type ForwardRow} from './forward-board-storage';
import {schemaObjects} from './board-reconciliation';
import {identitySeconds} from './rollback-identity-source';

const pin=(bytes:Buffer):PinnedForwardBytes=>({bytes:Buffer.from(bytes),sha256:forwardHash(bytes)});
const inactiveTables=new Set(['sessions','entry_intents','links','prelinks','link_overrides','native_profiles']);
/** Read the actual original checkpoint journal. The current native journal may
 * contain later work and cannot be substituted for this captured baseline. */
function baselineSource(input:ResetMemberRetirementInput){
  const authority=readRollbackErasureAuthority(input.members.vault.authorityRoot,input.members.vault.manifestSha256),entry=authority.manifest.baseline.find(row=>row.domain==='unified');
  if(!entry)throw Error('Reset retirement requires the original baseline journal');
  if(!authority.ledgers.unified.subarray(0,input.nativeJournal.bytes.length).equals(input.nativeJournal.bytes))throw Error('Reset retirement native journal has unrecorded bytes');
  const file=privateFile(join(input.members.vault.authorityRoot,entry.path),64*1024*1024);
  if(!file.bytes||file.sha256!==entry.sha256||forwardHash(JSON.stringify(decodeErasureJournal(file.bytes.toString())))!==authority.manifest.journalSha256)throw Error('Reset retirement baseline journal binding differs');
  const journal=pin(file.bytes),baselineInput:ResetMemberRetirementInput={...input,nativeImage:{bytes:Buffer.from(input.checkpoint.bytes),sha256:input.checkpoint.sha256},nativeJournal:journal};
  return {journal,baselineInput,guard(){file.assertUnchanged();authority.assertUnchanged();}};
}
function expectedIdentity(input:ResetMemberRetirementInput,native:ResetMemberRetirementBundle,original:DB){
  const retired=new Set(native.retained.dispositions.map(row=>row.key)),db=new Database(native.nativeImage);
  try{
    const markers=new Map(readMusicRetirements(db).map(row=>[row.legacyKey,row])),contacts=[...forwardRows(original,'profile_contacts')];let high=contacts.reduce((n,row)=>n>row.__forward_rowid__?n:row.__forward_rowid__,0n);
    for(const key of [...retired].sort()){
      const marker=markers.get(key),contact=marker?db.prepare('SELECT contact_qq,updated_at FROM music_profile_contacts WHERE profile_id=?').get(marker.profileId) as {contact_qq:string;updated_at:string}|undefined:undefined;
      const previous=contacts.find(row=>row.qq===key),number=contact?.contact_qq??(/^\d{4,12}$/.test(key)?key:undefined);
      if(number===undefined)continue;
      if(previous){if(previous.number!==number)throw Error('Retired contact reservation differs from the original identity; retain both sources');continue;}
      if(high===9223372036854775807n)throw Error('Retired contact rowid capacity exhausted');
      contacts.push({__forward_rowid__:++high,qq:key,number,updated:identitySeconds(contact?.updated_at??input.retiredAt),__forward_type_0:'text',__forward_type_1:'text',__forward_type_2:'real'});
    }
    const tables=schemaObjects(original).filter(row=>row.type==='table'&&!row.name.startsWith('sqlite_')).map(row=>row.name),rows:Record<string,ForwardRow[]>={};
    for(const table of tables)rows[table]=table==='profile_contacts'?contacts:[...forwardRows(original,table)].filter(row=>!inactiveTables.has(table)||!retired.has(String(row.qq)));
    return {retiredKeys:[...retired].sort(),rows};
  }finally{db.close();}
}
function sourceReport(input:ResetMemberRetirementInput,native:ResetMemberRetirementBundle,baseline:ResetMemberRetirementBundle,journal:PinnedForwardBytes,identity:PinnedForwardBytes,keys:string[]){
  return {version:1 as const,originalIdentitySha256:input.members.identity.sha256,originalNativeSha256:input.nativeImage.sha256,checkpointSha256:input.checkpoint.sha256,baselineJournalSha256:journal.sha256,
    nativeRetirementSha256:forwardHash(native.nativeImage),baselineRetirementSha256:forwardHash(baseline.nativeImage),derivedIdentitySha256:identity.sha256,retiredKeys:keys,
    baselineAndNativeCheckedSeparately:true as const,allOriginalIdentityRowsVerified:true as const,inactiveContactReservationsPreserved:true as const,originalSourcesRetained:true as const,
    globalResetProjected:false as const,businessProofAndRebasePrepared:false as const,recoveryRequired:true as const,releaseEligible:false as const};
}
/** Prepare only the common retired baseline, independent native fork and old
 * identity source. Original images remain in each retirement bundle. No global
 * reset, business merge, proof rebase, file write or service activation occurs. */
export function prepareForwardResetRetirementSources(input:ResetMemberRetirementInput,boundary?:()=>void){
  // The actual native fork is checked before any reset projection changes it.
  const native=projectForwardResetMemberRetirements(input,boundary),source=baselineSource(input),baseline=projectForwardResetMemberRetirements(source.baselineInput,boundary),original=new Database(input.members.identity.bytes),copy=new Database(input.members.identity.bytes);
  try{
    assertForwardIdentity(original);const expected=expectedIdentity(input,native,original);copy.transaction(()=>{
      for(const table of inactiveTables)for(const key of expected.retiredKeys)copy.prepare('DELETE FROM '+table+' WHERE qq=?').run(key);
      const before=new Set([...forwardRows(original,'profile_contacts')].map(row=>String(row.qq)));
      for(const row of expected.rows.profile_contacts!)if(!before.has(String(row.qq)))copy.prepare('INSERT INTO profile_contacts(rowid,qq,number,updated) VALUES(?,?,?,?)').run(row.__forward_rowid__,row.qq,row.number,row.updated);
    }).immediate();
    const identity=pin(copy.serialize()),bundle={native,baseline,baselineJournal:source.journal,identity,report:sourceReport(input,native,baseline,source.journal,identity,expected.retiredKeys)};
    verifyForwardResetRetirementSources(input,bundle,boundary);source.guard();return bundle;
  }finally{copy.close();original.close();}
}
export type ResetRetirementSourcesBundle=ReturnType<typeof prepareForwardResetRetirementSources>;
/** Independently derives every permitted identity row deletion and reservation;
 * does not rerun any retirement or identity writer. Preserved audit, scalar
 * storage, rowids and sequences are checked against the entire original image. */
export function verifyForwardResetRetirementSources(input:ResetMemberRetirementInput,bundle:ResetRetirementSourcesBundle,boundary?:()=>void){
  const retirementPin=(value:ResetMemberRetirementBundle)=>[forwardHash(value.nativeImage),forwardHash(value.nativeJournal),forwardHash(value.retainedNativeImage),value.report,forwardHash(JSON.stringify(value.retained))];
  const fingerprint=()=>JSON.stringify([retirementPin(bundle.native),retirementPin(bundle.baseline),bundle.baselineJournal.sha256,forwardHash(bundle.baselineJournal.bytes),bundle.identity.sha256,forwardHash(bundle.identity.bytes),bundle.report]);
  const sourcePin=()=>JSON.stringify([input.members.vault,input.retiredAt,...[input.members.music,input.members.identity,input.checkpoint,input.nativeImage,input.nativeJournal].map(row=>[row.sha256,forwardHash(row.bytes)])]),before=fingerprint(),originalPin=sourcePin(),source=baselineSource(input);
  const guard=()=>{const value:unknown=boundary?.();if(value!==null&&(typeof value==='object'||typeof value==='function')&&'then' in value)throw Error('Reset retirement source boundary must be synchronous');if(fingerprint()!==before)throw Error('Reset retirement source output changed');if(sourcePin()!==originalPin)throw Error('Reset retirement original source changed');source.guard();};
  guard();verifyForwardResetMemberRetirements(input,bundle.native,guard);verifyForwardResetMemberRetirements(source.baselineInput,bundle.baseline,guard);
  if(!bundle.baselineJournal.bytes.equals(source.journal.bytes)||bundle.baselineJournal.sha256!==source.journal.sha256||forwardHash(bundle.identity.bytes)!==bundle.identity.sha256)throw Error('Reset retirement derived source pin differs');
  assertForwardImage(bundle.identity.bytes);const original=new Database(input.members.identity.bytes),copy=new Database(bundle.identity.bytes);
  try{
    assertForwardIdentity(original);assertForwardIdentity(copy);const expected=expectedIdentity(input,bundle.native,original);
    if(!forwardEqual(schemaObjects(original),schemaObjects(copy))||!forwardEqual(forwardSequences(original),forwardSequences(copy))||copy.pragma('integrity_check',{simple:true})!=='ok'||(copy.pragma('foreign_key_check') as unknown[]).length)throw Error('Retired identity schema or sequences differ');
    for(const name of ['encoding','user_version','application_id'])if(original.pragma(name,{simple:true})!==copy.pragma(name,{simple:true}))throw Error('Retired identity metadata differs');
    for(const [table,rows] of Object.entries(expected.rows))if(!forwardEqual([...forwardRows(copy,table)],rows))throw Error('Retired identity original row relation differs: '+table);
    if(!forwardEqual(bundle.report,sourceReport(input,bundle.native,bundle.baseline,source.journal,bundle.identity,expected.retiredKeys)))throw Error('Reset retirement source report differs');guard();
    return {allOriginalIdentityRowsVerified:true as const,baselineAndNativeCheckedSeparately:true as const,releaseEligible:false as const};
  }finally{copy.close();original.close();}
}
