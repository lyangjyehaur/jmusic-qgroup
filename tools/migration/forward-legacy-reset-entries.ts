import type {DB} from '@qgroup/database';
import type {readRollbackErasureAuthority} from '../../apps/api/src/erasure-authority-protocol';
import {schemaObjects} from './board-reconciliation';
import {assertRollbackSource} from './rollback-source';
import {forwardEqual,forwardRows,forwardSequences} from './forward-board-storage';
import {musicBytes} from './forward-music-sources';
import {object} from './music-codec';
import type {readForwardLegacyResetVault} from './forward-legacy-reset-vault';
import {readSourceRebaseEvidence} from './source-rebase-evidence';

type Vault=ReturnType<typeof readForwardLegacyResetVault>;
type Records=ReturnType<typeof readRollbackErasureAuthority>['records'];

/** The rollback checkpoint exports actual native entry IDs as old JSON keys.
 * A completed global reset clears that original catalog generation, including
 * entries removed from the persisted container before the reset. Loaded members
 * remain a separate identity-erasure scope. Source rebase needs ancestry. */
function scope(checkpoint:DB,native:DB,records:Records,vault:Vault){
  if(!vault.vaultEvidence.allRecordedResetCompletionsPresent)throw Error('Complete original reset results required for entry projection');
  if(readSourceRebaseEvidence(native))throw Error('Legacy reset entries after source rebase require generation ancestry');
  const known=new Set((checkpoint.prepare('SELECT id FROM music_entries').all() as {id:string}[]).map(row=>row.id)),ids=new Set<string>(records.some(row=>row.version===2)?known:[]);
  for(const record of records){
    if(record.version!==2)continue;
    const original=vault.sources.resets.find(row=>row.sequence===record.sequence);
    if(!original)throw Error('Original reset source missing');
    const keys=Object.keys(object(object(musicBytes(original.persisted.bytes),'original reset root').entries,'original reset entries'));
    if(!forwardEqual(keys,record.operation.scope.entries.map(row=>row.key)))throw Error('Original persisted entry scope differs');
    for(const key of keys){
      if(!known.has(key)&&native.prepare('SELECT 1 FROM music_entries WHERE id=?').get(key))throw Error('Original reset key collides with unrelated native entry; generation review required');
    }
  }
  return ids;
}

/** Disposable native candidate only. Preserve catalog history, original receipts,
 * unrelated later entries and every bot row. No global shout/trend claim. */
export function repairAppliedLegacyResetEntries(checkpoint:DB,db:DB,records:Records,vault:Vault){
  if(!db.inTransaction||db.pragma('foreign_keys',{simple:true})!==1)throw Error('Legacy reset entry repair requires a held foreign-key transaction');
  const ids=scope(checkpoint,db,records,vault);
  for(const id of ids){
    db.prepare("DELETE FROM music_documents WHERE kind IN ('entry_source','entry_names','entry_lock') AND json_extract(payload_json,'$.entryId')=?").run(id);
    for(const table of ['music_selections','music_entry_creations','music_entry_details'])db.prepare(`DELETE FROM ${table} WHERE entry_id=?`).run(id);
    db.prepare('DELETE FROM music_entries WHERE id=?').run(id);
    db.prepare("UPDATE migration_map SET status='deleted' WHERE source='music' AND entity_type='entry' AND target_id=? AND status<>'deleted'").run(id);
  }
  return {entryScopes:ids.size,globalResetGenerationsVerified:false as const};
}

/** Independent complete-row oracle derives deletion IDs from authority scope,
 * while the writer derives them from verified persisted JSON. No writer replay
 * or manufactured administrative intent/receipt is used as evidence. */
export function reconcileAppliedLegacyResetEntries(checkpoint:DB,source:DB,candidate:DB,records:Records,vault:Vault){
  const reject=():never=>{throw Error('Legacy reset entry reconciliation failed; retain original images and vault');};
  source.transaction(()=>assertRollbackSource(source)).immediate();
  if(candidate.inTransaction)assertRollbackSource(candidate);else candidate.transaction(()=>assertRollbackSource(candidate)).immediate();
  if(!vault.vaultEvidence.allRecordedResetCompletionsPresent||readSourceRebaseEvidence(source))reject();
  if(!forwardEqual(schemaObjects(source),schemaObjects(candidate)))reject();
  for(const name of ['user_version','application_id','encoding'])if(!forwardEqual(source.pragma(name,{simple:true}),candidate.pragma(name,{simple:true})))reject();
  const known=new Set((checkpoint.prepare('SELECT id FROM music_entries').all() as {id:string}[]).map(row=>row.id)),entries=new Set<string>(records.some(row=>row.version===2)?known:[]);
  let resets=0;
  for(const record of records)if(record.version===2){
    if(!vault.sources.resets.some(row=>row.sequence===record.sequence)||!vault.completionSources.some(row=>row.sequence===record.sequence))reject();
    resets++;
    for(const {key} of record.operation.scope.entries){
      if(!known.has(key)&&source.prepare('SELECT 1 FROM music_entries WHERE id=?').get(key))reject();
    }
  }
  let removedRows=0,changedRows=0,retainedRows=0;
  for(const table of schemaObjects(source).filter(row=>row.type==='table'&&row.name!=='sqlite_sequence').map(row=>row.name)){
    const columns=(source.prepare(`PRAGMA table_xinfo("${table}")`).all() as {name:string}[]).map(row=>row.name),actual=forwardRows(candidate,table);
    try{
      for(const row of forwardRows(source,table)){
        let removed=table==='music_entries'&&entries.has(String(row.id))||['music_entry_details','music_selections','music_entry_creations'].includes(table)&&entries.has(String(row.entry_id));
        if(table==='music_documents'&&['entry_source','entry_names','entry_lock'].includes(String(row.kind))){
          const value=JSON.parse(String(row.payload_json)) as {entryId?:unknown};
          if(typeof value.entryId==='string'&&entries.has(value.entryId))removed=true;
        }
        if(removed){removedRows++;continue;}
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
  return {originalResetRecords:resets,entryScopes:entries.size,removedRows,changedRows,retainedRows,allRowsVerified:true as const,globalResetGenerationsVerified:false as const,releaseEligible:false as const};
}
