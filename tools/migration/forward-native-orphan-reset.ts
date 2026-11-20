import Database from 'better-sqlite3';
import type {DB} from '@qgroup/database';
import {AdminMusicErasureResult} from '@qgroup/contracts';
import {decodeErasureJournal,readVerifiedErasureJournal,type ErasureJournal} from '../../apps/api/src/erasure-journal';
import {replayMusicErasure} from '../../apps/api/src/privacy';
import {schemaObjects} from './board-reconciliation';
import {assertRollbackSource} from './rollback-source';
import {assertForwardImage,forwardEqual,forwardHash,forwardLineage,forwardRows,forwardSequences,type ForwardRow,type PinnedForwardBytes} from './forward-board-storage';
import {readSourceRebaseEvidence} from './source-rebase-evidence';

/** Explicit frozen sources for one empty-profile/empty-entry native reset.
 * Byte pins and a verified transition do not establish stopped-source custody. */
export type NativeOrphanResetSource={requestId:string;before:PinnedForwardBytes;beforeJournal:PinnedForwardBytes;completed:PinnedForwardBytes;completedJournal:PinnedForwardBytes};
export type NativeResetSource=NativeOrphanResetSource;
const kinds=['shouts','shoutHistory','trend','trend_sample'];
const mapKinds=['shouts','shoutHistory','trend'];
const slot=(table:string,row:ForwardRow)=>table==='music_shouts'?String(row.id):table==='music_shout_authors'?String(row.profile_id):table==='music_documents'?JSON.stringify([row.kind,String(row.position)]):JSON.stringify([row.source,row.entity_type,row.source_id]);
const scoped=(table:string,row:ForwardRow)=>table==='music_shouts'||table==='music_shout_authors'||table==='music_documents'&&kinds.includes(String(row.kind))||table==='migration_map'&&row.source==='music'&&mapKinds.includes(String(row.entity_type));
const tables=['music_shouts','music_shout_authors','music_documents','migration_map'];
const journal=(bytes:Buffer)=>({read:()=>decodeErasureJournal(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)),append(){throw Error('Frozen reset journal is read-only');}});

export function copyNativeOrphanResetSource(input:NativeOrphanResetSource):NativeOrphanResetSource{
  if(!input||typeof input.requestId!=='string')throw Error('Native orphan reset source required');
  const held={requestId:input.requestId} as NativeOrphanResetSource;
  for(const key of ['before','beforeJournal','completed','completedJournal'] as const){
    const value=input[key];if(!value||!Buffer.isBuffer(value.bytes)||!/^[a-f0-9]{64}$/.test(value.sha256)||forwardHash(value.bytes)!==value.sha256)throw Error('Native orphan reset source pin differs');
    if(key==='before'||key==='completed')assertForwardImage(value.bytes);else if(value.bytes.length>64*1024*1024)throw Error('Native orphan reset journal exceeds capacity');
    held[key]={bytes:Buffer.from(value.bytes),sha256:value.sha256};
  }
  return held;
}

function addedRow(db:DB,table:string,values:Record<string,unknown>,rowid:bigint){
  const cols=(db.prepare(`PRAGMA table_xinfo("${table}")`).all() as {name:string}[]).map(row=>row.name);
  const row:ForwardRow={__forward_rowid__:rowid};for(const col of cols)row[col]=values[col];
  for(const [index,col] of cols.entries())row['__forward_type_'+index]=values[col]===null?'null':typeof values[col]==='bigint'?'integer':'text';
  return row;
}

/** Full pre/completion row relation with independent global/authority rules.
 * General resets explicitly reuse private profile service semantics, without
 * replaying the administrative action or producing a replacement receipt. */
