import Database from 'better-sqlite3';
import {z} from 'zod';
import {digest,parseJson,stringifyJson} from './music-codec';
import {decodeErasureJournal} from '../../apps/api/src/erasure-journal';
import type {RollbackState} from './rollback-state';
import type {RollbackMedia,MediaSourceFile} from './rollback-media';
import type {RollbackHistory} from './rollback-history';
import type {HistoryPins} from './rollback-history-source';
import {verifyRollbackState} from './rollback-state-reconciliation';
import {verifyRollbackMedia} from './rollback-media-reconciliation';
import {verifyRollbackHistory} from './rollback-history-reconciliation';
import {BotStateIndex,encodeRollbackBotIndex,pinRollbackBotState,verifyRollbackBotState,type RollbackBotState} from './rollback-bot-state';
import {RollbackCaptureBoundary,encodeRollbackBoundary,verifyRollbackCaptureBoundary,type RollbackCaptureBoundaryValue} from './rollback-capture-boundary';

const sha=z.string().regex(/^[a-f0-9]{64}$/);
export const PackageFile=z.object({path:z.string().min(1),size:z.number().int().nonnegative().safe().max(512*1024*1024),sha256:sha}).strict();
export const PackageSourcePins=z.object({checkpointSha256:sha,mediaFiles:z.array(PackageFile),captureManifestSha256:sha,native:z.array(z.object({id:z.string().regex(/^[0-9]{8}-[0-9]{6}-[a-f0-9]{32}$/),sha256:sha}).strict())}).strict();
export const PackageSourcePinsV2=PackageSourcePins.extend({botStateSha256:sha}).strict();
export const PackageSourcePinsV3=PackageSourcePinsV2.extend({captureBoundarySha256:sha}).strict();
export type SourcePinsV3=z.infer<typeof PackageSourcePinsV3>;
export type SourcePins=z.infer<typeof PackageSourcePins>;
export type SourcePinsV2=z.infer<typeof PackageSourcePinsV2>;
type PackageDomains={state:RollbackState;media:RollbackMedia;history:RollbackHistory};
export type RollbackPackage=PackageDomains&({version:1;sourcePins:SourcePins}|{version:2;sourcePins:SourcePinsV2;bot:RollbackBotState}|{version:3;sourcePins:SourcePinsV3;bot:RollbackBotState;boundary:RollbackCaptureBoundaryValue;captureInput:Buffer;sourceJournal:Buffer|null});
const manifestFields={kind:z.literal('qgroup-private-rollback-package'),createdAt:z.iso.datetime(),files:z.array(PackageFile),rollbackEligible:z.literal(false)};
export const PackageManifest=z.discriminatedUnion('version',[
  z.object({...manifestFields,version:z.literal(1),sourcePins:PackageSourcePins}).strict(),
  z.object({...manifestFields,version:z.literal(2),sourcePins:PackageSourcePinsV2}).strict(),
  z.object({...manifestFields,version:z.literal(3),sourcePins:PackageSourcePinsV3}).strict(),
]).refine(value=>new Set(value.files.map(file=>file.path)).size===value.files.length);
export type PackageManifestValue=z.infer<typeof PackageManifest>;
export const packageDecode=(bytes:Buffer)=>new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
const json=(value:unknown)=>Buffer.from(JSON.stringify(value)+'\n');
const descriptors=(files:MediaSourceFile[])=>files.map(file=>({path:file.path,size:file.bytes.length,sha256:digest(file.bytes)}));
/** Save this pin with the original held capture, before projections/IO. It is
 * not source authority when reconstructed from arbitrary caller-supplied bytes. */
export function pinRollbackPackageSource(media:RollbackMedia,history:HistoryPins):SourcePins{return PackageSourcePins.parse({checkpointSha256:digest(media.checkpointImage),mediaFiles:descriptors(media.originalFiles),...history});}
export function pinRollbackPackageSourceV2(media:RollbackMedia,history:HistoryPins,bot:RollbackBotState):SourcePinsV2{return PackageSourcePinsV2.parse({...pinRollbackPackageSource(media,history),botStateSha256:pinRollbackBotState(bot)});}
export function pinRollbackPackageSourceV3(media:RollbackMedia,history:HistoryPins,bot:RollbackBotState,boundary:RollbackCaptureBoundaryValue):SourcePinsV3{return PackageSourcePinsV3.parse({...pinRollbackPackageSourceV2(media,history,bot),captureBoundarySha256:digest(encodeRollbackBoundary(boundary))});}
export function safePackagePath(path:string){if(path.startsWith('/')||path.includes('\\')||path.split('/').some(part=>!part||part==='.'||part==='..'))throw Error('Unsafe rollback package path');}
/** All domains must prove the same externally pinned full source. No projector,
 * live DB/file, erasure replay on the latest source or service operation. */
