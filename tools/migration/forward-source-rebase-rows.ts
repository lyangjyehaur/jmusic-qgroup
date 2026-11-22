import Database from 'better-sqlite3';
import {copyForwardSourceRebaseInput,sourceRebasePins,type ForwardSourceRebaseInput,openForwardSourceRebase} from './forward-source-rebase-source';
import {forwardRows,forwardHash,assertForwardImage,forwardSequences} from './forward-board-storage';
import {object,jsonObjectKeys} from './music-codec';
import {captureIdentitySource} from './identity-source';
import {identityTables,identityColumns} from './rollback-identity-source';
import {sourceRebaseDigest,sourceRebaseRowDigest,type SourceRebaseEvidence} from './source-rebase-evidence';
import {verifyForwardSourceRebase} from './forward-source-rebase-reconciliation';
import {quoted} from './board-reconciliation';

type Row=Record<string,unknown>;
/** Rebase source evidence only on the independently verified proof candidate.
 * All native business, history, authentication, bot work and sequence rows stay
 * exact. Superseded evidence remains in separately returned original images. */
export function rebaseForwardSourceRows(input:ForwardSourceRebaseInput,s:ReturnType<typeof openForwardSourceRebase>,assertBoundary?:()=>void){
  const held=copyForwardSourceRebaseInput(input),pins=sourceRebasePins(held),db=new Database(held.proofImage.bytes);
  const guard=()=>{const value:unknown=assertBoundary?.();if(value!==null&&(typeof value==='object'||typeof value==='function')&&'then' in value)throw Error('Source rebase boundary must be synchronous');const now=copyForwardSourceRebaseInput(input);if(now.rebasedAt!==held.rebasedAt||now.proofs.reconstructedAt!==held.proofs.reconstructedAt||now.proofs.reconciledAt!==held.proofs.reconciledAt||JSON.stringify(sourceRebasePins(now))!==JSON.stringify(pins)||!now.proofImage.bytes.equals(held.proofImage.bytes))throw Error('Source rebase input changed');};
  try{
    guard();
    const music=s.sources.music,evidence:SourceRebaseEvidence={version:1,kind:'forward_source_rebase',sourcePins:pins,rebasedAt:held.rebasedAt,
      bindings:music.keys.map(({profileId,legacyKey,mode})=>({profileId,legacyKey,mode})),histories:{music_ownership_history:{cutoff:'0',rows:[]},music_profile_audit:{cutoff:'0',rows:[]}},auditMappings:structuredClone(s.sources.original.nativeAuditMappings)};
    const sequences=forwardSequences(s.proof);
    for(const table of ['music_ownership_history','music_profile_audit'] as const){evidence.histories[table]={cutoff:String(sequences.get(table)??0n),rows:[...forwardRows(s.proof,table)].map(row=>({id:String(row.id),profileId:String(row.profile_id),sha256:sourceRebaseRowDigest(row)}))};}
    const run=sourceRebaseDigest(evidence),members=object(music.data.members,'rebased members'),documents:Row[]=[],maps:Row[]=[],identityRows:Row[]=[];
    const document=(kind:string,position:number,payload:unknown)=>documents.push({kind,position,payload_json:JSON.stringify(payload)});
    const map=(source:string,entity_type:string,source_id:string,target_id:string,payload:string,status:string)=>maps.push({source,entity_type,source_id,target_id,source_revision:run,payload_digest:forwardHash(payload),status});
    const entrySource=object(music.data.entries,'rebased entries');jsonObjectKeys(entrySource).forEach((id,position)=>{const entry=entrySource[id]!;document('entry_source',position,{entryId:id,entry});map('music','entry',id,id,JSON.stringify(entry),'preserved');});
    const retiredSources=(s.proof.prepare("SELECT kind,position,payload_json FROM music_documents WHERE kind='profile_source' ORDER BY position").all() as {kind:string;position:number;payload_json:string}[]).filter(row=>music.keys.some(key=>key.retired&&JSON.parse(row.payload_json).profileId===key.profileId));
    if(retiredSources.some(row=>!Number.isSafeInteger(row.position)||row.position<0))throw Error('Retired profile source position exceeds supported scope');
    documents.push(...retiredSources);const reservedProfilePositions=new Set(retiredSources.map(row=>row.position));
    const orderedKeys=[...jsonObjectKeys(members).map(id=>music.keys.find(key=>key.legacyKey===id)!),...music.keys.filter(key=>!Object.hasOwn(members,key.legacyKey))];
    let position=0;for(const key of orderedKeys){
      if(key.erased){map('music','profile',key.legacyKey,key.profileId,'','erased');continue;}
      if(key.retired){const original=s.proof.prepare("SELECT * FROM migration_map WHERE source='music' AND entity_type='profile' AND source_id=? AND target_id=?").get(key.legacyKey,key.profileId) as Row|undefined;if(original)maps.push(original);else map('music','profile',key.legacyKey,key.profileId,'','retired');continue;}
      const member=object(members[key.legacyKey],'rebased member'),creation=s.proof.prepare('SELECT created_at FROM music_profile_creation WHERE profile_id=?').get(key.profileId) as {created_at:string}|undefined;
      if(creation&&member.createdAt!==Date.parse(creation.created_at)/1000)throw Error('Source rebase conflicts with original native creation time');
      while(reservedProfilePositions.has(position))position++;
      document('profile_source',position++,{profileId:key.profileId,legacyKey:key.legacyKey,source:'json',member});map('music','profile',key.legacyKey,key.profileId,JSON.stringify(member),'preserved');
    }
    for(const kind of ['settings','shouts','shoutHistory']){const values=kind==='settings'?[music.data.settings??{}]:music.data[kind];if(!Array.isArray(values))throw Error('Invalid source rebase document list');values.forEach((value,index)=>{document(kind,index,value);map('music',kind,String(index),kind+':'+index,JSON.stringify(value),kind==='settings'?'inactive_legacy_credential':'preserved');});}
    document('identity_source',0,captureIdentitySource(s.identity));document('source_rebase',0,evidence);
    for(const table of identityTables)for(const [index,row] of [...forwardRows(s.identity,table)].entries()){
      const value=Object.fromEntries(identityColumns[table].map(column=>{let v=row[column];if(typeof v==='bigint'){if(v>BigInt(Number.MAX_SAFE_INTEGER)||v<-BigInt(Number.MAX_SAFE_INTEGER))throw Error('Source rebase identity body exceeds safe JSON integer');v=Number(v);}return [column,v];})),payload=JSON.stringify(value);
      identityRows.push({table_name:table,row_number:index,payload_json:payload});const orphan=value.qq!==undefined&&!Object.hasOwn(members,String(value.qq));map('music-identity',table,String(index),table+':'+index,payload,orphan?'requires_legacy_review':['sessions','entry_intents'].includes(table)?'requires_legacy_adapter':'preserved');
    }
    db.pragma('foreign_keys=ON');db.transaction(()=>{
      const replace=(table:string,keys:string[],desired:Row[],belongs:(row:Row)=>boolean)=>{
        const existing=[...forwardRows(db,table)],old=new Map(existing.map(row=>[JSON.stringify(keys.map(key=>String(row[key]))),row])),wanted=new Set(desired.map(row=>JSON.stringify(keys.map(key=>String(row[key])))));let high=existing.reduce((high,row)=>high>row.__forward_rowid__?high:row.__forward_rowid__,0n);
        for(const row of existing)if(belongs(row)&&!wanted.has(JSON.stringify(keys.map(key=>String(row[key])))))db.prepare(`DELETE FROM ${quoted(table)} WHERE rowid=?`).run(row.__forward_rowid__);
        for(const row of desired){const previous=old.get(JSON.stringify(keys.map(key=>String(row[key])))),columns=Object.keys(row);if(previous)db.prepare(`UPDATE ${quoted(table)} SET ${columns.map(column=>quoted(column)+'=?').join(',')} WHERE rowid=?`).run(...columns.map(column=>row[column]),previous.__forward_rowid__);else{if(high===9223372036854775807n)throw Error('Source rebase rowid capacity exhausted');db.prepare(`INSERT INTO ${quoted(table)}(rowid,${columns.map(quoted).join(',')}) VALUES(${Array(columns.length+1).fill('?').join(',')})`).run(++high,...columns.map(column=>row[column]));}}
      };
      replace('music_documents',['kind','position'],documents,row=>['entry_source','profile_source','settings','shouts','shoutHistory','identity_source','source_rebase'].includes(String(row.kind)));
      replace('music_legacy_identity',['table_name','row_number'],identityRows,()=>true);
      replace('migration_map',['source','entity_type','source_id'],maps,row=>row.source==='music-identity'||row.source==='music'&&['entry','profile','settings','shouts','shoutHistory'].includes(String(row.entity_type)));
      const high=[...forwardRows(db,'migration_runs')].reduce((high,row)=>high>row.__forward_rowid__?high:row.__forward_rowid__,0n);if(high===9223372036854775807n)throw Error('Source rebase rowid capacity exhausted');
      const manifest={version:1,kind:'forward_source_rebase',evidenceSha256:forwardHash(JSON.stringify(evidence)),sourcePins:pins,rebasedAt:held.rebasedAt},report={sourceEvidenceRebased:true,originalBindingsPreserved:true,frozenAuditMappings:evidence.auditMappings.length,externalRetentionRequired:true,latestErasureReplayRequired:true,releaseEligible:false};
      db.prepare('INSERT INTO migration_runs(rowid,source_digest,manifest_json,report_json,created_at) VALUES(?,?,?,?,?)').run(high+1n,run,JSON.stringify(manifest),JSON.stringify(report),held.rebasedAt);
    }).immediate();const nativeImage=db.serialize();assertForwardImage(nativeImage);const reconciliation=verifyForwardSourceRebase(held,nativeImage);guard();
    return {nativeImage,nativeJournal:Buffer.from(held.proofs.sources.nativeJournal.bytes),retainedProofImage:Buffer.from(held.proofImage.bytes),retainedBusinessImage:Buffer.from(held.proofs.businessImage.bytes),musicSources:Buffer.from(held.proofs.musicSources.bytes),identitySources:Buffer.from(held.proofs.identitySources.bytes),report:{version:1 as const,sourcePins:pins,sourceDigest:run,reconciliation,sourceEvidenceRebased:true as const,externalRetentionRequired:true as const,externalRetentionVerified:false as const,latestErasureReplayRequired:true as const,recoveryRequired:true as const,rollbackEligible:false as const,releaseEligible:false as const}};
  }finally{db.close();}
}
