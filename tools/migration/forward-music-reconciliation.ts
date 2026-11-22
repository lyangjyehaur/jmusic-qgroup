import Database from 'better-sqlite3';
import type {DB} from '@qgroup/database';
import {object,profileId,jsonObjectKeys,type Json} from './music-codec';
import type {RollbackMusic} from './rollback-music';
import {identityTables} from './rollback-identity-source';
import {forwardRows,forwardRowReader,forwardEqual,forwardHash,forwardCanonical,assertForwardImage} from './forward-board-storage';
import {copyForwardMusicInput,openForwardMusicSources,assertForwardIdentity,musicEqual,musicCanonical,type ForwardMusicInput,type ForwardMusicSources} from './forward-music-sources';
import {validateForwardMusicGraph} from './forward-music-validation';

function reject():never{throw Error('Forward music reconciliation failed; retain every source');}
function expected<T>(before:T|undefined,current:T|undefined,legacy:T|undefined,equal:(a:unknown,b:unknown)=>boolean):T|undefined{
  if(equal(before,legacy))return current;if(!equal(before,current)&&!equal(current,legacy))reject();return legacy;
}
/** Independent order oracle; no merge helper or report is consulted. */
function order(before:string[],current:string[],legacy:string[],present:Set<string>,actual:string[]){
  const lists=[before,current,legacy].map(list=>list.filter(id=>present.has(id))),[b,n,o]=lists as [string[],string[],string[]],eq=(a:string[],b:string[])=>JSON.stringify(a)===JSON.stringify(b);
  const chosen=eq(b,o)?[n]:eq(b,n)?[o]:[n,o],discovery=[...new Set(lists.flat())],rank=new Map(discovery.map((id,index)=>[id,index])),constraints=new Set<string>();
  for(const list of chosen)for(let index=1;index<list.length;index++)constraints.add(JSON.stringify([list[index-1],list[index]]));
  const remaining=new Set(discovery),wanted:string[]=[];
  while(remaining.size){const blocked=new Set([...constraints].map(value=>JSON.parse(value) as [string,string]).filter(([a,b])=>remaining.has(a)&&remaining.has(b)).map(([,b])=>b)),ready=[...remaining].filter(id=>!blocked.has(id)).sort((a,b)=>rank.get(a)!-rank.get(b)!);if(!ready.length)reject();wanted.push(ready[0]!);remaining.delete(ready[0]!);}
  if(!eq(wanted,actual)||wanted.length!==present.size)reject();
}
/** Reads all source rows and derives expectations independently. It never
 * invokes the merger or accepts its decisions, mapping list or summary as proof. */
export function reconcileForwardMusicSources(s:ForwardMusicSources,music:RollbackMusic,identity:DB){
  validateForwardMusicGraph(s,music,identity);
  return reconcileForwardMusicRows(s,music,identity);
}
/** Internal complete row/order oracle; a caller must validate the final graph
 * before returning any effective source pair or native image. */
