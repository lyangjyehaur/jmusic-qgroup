import {z} from 'zod';
import {prepareForwardAccountEpoch,verifyForwardAccountEpoch,accountPin,type ForwardAccountEpochInput,type ForwardAccountEpoch} from './forward-account-epoch';
import {copyForwardMusicInput} from './forward-music-sources';
import {reconstructForwardBusiness} from './forward-business-reconstruction';
import {verifyForwardBusiness} from './forward-business-reconciliation';
import {reconstructForwardProofs} from './forward-proof-reconstruction';
import {verifyForwardProofBundle} from './forward-proof-reconciliation';
import {forwardHash} from './forward-board-storage';
import {readRollbackErasureAuthority} from '../../apps/api/src/erasure-authority-protocol';
import {stringifyJson,parseJson} from './music-codec';

export type ForwardAccountBusinessInput=ForwardAccountEpochInput&{reconstructedAt:string;reconciledAt:string};
export type ForwardAccountBusinessBundle={epoch:ForwardAccountEpoch;nativeImage:Buffer;nativeJournal:Buffer;retainedBusinessImage:Buffer;musicSources:Buffer;identitySources:Buffer};
function times(input:ForwardAccountBusinessInput){for(const key of ['preparedAt','reconstructedAt','reconciledAt'] as const)z.iso.datetime().parse(input[key]);if(Date.parse(input.preparedAt)>Date.parse(input.reconstructedAt)||Date.parse(input.reconstructedAt)>Date.parse(input.reconciledAt))throw Error('Account business operation times are out of order');}
function proofInput(input:ForwardAccountBusinessInput,bundle:ForwardAccountBusinessBundle){return {sources:bundle.epoch.sources,businessImage:accountPin(bundle.retainedBusinessImage),musicSources:accountPin(bundle.musicSources),identitySources:accountPin(bundle.identitySources),reconstructedAt:input.reconstructedAt,reconciledAt:input.reconciledAt};}
/** Original authority-bound source merge -> valid derived epoch -> actual native
 * business and proof reconstruction. Every original source remains required. */
export function reconstructForwardAccountBusiness(input:ForwardAccountBusinessInput,boundary?:()=>void){
  times(input);const held={...input,sources:copyForwardMusicInput(input.sources)},root=input.authorityRoot,pin=input.manifestSha256,authority=readRollbackErasureAuthority(root,pin);
  const guard=()=>{const value:unknown=boundary?.();if(value!==null&&(typeof value==='object'||typeof value==='function')&&'then' in value)throw Error('Account business boundary must be synchronous');if(input.authorityRoot!==root||input.manifestSha256!==pin||input.preparedAt!==held.preparedAt||input.reconstructedAt!==held.reconstructedAt||input.reconciledAt!==held.reconciledAt)throw Error('Account business identity changed');for(const key of Object.keys(held.sources) as (keyof typeof held.sources)[])if(input.sources[key].sha256!==held.sources[key].sha256||!input.sources[key].bytes.equals(held.sources[key].bytes))throw Error('Account business original source changed');authority.assertUnchanged();};
  guard();const epoch=prepareForwardAccountEpoch(held),business=reconstructForwardBusiness(epoch.sources,held.reconstructedAt),bundle:ForwardAccountBusinessBundle={epoch,nativeImage:Buffer.alloc(0),nativeJournal:Buffer.from(epoch.sources.nativeJournal.bytes),retainedBusinessImage:business.nativeImage,musicSources:Buffer.from(stringifyJson(business.musicSources)),identitySources:business.identitySources};
  const proof=reconstructForwardProofs(proofInput(held,bundle));bundle.nativeImage=proof.nativeImage;
  const verification=verifyForwardAccountBusiness(held,bundle);guard();
  return {...bundle,report:{...verification,originalAuthorityBound:true as const,businessAndProofsReconstructed:true as const,sourceRebaseRequired:true as const,externalRetentionVerified:false as const,recoveryRequired:true as const,rollbackEligible:false as const,releaseEligible:false as const,remaining:['complete_latest_music_erasure_and_structured_reset_generation','repeated_source_epoch_ancestry_history_rebase_and_external_high_water','media_browser_stopped_capture_and_private_latest_erasure_access','fixed_actual_web_bot_versions_B01_B15_and_audited_activation']}};
}
/** Re-verify the entire parent, rather than trusting a re-pinned derived plan. */
export function verifyForwardAccountBusiness(input:ForwardAccountBusinessInput,bundle:ForwardAccountBusinessBundle){
  times(input);const held={...input,sources:copyForwardMusicInput(input.sources)},authority=readRollbackErasureAuthority(held.authorityRoot,held.manifestSha256),epoch=verifyForwardAccountEpoch(held,bundle.epoch),proofs=proofInput(held,bundle);
  const music=parseJson(new TextDecoder('utf-8',{fatal:true}).decode(bundle.musicSources)) as unknown as Parameters<typeof verifyForwardBusiness>[2];
  const business=verifyForwardBusiness(bundle.epoch.sources,bundle.retainedBusinessImage,music,bundle.identitySources,held.reconstructedAt);
  const proof=verifyForwardProofBundle(proofs,{nativeImage:bundle.nativeImage,nativeJournal:bundle.nativeJournal,retainedBusinessImage:bundle.retainedBusinessImage,musicSources:bundle.musicSources,identitySources:bundle.identitySources});
  authority.assertUnchanged();
  return {version:1 as const,epoch,business,proof,nativeImageSha256:forwardHash(bundle.nativeImage),nativeJournalSha256:forwardHash(bundle.nativeJournal),allSourcesBusinessAndProofsVerified:true as const,releaseEligible:false as const};
}
