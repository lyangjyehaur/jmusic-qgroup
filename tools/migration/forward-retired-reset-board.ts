import Database from 'better-sqlite3';
import {readMusicRetirements} from '@qgroup/database';
import {assertForwardImage,forwardRows,forwardEqual,forwardHash,forwardSequences,type PinnedForwardBytes,type ForwardRow} from './forward-board-storage';
import {schemaObjects,quoted} from './board-reconciliation';

export type RetiredResetBoardInput={originalNative:PinnedForwardBytes;retiredNative:PinnedForwardBytes;oldBoard:PinnedForwardBytes};
const pin=(bytes:Buffer):PinnedForwardBytes=>({bytes:Buffer.from(bytes),sha256:forwardHash(bytes)});
function held(input:RetiredResetBoardInput,boundary?:()=>void){
  const s={originalNative:pin(input.originalNative.bytes),retiredNative:pin(input.retiredNative.bytes),oldBoard:pin(input.oldBoard.bytes)};
  for(const key of Object.keys(s) as (keyof typeof s)[]){assertForwardImage(s[key].bytes);if(input[key].sha256!==s[key].sha256)throw Error('Retired board original pin differs');}
  const guard=()=>{const value:unknown=boundary?.();if(value!==null&&(typeof value==='object'||typeof value==='function')&&'then' in value)throw Error('Retired board boundary must be synchronous');for(const key of Object.keys(s) as (keyof typeof s)[])if(input[key].sha256!==s[key].sha256||!Buffer.isBuffer(input[key].bytes)||!input[key].bytes.equals(s[key].bytes))throw Error('Retired board source changed');};
  guard();return {s,guard};
}
function expectedRows(input:RetiredResetBoardInput){
  const original=new Database(input.originalNative.bytes),retired=new Database(input.retiredNative.bytes),board=new Database(input.oldBoard.bytes);
  try{
    const ids=new Set(readMusicRetirements(retired).map(row=>row.profileId)),key=(row:ForwardRow)=>JSON.stringify([row.user_id,row.request_key]),receipts=new Set([...forwardRows(original,'music_profile_receipts')].filter(row=>ids.has(String(row.profile_id))).map(key));
    const before=new Map([...forwardRows(original,'request_results')].map(row=>[key(row),row])),after=new Map([...forwardRows(retired,'request_results')].map(row=>[key(row),row])),changes:{user:string;request:string;response:string}[]=[];
    const columns=board.prepare('PRAGMA table_xinfo(request_results)').all() as {name:string}[],statusType=columns.findIndex(row=>row.name==='response_status'),jsonType=columns.findIndex(row=>row.name==='response_json');
    if(statusType<0||jsonType<0)throw Error('Retired board cached response schema differs');
    const rows=[...forwardRows(board,'request_results')].map(row=>{
      if(!receipts.has(key(row)))return row;
      const old=before.get(key(row)),expired=after.get(key(row));
      if(!old||!expired||expired.response_status!==410n)throw Error('Retired board needs the verified native response disposition');
      const withOrdinal=(value:ForwardRow)=>({...value,__forward_rowid__:row.__forward_rowid__});
      if(forwardEqual(row,withOrdinal(expired)))return row;
      if(!forwardEqual(row,withOrdinal(old)))throw Error('Retired cached board response changed; retain both original sources for reconciliation');
      changes.push({user:String(row.user_id),request:String(row.request_key),response:String(expired.response_json)});
      return {...row,response_status:expired.response_status,response_json:expired.response_json,['__forward_type_'+statusType]:'integer',['__forward_type_'+jsonType]:'text'};
    });
    return {rows,changes};
  }finally{board.close();retired.close();original.close();}
}
function report(input:RetiredResetBoardInput,board:PinnedForwardBytes,count:number){return {version:1 as const,originalNativeSha256:input.originalNative.sha256,retiredNativeSha256:input.retiredNative.sha256,originalBoardSha256:input.oldBoard.sha256,derivedBoardSha256:board.sha256,expiredResults:count,allOtherOriginalRowsPreserved:true as const,retiredBoardResponsesPrepared:true as const,releaseEligible:false as const};}
/** Prevent an unchanged old cached save response from undoing the retirement's
 * 410 disposition during the three-way board merge. Changed responses require
 * explicit reconciliation; every original board row and image is retained.
 * The caller first verifies the complete native retirement bundle. */
export type RetiredResetBoardBundle={board:PinnedForwardBytes;retainedBoard:PinnedForwardBytes;report:ReturnType<typeof report>};
export function prepareRetiredResetBoard(input:RetiredResetBoardInput,boundary?:()=>void):RetiredResetBoardBundle{
  const h=held(input,boundary),expected=expectedRows(h.s),db=new Database(h.s.oldBoard.bytes);
  try{db.transaction(()=>{for(const row of expected.changes)db.prepare('UPDATE request_results SET response_status=410,response_json=? WHERE user_id=? AND request_key=?').run(row.response,row.user,row.request);}).immediate();
    const board=pin(db.serialize()),bundle={board,retainedBoard:pin(h.s.oldBoard.bytes),report:report(h.s,board,expected.changes.length)};verifyRetiredResetBoard(h.s,bundle,h.guard);h.guard();return bundle;
  }finally{db.close();}
}
/** Independent full-row oracle; does not rerun the board writer. */
export function verifyRetiredResetBoard(input:RetiredResetBoardInput,bundle:RetiredResetBoardBundle,boundary?:()=>void){
  const fingerprint=()=>JSON.stringify([bundle.board.sha256,forwardHash(bundle.board.bytes),bundle.retainedBoard.sha256,forwardHash(bundle.retainedBoard.bytes),bundle.report]),before=fingerprint(),h=held(input,()=>{const value:unknown=boundary?.();if(value!==null&&(typeof value==='object'||typeof value==='function')&&'then' in value)throw Error('Retired board boundary must be synchronous');if(fingerprint()!==before)throw Error('Retired board output changed');});
  if(bundle.retainedBoard.sha256!==h.s.oldBoard.sha256||!bundle.retainedBoard.bytes.equals(h.s.oldBoard.bytes)||forwardHash(bundle.board.bytes)!==bundle.board.sha256)throw Error('Retired board retained source or output pin differs');
  const expected=expectedRows(h.s),original=new Database(h.s.oldBoard.bytes),copy=new Database(bundle.board.bytes);
  try{
    if(!forwardEqual(schemaObjects(original),schemaObjects(copy))||!forwardEqual(forwardSequences(original),forwardSequences(copy))||copy.pragma('integrity_check',{simple:true})!=='ok'||(copy.pragma('foreign_key_check') as unknown[]).length)throw Error('Retired board schema or integrity differs');
    for(const name of ['encoding','user_version','application_id'])if(original.pragma(name,{simple:true})!==copy.pragma(name,{simple:true}))throw Error('Retired board metadata differs');
    for(const row of schemaObjects(original).filter(row=>row.type==='table'&&!row.name.startsWith('sqlite_')))if(!forwardEqual([...forwardRows(copy,row.name)],row.name==='request_results'?expected.rows:[...forwardRows(original,row.name)]))throw Error('Retired board original row relation differs: '+quoted(row.name));
    if(!forwardEqual(bundle.report,report(h.s,bundle.board,expected.changes.length)))throw Error('Retired board report differs');h.guard();return bundle.report;
  }finally{copy.close();original.close();}
}
