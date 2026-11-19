import {join} from 'node:path';
import type {DB} from '@qgroup/database';
import {decodeErasureJournal,erasureRequestId,type StoredIntent} from '../../apps/api/src/erasure-journal';
import {readRollbackErasureAuthority,privateFile,ErasureAuthorityRecord,validateAuthorityLedger} from '../../apps/api/src/erasure-authority-protocol';
import {parseJson} from '../../packages/runtime/src/strict-json';
import {forwardEqual,forwardRows,type ForwardBoardInput,type ForwardBoardSources} from './forward-board-storage';
import {assertRollbackSourceStructure} from './rollback-source';
import {readSourceRebaseEvidence} from './source-rebase-evidence';

export type ForwardBoardAccountInput={sources:ForwardBoardInput;authorityRoot:string;manifestSha256:string};
const text=(bytes:Buffer)=>new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
/** Full retained authority, not a caller-supplied list of accounts to remove. */
export function openForwardBoardAccountAuthority(input:ForwardBoardAccountInput,held:ForwardBoardInput,s:ForwardBoardSources){
  const authority=readRollbackErasureAuthority(input.authorityRoot,input.manifestSha256);
  if(authority.manifest.checkpointSha256!==held.checkpoint.sha256||!authority.ledgers.unified.equals(held.nativeJournal.bytes))throw Error('Board account authority source differs');
  const baseline=authority.manifest.baseline.find(row=>row.domain==='unified')!;
  const baselineFile=privateFile(join(input.authorityRoot,baseline.path),64*1024*1024);
  if(baselineFile.sha256!==baseline.sha256||!baselineFile.bytes?.equals(held.baselineJournal.bytes))throw Error('Board account authority baseline differs');
  let oldPhase=false;
  for(let sequence=1;sequence<=authority.head.sequence;sequence++){
    const file=privateFile(join(input.authorityRoot,'records',String(sequence).padStart(12,'0')+'.json'),90*1024*1024);
    const record=ErasureAuthorityRecord.parse(parseJson(text(file.bytes!)));file.assertUnchanged();
    if(record.version===2)throw Error('Board account merge requires complete structured reset repair');
    if(record.domain==='unified'&&oldPhase)throw Error('Interleaved board account authority requires full rebase');
    if(record.domain!=='unified')oldPhase=true;
  }
  const native=decodeErasureJournal(text(held.nativeJournal.bytes)),board=decodeErasureJournal(text(authority.ledgers.board));
  readSourceRebaseEvidence(s.native,native);readSourceRebaseEvidence(s.checkpoint,decodeErasureJournal(text(held.baselineJournal.bytes)));
  const added:StoredIntent[]=[],seen=new Map(native.map(row=>[erasureRequestId(row),row])),closed=new Map<string,{requestId:string;createdAt:string}>();
  for(const entry of board){
    if(!('user_id' in entry))throw Error('Board account merge requires original old closure');
    const previous=seen.get(entry.request_id);
    if(previous){
      const old='user_id' in previous?previous:'version' in previous&&previous.version===1&&previous.kind!=='music'?{user_id:previous.userId,request_id:previous.requestId,created_at:previous.createdAt}:null;
      if(!forwardEqual(old,entry))throw Error('Board account request scope conflicts');
    }else{seen.set(entry.request_id,entry);added.push(entry);}
    if(!s.old.prepare('SELECT 1 FROM users WHERE id=?').get(entry.user_id))throw Error('Original closed account tombstone is missing');
    const request=s.old.prepare('SELECT id,created_at FROM privacy_requests WHERE user_id=?').get(entry.user_id) as {id:string;created_at:string}|undefined;
    if(!request||request.id!==entry.request_id||request.created_at!==entry.created_at)throw Error('Original board closure row differs from authority');
    if(s.old.prepare('SELECT 1 FROM request_results WHERE user_id=?').get(entry.user_id))throw Error('Original closed account still contains private results');
    const user=s.old.prepare('SELECT nickname FROM users WHERE id=?').get(entry.user_id) as {nickname:string};
    if(user.nickname!=='已注销用户')throw Error('Original account closure footprint differs');
    const prior=closed.get(entry.user_id);if(prior&&!forwardEqual(prior,{requestId:entry.request_id,createdAt:entry.created_at}))throw Error('Original board closure identity conflicts');
    closed.set(entry.user_id,{requestId:entry.request_id,createdAt:entry.created_at});
  }
  for(const row of s.old.prepare('SELECT id,user_id,created_at FROM privacy_requests').all() as {id:string;user_id:string;created_at:string}[]){
    const original=closed.get(row.user_id);if(!original||original.requestId!==row.id||original.createdAt!==row.created_at)throw Error('Old account closure lacks its original authority');
  }
  const journal=Buffer.concat([held.nativeJournal.bytes,Buffer.from(added.map(row=>JSON.stringify(row)+'\n').join(''))]);validateAuthorityLedger('unified',journal);
  return {authority,closed,added,journal,journalReader:{read:()=>decodeErasureJournal(text(journal)),append(){throw Error('Read-only board account journal');}},assertUnchanged(){baselineFile.assertUnchanged();authority.assertUnchanged();}};
}
export type ForwardBoardAccountAuthority=ReturnType<typeof openForwardBoardAccountAuthority>;
/** Prove each pending child is the exact retained native receipt, and that its
 * existing native parent was removed by this original account closure. */
