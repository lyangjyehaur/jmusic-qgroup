import {constants,closeSync,fstatSync,lstatSync,openSync,readFileSync,readdirSync,realpathSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import Database from 'better-sqlite3';
import {migrateDatabase,type DB} from '@qgroup/database';
import {z} from 'zod';
import {PairedBackupManifest} from '../../apps/api/src/paired-backups';
import {decodeErasureJournal,erasureRequestId,readVerifiedErasureJournal,type StoredIntent} from '../../apps/api/src/erasure-journal';
import {digest,musicErasures,parseJson,readIdentity} from './music-codec';
import type {MediaSourceFile} from './rollback-media';
import {assertRollbackSource} from './rollback-source';

const sha=z.string().regex(/^[a-f0-9]{64}$/),nativeId=z.string().regex(/^[0-9]{8}-[0-9]{6}-[a-f0-9]{32}$/);
export const RollbackHistoryConfig=z.object({
  capture:z.object({root:z.string().min(1),manifestSha256:sha}).strict(),
  native:z.object({root:z.string().min(1),manifests:z.array(z.object({id:nativeId,sha256:sha}).strict())}).strict(),
}).strict();
export type HistoryConfig=z.infer<typeof RollbackHistoryConfig>;
export type HistoryPins={captureManifestSha256:string;native:{id:string;sha256:string}[]};
export type HistorySources={captureManifest:Buffer;captureFiles:MediaSourceFile[];native:{id:string;manifest:Buffer;files:MediaSourceFile[]}[]};
const File=z.object({path:z.string().min(1),size:z.number().int().nonnegative().safe(),sha256:sha}).strict();
const CaptureManifest=z.object({version:z.literal(1),files:z.array(File),sourceDigest:sha,releaseEligible:z.literal(false)}).passthrough();
export const decodeHistory=(raw:Buffer)=>new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw);
function historyJournal(raw:Buffer){const source=decodeHistory(raw);for(const line of source.split('\n').filter(line=>line.trim()))parseJson(line);return decodeErasureJournal(source);}
const order=(a:string,b:string)=>a<b?-1:a>b?1:0;
const pair=/^history\/music\/paired-backups\/([0-9]{8}-[0-9]{6})\/(?:data\.json|identity\.sqlite3|erasures\.jsonl|walls\/(?:manifest\.json|[^/]+\.(?:png|jpg|jpeg|webp)))$/;
const json=/^history\/music\/backups\/data-([0-9]{8}-[0-9]{6})\.json$/;
function safe(path:string){if(path.startsWith('/')||path.includes('\\')||path.split('/').some(part=>!part||part==='.'||part==='..'))throw Error('Unsafe history path');}
function mapFiles(files:MediaSourceFile[]){const map=new Map<string,Buffer>();for(const file of files){safe(file.path);if(!Buffer.isBuffer(file.bytes)||map.has(file.path))throw Error('Ambiguous history files');map.set(file.path,file.bytes);}return map;}
function matchFiles(files:MediaSourceFile[],manifest:z.infer<typeof File>[]){
  const actual=mapFiles(files);if(actual.size!==manifest.length)throw Error('History inventory differs');
  const seen=new Set<string>();for(const file of manifest){safe(file.path);const bytes=actual.get(file.path);if(seen.has(file.path)||!bytes||bytes.length!==file.size||digest(bytes)!==file.sha256)throw Error('History checksum differs');seen.add(file.path);}return actual;
}
function subset(older:StoredIntent[],latest:StoredIntent[]){const current=new Map(latest.map(row=>[erasureRequestId(row),JSON.stringify(row)]));if(older.some(row=>current.get(erasureRequestId(row))!==JSON.stringify(row)))throw Error('Historical erasure intent was lost');}
/** The capture pin and exact committed current fingerprint establish the legacy
 * namespace. All raw current/history/bot bytes remain inactive private evidence. */
