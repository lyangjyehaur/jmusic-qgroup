import {decodeErasureJournal} from '../../apps/api/src/erasure-journal';
import {forwardHash,type PinnedForwardBytes} from './forward-board-storage';
import {projectNativeForwardErasures} from './forward-erasure-projection';
import {holdLegacyResetRecoveryInput,generationInput,proofInput,verifyResetRecoveryCandidate,verifyResetGenerationReport,type LegacyResetRecoveryInput} from './forward-legacy-reset-recovery';
import {prepareForwardResetRetirementSources,verifyForwardResetRetirementSources,type ResetRetirementSourcesBundle} from './forward-reset-retirement-sources';
import type {ResetMemberRetirementInput} from './forward-reset-member-retirement';
import {prepareForwardLegacyResetGenerations,verifyForwardLegacyResetGenerations} from './forward-legacy-reset-generations';
import {prepareForwardLegacyResetIdentityRows,verifyForwardLegacyResetIdentityRows} from './forward-legacy-reset-identity-rows';
import {projectRollbackStateFromCheckpoint} from './rollback-state';
import {copyForwardMusicInput,openForwardMusicSources,musicEqual,type ForwardMusicInput} from './forward-music-sources';
import {reconstructForwardBusiness} from './forward-business-reconstruction';
import {reconstructForwardProofs} from './forward-proof-reconstruction';
import {rebaseForwardSources} from './forward-source-rebase';
import {prepareRetiredResetBoard,verifyRetiredResetBoard,type RetiredResetBoardBundle} from './forward-retired-reset-board';

const pin=(bytes:Buffer):PinnedForwardBytes=>({bytes:Buffer.from(bytes),sha256:forwardHash(bytes)});
function retirementInput(h:ReturnType<typeof holdLegacyResetRecoveryInput>):ResetMemberRetirementInput{
  const {s}=h;
  return {members:{vault:generationInput(s).vault,music:s.latestMusic,identity:s.latestIdentity},checkpoint:pin(s.erasures.checkpoint),nativeImage:pin(s.erasures.nativeImage),nativeJournal:pin(s.erasures.nativeJournal),retiredAt:s.reconstructedAt};
}
function sources(h:ReturnType<typeof holdLegacyResetRecoveryInput>,retirement:ResetRetirementSourcesBundle,generation:ReturnType<typeof prepareForwardLegacyResetGenerations>,suppliedRows?:ReturnType<typeof prepareForwardLegacyResetIdentityRows>,suppliedBoard?:RetiredResetBoardBundle){
  const {s,guard}=h;
  verifyForwardResetRetirementSources(retirementInput(h),retirement,guard);
  verifyForwardLegacyResetGenerations(generationInput(s,retirement.native.retained.projectedMusic),generation,guard);
  // Authority bindings still point to the original checkpoint, while each
  // disposable branch has already received its independent retirement delta.
  const native=projectNativeForwardErasures({...s.erasures,nativeImage:Buffer.from(retirement.native.nativeImage),nativeImageSha256:forwardHash(retirement.native.nativeImage),nativeJournal:Buffer.from(retirement.native.nativeJournal),nativeJournalSha256:forwardHash(retirement.native.nativeJournal)},guard);
  const baseline=projectNativeForwardErasures({...s.erasures,nativeImage:Buffer.from(retirement.baseline.nativeImage),nativeImageSha256:forwardHash(retirement.baseline.nativeImage),nativeJournal:Buffer.from(retirement.baselineJournal.bytes),nativeJournalSha256:retirement.baselineJournal.sha256},guard);
  const base=projectRollbackStateFromCheckpoint(baseline.nativeImage,decodeErasureJournal(baseline.nativeJournal.toString()));
  const boardInput={originalNative:pin(retirement.native.retainedNativeImage),retiredNative:pin(retirement.native.nativeImage),oldBoard:s.latestBoard};
  let boardDisposition:RetiredResetBoardBundle;if(suppliedBoard){verifyRetiredResetBoard(boardInput,suppliedBoard,guard);boardDisposition=suppliedBoard;}else boardDisposition=prepareRetiredResetBoard(boardInput,guard);
  const inputs:ForwardMusicInput={checkpoint:pin(base.checkpointImage),baselineBoard:pin(base.boardImage),baselineJournal:pin(baseline.nativeJournal),nativeImage:pin(native.nativeImage),nativeJournal:pin(native.nativeJournal),oldBoard:boardDisposition.board,baselineMusic:pin(Buffer.from(JSON.stringify({...base.music,identityAuditMappings:base.identityAuditMappings})+'\n')),baselineIdentity:pin(base.identityImage),oldMusic:generation.derivedMusic,oldIdentity:retirement.identity};
  const original=openForwardMusicSources(inputs);let identityRows:ReturnType<typeof prepareForwardLegacyResetIdentityRows>;
  try{
    const rowInput={baseline:pin(original.baselineIdentity.serialize()),native:pin(original.nativeIdentity.serialize()),old:retirement.identity};
    if(suppliedRows){const report=verifyForwardLegacyResetIdentityRows(rowInput,suppliedRows,guard);identityRows={...suppliedRows,report};}
    else identityRows=prepareForwardLegacyResetIdentityRows(rowInput,guard);
  }finally{original.close();}
  inputs.oldIdentity=identityRows.identity;guard();
  return {inputs:copyForwardMusicInput(inputs),identityRows,boardDisposition,baselineProjection:baseline.report,nativeProjection:native.report};
}
function report(h:ReturnType<typeof holdLegacyResetRecoveryInput>,retirement:ResetRetirementSourcesBundle,prepared:ReturnType<typeof sources>,final:Buffer){
  const {s}=h;
  return {version:1 as const,authoritySha256:s.erasures.manifestSha256,checkpointSha256:forwardHash(s.erasures.checkpoint),nativeOriginalSha256:s.erasures.nativeImageSha256,latestSourcePins:{music:s.latestMusic.sha256,identity:s.latestIdentity.sha256,board:s.latestBoard.sha256},retirement:retirement.report,boardDisposition:prepared.boardDisposition.report,baselineProjection:prepared.baselineProjection,nativeProjection:prepared.nativeProjection,finalNativeImageSha256:forwardHash(final),retiredResetRecoveryCandidatePrepared:true as const,allResetGenerationsReconciled:false as const,latestSourceAncestryVerified:false as const,externalRetentionVerified:false as const,mediaAndBrowserReconciled:false as const,recoveryRequired:true as const,releaseEligible:false as const};
}
/** Offline candidate only. Check the unmodified native fork before retirement,
 * then project global resets independently on the common baseline and fork.
 * The original persisted/loaded scope distinction and all sources are retained. */
