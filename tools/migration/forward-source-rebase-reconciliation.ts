import Database from 'better-sqlite3';
import {copyForwardSourceRebaseInput,openForwardSourceRebase,sourceRebasePins,type ForwardSourceRebaseInput} from './forward-source-rebase-source';
import {assertForwardImage,forwardRows,forwardEqual,forwardHash,forwardCanonical,forwardSequences,type ForwardRow} from './forward-board-storage';
import {schemaObjects} from './board-reconciliation';
import {captureIdentitySource} from './identity-source';
import {identityTables,identityColumns} from './rollback-identity-source';
import {sourceRebaseDigest,sourceRebaseRowDigest,readSourceRebaseEvidence,type SourceRebaseEvidence} from './source-rebase-evidence';
import {object} from './music-codec';
import {musicEqual} from './forward-music-sources';
import {assertRollbackSource} from './rollback-source';
import {decodeErasureJournal,type ErasureJournal} from '../../apps/api/src/erasure-journal';
import {projectRollbackMusic} from './rollback-music';
import {projectRollbackIdentity} from './rollback-identity';

const reject=():never=>{throw Error('Forward source rebase reconciliation failed; retain all original source images');};
/** Derives the complete output inventory from the pinned proof/source pair,
 * independently of the rebase writer. Structural codecs and the local evidence
 * reader are shared. Actual rollback projectors additionally prove this source
 * epoch can be used, without granting runtime or rollback activation. */
