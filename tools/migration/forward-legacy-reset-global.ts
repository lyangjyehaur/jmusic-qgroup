import type {DB} from '@qgroup/database';
import type {StoredIntent} from '../../apps/api/src/erasure-journal';
import type {readRollbackErasureAuthority} from '../../apps/api/src/erasure-authority-protocol';
import type {readForwardLegacyResetVault} from './forward-legacy-reset-vault';
import {schemaObjects} from './board-reconciliation';
import {assertRollbackSource} from './rollback-source';
import {forwardEqual,forwardRows,forwardSequences,type ForwardRow} from './forward-board-storage';
import {musicBytes} from './forward-music-sources';
import {object} from './music-codec';
import {readSourceRebaseEvidence} from './source-rebase-evidence';

type Records=ReturnType<typeof readRollbackErasureAuthority>['records'];
type Vault=ReturnType<typeof readForwardLegacyResetVault>;
const slot=(row:ForwardRow)=>JSON.stringify([row.kind,String(row.position)]);
const mapSlot=(row:ForwardRow)=>JSON.stringify([row.entity_type,String(row.source_id)]);
const kinds=['shouts','shoutHistory','trend','trend_sample'];

function original(checkpoint:DB,source:DB,records:Records,vault:Vault,intents:StoredIntent[]){
  if(!records.some(row=>row.version===2)||!vault.vaultEvidence.allRecordedResetCompletionsPresent)throw Error('Complete original global reset required');
  if(readSourceRebaseEvidence(source))throw Error('Global reset after source rebase requires generation ancestry');
  for(const intent of intents)if('version' in intent&&intent.version===2&&intent.command==='reset_music'&&!checkpoint.prepare('SELECT 1 FROM privacy_receipts WHERE request_id=?').get(intent.requestId))throw Error('Native reset after checkpoint requires global generation reconciliation');
  const ids=new Set((checkpoint.prepare('SELECT id FROM music_shouts').all() as {id:string}[]).map(row=>row.id));
  for(const record of records)if(record.version===2){
    const row=vault.sources.resets.find(value=>value.sequence===record.sequence);if(!row)throw Error('Original global reset source missing');
    const data=object(musicBytes(row.persisted.bytes),'original global reset source');
    for(const kind of ['shouts','shoutHistory']){
      const list=data[kind]??[];if(!Array.isArray(list))throw Error('Original reset shout list required');
      for(const item of list){const id=object(item,'original reset shout').id;if(typeof id!=='string'||!id)throw Error('Original reset shout identity requires review');
        if(!ids.has(id)&&source.prepare('SELECT 1 FROM music_shouts WHERE id=?').get(id))throw Error('Original reset shout collides with unrelated native generation');}
    }
  }
  const documents=new Map([...forwardRows(checkpoint,'music_documents')].filter(row=>kinds.includes(String(row.kind))).map(row=>[slot(row),row]));
  const maps=new Map([...forwardRows(checkpoint,'migration_map')].filter(row=>row.source==='music'&&['shouts','shoutHistory','trend'].includes(String(row.entity_type))&&documents.has(mapSlot(row))).map(row=>[mapSlot(row),row]));
  // Native appends have different identities/positions. A reused original slot
  // with changed content or mapping needs an explicit epoch relation.
  for(const row of forwardRows(source,'music_documents')){const before=documents.get(slot(row));if(before&&!forwardEqual(row,before))throw Error('Original reset document generation changed');}
  for(const row of forwardRows(source,'migration_map')){const before=maps.get(mapSlot(row));if(row.source==='music'&&before){const unchanged=['entity_type','source_id','target_id','source_revision','payload_digest'];if(unchanged.some(key=>!forwardEqual(row[key],before[key])))throw Error('Original reset mapping generation changed');}}
  return {ids,documents,maps};
}

/** Clear the original checkpoint shout/trend generation. Later native IDs and
 * appended samples remain; loaded profile erasures are handled separately. */
export function repairAppliedLegacyGlobalReset(checkpoint:DB,db:DB,records:Records,vault:Vault,intents:StoredIntent[]){
  if(!db.inTransaction||db.pragma('foreign_keys',{simple:true})!==1)throw Error('Global reset repair requires a held foreign-key transaction');
  const s=original(checkpoint,db,records,vault,intents);
  const mapRows=[...forwardRows(db,'migration_map')];
  for(const row of mapRows)if(row.source==='music'&&s.maps.has(mapSlot(row))&&row.status!=='erased')db.prepare("UPDATE migration_map SET status='deleted' WHERE rowid=?").run(row.__forward_rowid__);
  const remove=db.prepare('DELETE FROM music_documents WHERE kind=? AND position=?');for(const row of s.documents.values())remove.run(row.kind,row.position);
  for(const id of s.ids){db.prepare("DELETE FROM music_documents WHERE kind IN ('shouts','shoutHistory') AND json_extract(payload_json,'$.id')=?").run(id);db.prepare('DELETE FROM music_shouts WHERE id=?').run(id);}
  return {checkpointShoutScopes:s.ids.size,checkpointDocumentScopes:s.documents.size,checkpointGenerationCleared:true as const};
}

