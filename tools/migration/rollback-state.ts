import Database from 'better-sqlite3';
import type {DB} from '@qgroup/database';
import type {ErasureJournal,StoredIntent} from '../../apps/api/src/erasure-journal';
import {captureRollbackCheckpoint} from './rollback-checkpoint';
import {projectRollbackBoard} from './rollback-board';
import {projectRollbackMusic,type RollbackMusic} from './rollback-music';
import {projectRollbackIdentity,type IdentityAuditMapping} from './rollback-identity';
import {projectRollbackErasures,type RollbackErasures} from './rollback-erasures';
import {verifyRollbackState} from './rollback-state-reconciliation';
import {assertRollbackSource} from './rollback-source';
import {readVerifiedErasureJournal} from '../../apps/api/src/erasure-journal';
import {verifyRollbackCheckpoint} from './rollback-checkpoint-reconciliation';

export type RollbackState={
  version:1;checkpointImage:Buffer;journal:StoredIntent[];boardImage:Buffer;music:RollbackMusic;
  identityImage:Buffer;identityAuditMappings:IdentityAuditMapping[];erasures:RollbackErasures;
};
/** One fixed complete source for every database/JSON/ledger projection. No
 * connections escape and nothing is written, replayed or activated. Assets,
 * browser work and fixed service rehearsals still block an actual rollback. */
export function projectRollbackState(source:DB,journal:ErasureJournal){
  const checkpoint=captureRollbackCheckpoint(source,journal);
  return projectRollbackStateFromCheckpoint(checkpoint.image,checkpoint.journal);
}
/** Assemble the checkpoint captured together with external media. The caller
 * must retain its original capture/pin; this function cannot infer provenance
 * from arbitrary bytes. Never reads a current DB, source file or live journal. */
export function projectRollbackStateFromCheckpoint(image:Buffer,intents:StoredIntent[]){
  if(!Buffer.isBuffer(image)||image.length<100||image[18]!==1||image[19]!==1)throw Error('Rollback state requires a standalone checkpoint image');
  const checkpoint={image:Buffer.from(image),journal:structuredClone(intents)};
  const fixed=new Database(checkpoint.image),fixedJournal:ErasureJournal={read:()=>structuredClone(checkpoint.journal),append(){throw Error('Fixed rollback source is read-only');}};
  let board:DB|undefined,identity:DB|undefined;
  try{
    fixed.transaction(()=>{assertRollbackSource(fixed);readVerifiedErasureJournal(fixed,fixedJournal);verifyRollbackCheckpoint(fixed,checkpoint.image,checkpoint.journal);}).immediate();
    const projectedBoard=projectRollbackBoard(fixed);board=projectedBoard.db;
    const projectedMusic=projectRollbackMusic(fixed,fixedJournal),music:RollbackMusic={data:projectedMusic.data,keys:projectedMusic.keys};
    const projectedIdentity=projectRollbackIdentity(fixed,fixedJournal,music);identity=projectedIdentity.db;
    const projectedErasures=projectRollbackErasures(fixed,fixedJournal,music);
    const erasures:RollbackErasures={boardJournal:projectedErasures.boardJournal,musicJournal:projectedErasures.musicJournal,unifiedJournal:projectedErasures.unifiedJournal,scopes:projectedErasures.scopes};
    const result:RollbackState={version:1,checkpointImage:checkpoint.image,journal:checkpoint.journal,boardImage:board.serialize(),music,identityImage:identity.serialize(),identityAuditMappings:projectedIdentity.report.auditMappings,erasures};
    // Verify the entire assembly against the unchanged authoritative image,
    // including new-only tables that the old projections cannot represent.
    const report=fixed.transaction(()=>verifyRollbackState(fixed,result,checkpoint.journal)).immediate();
    return {...result,report};
  }finally{identity?.close();board?.close();fixed.close();}
}