export function reconstructForwardRetiredResetRecovery(input:LegacyResetRecoveryInput,boundary?:()=>void){
  const h=holdLegacyResetRecoveryInput(input,boundary),retirement=prepareForwardResetRetirementSources(retirementInput(h),h.guard),generation=prepareForwardLegacyResetGenerations(generationInput(h.s,retirement.native.retained.projectedMusic),h.guard),prepared=sources(h,retirement,generation),business=reconstructForwardBusiness(prepared.inputs,h.s.reconstructedAt,h.guard);
  const proofs=proofInput(h.s,prepared.inputs,business),proof=reconstructForwardProofs(proofs,h.guard),rebased=rebaseForwardSources({proofs,proofImage:pin(proof.nativeImage),rebasedAt:h.s.rebasedAt},h.guard);
  h.guard();return {retirement,generation,identityRows:prepared.identityRows,boardDisposition:prepared.boardDisposition,sources:prepared.inputs,business,proof,rebased,report:report(h,retirement,prepared,rebased.nativeImage)};
}
export type RetiredResetRecoveryBundle=ReturnType<typeof reconstructForwardRetiredResetRecovery>;
/** Verify retirement, generations and identity derivation against originals;
 * re-derive the erasure/source environment, then use full-row oracles on the
 * actual business/proof/rebase outputs without rerunning those three writers. */
export function verifyForwardRetiredResetRecovery(input:LegacyResetRecoveryInput,bundle:RetiredResetRecoveryBundle,boundary?:()=>void){
  const summarize=(value:unknown):unknown=>Buffer.isBuffer(value)?{bytes:value.length,sha256:forwardHash(value)}:Array.isArray(value)?value.map(summarize):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,summarize(item)])):typeof value==='bigint'?{integer:String(value)}:value;
  const fingerprint=()=>JSON.stringify(summarize(bundle)),before=fingerprint();
  const h=holdLegacyResetRecoveryInput(input,()=>{const value:unknown=boundary?.();if(value!==null&&(typeof value==='object'||typeof value==='function')&&'then' in value)throw Error('Retired reset recovery boundary must be synchronous');if(fingerprint()!==before)throw Error('Retired reset recovery output bundle changed');});
  const prepared=sources(h,bundle.retirement,bundle.generation,bundle.identityRows,bundle.boardDisposition),rows=verifyResetRecoveryCandidate(h,prepared.inputs,bundle);
  verifyResetGenerationReport(h,bundle.retirement.native.retained.projectedMusic,bundle.generation);
  if(!musicEqual(bundle.identityRows.report,prepared.identityRows.report)||!musicEqual(bundle.report,report(h,bundle.retirement,prepared,bundle.rebased.nativeImage)))throw Error('Retired reset recovery report differs');
  h.guard();return {...rows,retiredBaselineAndNativeVerified:true as const};
}
