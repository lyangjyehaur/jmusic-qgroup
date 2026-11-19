import Database from 'better-sqlite3';
import {exportLegacyMusic} from '../../apps/api/src/legacy-music-export';
import {digest} from './music-codec';
import type {RollbackState} from './rollback-state';
import {verifyRollbackState} from './rollback-state-reconciliation';
import {readRollbackHistorySources,validateHistoryCapture,type HistoryConfig,type HistorySources,type HistoryPins} from './rollback-history-source';
import {legacyHistoryData,projectNativeHistory,type HistoryProjection} from './rollback-history-music';
import {verifyRollbackHistory} from './rollback-history-reconciliation';

export type RollbackHistory={version:1;checkpointDigest:string;journalDigest:string;sources:HistorySources;projections:HistoryProjection[]};
/** Use the same complete media/state checkpoint. Explicit source pins and
 * inventories are retained by the caller. No old backup is restored/activated. */
export function projectRollbackHistory(state:RollbackState,config:HistoryConfig){
  const fixed=new Database(state.checkpointImage);try{
    fixed.transaction(()=>verifyRollbackState(fixed,state,state.journal)).immediate();
    const captured=readRollbackHistorySources(fixed,state.journal,config),result=projectRollbackHistoryFromSources(state,captured.sources,captured.pins);
    captured.assertUnchanged();return result;
  }finally{fixed.close();}
}
/** Project an already-held immutable history acquisition. The caller retains
 * its original source pins and assertUnchanged handle throughout dependent IO. */
export function projectRollbackHistoryFromSources(state:RollbackState,sources:HistorySources,pins:HistoryPins){
  const fixed=new Database(state.checkpointImage);try{
    fixed.transaction(()=>verifyRollbackState(fixed,state,state.journal)).immediate();
    const original=structuredClone(sources);
    // structuredClone turns Buffers into Uint8Array; retain independent Buffers.
    const expected:HistorySources={captureManifest:Buffer.from(original.captureManifest),captureFiles:original.captureFiles.map(file=>({path:file.path,bytes:Buffer.from(file.bytes)})),native:original.native.map(archive=>({id:archive.id,manifest:Buffer.from(archive.manifest),files:archive.files.map(file=>({path:file.path,bytes:Buffer.from(file.bytes)}))}))};
    const catalog=validateHistoryCapture(fixed,sources,pins,state.journal),projections:HistoryProjection[]=catalog.groups.map(group=>({id:group.id,source:group.source,sourceStamp:group.sourceStamp,createdAt:null,schema:null,keys:[],data:exportLegacyMusic(legacyHistoryData(catalog.files,group),fixed,state.journal,catalog.erased)}));
    for(const archive of sources.native)projections.push(projectNativeHistory(fixed,state.music,archive,pins,state.journal));
    const result:RollbackHistory={version:1,checkpointDigest:digest(state.checkpointImage),journalDigest:digest(JSON.stringify(state.journal)),sources:sources,projections};
    const report=fixed.transaction(()=>verifyRollbackHistory(fixed,state,result,expected,pins)).immediate();
    return {...result,report};
  }finally{fixed.close();}
}
