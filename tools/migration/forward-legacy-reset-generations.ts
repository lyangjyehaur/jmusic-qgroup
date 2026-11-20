import Database from 'better-sqlite3';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {readRollbackErasureAuthority} from '../../apps/api/src/erasure-authority-protocol';
import {pinRollbackTree} from '../../packages/runtime/src/private-source-files';
import {assertRollbackSource} from './rollback-source';
import {assertForwardImage,forwardHash,type PinnedForwardBytes} from './forward-board-storage';
import {musicBytes} from './forward-music-sources';
import {object} from './music-codec';
import {readForwardLegacyResetVault,type LegacyResetVaultInput} from './forward-legacy-reset-vault';

export type LegacyResetGenerationInput={vault:LegacyResetVaultInput;checkpoint:PinnedForwardBytes;latestMusic:PinnedForwardBytes;nativeImage:PinnedForwardBytes};
const sha=z.string().regex(/^[a-f0-9]{64}$/),key=z.string().min(1).max(80),mappingSchema=z.object({
  entries:z.array(z.object({originalKey:key,derivedId:z.string().regex(/^e_[a-f0-9]{40}$/),catalog:z.boolean()}).strict()).max(100000),
  shouts:z.array(z.object({originalKey:z.string().min(1).max(64*1024*1024),derivedId:z.string().regex(/^s_[a-f0-9]{40}$/)}).strict()).max(100000),
}).strict();
export type LegacyResetGenerationMapping=z.infer<typeof mappingSchema>;
const receiptSchema=z.object({originalSha256:sha,derivedSha256:sha,mappingSha256:sha,catalogEntries:z.number().int().nonnegative(),historicalEntryReferences:z.number().int().nonnegative(),shouts:z.number().int().nonnegative(),allKnownReferencesVerified:z.literal(true),originalContentAndOrderRoundTripVerified:z.literal(true),latestSourceAncestryVerified:z.literal(false),resetGenerationsReconciled:z.literal(false),releaseEligible:z.literal(false)}).strict();
const script=`import base64,json,sys
sys.path.insert(0,sys.argv[1])
from tools.migration.rollback_music_reset_generations import prepare_reset_generation_source,verify_reset_generation_source
value=json.loads(sys.stdin.buffer.read());source=base64.b64decode(value['source'],validate=True)
if value['mode']=='prepare':
 result,mapping=prepare_reset_generation_source(source,value['epoch'],value['reserved'],value['references'])
 print(json.dumps(dict(derived=base64.b64encode(result).decode(),mapping=mapping),ensure_ascii=False,separators=(',',':')))
else:
 result=base64.b64decode(value['derived'],validate=True)
 print(json.dumps(verify_reset_generation_source(source,value['epoch'],value['reserved'],value['references'],result,value['mapping']),separators=(',',':')))
`;

/** Use precisely the effective selection reference coercion of importMusic.
 * Metadata describes references only; Python retains every original raw value,
 * including 1.0, negative zero, unknown fields and source object order. */
