import Database from 'better-sqlite3';
import {z} from 'zod';
import {digest,parseJson} from './music-codec';
import {decodeErasureJournal} from '../../apps/api/src/erasure-journal';
import type {RollbackState} from './rollback-state';
import type {RollbackMedia,MediaSourceFile} from './rollback-media';
import type {RollbackHistory} from './rollback-history';
import type {HistoryPins} from './rollback-history-source';
import {verifyRollbackState} from './rollback-state-reconciliation';
import {verifyRollbackMedia} from './rollback-media-reconciliation';
import {verifyRollbackHistory} from './rollback-history-reconciliation';

const sha=z.string().regex(/^[a-f0-9]{64}$/);
export const PackageFile=z.object({path:z.string().min(1),size:z.number().int().nonnegative().safe().max(512*1024*1024),sha256:sha}).strict();
export const PackageSourcePins=z.object({checkpointSha256:sha,mediaFiles:z.array(PackageFile),captureManifestSha256:sha,native:z.array(z.object({id:z.string().regex(/^[0-9]{8}-[0-9]{6}-[a-f0-9]{32}$/),sha256:sha}).strict())}).strict();
export type SourcePins=z.infer<typeof PackageSourcePins>;
export type RollbackPackage={version:1;sourcePins:SourcePins;state:RollbackState;media:RollbackMedia;history:RollbackHistory};
export const PackageManifest=z.object({version:z.literal(1),kind:z.literal('qgroup-private-rollback-package'),createdAt:z.iso.datetime(),sourcePins:PackageSourcePins,files:z.array(PackageFile),rollbackEligible:z.literal(false)}).strict().refine(value=>new Set(value.files.map(file=>file.path)).size===value.files.length);
export type PackageManifestValue=z.infer<typeof PackageManifest>;
export const packageDecode=(bytes:Buffer)=>new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
const json=(value:unknown)=>Buffer.from(JSON.stringify(value)+'\n');
const descriptors=(files:MediaSourceFile[])=>files.map(file=>({path:file.path,size:file.bytes.length,sha256:digest(file.bytes)}));
/** Save this pin with the original held capture, before projections/IO. It is
 * not source authority when reconstructed from arbitrary caller-supplied bytes. */
export function pinRollbackPackageSource(media:RollbackMedia,history:HistoryPins):SourcePins{return PackageSourcePins.parse({checkpointSha256:digest(media.checkpointImage),mediaFiles:descriptors(media.originalFiles),...history});}
export function safePackagePath(path:string){if(path.startsWith('/')||path.includes('\\')||path.split('/').some(part=>!part||part==='.'||part==='..'))throw Error('Unsafe rollback package path');}
/** All domains must prove the same externally pinned full source. No projector,
 * live DB/file, erasure replay on the latest source or service operation. */
export function verifyRollbackPackage(result:RollbackPackage){
  if(result.version!==1||JSON.stringify(Object.keys(result).filter(key=>key!=='report').sort())!==JSON.stringify(['version','sourcePins','state','media','history'].sort()))throw Error('Invalid rollback package components');
  const pins=PackageSourcePins.parse(result.sourcePins);
  if(digest(result.state.checkpointImage)!==pins.checkpointSha256||!result.media.checkpointImage.equals(result.state.checkpointImage)||JSON.stringify(descriptors(result.media.originalFiles))!==JSON.stringify(pins.mediaFiles))throw Error('Rollback package capture pins differ');
  const fixed=new Database(result.state.checkpointImage);try{return fixed.transaction(()=>{
    const state=verifyRollbackState(fixed,result.state,result.state.journal),media=verifyRollbackMedia(fixed,result.media,result.media.originalFiles,result.state.journal),history=verifyRollbackHistory(fixed,result.state,result.history,result.history.sources,{captureManifestSha256:pins.captureManifestSha256,native:pins.native});
    return {version:1 as const,checkpointDigest:pins.checkpointSha256,state,media,history,rollbackEligible:false as const,remaining:['quiescent_capture_boundary','old_history_namespace_adapter','board_history_restore_latest_erasure_rehearsal','browser_requests_proof_recovery','fixed_old_web_music_bot_rehearsal','forward_restore_mapping','resource_scale','actual_candidate_version_pair']};
  }).immediate();}finally{fixed.close();}
}
export function assembleRollbackPackage(state:RollbackState,media:RollbackMedia,history:RollbackHistory,pins:SourcePins){const result:RollbackPackage={version:1,sourcePins:PackageSourcePins.parse(pins),state,media,history};return {...result,report:verifyRollbackPackage(result)};}
/** Explicit paths keep raw credentials/deleted data and old-readable projections
 * in separate private namespaces. Nothing is a service-ready activation folder. */
