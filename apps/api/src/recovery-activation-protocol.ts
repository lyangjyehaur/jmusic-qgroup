import Database from 'better-sqlite3';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { openDatabase, REBUILD_SCHEMA_VERSION, type DB } from '@qgroup/database';
import { decodeErasureJournal, readVerifiedErasureJournal } from './erasure-journal';
import { authorityDomains, ErasureAuthorityHead, encode, privateDirectory, privateFile, type AuthorityFileGuard, type readRollbackErasureAuthority } from './erasure-authority-protocol';
import { digest, parseJson } from '../../../packages/runtime/src/strict-json';

const sha = z.string().regex(/^[a-f0-9]{64}$/), lineage = z.string().regex(/^[a-f0-9]{32}$/);
const service = z.object({ runtime: z.enum(['typescript','python']), commit: z.string().regex(/^[a-f0-9]{40}$/), imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict();
export const RecoveryActivationReview = z.object({
  version: z.literal(1), kind: z.literal('qgroup-private-recovery-review'), reviewedAt: z.iso.datetime(),
  checkpointSha256: sha, journalSha256: sha, authorityManifestSha256: sha, authorityHeadSha256: sha, lineageId: lineage,
  botStateSha256: sha,
  services: z.object({ web: service.extend({runtime:z.literal('typescript')}), bot: service }).strict(),
  evidence: z.object({ source: sha, capture: sha, versions: sha, bot: sha }).strict(),
  deliveries: z.array(z.object({ id: z.string().regex(/^[1-9]\d*$/), rowSha256: sha, decision: z.literal('preserve') }).strict())
    .refine(rows => new Set(rows.map(row=>row.id)).size===rows.length),
}).strict();
export type RecoveryReview = z.infer<typeof RecoveryActivationReview>;
const file = z.object({path:z.enum(['review.json','activated-checkpoint.sqlite3','unified.erasures.jsonl','source-review.json','capture-review.json','version-review.json','bot-review.json']),size:z.number().int().nonnegative().safe().max(512*1024*1024),sha256:sha}).strict();
export const RecoveryActivationManifest = z.object({
  version:z.literal(1),kind:z.literal('qgroup-private-recovery-activation'),createdAt:z.iso.datetime(),
  sourcePackageSha256:sha,botStateSha256:sha,reviewSha256:sha,checkpointSha256:sha,activatedCheckpointSha256:sha,journalSha256:sha,lineageId:lineage,
  authorityHead:ErasureAuthorityHead,files:z.array(file).length(7),schema:z.literal(REBUILD_SCHEMA_VERSION),schemaSha256:sha,
  tables:z.record(z.string(),sha),deploymentPerformed:z.literal(false),releaseEligible:z.literal(false),
}).strict().refine(row=>new Set(row.files.map(f=>f.path)).size===7);

const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
function canonical(value:unknown):string {
  function normalize(item:unknown):unknown {
    if(typeof item==='bigint')return {integer:item.toString()};
    if(typeof item==='number'){const raw=Buffer.alloc(8);raw.writeDoubleBE(item);return {real:raw.toString('hex')};}
    if(Buffer.isBuffer(item))return {blob:item.toString('base64')};
    if(Array.isArray(item))return item.map(normalize);
    if(item!==null&&typeof item==='object')return Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,value])=>[key,normalize(value)]));
    return item;
  }
  return JSON.stringify(normalize(value));
}
function ddl(db:DB){return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();}
function tableHash(db:DB,name:string){
  const columns=db.prepare('PRAGMA table_xinfo('+quote(name)+')').all() as {name:string;hidden:number}[];
  if(columns.some(c=>c.hidden))throw Error('Unsupported recovery storage columns');
  // Values, storage classes and rowids are all part of the immutable snapshot.
  const fields=columns.map(c=>'typeof('+quote(c.name)+'),'+quote(c.name)).join(','),hash=createHash('sha256');
  for(const row of db.prepare('SELECT rowid,'+fields+' FROM '+quote(name)+' ORDER BY rowid').safeIntegers(true).raw(true).iterate())hash.update(canonical(row)+'\n');
  return hash.digest('hex');
}
export function recoveryDeliveryReview(db:DB){
  return (db.prepare("SELECT * FROM bot_outbox WHERE status='sending' OR (status='skipped' AND simulated_at IS NULL) ORDER BY id").safeIntegers(true).all() as Record<string,unknown>[])
    .map(row=>({id:String(row.id),rowSha256:digest(canonical(row)),decision:'preserve' as const}));
}
function standalone(bytes:Buffer){
  if(!Buffer.isBuffer(bytes)||bytes.length<100||bytes.length>512*1024*1024||bytes.subarray(0,16).toString('binary')!=='SQLite format 3\0'||bytes[18]!==1||bytes[19]!==1)throw Error('Recovery requires a standalone SQLite image');
}
function inspected(bytes:Buffer,journal:Buffer,required:number,expectedLineage:string){
  standalone(bytes);const db=new Database(bytes);
  try{
    db.pragma('foreign_keys=ON');
    const reference=openDatabase(':memory:');try{if(canonical(ddl(db))!==canonical(ddl(reference)))throw Error('Recovery schema requires explicit migration');}finally{reference.close();}
    const storage=db.prepare('SELECT * FROM rebuild_storage').all() as {id:number;lineage_id:string;recovery_required:number}[];
    if(storage.length!==1||storage[0]?.id!==1||storage[0].lineage_id!==expectedLineage||storage[0].recovery_required!==required)throw Error('Recovery activation storage state differs');
    if(db.pragma('integrity_check',{simple:true})!=='ok'||(db.pragma('foreign_key_check') as unknown[]).length)throw Error('Recovery activation integrity failure');
    const entries=decodeErasureJournal(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(journal));
    readVerifiedErasureJournal(db,{read:()=>entries,append(){throw Error('Read-only activation journal');}});
    return db;
  }catch(error){db.close();throw error;}
}
/** Exact offline state transition. No original DB, trigger, row or job is edited. */
export function createActivatedRecoveryImage(checkpoint:Buffer,journal:Buffer,reviewInput:RecoveryReview){
  const review=RecoveryActivationReview.parse(reviewInput);
  if(digest(checkpoint)!==review.checkpointSha256||digest(journal)!==review.journalSha256)throw Error('Recovery review source pin differs');
  const db=inspected(checkpoint,journal,1,review.lineageId);
  try{
    if(canonical(recoveryDeliveryReview(db))!==canonical(review.deliveries))throw Error('Every uncertain delivery requires exact preservation review');
    const trigger=(db.prepare("SELECT sql FROM sqlite_master WHERE name='rebuild_storage_no_update'").get() as {sql:string}).sql;
    db.transaction(()=>{db.exec('DROP TRIGGER rebuild_storage_no_update');db.exec('UPDATE rebuild_storage SET recovery_required=0 WHERE id=1');db.exec(trigger);}).immediate();
    const image=db.serialize();image[18]=1;image[19]=1;
    return {image,...verifyRecoveryActivationImage(checkpoint,image,journal,review)};
  }finally{db.close();}
}
/** Reverify the only allowed delta independently of the activation writer. */
export function verifyRecoveryActivationImage(checkpoint:Buffer,activated:Buffer,journal:Buffer,reviewInput:RecoveryReview){
  const review=RecoveryActivationReview.parse(reviewInput);
  if(digest(checkpoint)!==review.checkpointSha256||digest(journal)!==review.journalSha256)throw Error('Recovery review source pin differs');
  const before=inspected(checkpoint,journal,1,review.lineageId);let after:DB|undefined;
  try{
    after=inspected(activated,journal,0,review.lineageId);
    if(canonical(recoveryDeliveryReview(before))!==canonical(review.deliveries))throw Error('Uncertain delivery review differs');
    for(const pragma of ['application_id','user_version','encoding','auto_vacuum'])if(before.pragma(pragma,{simple:true})!==after.pragma(pragma,{simple:true}))throw Error('Recovery SQLite metadata changed');
    if(canonical(ddl(before))!==canonical(ddl(after)))throw Error('Recovery DDL changed');
    const original=before.prepare('SELECT rowid,id,lineage_id FROM rebuild_storage').safeIntegers(true).all();
    if(canonical(original)!==canonical(after.prepare('SELECT rowid,id,lineage_id FROM rebuild_storage').safeIntegers(true).all()))throw Error('Recovery storage identity changed');
    const tables:Record<string,string>={};
    for(const {name} of before.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {name:string}[]){
      if(name==='rebuild_storage')continue;
      const expected=tableHash(before,name);if(expected!==tableHash(after,name))throw Error('Recovery activation changed a data table');tables[name]=expected;
    }
    return {schemaSha256:digest(canonical(ddl(before))),tables};
  }finally{before.close();after?.close();}
}
type Authority=ReturnType<typeof readRollbackErasureAuthority>;
/** Derive an earlier published head from the held immutable baseline/records. */
export function recoveryAuthorityJournal(authority:Authority,head:z.infer<typeof ErasureAuthorityHead>){
  if(head.authoritySha256!==authority.manifestSha256||head.sequence>authority.head.sequence)throw Error('Activation authority head is not retained');
  const chunks=Object.fromEntries(authorityDomains.map(domain=>[domain,[authority.ledgers[domain].subarray(0,authority.manifest.baseline.find(f=>f.domain===domain)!.size)]])) as Record<typeof authorityDomains[number],Buffer[]>;
  for(const row of authority.records.slice(0,head.sequence))chunks[row.domain].push(Buffer.from(row.suffixBase64,'base64'));
  const expected={version:1,authoritySha256:authority.manifestSha256,sequence:head.sequence,recordSha256:head.sequence?authority.recordPins[head.sequence-1]:null,
    ledgers:Object.fromEntries(Object.entries(chunks).map(([domain,parts])=>{const raw=Buffer.concat(parts);return [domain,{size:raw.length,sha256:digest(raw)}];}))};
  if(canonical(head)!==canonical(expected))throw Error('Activation authority head differs');
  return Buffer.concat(chunks.unified);
}
/** Explicit external manifest pin is the review boundary. Metadata does not
 * prove deployment authorization, QQ delivery or functional version acceptance. */
