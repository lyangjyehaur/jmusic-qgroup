import type {DB} from '@qgroup/database';
import {forwardCanonical,forwardEqual,forwardRows,type ForwardRow} from './forward-board-storage';

/** Protect the private rows which a replay would remove or overwrite. An
 * ID-only tombstone cannot prove that its current children are the original
 * generation. This is read-only and does not establish complete ancestry. */
export function assertNativeResetProfileBoundary(before:DB,completed:DB,current:DB,profileIds:string[]){
  if(!profileIds.length)return;
  const profiles=new Set(profileIds),keys=new Set<string>(),reject=():never=>{throw Error('Native reset original profile relationship changed; generation evidence required');};
  for(const id of profiles)for(const row of before.prepare("SELECT legacy_key FROM music_legacy_profiles WHERE profile_id=? UNION SELECT source_id AS legacy_key FROM migration_map WHERE source='music' AND entity_type='profile' AND target_id=?").all(id,id) as {legacy_key:string}[])keys.add(row.legacy_key);
  const creator=(value:unknown)=>typeof value==='string'&&(profiles.has(value)||keys.has(value));
  const extract=before.prepare('SELECT json_extract(?,?) AS value').safeIntegers(true),value=(payload:unknown,path:string)=>(extract.get(payload,path) as {value:unknown}).value;
  const primary=(table:string)=>{
    const columns=(before.prepare(`PRAGMA table_xinfo("${table}")`).all() as {name:string;pk:number}[]).filter(r=>r.pk).sort((a,b)=>a.pk-b.pk).map(r=>r.name);
    if(!columns.length)throw Error('Native reset relationship primary key missing');
    return (row:ForwardRow)=>forwardCanonical(columns.map(column=>row[column]));
  };
  const exact=(table:string,inScope:(row:ForwardRow)=>boolean,allowCompleted=false)=>{
    const slot=primary(table),original=new Map([...forwardRows(before,table)].filter(inScope).map(r=>[slot(r),r])),finished=allowCompleted?new Map([...forwardRows(completed,table)].filter(inScope).map(r=>[slot(r),r])):null;
    for(const row of forwardRows(current,table))if(inScope(row)&&!forwardEqual(row,original.get(slot(row)))&&!forwardEqual(row,finished?.get(slot(row))))reject();
  };
  const profileRow=(row:ForwardRow)=>profiles.has(String(row.profile_id));
  for(const table of ['music_profile_creation','music_legacy_profiles','music_profile_contacts','music_contact_history','music_ownership_history','music_pin_history','music_field_history','music_profile_fields','music_profile_audit','music_claim_intents','music_selections','music_entry_creations','music_shout_authors'])exact(table,profileRow);

  const attempts=new Set([...forwardRows(before,'music_claim_intents')].filter(profileRow).flatMap(r=>typeof r.attempt_id==='string'?[r.attempt_id]:[]));
  exact('login_attempts',r=>attempts.has(String(r.id)),true);
  const responseKey=(r:ForwardRow)=>forwardCanonical([r.user_id,r.request_key]),responses=new Set([...forwardRows(before,'music_profile_receipts')].filter(profileRow).map(responseKey));
  // Saved-operation keys remain bound to their original profile even when a
  // forged receipt now points elsewhere and would evade a profile-only scan.
  exact('music_profile_receipts',r=>profileRow(r)||responses.has(responseKey(r)));
  exact('request_results',r=>responses.has(responseKey(r)),true);

  exact('music_legacy_identity',r=>keys.has(value(r.payload_json,'$.qq') as string));
  const shoutRow=(r:ForwardRow)=>profileRow(r)||keys.has(String(r.legacy_key));
  exact('music_shouts',shoutRow);
  const shoutIds=new Set([...forwardRows(current,'music_shouts')].filter(shoutRow).map(r=>String(r.id)));
  const documentScope=(r:ForwardRow)=>r.kind==='profile_source'&&(profiles.has(value(r.payload_json,'$.profileId') as string)||keys.has(value(r.payload_json,'$.legacyKey') as string))||r.kind==='profile_retirement'&&profiles.has(value(r.payload_json,'$.profileId') as string)||r.kind==='entry_source'&&creator(value(r.payload_json,'$.entry.createdBy'))||['shouts','shoutHistory'].includes(String(r.kind))&&(keys.has(value(r.payload_json,'$.qq') as string)||shoutIds.has(value(r.payload_json,'$.id') as string));
  exact('music_documents',documentScope);
  exact('music_entry_details',r=>creator(r.created_by));

  // Identity source IDs are decimal row numbers only for those original slots.
  // Unrelated opaque source IDs are not parsed or treated as scoped evidence.
  const identityMaps=new Set([...forwardRows(before,'music_legacy_identity')].filter(r=>keys.has(value(r.payload_json,'$.qq') as string)).map(r=>forwardCanonical([r.table_name,String(r.row_number)])));
  const mappingScope=(r:ForwardRow)=>r.source==='music'&&r.entity_type==='profile'&&(profiles.has(String(r.target_id))||keys.has(String(r.source_id)))||r.source==='music-identity'&&identityMaps.has(forwardCanonical([r.entity_type,r.source_id]));
  const mappingSlot=primary('migration_map'),mappings=new Map([...forwardRows(before,'migration_map')].filter(mappingScope).map(r=>[mappingSlot(r),r]));
  for(const row of forwardRows(current,'migration_map'))if(mappingScope(row)){
    const original=mappings.get(mappingSlot(row))??reject();
    if(!new Set([original.status,'erased','erasure_redacted']).has(row.status)||!forwardEqual(row,{...original,status:row.status}))reject();
  }
}