function openSource(input:NativeResetSource,general=false){
  const held=copyNativeOrphanResetSource(input),before=new Database(held.before.bytes);let completed:DB;
  try{completed=new Database(held.completed.bytes);}catch(error){before.close();throw error;}
  let projected:DB|undefined;
  const close=()=>{projected?.close();completed.close();before.close();};
  try{
    for(const db of [before,completed]){
      db.pragma('foreign_keys = ON');db.transaction(()=>{assertRollbackSource(db);forwardSequences(db);}).immediate();
      if(readSourceRebaseEvidence(db))throw Error('Native orphan reset after rebase requires generation ancestry');
    }
    const prior=readVerifiedErasureJournal(before,journal(held.beforeJournal.bytes)),after=readVerifiedErasureJournal(completed,journal(held.completedJournal.bytes));
    if(!held.completedJournal.bytes.subarray(0,held.beforeJournal.bytes.length).equals(held.beforeJournal.bytes)||after.length!==prior.length+1||new Set(after.map(row=>'user_id' in row?row.request_id:row.version===3?row.markerId:row.requestId)).size!==after.length)throw Error('Native orphan reset journal transition differs');
    const intent=after.at(-1)!;
    if(!('version' in intent)||intent.version!==2||intent.command!=='reset_music'||intent.requestId!==held.requestId)throw Error('Native reset source intent differs');
    const profiles=before.prepare('SELECT id,user_id AS userId FROM music_profiles WHERE erased_at IS NULL ORDER BY id').all(),entries=(before.prepare('SELECT id FROM music_entries ORDER BY id').all() as {id:string}[]).map(row=>row.id);
    if(!forwardEqual(profiles,intent.profiles)||!forwardEqual(entries,intent.entries))throw Error('Native reset source profile or entry scope differs');
    if(!general&&(intent.profiles.length||intent.entries.length))throw Error('Native orphan reset scope requires empty profile and entry generations');
    // A full reset also invokes the established private profile erasure and
    // catalog semantics. Their service writer is explicitly reused here; the
    // global row oracle and appended authority relation remain independent.
    if(general&&(intent.profiles.length||intent.entries.length)){
      projected=new Database(before.serialize());projected.pragma('foreign_keys = ON');
      const model=projected;
      model.transaction(()=>{
        for(const profile of intent.profiles)replayMusicErasure(model,profile.id,profile.userId,intent.createdAt);
        for(const id of intent.entries){
          model.prepare("DELETE FROM music_documents WHERE kind='entry_source' AND json_extract(payload_json,'$.entryId')=?").run(id);
          model.prepare('DELETE FROM music_selections WHERE entry_id=?').run(id);
          model.prepare('DELETE FROM music_entry_details WHERE entry_id=?').run(id);
          model.prepare('DELETE FROM music_entries WHERE id=?').run(id);
          model.prepare("UPDATE migration_map SET status='deleted' WHERE source='music' AND entity_type='entry' AND target_id=?").run(id);
        }
        assertRollbackSource(model);forwardSequences(model);
      }).immediate();
    }
    const expected=projected??before;
    const receipt=AdminMusicErasureResult.parse({requestId:intent.requestId,target:'admin_music',command:'reset_music',status:'completed',profiles:intent.profiles.length,entries:intent.entries.length});
    const actor=intent.actorRef.startsWith('account:')?intent.actorRef.slice(8):null;
    const appended:Record<string,Record<string,unknown>>={
      privacy_receipts:{request_id:intent.requestId,secret_hash:intent.secretHash,signature:intent.signature,result_json:JSON.stringify(receipt)},
      erasure_applied:{request_id:intent.requestId},
      music_catalog_actions:{actor_id:actor&&before.prepare('SELECT 1 FROM users WHERE id=?').get(actor)?actor:null,actor_ref:intent.actorRef,command:'reset_music',entry_id:'',target_id:'',affected_profiles:BigInt(intent.profiles.length),created_at:intent.createdAt},
    };
    if(!forwardEqual(schemaObjects(before),schemaObjects(completed)))throw Error('Native orphan reset source schema differs');
    for(const name of ['user_version','application_id','encoding'])if(!forwardEqual(before.pragma(name,{simple:true}),completed.pragma(name,{simple:true})))throw Error('Native orphan reset source metadata differs');
    for(const table of schemaObjects(before).filter(row=>row.type==='table').map(row=>row.name)){
      const actual=forwardRows(completed,table);let high=0n;
      try{
        for(const row of forwardRows(expected,table)){
          high=row.__forward_rowid__>high?row.__forward_rowid__:high;
          if(scoped(table,row)&&table!=='migration_map')continue;
          const wanted={...row};if(table==='migration_map'&&scoped(table,row))wanted.status='deleted';
          const next=actual.next();if(next.done||!forwardEqual(wanted,next.value))throw Error('Native orphan reset completion row relation differs');
        }
        if(appended[table]){
          const id=high+1n,values={...appended[table],...table==='music_catalog_actions'?{id}:{}},next=actual.next();
          if(next.done||!forwardEqual(addedRow(before,table,values,id),next.value))throw Error('Native orphan reset appended authority row differs');
        }
        if(!actual.next().done)throw Error('Native orphan reset completion contains unrelated writes');
      }finally{actual.return?.();}
    }
    const globalSourceRows=tables.filter(table=>table!=='migration_map').reduce((count,table)=>count+[...forwardRows(before,table)].filter(row=>scoped(table,row)).length,0);
    if(!globalSourceRows&&!intent.profiles.length&&!intent.entries.length)throw Error('Native reset source contains no reset data');
    return {held,before,completed,intent,erasedRows:globalSourceRows,profileProjectionUsesServiceWriter:intent.profiles.length>0,close};
  }catch(error){close();throw error;}
}

