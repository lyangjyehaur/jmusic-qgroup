import Database from 'better-sqlite3';
import {forwardHash} from './forward-board-storage';
import {copyForwardMusicInput,openForwardMusicSources,type ForwardMusicInput} from './forward-music-sources';
import {reconcileForwardMusicSources} from './forward-music-reconciliation';
import {mergeForwardMusicRows} from './forward-music-rows';

/** Merge private legacy-shaped business sources. No native image, credential
 * activation, source-file access or authority mutation. Full native reconstruction
 * must preserve native-only revisions, PINs, receipts and original source evidence. */
export function mergeForwardMusic(input:ForwardMusicInput,assertBoundary?:()=>void){
  const held=copyForwardMusicInput(input),s=openForwardMusicSources(held);let identity:Database.Database|undefined;
  const guard=()=>{const value:unknown=assertBoundary?.();if(value!==null&&(typeof value==='object'||typeof value==='function')&&'then' in value)throw Error('Forward music boundary must be synchronous');for(const name of Object.keys(held) as (keyof ForwardMusicInput)[])if(input[name].sha256!==held[name].sha256||!input[name].bytes.equals(held[name].bytes))throw Error('Forward music source changed');};
  try{
    guard();const raw=mergeForwardMusicRows(s),music=raw.music;identity=raw.identity;const candidate=identity;
    const reconciliation=reconcileForwardMusicSources(s,music,candidate);guard();const identityImage=candidate.serialize();
    return {music,identityImage,report:{version:1 as const,sourcePins:Object.fromEntries(Object.entries(held).map(([key,item])=>[key,item.sha256])),identityImageSha256:forwardHash(identityImage),reconciliation,sourceOnly:true as const,nativeReconstructionRequired:true as const,authenticationActive:false as const,recoveryRequired:true as const,rollbackEligible:false as const,releaseEligible:false as const,remaining:['native_only_state_and_source_provenance_reconstruction','complete_authority_backed_erasure_and_reset_replay','media_browser_pending_proof_reconciliation','stopped_source_capture_and_authority_epoch_rebase','fixed_service_versions_and_audited_activation']}};
  }finally{identity?.close();s.close();}
}
