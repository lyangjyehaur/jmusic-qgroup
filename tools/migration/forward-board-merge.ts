import Database from 'better-sqlite3';
import {applyForwardBoardRows} from './forward-board-rows';
import {copyForwardBoardInput,openForwardBoardSources,forwardHash,forwardLineage,assertForwardImage,type ForwardBoardInput} from './forward-board-storage';
import {reconcileForwardBoardSources} from './forward-board-reconciliation';

/** Offline board business merge, before full music/identity/media and erasure
 * reconciliation. Sources are immutable pinned buffers, SQLite stays in memory,
 * no source history/audit/receipt is manufactured and activation stays blocked. */
export function mergeForwardBoard(input:ForwardBoardInput,assertBoundary?:()=>void){
  const held=copyForwardBoardInput(input),sources=openForwardBoardSources(held);let db:Database.Database|undefined;
  function guard(){const result:unknown=assertBoundary?.();if(result!==null&&(typeof result==='object'||typeof result==='function')&&'then' in result)throw Error('Forward board boundary must be synchronous');for(const name of Object.keys(held) as (keyof ForwardBoardInput)[])if(input[name].sha256!==held[name].sha256||!input[name].bytes.equals(held[name].bytes))throw Error('Forward board source changed');}
  try{
    guard();db=new Database(held.nativeImage.bytes);const candidate=db;candidate.pragma('foreign_keys=OFF');
    const decisions=applyForwardBoardRows(sources,candidate);
    candidate.pragma('foreign_keys=ON');const reconciliation=reconcileForwardBoardSources(sources,candidate);guard();const nativeImage=candidate.serialize();assertForwardImage(nativeImage);
    return {nativeImage,nativeJournal:Buffer.from(held.nativeJournal.bytes),report:{version:1 as const,sourcePins:Object.fromEntries(Object.entries(held).map(([name,item])=>[name,item.sha256])),lineageId:forwardLineage(candidate),nativeImageSha256:forwardHash(nativeImage),decisions,reconciliation,boardOnly:true as const,recoveryRequired:true as const,rollbackEligible:false as const,releaseEligible:false as const,remaining:['stopped_old_and_native_source_capture_provenance','music_identity_media_browser_forward_merge','original_source_mapping_and_pending_proof_reconciliation','complete_erasure_footprint_replay_after_business_merge','structured_reset_history_cutoff','authority_epoch_rebase_and_external_high_water','fixed_web_music_bot_versions_and_audited_activation']}};
  }finally{db?.close();sources.close();}
}