export function encodeRollbackPackage(input:RollbackPackage){
  verifyRollbackPackage(input);const files:MediaSourceFile[]=[];
  const save=(path:string,bytes:Buffer)=>{safePackagePath(path);if(files.some(file=>file.path===path))throw Error('Duplicate rollback package path');files.push({path,bytes:Buffer.from(bytes)});};
  const {state,media,history}=input;
  save('private/latest/unified.sqlite3',state.checkpointImage);save('private/latest/unified.erasures.jsonl',Buffer.from(state.erasures.unifiedJournal));
  save('projection/board/board.sqlite3',state.boardImage);save('projection/board/erasures.jsonl',Buffer.from(state.erasures.boardJournal));
  save('projection/music/data.json',json(state.music.data));save('projection/music/identity.sqlite3',state.identityImage);save('projection/music/erasures.jsonl',Buffer.from(state.erasures.musicJournal));
  save('private/latest/music-keys.json',json(state.music.keys));save('private/latest/identity-audit-mappings.json',json(state.identityAuditMappings));save('private/latest/erasure-scopes.json',json(state.erasures.scopes));
  for(const file of media.originalFiles)save('private/original-media/'+file.path,file.bytes);
  for(const file of media.boardImages)save('projection/board/images/'+file.digest.slice(0,2)+'/'+file.digest+'.png',file.bytes);
  save('projection/music/walls/manifest.json',Buffer.from(media.walls.manifest));for(const file of media.walls.files)save('projection/music'+file.source,file.bytes);
  save('private/latest/media-index.json',json({originalFiles:media.originalFiles.map(file=>file.path),boardImages:media.boardImages.map(file=>file.digest),walls:{mapping:media.walls.mapping,archivedFields:media.walls.archivedFields,files:media.walls.files.map(({source,digest})=>({source,digest}))}}));
  save('private/legacy-capture/capture-manifest.json',history.sources.captureManifest);for(const file of history.sources.captureFiles)save('private/legacy-capture/'+file.path,file.bytes);
  for(const archive of history.sources.native){save('private/native-history/'+archive.id+'/manifest.json',archive.manifest);for(const file of archive.files)save('private/native-history/'+archive.id+'/'+file.path,file.bytes);}
  save('private/history-index.json',json({checkpointDigest:history.checkpointDigest,journalDigest:history.journalDigest,captureFiles:history.sources.captureFiles.map(file=>file.path),native:history.sources.native.map(row=>({id:row.id,files:row.files.map(file=>file.path)})),projections:history.projections.map(({data,...row})=>row)}));
  for(const row of history.projections)save('projection/history/'+row.id+'/data.json',json(row.data));
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
  const result:RollbackPackage={version:1,sourcePins:m.sourcePins,state,media,history},report=verifyRollbackPackage(result),encoded=encodeRollbackPackage(result);
  if(JSON.stringify(encoded.map(file=>file.path))!==JSON.stringify([...all.keys()].sort()))throw Error('Unclassified rollback package component');
  for(const file of encoded)if(!file.bytes.equals(read(file.path)))throw Error('Noncanonical rollback package component');return {...result,report};
}
