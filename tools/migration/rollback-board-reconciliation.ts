import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import type { DB } from '@qgroup/database';
import { legacySchema } from '../../packages/database/src/legacy-schema';

const quoted=(name:string)=>'"'+name.replaceAll('"','""')+'"';
function encode(value:unknown):unknown {
  if(typeof value==='bigint')return {integer:value.toString()};
  if(Buffer.isBuffer(value))return {blob:value.toString('base64')};
  if(Array.isArray(value))return value.map(encode);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,encode(item)]));
  return value;
}
const canonical=(value:unknown)=>JSON.stringify(encode(value));
const objects=(db:DB)=>db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
function reject():never{throw Error('Rollback board reconciliation failed; retain the complete latest source');}
function same(left:unknown,right:unknown){if(canonical(left)!==canonical(right))reject();}
/** Independent verifier reads both databases, including rowid and each column's
 * storage class. It does not call the projector or trust migration_map/report. */
export function verifyRollbackBoard(source:DB,copy:DB) {
  const reference=new Database(':memory:');
  try {
    reference.exec(legacySchema);same(objects(copy),objects(reference));
    for(const name of ['user_version','application_id','encoding'])same(source.pragma(name,{simple:true}),copy.pragma(name,{simple:true}));
    const tables=(reference.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string}[]).map(row=>row.name);
    if(tables.length!==59)reject();
    if(source.pragma('integrity_check',{simple:true})!=='ok'||copy.pragma('integrity_check',{simple:true})!=='ok'||(source.pragma('foreign_key_check') as unknown[]).length||(copy.pragma('foreign_key_check') as unknown[]).length)reject();
    const counts:Record<string,number>={},hash=createHash('sha256');
    for(const table of tables){
      const columns=(reference.prepare(`PRAGMA table_xinfo(${quoted(table)})`).all() as {name:string}[]).map(column=>column.name);
      same(copy.prepare(`PRAGMA table_xinfo(${quoted(table)})`).all(),reference.prepare(`PRAGMA table_xinfo(${quoted(table)})`).all());
      const types=columns.map((column,index)=>`typeof(${quoted(column)}) AS ${quoted('__storage_'+index)}`).join(',');
      const query=`SELECT rowid AS __original_rowid__,*,${types} FROM ${quoted(table)} ORDER BY rowid`;
      const original=source.prepare(query).safeIntegers(true).iterate(),projected=copy.prepare(query).safeIntegers(true).iterate();let count=0;
      try{for(;;){const a=original.next(),b=projected.next();if(a.done!==b.done)reject();if(a.done)break;same(a.value,b.value);hash.update(canonical([table,a.value])+'\n');count++;}}
      finally{original.return?.();projected.return?.();}
      counts[table]=count;
    }
    const names=new Set(tables);
    const originalSequence=(source.prepare('SELECT name,seq,typeof(seq) AS storage FROM sqlite_sequence ORDER BY name').safeIntegers(true).all() as {name:string;seq:bigint;storage:string}[]).filter(row=>names.has(row.name));
    same(copy.prepare('SELECT name,seq,typeof(seq) AS storage FROM sqlite_sequence ORDER BY name').safeIntegers(true).all(),originalSequence);
    const autoTables=(reference.prepare("SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%AUTOINCREMENT%' ORDER BY name").all() as {name:string}[]).map(row=>row.name);
    if(new Set(originalSequence.map(row=>row.name)).size!==originalSequence.length||originalSequence.some(row=>!autoTables.includes(row.name)))reject();
    for(const table of autoTables){
      const maximum=source.prepare(`SELECT max(rowid) AS maximum FROM ${quoted(table)}`).safeIntegers(true).get() as {maximum:bigint|null};
      if(maximum.maximum!==null&&maximum.maximum>0n&&!originalSequence.some(row=>row.name===table))reject();
    }
    for(const sequence of originalSequence){
      if(sequence.storage!=='integer'||typeof sequence.seq!=='bigint'||sequence.seq<0n)reject();
      const maximum=source.prepare(`SELECT max(rowid) AS maximum FROM ${quoted(sequence.name)}`).safeIntegers(true).get() as {maximum:bigint|null};
      if(maximum.maximum!==null&&maximum.maximum>sequence.seq)reject();
    }
    return {version:1 as const,tables:counts,tableCount:59 as const,rowsDigest:hash.digest('hex'),
      databaseMetadata:{userVersion:source.pragma('user_version',{simple:true}),applicationId:source.pragma('application_id',{simple:true}),encoding:source.pragma('encoding',{simple:true})},
      sequences:originalSequence.map(row=>({name:row.name,seq:row.seq.toString()})),
      rollbackEligible:false as const,remaining:['music','identity','media','latest_erasure_package','browser_requests','fixed_web_bot_rehearsal']};
  }finally{reference.close();}
}
