import Database from 'better-sqlite3';
import {object,profileId,cloneJson,jsonObjectKeys,jsonObjectFromEntries,type ObjectValue,type Json} from './music-codec';
import {identityTables,identityColumns,quoteIdentity} from './rollback-identity-source';
import {forwardRows,forwardEqual,type ForwardRow} from './forward-board-storage';
import {musicEqual,type ForwardMusicSources} from './forward-music-sources';
import type {RollbackMusic} from './rollback-music';
import {mergeForwardOrder} from './forward-music-order';

function choose<T>(base:T|undefined,native:T|undefined,old:T|undefined,equal:(a:unknown,b:unknown)=>boolean,label:string){
  if(equal(old,base))return native;
  if(!equal(native,base)&&!equal(native,old))throw Error('Forward music conflict in '+label+'; explicit reconciliation required');
  return old;
}
function documents(base:ObjectValue,native:ObjectValue,old:ObjectValue,label:string){
  const values=new Map<string,Json>();for(const key of new Set([...jsonObjectKeys(base),...jsonObjectKeys(native),...jsonObjectKeys(old)])){
    const value=choose(base[key],native[key],old[key],musicEqual,label);if(value!==undefined)values.set(key,cloneJson(value));
  }
  return jsonObjectFromEntries(mergeForwardOrder(jsonObjectKeys(base),jsonObjectKeys(native),jsonObjectKeys(old),new Set(values.keys())).map(key=>[key,values.get(key)!]));
}
function trend(before:Json,current:Json,legacy:Json){
  if(musicEqual(before,legacy)||musicEqual(current,legacy))return structuredClone(current);
  if(musicEqual(before,current))return structuredClone(legacy);
  if(!Array.isArray(before)||!Array.isArray(current)||!Array.isArray(legacy)||current.length<before.length||legacy.length<before.length||before.some((point,index)=>!musicEqual(point,current[index])||!musicEqual(point,legacy[index])))throw Error('Forward music conflict in trend; explicit reconciliation required');
  let shared=before.length;while(shared<current.length&&shared<legacy.length&&musicEqual(current[shared],legacy[shared]))shared++;
  // Preserve the native prefix/row identities. Exact shared-prefix samples are
  // already represented; retain every distinct old append in its source order.
  return structuredClone([...current,...legacy.slice(shared)]);
}
type Shout={kind:'shouts'|'shoutHistory';value:Json};
function shouts(data:ObjectValue){
  const result=new Map<string,Shout>();
  for(const kind of ['shouts','shoutHistory'] as const){const list=data[kind]??[];if(!Array.isArray(list))throw Error('Invalid forward shout list');for(const item of list){const value=object(item,'forward shout');if(typeof value.id!=='string'||!value.id||result.has(value.id))throw Error('Duplicate forward shout ID');result.set(value.id,{kind,value});}}
  return result;
}
/** Internal unpublished source relation only; callers must independently
 * reconcile every row and the final authority-constrained semantic graph. */
export function mergeForwardMusicRows(s:ForwardMusicSources){
    const sources=[s.baseline.data,s.native.data,s.old];
    const data:ObjectValue={};for(const kind of ['entries','members'])data[kind]=documents(...sources.map(source=>object(source[kind],'forward '+kind)) as [ObjectValue,ObjectValue,ObjectValue],kind);
    data.settings=structuredClone(choose(...sources.map(source=>source.settings??{}) as [Json,Json,Json],musicEqual,'settings')!);
    data.trend=trend(...sources.map(source=>source.trend??[]) as [Json,Json,Json]);
    const shoutSources=sources.map(shouts),mergedShouts=new Map<string,Shout>();
    for(const id of new Set(shoutSources.flatMap(map=>[...map.keys()]))){const wanted=choose(...shoutSources.map(map=>map.get(id)) as [Shout|undefined,Shout|undefined,Shout|undefined],musicEqual,'shouts');if(wanted)mergedShouts.set(id,structuredClone(wanted));}
    for(const kind of ['shouts','shoutHistory'] as const){const present=new Set([...mergedShouts].filter(([,row])=>row.kind===kind).map(([id])=>id)),orders=shoutSources.map(map=>[...map].filter(([,row])=>row.kind===kind).map(([id])=>id));data[kind]=mergeForwardOrder(...orders as [string[],string[],string[]],present).map(id=>mergedShouts.get(id)!.value);}
    const members=object(data.members,'merged members'),mapping=structuredClone(s.native.keys),reserved=new Set(mapping.map(row=>row.profileId));
    for(const key of jsonObjectKeys(members))if(!mapping.some(row=>row.legacyKey===key)){const id=profileId(key);if(reserved.has(id))throw Error('Forward new profile ID collision');reserved.add(id);mapping.push({profileId:id,legacyKey:key,mode:'preserved',erased:false});}
    const music:RollbackMusic={data,keys:mapping};const identity=new Database(s.nativeIdentity.serialize()),candidate=identity;
    try{
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
    return {music,identity};
    }catch(error){identity.close();throw error;}
}