export function validateHistoryCapture(db:DB,sources:HistorySources,pins:HistoryPins,latest:StoredIntent[]){
  if(digest(sources.captureManifest)!==pins.captureManifestSha256)throw Error('History capture pin differs');
  const manifest=CaptureManifest.parse(parseJson(decodeHistory(sources.captureManifest)));
  if(digest(JSON.stringify(manifest.files))!==manifest.sourceDigest)throw Error('History capture fingerprint differs');
  const files=matchFiles(sources.captureFiles,manifest.files),required=['current/board.sqlite3','current/board.erasures.jsonl','current/music/data.json','current/music/identity.sqlite3','current/music/erasures.jsonl','current/music/walls/manifest.json'];
  if(required.some(path=>!files.has(path)))throw Error('Incomplete history capture');
  const current=manifest.files.filter(file=>file.path.startsWith('current/')).map(file=>({path:file.path.slice(8),digest:file.sha256,size:file.size})).sort((a,b)=>order(a.path,b.path));
  const run=db.prepare('SELECT manifest_json FROM migration_runs WHERE source_digest=?').get(digest(JSON.stringify(current))) as {manifest_json:string}|undefined;
  if(run?.manifest_json!==JSON.stringify(current))throw Error('History does not belong to the fixed imported source');
  subset(historyJournal(files.get('current/board.erasures.jsonl')!),latest);
  const erased=new Set([...musicErasures(decodeHistory(files.get('current/music/erasures.jsonl')!)).keys(),...(db.prepare('SELECT legacy_key FROM music_legacy_erasures').all() as {legacy_key:string}[]).map(row=>row.legacy_key)]);
  const groups=new Map<string,{id:string;source:'legacy_pair'|'legacy_json';sourceStamp:string;paths:string[]}>();
  const boardPairs=new Set<string>();
  for(const [path,bytes] of files){
    if(path.startsWith('history/music/')){
      const matched=pair.exec(path),single=json.exec(path),stamp=matched?.[1]??single?.[1];if(!stamp)throw Error('Unclassified music history');
      const id='legacy-'+(matched?'pair':'json')+'-'+stamp,group=groups.get(id)??{id,source:matched?'legacy_pair':'legacy_json',sourceStamp:stamp,paths:[]};group.paths.push(path);groups.set(id,group);
      if(path.endsWith('/erasures.jsonl'))for(const key of musicErasures(decodeHistory(bytes)).keys())if(!erased.has(key))throw Error('Historical music erasure intent was lost');
    }else if(path.startsWith('history/board/')){
      if(path==='history/board/privacy-erasures.jsonl')subset(historyJournal(bytes),latest);
      else{const match=/^history\/board\/(kanban-[0-9]{8}-[0-9]{6}-[0-9]{6})\.(sqlite3|images\.tar\.gz)$/.exec(path);if(!match)throw Error('Unclassified board history');if(match[2]==='sqlite3')boardPairs.add(match[1]!);}
    }else if(path.startsWith('bot-evidence/')){
      if(!/^bot-evidence\/(?:bot-group-state(?:-[a-f0-9]{20})?\.json|bot-health\.json|bot-events\.jsonl(?:\.[1-4])?)$/.test(path))throw Error('Unclassified historical bot evidence');
      const raw=decodeHistory(bytes);if(path.endsWith('.json'))parseJson(raw);else{if(raw&&!raw.endsWith('\n'))throw Error('Incomplete historical bot journal');for(const line of raw.split('\n').filter(line=>line.trim()))parseJson(line);}
    }else if(!/^current\/(?:board\.sqlite3|board\.erasures\.jsonl|images\/[a-f0-9]{2}\/[a-f0-9]{64}\.png|music\/(?:data\.json|identity\.sqlite3|erasures\.jsonl|walls\/(?:manifest\.json|[^/]+\.(?:png|jpg|jpeg|webp))))$/.test(path))throw Error('Unclassified captured source');
  }
  for(const path of files.keys())if(path.endsWith('.images.tar.gz')&&!boardPairs.has(path.slice('history/board/'.length,-'.images.tar.gz'.length)))throw Error('Orphan board image history');
  for(const group of groups.values())if(group.source==='legacy_pair'){
    const base='history/music/paired-backups/'+group.sourceStamp;
    if(!files.has(base+'/data.json')||!files.has(base+'/identity.sqlite3'))throw Error('Incomplete historical music pair');
    const identity=new Database(files.get(base+'/identity.sqlite3')!);try{if(identity.pragma('integrity_check',{simple:true})!=='ok'||(identity.pragma('foreign_key_check') as unknown[]).length)throw Error('Historical identity integrity failed');readIdentity(identity);}finally{identity.close();}
    const wall=files.get(base+'/walls/manifest.json');if(wall){const value=parseJson(decodeHistory(wall));if(!value||typeof value!=='object'||Array.isArray(value)||!Array.isArray(value.items))throw Error('Invalid historical wall manifest');for(const item of value.items){if(!item||typeof item!=='object'||Array.isArray(item)||typeof item.src!=='string'||!/^\/walls\/[^/]+\.(?:png|jpg|jpeg|webp)$/.test(item.src)||item.src.includes('..')||!files.has(base+item.src))throw Error('Missing historical wall reference');}}
  }
  return {files,erased,groups:[...groups.values()].sort((a,b)=>order(a.id,b.id))};
}
/** Validates raw pinned bytes in memory. Historical credentials/bot work are
 * never activated; migrations affect only this disposable copy. */
