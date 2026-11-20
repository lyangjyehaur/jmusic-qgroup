import type {DB} from '@qgroup/database';
import {z} from 'zod';
import {readVerifiedErasureJournal,type ErasureJournal} from '../../apps/api/src/erasure-journal';
import {schemaObjects} from './board-reconciliation';
import {assertRollbackSource} from './rollback-source';
import {nativeOwnerEpochs} from './native-reset-candidate-boundary';
import {forwardCanonical,forwardEqual,forwardHash,forwardRows,forwardSequences,type ForwardRow} from './forward-board-storage';

/** Legacy overrides come from the already pinned authority/baseline relation,
 * never from the repair report. Their external ancestry remains a separate gate. */
export type MusicRepairContext={authoritySha256:string;headRecordSha256:string|null;legacyScopes:{legacyKey:string;profileId:string;stamp:string;originalTimeJson:string}[]};
const reject=():never=>{throw Error('Native music repair reconciliation failed; retain all original images');};

/** Complete private-replay row oracle. No privacy, ownership or erasure writer
 * is imported. The source must be a committed, owned in-memory snapshot taken
 * after the separately verified account repair and before music repair. */
export function reconcileAppliedMusicRepair(source:DB,candidate:DB,journal:ErasureJournal,context:MusicRepairContext){
  if(source.name!==':memory:'||source.inTransaction||candidate.name!==':memory:')reject();
  source.transaction(()=>assertRollbackSource(source)).immediate();
  if(candidate.inTransaction)assertRollbackSource(candidate);else candidate.transaction(()=>assertRollbackSource(candidate)).immediate();
  if(!forwardEqual(schemaObjects(source),schemaObjects(candidate)))reject();
  for(const name of ['user_version','application_id','encoding'])if(!forwardEqual(source.pragma(name,{simple:true}),candidate.pragma(name,{simple:true})))reject();
  if(!/^[a-f0-9]{64}$/.test(context.authoritySha256)||context.headRecordSha256!==null&&!/^[a-f0-9]{64}$/.test(context.headRecordSha256))reject();
  const native=new Map<string,string>();
  for(const intent of readVerifiedErasureJournal(source,journal)){
    if('user_id' in intent)continue;
    if(intent.version===1){if(intent.kind!=='account'&&intent.profileId)native.set(intent.profileId,intent.createdAt);}
    else if(intent.version===2)for(const profile of intent.profiles)native.set(profile.id,intent.createdAt);
    else native.set(intent.profileId,intent.createdAt);
  }
  const legacyKeys=new Set<string>(),legacyProfiles=new Set<string>();
  for(const scope of context.legacyScopes){
    if(!scope.legacyKey||!scope.profileId||legacyKeys.has(scope.legacyKey)||legacyProfiles.has(scope.profileId)||!z.iso.datetime().safeParse(scope.stamp).success)reject();
    if((source.prepare('SELECT json_valid(?) AS valid').get(scope.originalTimeJson) as {valid:number}).valid!==1)reject();legacyKeys.add(scope.legacyKey);legacyProfiles.add(scope.profileId);
    const binding=source.prepare("SELECT target_id FROM migration_map WHERE source='music' AND entity_type='profile' AND source_id=?").get(scope.legacyKey) as {target_id:string}|undefined;
    if(binding&&binding.target_id!==scope.profileId)reject();
  }
  const operations=[...[...native].filter(([id])=>!legacyProfiles.has(id)).map(([profileId,stamp])=>({profileId,stamp,legacyKey:null as string|null,originalTimeJson:null as string|null})),...context.legacyScopes];
  const profiles=new Map(operations.map(row=>[row.profileId,row.stamp])),keys=new Map<string,string>(),owners=new Map<string,bigint>(),legacyTimes=new Map<string,string>();
  const aliases=source.prepare("SELECT legacy_key FROM music_legacy_profiles WHERE profile_id=? UNION SELECT source_id AS legacy_key FROM migration_map WHERE source='music' AND entity_type='profile' AND target_id=? UNION SELECT ? WHERE ? IS NOT NULL");
  for(const operation of operations){
    const profile=source.prepare('SELECT user_id FROM music_profiles WHERE id=?').get(operation.profileId) as {user_id:string|null}|undefined;
    if(profile?.user_id&&source.prepare('SELECT 1 FROM users WHERE id=?').get(profile.user_id))owners.set(profile.user_id,(owners.get(profile.user_id)??0n)+1n);
    for(const row of aliases.all(operation.profileId,operation.profileId,operation.legacyKey,operation.legacyKey) as {legacy_key:string}[]){
      if(keys.has(row.legacy_key)&&keys.get(row.legacy_key)!==operation.profileId)reject();
      keys.set(row.legacy_key,operation.profileId);legacyTimes.set(row.legacy_key,JSON.stringify(operation.stamp));
    }
    if(operation.legacyKey!==null)legacyTimes.set(operation.legacyKey,operation.originalTimeJson!);
  }
  const epochs=nativeOwnerEpochs(source);nativeOwnerEpochs(candidate);
  const extract=source.prepare('SELECT json_extract(?,?) AS value').safeIntegers(true),json=(payload:unknown,path:string)=>(extract.get(payload,path) as {value:unknown}).value;
  const creator=(value:unknown)=>typeof value==='string'&&(profiles.has(value)||keys.has(value));
  const profileRow=(row:ForwardRow)=>profiles.has(String(row.profile_id));
  const claims=[...forwardRows(source,'music_claim_intents')],doomedClaim=(r:ForwardRow)=>profileRow(r)||r.target_user_id!==null&&owners.has(String(r.target_user_id)),attempts=new Set(claims.filter(doomedClaim).flatMap(r=>typeof r.attempt_id==='string'?[r.attempt_id]:[]));
  const responseKey=(r:ForwardRow)=>forwardCanonical([r.user_id,r.request_key]),responses=new Set([...forwardRows(source,'music_profile_receipts')].filter(profileRow).map(responseKey));
  const identitySlots=new Set([...forwardRows(source,'music_legacy_identity')].filter(r=>keys.has(json(r.payload_json,'$.qq') as string)).map(r=>forwardCanonical([r.table_name,String(r.row_number)])));
  const shoutIds=new Set([...forwardRows(source,'music_shouts')].filter(profileRow).map(r=>String(r.id)));
  const creatorEntries=new Set([...forwardRows(source,'music_entry_details')].filter(r=>creator(r.created_by)).map(r=>String(r.entry_id)));
  const shoutSlots=new Set([...forwardRows(source,'music_documents')].filter(r=>['shouts','shoutHistory'].includes(String(r.kind))&&(keys.has(json(r.payload_json,'$.qq') as string)||shoutIds.has(json(r.payload_json,'$.id') as string))).map(r=>forwardCanonical([r.kind,String(r.position)])));
  const privateTables=new Set(['music_profile_creation','music_legacy_profiles','music_profile_contacts','music_contact_history','music_ownership_history','music_pin_history','music_field_history','music_profile_fields','music_profile_audit','music_selections','music_entry_creations','music_shout_authors']);
  const metadata=new Map<string,string[]>(),columns=(table:string)=>{
    let names=metadata.get(table);if(!names){names=(source.prepare(`PRAGMA table_xinfo("${table}")`).all() as {name:string}[]).map(r=>r.name);metadata.set(table,names);}return names;
  };
  const replace=(table:string,row:ForwardRow,values:Record<string,unknown>)=>{
    const result={...row};for(const [name,value] of Object.entries(values)){const index=columns(table).indexOf(name);if(index<0)reject();result[name]=value;result['__forward_type_'+index]=value===null?'null':typeof value==='bigint'?'integer':typeof value==='number'?'real':'text';}return result;
  };
  const redaction=source.prepare("SELECT json_set(?,'$.entry.createdBy','') AS value"),erasedResponse='{"code":"PROFILE_ERASED","message":"這份成分已刪除，原保存操作不會重建資料"}';
  const expected=(table:string,row:ForwardRow):ForwardRow|null=>{
    if(table==='music_profiles'&&profiles.has(String(row.id)))return replace(table,row,{user_id:null,erased_at:profiles.get(String(row.id))});
    if(privateTables.has(table)&&profileRow(row)||table==='music_claim_intents'&&doomedClaim(row)||table==='music_shouts'&&profileRow(row))return null;
    if(table==='login_attempts'&&attempts.has(String(row.id))&&['pending','exchanging','verified'].includes(String(row.status)))return replace(table,row,{status:'failed',union_id:''});
    if(table==='request_results'&&responses.has(responseKey(row)))return replace(table,row,{response_status:410n,response_json:erasedResponse});
    if(table==='music_account_epochs'&&owners.has(String(row.user_id))){const epoch=epochs.get(String(row.user_id))!+owners.get(String(row.user_id))!;if(epoch>9223372036854775807n)reject();return replace(table,row,{epoch});}
    if(table==='music_legacy_identity'&&keys.has(json(row.payload_json,'$.qq') as string))return null;
    if(table==='music_legacy_erasures'&&legacyTimes.has(String(row.legacy_key)))return replace(table,row,{erased_at_json:legacyTimes.get(String(row.legacy_key))});
    if(table==='music_entry_details'&&creator(row.created_by))return replace(table,row,{created_by:''});
    if(table==='music_documents'){
      if(row.kind==='profile_source'&&(profiles.has(json(row.payload_json,'$.profileId') as string)||keys.has(json(row.payload_json,'$.legacyKey') as string))||row.kind==='profile_retirement'&&profiles.has(json(row.payload_json,'$.profileId') as string)||['shouts','shoutHistory'].includes(String(row.kind))&&shoutSlots.has(forwardCanonical([row.kind,String(row.position)])))return null;
      if(row.kind==='entry_source'&&creator(json(row.payload_json,'$.entry.createdBy')))return replace(table,row,{payload_json:(redaction.get(row.payload_json) as {value:string}).value});
    }
    if(table==='migration_map'){
      if(row.source==='music'&&row.entity_type==='profile'&&keys.has(String(row.source_id))||row.source==='music-identity'&&identitySlots.has(forwardCanonical([row.entity_type,row.source_id]))||row.source==='music'&&shoutSlots.has(forwardCanonical([row.entity_type,row.source_id])))return replace(table,row,{status:'erased'});
      if(row.source==='music'&&row.entity_type==='entry'&&creatorEntries.has(String(row.target_id)))return replace(table,row,{status:'erasure_redacted'});
    }
    return row;
  };
  const additions=new Map<string,ForwardRow[]>(),append=(table:string,values:Record<string,unknown>)=>{
    let rows=additions.get(table);if(!rows){rows=[];additions.set(table,rows);}
    let high=rows.at(-1)?.__forward_rowid__;
    if(high===undefined){const maximum=source.prepare(`SELECT max(rowid) AS value FROM "${table}"`).safeIntegers(true).get() as {value:bigint|null};high=maximum.value??0n;}
    if(high>=9223372036854775807n)reject();
    const row:ForwardRow={__forward_rowid__:high+1n};
    for(const name of columns(table)){if(!(name in values))reject();row[name]=values[name];}
    for(const [index,name] of columns(table).entries()){const value=values[name];row['__forward_type_'+index]=value===null?'null':typeof value==='bigint'?'integer':typeof value==='number'?'real':'text';}
    rows.push(row);
  };
  for(const operation of operations)if(!source.prepare('SELECT 1 FROM music_profiles WHERE id=?').get(operation.profileId))append('music_profiles',{id:operation.profileId,user_id:null,revision:0n,updated_at:operation.stamp,erased_at:operation.stamp});
  for(const [owner,count] of owners)if(!epochs.has(owner))append('music_account_epochs',{user_id:owner,epoch:count});
  for(const [key,time] of legacyTimes)if(!source.prepare('SELECT 1 FROM music_legacy_erasures WHERE legacy_key=?').get(key))append('music_legacy_erasures',{legacy_key:key,erased_at_json:time});
  for(const scope of context.legacyScopes)if(!source.prepare("SELECT 1 FROM migration_map WHERE source='music' AND entity_type='profile' AND source_id=?").get(scope.legacyKey))append('migration_map',{source:'music',entity_type:'profile',source_id:scope.legacyKey,target_id:scope.profileId,source_revision:'',payload_digest:forwardHash(JSON.stringify({authority:context.authoritySha256,head:context.headRecordSha256,key:scope.legacyKey,profileId:scope.profileId})),status:'erased'});
  let removedRows=0,changedRows=0,retainedRows=0,addedRows=0;
  for(const table of schemaObjects(source).filter(r=>r.type==='table').map(r=>r.name)){
    const actual=forwardRows(candidate,table);
    try{
      for(const row of forwardRows(source,table)){const wanted=expected(table,row);if(!wanted){removedRows++;continue;}const next=actual.next();if(next.done||!forwardEqual(wanted,next.value))reject();if(forwardEqual(wanted,row))retainedRows++;else changedRows++;}
      for(const row of additions.get(table)??[]){const next=actual.next();if(next.done||!forwardEqual(row,next.value))reject();addedRows++;}
      if(!actual.next().done)reject();
    }finally{actual.return?.();}
  }
  forwardSequences(source);forwardSequences(candidate);
  if(!forwardEqual([...forwardRows(source,'sqlite_sequence')],[...forwardRows(candidate,'sqlite_sequence')]))reject();
  readVerifiedErasureJournal(candidate,journal);
  return {profileScopes:profiles.size,legacyScopes:context.legacyScopes.length,removedRows,changedRows,retainedRows,addedRows,allRowsVerified:true as const,oracleUsesServiceWriter:false as const,externalLegacyScopeIndependentlyDerived:false as const,allResetGenerationsReconciled:false as const,releaseEligible:false as const};
}