function references(bytes:Buffer){
  const data=object(musicBytes(bytes),'reset generation source'),members=object(data.members,'reset generation members');
  return Object.entries(members).flatMap(([memberKey,value])=>{
    const member=object(value,'reset generation member'),selection=member.selection??[];
    if(!Array.isArray(selection))throw Error('Original generation selection list required');
    return selection.map((item,index)=>{
      if(typeof item==='string')return {memberKey,index,field:null,selectedKey:item};
      if(!item||typeof item!=='object'||Array.isArray(item))throw Error('Original generation selection value required');
      const field=item.id?'id':item.entryId?'entryId':null;
      return {memberKey,index,field,selectedKey:String(item.id||item.entryId||'')};
    });
  });
}
function call(payload:unknown,limit:number){
  try{return JSON.parse(execFileSync('python3',['-I','-c',script,fileURLToPath(new URL('../../',import.meta.url))],{input:JSON.stringify(payload),encoding:'utf8',timeout:30000,maxBuffer:limit,stdio:['pipe','pipe','pipe']}));}
  catch{throw Error('Original reset generation relation failed; retain all source bytes');}
}
function heldInput(input:LegacyResetGenerationInput){
  const held={vault:{...input.vault},checkpoint:{...input.checkpoint,bytes:Buffer.from(input.checkpoint.bytes)},latestMusic:{...input.latestMusic,bytes:Buffer.from(input.latestMusic.bytes)},nativeImage:{...input.nativeImage,bytes:Buffer.from(input.nativeImage.bytes)}};
  for(const row of [held.checkpoint,held.latestMusic,held.nativeImage])if(!sha.safeParse(row.sha256).success||forwardHash(row.bytes)!==row.sha256)throw Error('Reset generation source pin differs');
  if(held.latestMusic.bytes.length>64*1024*1024)throw Error('Reset generation source exceeds capacity');assertForwardImage(held.checkpoint.bytes);assertForwardImage(held.nativeImage.bytes);return held;
}
function open(input:LegacyResetGenerationInput,boundary?:()=>void){
  const held=heldInput(input),authority=readRollbackErasureAuthority(held.vault.authorityRoot,held.vault.manifestSha256),tree=pinRollbackTree(held.vault.vaultRoot),vault=readForwardLegacyResetVault(held.vault);
  const records=authority.records.filter(row=>row.version===2),last=records.at(-1);
  if(!last||!vault.vaultEvidence.allRecordedResetCompletionsPresent)throw Error('Every original reset requires a complete source and result before preparing generations');
  const completion=vault.completionSources.find(row=>row.sequence===last.sequence)!;
  if(held.checkpoint.sha256!==authority.manifest.checkpointSha256)throw Error('Reset generation authority checkpoint differs');
  const guard=()=>{
    const value:unknown=boundary?.();if(value!==null&&(typeof value==='object'||typeof value==='function')&&'then' in value)throw Error('Reset generation boundary must be synchronous');
    for(const key of Object.keys(held.vault) as (keyof LegacyResetVaultInput)[])if(input.vault[key]!==held.vault[key])throw Error('Reset generation vault identity changed');
    for(const key of ['checkpoint','latestMusic','nativeImage'] as const)if(input[key].sha256!==held[key].sha256||!Buffer.isBuffer(input[key].bytes)||!input[key].bytes.equals(held[key].bytes))throw Error('Reset generation original source changed');
    tree.assertUnchanged();authority.assertUnchanged();
  };
  guard();const db=new Database(held.nativeImage.bytes);let checkpoint:Database.Database|undefined;
  try{
    checkpoint=new Database(held.checkpoint.bytes);checkpoint.pragma('foreign_keys = ON');checkpoint.transaction(()=>assertRollbackSource(checkpoint!)).immediate();
    db.pragma('foreign_keys = ON');db.transaction(()=>assertRollbackSource(db)).immediate();
    const lineage=(db.prepare('SELECT lineage_id FROM rebuild_storage WHERE id=1').get() as {lineage_id:string}).lineage_id;
    if(lineage!==(checkpoint.prepare('SELECT lineage_id FROM rebuild_storage WHERE id=1').get() as {lineage_id:string}).lineage_id)throw Error('Reset generation native lineage differs from authority checkpoint');
    const reserved={entries:(db.prepare('SELECT id FROM music_entries ORDER BY id').all() as {id:string}[]).map(row=>row.id),shouts:(db.prepare('SELECT id FROM music_shouts ORDER BY id').all() as {id:string}[]).map(row=>row.id)};
    const latest=object(musicBytes(held.latestMusic.bytes),'reset generation latest'),members=object(latest.members,'reset generation latest members');
    const erased=new Set(authority.ledgers.music.toString('utf8').split('\n').filter(line=>line.trim()).map(line=>(JSON.parse(line) as {qq:string}).qq));
    if([...erased].some(key=>Object.hasOwn(members,key)))throw Error('Latest generation contains an erased original member; source cleanup and ancestry required');
    for(const value of Object.values(object(latest.entries,'reset generation entries')))if(erased.has(String(object(value,'reset generation entry').createdBy??'')))throw Error('Latest generation retains an erased creator');
    for(const kind of ['shouts','shoutHistory']){const list=latest[kind]??[];if(!Array.isArray(list))throw Error('Latest generation shout list required');for(const value of list)if(erased.has(String(object(value,'reset generation shout').qq??'')))throw Error('Latest generation retains an erased shout');}
    return {held,authority,vault,last,completion,reserved,lineage,references:references(held.latestMusic.bytes),guard};
  }finally{checkpoint?.close();db.close();}
}

/** Prepare a derived source with distinct post-reset entry/shout identities.
 * Original files, native rows, receipts, bot work and the authority are untouched.
 * This requires complete reset endpoints but still does not authorize a source
 * capture epoch, destructive native replay, reconstruction or activation. */
