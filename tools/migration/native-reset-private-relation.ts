import type {DB} from '@qgroup/database';
import type {ErasureIntent} from '../../apps/api/src/erasure-journal';
import {forwardRows,type ForwardRow} from './forward-board-storage';

type Reset=Extract<ErasureIntent,{version:2}>;
/** Read-only pre/completion oracle. No erasure, ownership, claim or catalog
 * writer is imported. Scope comes only from the already verified original
 * intent and before image; opaque JSON is transformed by read-only SQLite. */
export function nativeResetPrivateRelation(before:DB,intent:Reset){
  const profiles=new Set(intent.profiles.map(p=>p.id)),entries=new Set(intent.entries),keys=new Set<string>(),owners=new Map<string,bigint>();
  for(const profile of intent.profiles){
    if(profile.userId&&before.prepare('SELECT 1 FROM users WHERE id=?').get(profile.userId))owners.set(profile.userId,(owners.get(profile.userId)??0n)+1n);
    for(const row of before.prepare("SELECT legacy_key FROM music_legacy_profiles WHERE profile_id=? UNION SELECT source_id AS legacy_key FROM migration_map WHERE source='music' AND entity_type='profile' AND target_id=?").all(profile.id,profile.id) as {legacy_key:string}[])keys.add(row.legacy_key);
  }
  const attempts=new Set<string>();
  for(const row of before.prepare('SELECT profile_id,target_user_id,attempt_id FROM music_claim_intents').all() as {profile_id:string;target_user_id:string|null;attempt_id:string|null}[]){
    if((profiles.has(row.profile_id)||row.target_user_id!==null&&owners.has(row.target_user_id))&&row.attempt_id)attempts.add(row.attempt_id);
  }
  const responses=new Set([...forwardRows(before,'music_profile_receipts')].filter(r=>profiles.has(String(r.profile_id))).map(r=>JSON.stringify([r.user_id,r.request_key])));
  const extract=before.prepare('SELECT json_extract(?,?) AS value').safeIntegers(true);
  const jsonValue=(payload:unknown,path:string)=>extract.get(payload,path) as {value:unknown};
  const redacted=before.prepare("SELECT json_set(?,'$.entry.createdBy','') AS value");
  const identity=new Set([...forwardRows(before,'music_legacy_identity')].filter(r=>keys.has(jsonValue(r.payload_json,'$.qq').value as string)).map(r=>JSON.stringify([r.table_name,String(r.row_number)])));
  const columns=new Map<string,string[]>();
  const replace=(table:string,row:ForwardRow,values:Record<string,unknown>):ForwardRow=>{
    let cols=columns.get(table);if(!cols){cols=(before.prepare(`PRAGMA table_xinfo("${table}")`).all() as {name:string}[]).map(r=>r.name);columns.set(table,cols);}
    const result={...row};for(const [name,value] of Object.entries(values)){
      const index=cols.indexOf(name);if(index<0)throw Error('Unknown reset relation column');result[name]=value;
      result['__forward_type_'+index]=value===null?'null':typeof value==='bigint'?'integer':typeof value==='number'?'real':'text';
    }return result;
  };
  const erasedResponse='{"code":"PROFILE_ERASED","message":"這份成分已刪除，原保存操作不會重建資料"}';
  const privateTables=new Set(['music_profile_creation','music_legacy_profiles','music_profile_contacts','music_contact_history','music_ownership_history','music_pin_history','music_field_history','music_profile_fields','music_profile_audit']);
  const row=(table:string,r:ForwardRow):ForwardRow|null=>{
    if(table==='music_profiles'&&profiles.has(String(r.id)))return replace(table,r,{user_id:null,erased_at:intent.createdAt});
    if(privateTables.has(table)&&profiles.has(String(r.profile_id)))return null;
    if(table==='music_claim_intents'&&(profiles.has(String(r.profile_id))||r.target_user_id!==null&&owners.has(String(r.target_user_id))))return null;
    if(table==='login_attempts'&&attempts.has(String(r.id))&&['pending','exchanging','verified'].includes(String(r.status)))return replace(table,r,{status:'failed',union_id:''});
    if(table==='request_results'&&responses.has(JSON.stringify([r.user_id,r.request_key])))return replace(table,r,{response_status:410n,response_json:erasedResponse});
    if(table==='music_account_epochs'&&owners.has(String(r.user_id))){
      const value=(before.prepare('SELECT ? + ? AS value,typeof(? + ?) AS storage').safeIntegers(true).get(r.epoch,owners.get(String(r.user_id)),r.epoch,owners.get(String(r.user_id))) as {value:unknown;storage:string});
      const result=replace(table,r,{epoch:value.value});result['__forward_type_1']=value.storage;return result;
    }
    if(table==='music_legacy_identity'&&identity.has(JSON.stringify([r.table_name,String(r.row_number)])))return null;
    if(table==='music_legacy_erasures'&&keys.has(String(r.legacy_key)))return replace(table,r,{erased_at_json:JSON.stringify(intent.createdAt)});
    if(table==='music_selections'&&(profiles.has(String(r.profile_id))||entries.has(String(r.entry_id))))return null;
    if(table==='music_entry_creations'&&(profiles.has(String(r.profile_id))||entries.has(String(r.entry_id))))return null;
    if(table==='music_entries'&&entries.has(String(r.id))||table==='music_entry_details'&&entries.has(String(r.entry_id)))return null;
    if(table==='music_documents'){
      if(r.kind==='profile_source'&&(profiles.has(jsonValue(r.payload_json,'$.profileId').value as string)||keys.has(jsonValue(r.payload_json,'$.legacyKey').value as string)))return null;
      if(r.kind==='profile_retirement'&&profiles.has(jsonValue(r.payload_json,'$.profileId').value as string))return null;
      if(r.kind==='entry_source'){
        if(entries.has(jsonValue(r.payload_json,'$.entryId').value as string))return null;
        const creator=jsonValue(r.payload_json,'$.entry.createdBy').value;
        if(profiles.has(creator as string)||keys.has(creator as string))return replace(table,r,{payload_json:(redacted.get(r.payload_json) as {value:string}).value});
      }
    }
    if(table==='migration_map'){
      if(r.source==='music'&&r.entity_type==='profile'&&keys.has(String(r.source_id)))return replace(table,r,{status:'erased'});
      if(r.source==='music-identity'&&identity.has(JSON.stringify([r.entity_type,String(r.source_id)])))return replace(table,r,{status:'erased'});
      if(r.source==='music'&&r.entity_type==='entry'&&entries.has(String(r.target_id)))return replace(table,r,{status:'deleted'});
    }
    return r;
  };
  const additions=new Map<string,{rowid:bigint;values:Record<string,unknown>}[]>();
  for(const [table,ordered,column] of [['music_account_epochs',[...owners.keys()],'user_id'],['music_legacy_erasures',[...keys],'legacy_key']] as const){
    const existing=[...forwardRows(before,table)],seen=new Set(existing.map(r=>String(r[column])));let high=existing.reduce((n,r)=>r.__forward_rowid__>n?r.__forward_rowid__:n,0n);
    additions.set(table,ordered.filter(key=>!seen.has(key)).map(key=>({rowid:++high,values:table==='music_account_epochs'?{user_id:key,epoch:owners.get(key)}:{legacy_key:key,erased_at_json:JSON.stringify(intent.createdAt)}})));
  }
  return {row,additions};
}
