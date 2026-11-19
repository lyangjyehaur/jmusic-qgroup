import Database from 'better-sqlite3';
import type {DB} from '@qgroup/database';
import {createHash} from 'node:crypto';
import {decodeErasureJournal,readVerifiedErasureJournal} from '../../apps/api/src/erasure-journal';
import {validateAuthorityLedger} from '../../apps/api/src/erasure-authority-protocol';
import {boardTables,quoted} from './board-reconciliation';
import {assertRollbackSource} from './rollback-source';
import {verifyRollbackBoard} from './rollback-board-reconciliation';

export type PinnedForwardBytes={bytes:Buffer;sha256:string};
export type ForwardBoardInput={checkpoint:PinnedForwardBytes;baselineBoard:PinnedForwardBytes;baselineJournal:PinnedForwardBytes;nativeImage:PinnedForwardBytes;nativeJournal:PinnedForwardBytes;oldBoard:PinnedForwardBytes};
export type ForwardRow=Record<string,unknown>&{__forward_rowid__:bigint};
export const immutableForwardBoardTables=Object.freeze(['account_audit','admin_audit','admin_role_history','attendee_consents','attendee_payment_origins','bot_settings_history','event_audit','event_conditions','event_room_plans','finance_entries','finance_report_actions','finance_reports','settlement_code_images','settlement_details','settlement_history','settlement_receipt_images','settlement_receipts','time_poll_history']);
export const forwardHash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
function encoded(value:unknown):unknown{
  if(typeof value==='bigint')return {integer:value.toString()};
  if(typeof value==='number')return {real:String(value),negativeZero:Object.is(value,-0)};
  if(Buffer.isBuffer(value))return {blob:value.toString('base64')};
  if(Array.isArray(value))return value.map(encoded);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,encoded(item)]));
  return value;
}
export const forwardCanonical=(value:unknown)=>JSON.stringify(encoded(value));
export const forwardEqual=(left:unknown,right:unknown)=>forwardCanonical(left)===forwardCanonical(right);
export function assertForwardImage(bytes:Buffer){
  if(!Buffer.isBuffer(bytes)||bytes.length<100||bytes.length>512*1024*1024||bytes.subarray(0,16).toString('binary')!=='SQLite format 3\0'||bytes[18]!==1||bytes[19]!==1)throw Error('Forward board requires standalone SQLite image bytes');
}
export function copyForwardBoardInput(input:ForwardBoardInput){
  const held={} as ForwardBoardInput;
  for(const name of ['checkpoint','baselineBoard','baselineJournal','nativeImage','nativeJournal','oldBoard'] as const){
    const item=input[name];if(!item||!Buffer.isBuffer(item.bytes)||!/^[a-f0-9]{64}$/.test(item.sha256)||forwardHash(item.bytes)!==item.sha256)throw Error('Forward board source pin differs');
    if(name!=='baselineJournal'&&name!=='nativeJournal')assertForwardImage(item.bytes);
    else if(item.bytes.length>64*1024*1024)throw Error('Forward journal exceeds supported size');
    held[name]={bytes:Buffer.from(item.bytes),sha256:item.sha256};
  }
  return held;
}
export function forwardLineage(db:DB){
  const value=db.prepare('SELECT lineage_id,recovery_required FROM rebuild_storage WHERE id=1').get() as {lineage_id:string;recovery_required:number}|undefined;
  if(!value||!/^[a-f0-9]{32}$/.test(value.lineage_id)||![0,1].includes(value.recovery_required))throw Error('Forward storage lineage requires review');
  return value.lineage_id;
}
/** Read every SQLite storage class; REAL 1 and INTEGER 1 remain distinct. */
export function forwardRows(db:DB,table:string){
  const columns=db.prepare(`PRAGMA table_xinfo(${quoted(table)})`).all() as {name:string;hidden:number}[];
  if(columns.some(column=>column.hidden||column.name==='__forward_rowid__'||column.name.startsWith('__forward_type_')))throw Error('Unsupported forward storage columns');
  const types=columns.map((column,index)=>`typeof(${quoted(column.name)}) AS ${quoted('__forward_type_'+index)}`).join(',');
  return db.prepare(`SELECT rowid AS __forward_rowid__,*,${types} FROM ${quoted(table)} ORDER BY rowid`).safeIntegers(true).iterate() as IterableIterator<ForwardRow>;
}
export function forwardRowReader(db:DB,table:string){
  const columns=db.prepare(`PRAGMA table_xinfo(${quoted(table)})`).all() as {name:string}[];
  const types=columns.map((column,index)=>`typeof(${quoted(column.name)}) AS ${quoted('__forward_type_'+index)}`).join(',');
  const read=db.prepare(`SELECT rowid AS __forward_rowid__,*,${types} FROM ${quoted(table)} WHERE rowid=?`).safeIntegers(true);
  return (id:bigint)=>read.get(id) as ForwardRow|undefined;
}
function assertRetainedForwardHistory(baseline:DB,native:DB,old:DB){
  for(const table of immutableForwardBoardTables){const a=forwardRowReader(native,table),b=forwardRowReader(old,table);for(const row of forwardRows(baseline,table))if(!forwardEqual(row,a(row.__forward_rowid__))||!forwardEqual(row,b(row.__forward_rowid__)))throw Error('Forward append-only history was removed or rewritten');}
  const a=forwardRowReader(native,'bot_outbox'),b=forwardRowReader(old,'bot_outbox');
  const frozen=['event_id','poll_id','kind','dedupe_key','channel','payload_json','due_at','created_at','target','recipient_user_id'];
  for(const row of forwardRows(baseline,'bot_outbox'))for(const after of [a(row.__forward_rowid__),b(row.__forward_rowid__)]){
    if(!after||frozen.some(field=>!forwardEqual(row[field],after[field])))throw Error('Forward bot work identity or frozen payload changed');
    if(row.status==='sent'&&(after.status!=='sent'||!forwardEqual(row.delivered_payload_json,after.delivered_payload_json)))throw Error('Forward already-sent bot work was replayed or rewritten');
    if(row.simulated_at!==null&&(!forwardEqual(row.simulated_at,after.simulated_at)||after.status!==row.status&&['pending','sending','sent'].includes(String(after.status))))throw Error('Forward simulation cannot become live work');
  }
}
export function forwardSequences(db:DB){
  const auto=(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%AUTOINCREMENT%' ORDER BY name").all() as {name:string}[]).map(row=>row.name);
  const rows=db.prepare('SELECT name,seq,typeof(seq) AS storage FROM sqlite_sequence ORDER BY name').safeIntegers(true).all() as {name:string;seq:bigint;storage:string}[];
  if(new Set(rows.map(row=>row.name)).size!==rows.length||rows.some(row=>!auto.includes(row.name)||row.storage!=='integer'||typeof row.seq!=='bigint'||row.seq<0n))throw Error('Invalid forward sequence storage');
  const result=new Map(rows.map(row=>[row.name,row.seq]));
  for(const table of auto){const maximum=(db.prepare(`SELECT max(rowid) AS value FROM ${quoted(table)}`).safeIntegers(true).get() as {value:bigint|null}).value;if(maximum!==null&&maximum>0n&&(result.get(table)??-1n)<maximum)throw Error('Forward sequence is below its row high-water');}
  return result;
}
export function openForwardBoardSources(input:ForwardBoardInput){
  const dbs:DB[]=[];
  try{
    const open=(bytes:Buffer)=>{const db=new Database(bytes);dbs.push(db);return db;};
    const checkpoint=open(input.checkpoint.bytes),baseline=open(input.baselineBoard.bytes),native=open(input.nativeImage.bytes),old=open(input.oldBoard.bytes);
    const decode=(bytes:Buffer)=>{validateAuthorityLedger('unified',bytes);return decodeErasureJournal(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes));};
    if(!input.nativeJournal.bytes.subarray(0,input.baselineJournal.bytes.length).equals(input.baselineJournal.bytes))throw Error('Forward native journal has lost its baseline prefix');
    for(const [db,journal] of [[checkpoint,input.baselineJournal.bytes],[native,input.nativeJournal.bytes]] as const){db.transaction(()=>{assertRollbackSource(db);readVerifiedErasureJournal(db,{read:()=>decode(journal),append(){throw Error('Read-only forward journal');}});}).immediate();forwardSequences(db);}
    if(forwardLineage(checkpoint)!==forwardLineage(native))throw Error('Forward native lineage differs');
    verifyRollbackBoard(checkpoint,baseline);verifyRollbackBoard(old,old);
    assertRetainedForwardHistory(baseline,native,old);
    const before=forwardSequences(baseline),next=forwardSequences(old),current=forwardSequences(native);
    for(const name of boardTables){const minimum=before.get(name);if(minimum!==undefined&&((next.get(name)??-1n)<minimum||(current.get(name)??-1n)<minimum))throw Error('Forward source sequence rewound below baseline');}
    return {checkpoint,baseline,native,old,close(){for(const db of dbs.splice(0).reverse())db.close();}};
  }catch(error){for(const db of dbs.reverse())db.close();throw error;}
}
export type ForwardBoardSources=ReturnType<typeof openForwardBoardSources>;
