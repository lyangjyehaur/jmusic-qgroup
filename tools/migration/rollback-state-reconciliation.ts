import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import type {DB} from '@qgroup/database';
import {readVerifiedErasureJournal,type StoredIntent} from '../../apps/api/src/erasure-journal';
import {assertRollbackSource} from './rollback-source';
import type {RollbackState} from './rollback-state';
import {verifyRollbackCheckpoint} from './rollback-checkpoint-reconciliation';
import {verifyRollbackBoard} from './rollback-board-reconciliation';
import {verifyRollbackMusic} from './rollback-music-reconciliation';
import {verifyRollbackIdentity} from './rollback-identity-reconciliation';
import {verifyRollbackErasures} from './rollback-erasures-reconciliation';
const reject=():never=>{throw Error('Rollback state reconciliation failed; retain the complete latest source');};
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
/** Expected source/journal must be the pinned complete checkpoint, never
 * current live state or another domain's report. No projector is called. */
export function verifyRollbackState(source:DB,result:RollbackState,intents:StoredIntent[]){
  assertRollbackSource(source);
  readVerifiedErasureJournal(source,{read:()=>intents,append(){throw Error('Read-only state verification');}});
  const expected=['version','checkpointImage','journal','boardImage','music','identityImage','identityAuditMappings','erasures'].sort();
  if(result.version!==1||JSON.stringify(Object.keys(result).filter(key=>key!=='report').sort())!==JSON.stringify(expected)||JSON.stringify(result.journal)!==JSON.stringify(intents))reject();
  if(JSON.stringify(Object.keys(result.music).sort())!==JSON.stringify(['data','keys'])||JSON.stringify(Object.keys(result.erasures).sort())!==JSON.stringify(['boardJournal','musicJournal','scopes','unifiedJournal']))reject();
  for(const image of [result.checkpointImage,result.boardImage,result.identityImage])if(!Buffer.isBuffer(image)||image.length<100||image.subarray(0,16).toString('binary')!=='SQLite format 3\0'||image[18]!==1||image[19]!==1)reject();
  const checkpoint=verifyRollbackCheckpoint(source,result.checkpointImage,result.journal);
  let board:DB|undefined,identity:DB|undefined;
  try{
    board=new Database(result.boardImage,{readonly:true});identity=new Database(result.identityImage,{readonly:true});
    const boardReport=verifyRollbackBoard(source,board),music=verifyRollbackMusic(source,result.music,intents),identityReport=verifyRollbackIdentity(source,identity,result.music,intents,result.identityAuditMappings),erasures=verifyRollbackErasures(source,result.erasures,result.music,intents);
    return {version:1 as const,checkpoint,board:boardReport,music,identity:identityReport,erasures,
      digests:{checkpointImage:sha(result.checkpointImage),journal:sha(JSON.stringify(result.journal)),boardImage:sha(result.boardImage),music:sha(JSON.stringify(result.music)),identityImage:sha(result.identityImage),identityAuditMappings:sha(JSON.stringify(result.identityAuditMappings)),erasures:sha(JSON.stringify(result.erasures))},
      rollbackEligible:false as const,remaining:['private_package_manifest_fsync','media_history','browser_requests_proof_recovery','fixed_old_web_music_bot_rehearsal','forward_restore_mapping']};
  }finally{identity?.close();board?.close();}
}
