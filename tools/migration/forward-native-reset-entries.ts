import type {DB} from '@qgroup/database';
import {AdminMusicErasureResult} from '@qgroup/contracts';
import {readVerifiedErasureJournal,type ErasureJournal} from '../../apps/api/src/erasure-journal';
import {schemaObjects} from './board-reconciliation';
import {assertRollbackSource} from './rollback-source';
import {forwardEqual,forwardRows,forwardSequences} from './forward-board-storage';

/** Only the entry IDs in original, applied native reset intents. This does not
 * infer legacy reset generations or the scope of global shout/trend clearing. */
function originalScope(db:DB,journal:ErasureJournal){
  const ids=new Set<string>(),requests=new Set<string>();
  for(const entry of readVerifiedErasureJournal(db,journal)){
    if(!('version' in entry)||entry.version!==2||entry.command!=='reset_music')continue;
    const row=db.prepare('SELECT result_json FROM privacy_receipts WHERE request_id=?').get(entry.requestId) as {result_json:string};
    const receipt=AdminMusicErasureResult.parse(JSON.parse(row.result_json));
    if(receipt.requestId!==entry.requestId||receipt.command!==entry.command||receipt.profiles!==entry.profiles.length||receipt.entries!==entry.entries.length||receipt.status!=='completed')throw Error('Native reset receipt scope differs');
    requests.add(entry.requestId);for(const id of entry.entries)ids.add(id);
  }
  return {ids,requests};
}

/** Repair a restored applied reset without replaying its administrative action,
 * issuing receipts or clearing later, unrelated catalog/shout generations. */
export function repairAppliedNativeResetEntries(db:DB,journal:ErasureJournal){
  if(!db.inTransaction||db.pragma('foreign_keys',{simple:true})!==1)throw Error('Native reset entry repair requires a held foreign-key transaction');
  const {ids,requests}=originalScope(db,journal);
  for(const id of ids){
    db.prepare("DELETE FROM music_documents WHERE kind IN ('entry_source','entry_names','entry_lock') AND json_extract(payload_json,'$.entryId')=?").run(id);
    db.prepare('DELETE FROM music_selections WHERE entry_id=?').run(id);
    // Explicitly remove restored creation memberships, even before the parent
    // delete. No append-only catalog/action history is removed.
    db.prepare('DELETE FROM music_entry_creations WHERE entry_id=?').run(id);
    db.prepare('DELETE FROM music_entry_details WHERE entry_id=?').run(id);
    db.prepare('DELETE FROM music_entries WHERE id=?').run(id);
    db.prepare("UPDATE migration_map SET status='deleted' WHERE source='music' AND entity_type='entry' AND target_id=? AND status<>'deleted'").run(id);
  }
  return {nativeResetRequests:requests.size,entryScopes:ids.size};
}

/** Independent complete row oracle from the pre-repair image and journal.
 * It does not call the writer or trust its reported scope/change counters. */
export function reconcileAppliedNativeResetEntries(source:DB,candidate:DB,journal:ErasureJournal){
  const reject=():never=>{throw Error('Native reset entry reconciliation failed; retain original images');};
  source.transaction(()=>assertRollbackSource(source)).immediate();
  if(candidate.inTransaction)assertRollbackSource(candidate);else candidate.transaction(()=>assertRollbackSource(candidate)).immediate();
  if(!forwardEqual(schemaObjects(source),schemaObjects(candidate)))reject();
  for(const name of ['user_version','application_id','encoding'])if(!forwardEqual(source.pragma(name,{simple:true}),candidate.pragma(name,{simple:true})))reject();
  // Deliberately derive the oracle's scope independently from the writer helper.
  const entries=new Set<string>(),requests=new Set<string>();
  for(const intent of readVerifiedErasureJournal(source,journal))if('version' in intent&&intent.version===2&&intent.command==='reset_music'){
    const result=AdminMusicErasureResult.parse(JSON.parse((source.prepare('SELECT result_json FROM privacy_receipts WHERE request_id=?').get(intent.requestId) as {result_json:string}).result_json));
    if(!forwardEqual(result,{requestId:intent.requestId,target:'admin_music',command:'reset_music',status:'completed',profiles:intent.profiles.length,entries:intent.entries.length}))reject();
    requests.add(intent.requestId);intent.entries.forEach(id=>entries.add(id));
  }
  let removedRows=0,changedRows=0,retainedRows=0;
  for(const table of schemaObjects(source).filter(row=>row.type==='table'&&row.name!=='sqlite_sequence').map(row=>row.name)){
    const columns=(source.prepare(`PRAGMA table_xinfo("${table}")`).all() as {name:string}[]).map(row=>row.name),actual=forwardRows(candidate,table);
    try{
      for(const row of forwardRows(source,table)){
        let deleted=table==='music_entries'&&entries.has(String(row.id))||['music_entry_details','music_selections','music_entry_creations'].includes(table)&&entries.has(String(row.entry_id));
        if(table==='music_documents'&&['entry_source','entry_names','entry_lock'].includes(String(row.kind))){
          const value=JSON.parse(String(row.payload_json)) as {entryId?:unknown};
          if(typeof value.entryId==='string'&&entries.has(value.entryId))deleted=true;
        }
        if(deleted){removedRows++;continue;}
        const wanted={...row};
        if(table==='migration_map'&&row.source==='music'&&row.entity_type==='entry'&&entries.has(String(row.target_id))){wanted.status='deleted';wanted['__forward_type_'+columns.indexOf('status')]='text';}
        const next=actual.next();if(next.done||!forwardEqual(wanted,next.value))reject();
        if(forwardEqual(wanted,row))retainedRows++;else changedRows++;
      }
      if(!actual.next().done)reject();
    }finally{actual.return?.();}
  }
  forwardSequences(source);forwardSequences(candidate);
  if(!forwardEqual([...forwardRows(source,'sqlite_sequence')],[...forwardRows(candidate,'sqlite_sequence')]))reject();
  readVerifiedErasureJournal(candidate,journal);
  return {nativeResetRequests:requests.size,entryScopes:entries.size,removedRows,changedRows,retainedRows,allRowsVerified:true as const,globalResetGenerationsVerified:false as const,releaseEligible:false as const};
}