export function verifyRollbackPackage(result:RollbackPackage){
  if(![1,2,3].includes(result.version)||JSON.stringify(Object.keys(result).filter(key=>key!=='report').sort())!==JSON.stringify(['version','sourcePins','state','media','history',...(result.version!==1?['bot']:[]),...(result.version===3?['boundary','captureInput','sourceJournal']:[])].sort()))throw Error('Invalid rollback package components');
  const pins=result.version===3?PackageSourcePinsV3.parse(result.sourcePins):result.version===2?PackageSourcePinsV2.parse(result.sourcePins):PackageSourcePins.parse(result.sourcePins);
  const bot=result.version!==1?verifyRollbackBotState(result.bot,result.sourcePins.botStateSha256):null;
  if(digest(result.state.checkpointImage)!==pins.checkpointSha256||!result.media.checkpointImage.equals(result.state.checkpointImage)||JSON.stringify(descriptors(result.media.originalFiles))!==JSON.stringify(pins.mediaFiles))throw Error('Rollback package capture pins differ');
  const fixed=new Database(result.state.checkpointImage);try{return fixed.transaction(()=>{
    const state=verifyRollbackState(fixed,result.state,result.state.journal),media=verifyRollbackMedia(fixed,result.media,result.media.originalFiles,result.state.journal),history=verifyRollbackHistory(fixed,result.state,result.history,result.history.sources,{captureManifestSha256:pins.captureManifestSha256,native:pins.native});
    const boundary=result.version===3?verifyRollbackCaptureBoundary(fixed,result.boundary,result.captureInput,result.sourceJournal,result.bot,result.state.journal,result.sourcePins):null;
    return {version:result.version,checkpointDigest:pins.checkpointSha256,state,media,history,bot,boundary,rollbackEligible:false as const,remaining:['quiescent_capture_boundary',...(result.version===3?['external_deployment_retention_coordination']:[]),...(result.version===1?['latest_external_bot_state']:[]),'fixed_bot_external_state_restore','old_history_namespace_adapter','board_history_restore_latest_erasure_rehearsal','browser_requests_proof_recovery','fixed_old_web_music_bot_rehearsal','forward_restore_mapping','resource_scale','actual_candidate_version_pair']};
  }).immediate();}finally{fixed.close();}
}
export function assembleRollbackPackage(state:RollbackState,media:RollbackMedia,history:RollbackHistory,pins:SourcePins){const result:RollbackPackage={version:1,sourcePins:PackageSourcePins.parse(pins),state,media,history};return {...result,report:verifyRollbackPackage(result)};}
export function assembleRollbackPackageV2(state:RollbackState,media:RollbackMedia,history:RollbackHistory,bot:RollbackBotState,pins:SourcePinsV2){const result:RollbackPackage={version:2,sourcePins:PackageSourcePinsV2.parse(pins),state,media,history,bot};return {...result,report:verifyRollbackPackage(result)};}
export function assembleRollbackPackageV3(state:RollbackState,media:RollbackMedia,history:RollbackHistory,bot:RollbackBotState,boundary:RollbackCaptureBoundaryValue,captureInput:Buffer,sourceJournal:Buffer|null,pins:SourcePinsV3){const result:RollbackPackage={version:3,sourcePins:PackageSourcePinsV3.parse(pins),state,media,history,bot,boundary,captureInput,sourceJournal};return {...result,report:verifyRollbackPackage(result)};}
/** Explicit paths keep raw credentials/deleted data and old-readable projections
 * in separate private namespaces. Nothing is a service-ready activation folder. */
