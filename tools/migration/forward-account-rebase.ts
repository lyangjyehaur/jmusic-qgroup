import {z} from 'zod';
import {copyForwardMusicInput} from './forward-music-sources';
import {accountPin,type ForwardAccountEpoch} from './forward-account-epoch';
import {verifyForwardAccountBusiness,type ForwardAccountBusinessInput,type ForwardAccountBusinessBundle} from './forward-account-business';
import {openForwardSourceRebase,type ForwardSourceRebaseInput} from './forward-source-rebase-source';
import {rebaseForwardSourceRows} from './forward-source-rebase-rows';
import {verifyForwardSourceRebaseBundle} from './forward-source-rebase-reconciliation';
import {readRollbackErasureAuthority} from '../../apps/api/src/erasure-authority-protocol';

function copied(bundle:ForwardAccountBusinessBundle):ForwardAccountBusinessBundle{
  const epoch:ForwardAccountEpoch={sources:copyForwardMusicInput(bundle.epoch.sources),accountBase:accountPin(bundle.epoch.accountBase.bytes),rawMusic:accountPin(bundle.epoch.rawMusic.bytes),rawIdentity:accountPin(bundle.epoch.rawIdentity.bytes),cleanMusic:accountPin(bundle.epoch.cleanMusic.bytes),cleanIdentity:accountPin(bundle.epoch.cleanIdentity.bytes)};
  for(const key of ['accountBase','rawMusic','rawIdentity','cleanMusic','cleanIdentity'] as const)if(epoch[key].sha256!==bundle.epoch[key].sha256)throw Error('Account rebase source pin differs');
  return {epoch,nativeImage:Buffer.from(bundle.nativeImage),nativeJournal:Buffer.from(bundle.nativeJournal),retainedBusinessImage:Buffer.from(bundle.retainedBusinessImage),musicSources:Buffer.from(bundle.musicSources),identitySources:Buffer.from(bundle.identitySources)};
}
function inputFor(input:ForwardAccountBusinessInput,b:ForwardAccountBusinessBundle,rebasedAt:string):ForwardSourceRebaseInput{return {proofs:{sources:b.epoch.sources,businessImage:accountPin(b.retainedBusinessImage),musicSources:accountPin(b.musicSources),identitySources:accountPin(b.identitySources),reconstructedAt:input.reconstructedAt,reconciledAt:input.reconciledAt},proofImage:accountPin(b.nativeImage),rebasedAt};}
export type ForwardAccountRebaseBundle={nativeImage:Buffer;nativeJournal:Buffer;retainedProofImage:Buffer;retainedBusinessImage:Buffer;musicSources:Buffer;identitySources:Buffer;retainedAccountParent:ForwardAccountBusinessBundle;retainedAccountInput:ForwardAccountBusinessInput};
function sameInput(a:ForwardAccountBusinessInput,b:ForwardAccountBusinessInput){
  for(const key of ['authorityRoot','manifestSha256','preparedAt','reconstructedAt','reconciledAt'] as const)if(a[key]!==b[key])throw Error('Retained account input identity differs');
  const held=copyForwardMusicInput(a.sources),other=copyForwardMusicInput(b.sources);
  for(const key of Object.keys(held) as (keyof typeof held)[])if(held[key].sha256!==other[key].sha256||!held[key].bytes.equals(other[key].bytes))throw Error('Retained original account source differs');
}
function sameParent(a:ForwardAccountBusinessBundle,b:ForwardAccountBusinessBundle){
  const held=copied(a),other=copied(b);
  for(const key of ['nativeImage','nativeJournal','retainedBusinessImage','musicSources','identitySources'] as const)if(!held[key].equals(other[key]))throw Error('Retained account parent differs');
  for(const key of ['accountBase','rawMusic','rawIdentity','cleanMusic','cleanIdentity'] as const)if(held.epoch[key].sha256!==other.epoch[key].sha256||!held.epoch[key].bytes.equals(other.epoch[key].bytes))throw Error('Retained account epoch differs');
  for(const key of Object.keys(held.epoch.sources) as (keyof typeof held.epoch.sources)[])if(!held.epoch.sources[key].bytes.equals(other.epoch.sources[key].bytes))throw Error('Retained account derived source differs');
}
/** Only a complete original-source+authority+business+proof parent can supersede
 * its previous source evidence. Original epochs remain in the retained bundle;
 * this does not grant external custody, authority activation or deployment. */