export function readRecoveryActivation(root:string,pin:string,checkpoint:Buffer,authority:Authority,guard?:AuthorityFileGuard){
  const directory=privateDirectory(root),manifestFile=privateFile(join(root,'activation-manifest.json'),4*1024*1024,guard);
  if(!manifestFile.bytes||manifestFile.sha256!==pin)throw Error('Recovery activation manifest pin differs');
  const manifest=RecoveryActivationManifest.parse(parseJson(manifestFile.bytes.toString('utf8')));
  if(!manifestFile.bytes.equals(encode(manifest)))throw Error('Noncanonical recovery activation manifest');
  if(JSON.stringify(readdirSync(root).sort())!==JSON.stringify(['activation-manifest.json',...manifest.files.map(f=>f.path)].sort()))throw Error('Recovery activation inventory differs');
  const held=manifest.files.map(f=>{const saved=privateFile(join(root,f.path),f.size,guard);if(!saved.bytes||saved.bytes.length!==f.size||saved.sha256!==f.sha256)throw Error('Recovery activation file pin differs');return {path:f.path,saved};});
  const get=(path:string)=>held.find(f=>f.path===path)!.saved.bytes!;
  const review=RecoveryActivationReview.parse(parseJson(get('review.json').toString('utf8')));
  if(review.botStateSha256!==manifest.botStateSha256)throw Error('Recovery bot state review differs');
  if(digest(get('review.json'))!==manifest.reviewSha256||review.checkpointSha256!==manifest.checkpointSha256||review.journalSha256!==manifest.journalSha256||review.lineageId!==manifest.lineageId||digest(get('activated-checkpoint.sqlite3'))!==manifest.activatedCheckpointSha256||digest(encode(manifest.authorityHead))!==review.authorityHeadSha256||review.authorityManifestSha256!==manifest.authorityHead.authoritySha256||Date.parse(manifest.createdAt)<Date.parse(review.reviewedAt))throw Error('Recovery activation review binding differs');
  for(const name of ['source','capture','versions','bot'] as const){const raw=get(name==='versions'?'version-review.json':name+'-review.json');parseJson(raw.toString('utf8'));if(digest(raw)!==review.evidence[name])throw Error('Recovery review evidence differs');}
  const journal=get('unified.erasures.jsonl');if(!recoveryAuthorityJournal(authority,manifest.authorityHead).equals(journal)||digest(journal)!==manifest.journalSha256)throw Error('Recovery activation lost reviewed erasures');
  if(authority.manifest.sourcePackageSha256!==manifest.sourcePackageSha256||authority.manifest.checkpointSha256!==manifest.checkpointSha256)throw Error('Recovery activation belongs to another retained source');
  const verified=verifyRecoveryActivationImage(checkpoint,get('activated-checkpoint.sqlite3'),journal,review);
  if(canonical(verified.tables)!==canonical(manifest.tables)||verified.schemaSha256!==manifest.schemaSha256)throw Error('Recovery activation reconciliation differs');
  const view=digest(canonical({manifest,review}));
  function assertUnchanged(){const current=privateDirectory(root);if(current.dev!==directory.dev||current.ino!==directory.ino||JSON.stringify(readdirSync(root).sort())!==JSON.stringify(['activation-manifest.json',...manifest.files.map(f=>f.path)].sort())||digest(canonical({manifest,review}))!==view)throw Error('Recovery activation changed');manifestFile.assertUnchanged();for(const file of held)file.saved.assertUnchanged();}
  assertUnchanged();return {manifest,review,assertUnchanged};
}
