import Database from 'better-sqlite3';
import {object,profileId,type ObjectValue,type Json} from './music-codec';
import {identityTables,identityColumns,quoteIdentity} from './rollback-identity-source';
import {forwardRows,forwardEqual,forwardHash,type ForwardRow} from './forward-board-storage';
import {copyForwardMusicInput,openForwardMusicSources,musicEqual,type ForwardMusicInput} from './forward-music-sources';
import {reconcileForwardMusicSources} from './forward-music-reconciliation';
import type {RollbackMusic} from './rollback-music';
import {mergeForwardOrder} from './forward-music-order';

function choose<T>(base:T|undefined,native:T|undefined,old:T|undefined,equal:(a:unknown,b:unknown)=>boolean,label:string){
  if(equal(old,base))return native;
  if(!equal(native,base)&&!equal(native,old))throw Error('Forward music conflict in '+label+'; explicit reconciliation required');
  return old;
}
function documents(base:ObjectValue,native:ObjectValue,old:ObjectValue,label:string){
  const values=new Map<string,Json>();for(const key of new Set([...Object.keys(base),...Object.keys(native),...Object.keys(old)])){
    const value=choose(base[key],native[key],old[key],musicEqual,label);if(value!==undefined)values.set(key,structuredClone(value));
  }
  return Object.fromEntries(mergeForwardOrder(Object.keys(base),Object.keys(native),Object.keys(old),new Set(values.keys())).map(key=>[key,values.get(key)!]));
}
type Shout={kind:'shouts'|'shoutHistory';value:Json};
function shouts(data:ObjectValue){
  const result=new Map<string,Shout>();
  for(const kind of ['shouts','shoutHistory'] as const){const list=data[kind]??[];if(!Array.isArray(list))throw Error('Invalid forward shout list');for(const item of list){const value=object(item,'forward shout');if(typeof value.id!=='string'||!value.id||result.has(value.id))throw Error('Duplicate forward shout ID');result.set(value.id,{kind,value});}}
  return result;
}
/** Merge private legacy-shaped business sources. No native image, credential
 * activation, source-file access or authority mutation. Full native reconstruction
 * must preserve native-only revisions, PINs, receipts and original source evidence. */
export function mergeForwardMusic(input:ForwardMusicInput,assertBoundary?:()=>void){
  const held=copyForwardMusicInput(input),s=openForwardMusicSources(held);let identity:Database.Database|undefined;
  const guard=()=>{const value:unknown=assertBoundary?.();if(value!==null&&(typeof value==='object'||typeof value==='function')&&'then' in value)throw Error('Forward music boundary must be synchronous');for(const name of Object.keys(held) as (keyof ForwardMusicInput)[])if(input[name].sha256!==held[name].sha256||!input[name].bytes.equals(held[name].bytes))throw Error('Forward music source changed');};
  try{
    guard();const sources=[s.baseline.data,s.native.data,s.old];
    const data:ObjectValue={};for(const kind of ['entries','members'])data[kind]=documents(...sources.map(source=>object(source[kind],'forward '+kind)) as [ObjectValue,ObjectValue,ObjectValue],kind);
    for(const kind of ['settings','trend'])data[kind]=structuredClone(choose(...sources.map(source=>source[kind]??(kind==='settings'?{}:[])) as [Json,Json,Json],musicEqual,kind)!);
    const shoutSources=sources.map(shouts),mergedShouts=new Map<string,Shout>();
    for(const id of new Set(shoutSources.flatMap(map=>[...map.keys()]))){const wanted=choose(...shoutSources.map(map=>map.get(id)) as [Shout|undefined,Shout|undefined,Shout|undefined],musicEqual,'shouts');if(wanted)mergedShouts.set(id,structuredClone(wanted));}
    for(const kind of ['shouts','shoutHistory'] as const){const present=new Set([...mergedShouts].filter(([,row])=>row.kind===kind).map(([id])=>id)),orders=shoutSources.map(map=>[...map].filter(([,row])=>row.kind===kind).map(([id])=>id));data[kind]=mergeForwardOrder(...orders as [string[],string[],string[]],present).map(id=>mergedShouts.get(id)!.value);}
    const members=object(data.members,'merged members'),mapping=structuredClone(s.native.keys),reserved=new Set(mapping.map(row=>row.profileId));
    for(const key of Object.keys(members))if(!mapping.some(row=>row.legacyKey===key)){const id=profileId(key);if(reserved.has(id))throw Error('Forward new profile ID collision');reserved.add(id);mapping.push({profileId:id,legacyKey:key,mode:'preserved',erased:false});}
    const music:RollbackMusic={data,keys:mapping};identity=new Database(s.nativeIdentity.serialize());const candidate=identity;
    candidate.transaction(()=>{
      for(const table of identityTables){
        const maps=[s.baselineIdentity,s.nativeIdentity,s.oldIdentity].map(db=>new Map([...forwardRows(db,table)].map(row=>[row.__forward_rowid__,row]))),ids=new Set(maps.flatMap(map=>[...map.keys()])),pending:ForwardRow[]=[];
        const remove=candidate.prepare(`DELETE FROM ${quoteIdentity(table)} WHERE rowid=?`),insert=candidate.prepare(`INSERT INTO ${quoteIdentity(table)}(rowid,${identityColumns[table].map(quoteIdentity).join(',')}) VALUES(${Array(identityColumns[table].length+1).fill('?').join(',')})`);
        for(const id of ids){const [base,native,old]=maps.map(map=>map.get(id)),wanted=choose(base,native,old,forwardEqual,'identity '+table);if(forwardEqual(wanted,native))continue;remove.run(id);if(wanted)pending.push(wanted);}
        for(const row of pending)insert.run(row.__forward_rowid__,...identityColumns[table].map(column=>row[column]));
      }
      const seq=(db:Database.Database)=>(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='link_audit'").safeIntegers(true).get() as {seq:bigint}|undefined)?.seq;
      const a=seq(s.nativeIdentity),b=seq(s.oldIdentity),maximum=a===undefined?b:b===undefined?a:a>b?a:b;candidate.exec('DELETE FROM sqlite_sequence');if(maximum!==undefined)candidate.prepare("INSERT INTO sqlite_sequence VALUES('link_audit',?)").run(maximum);
    }).immediate();
    const reconciliation=reconcileForwardMusicSources(s,music,candidate);guard();const identityImage=candidate.serialize();
    return {music,identityImage,report:{version:1 as const,sourcePins:Object.fromEntries(Object.entries(held).map(([key,item])=>[key,item.sha256])),identityImageSha256:forwardHash(identityImage),reconciliation,sourceOnly:true as const,nativeReconstructionRequired:true as const,authenticationActive:false as const,recoveryRequired:true as const,rollbackEligible:false as const,releaseEligible:false as const,remaining:['native_only_state_and_source_provenance_reconstruction','complete_authority_backed_erasure_and_reset_replay','media_browser_pending_proof_reconciliation','stopped_source_capture_and_authority_epoch_rebase','fixed_service_versions_and_audited_activation']}};
  }finally{identity?.close();s.close();}
}
