import {z} from 'zod';
import Database from 'better-sqlite3';
import {readRollbackErasureAuthority} from '../../apps/api/src/erasure-authority-protocol';
import {decodeErasureJournal} from '../../apps/api/src/erasure-journal';
import {pinRollbackTree} from '../../packages/runtime/src/private-source-files';
import {assertForwardImage,forwardHash,type PinnedForwardBytes} from './forward-board-storage';
import {projectNativeForwardErasures,type ForwardErasureInput} from './forward-erasure-projection';
import {prepareForwardLegacyResetGenerations,verifyForwardLegacyResetGenerations,type LegacyResetGenerationBundle} from './forward-legacy-reset-generations';
import {projectRollbackStateFromCheckpoint} from './rollback-state';
import {copyForwardMusicInput,musicEqual,musicCanonical,type ForwardMusicInput} from './forward-music-sources';
import {reconstructForwardBusiness} from './forward-business-reconstruction';
import {verifyForwardBusiness} from './forward-business-reconciliation';
import {reconstructForwardProofs} from './forward-proof-reconstruction';
import {verifyForwardProofBundle} from './forward-proof-reconciliation';
import type {ForwardProofInput} from './forward-proof-source';
import {rebaseForwardSources} from './forward-source-rebase';
import {verifyForwardSourceRebaseBundle} from './forward-source-rebase-reconciliation';
import {readForwardLegacyResetVault} from './forward-legacy-reset-vault';
import type {ForwardSourceRebaseInput} from './forward-source-rebase-source';

export type LegacyResetRecoveryInput={erasures:ForwardErasureInput;latestMusic:PinnedForwardBytes;latestIdentity:PinnedForwardBytes;latestBoard:PinnedForwardBytes;reconstructedAt:string;reconciledAt:string;rebasedAt:string};
const pin=(bytes:Buffer):PinnedForwardBytes=>({bytes:Buffer.from(bytes),sha256:forwardHash(bytes)});
function held(input:LegacyResetRecoveryInput,boundary?:()=>void){
  if(!input.erasures.resetSourceVault)throw Error('Original reset recovery requires the complete private vault');
  for(const key of ['reconstructedAt','reconciledAt','rebasedAt'] as const)z.iso.datetime().parse(input[key]);
  if(Date.parse(input.reconstructedAt)>Date.parse(input.reconciledAt)||Date.parse(input.reconciledAt)>Date.parse(input.rebasedAt))throw Error('Reset recovery operation times are out of order');
  const e=input.erasures,erasures:ForwardErasureInput={authorityRoot:e.authorityRoot,manifestSha256:e.manifestSha256,checkpoint:Buffer.from(e.checkpoint),nativeImage:Buffer.from(e.nativeImage),nativeImageSha256:e.nativeImageSha256,nativeJournal:Buffer.from(e.nativeJournal),nativeJournalSha256:e.nativeJournalSha256,resetSourceVault:{vaultRoot:e.resetSourceVault!.vaultRoot,vaultManifestSha256:e.resetSourceVault!.vaultManifestSha256}};
  const s={erasures,latestMusic:pin(input.latestMusic.bytes),latestIdentity:pin(input.latestIdentity.bytes),latestBoard:pin(input.latestBoard.bytes),reconstructedAt:input.reconstructedAt,reconciledAt:input.reconciledAt,rebasedAt:input.rebasedAt};
  for(const key of ['latestMusic','latestIdentity','latestBoard'] as const)if(input[key].sha256!==s[key].sha256)throw Error('Original reset recovery source pin differs');
  for(const bytes of [erasures.checkpoint,erasures.nativeImage,s.latestIdentity.bytes,s.latestBoard.bytes])assertForwardImage(bytes);
  if(forwardHash(erasures.nativeImage)!==erasures.nativeImageSha256||forwardHash(erasures.nativeJournal)!==erasures.nativeJournalSha256)throw Error('Original native reset recovery pin differs');
  const authority=readRollbackErasureAuthority(erasures.authorityRoot,erasures.manifestSha256),tree=pinRollbackTree(erasures.resetSourceVault!.vaultRoot);
  const guard=()=>{
    const value:unknown=boundary?.();if(value!==null&&(typeof value==='object'||typeof value==='function')&&'then' in value)throw Error('Reset recovery boundary must be synchronous');
    for(const key of ['authorityRoot','manifestSha256','nativeImageSha256','nativeJournalSha256'] as const)if(input.erasures[key]!==erasures[key])throw Error('Original reset recovery identity changed');
    for(const key of ['checkpoint','nativeImage','nativeJournal'] as const)if(!Buffer.isBuffer(input.erasures[key])||!input.erasures[key].equals(erasures[key]))throw Error('Original native recovery bytes changed');
    for(const key of ['vaultRoot','vaultManifestSha256'] as const)if(input.erasures.resetSourceVault?.[key]!==erasures.resetSourceVault![key])throw Error('Original reset recovery vault changed');
    for(const key of ['latestMusic','latestIdentity','latestBoard'] as const)if(input[key].sha256!==s[key].sha256||!Buffer.isBuffer(input[key].bytes)||!input[key].bytes.equals(s[key].bytes))throw Error('Original latest reset source changed');
    for(const key of ['reconstructedAt','reconciledAt','rebasedAt'] as const)if(input[key]!==s[key])throw Error('Reset recovery operation time changed');
    authority.assertUnchanged();tree.assertUnchanged();
  };
  guard();return {s,guard,authority};
}
function generationInput(s:ReturnType<typeof held>['s']){return {vault:{authorityRoot:s.erasures.authorityRoot,manifestSha256:s.erasures.manifestSha256,...s.erasures.resetSourceVault!},checkpoint:pin(s.erasures.checkpoint),nativeImage:{bytes:s.erasures.nativeImage,sha256:s.erasures.nativeImageSha256},latestMusic:s.latestMusic};}