export function openHistoryNative(current:DB,archive:HistorySources['native'][number],pins:HistoryPins,latest:StoredIntent[]){
  const pin=pins.native.find(row=>row.id===archive.id);if(!pin||digest(archive.manifest)!==pin.sha256)throw Error('Native history pin differs');
  const manifest=PairedBackupManifest.parse(parseJson(decodeHistory(archive.manifest)));if(manifest.id!==archive.id)throw Error('Native history name differs');
  const files=matchFiles(archive.files,manifest.files),image=files.get('state.sqlite3')!;
  if(image.length<100||image[18]!==1||image[19]!==1)throw Error('Native history must be standalone');
  const entries=historyJournal(files.get('state.erasures.jsonl')!);subset(entries,latest);
  const copy=new Database(image);try{
    if((copy.prepare('SELECT version FROM rebuild_schema').get() as {version:number}|undefined)?.version!==manifest.schema||copy.pragma('integrity_check',{simple:true})!=='ok'||(copy.pragma('foreign_key_check') as unknown[]).length)throw Error('Historical native database integrity failed');
    readVerifiedErasureJournal(copy,{read:()=>entries,append(){throw Error('Read-only history');}});
    if(manifest.version===2){const lineage=(copy.prepare('SELECT lineage_id FROM rebuild_storage WHERE id=1').get() as {lineage_id:string}|undefined)?.lineage_id;if(lineage!==manifest.lineageId||lineage!==(current.prepare('SELECT lineage_id FROM rebuild_storage WHERE id=1').get() as {lineage_id:string}).lineage_id)throw Error('Native history lineage differs');}
    // Schema13 predates lineage. Require exact imported-source receipts; never
    // infer identity from the backup name, timestamp or copied credentials.
    const runs=copy.prepare('SELECT source_digest,manifest_json FROM migration_runs ORDER BY source_digest').all() as {source_digest:string;manifest_json:string}[];
    if(manifest.version===1&&!runs.length)throw Error('Schema13 history has no source provenance');
    for(const run of runs)if((current.prepare('SELECT manifest_json FROM migration_runs WHERE source_digest=?').get(run.source_digest) as {manifest_json:string}|undefined)?.manifest_json!==run.manifest_json)throw Error('Native history import provenance differs');
    migrateDatabase(copy);
    copy.transaction(()=>assertRollbackSource(copy)).immediate();
    const images=(copy.prepare('SELECT digest,size,mime FROM image_assets ORDER BY digest').safeIntegers(true).all() as {digest:string;size:bigint;mime:string}[]).map(row=>{
      const path='images/'+row.digest.slice(0,2)+'/'+row.digest+'.png',bytes=files.get(path);if(!bytes||BigInt(bytes.length)!==row.size||digest(bytes)!==row.digest||row.mime!=='image/png')throw Error('Historical native image pairing differs');return path;
    }).sort();if(JSON.stringify(images)!==JSON.stringify([...files.keys()].filter(path=>path.startsWith('images/')).sort()))throw Error('Native history image inventory differs');
    return {db:copy,manifest,entries};
  }catch(error){copy.close();throw error;}
}
function directory(path:string){const stat=lstatSync(path);if(!stat.isDirectory()||stat.isSymbolicLink()||realpathSync(path)!==path)throw Error('Unsafe history directory');}
function read(path:string,limit=512*1024*1024){const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const stat=fstatSync(fd);if(!stat.isFile()||stat.size>limit)throw Error('Invalid history source file');return readFileSync(fd);}finally{closeSync(fd);}}
function inventory(root:string,expected:Set<string>,empty:string[]=[]){
  const folders=new Set(empty);for(const path of expected){safe(path);for(let parent=dirname(path);parent!=='.';parent=dirname(parent))folders.add(parent);}
  const seen=new Set<string>();function walk(prefix=''){directory(join(root,prefix));for(const child of readdirSync(join(root,prefix),{withFileTypes:true})){const relative=prefix?prefix+'/'+child.name:child.name;if(child.isDirectory()&&folders.has(relative))walk(relative);else if(child.isFile()&&expected.has(relative))seen.add(relative);else throw Error('Unclassified history source inventory');}}
  walk();if(seen.size!==expected.size)throw Error('Missing history source inventory');
}
/** Explicit canonical immutable mounts and externally pinned complete inventory.
 * No writes, retention, service probes, source DB opens or authentication. */