export function verifyNativeOrphanResetSource(input:NativeOrphanResetSource){
  const s=openSource(input);try{return {requestId:s.intent.requestId,beforeSha256:s.held.before.sha256,completedSha256:s.held.completed.sha256,erasedRows:s.erasedRows,allTransitionRowsVerified:true as const,stoppedCaptureCustodyVerified:false as const,allResetGenerationsReconciled:false as const,releaseEligible:false as const};}finally{s.close();}
}
export function verifyNativeResetSource(input:NativeResetSource){
  const s=openSource(input,true);try{return {requestId:s.intent.requestId,beforeSha256:s.held.before.sha256,completedSha256:s.held.completed.sha256,profileScopes:s.intent.profiles.length,entryScopes:s.intent.entries.length,globalSourceRows:s.erasedRows,allTransitionRowsVerified:true as const,profileProjectionUsesServiceWriter:s.profileProjectionUsesServiceWriter,fullPrivateScopeIndependentlyVerified:!s.profileProjectionUsesServiceWriter,stoppedCaptureCustodyVerified:false as const,allResetGenerationsReconciled:false as const,releaseEligible:false as const};}finally{s.close();}
}

function candidateBoundary(before:DB,completed:DB,db:DB,current:ErasureJournal,completedJournal:Buffer){
  if(forwardLineage(before)!==forwardLineage(db)||readSourceRebaseEvidence(db))throw Error('Native orphan reset candidate generation ancestry differs');
  const minimum=forwardSequences(completed),currentSequences=forwardSequences(db);
  for(const [name,value] of minimum)if((currentSequences.get(name)??-1n)<value)throw Error('Native reset candidate sequence rewound below completion');
  const original=journal(completedJournal).read(),actual=readVerifiedErasureJournal(db,current);
  if(actual.length<original.length||!forwardEqual(original,actual.slice(0,original.length)))throw Error('Native orphan reset candidate lost its completed journal prefix');
  if(actual.slice(original.length).some(intent=>'version' in intent&&intent.version===2&&intent.command==='reset_music'))throw Error('Native orphan reset followed by a later reset requires generation ancestry');
  for(const table of ['privacy_receipts','erasure_applied','music_catalog_actions']){
    const rows=new Map([...forwardRows(db,table)].map(row=>[row.__forward_rowid__,row]));
    for(const row of forwardRows(completed,table))if(!forwardEqual(row,rows.get(row.__forward_rowid__)))throw Error('Native orphan reset original authority row changed');
  }
  const shoutIds=new Set([...forwardRows(before,'music_shouts')].map(row=>String(row.id)));
  for(const table of tables){
    const originals=new Map([...forwardRows(before,table)].filter(row=>scoped(table,row)).map(row=>[slot(table,row),row]));
    for(const row of forwardRows(db,table)){
      const original=originals.get(slot(table,row));
      if(original){const wanted={...original};if(table==='migration_map')wanted.status=row.status;
        if(!forwardEqual(row,wanted))throw Error('Native orphan reset key or source slot was reused; generation evidence required');}
      else if(table==='music_documents'&&['shouts','shoutHistory'].includes(String(row.kind))&&shoutIds.has(String((JSON.parse(String(row.payload_json)) as {id?:unknown}).id)))throw Error('Native orphan reset shout shadow identity was reused');
    }
  }
}

/** Only a disposable memory candidate in a held transaction may be repaired.
 * Later keys are retained; ambiguous key reuse blocks before the first write. */