/** Prepare a common post-reset baseline separately from the native fork. Using
 * the current native fork as the baseline would misclassify its later additions
 * as old deletions. Original checkpoint/authority bindings are retained. */
function sources(h:ReturnType<typeof held>,generation:LegacyResetGenerationBundle){
  const {s,guard}=h;verifyForwardLegacyResetGenerations(generationInput(s),generation,guard);
  const native=projectNativeForwardErasures(s.erasures,guard),baseline=projectNativeForwardErasures({...s.erasures,nativeImage:Buffer.from(s.erasures.checkpoint),nativeImageSha256:forwardHash(s.erasures.checkpoint)},guard);
  const base=projectRollbackStateFromCheckpoint(baseline.nativeImage,decodeErasureJournal(baseline.nativeJournal.toString()));
  const inputs:ForwardMusicInput={checkpoint:pin(base.checkpointImage),baselineBoard:pin(base.boardImage),baselineJournal:pin(baseline.nativeJournal),nativeImage:pin(native.nativeImage),nativeJournal:pin(native.nativeJournal),oldBoard:s.latestBoard,baselineMusic:pin(Buffer.from(JSON.stringify({...base.music,identityAuditMappings:base.identityAuditMappings})+'\n')),baselineIdentity:pin(base.identityImage),oldMusic:generation.derivedMusic,oldIdentity:s.latestIdentity};
  guard();return {inputs:copyForwardMusicInput(inputs),baselineProjection:baseline.report,nativeProjection:native.report};
}
function recoveryReport(h:ReturnType<typeof held>,prepared:ReturnType<typeof sources>,final:Buffer){return {version:1 as const,authoritySha256:h.s.erasures.manifestSha256,checkpointSha256:forwardHash(h.s.erasures.checkpoint),nativeOriginalSha256:h.s.erasures.nativeImageSha256,latestSourcePins:{music:h.s.latestMusic.sha256,identity:h.s.latestIdentity.sha256,board:h.s.latestBoard.sha256},baselineProjection:prepared.baselineProjection,nativeProjection:prepared.nativeProjection,finalNativeImageSha256:forwardHash(final),resetRecoveryCandidatePrepared:true as const,latestSourceAncestryVerified:false as const,allResetGenerationsReconciled:false as const,externalRetentionVerified:false as const,mediaAndBrowserReconciled:false as const,recoveryRequired:true as const,releaseEligible:false as const};}
const proofInput=(s:ReturnType<typeof held>['s'],inputs:ForwardMusicInput,business:ReturnType<typeof reconstructForwardBusiness>):ForwardProofInput=>({sources:inputs,businessImage:pin(business.nativeImage),musicSources:pin(Buffer.from(JSON.stringify(business.musicSources)+'\n')),identitySources:pin(business.identitySources),reconstructedAt:s.reconstructedAt,reconciledAt:s.reconciledAt});

