import {readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {erasureRequestId, decodeErasureJournal} from './erasure-journal';
import {sourceDirectory,sourceStat,snapshotRollbackFile} from '../../../packages/runtime/src/private-source-files';
import {digest,parseJson,type Json} from '../../../packages/runtime/src/strict-json';

export const authorityDomains=['board','music','unified'] as const;
export type AuthorityDomain=typeof authorityDomains[number];
const sha=z.string().regex(/^[a-f0-9]{64}$/),domain=z.enum(authorityDomains),limit=64*1024*1024;
const descriptor=z.object({size:z.number().int().nonnegative().safe().max(limit),sha256:sha}).strict();
export const ErasureAuthorityManifest=z.object({version:z.literal(1),kind:z.literal('qgroup-private-erasure-authority'),authorityId:z.string().regex(/^[a-f0-9]{32}$/),createdAt:z.iso.datetime(),sourcePackageSha256:sha,checkpointSha256:sha,journalSha256:sha,
  baseline:z.array(z.object({domain,path:z.string(),size:descriptor.shape.size,sha256:sha}).strict()).length(3),rollbackEligible:z.literal(false)}).strict().refine(row=>JSON.stringify(row.baseline.map(file=>[file.domain,file.path]))===JSON.stringify(authorityDomains.map(domain=>[domain,'baseline/'+domain+'.erasures.jsonl'])));
export const ErasureAuthorityHead=z.object({version:z.literal(1),authoritySha256:sha,sequence:z.number().int().nonnegative().safe().max(999999999999),recordSha256:sha.nullable(),ledgers:z.object({board:descriptor,music:descriptor,unified:descriptor}).strict()}).strict().refine(row=>(row.sequence===0)===(row.recordSha256===null));
const keyedScope=(key:z.ZodString)=>z.array(z.object({key,sha256:sha}).strict()).max(100000).refine(rows=>new Set(rows.map(row=>row.key)).size===rows.length);
const orderedScope=z.array(z.object({index:z.number().int().nonnegative().safe(),sha256:sha}).strict()).max(100000).refine(rows=>rows.every((row,index)=>row.index===index));
const musicResetScope=z.object({entries:keyedScope(z.string().max(1024).refine(value=>!/[\p{Surrogate}]/u.test(value))),members:keyedScope(z.string().regex(/^(?:[0-9]{4,12}|m_[a-f0-9]{24})$/)),shouts:orderedScope,shoutHistory:orderedScope,trend:orderedScope}).strict();
export const LegacyMusicResetOperation=z.object({kind:z.literal('legacy_music_reset'),source:descriptor,loadedSha256:sha,erasedAtJson:z.string().max(80).refine(value=>{try{const time=parseJson(value);return typeof time==='number'&&time>=0&&time<=8640000000000;}catch{return false;}}),scope:musicResetScope,loadedScope:musicResetScope}).strict();
const recordFields={authoritySha256:sha,sequence:z.number().int().positive().safe().max(999999999999),previousRecordSha256:sha,domain,suffixBase64:z.string().max(90*1024*1024),ledgerSize:descriptor.shape.size,ledgerSha256:sha};
export const ErasureAuthorityRecord=z.discriminatedUnion('version',[
  z.object({version:z.literal(1),...recordFields}).strict(),
  z.object({version:z.literal(2),...recordFields,domain:z.literal('music'),operation:LegacyMusicResetOperation}).strict(),
]);
/** The member suffix is the original ledger representation of this same reset.
 * An empty member set still records a reset of terms, shouts and trends. */
export function validateAuthorityRecordSuffix(record:z.infer<typeof ErasureAuthorityRecord>,suffix:Buffer){
  if(suffix.toString('base64')!==record.suffixBase64||record.version===1&&!suffix.length)throw Error('Invalid authority suffix');
  validateAuthorityLedger(record.domain,suffix);
  if(record.version===2){const rows=decode(suffix).split('\n').filter(line=>line.trim()).map(line=>parseJson(line)) as {qq:string;erased_at:Json}[];
    if(JSON.stringify(rows.map(row=>row.qq))!==JSON.stringify(record.operation.loadedScope.members.map(row=>row.key))||rows.some(row=>row.erased_at!==parseJson(record.operation.erasedAtJson)))throw Error('Reset member ledger differs from structured scope');}
}
export const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)+'\n');
function decode(bytes:Buffer){return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}
export function validateAuthorityLedger(domain:AuthorityDomain,bytes:Buffer,seen=new Map<string,string>()){
  if(bytes.length>limit)throw Error('Authority ledger exceeds limit');const text=decode(bytes);
  if(text&&!text.endsWith('\n'))throw Error('Incomplete authority ledger');
  for(const line of text.split('\n').filter(line=>line.trim()))parseJson(line);
  if(domain!=='music'){
    const rows=decodeErasureJournal(text);
    for(const row of rows){if(domain==='board'&&'version' in row)throw Error('Board authority requires original closure records');const id=erasureRequestId(row),value=JSON.stringify(row);if(seen.has(id)&&seen.get(id)!==value)throw Error('Conflicting authority intent');seen.set(id,value);}
    return rows.length;
  }
  const rows=text.split('\n').filter(line=>line.trim()).map(line=>parseJson(line));
  for(const row of rows)if(!row||typeof row!=='object'||Array.isArray(row)||JSON.stringify(Object.keys(row).sort())!==JSON.stringify(['erased_at','qq'])||typeof row.qq!=='string'||!/^(?:[0-9]{4,12}|m_[a-f0-9]{24})$/.test(row.qq))throw Error('Invalid music authority intent');
  return rows.length;
}
export function privateDirectory(path:string){const stat=sourceDirectory(path);if(!process.getuid||stat.uid!==BigInt(process.getuid())||(stat.mode&0o7777n)!==0o700n)throw Error('Authority directory must be private');return stat;}
export type AuthorityFileGuard=(path:string)=>void;
function guardFile(guard:AuthorityFileGuard|undefined,path:string){const value:unknown=guard?.(path);if(value!==null&&(typeof value==='object'||typeof value==='function')&&'then' in value)throw Error('Authority file guard must be synchronous');}
export function privateFile(path:string,maximum:number,guard?:AuthorityFileGuard){guardFile(guard,path);const stat=sourceStat(path);if(!process.getuid||!stat?.isFile()||stat.nlink!==1n||stat.uid!==BigInt(process.getuid())||(stat.mode&0o7777n)!==0o600n)throw Error('Authority file must be private');const saved=snapshotRollbackFile(path,maximum);return {...saved,assertUnchanged(){guardFile(guard,path);saved.assertUnchanged();}};}
function canonical<T>(schema:z.ZodType<T>,bytes:Buffer){const value=schema.parse(parseJson(decode(bytes)));if(!bytes.equals(encode(value)))throw Error('Noncanonical authority metadata');return value;}
/** A snapshot reader. It rejects an in-progress publication rather than mixing
 * heads and records; immutable baseline is bound to an independently saved pin.
 * No live SQLite or service file is opened, modified or restored here. */