export function reconcileForwardMusicRows(s:ForwardMusicSources,music:RollbackMusic,identity:DB){
  assertForwardIdentity(identity);
  const sources=[s.baseline.data,s.native.data,s.old],counts:Record<string,number>={};
  if(Object.keys(music.data).sort().join()!==['entries','members','settings','shouts','shoutHistory','trend'].sort().join())reject();
  for(const kind of ['entries','members']){
    const [base,current,old]=sources.map(data=>object(data[kind],'verify music '+kind)) as [ReturnType<typeof object>,ReturnType<typeof object>,ReturnType<typeof object>],actual=object(music.data[kind],'candidate music '+kind),wanted=new Map<string,Json>();
    for(const key of new Set([...Object.keys(base),...Object.keys(current),...Object.keys(old)])){const value=expected(base[key],current[key],old[key],musicEqual);if(value!==undefined)wanted.set(key,value);}
    if(Object.keys(actual).length!==wanted.size||[...wanted].some(([key,value])=>!Object.hasOwn(actual,key)||!musicEqual(value,actual[key])))reject();
    order(jsonObjectKeys(base),jsonObjectKeys(current),jsonObjectKeys(old),new Set(wanted.keys()),jsonObjectKeys(actual));counts[kind]=wanted.size;
  }
  const [beforeSettings,currentSettings,legacySettings]=sources.map(data=>data.settings??{});if(!musicEqual(expected(beforeSettings,currentSettings,legacySettings,musicEqual),music.data.settings))reject();
  const [beforeTrend,currentTrend,legacyTrend]=sources.map(data=>data.trend??[]);let expectedTrend;
  if(musicEqual(beforeTrend,legacyTrend)||musicEqual(currentTrend,legacyTrend))expectedTrend=currentTrend;
  else if(musicEqual(beforeTrend,currentTrend))expectedTrend=legacyTrend;
  else{
    if(!Array.isArray(beforeTrend)||!Array.isArray(currentTrend)||!Array.isArray(legacyTrend)||currentTrend.length<beforeTrend.length||legacyTrend.length<beforeTrend.length)return reject();
    for(let index=0;index<beforeTrend.length;index++)if(!musicEqual(beforeTrend[index],currentTrend[index])||!musicEqual(beforeTrend[index],legacyTrend[index]))reject();
    let common=beforeTrend.length;for(;common<Math.min(currentTrend.length,legacyTrend.length);common++)if(!musicEqual(currentTrend[common],legacyTrend[common]))break;
    expectedTrend=currentTrend.concat(legacyTrend.slice(common));
  }
  if(!musicEqual(expectedTrend,music.data.trend))reject();
  type Shout={kind:string;value:Json};
  const lists=[...sources,music.data].map(data=>{
    const rows=new Map<string,Shout>();for(const kind of ['shouts','shoutHistory']){const list=data[kind]??[];if(!Array.isArray(list))reject();for(const item of list){const value=object(item,'verify forward shout');if(typeof value.id!=='string'||rows.has(value.id))reject();rows.set(value.id,{kind,value});}}return rows;
  });
  const [base,current,old,actual]=lists as [Map<string,Shout>,Map<string,Shout>,Map<string,Shout>,Map<string,Shout>],wanted=new Map<string,Shout>();
  for(const id of new Set([...base.keys(),...current.keys(),...old.keys()])){const value=expected(base.get(id),current.get(id),old.get(id),musicEqual);if(value)wanted.set(id,value);}
  if(actual.size!==wanted.size||[...wanted].some(([id,row])=>!musicEqual(row,actual.get(id))))reject();
  for(const kind of ['shouts','shoutHistory']){const present=new Set([...wanted].filter(([,row])=>row.kind===kind).map(([id])=>id)),ids=lists.map(map=>[...map].filter(([,row])=>row.kind===kind).map(([id])=>id));order(ids[0]!,ids[1]!,ids[2]!,present,ids[3]!);counts[kind]=present.size;}
  const members=object(music.data.members,'verify forward keys'),mapping=[...s.native.keys,...jsonObjectKeys(members).filter(key=>!s.native.keys.some(row=>row.legacyKey===key)).map(key=>({profileId:profileId(key),legacyKey:key,mode:'preserved' as const,erased:false}))];
  if(!musicEqual(music.keys,mapping))reject();
  const identityCounts:Record<string,number>={},digest:string[]=[];
  for(const table of identityTables){
    const dbs=[s.baselineIdentity,s.nativeIdentity,s.oldIdentity,identity],reads=dbs.map(db=>forwardRowReader(db,table)),ids=new Set(dbs.flatMap(db=>[...forwardRows(db,table)].map(row=>row.__forward_rowid__)));let count=0;
    for(const id of [...ids].sort((a,b)=>a<b?-1:a>b?1:0)){const [b,n,o,a]=reads.map(read=>read(id)),value=expected(b,n,o,forwardEqual);if(!forwardEqual(value,a))reject();if(a){count++;digest.push(forwardCanonical([table,a]));}}
    identityCounts[table]=count;
  }
  const sequence=(db:DB)=>(db.prepare("SELECT name,seq FROM sqlite_sequence ORDER BY name").safeIntegers(true).all() as {name:string;seq:bigint}[]),n=sequence(s.nativeIdentity)[0]?.seq,o=sequence(s.oldIdentity)[0]?.seq,max=n===undefined?o:o===undefined?n:n>o?n:o;
  if(!forwardEqual(sequence(identity),max===undefined?[]:[{name:'link_audit',seq:max}]))reject();
  return {version:1 as const,documents:counts,identityTables:identityCounts,profileMappings:mapping.length,identityHighWater:max?.toString()??null,sourceDigest:forwardHash(musicCanonical(music)+'\n'+digest.join('\n')),authenticationActive:false as const,releaseEligible:false as const};
}
export function verifyForwardMusicMerge(input:ForwardMusicInput,music:RollbackMusic,identityImage:Buffer){
  const held=copyForwardMusicInput(input);assertForwardImage(identityImage);const sources=openForwardMusicSources(held);let db:DB|undefined;
  try{db=new Database(Buffer.from(identityImage));return reconcileForwardMusicSources(sources,music,db);}finally{db?.close();sources.close();}
}
