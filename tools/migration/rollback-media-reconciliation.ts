import type {DB} from '@qgroup/database';
import type {StoredIntent} from '../../apps/api/src/erasure-journal';
import {readVerifiedErasureJournal} from '../../apps/api/src/erasure-journal';
import {assertRollbackSource} from './rollback-source';
import {verifyRollbackCheckpoint} from './rollback-checkpoint-reconciliation';
import {digest,object,parseJson,type ObjectValue} from './music-codec';
import type {MediaSourceFile,RollbackMedia} from './rollback-media';
function reject():never{throw Error('Rollback media reconciliation failed; retain the complete latest source');}
const canonical=(value:unknown)=>JSON.stringify(value,(_key,item:unknown)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item);
const equal=(a:unknown,b:unknown)=>{if(canonical(a)!==canonical(b))reject();};
const wallSource=/^\/walls\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(png|jpg|jpeg|webp)$/;
/** Expected original files must come from the held source capture, or from a
 * separately pinned package. No file reader or media projector is called. */
export function verifyRollbackMedia(source:DB,result:RollbackMedia,expectedFiles:MediaSourceFile[],intents:StoredIntent[]){
  assertRollbackSource(source);readVerifiedErasureJournal(source,{read:()=>intents,append(){throw Error('Read-only media verification');}});
  if(result.version!==1)reject();equal(Object.keys(result).filter(key=>key!=='report').sort(),['version','checkpointImage','journal','originalFiles','boardImages','walls'].sort());equal(result.journal,intents);
  const checkpoint=verifyRollbackCheckpoint(source,result.checkpointImage,intents);
  const inventory=(files:MediaSourceFile[])=>files.map(file=>{equal(Object.keys(file).sort(),['bytes','path']);if(!Buffer.isBuffer(file.bytes)||!(file.path==='walls/manifest.json'||/^walls\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(png|jpg|jpeg|webp)$/.test(file.path)&&!file.path.includes('..')||/^images\/[a-f0-9]{2}\/[a-f0-9]{64}\.png$/.test(file.path)))reject();if(file.path.startsWith('images/')){if(file.path.split('/')[1]!==file.path.split('/')[2]!.slice(0,2)||digest(file.bytes)!==file.path.split('/')[2]!.slice(0,-4))reject();}return {path:file.path,size:file.bytes.length,sha256:digest(file.bytes)};});
  const originals=inventory(expectedFiles);if(new Set(originals.map(file=>file.path)).size!==originals.length)reject();equal(inventory(result.originalFiles),originals);
  const assets=source.prepare('SELECT digest,size,mime FROM image_assets ORDER BY digest').safeIntegers(true).all() as {digest:string;size:bigint;mime:string}[];
  equal(result.boardImages.map(image=>{equal(Object.keys(image).sort(),['bytes','digest']);if(!Buffer.isBuffer(image.bytes)||!assets.some(row=>row.digest===image.digest)||digest(image.bytes)!==image.digest)reject();return [image.digest,BigInt(image.bytes.length).toString()];}),assets.map(row=>{if(typeof row.size!=='bigint'||row.size<0n||row.mime!=='image/png')reject();const path='images/'+row.digest.slice(0,2)+'/'+row.digest+'.png',file=expectedFiles.find(file=>file.path===path);if(!file||BigInt(file.bytes.length)!==row.size)reject();return [row.digest,row.size.toString()];}));
  equal(Object.keys(result.walls).sort(),['archivedFields','files','manifest','mapping']);
  const config=source.prepare('SELECT rotate_seconds,legacy_manifest_json FROM wallpaper_config WHERE id=1').get() as {rotate_seconds:number;legacy_manifest_json:string|null};
  const old=config.legacy_manifest_json===null?null:object(parseJson(config.legacy_manifest_json),'original wall manifest'),parsed=object(parseJson(result.walls.manifest),'rollback wall manifest');
  if(Object.keys(parsed).some(key=>!['rotateSeconds','items'].includes(key))||!Array.isArray(parsed.items))reject();
  if(!Number.isSafeInteger(config.rotate_seconds)||config.rotate_seconds<8||config.rotate_seconds>600||(typeof (parsed.rotateSeconds??24)!=='number'&&typeof parsed.rotateSeconds!=='string')||Number(parsed.rotateSeconds||24)!==config.rotate_seconds)reject();
  const archived:string[]=[],oldItems=new Map<string,ObjectValue>();
  const rotationSupported=!old||!Object.hasOwn(old,'rotateSeconds')||(typeof old.rotateSeconds==='number'||typeof old.rotateSeconds==='string')&&Number.isInteger(Number(old.rotateSeconds||24))&&Number(old.rotateSeconds||24)>=8&&Number(old.rotateSeconds||24)<=600;
  if(old){for(const field of Object.keys(old))if(!['rotateSeconds','items'].includes(field))archived.push('$['+JSON.stringify(field)+']');if(!rotationSupported)archived.push('$.rotateSeconds');if(!Array.isArray(old.items))reject();for(const [index,item] of old.items.entries()){
    const row=object(item,'source wall item');if(typeof row.src!=='string'||!wallSource.test(row.src)||row.src.includes('..')||oldItems.has(row.src)||row.name!==undefined&&typeof row.name!=='string')reject();oldItems.set(row.src,row);
    for(const field of Object.keys(row))if(!['src','name','enabled'].includes(field))archived.push('$.items['+index+']['+JSON.stringify(field)+']');if(row.enabled!==undefined&&typeof row.enabled!=='boolean')archived.push('$.items['+index+'].enabled');
  }}
  equal(result.walls.archivedFields,archived);
  const rows=source.prepare('SELECT id,source,name,enabled,position,digest FROM wallpaper_items ORDER BY position').safeIntegers(true).all() as {id:string;source:string;name:string;enabled:bigint;position:bigint;digest:string|null}[];
  equal(result.walls.mapping,rows.map(row=>{if(!/^w_(?:[a-f0-9]{24}|[a-f0-9]{32})$/.test(row.id)||!wallSource.test(row.source)||row.source.includes('..')||typeof row.position!=='bigint'||row.position<0n||![0n,1n].includes(row.enabled)||typeof row.name!=='string')reject();return {id:row.id,source:row.source,digest:row.digest,position:row.position.toString(),missing:row.digest===null};}));
  equal(parsed.items.length,rows.length);
  const items=parsed.items;
  rows.forEach((row,index)=>{
    const item=object(items[index],'rollback wall item'),previous=oldItems.get(row.source);if(Object.keys(item).some(key=>!['src','name','enabled'].includes(key))||item.name!==undefined&&typeof item.name!=='string'||item.enabled!==undefined&&typeof item.enabled!=='boolean')reject();equal(item.src,row.source);equal(item.name||row.source.split('/').at(-1),row.name);equal(item.enabled!==false,row.enabled===1n);
    if(previous&&(previous.name||row.source.split('/').at(-1))===row.name)equal(item.name,previous.name);
    if(previous&&typeof previous.enabled==='boolean'&&(previous.enabled!==false)===(row.enabled===1n))equal(item.enabled,previous.enabled);
    if(previous&&!Object.hasOwn(previous,'enabled')&&row.enabled===1n)equal(Object.hasOwn(item,'enabled'),false);
  });
  if(old&&rotationSupported&&Number(old.rotateSeconds||24)===config.rotate_seconds){equal(parsed.rotateSeconds,old.rotateSeconds);if(archived.length===0&&canonical(parsed)===canonical(old))equal(result.walls.manifest,config.legacy_manifest_json);}
  const current=rows.filter(row=>row.digest!==null);equal(result.walls.files.length,current.length);current.forEach((row,index)=>{
    const file=result.walls.files[index]!,asset=source.prepare('SELECT data,size,mime FROM wallpaper_assets WHERE digest=?').safeIntegers(true).get(row.digest) as {data:Buffer;size:bigint;mime:string}|undefined;
    const mime=row.source.endsWith('.png')?'image/png':row.source.endsWith('.webp')?'image/webp':'image/jpeg';
    equal(Object.keys(file).sort(),['bytes','digest','source']);if(!asset||!Buffer.isBuffer(asset.data)||!Buffer.isBuffer(file.bytes)||typeof asset.size!=='bigint'||BigInt(asset.data.length)!==asset.size||digest(asset.data)!==row.digest||!asset.data.equals(file.bytes)||asset.mime!==mime)reject();equal(file.source,row.source);equal(file.digest,row.digest);
  });
  return {version:1 as const,checkpoint,originalFiles:originals,boardImages:assets.length,orphanBoardFiles:originals.filter(file=>file.path.startsWith('images/')&&!assets.some(row=>row.digest===file.sha256)).length,
    wallItems:rows.length,missingWalls:rows.filter(row=>row.digest===null).length,wallFiles:current.length,inactiveOriginalWallFiles:originals.filter(file=>file.path.startsWith('walls/')&&file.path!=='walls/manifest.json'&&!result.walls.files.some(wall=>wall.source==='/'+file.path&&wall.digest===file.sha256)).length,archivedManifestFields:archived.length,wallManifestDigest:digest(result.walls.manifest),
    rollbackEligible:false as const,sourcePolicy:'private_original_files_latest_active_projection' as const,remaining:['native_legacy_history','private_package_manifest_fsync','browser_requests_proof_recovery','fixed_old_web_music_bot_rehearsal','forward_restore_mapping','resource_scale']};
}
