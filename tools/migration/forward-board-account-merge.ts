import Database from 'better-sqlite3';
import type {DB} from '@qgroup/database';
import {copyForwardBoardInput,openForwardBoardSources,forwardHash,forwardLineage,assertForwardImage} from './forward-board-storage';
import {applyForwardBoardRows} from './forward-board-rows';
import {reconcileForwardBoardRows} from './forward-board-reconciliation';
import {repairAppliedAccountErasures} from './forward-account-erasures';
import {reconcileAppliedAccountRepair} from './forward-account-reconciliation';
import {openForwardBoardAccountAuthority,assertForwardBoardAccountReferences,markForwardBoardAccountClosures,guardForwardBoardAccountInput,boardAccountPins,type ForwardBoardAccountInput} from './forward-board-account-source';
import {verifyForwardBoardAccountClosures} from './forward-board-account-reconciliation';

/** Dedicated offline board+account-reference stage. An invalid partial graph
 * never leaves this function. Full music/proof/media/epoch merge is still gated. */
export function mergeForwardBoardAccountClosures(input:ForwardBoardAccountInput,assertBoundary?:()=>void){
  const held=copyForwardBoardInput(input.sources),root=input.authorityRoot,pin=input.manifestSha256,s=openForwardBoardSources(held);let db:DB|undefined,source:DB|undefined;
  try{
    const a=openForwardBoardAccountAuthority(input,held,s);guardForwardBoardAccountInput(input,held,a,root,pin,assertBoundary);
    db=new Database(held.nativeImage.bytes);db.pragma('foreign_keys=OFF');const decisions=applyForwardBoardRows(s,db);db.pragma('foreign_keys=ON');
    reconcileForwardBoardRows(s,db);assertForwardBoardAccountReferences(s,db,a);markForwardBoardAccountClosures(db,a);
    // The source is committed in disposable memory before serialization. No
    // dirty-page image is passed to the independent account cleanup oracle.
    source=new Database(db.serialize());source.pragma('foreign_keys=ON');const candidate=db,repairSource=source;
    candidate.transaction(()=>{repairAppliedAccountErasures(candidate,a.journalReader);reconcileAppliedAccountRepair(repairSource,candidate,a.journalReader);}).immediate();
    const nativeImage=candidate.serialize();assertForwardImage(nativeImage);const reconciliation=verifyForwardBoardAccountClosures(input,nativeImage);
    guardForwardBoardAccountInput(input,held,a,root,pin,assertBoundary);
    return {nativeImage,nativeJournal:Buffer.from(a.journal),boardJournal:Buffer.from(a.authority.ledgers.board),musicJournal:Buffer.from(a.authority.ledgers.music),report:{version:1 as const,sourcePins:boardAccountPins(held),authoritySha256:pin,headSequence:a.authority.head.sequence,headRecordSha256:a.authority.head.recordSha256,lineageId:forwardLineage(candidate),nativeImageSha256:forwardHash(nativeImage),nativeJournalSha256:forwardHash(a.journal),decisions,reconciliation,boardAccountOnly:true as const,recoveryRequired:true as const,rollbackEligible:false as const,releaseEligible:false as const,remaining:['complete_music_identity_proof_source_epoch_reconstruction','remaining_cross_domain_privacy_references','structured_reset_generation_and_history_cutoff','media_browser_and_stopped_source_capture','external_authority_ancestry_high_water_and_audited_activation','fixed_actual_web_and_bot_versions_and_B01_B15_acceptance']}};
  }finally{source?.close();db?.close();s.close();}
}