export function rebaseForwardAccountBusiness(input:ForwardAccountBusinessInput,bundle:ForwardAccountBusinessBundle,rebasedAt:string,boundary?:()=>void){
  z.iso.datetime().parse(rebasedAt);const held={...input,sources:copyForwardMusicInput(input.sources)},before=copied(bundle),authority=readRollbackErasureAuthority(input.authorityRoot,input.manifestSha256);
  const guard=()=>{
    const value:unknown=boundary?.();if(value!==null&&(typeof value==='object'||typeof value==='function')&&'then' in value)throw Error('Account rebase boundary must be synchronous');
    for(const key of ['authorityRoot','manifestSha256','preparedAt','reconstructedAt','reconciledAt'] as const)if(input[key]!==held[key])throw Error('Account rebase identity changed');
    for(const key of Object.keys(held.sources) as (keyof typeof held.sources)[])if(input.sources[key].sha256!==held.sources[key].sha256||!input.sources[key].bytes.equals(held.sources[key].bytes))throw Error('Account rebase original source changed');
    for(const key of ['nativeImage','nativeJournal','retainedBusinessImage','musicSources','identitySources'] as const)if(!bundle[key].equals(before[key]))throw Error('Account rebase parent bytes changed');
    for(const key of ['accountBase','rawMusic','rawIdentity','cleanMusic','cleanIdentity'] as const)if(bundle.epoch[key].sha256!==before.epoch[key].sha256||!bundle.epoch[key].bytes.equals(before.epoch[key].bytes))throw Error('Account rebase epoch changed');
    for(const key of Object.keys(before.epoch.sources) as (keyof typeof before.epoch.sources)[])if(bundle.epoch.sources[key].sha256!==before.epoch.sources[key].sha256||!bundle.epoch.sources[key].bytes.equals(before.epoch.sources[key].bytes))throw Error('Account rebase derived source changed');
    authority.assertUnchanged();
  };
  guard();const parent=verifyForwardAccountBusiness(held,before),rebase=inputFor(held,before,rebasedAt),s=openForwardSourceRebase(rebase);
  try{
    const result={...rebaseForwardSourceRows(rebase,s),retainedAccountParent:before,retainedAccountInput:held},verification=verifyForwardAccountRebase(held,before,rebasedAt,result);guard();
    return {...result,report:{...verification,parent,authoritySha256:held.manifestSha256,authorityHeadSequence:authority.head.sequence,authorityHeadSha256:authority.head.recordSha256,previousEpochRetained:true as const,originalSourceBytesRetained:true as const,completeAccountBusinessSourceRebased:true as const,externalRetentionVerified:false as const,authorityActivationRequired:true as const,recoveryRequired:true as const,rollbackEligible:false as const,releaseEligible:false as const}};
  }finally{s.close();}
}
export function verifyForwardAccountRebase(input:ForwardAccountBusinessInput,parent:ForwardAccountBusinessBundle,rebasedAt:string,bundle:ForwardAccountRebaseBundle){
  z.iso.datetime().parse(rebasedAt);const authority=readRollbackErasureAuthority(input.authorityRoot,input.manifestSha256);
  sameInput(input,bundle.retainedAccountInput);sameParent(parent,bundle.retainedAccountParent);verifyForwardAccountBusiness(input,parent);const rebase=inputFor(input,parent,rebasedAt),verification=verifyForwardSourceRebaseBundle(rebase,bundle);
  authority.assertUnchanged();
  return {...verification,completeOriginalAccountParentVerified:true as const,originalSourceBytesRetained:true as const,releaseEligible:false as const};
}
