import {afterAll,beforeAll,expect,it} from 'vitest';
import Database from 'better-sqlite3';
import {legacyResetRecoveryFixture} from '../testsupport/legacy-reset-recovery-fixture';
import {prepareForwardResetRetirementSources} from '../../../tools/migration/forward-reset-retirement-sources';
import {prepareRetiredResetBoard,verifyRetiredResetBoard,type RetiredResetBoardInput,type RetiredResetBoardBundle} from '../../../tools/migration/forward-retired-reset-board';
import {forwardHash,forwardRows} from '../../../tools/migration/forward-board-storage';
let s:Awaited<ReturnType<typeof legacyResetRecoveryFixture>>,input:RetiredResetBoardInput,bundle:RetiredResetBoardBundle;
const pin=(bytes:Buffer)=>({bytes:Buffer.from(bytes),sha256:forwardHash(bytes)});
beforeAll(async()=>{s=await legacyResetRecoveryFixture(true,false,'persisted-only','completed');const retirement=prepareForwardResetRetirementSources({members:{vault:s.input.vault,music:s.recoveryInput.latestMusic,identity:s.recoveryInput.latestIdentity},checkpoint:s.input.checkpoint,nativeImage:pin(s.recoveryInput.erasures.nativeImage),nativeJournal:pin(s.recoveryInput.erasures.nativeJournal),retiredAt:s.recoveryInput.reconstructedAt});input={originalNative:pin(retirement.native.retainedNativeImage),retiredNative:pin(retirement.native.nativeImage),oldBoard:s.recoveryInput.latestBoard};bundle=prepareRetiredResetBoard(input);},60000);
afterAll(()=>s?.close());
function copy():RetiredResetBoardBundle{return {board:pin(bundle.board.bytes),retainedBoard:pin(bundle.retainedBoard.bytes),report:structuredClone(bundle.report)};}
function changed(bytes:Buffer,change:(db:Database.Database)=>void){const db=new Database(bytes);try{change(db);return pin(db.serialize());}finally{db.close();}}
it('expires only the original retired cached save while preserving all original board rows, rowids, receipts and bot delivery states',()=>{
  const db=new Database(bundle.board.bytes),original=new Database(input.oldBoard.bytes);
  try{
    expect(verifyRetiredResetBoard(input,bundle)).toMatchObject({expiredResults:1,allOtherOriginalRowsPreserved:true,releaseEligible:false});
    expect(db.prepare("SELECT response_status FROM request_results WHERE request_key='original-retired-save'").get()).toEqual({response_status:410});
    for(const table of ['bot_outbox','bot_settings','bot_settings_history','bot_runtime','browser_sessions','users'])expect([...forwardRows(db,table)]).toEqual([...forwardRows(original,table)]);
    expect(bundle.retainedBoard.bytes).toEqual(input.oldBoard.bytes);
  }finally{original.close();db.close();}
});
it('accepts already-expired original responses without changing or replaying them',()=>{
  const result=prepareRetiredResetBoard({...input,oldBoard:bundle.board});expect(result.report.expiredResults).toBe(0);expect(result.board.bytes).toEqual(bundle.board.bytes);
});
it('retains a legitimately missing old cached result instead of synthesizing a new row',()=>{
  const oldBoard=changed(input.oldBoard.bytes,db=>{db.prepare("DELETE FROM request_results WHERE request_key='original-retired-save'").run();}),result=prepareRetiredResetBoard({...input,oldBoard});expect(result.report.expiredResults).toBe(0);expect(result.board.bytes).toEqual(oldBoard.bytes);
});
it('rejects changed old responses and retains both source images for explicit reconciliation',()=>{
  const oldBoard=changed(input.oldBoard.bytes,db=>{db.prepare("UPDATE request_results SET signature='new-original-operation' WHERE request_key='original-retired-save'").run();}),original=Buffer.from(oldBoard.bytes);expect(()=>prepareRetiredResetBoard({...input,oldBoard})).toThrow('cached board response changed');expect(oldBoard.bytes).toEqual(original);
});
it.each(['reactivation','rowid','bot-work','metadata','retained-image','report'] as const)('independently rejects re-pinned retired board %s corruption',kind=>{
  const value=copy();
  if(kind==='reactivation')value.board=changed(value.board.bytes,db=>{db.prepare("UPDATE request_results SET response_status=200 WHERE request_key='original-retired-save'").run();});
  if(kind==='rowid')value.board=changed(value.board.bytes,db=>{db.prepare("UPDATE request_results SET rowid=rowid+10000 WHERE request_key='original-retired-save'").run();});
  if(kind==='bot-work')value.board=changed(value.board.bytes,db=>{db.prepare("UPDATE bot_outbox SET last_error='changed'").run();});
  if(kind==='metadata')value.board=changed(value.board.bytes,db=>{db.pragma('application_id=7654');});
  if(kind==='retained-image')value.retainedBoard.bytes[0]=value.retainedBoard.bytes[0]!^1;
  if(kind==='report')Object.assign(value.report,{releaseEligible:true});
  value.report.derivedBoardSha256=value.board.sha256;expect(()=>verifyRetiredResetBoard(input,value)).toThrow();
});
it('fences late source/output changes and rejects asynchronous boundaries',()=>{
  const value=copy();expect(()=>verifyRetiredResetBoard(input,value,()=>{value.board.bytes[0]=value.board.bytes[0]!^1;})).toThrow('output changed');
  const source={...input,oldBoard:pin(input.oldBoard.bytes)};expect(()=>prepareRetiredResetBoard(source,()=>{source.oldBoard.bytes[0]=source.oldBoard.bytes[0]!^1;})).toThrow('source changed');
  expect(()=>verifyRetiredResetBoard(input,bundle,(()=>Promise.resolve()) as unknown as ()=>void)).toThrow('synchronous');
});
