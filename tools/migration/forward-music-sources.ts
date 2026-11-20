import Database from 'better-sqlite3';
import {readMusicRetirements,type DB} from '@qgroup/database';
import {decodeErasureJournal,type ErasureJournal} from '../../apps/api/src/erasure-journal';
import {assertIdentitySchema,captureIdentitySource} from './identity-source';
import {keys,object,parseJson,projectMusic,readIdentity,type ObjectValue} from './music-codec';
import {projectRollbackMusic,type RollbackMusic} from './rollback-music';
import {projectRollbackIdentity,type IdentityAuditMapping} from './rollback-identity';
import {verifyRollbackMusic} from './rollback-music-reconciliation';
import {verifyRollbackIdentity} from './rollback-identity-reconciliation';
import {copyForwardBoardInput,openForwardBoardSources,assertForwardImage,forwardHash,forwardRows,forwardRowReader,forwardEqual,type ForwardBoardInput,type PinnedForwardBytes} from './forward-board-storage';

export type ForwardMusicInput=ForwardBoardInput&{baselineMusic:PinnedForwardBytes;baselineIdentity:PinnedForwardBytes;oldMusic:PinnedForwardBytes;oldIdentity:PinnedForwardBytes};
export function musicCanonical(value:unknown):string {
  const encode=(item:unknown):unknown=>{
    if(typeof item==='number')return {number:String(item),negativeZero:Object.is(item,-0)};
    if(Array.isArray(item))return item.map(encode);
    if(item&&typeof item==='object')return Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,v])=>[key,encode(v)]));
    return item;
  };
  return JSON.stringify(encode(value));
}
export const musicEqual=(a:unknown,b:unknown)=>musicCanonical(a)===musicCanonical(b);
export const musicBytes=(bytes:Buffer)=>parseJson(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes));
export function copyForwardMusicInput(input:ForwardMusicInput){
  const held={...copyForwardBoardInput(input)} as ForwardMusicInput;
  for(const name of ['baselineMusic','baselineIdentity','oldMusic','oldIdentity'] as const){
    const item=input[name];if(!item||!Buffer.isBuffer(item.bytes)||!/^[a-f0-9]{64}$/.test(item.sha256)||forwardHash(item.bytes)!==item.sha256)throw Error('Forward music source pin differs');
    if(name.endsWith('Identity'))assertForwardImage(item.bytes);else if(item.bytes.length>64*1024*1024)throw Error('Forward music JSON exceeds supported size');
    held[name]={bytes:Buffer.from(item.bytes),sha256:item.sha256};
  }
  return held;
}
export function musicRecord(raw:unknown){
  const value=object(raw as ObjectValue,'forward music');keys(value,['data','keys','identityAuditMappings'],'forward music checkpoint');
  if(!Array.isArray(value.keys)||!Array.isArray(value.identityAuditMappings))throw Error('Incomplete forward music checkpoint');
  const data=object(value.data,'forward music data');
  return {data,keys:value.keys as unknown as RollbackMusic['keys'],identityAuditMappings:value.identityAuditMappings as unknown as IdentityAuditMapping[]};
}
export function assertForwardIdentity(db:DB){
  assertIdentitySchema(db);captureIdentitySource(db);
  if(db.pragma('integrity_check',{simple:true})!=='ok'||(db.pragma('foreign_key_check') as unknown[]).length)throw Error('Invalid forward identity integrity');
  for(const table of ['sessions','links','used_oauth','prelinks','login_attempts','link_overrides','link_audit','native_profiles','profile_contacts','entry_intents']){
    const columns=db.prepare(`PRAGMA table_xinfo("${table}")`).all() as {name:string}[];
    for(const row of forwardRows(db,table))for(const [index,column] of columns.entries()){
      const expected=['created','updated','expires','pending_until'].includes(column.name)?'real':['id','revision'].includes(column.name)?'integer':'text';
      if(row['__forward_type_'+index]!==expected)throw Error('Unsupported forward identity storage class');
      const item=row[column.name];if(typeof item==='number'&&(!Number.isFinite(item)||Math.abs(item)>Number.MAX_SAFE_INTEGER))throw Error('Unsafe forward identity time');
    }
  }
  // Validate payload JSON and all retained values; this does not activate proofs.
  readIdentity(db);
}
export function openForwardMusicSources(input:ForwardMusicInput){
  const board=openForwardBoardSources(input),dbs:DB[]=[];
  try{
    const open=(bytes:Buffer)=>{const db=new Database(bytes);dbs.push(db);assertForwardIdentity(db);return db;};
    const baseline=musicRecord(musicBytes(input.baselineMusic.bytes)),baselineIdentity=open(input.baselineIdentity.bytes),oldIdentity=open(input.oldIdentity.bytes);
    const journal=(bytes:Buffer):ErasureJournal=>({read:()=>decodeErasureJournal(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)),append(){throw Error('Read-only forward music journal');}});
    board.checkpoint.transaction(()=>{verifyRollbackMusic(board.checkpoint,baseline,journal(input.baselineJournal.bytes).read());verifyRollbackIdentity(board.checkpoint,baselineIdentity,baseline,journal(input.baselineJournal.bytes).read(),baseline.identityAuditMappings);}).immediate();
    const projected=projectRollbackMusic(board.native,journal(input.nativeJournal.bytes)),native:RollbackMusic={data:projected.data,keys:projected.keys},identity=projectRollbackIdentity(board.native,journal(input.nativeJournal.bytes),native);dbs.push(identity.db);assertForwardIdentity(identity.db);
    const raw=object(musicBytes(input.oldMusic.bytes),'old music root'),old=projectMusic(raw,readIdentity(oldIdentity),new Map()).data;
    // Original mappings are immutable, including generated keys. A later native
    // profile may reserve a key absent at the rollback checkpoint.
    for(const key of baseline.keys){const next=native.keys.find(row=>row.profileId===key.profileId);if(!next||next.legacyKey!==key.legacyKey||next.mode!==key.mode)throw Error('Forward profile mapping changed');}
    const erased=new Set(native.keys.filter(row=>row.erased).map(row=>row.legacyKey));
    for(const row of board.native.prepare('SELECT legacy_key FROM music_legacy_erasures').all() as {legacy_key:string}[])erased.add(row.legacy_key);
    const oldMembers=object(old.members,'old music members');
    const retired=readMusicRetirements(board.native),baselineRetired=new Map(readMusicRetirements(board.checkpoint).map(row=>[row.profileId,row]));
    for(const marker of baselineRetired.values())if(!retired.some(row=>row.profileId===marker.profileId)&&!native.keys.some(row=>row.profileId===marker.profileId&&row.erased))throw Error('Forward original retirement cannot be removed without verified erasure');
    for(const marker of retired){const original=baselineRetired.get(marker.profileId);if(!original||original.legacyKey!==marker.legacyKey||original.retiredAt!==marker.retiredAt||original.originalProfileSha256!==marker.originalProfileSha256||!musicEqual(original.occurrences,marker.occurrences))throw Error('Forward retirement needs matching original baseline evidence');
      if(Object.hasOwn(oldMembers,marker.legacyKey)||['sessions','entry_intents','links','prelinks','link_overrides','native_profiles'].some(table=>oldIdentity.prepare('SELECT 1 FROM '+table+' WHERE qq=?').get(marker.legacyKey)))throw Error('Forward retired member or authentication revival requires explicit reconciliation');
    }
    for(const key of erased){if(Object.hasOwn(oldMembers,key)||['sessions','links','prelinks','link_overrides','link_audit','native_profiles','profile_contacts','entry_intents'].some(table=>oldIdentity.prepare(`SELECT 1 FROM "${table}" WHERE qq=?`).get(key)))throw Error('Forward erased profile requires authority-backed cleanup before source merge');}
    const erasedRefs=new Set([...erased,...native.keys.filter(row=>row.erased).map(row=>row.profileId)]);
    for(const value of Object.values(object(old.entries,'old entries')))if(erasedRefs.has(String(object(value,'old entry').createdBy??'')))throw Error('Forward erased creator requires authority-backed cleanup');
    for(const kind of ['shouts','shoutHistory']){const list=old[kind]??[];if(!Array.isArray(list))throw Error('Invalid forward shout list');for(const value of list)if(erasedRefs.has(String(object(value,'old shout').qq??'')))throw Error('Forward erased shout requires authority-backed cleanup');}
    for(const key of baseline.keys)if(!key.erased&&!key.retired&&!erased.has(key.legacyKey)&&!Object.hasOwn(oldMembers,key.legacyKey))throw Error('Forward member disappearance requires original erasure or reset authority');
    for(const table of ['link_audit','used_oauth']){
      const a=forwardRowReader(identity.db,table),b=forwardRowReader(oldIdentity,table);
      for(const row of forwardRows(baselineIdentity,table)){
        const n=a(row.__forward_rowid__),o=b(row.__forward_rowid__);
        if(table==='link_audit'&&erased.has(String(row.qq))&&!n&&!o)continue;
        if(!forwardEqual(row,n)||!forwardEqual(row,o))throw Error('Forward identity audit or consumed OAuth history changed');
      }
    }
    const seq=(db:DB)=>(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='link_audit'").safeIntegers(true).get() as {seq:bigint}|undefined)?.seq;
    const minimum=seq(baselineIdentity);if(minimum!==undefined&&((seq(identity.db)??-1n)<minimum||(seq(oldIdentity)??-1n)<minimum))throw Error('Forward identity high-water rewound');
    return {board,baseline,baselineIdentity,native,nativeIdentity:identity.db,nativeAuditMappings:identity.report.auditMappings,old,oldIdentity,erased,close(){for(const db of dbs.splice(0).reverse())db.close();board.close();}};
  }catch(error){for(const db of dbs.reverse())db.close();board.close();throw error;}
}
export type ForwardMusicSources=ReturnType<typeof openForwardMusicSources>;