export function verifyForwardSourceRebase(input:ForwardSourceRebaseInput,image:Buffer){
  const held=copyForwardSourceRebaseInput(input);assertForwardImage(image);const s=openForwardSourceRebase(held);let db:Database.Database;
  try{db=new Database(Buffer.from(image));}catch(error){s.close();throw error;}
  try{
    db.transaction(()=>assertRollbackSource(db)).immediate();if(!forwardEqual(schemaObjects(db),schemaObjects(s.proof)))reject();for(const pragma of ['user_version','application_id','encoding'])if(db.pragma(pragma,{simple:true})!==s.proof.pragma(pragma,{simple:true}))reject();
    const pins=sourceRebasePins(held),music=s.sources.music,members=object(music.data.members,'expected rebased members'),sequence=forwardSequences(s.proof);
    const evidence:SourceRebaseEvidence={version:1,kind:'forward_source_rebase',sourcePins:pins,rebasedAt:held.rebasedAt,bindings:music.keys.map(key=>({profileId:key.profileId,legacyKey:key.legacyKey,mode:key.mode})),
      histories:{music_ownership_history:{cutoff:String(sequence.get('music_ownership_history')??0n),rows:[...forwardRows(s.proof,'music_ownership_history')].map(row=>({id:String(row.id),profileId:String(row.profile_id),sha256:sourceRebaseRowDigest(row)}))},music_profile_audit:{cutoff:String(sequence.get('music_profile_audit')??0n),rows:[...forwardRows(s.proof,'music_profile_audit')].map(row=>({id:String(row.id),profileId:String(row.profile_id),sha256:sourceRebaseRowDigest(row)}))}},auditMappings:structuredClone(s.sources.original.nativeAuditMappings)};
    const run=sourceRebaseDigest(evidence),desired=new Map<string,Record<string,unknown>[]>([['music_documents',[]],['music_legacy_identity',[]],['migration_map',[]]]);
    const docs=desired.get('music_documents')!,maps=desired.get('migration_map')!,rows=desired.get('music_legacy_identity')!;
    const expectedMap=(source:string,entity_type:string,source_id:string,target_id:string,payload:unknown,status:string)=>maps.push({source,entity_type,source_id,target_id,source_revision:run,payload_digest:forwardHash(typeof payload==='string'?payload:JSON.stringify(payload)),status});
    let position=0;for(const [id,entry] of Object.entries(object(music.data.entries,'expected entries'))){docs.push({kind:'entry_source',position:position++,payload_json:JSON.stringify({entryId:id,entry})});expectedMap('music','entry',id,id,entry,'preserved');}
    const retiredIds=new Set(music.keys.filter(row=>row.retired).map(row=>row.profileId)),retiredSources=(s.proof.prepare("SELECT kind,position,payload_json FROM music_documents WHERE kind='profile_source' ORDER BY position").all() as {kind:string;position:number;payload_json:string}[]).filter(row=>retiredIds.has(JSON.parse(row.payload_json).profileId));
    if(retiredSources.some(row=>!Number.isSafeInteger(row.position)||row.position<0))reject();docs.push(...retiredSources);const occupied=new Set(retiredSources.map(row=>row.position));
    position=0;for(const binding of music.keys){
      if(binding.erased){expectedMap('music','profile',binding.legacyKey,binding.profileId,'','erased');continue;}
      if(binding.retired){const original=s.proof.prepare("SELECT * FROM migration_map WHERE source='music' AND entity_type='profile' AND source_id=? AND target_id=?").get(binding.legacyKey,binding.profileId) as Record<string,unknown>|undefined;if(original)maps.push(original);else expectedMap('music','profile',binding.legacyKey,binding.profileId,'','retired');continue;}
      const member=members[binding.legacyKey];if(!member)reject();while(occupied.has(position))position++;docs.push({kind:'profile_source',position:position++,payload_json:JSON.stringify({profileId:binding.profileId,legacyKey:binding.legacyKey,source:'json',member})});expectedMap('music','profile',binding.legacyKey,binding.profileId,member,'preserved');
    }
    for(const kind of ['settings','shouts','shoutHistory']){const list=kind==='settings'?[music.data.settings??{}]:music.data[kind];if(!Array.isArray(list))return reject();list.forEach((item,index)=>{docs.push({kind,position:index,payload_json:JSON.stringify(item)});expectedMap('music',kind,String(index),kind+':'+index,item,kind==='settings'?'inactive_legacy_credential':'preserved');});}
    docs.push({kind:'identity_source',position:0,payload_json:JSON.stringify(captureIdentitySource(s.identity))},{kind:'source_rebase',position:0,payload_json:JSON.stringify(evidence)});
    for(const table of identityTables){
      let index=0;for(const row of forwardRows(s.identity,table)){
        const value:Record<string,unknown>={};for(const column of identityColumns[table]){const v=row[column];if(typeof v==='bigint'&&(v>BigInt(Number.MAX_SAFE_INTEGER)||v<-BigInt(Number.MAX_SAFE_INTEGER)))reject();value[column]=typeof v==='bigint'?Number(v):v;}
        rows.push({table_name:table,row_number:index,payload_json:JSON.stringify(value)});expectedMap('music-identity',table,String(index),table+':'+index,value,value.qq!==undefined&&!Object.hasOwn(members,String(value.qq))?'requires_legacy_review':['sessions','entry_intents'].includes(table)?'requires_legacy_adapter':'preserved');index++;
      }
    }
    const expected=new Map<string,ForwardRow[]>();for(const name of schemaObjects(s.proof).filter(row=>row.type==='table').map(row=>row.name))expected.set(name,[...forwardRows(s.proof,name)]);expected.set('sqlite_sequence',[...forwardRows(s.proof,'sqlite_sequence')]);
    for(const [table,records] of desired){
      const before=expected.get(table)!,columns=(s.proof.prepare(`PRAGMA table_xinfo("${table}")`).all() as {name:string}[]).map(row=>row.name),keys=table==='music_documents'?['kind','position']:table==='music_legacy_identity'?['table_name','row_number']:['source','entity_type','source_id'],key=(row:Record<string,unknown>)=>JSON.stringify(keys.map(name=>String(row[name])));
      const byKey=new Map(before.map(row=>[key(row),row])),replaced=new Set(records.map(key));let high=before.reduce((high,row)=>row.__forward_rowid__>high?row.__forward_rowid__:high,0n);
      const retained=before.filter(row=>!replaced.has(key(row))&&(table==='music_documents'?!['entry_source','profile_source','settings','shouts','shoutHistory','identity_source','source_rebase'].includes(String(row.kind)):table==='music_legacy_identity'?false:row.source!=='music-identity'&&!(row.source==='music'&&['entry','profile','settings','shouts','shoutHistory'].includes(String(row.entity_type)))));
      const final=[...retained];for(const record of records){const old=byKey.get(key(record)),rid=old?.__forward_rowid__??++high;if(rid>9223372036854775807n)reject();const row:ForwardRow={__forward_rowid__:rid};columns.forEach(name=>{row[name]=typeof record[name]==='number'?BigInt(record[name]):record[name];});columns.forEach((name,index)=>row['__forward_type_'+index]=typeof record[name]==='number'?'integer':'text');final.push(row);}expected.set(table,final);
    }
    const runs=expected.get('migration_runs')!,rid=runs.reduce((high,row)=>row.__forward_rowid__>high?row.__forward_rowid__:high,0n)+1n;if(rid>9223372036854775807n)reject();
    runs.push({__forward_rowid__:rid,source_digest:run,manifest_json:JSON.stringify({version:1,kind:'forward_source_rebase',evidenceSha256:forwardHash(JSON.stringify(evidence)),sourcePins:pins,rebasedAt:held.rebasedAt}),report_json:JSON.stringify({sourceEvidenceRebased:true,originalBindingsPreserved:true,frozenAuditMappings:evidence.auditMappings.length,externalRetentionRequired:true,latestErasureReplayRequired:true,releaseEligible:false}),created_at:held.rebasedAt,__forward_type_0:'text',__forward_type_1:'text',__forward_type_2:'text',__forward_type_3:'text'});
    const counts:Record<string,number>={},digests:Record<string,string>={};for(const [table,rows] of expected){const actual=[...forwardRows(db,table)];if(!forwardEqual(rows.sort((a,b)=>a.__forward_rowid__<b.__forward_rowid__?-1:1),actual))throw Error('Forward source rebase row inventory differs in '+table);counts[table]=actual.length;digests[table]=forwardHash(forwardCanonical(actual));}
    for(const mapping of evidence.auditMappings){const id=BigInt(mapping.legacyId),original=[...forwardRows(s.sources.original.nativeIdentity,'link_audit')].find(row=>row.id===id),current=[...forwardRows(s.identity,'link_audit')].find(row=>row.id===id);if(!original||!forwardEqual(original,current))reject();}
    const intents=decodeErasureJournal(new TextDecoder('utf8',{fatal:true}).decode(held.proofs.sources.nativeJournal.bytes)),journal:ErasureJournal={read:()=>intents,append(){throw Error('Read-only source rebase journal');}};
    if(!forwardEqual(readSourceRebaseEvidence(db,intents),evidence))reject();
    const projected=projectRollbackMusic(db,journal);if(!musicEqual(projected.keys,music.keys)||!musicEqual(projected.data,{...music.data,settings:{}}))reject();
    const identity=projectRollbackIdentity(db,journal,projected);try{if(!forwardEqual(identity.report.auditMappings,evidence.auditMappings))reject();if(identity.report.highWater!==String((s.identity.prepare("SELECT seq FROM sqlite_sequence WHERE name='link_audit'").safeIntegers(true).get() as {seq:bigint}|undefined)?.seq??0n))reject();}finally{identity.db.close();}
    if((db.prepare('SELECT recovery_required FROM rebuild_storage').get() as {recovery_required:number}).recovery_required!==1)reject();
    return {version:1 as const,sourcePins:pins,sourceDigest:run,checkedTables:counts,rowsDigest:forwardHash(forwardCanonical(digests)),rollbackProjectionVerified:true as const,originalBindingsPreserved:true as const,frozenAuditMappings:evidence.auditMappings.length,recoveryRequired:true as const,releaseEligible:false as const};
  }finally{db.close();s.close();}
}
export function verifyForwardSourceRebaseBundle(input:ForwardSourceRebaseInput,bundle:{nativeImage:Buffer;nativeJournal:Buffer;retainedProofImage:Buffer;retainedBusinessImage:Buffer;musicSources:Buffer;identitySources:Buffer}){
  const held=copyForwardSourceRebaseInput(input);for(const [actual,expected] of [[bundle.nativeJournal,held.proofs.sources.nativeJournal.bytes],[bundle.retainedProofImage,held.proofImage.bytes],[bundle.retainedBusinessImage,held.proofs.businessImage.bytes],[bundle.musicSources,held.proofs.musicSources.bytes],[bundle.identitySources,held.proofs.identitySources.bytes]])if(!Buffer.isBuffer(actual)||!actual.equals(expected!))reject();
  return {...verifyForwardSourceRebase(input,bundle.nativeImage),retainedOriginalImagesVerified:true as const,pairedSourceBytesVerified:true as const};
}
