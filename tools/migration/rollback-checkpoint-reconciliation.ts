import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import type { DB } from '@qgroup/database';
import type { StoredIntent } from '../../apps/api/src/erasure-journal';

const quoted=(name:string)=>'"'+name.replaceAll('"','""')+'"';
const reject=():never=>{throw Error('Rollback checkpoint reconciliation failed; retain the complete latest source');};
function encode(value:unknown):unknown {
  if(typeof value==='bigint')return {integer:value.toString()};
  if(typeof value==='number'&&(!Number.isFinite(value)||Object.is(value,-0)))return {real:String(value),negativeZero:Object.is(value,-0)};
  if(Buffer.isBuffer(value))return {blob:value.toString('base64')};
  if(Array.isArray(value))return value.map(encode);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,encode(item)]));
  return value;
}
const canonical=(value:unknown)=>JSON.stringify(encode(value));
const same=(a:unknown,b:unknown)=>{if(canonical(a)!==canonical(b))reject();};
const objects=(db:DB)=>db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all();
/** Reads every table directly from a private standalone SQLite image. No
 * projection, migration, erasure replay, worker or authentication is executed. */
export function verifyRollbackCheckpoint(source:DB,image:Buffer,journal:StoredIntent[]){
  if(!source.inTransaction)throw Error('Rollback checkpoint verification requires a held source transaction');
  if(image.length<100||image.subarray(0,16).toString('binary')!=='SQLite format 3\0'||image[18]!==1||image[19]!==1)reject();
  const copy=new Database(image,{readonly:true});
  try{
    same(objects(source),objects(copy));
    for(const db of [source,copy])if(db.pragma('integrity_check',{simple:true})!=='ok'||(db.pragma('foreign_key_check') as unknown[]).length)reject();
    const metadata:Record<string,unknown>={};
    for(const name of ['user_version','application_id','encoding']){const value=source.pragma(name,{simple:true});same(value,copy.pragma(name,{simple:true}));metadata[name]=value;}
    const tables=(source.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {name:string}[]).map(row=>row.name);
    const counts:Record<string,number>={},hash=createHash('sha256');
    for(const table of tables){
      const columns=source.prepare(`PRAGMA table_xinfo(${quoted(table)})`).all() as {name:string;hidden:number}[];
      same(columns,copy.prepare(`PRAGMA table_xinfo(${quoted(table)})`).all());
      if(columns.some(column=>column.hidden)||columns.some(column=>column.name==='__rollback_rowid__'||column.name.startsWith('__rollback_storage_')))reject();
      const types=columns.map((column,index)=>`typeof(${quoted(column.name)}) AS ${quoted('__rollback_storage_'+index)}`).join(',');
      const query=`SELECT rowid AS __rollback_rowid__,*,${types} FROM ${quoted(table)} ORDER BY rowid`;
      const original=source.prepare(query).safeIntegers(true).iterate(),saved=copy.prepare(query).safeIntegers(true).iterate();let count=0;
      try{for(;;){const a=original.next(),b=saved.next();if(a.done!==b.done)reject();if(a.done)break;same(a.value,b.value);hash.update(canonical([table,a.value])+'\n');count++;}}
      finally{original.return?.();saved.return?.();}
      counts[table]=count;
    }
    const autoTables=(source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%AUTOINCREMENT%' ORDER BY name").all() as {name:string}[]).map(row=>row.name);
    const sequences=source.prepare('SELECT name,seq,typeof(seq) AS storage FROM sqlite_sequence ORDER BY name').safeIntegers(true).all() as {name:string;seq:bigint;storage:string}[];
    if(new Set(sequences.map(row=>row.name)).size!==sequences.length||sequences.some(row=>!autoTables.includes(row.name)||row.storage!=='integer'||typeof row.seq!=='bigint'||row.seq<0n))reject();
    for(const table of autoTables){
      const max=(source.prepare(`SELECT max(rowid) AS maximum FROM ${quoted(table)}`).safeIntegers(true).get() as {maximum:bigint|null}).maximum;
      const sequence=sequences.find(row=>row.name===table);
      if(max!==null&&max>0n&&(!sequence||sequence.seq<max))reject();
    }
    const unique=new Map<string,StoredIntent>();
    for(const entry of journal){const id='request_id' in entry?entry.request_id:entry.requestId;if(unique.has(id)&&canonical(unique.get(id))!==canonical(entry))reject();unique.set(id,entry);}
    same([...unique.keys()].sort(),(copy.prepare('SELECT request_id FROM erasure_applied').all() as {request_id:string}[]).map(row=>row.request_id).sort());
    for(const entry of unique.values())if('version' in entry)same(copy.prepare('SELECT signature,secret_hash FROM privacy_receipts WHERE request_id=?').get(entry.requestId),{signature:entry.signature,secret_hash:entry.secretHash});
    return {version:1 as const,tables:counts,tableCount:tables.length,rowsDigest:hash.digest('hex'),imageDigest:createHash('sha256').update(image).digest('hex'),imageBytes:image.length,metadata,
      sequences:sequences.map(row=>({name:row.name,seq:row.seq.toString()})),journalRequests:unique.size,journalDigest:createHash('sha256').update(canonical(journal)).digest('hex'),
      rollbackEligible:false as const,remaining:['identity_sqlite','latest_erasure_package_replay','media_history','browser_requests','package_manifest','fixed_old_web_music_bot_rehearsal']};
  }finally{copy.close();}
}
