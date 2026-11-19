import Database from 'better-sqlite3';
import {forwardProofFixture,proofPin,proofStamp,proofReconstructedAt,proofReconciledAt} from './forward-proof-fixture';
import {saveProfile} from '../src/repositories';
import {hash} from '../src/security';
import {erasureJournal} from '../src/erasure-journal';
import {projectRollbackState} from '../../../tools/migration/rollback-state';
import {captureRollbackCheckpoint} from '../../../tools/migration/rollback-checkpoint';
import {reconstructForwardBusiness} from '../../../tools/migration/forward-business-reconstruction';
import {reconstructForwardProofs} from '../../../tools/migration/forward-proof-reconstruction';
import type {ForwardMusicInput} from '../../../tools/migration/forward-music-sources';
import type {ForwardSourceRebaseInput} from '../../../tools/migration/forward-source-rebase-source';

export const sourceRebasedAt='2026-11-20T01:03:00.000Z';
export async function forwardSourceRebaseFixture(stage:Parameters<typeof forwardProofFixture>[0]='completed'){
  const s=await forwardProofFixture(stage);let oldBoard:Database.Database|undefined,oldIdentity:Database.Database|undefined;
  try{
    s.db.prepare('INSERT INTO users VALUES(?,?,?,?)').run('fresh-native',hash('synthetic-native-rebase'),'合成原生成分',proofStamp);
    const native=saveProfile(s.db,'fresh-native',{profileId:null,revision:0,musicEpoch:0,selections:[{entryId:'e',level:2}]},new Date(proofStamp));
    const journal=erasureJournal(s.db),base=projectRollbackState(s.db,journal),old=structuredClone(base.music.data);oldBoard=new Database(base.boardImage);oldIdentity=new Database(base.identityImage);
    const input=():ForwardMusicInput=>({checkpoint:proofPin(base.checkpointImage),baselineBoard:proofPin(base.boardImage),baselineJournal:proofPin(Buffer.from(base.journal.map(row=>JSON.stringify(row)+'\n').join(''))),nativeImage:proofPin(captureRollbackCheckpoint(s.db,journal).image),nativeJournal:proofPin(Buffer.from(journal.read().map(row=>JSON.stringify(row)+'\n').join(''))),oldBoard:proofPin(oldBoard!.serialize()),baselineMusic:proofPin(Buffer.from(JSON.stringify({...base.music,identityAuditMappings:base.identityAuditMappings}))),baselineIdentity:proofPin(base.identityImage),oldMusic:proofPin(Buffer.from(JSON.stringify(old))),oldIdentity:proofPin(oldIdentity!.serialize())});
    const rebaseInput=():ForwardSourceRebaseInput=>{const sources=input(),business=reconstructForwardBusiness(sources,proofReconstructedAt),proofs={sources,businessImage:proofPin(business.nativeImage),musicSources:proofPin(Buffer.from(JSON.stringify(business.musicSources))),identitySources:proofPin(business.identitySources),reconstructedAt:proofReconstructedAt,reconciledAt:proofReconciledAt},proof=reconstructForwardProofs(proofs);return {proofs,proofImage:proofPin(proof.nativeImage),rebasedAt:sourceRebasedAt};};
    return {...s,oldBoard,oldIdentity,old,base,native,journal,rebaseInput,close(){oldIdentity!.close();oldBoard!.close();s.close();}};
  }catch(error){oldIdentity?.close();oldBoard?.close();s.close();throw error;}
}