export function encodeRollbackPackage(input:RollbackPackage){
  verifyRollbackPackage(input);const files:MediaSourceFile[]=[];
  const save=(path:string,bytes:Buffer)=>{safePackagePath(path);if(files.some(file=>file.path===path))throw Error('Duplicate rollback package path');files.push({path,bytes:Buffer.from(bytes)});};
  const {state,media,history}=input;
  if(input.version!==1){save('private/latest/bot-state-index.json',encodeRollbackBotIndex(input.bot));for(const file of input.bot.files)save('private/latest/bot/'+file.path,file.bytes);}
  if(input.version===3){save('private/latest/capture-boundary.json',encodeRollbackBoundary(input.boundary));save('private/latest/capture-input.json',input.captureInput);if(input.sourceJournal!==null)save('private/latest/source-unified.erasures.jsonl',input.sourceJournal);}
  save('private/latest/unified.sqlite3',state.checkpointImage);save('private/latest/unified.erasures.jsonl',Buffer.from(state.erasures.unifiedJournal));
  save('projection/board/board.sqlite3',state.boardImage);save('projection/board/erasures.jsonl',Buffer.from(state.erasures.boardJournal));
  save('projection/music/data.json',Buffer.from(stringifyJson(state.music.data)+'\n'));save('projection/music/identity.sqlite3',state.identityImage);save('projection/music/erasures.jsonl',Buffer.from(state.erasures.musicJournal));
  save('private/latest/music-keys.json',json(state.music.keys));save('private/latest/identity-audit-mappings.json',json(state.identityAuditMappings));save('private/latest/erasure-scopes.json',json(state.erasures.scopes));
  for(const file of media.originalFiles)save('private/original-media/'+file.path,file.bytes);
  for(const file of media.boardImages)save('projection/board/images/'+file.digest.slice(0,2)+'/'+file.digest+'.png',file.bytes);
  save('projection/music/walls/manifest.json',Buffer.from(media.walls.manifest));for(const file of media.walls.files)save('projection/music'+file.source,file.bytes);
  save('private/latest/media-index.json',json({originalFiles:media.originalFiles.map(file=>file.path),boardImages:media.boardImages.map(file=>file.digest),walls:{mapping:media.walls.mapping,archivedFields:media.walls.archivedFields,files:media.walls.files.map(({source,digest})=>({source,digest}))}}));
  save('private/legacy-capture/capture-manifest.json',history.sources.captureManifest);for(const file of history.sources.captureFiles)save('private/legacy-capture/'+file.path,file.bytes);
  for(const archive of history.sources.native){save('private/native-history/'+archive.id+'/manifest.json',archive.manifest);for(const file of archive.files)save('private/native-history/'+archive.id+'/'+file.path,file.bytes);}
  save('private/history-index.json',json({checkpointDigest:history.checkpointDigest,journalDigest:history.journalDigest,captureFiles:history.sources.captureFiles.map(file=>file.path),native:history.sources.native.map(row=>({id:row.id,files:row.files.map(file=>file.path)})),projections:history.projections.map(({data,...row})=>row)}));
  for(const row of history.projections)save('projection/history/'+row.id+'/data.json',Buffer.from(stringifyJson(row.data)+'\n'));
  files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);for(const file of descriptors(files))PackageFile.parse(file);return files;
}
const MediaIndex=z.object({originalFiles:z.array(z.string()),boardImages:z.array(sha),walls:z.object({mapping:z.array(z.object({id:z.string(),source:z.string(),digest:sha.nullable(),position:z.string(),missing:z.boolean()}).strict()),archivedFields:z.array(z.string()),files:z.array(z.object({source:z.string(),digest:sha}).strict())}).strict()}).strict();
const HistoryIndex=z.object({checkpointDigest:sha,journalDigest:sha,captureFiles:z.array(z.string()),native:z.array(z.object({id:z.string(),files:z.array(z.string())}).strict()),projections:z.array(z.object({id:z.string(),source:z.enum(['legacy_pair','legacy_json','native']),sourceStamp:z.string(),createdAt:z.string().nullable(),schema:z.number().int().nullable(),keys:z.array(z.object({profileId:z.string(),legacyKey:z.string()}).strict())}).strict())}).strict();
/** Reconstitute from pinned complete bytes, then verify every domain. Re-encode
 * equality also rejects omissions, extra files, duplicated index references and
 * metadata-only paths. Returned latest DB bytes are evidence, never activated. */