export function readRollbackErasureAuthority(root:string,pin:string,options:{beforeFile?:AuthorityFileGuard;includeUnpublished?:boolean}={}){
  if(resolve(root)!==root||!sha.safeParse(pin).success)throw Error('Canonical authority and external pin required');
  const identity=privateDirectory(root),baselineIdentity=privateDirectory(join(root,'baseline')),recordsIdentity=privateDirectory(join(root,'records'));
  const file=(path:string,maximum:number)=>privateFile(path,maximum,options.beforeFile);
  const manifestFile=file(join(root,'authority-manifest.json'),16*1024*1024);if(!manifestFile.bytes||manifestFile.sha256!==pin)throw Error('Authority manifest pin differs');
  const manifest=canonical(ErasureAuthorityManifest,manifestFile.bytes),headFile=file(join(root,'authority-head.json'),4096),lockFile=file(join(root,'.authority.lock'),0);if(!headFile.bytes||!lockFile.bytes||lockFile.bytes.length)throw Error('Invalid authority components');
  const publishedHead=canonical(ErasureAuthorityHead,headFile.bytes);if(publishedHead.authoritySha256!==pin||publishedHead.sequence>100000)throw Error('Authority head belongs to another baseline or exceeds limit');
  const held=[manifestFile,headFile,lockFile],ledgers={} as Record<AuthorityDomain,Buffer>,chunks={} as Record<AuthorityDomain,Buffer[]>,sizes={} as Record<AuthorityDomain,number>,hashes={} as Record<AuthorityDomain,ReturnType<typeof createHash>>,seen={} as Record<AuthorityDomain,Map<string,string>>;
  for(const row of manifest.baseline){const saved=file(join(root,row.path),limit);if(!saved.bytes||saved.bytes.length!==row.size||saved.sha256!==row.sha256)throw Error('Authority baseline differs');held.push(saved);ledgers[row.domain]=Buffer.from(saved.bytes);chunks[row.domain]=[ledgers[row.domain]];sizes[row.domain]=saved.bytes.length;hashes[row.domain]=createHash('sha256').update(saved.bytes);seen[row.domain]=new Map();validateAuthorityLedger(row.domain,saved.bytes,seen[row.domain]);}
  let previous=pin;
  const count=readdirSync(join(root,'records')).length,sequence=publishedHead.sequence;
  if(count!==sequence&&!(options.includeUnpublished&&count===sequence+1)||count>100000)throw Error('Authority publication incomplete or inventory differs');
  const paths=Array.from({length:count},(_,i)=>String(i+1).padStart(12,'0')+'.json'),recordPins:string[]=[],records:z.infer<typeof ErasureAuthorityRecord>[]=[];
  const currentHead=(sequence:number)=>ErasureAuthorityHead.parse({version:1,authoritySha256:pin,sequence,recordSha256:sequence?previous:null,ledgers:Object.fromEntries(authorityDomains.map(domain=>[domain,{size:sizes[domain],sha256:hashes[domain].copy().digest('hex')}]))});
  if(sequence===0&&JSON.stringify(publishedHead)!==JSON.stringify(currentHead(0)))throw Error('Authority head ledger differs');
  for(const [index,path] of paths.entries()){
    const saved=file(join(root,'records',path),90*1024*1024);if(!saved.bytes)throw Error('Missing authority record');held.push(saved);const row=canonical(ErasureAuthorityRecord,saved.bytes),suffix=Buffer.from(row.suffixBase64,'base64');
    if(row.authoritySha256!==pin||row.sequence!==index+1||row.previousRecordSha256!==previous)throw Error('Authority record chain differs');validateAuthorityRecordSuffix(row,suffix);
    sizes[row.domain]+=suffix.length;hashes[row.domain].update(suffix);if(sizes[row.domain]!==row.ledgerSize||hashes[row.domain].copy().digest('hex')!==row.ledgerSha256)throw Error('Authority record ledger differs');validateAuthorityLedger(row.domain,suffix,seen[row.domain]);chunks[row.domain].push(suffix);previous=saved.sha256!;recordPins.push(previous);records.push(row);
    if(index+1===sequence&&JSON.stringify(publishedHead)!==JSON.stringify(currentHead(sequence)))throw Error('Authority head lost a recorded intent');
  }
  const head=currentHead(count),pendingPublication=count!==sequence,sourceHeadBytes=Buffer.from(headFile.bytes);
  for(const domain of authorityDomains)ledgers[domain]=Buffer.concat(chunks[domain]);
  function inventory(extraRootFiles:string[]=[]){if(extraRootFiles.some(name=>!/^\.head-[a-f0-9]{32}\.tmp$/.test(name))||new Set(extraRootFiles).size!==extraRootFiles.length||JSON.stringify(readdirSync(root).sort())!==JSON.stringify(['.authority.lock','authority-head.json','authority-manifest.json','baseline','records',...extraRootFiles].sort())||JSON.stringify(readdirSync(join(root,'baseline')).sort())!==JSON.stringify(authorityDomains.map(domain=>domain+'.erasures.jsonl').sort())||JSON.stringify(readdirSync(join(root,'records')).sort())!==JSON.stringify(paths))throw Error('Authority publication incomplete or inventory differs');}
  const view=()=>digest(JSON.stringify({manifest,head,publishedHead,pendingPublication,sourceHeadSha256:digest(sourceHeadBytes),recordPins,records,ledgerKeys:Object.keys(ledgers).sort(),ledgers:Object.fromEntries(authorityDomains.map(domain=>[domain,digest(ledgers[domain])]))})),originalView=view();
  function assertUnchanged(extraRootFiles:string[]=[]){for(const [path,original] of [[root,identity],[join(root,'baseline'),baselineIdentity],[join(root,'records'),recordsIdentity]] as const){const current=privateDirectory(path);if(current.dev!==original.dev||current.ino!==original.ino)throw Error('Authority directory replaced');}for(const file of held)file.assertUnchanged();if(view()!==originalView)throw Error('Authority snapshot view changed');inventory(extraRootFiles);}
  assertUnchanged();return {manifest,head,publishedHead,pendingPublication,sourceHeadBytes,recordPins,records,ledgers,manifestSha256:pin,assertUnchanged,rollbackEligible:false as const};
}
