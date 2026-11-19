import {constants,closeSync,fstatSync,lstatSync,openSync,readFileSync,readdirSync,realpathSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import type {DB} from '@qgroup/database';
import {readVerifiedErasureJournal,type ErasureJournal,type StoredIntent} from '../../apps/api/src/erasure-journal';
import {assertRollbackSource} from './rollback-source';
import {verifyRollbackCheckpoint} from './rollback-checkpoint-reconciliation';
import {digest,object,parseJson,type ObjectValue} from './music-codec';
import {verifyRollbackMedia} from './rollback-media-reconciliation';

export type MediaSourceFile={path:string;bytes:Buffer};
export type RollbackMedia={version:1;checkpointImage:Buffer;journal:StoredIntent[];originalFiles:MediaSourceFile[];boardImages:{digest:string;bytes:Buffer}[];
  walls:{manifest:string;files:{source:string;digest:string;bytes:Buffer}[];mapping:{id:string;source:string;digest:string|null;position:string;missing:boolean}[];archivedFields:string[]}};
const imagePath=/^images\/[a-f0-9]{2}\/[a-f0-9]{64}\.png$/;
const wallPath=/^walls\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(png|jpg|jpeg|webp)$/;
const wallSource=/^\/walls\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(png|jpg|jpeg|webp)$/;
const canonical=(value:unknown)=>JSON.stringify(value,(_key,item:unknown)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item);
function read(path:string){const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const stat=fstatSync(fd);if(!stat.isFile()||stat.size>512*1024*1024)throw Error('Invalid rollback media file');return readFileSync(fd);}finally{closeSync(fd);}}
function originals(root:string){
  const files:MediaSourceFile[]=[];
  for(const name of ['images','walls']){
    const folder=join(root,name);try{lstatSync(folder);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
    const walk=(path:string)=>{
      const full=join(root,path),stat=lstatSync(full);
      if(!stat.isDirectory()||stat.isSymbolicLink()||realpathSync(full)!==full)throw Error('Unsafe rollback media directory');
      for(const child of readdirSync(full,{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){
        const relative=path+'/'+child.name;
        if(child.isDirectory()&&name==='images'&&/^images\/[a-f0-9]{2}$/.test(relative))walk(relative);
        else if(child.isFile()&&(imagePath.test(relative)||relative==='walls/manifest.json'||wallPath.test(relative)&&!relative.includes('..'))){
          const bytes=read(join(root,relative));
          if(relative.startsWith('images/')&&(relative.split('/')[1]!==relative.split('/')[2]!.slice(0,2)||digest(bytes)!==relative.split('/')[2]!.slice(0,-4)))throw Error('Rollback source image digest differs');
          files.push({path:relative,bytes});
        }else throw Error('Unclassified rollback media source');
      }
    };walk(name);
  }
  return files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}
/** Project only the latest authoritative wallpaper rows. Original unused
 * fields/files stay in the private complete source, never in a served manifest. */
function walls(db:DB):RollbackMedia['walls']{
  const config=db.prepare('SELECT rotate_seconds,legacy_manifest_json FROM wallpaper_config WHERE id=1').get() as {rotate_seconds:number;legacy_manifest_json:string|null};
  const original=config.legacy_manifest_json===null?null:object(parseJson(config.legacy_manifest_json),'original wallpaper manifest');
  const fields:string[]=[];if(original)for(const field of Object.keys(original))if(!['rotateSeconds','items'].includes(field))fields.push('$['+JSON.stringify(field)+']');
  const rotationSupported=!original||!Object.hasOwn(original,'rotateSeconds')||(typeof original.rotateSeconds==='number'||typeof original.rotateSeconds==='string')&&Number.isInteger(Number(original.rotateSeconds||24))&&Number(original.rotateSeconds||24)>=8&&Number(original.rotateSeconds||24)<=600;
  if(!rotationSupported)fields.push('$.rotateSeconds');
  const previous=new Map<string,ObjectValue>();
  if(original){if(!Array.isArray(original.items))throw Error('Invalid original wallpaper items');for(const [index,value] of original.items.entries()){
    const row=object(value,'original wallpaper item');if(typeof row.src!=='string'||!wallSource.test(row.src)||row.src.includes('..')||previous.has(row.src))throw Error('Invalid original wallpaper source');
    for(const field of Object.keys(row))if(!['src','name','enabled'].includes(field))fields.push('$.items['+index+']['+JSON.stringify(field)+']');
    if(row.name!==undefined&&typeof row.name!=='string')throw Error('Invalid original wallpaper name');
    if(row.enabled!==undefined&&typeof row.enabled!=='boolean')fields.push('$.items['+index+'].enabled');
    previous.set(row.src,row);
  }}
  if(!Number.isSafeInteger(config.rotate_seconds)||config.rotate_seconds<8||config.rotate_seconds>600)throw Error('Invalid current wallpaper rotation');
  const manifest:ObjectValue={rotateSeconds:config.rotate_seconds,items:[]},items:ObjectValue[]=[],files:RollbackMedia['walls']['files']=[],mapping:RollbackMedia['walls']['mapping']=[];
  if(original&&rotationSupported&&Number(original.rotateSeconds||24)===config.rotate_seconds){if(Object.hasOwn(original,'rotateSeconds'))manifest.rotateSeconds=original.rotateSeconds!;else delete manifest.rotateSeconds;}
  for(const row of db.prepare('SELECT i.*,a.data,a.mime FROM wallpaper_items i LEFT JOIN wallpaper_assets a ON a.digest=i.digest ORDER BY position').safeIntegers(true).all() as {id:string;source:string;name:string;enabled:bigint;position:bigint;digest:string|null;data:Buffer|null;mime:string|null}[]){
    if(!/^w_(?:[a-f0-9]{24}|[a-f0-9]{32})$/.test(row.id)||!wallSource.test(row.source)||row.source.includes('..')||typeof row.name!=='string'||![0n,1n].includes(row.enabled)||typeof row.position!=='bigint'||row.position<0n)throw Error('Invalid current wallpaper row');
    const old=previous.get(row.source),item:ObjectValue={src:row.source,name:row.name,enabled:row.enabled===1n};
    if(old){if((old.name||row.source.split('/').at(-1))===row.name){if(Object.hasOwn(old,'name'))item.name=old.name!;else delete item.name;}
      if((old.enabled!==false)===(row.enabled===1n)&&typeof old.enabled==='boolean')item.enabled=old.enabled;
      else if(row.enabled===1n&&!Object.hasOwn(old,'enabled'))delete item.enabled;
    }
    items.push(item);mapping.push({id:row.id,source:row.source,digest:row.digest,position:row.position.toString(),missing:row.digest===null});
    if(row.digest!==null){if(!Buffer.isBuffer(row.data)||digest(row.data)!==row.digest)throw Error('Current wallpaper bytes differ');files.push({source:row.source,digest:row.digest,bytes:Buffer.from(row.data)});}
  }
  manifest.items=items;
  const encoded=JSON.stringify(manifest)+'\n';
  return {manifest:original&&canonical(original)===canonical(manifest)?config.legacy_manifest_json!:encoded,files,mapping,archivedFields:fields};
}
/** One standalone IMMEDIATE lock covers SQLite, its durable journal and
 * external content-addressed images. Never deletes, rewrites or serves files. */
export function withRollbackMediaCapture<T>(source:DB,journal:ErasureJournal,work:(capture:{media:RollbackMedia&{report:ReturnType<typeof verifyRollbackMedia>};assertUnchanged:()=>void})=>T):T{
  if(source.inTransaction)throw Error('Rollback media requires a standalone source transaction');
  if(!source.name||source.name===':memory:'||resolve(source.name)!==source.name||realpathSync(source.name)!==source.name||!lstatSync(source.name).isFile())throw Error('Rollback media requires a canonical file-backed source');
  const root=dirname(source.name);if(realpathSync(root)!==root)throw Error('Unsafe rollback media source root');
  const sourceStat=lstatSync(source.name,{bigint:true});
  return source.transaction(()=>{
    assertRollbackSource(source);const intents=structuredClone(readVerifiedErasureJournal(source,journal)),image=source.serialize();image[18]=1;image[19]=1;
    const expected=originals(root),byPath=new Map(expected.map(file=>[file.path,file]));
    const boardImages=(source.prepare('SELECT digest,size,mime FROM image_assets ORDER BY digest').safeIntegers(true).all() as {digest:string;size:bigint;mime:string}[]).map(row=>{
      const file=byPath.get('images/'+row.digest.slice(0,2)+'/'+row.digest+'.png');
      if(!/^[a-f0-9]{64}$/.test(row.digest)||typeof row.size!=='bigint'||row.size<0n||row.mime!=='image/png'||!file||BigInt(file.bytes.length)!==row.size)throw Error('Missing or inconsistent rollback board image');
      return {digest:row.digest,bytes:Buffer.from(file.bytes)};
    });
    const result:RollbackMedia={version:1,checkpointImage:image,journal:intents,originalFiles:expected.map(file=>({path:file.path,bytes:Buffer.from(file.bytes)})),boardImages,walls:walls(source)};
    const report=verifyRollbackMedia(source,result,expected,intents);
    verifyRollbackCheckpoint(source,image,intents);
    const fixedImage=Buffer.from(image),fixedIntents=structuredClone(intents);
    let active=true;
    function assertUnchanged(){
      if(!active||!source.inTransaction)throw Error('Rollback media source lock was released');
      const after=originals(root);if(JSON.stringify(after.map(file=>[file.path,digest(file.bytes)]))!==JSON.stringify(expected.map(file=>[file.path,digest(file.bytes)])))throw Error('Rollback media source changed while locked');
      const afterStat=lstatSync(source.name,{bigint:true});if(afterStat.isSymbolicLink()||!afterStat.isFile()||afterStat.dev!==sourceStat.dev||afterStat.ino!==sourceStat.ino)throw Error('Rollback media database file changed while locked');
      const current=readVerifiedErasureJournal(source,journal);if(JSON.stringify(current)!==JSON.stringify(fixedIntents))throw Error('Rollback media journal changed while locked');
      if(!image.equals(fixedImage)||JSON.stringify(result.journal)!==JSON.stringify(fixedIntents))throw Error('Rollback media captured checkpoint was changed');
      verifyRollbackCheckpoint(source,fixedImage,fixedIntents);
    }
    try{
      assertUnchanged();const captured={...result,report};const output=work({media:captured,assertUnchanged});
      if(output!==null&&(typeof output==='object'||typeof output==='function')&&'then' in output)throw Error('Rollback media capture callback must be synchronous');
      assertUnchanged();verifyRollbackMedia(source,result,expected,fixedIntents);return output;
    }finally{active=false;}
  }).immediate();
}

/** Compatibility API. Use withRollbackMediaCapture to retain the writer lock
 * through dependent capture/projection/IO; never await inside that callback. */
export function captureRollbackMedia(source:DB,journal:ErasureJournal){
  return withRollbackMediaCapture(source,journal,({media})=>media);
}