function repairGlobal(db:DB,current:ErasureJournal,input:NativeResetSource,general:boolean){
  if(db.name!==':memory:'||!db.inTransaction||db.pragma('foreign_keys',{simple:true})!==1)throw Error('Native orphan reset repair requires a disposable memory image and held foreign-key transaction');
  assertRollbackSource(db);forwardSequences(db);
  const s=openSource(input,general);
  try{
    candidateBoundary(s.before,s.completed,db,current,s.held.completedJournal.bytes);
    for(const table of tables){
      const originals=new Set([...forwardRows(s.before,table)].filter(row=>scoped(table,row)).map(row=>slot(table,row)));
      const rows=[...forwardRows(db,table)];
      for(const row of rows)if(originals.has(slot(table,row))){
        if(table==='migration_map')db.prepare("UPDATE migration_map SET status='deleted' WHERE rowid=? AND status<>'deleted'").run(row.__forward_rowid__);
        else db.prepare(`DELETE FROM "${table}" WHERE rowid=?`).run(row.__forward_rowid__);
      }
    }
  }finally{s.close();}
}
export function repairAppliedNativeOrphanResetGlobal(db:DB,current:ErasureJournal,input:NativeOrphanResetSource){return repairGlobal(db,current,input,false);}
export function repairAppliedNativeResetGlobal(db:DB,current:ErasureJournal,input:NativeResetSource){return repairGlobal(db,current,input,true);}

/** Independent whole-candidate oracle from the frozen pre-reset generation,
 * not the repairer's reported scope or counters. */
function reconcileGlobal(source:DB,candidate:DB,current:ErasureJournal,input:NativeResetSource,general:boolean){
  const reject=():never=>{throw Error('Native orphan reset reconciliation failed; retain all source generations');};
  const s=openSource(input,general);
  try{
    source.transaction(()=>{assertRollbackSource(source);forwardSequences(source);}).immediate();
    if(candidate.inTransaction){assertRollbackSource(candidate);forwardSequences(candidate);}else candidate.transaction(()=>{assertRollbackSource(candidate);forwardSequences(candidate);}).immediate();
    candidateBoundary(s.before,s.completed,source,current,s.held.completedJournal.bytes);
    if(!forwardEqual(schemaObjects(source),schemaObjects(candidate)))reject();
    for(const name of ['user_version','application_id','encoding'])if(!forwardEqual(source.pragma(name,{simple:true}),candidate.pragma(name,{simple:true})))reject();
    const scopes=new Map(tables.map(table=>[table,new Set([...forwardRows(s.before,table)].filter(row=>scoped(table,row)).map(row=>slot(table,row)))]));
    let removedRows=0,changedRows=0,retainedRows=0;
    for(const table of schemaObjects(source).filter(row=>row.type==='table').map(row=>row.name)){
      const actual=forwardRows(candidate,table);
      try{
        for(const row of forwardRows(source,table)){
          const included=scopes.get(table)?.has(slot(table,row));
          if(included&&table!=='migration_map'){removedRows++;continue;}
          const wanted={...row};if(included)wanted.status='deleted';
          const next=actual.next();if(next.done||!forwardEqual(wanted,next.value))reject();
          if(forwardEqual(wanted,row))retainedRows++;else changedRows++;
        }
        if(!actual.next().done)reject();
      }finally{actual.return?.();}
    }
    readVerifiedErasureJournal(candidate,current);
    return {requestId:input.requestId,removedRows,changedRows,retainedRows,allRowsVerified:true as const,profileProjectionUsesServiceWriter:s.profileProjectionUsesServiceWriter,fullPrivateScopeIndependentlyVerified:!s.profileProjectionUsesServiceWriter,stoppedCaptureCustodyVerified:false as const,allResetGenerationsReconciled:false as const,releaseEligible:false as const};
  }finally{s.close();}
}
export function reconcileAppliedNativeOrphanResetGlobal(source:DB,candidate:DB,current:ErasureJournal,input:NativeOrphanResetSource){return reconcileGlobal(source,candidate,current,input,false);}
export function reconcileAppliedNativeResetGlobal(source:DB,candidate:DB,current:ErasureJournal,input:NativeResetSource){return reconcileGlobal(source,candidate,current,input,true);}
