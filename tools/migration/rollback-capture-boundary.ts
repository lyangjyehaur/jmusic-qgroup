import {dirname,extname,join,posix,resolve,sep} from 'node:path';
import {z} from 'zod';
import type {DB} from '@qgroup/database';
import {decodeErasureJournal,readVerifiedErasureJournal,type StoredIntent} from '../../apps/api/src/erasure-journal';
import {RollbackHistoryConfig} from './rollback-history-source';
import {RollbackBotInput,type RollbackBotState} from './rollback-bot-state';
import {RollbackServices,RollbackServiceEvidence,rollbackBindSource,pinRollbackServiceEvidence,type RollbackServiceEvidenceValue} from './rollback-service-evidence';
import {digest,parseJson} from './music-codec';
import type {SourcePinsV3} from './rollback-package-codec';
const sha=z.string().regex(/^[a-f0-9]{64}$/);
export const RollbackCaptureInput=z.object({database:z.string().min(1),expectedLineageId:z.string().regex(/^[a-f0-9]{32}$/),bot:RollbackBotInput.omit({database:true}),history:RollbackHistoryConfig,destination:z.string().min(1),dockerSocket:z.string().min(1).optional(),services:RollbackServices}).strict();
export type RollbackCaptureInputValue=z.infer<typeof RollbackCaptureInput>;
export const RollbackObservedService=z.object({role:z.enum(['web','bot']),evidence:RollbackServiceEvidence}).strict();
export type RollbackObservedServiceValue=z.infer<typeof RollbackObservedService>;
export const RollbackCaptureBoundary=z.object({
  version:z.literal(1),kind:z.literal('qgroup-offline-capture-boundary'),capturedAt:z.iso.datetime(),inputSha256:sha,checkpointSha256:sha,journalEntriesSha256:sha,mediaFilesSha256:sha,botStateSha256:sha,captureManifestSha256:sha,
  nativeManifests:z.array(z.object({id:z.string(),sha256:sha}).strict()),lineageId:z.string().regex(/^[a-f0-9]{32}$/),
  journal:z.object({path:z.string(),present:z.boolean(),size:z.number().int().nonnegative().safe().max(64*1024*1024).nullable(),sha256:sha.nullable()}).strict(),services:z.array(RollbackObservedService).length(2),
  coordination:z.object({deliveryOwner:z.literal('existing-local-sqlite'),businessDatabase:z.literal('standalone-immediate'),services:z.literal('stopped-observations'),retention:z.literal('source-fence-only'),deployment:z.literal('not-coordinated')}).strict(),rollbackEligible:z.literal(false),
}).strict();
export type RollbackCaptureBoundaryValue=z.infer<typeof RollbackCaptureBoundary>;
export const encodeRollbackBoundary=(value:RollbackCaptureBoundaryValue)=>Buffer.from(JSON.stringify(RollbackCaptureBoundary.parse(value))+'\n');
export const rollbackJournalPath=(database:string)=>{const suffix=extname(database);return (suffix?database.slice(0,-suffix.length):database)+'.erasures.jsonl';};
export function rollbackInside(path:string,root:string){return path===root||path.startsWith(root.endsWith(sep)?root:root+sep);}
/** Pure checks also run when reading a relocated package. No source reads. */
export function validateRollbackCapturePaths(input:RollbackCaptureInputValue){
  for(const path of [input.database,input.destination,input.bot.logDirectory,input.bot.sensitiveWordsFile,input.history.capture.root,input.history.native.root,input.dockerSocket])if(path!==undefined&&path!==null&&resolve(path)!==path)throw Error('Rollback capture paths must be canonical');
  const data=dirname(input.database);if(input.history.native.root!==join(data,'paired-backups'))throw Error('Rollback native history must use the source data directory');
  if(rollbackInside(data,input.history.capture.root)||rollbackInside(input.history.capture.root,data))throw Error('Rollback original capture must be isolated from the current database');
  const sources=[data,input.history.capture.root,input.bot.logDirectory,...(input.bot.sensitiveWordsFile?[dirname(input.bot.sensitiveWordsFile)]:[])];
  for(const root of sources)if(rollbackInside(input.destination,root)||rollbackInside(root,input.destination))throw Error('Rollback package destination must be isolated from all sources');
}
/** Labels/commands are recorded evidence, not release-source certification or
 * proof that an arbitrary image implements the native ownership protocol. */
