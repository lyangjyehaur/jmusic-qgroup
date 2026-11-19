import Database from 'better-sqlite3';
import {exportLegacyMusic} from '../../apps/api/src/legacy-music-export';
import {digest} from './music-codec';
import type {RollbackState} from './rollback-state';
import {verifyRollbackState} from './rollback-state-reconciliation';
import {readRollbackHistorySources,validateHistoryCapture,type HistoryConfig,type HistorySources} from './rollback-history-source';
import {legacyHistoryData,projectNativeHistory,type HistoryProjection} from './rollback-history-music';
import {verifyRollbackHistory} from './rollback-history-reconciliation';

export type RollbackHistory={version:1;checkpointDigest:string;journalDigest:string;sources:HistorySources;projections:HistoryProjection[]};
/** Use the same complete media/state checkpoint. Explicit source pins and
 * inventories are retained by the caller. No old backup is restored/activated. */
export function projectRollbackHistory(state:RollbackState,config:HistoryConfig){
  const fixed=new Database(state.checkpointImage);try{
    fixed.transaction(()=>verifyRollbackState(fixed,state,state.journal)).immediate();
    const captured=readRollbackHistorySources(fixed,state.journal,config),original=structuredClone(captured.sources);
    // structuredClone turns Buffers into Uint8Array; retain independent Buffers.
    const expected:HistorySources={captureManifest:Buffer.from(original.captureManifest),captureFiles:original.captureFiles.map(file=>({path:file.path,bytes:Buffer.from(file.bytes)})),native:original.native.map(archive=>({id:archive.id,manifest:Buffer.from(archive.manifest),files:archive.files.map(file=>({path:file.path,bytes:Buffer.from(file.bytes)}))}))};
    const catalog=validateHistoryCapture(fixed,captured.sources,captured.pins,state.journal),projections:HistoryProjection[]=catalog.groups.map(group=>({id:group.id,source:group.source,sourceStamp:group.sourceStamp,createdAt:null,schema:null,keys:[],data:exportLegacyMusic(legacyHistoryData(catalog.files,group),fixed,state.journal,catalog.erased)}));
    for(const archive of captured.sources.native)projections.push(projectNativeHistory(fixed,state.music,archive,captured.pins,state.journal));
    const result:RollbackHistory={version:1,checkpointDigest:digest(state.checkpointImage),journalDigest:digest(JSON.stringify(state.journal)),sources:captured.sources,projections};
    const report=fixed.transaction(()=>verifyRollbackHistory(fixed,state,result,expected,captured.pins)).immediate();
    captured.assertUnchanged();return {...result,report};
  }finally{fixed.close();}
}