export function readRollbackHistorySources(db:DB,latest:StoredIntent[],input:HistoryConfig){
  const config=RollbackHistoryConfig.parse(input);for(const root of [config.capture.root,config.native.root]){if(resolve(root)!==root)throw Error('History source must be canonical');directory(dirname(root));}
  const pins:HistoryPins={captureManifestSha256:config.capture.manifestSha256,native:[...config.native.manifests].sort((a,b)=>order(a.id,b.id))};
  if(new Set(pins.native.map(row=>row.id)).size!==pins.native.length)throw Error('Duplicate native history pin');
  const captureManifest=read(join(config.capture.root,'capture-manifest.json'),16*1024*1024);if(digest(captureManifest)!==pins.captureManifestSha256)throw Error('History capture pin differs');
  const manifest=CaptureManifest.parse(parseJson(decodeHistory(captureManifest))),captureExpected=new Set(['capture-manifest.json',...manifest.files.map(file=>file.path)]);
  const nativeExists=(()=>{try{lstatSync(config.native.root);return true;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;return false;}})();
  if(!nativeExists&&pins.native.length)throw Error('Missing native history source');
  function nativeInventory(){if(!nativeExists){try{lstatSync(config.native.root);throw Error('Native history directory appeared');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}return;}directory(config.native.root);const names=readdirSync(config.native.root).sort();if(JSON.stringify(names)!==JSON.stringify(pins.native.map(row=>row.id).sort()))throw Error('Native history inventory differs');}
  const empty=['current','current/images','current/music','current/music/walls','history','history/music','history/music/backups','history/music/paired-backups','history/board','bot-evidence'];
  inventory(config.capture.root,captureExpected,empty);nativeInventory();
  const sources:HistorySources={captureManifest,captureFiles:manifest.files.map(file=>({path:file.path,bytes:read(join(config.capture.root,file.path))})),native:[]};
  for(const pin of pins.native){const base=join(config.native.root,pin.id),encoded=read(join(base,'manifest.json'),4*1024*1024);if(digest(encoded)!==pin.sha256)throw Error('Native history pin differs');const m=PairedBackupManifest.parse(parseJson(decodeHistory(encoded)));inventory(base,new Set(['manifest.json',...m.files.map(file=>file.path)]));sources.native.push({id:pin.id,manifest:encoded,files:m.files.map(file=>({path:file.path,bytes:read(join(base,file.path))}))});}
  validateHistoryCapture(db,sources,pins,latest);for(const archive of sources.native){const copy=openHistoryNative(db,archive,pins,latest);copy.db.close();}
  function assertUnchanged(){inventory(config.capture.root,captureExpected,empty);nativeInventory();if(!read(join(config.capture.root,'capture-manifest.json'),16*1024*1024).equals(captureManifest))throw Error('History capture manifest changed');for(const file of sources.captureFiles)if(!read(join(config.capture.root,file.path)).equals(file.bytes))throw Error('History capture bytes changed');for(const archive of sources.native){const base=join(config.native.root,archive.id);inventory(base,new Set(['manifest.json',...archive.files.map(file=>file.path)]));if(!read(join(base,'manifest.json'),4*1024*1024).equals(archive.manifest))throw Error('Native history manifest changed');for(const file of archive.files)if(!read(join(base,file.path)).equals(file.bytes))throw Error('Native history bytes changed');}}
  assertUnchanged();return {sources,pins,assertUnchanged};
}