export function prepareForwardLegacyResetGenerations(input:LegacyResetGenerationInput,boundary?:()=>void){
  const s=open(input,boundary),payload={mode:'prepare',source:s.held.latestMusic.bytes.toString('base64'),epoch:s.completion.authorityRecordSha256,reserved:s.reserved,references:s.references};
  const raw=z.object({derived:z.string().max(90*1024*1024),mapping:mappingSchema}).strict().parse(call(payload,192*1024*1024)),bytes=Buffer.from(raw.derived,'base64');
  if(bytes.toString('base64')!==raw.derived||bytes.length>64*1024*1024)throw Error('Derived reset generation source exceeds capacity');s.guard();
  const result={derivedMusic:{bytes,sha256:forwardHash(bytes)},mapping:raw.mapping};
  const verification=verify(s,result);s.guard();
  return {...result,report:{...verification,authoritySha256:s.held.vault.manifestSha256,headSequence:s.authority.head.sequence,resetSequence:s.last.sequence,resetRecordSha256:s.completion.authorityRecordSha256,completionSha256:s.completion.completionSha256,nativeImageSha256:s.held.nativeImage.sha256,lineageId:s.lineage,entryGenerationSourcesPrepared:true as const,externalRetentionVerified:false as const,recoveryRequired:true as const,releaseEligible:false as const}};
}
export type LegacyResetGenerationBundle={derivedMusic:PinnedForwardBytes;mapping:LegacyResetGenerationMapping};
function verify(s:ReturnType<typeof open>,bundle:LegacyResetGenerationBundle){
  const mapping=mappingSchema.parse(bundle.mapping),bytes=bundle.derivedMusic.bytes;
  if(!Buffer.isBuffer(bytes)||bytes.length>64*1024*1024||forwardHash(bytes)!==bundle.derivedMusic.sha256)throw Error('Derived reset generation pin differs');
  const result=receiptSchema.parse(call({mode:'verify',source:s.held.latestMusic.bytes.toString('base64'),epoch:s.completion.authorityRecordSha256,reserved:s.reserved,references:s.references,derived:bytes.toString('base64'),mapping},64*1024));
  if(result.originalSha256!==s.held.latestMusic.sha256||result.derivedSha256!==bundle.derivedMusic.sha256||result.mappingSha256!==forwardHash(Buffer.from(JSON.stringify(mapping)+'\n')))throw Error('Reset generation receipt differs');
  const expected=references(bytes),byReference=new Map(expected.map(row=>[JSON.stringify([row.memberKey,row.index]),row])),ids=new Map(mapping.entries.map(row=>[row.originalKey,row.derivedId]));
  if(expected.length!==s.references.length)throw Error('Reset generation selection inventory differs');
  for(const ref of s.references){const next=byReference.get(JSON.stringify([ref.memberKey,ref.index]));if(!next||next.selectedKey!==(ref.selectedKey?ids.get(ref.selectedKey):''))throw Error('Reset generation effective selection coercion changed');}
  s.guard();return result;
}
/** Independent reverse relation reopens the complete original authority/vault;
 * re-pinning a changed source, mapping or result does not skip the oracle. */
export function verifyForwardLegacyResetGenerations(input:LegacyResetGenerationInput,bundle:LegacyResetGenerationBundle,boundary?:()=>void){
  if(!Buffer.isBuffer(bundle.derivedMusic.bytes))throw Error('Derived reset generation bytes required');
  const held={derivedMusic:{bytes:Buffer.from(bundle.derivedMusic.bytes),sha256:bundle.derivedMusic.sha256},mapping:mappingSchema.parse(bundle.mapping)},mappingJson=JSON.stringify(bundle.mapping);
  const guardedBoundary=()=>{
    const value:unknown=boundary?.();if(value!==null&&(typeof value==='object'||typeof value==='function')&&'then' in value)throw Error('Reset generation boundary must be synchronous');
    if(bundle.derivedMusic.sha256!==held.derivedMusic.sha256||!Buffer.isBuffer(bundle.derivedMusic.bytes)||!bundle.derivedMusic.bytes.equals(held.derivedMusic.bytes)||JSON.stringify(bundle.mapping)!==mappingJson)throw Error('Derived reset generation bundle changed');
  };
  const s=open(input,guardedBoundary),result=verify(s,held);s.guard();return result;
}
