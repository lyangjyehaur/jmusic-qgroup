import Database from 'better-sqlite3';
import type {DB} from '@qgroup/database';
import {assertForwardIdentity,musicEqual} from './forward-music-sources';
import {assertForwardImage,forwardHash,forwardRows,forwardEqual,type PinnedForwardBytes} from './forward-board-storage';
import {schemaObjects} from './board-reconciliation';
import {identityTables} from './rollback-identity-source';
export type ResetIdentityRowsInput={baseline:PinnedForwardBytes;native:PinnedForwardBytes;old:PinnedForwardBytes};
const tables=['native_profiles','prelinks','profile_contacts'] as const;
type Binding={table:typeof tables[number];qq:string;originalRowid:string;derivedRowid:string};
function held(input:ResetIdentityRowsInput,boundary?:()=>void){
  const s=Object.fromEntries(Object.entries(input).map(([key,row])=>[key,{bytes:Buffer.from(row.bytes),sha256:row.sha256}])) as ResetIdentityRowsInput;
  const guard=()=>{const value:unknown=boundary?.();if(value!==null&&(typeof value==='object'||typeof value==='function')&&'then' in value)throw Error('Reset identity rows boundary must be synchronous');for(const key of ['baseline','native','old'] as const)if(input[key].sha256!==s[key].sha256||!Buffer.isBuffer(input[key].bytes)||!input[key].bytes.equals(s[key].bytes))throw Error('Reset identity row source changed');};
  for(const row of Object.values(s)){assertForwardImage(row.bytes);if(forwardHash(row.bytes)!==row.sha256)throw Error('Reset identity row source pin differs');}
  const dbs:DB[]=[];try{for(const key of ['baseline','native','old'] as const){const db=new Database(s[key].bytes);dbs.push(db);assertForwardIdentity(db);}guard();return {s,guard,baseline:dbs[0]!,native:dbs[1]!,old:dbs[2]!,close(){dbs.reverse().forEach(db=>db.close());}};}catch(error){dbs.reverse().forEach(db=>db.close());throw error;}
}
/** Explicit source derivation only for independently added identity members.
 * Keep native rowids; allocate a bound old rowid only when both appended distinct
 * QQ keys into the same empty baseline slot. Original images stay retained. */
export function prepareForwardLegacyResetIdentityRows(input:ResetIdentityRowsInput,boundary?:()=>void){
  const h=held(input,boundary),bindings:Binding[]=[];
  try{
    h.old.transaction(()=>{
      for(const table of tables){
        const before=[...forwardRows(h.baseline,table)],current=[...forwardRows(h.native,table)],legacy=[...forwardRows(h.old,table)],known=new Set(before.map(row=>row.qq)),occupied=new Map(current.map(row=>[row.__forward_rowid__,row]));
        let high=[...before,...current,...legacy].reduce((high,row)=>high>row.__forward_rowid__?high:row.__forward_rowid__,0n);
        for(const row of legacy){const other=occupied.get(row.__forward_rowid__);if(!other||other.qq===row.qq||before.some(item=>item.__forward_rowid__===row.__forward_rowid__)||known.has(row.qq)||known.has(other.qq))continue;
          if(high===9223372036854775807n)throw Error('Reset identity rowid capacity exhausted');const id=++high;h.old.prepare(`UPDATE ${table} SET rowid=? WHERE rowid=?`).run(id,row.__forward_rowid__);bindings.push({table,qq:String(row.qq),originalRowid:String(row.__forward_rowid__),derivedRowid:String(id)});
        }
      }
    }).immediate();h.guard();const bytes=h.old.serialize(),identity={bytes,sha256:forwardHash(bytes)},result={identity,bindings};const report=verifyForwardLegacyResetIdentityRows(input,result,h.guard);h.guard();return {...result,report};
  }finally{h.close();}
}
export type ResetIdentityRowsBundle={identity:PinnedForwardBytes;bindings:Binding[]};
/** Independent complete row/storage-class oracle; no writer plan is consulted. */
export function verifyForwardLegacyResetIdentityRows(input:ResetIdentityRowsInput,bundle:ResetIdentityRowsBundle,boundary?:()=>void){
  const original=JSON.stringify([bundle.identity.sha256,forwardHash(bundle.identity.bytes),bundle.bindings]),h=held(input,()=>{const value:unknown=boundary?.();if(value!==null&&(typeof value==='object'||typeof value==='function')&&'then' in value)throw Error('Reset identity rows boundary must be synchronous');if(JSON.stringify([bundle.identity.sha256,forwardHash(bundle.identity.bytes),bundle.bindings])!==original)throw Error('Reset identity row output changed');});let db:DB|undefined;
  const reject=():never=>{throw Error('Original reset identity row relation differs; retain both original images');};
  try{
    assertForwardImage(bundle.identity.bytes);if(forwardHash(bundle.identity.bytes)!==bundle.identity.sha256)reject();db=new Database(bundle.identity.bytes);assertForwardIdentity(db);if(!forwardEqual(schemaObjects(h.old),schemaObjects(db)))reject();for(const key of ['user_version','application_id','encoding'])if(h.old.pragma(key,{simple:true})!==db.pragma(key,{simple:true}))reject();
    const wanted:Binding[]=[];let rows=0;
    for(const table of identityTables){
      const source=[...forwardRows(h.old,table)],expected=source.map(row=>({...row}));
      if(tables.some(name=>name===table)){
        const b=[...forwardRows(h.baseline,table)],n=[...forwardRows(h.native,table)],all=[...b,...n,...source];let next=all.map(row=>row.__forward_rowid__).reduce((high,id)=>high>id?high:id,0n);
        for(const row of expected){const collision=n.find(item=>item.__forward_rowid__===row.__forward_rowid__);if(!collision||collision.qq===row.qq||b.some(item=>item.__forward_rowid__===row.__forward_rowid__||item.qq===row.qq||item.qq===collision.qq))continue;
          if(next===9223372036854775807n)reject();const previous=row.__forward_rowid__;row.__forward_rowid__=++next;wanted.push({table:table as Binding['table'],qq:String(row.qq),originalRowid:String(previous),derivedRowid:String(next)});
        }
      }
      if(!forwardEqual(expected.sort((a,b)=>a.__forward_rowid__<b.__forward_rowid__?-1:1),[...forwardRows(db,table)]))reject();rows+=source.length;
    }
    wanted.sort((a,b)=>tables.indexOf(a.table)-tables.indexOf(b.table)||(BigInt(a.originalRowid)<BigInt(b.originalRowid)?-1:BigInt(a.originalRowid)>BigInt(b.originalRowid)?1:0));
    if(!musicEqual(bundle.bindings,wanted)||!forwardEqual([...forwardRows(h.old,'sqlite_sequence')],[...forwardRows(db,'sqlite_sequence')]))reject();h.guard();return {sourcePins:{baseline:h.s.baseline.sha256,native:h.s.native.sha256,old:h.s.old.sha256},derivedIdentitySha256:bundle.identity.sha256,identityTables:10 as const,originalRows:rows,explicitBindings:wanted,allValuesAndStorageClassesVerified:true as const,originalImagesRequired:true as const,releaseEligible:false as const};
  }finally{db?.close();h.close();}
}
