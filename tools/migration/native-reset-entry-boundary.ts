import type {DB} from '@qgroup/database';
import {forwardEqual,forwardRows,type ForwardRow} from './forward-board-storage';

/** Exact original relationships for restored reset IDs. Matching parent bytes
 * cannot authorize deletion of later selections, creation or source evidence.
 * Identical complete graphs still require external generation custody. */
export function assertNativeResetEntryBoundary(before:DB,current:DB,profileIds:string[],entryIds:string[]){
  if(!entryIds.length)return;
  const ids=new Set(entryIds),creators=new Set(profileIds),reject=():never=>{throw Error('Native reset original entry relationship changed; generation evidence required');};
  for(const id of profileIds)for(const row of before.prepare("SELECT legacy_key FROM music_legacy_profiles WHERE profile_id=? UNION SELECT source_id AS legacy_key FROM migration_map WHERE source='music' AND entity_type='profile' AND target_id=?").all(id,id) as {legacy_key:string}[])creators.add(row.legacy_key);
  const details=new Map([...forwardRows(before,'music_entry_details')].filter(r=>ids.has(String(r.entry_id))).map(r=>[String(r.entry_id),r]));
  for(const row of forwardRows(current,'music_entry_details'))if(ids.has(String(row.entry_id))){
    const original=details.get(String(row.entry_id))??reject();
    if(forwardEqual(row,original))continue;
    if(!creators.has(String(original.created_by))||!forwardEqual(row,{...original,created_by:''}))reject();
  }
  const relationship=(row:ForwardRow)=>JSON.stringify([row.profile_id,row.entry_id]);
  for(const table of ['music_selections','music_entry_creations']){
    const original=new Map([...forwardRows(before,table)].filter(r=>ids.has(String(r.entry_id))).map(r=>[relationship(r),r]));
    for(const row of forwardRows(current,table))if(ids.has(String(row.entry_id))&&!forwardEqual(row,original.get(relationship(row))))reject();
  }
  const extract=before.prepare('SELECT json_extract(?,?) AS value').safeIntegers(true),value=(payload:unknown,path:string)=>(extract.get(payload,path) as {value:unknown}).value;
  const redacted=before.prepare("SELECT json_set(?,'$.entry.createdBy','') AS value");
  const documentSlot=(row:ForwardRow)=>JSON.stringify([row.kind,String(row.position)]),documents=new Map([...forwardRows(before,'music_documents')].filter(r=>r.kind==='entry_source'&&ids.has(value(r.payload_json,'$.entryId') as string)).map(r=>[documentSlot(r),r]));
  for(const row of forwardRows(current,'music_documents'))if(row.kind==='entry_source'&&ids.has(value(row.payload_json,'$.entryId') as string)){
    const original=documents.get(documentSlot(row))??reject();
    if(forwardEqual(row,original))continue;
    const creator=value(original.payload_json,'$.entry.createdBy');
    if(!creators.has(creator as string)||!forwardEqual(row,{...original,payload_json:(redacted.get(original.payload_json) as {value:string}).value}))reject();
  }
  const mapped=(row:ForwardRow)=>row.source==='music'&&row.entity_type==='entry'&&ids.has(String(row.target_id)),mappingSlot=(row:ForwardRow)=>JSON.stringify([row.source,row.entity_type,row.source_id]);
  const mappings=new Map([...forwardRows(before,'migration_map')].filter(mapped).map(r=>[mappingSlot(r),r]));
  for(const row of forwardRows(current,'migration_map'))if(mapped(row)){
    const original=mappings.get(mappingSlot(row))??reject();
    const allowed=new Set([original.status,'deleted']);
    const creator=details.get(String(original.target_id))?.created_by;if(creator!==undefined&&creators.has(String(creator)))allowed.add('erasure_redacted');
    if(!allowed.has(row.status)||!forwardEqual(row,{...original,status:row.status}))reject();
  }
}