export function verifyStoppedRollbackServices(input:RollbackCaptureInputValue,observed:RollbackObservedServiceValue[]){
  if(JSON.stringify(observed.map(row=>row.role))!==JSON.stringify(['web','bot']))throw Error('Rollback observed service roles differ');
  for(const {role,evidence:raw} of observed){const actual=RollbackServiceEvidence.parse(raw),expected=input.services.find(row=>row.role===role)!;
    if(pinRollbackServiceEvidence(actual)!==expected.evidenceSha256)throw Error('Rollback stopped service pin differs');
    // Old Python images may have no revision label. Preserve the reviewed
    // external record reference and observed null instead of inventing a label.
    // The record is not independently certified here; actual version acceptance
    // and release eligibility remain blocked, including for labelled images.
    const external=role==='bot'&&expected.runtime==='python'&&actual.Revision===null&&expected.commitRecordSha256;
    if(actual.Id!==expected.containerId||actual.Image!==expected.imageId||actual.Revision!==expected.commit&&!external||actual.Service!==role||actual.Runtime!==(role==='web'?'native-api':expected.runtime==='python'?'python-bot':'native-bot')||expected.runtime==='typescript'&&actual.EnvironmentMode!=='production'||actual.NodeOptionsConfigured||actual.State.Running||actual.State.Paused||actual.State.Restarting||actual.State.Dead||actual.State.Pid!==0||!['created','exited'].includes(actual.State.Status))throw Error('Rollback source services must be stopped at the exact specified images and version evidence');
    const database=role==='web'?actual.WebDatabase:actual.BotDatabase;if(rollbackBindSource(actual,database)!==input.database)throw Error('Rollback service database bind differs');
    if(role==='bot'){
      if(actual.BotEnvironmentFile)throw Error('Rollback bot file overrides need effective configuration evidence');
      const logs=actual.BotLogDirectory||posix.join(posix.dirname(database),'bot-logs');if(rollbackBindSource(actual,logs)!==input.bot.logDirectory)throw Error('Rollback bot log bind differs');
      const words=actual.BotSensitiveWordsFile?rollbackBindSource(actual,actual.BotSensitiveWordsFile):null;if(words!==input.bot.sensitiveWordsFile)throw Error('Rollback bot word-list bind differs');
    }else if(actual.HistoryRoot||actual.HistoryManifestSha256){if(rollbackBindSource(actual,actual.HistoryRoot)!==input.history.capture.root||actual.HistoryManifestSha256!==input.history.capture.manifestSha256)throw Error('Rollback web original-history source differs');}
  }
}
export function observeStoppedRollbackServices(input:RollbackCaptureInputValue,inspect:(id:string)=>RollbackServiceEvidenceValue){const rows=(['web','bot'] as const).map(role=>({role,evidence:RollbackServiceEvidence.parse(inspect(input.services.find(row=>row.role===role)!.containerId))}));verifyStoppedRollbackServices(input,rows);return rows;}
/** Verify source provenance and every boundary digest against the fixed package
 * checkpoint. It never opens, locks or probes the original source paths. */
export function verifyRollbackCaptureBoundary(db:DB,boundary:RollbackCaptureBoundaryValue,captureInput:Buffer,sourceJournal:Buffer|null,bot:RollbackBotState,journal:StoredIntent[],pins:SourcePinsV3){
  if(!Buffer.isBuffer(captureInput)||captureInput.length>64*1024||sourceJournal!==null&&!Buffer.isBuffer(sourceJournal))throw Error('Invalid rollback capture source bytes');
  const value=RollbackCaptureBoundary.parse(boundary),decode=(bytes:Buffer)=>new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes),input=RollbackCaptureInput.parse(parseJson(decode(captureInput)));validateRollbackCapturePaths(input);
  if(digest(captureInput)!==value.inputSha256||digest(encodeRollbackBoundary(value))!==pins.captureBoundarySha256||value.checkpointSha256!==pins.checkpointSha256||value.botStateSha256!==pins.botStateSha256||value.mediaFilesSha256!==digest(JSON.stringify(pins.mediaFiles))||value.captureManifestSha256!==pins.captureManifestSha256||JSON.stringify(value.nativeManifests)!==JSON.stringify(pins.native)||value.journalEntriesSha256!==digest(JSON.stringify(journal))||input.history.capture.manifestSha256!==pins.captureManifestSha256||JSON.stringify([...input.history.native.manifests].sort((a,b)=>a.id.localeCompare(b.id)))!==JSON.stringify(pins.native))throw Error('Rollback capture boundary pins differ');
  const storage=db.prepare('SELECT lineage_id,recovery_required FROM rebuild_storage WHERE id=1').get() as {lineage_id:string;recovery_required:number}|undefined;
  if(storage?.lineage_id!==input.expectedLineageId||storage.lineage_id!==value.lineageId||storage.recovery_required!==0)throw Error('Rollback capture storage lineage differs');
  if(bot.sources.database!==input.database||bot.sources.logDirectory!==input.bot.logDirectory||bot.sources.sensitiveWordsFile!==input.bot.sensitiveWordsFile||bot.capturedAt!==value.capturedAt)throw Error('Rollback capture latest bot source differs');
  if(value.journal.path!==rollbackJournalPath(input.database)||value.journal.present!==(sourceJournal!==null)||value.journal.size!==(sourceJournal?.length??null)||value.journal.sha256!==(sourceJournal?digest(sourceJournal):null))throw Error('Rollback capture original journal differs');
  const raw=sourceJournal?decode(sourceJournal):'';for(const line of raw.split('\n').filter(line=>line.trim()))parseJson(line);
  const entries=decodeErasureJournal(raw);if(JSON.stringify(entries)!==JSON.stringify(journal))throw Error('Rollback capture original journal entries differ');readVerifiedErasureJournal(db,{read:()=>entries,append(){throw Error('Read-only capture');}});
  verifyStoppedRollbackServices(input,value.services);
  return {version:1 as const,inputSha256:value.inputSha256,lineageId:value.lineageId,services:2,coordination:value.coordination,rollbackEligible:false as const};
}