export function assertForwardBoardAccountReferences(s:ForwardBoardSources,db:DB,a:ForwardBoardAccountAuthority){
  db.transaction(()=>assertRollbackSourceStructure(db)).immediate();
  for(const [userId,closure] of a.closed){
    const request=db.prepare('SELECT id,created_at FROM privacy_requests WHERE user_id=?').get(userId) as {id:string;created_at:string}|undefined;
    if(!request||request.id!==closure.requestId||request.created_at!==closure.createdAt)throw Error('Merged original closure row differs');
  }
  const resultFk=(db.prepare('PRAGMA foreign_key_list(music_profile_receipts)').all() as {id:number;table:string}[]).find(row=>row.table==='request_results')?.id;
  const nativeReceipts=new Map([...forwardRows(s.native,'music_profile_receipts')].map(row=>[row.__forward_rowid__,row]));
  const receipts=new Map([...forwardRows(db,'music_profile_receipts')].map(row=>[row.__forward_rowid__,row]));
  const violations=db.prepare('PRAGMA foreign_key_check').safeIntegers(true).all() as {table:string;rowid:bigint;parent:string;fkid:bigint}[];
  for(const fk of violations){
    if(fk.table!=='music_profile_receipts'||fk.parent!=='request_results'||fk.fkid!==BigInt(resultFk??-1))throw Error('Unproven cross-domain account reference');
    const child=receipts.get(fk.rowid),before=nativeReceipts.get(fk.rowid);
    if(!child||!forwardEqual(child,before)||!a.closed.has(String(child.user_id))||!s.native.prepare('SELECT 1 FROM request_results WHERE user_id=? AND request_key=?').get(child.user_id,child.request_key)||s.old.prepare('SELECT 1 FROM request_results WHERE user_id=? AND request_key=?').get(child.user_id,child.request_key))throw Error('Unproven original account receipt deletion');
  }
  return {pendingAccountReceiptReferences:violations.length,originalClosures:a.closed.size};
}
/** Only original old IDs are added as applied markers; no request or receipt is
 * created, and the independent account oracle checks every final row. */
export function markForwardBoardAccountClosures(db:DB,a:ForwardBoardAccountAuthority){
  db.transaction(()=>{for(const entry of a.added){if(!('user_id' in entry))throw Error('Original board marker required');db.prepare('INSERT INTO erasure_applied VALUES(?)').run(entry.request_id);}}).immediate();
}
export function guardForwardBoardAccountInput(input:ForwardBoardAccountInput,held:ForwardBoardInput,a:ForwardBoardAccountAuthority,root:string,pin:string,boundary?:()=>void){
  const value:unknown=boundary?.();if(value!==null&&(typeof value==='object'||typeof value==='function')&&'then' in value)throw Error('Board account boundary must be synchronous');
  if(input.authorityRoot!==root||input.manifestSha256!==pin)throw Error('Board account authority changed');
  for(const name of Object.keys(held) as (keyof ForwardBoardInput)[])if(input.sources[name].sha256!==held[name].sha256||!input.sources[name].bytes.equals(held[name].bytes))throw Error('Board account source changed');
  a.assertUnchanged();
}
export const boardAccountPins=(held:ForwardBoardInput)=>Object.fromEntries(Object.entries(held).map(([key,row])=>[key,row.sha256]));
