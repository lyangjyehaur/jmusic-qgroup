import { createHash } from 'node:crypto';
import { constants,closeSync,existsSync,fstatSync,lstatSync,openSync,readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from './index';
export const wallpaperDigest=(raw:Buffer|string)=>createHash('sha256').update(raw).digest('hex');
export const wallpaperFile=/^\/walls\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(png|jpg|jpeg|webp)$/;
function read(path:string){const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const stat=fstatSync(fd);if(!stat.isFile()||stat.size>32*1024*1024)throw Error('Invalid wallpaper file');return readFileSync(fd);}finally{closeSync(fd);}}
/** An explicit import, once, retaining original manifest and file bytes without transcoding. */
export function seedWallpapers(db:DB,folder:string){
  const config=db.prepare('SELECT initialized FROM wallpaper_config WHERE id=1').get() as {initialized:number};
  if(config.initialized||!existsSync(folder))return false;
  if(lstatSync(folder).isSymbolicLink()||!lstatSync(folder).isDirectory())throw Error('Unsafe wallpaper directory');
  const path=join(folder,'manifest.json');if(!existsSync(path))throw Error('Missing wallpaper manifest');
  const raw=read(path).toString('utf8'),value:unknown=JSON.parse(raw);
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid wallpaper manifest');
  const manifest=value as {rotateSeconds?:unknown;items?:unknown},seconds=Number(manifest.rotateSeconds||24);
  if(!Number.isInteger(seconds)||seconds<8||seconds>600||!Array.isArray(manifest.items))throw Error('Invalid wallpaper manifest settings');
  const items=manifest.items;
  db.transaction(()=>{
    for(const [position,value] of items.entries()){
      if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid wallpaper item');
      const item=value as {src?:unknown;name?:unknown;enabled?:unknown};
      if(typeof item.src!=='string'||!wallpaperFile.test(item.src)||item.src.includes('..')||item.name!==undefined&&typeof item.name!=='string')throw Error('Unsafe wallpaper source');
      let digest:string|null=null;const imagePath=join(folder,item.src.slice('/walls/'.length));
      if(existsSync(imagePath)){
        const data=read(imagePath);digest=wallpaperDigest(data);const extension=item.src.split('.').at(-1)!;
        db.prepare('INSERT OR IGNORE INTO wallpaper_assets VALUES(?,?,?,?)').run(digest,extension==='png'?'image/png':extension==='webp'?'image/webp':'image/jpeg',data,data.length);
      }
      db.prepare('INSERT INTO wallpaper_items VALUES(?,?,?,?,?,?)').run('w_'+wallpaperDigest(item.src).slice(0,24),item.src,item.name||item.src.split('/').at(-1),item.enabled===false?0:1,position,digest);
    }
    db.prepare('UPDATE wallpaper_config SET rotate_seconds=?,initialized=1,legacy_manifest_json=? WHERE id=1').run(seconds,raw);
  }).immediate();return true;
}