export function decodeRollbackPackage(manifest:PackageManifestValue,files:MediaSourceFile[]){
  const m=PackageManifest.parse(manifest),all=new Map(files.map(file=>[file.path,file.bytes]));if(all.size!==files.length||m.files.length!==files.length)throw Error('Rollback package inventory differs');
  for(const file of m.files){safePackagePath(file.path);const bytes=all.get(file.path);if(!bytes||bytes.length!==file.size||digest(bytes)!==file.sha256)throw Error('Rollback package checksum differs');}
  const read=(path:string)=>{safePackagePath(path);const bytes=all.get(path);if(!bytes)throw Error('Missing rollback package component');return bytes;};
  const value=(path:string)=>parseJson(packageDecode(read(path)));
  const journalRaw=packageDecode(read('private/latest/unified.erasures.jsonl'));for(const line of journalRaw.split('\n').filter(line=>line.trim()))parseJson(line);
  const journal=decodeErasureJournal(journalRaw),checkpointImage=read('private/latest/unified.sqlite3');
  const state:RollbackState={version:1,checkpointImage,journal,boardImage:read('projection/board/board.sqlite3'),identityImage:read('projection/music/identity.sqlite3'),music:{data:value('projection/music/data.json') as RollbackState['music']['data'],keys:value('private/latest/music-keys.json') as RollbackState['music']['keys']},identityAuditMappings:value('private/latest/identity-audit-mappings.json') as RollbackState['identityAuditMappings'],erasures:{boardJournal:packageDecode(read('projection/board/erasures.jsonl')),musicJournal:packageDecode(read('projection/music/erasures.jsonl')),unifiedJournal:journalRaw,scopes:value('private/latest/erasure-scopes.json') as RollbackState['erasures']['scopes']}};
  const mi=MediaIndex.parse(value('private/latest/media-index.json')),hi=HistoryIndex.parse(value('private/history-index.json'));
  const media:RollbackMedia={version:1,checkpointImage,journal,originalFiles:mi.originalFiles.map(path=>({path,bytes:read('private/original-media/'+path)})),boardImages:mi.boardImages.map(digest=>({digest,bytes:read('projection/board/images/'+digest.slice(0,2)+'/'+digest+'.png')})),walls:{mapping:mi.walls.mapping,archivedFields:mi.walls.archivedFields,manifest:packageDecode(read('projection/music/walls/manifest.json')),files:mi.walls.files.map(row=>({...row,bytes:read('projection/music'+row.source)}))}};
  const history:RollbackHistory={version:1,checkpointDigest:hi.checkpointDigest,journalDigest:hi.journalDigest,sources:{captureManifest:read('private/legacy-capture/capture-manifest.json'),captureFiles:hi.captureFiles.map(path=>({path,bytes:read('private/legacy-capture/'+path)})),native:hi.native.map(row=>({id:row.id,manifest:read('private/native-history/'+row.id+'/manifest.json'),files:row.files.map(path=>({path,bytes:read('private/native-history/'+row.id+'/'+path)}))}))},projections:hi.projections.map(row=>({...row,data:value('projection/history/'+row.id+'/data.json') as RollbackHistory['projections'][number]['data']}))};
  let result:RollbackPackage;
  if(m.version!==1){
    const bi=BotStateIndex.parse(value('private/latest/bot-state-index.json')),bot:RollbackBotState={version:1,capturedAt:bi.capturedAt,sources:bi.sources,directories:bi.directories,files:bi.files.map(file=>({path:file.path,mtimeNs:file.mtimeNs,bytes:read('private/latest/bot/'+file.path)}))};
    if(m.version===3){const boundary=RollbackCaptureBoundary.parse(value('private/latest/capture-boundary.json'));result={version:3,sourcePins:m.sourcePins,state,media,history,bot,boundary,captureInput:read('private/latest/capture-input.json'),sourceJournal:boundary.journal.present?read('private/latest/source-unified.erasures.jsonl'):null};}
    else result={version:2,sourcePins:m.sourcePins,state,media,history,bot};
  }else result={version:1,sourcePins:m.sourcePins,state,media,history};
  const report=verifyRollbackPackage(result),encoded=encodeRollbackPackage(result);
  if(JSON.stringify(encoded.map(file=>file.path))!==JSON.stringify([...all.keys()].sort()))throw Error('Unclassified rollback package component');
  for(const file of encoded)if(!file.bytes.equals(read(file.path)))throw Error('Noncanonical rollback package component');return {...result,report};
}