/** Entire business/proof/source-rebase candidate; no files, service startup,
 * authority rebase, media replacement or platform delivery. All original source
 * generations remain independently pinned and external ancestry is still needed. */
export function reconstructForwardLegacyResetRecovery(input:LegacyResetRecoveryInput,boundary?:()=>void){
  const h=held(input,boundary),generation=prepareForwardLegacyResetGenerations(generationInput(h.s),h.guard),prepared=sources(h,generation),business=reconstructForwardBusiness(prepared.inputs,h.s.reconstructedAt,h.guard);
  const proofs=proofInput(h.s,prepared.inputs,business),proof=reconstructForwardProofs(proofs,h.guard),rebaseInput:ForwardSourceRebaseInput={proofs,proofImage:pin(proof.nativeImage),rebasedAt:h.s.rebasedAt},rebased=rebaseForwardSources(rebaseInput,h.guard);
  h.guard();return {generation,sources:prepared.inputs,business,proof,rebased,report:recoveryReport(h,prepared,rebased.nativeImage)};
}
export type LegacyResetRecoveryBundle=ReturnType<typeof reconstructForwardLegacyResetRecovery>;

/** Re-derive the original source environment; never rerun the business, proof or
 * rebase writers. Their independent full-row oracles verify every actual output. */
export function verifyForwardLegacyResetRecovery(input:LegacyResetRecoveryInput,bundle:LegacyResetRecoveryBundle,boundary?:()=>void){
  const outputPins=()=>JSON.stringify({generation:[bundle.generation.derivedMusic.sha256,forwardHash(bundle.generation.derivedMusic.bytes),bundle.generation.mapping],sources:Object.fromEntries(Object.entries(bundle.sources).map(([key,row])=>[key,[row.sha256,forwardHash(row.bytes)]])),business:[forwardHash(bundle.business.nativeImage),forwardHash(bundle.business.nativeJournal),forwardHash(bundle.business.identitySources),bundle.business.musicSources],proof:[forwardHash(bundle.proof.nativeImage),forwardHash(bundle.proof.nativeJournal),forwardHash(bundle.proof.retainedBusinessImage),forwardHash(bundle.proof.musicSources),forwardHash(bundle.proof.identitySources)],rebased:[forwardHash(bundle.rebased.nativeImage),forwardHash(bundle.rebased.nativeJournal),forwardHash(bundle.rebased.retainedBusinessImage),forwardHash(bundle.rebased.retainedProofImage),forwardHash(bundle.rebased.musicSources),forwardHash(bundle.rebased.identitySources)],reports:[bundle.generation.report,bundle.business.report,bundle.proof.report,bundle.rebased.report,bundle.report]});
  const original=outputPins(),h=held(input,()=>{const value:unknown=boundary?.();if(value!==null&&(typeof value==='object'||typeof value==='function')&&'then' in value)throw Error('Reset recovery boundary must be synchronous');if(outputPins()!==original)throw Error('Reset recovery output bundle changed');}),prepared=sources(h,bundle.generation);
  if(!musicEqual(Object.keys(bundle.sources).sort(),Object.keys(prepared.inputs).sort()))throw Error('Reset recovery source environment inventory differs');
  for(const key of Object.keys(prepared.inputs) as (keyof ForwardMusicInput)[])if(bundle.sources[key].sha256!==prepared.inputs[key].sha256||!bundle.sources[key].bytes.equals(prepared.inputs[key].bytes))throw Error('Reset recovery source environment differs');
  if(!bundle.business.nativeJournal.equals(prepared.inputs.nativeJournal.bytes))throw Error('Reset recovery business journal differs');
  const business=verifyForwardBusiness(prepared.inputs,bundle.business.nativeImage,bundle.business.musicSources,bundle.business.identitySources,h.s.reconstructedAt),proofs=proofInput(h.s,prepared.inputs,bundle.business),proof=verifyForwardProofBundle(proofs,bundle.proof),rebaseInput={proofs,proofImage:pin(bundle.proof.nativeImage),rebasedAt:h.s.rebasedAt},rebased=verifyForwardSourceRebaseBundle(rebaseInput,bundle.rebased);
  // Compare reports only after the independent row oracles have verified the
  // underlying migration records. Reports cannot grant activation or swap pins.
  const check=(actual:unknown,wanted:unknown)=>{if(!musicEqual(actual,wanted))throw Error('Reset recovery report differs');};
  check(bundle.report,recoveryReport(h,prepared,bundle.rebased.nativeImage));
  const generation=verifyForwardLegacyResetGenerations(generationInput(h.s),bundle.generation,h.guard),vault=readForwardLegacyResetVault(generationInput(h.s).vault),last=h.authority.records.filter(row=>row.version===2).at(-1)!,completion=vault.completionSources.find(row=>row.sequence===last.sequence)!;
  const native=new Database(h.s.erasures.nativeImage);let lineage:string;try{lineage=(native.prepare('SELECT lineage_id FROM rebuild_storage WHERE id=1').get() as {lineage_id:string}).lineage_id;}finally{native.close();}
  check(bundle.generation.report,{...generation,authoritySha256:h.s.erasures.manifestSha256,headSequence:h.authority.head.sequence,resetSequence:last.sequence,resetRecordSha256:completion.authorityRecordSha256,completionSha256:completion.completionSha256,nativeImageSha256:h.s.erasures.nativeImageSha256,lineageId:lineage,entryGenerationSourcesPrepared:true,externalRetentionVerified:false,recoveryRequired:true,releaseEligible:false});
  const sourcePins=Object.fromEntries(Object.entries(prepared.inputs).map(([key,row])=>[key,row.sha256]));
  check(bundle.business.report,{version:1,sourcePins,sourceDigest:forwardHash('qgroup:forward-business:v1:'+musicCanonical(sourcePins)),nativeImageSha256:forwardHash(bundle.business.nativeImage),reconstructedAt:h.s.reconstructedAt,changedProfiles:business.changedProfiles,ownershipEpochs:business.ownershipEpochs,reconciliation:business,businessCandidateOnly:true,proofReconciliationRequired:true,sourceRebaseRequired:true,recoveryRequired:true,rollbackEligible:false,releaseEligible:false,remaining:['original_source_rebase_and_pending_proof_receipt_reconciliation','complete_authority_backed_account_reset_repair','media_browser_and_stopped_source_capture','authority_epoch_custody_and_fixed_service_acceptance']});
  const proofDb=new Database(bundle.proof.nativeImage);let disposition:Record<string,unknown>;try{disposition=JSON.parse((proofDb.prepare('SELECT report_json FROM migration_runs WHERE source_digest=?').get(proof.sourceDigest) as {report_json:string}).report_json);}finally{proofDb.close();}
  const {retainedBusinessImageVerified,pairedSourceBytesVerified,...proofRows}=proof;
  check(bundle.proof.report,{version:1,sourcePins:proof.sourcePins,sourceDigest:proof.sourceDigest,nativeImageSha256:forwardHash(bundle.proof.nativeImage),claims:disposition.claims,failedAttempts:disposition.failedAttempts,receiptRows:disposition.receiptRows,profileRows:disposition.profileRows,epochRows:disposition.epochRows,reconciliation:proofRows,proofCandidateOnly:true,sourceRebaseRequired:true,latestErasureReplayRequired:true,externalRetentionRequired:true,externalRetentionVerified:false,recoveryRequired:true,rollbackEligible:false,releaseEligible:false});
  const {retainedOriginalImagesVerified,pairedSourceBytesVerified:pairedRebased,...rebaseRows}=rebased;
  check(bundle.rebased.report,{version:1,sourcePins:rebased.sourcePins,sourceDigest:rebased.sourceDigest,reconciliation:rebaseRows,sourceEvidenceRebased:true,externalRetentionRequired:true,externalRetentionVerified:false,latestErasureReplayRequired:true,recoveryRequired:true,rollbackEligible:false,releaseEligible:false});
  h.guard();return {business,proof,rebased,allCandidateRowsVerified:true as const,latestSourceAncestryVerified:false as const,releaseEligible:false as const};
}