/** Independent complete-row oracle. It reads the complete verified vault and
 * derives the original checkpoint generation without calling the writer/plan. */
export function reconcileAppliedLegacyGlobalReset(checkpoint:DB,source:DB,candidate:DB,records:Records,vault:Vault,intents:StoredIntent[]){
  const reject=():never=>{throw Error('Original global reset reconciliation failed; retain all original generations');};
  source.transaction(()=>assertRollbackSource(source)).immediate();
  if(candidate.inTransaction)assertRollbackSource(candidate);else candidate.transaction(()=>assertRollbackSource(candidate)).immediate();
  const resets=records.filter(row=>row.version===2);if(!resets.length||!vault.vaultEvidence.allRecordedResetCompletionsPresent||readSourceRebaseEvidence(source))reject();
  for(const intent of intents)if('version' in intent&&intent.version===2&&intent.command==='reset_music'&&!checkpoint.prepare('SELECT 1 FROM privacy_receipts WHERE request_id=?').get(intent.requestId))reject();
  const ids=new Set((checkpoint.prepare('SELECT id FROM music_shouts').all() as {id:string}[]).map(row=>row.id));
  for(const record of resets){const originalSource=vault.sources.resets.find(row=>row.sequence===record.sequence);if(!originalSource||!vault.completionSources.some(row=>row.sequence===record.sequence))return reject();
    const value=object(musicBytes(originalSource.persisted.bytes),'reset oracle source');
    for(const kind of ['shouts','shoutHistory']){const rows=value[kind]??[];if(!Array.isArray(rows))return reject();for(const item of rows){const id=object(item,'reset oracle shout').id;if(typeof id!=='string'||!id||!ids.has(id)&&source.prepare('SELECT 1 FROM music_shouts WHERE id=?').get(id))reject();}}
  }
  const docs=new Map([...forwardRows(checkpoint,'music_documents')].filter(row=>['shouts','shoutHistory','trend','trend_sample'].includes(String(row.kind))).map(row=>[JSON.stringify([row.kind,String(row.position)]),row]));
  const maps=new Map([...forwardRows(checkpoint,'migration_map')].filter(row=>row.source==='music'&&['shouts','shoutHistory','trend'].includes(String(row.entity_type))&&docs.has(JSON.stringify([row.entity_type,String(row.source_id)]))).map(row=>[JSON.stringify([row.entity_type,String(row.source_id)]),row]));
  if(!forwardEqual(schemaObjects(source),schemaObjects(candidate)))reject();
  for(const name of ['user_version','application_id','encoding'])if(!forwardEqual(source.pragma(name,{simple:true}),candidate.pragma(name,{simple:true})))reject();
  let removedRows=0,changedRows=0,retainedRows=0;
  for(const table of schemaObjects(source).filter(row=>row.type==='table'&&row.name!=='sqlite_sequence').map(row=>row.name)){
    const columns=(source.prepare(`PRAGMA table_xinfo("${table}")`).all() as {name:string}[]).map(row=>row.name),actual=forwardRows(candidate,table);
    try{
      for(const row of forwardRows(source,table)){
        const before=table==='music_documents'?docs.get(JSON.stringify([row.kind,String(row.position)])):undefined;
        if(before&&!forwardEqual(before,row))reject();
        const deleted=table==='music_shouts'&&ids.has(String(row.id))||table==='music_documents'&&(!!before||['shouts','shoutHistory'].includes(String(row.kind))&&ids.has(String((JSON.parse(String(row.payload_json)) as {id?:unknown}).id)));
        if(deleted){removedRows++;continue;}
        const wanted={...row};
        if(table==='migration_map'&&row.source==='music'){
          const originalMap=maps.get(JSON.stringify([row.entity_type,String(row.source_id)]));
          if(originalMap){for(const key of ['entity_type','source_id','target_id','source_revision','payload_digest'])if(!forwardEqual(originalMap[key],row[key]))reject();if(row.status!=='erased'){wanted.status='deleted';wanted['__forward_type_'+columns.indexOf('status')]='text';}}
        }
        const next=actual.next();if(next.done||!forwardEqual(wanted,next.value))reject();
        if(forwardEqual(wanted,row))retainedRows++;else changedRows++;
      }
      if(!actual.next().done)reject();
    }finally{actual.return?.();}
  }
  forwardSequences(source);forwardSequences(candidate);if(!forwardEqual([...forwardRows(source,'sqlite_sequence')],[...forwardRows(candidate,'sqlite_sequence')]))reject();
  return {originalResetRecords:resets.length,checkpointShoutScopes:ids.size,checkpointDocumentScopes:docs.size,removedRows,changedRows,retainedRows,allRowsVerified:true as const,checkpointGenerationCleared:true as const,allResetGenerationsReconciled:false as const,releaseEligible:false as const};
}
