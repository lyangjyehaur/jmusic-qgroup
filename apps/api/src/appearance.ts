import { WallpaperPath } from '@qgroup/contracts/http-paths';
import { withApiError } from './error-display';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { EmptyHttpQuery, Appearance,AppearanceCommand,AppearanceResult,SiteTitle } from '@qgroup/contracts';
import { wallpaperDigest,type DB } from '@qgroup/database';
import { DomainError,musicText } from '@qgroup/domain';
import { z } from 'zod';
import type { AdminSecurity } from './admin-security';
import { hash } from './security';
const imageURL=(id:string)=>'/api/v2/appearance/walls/'+id+'/image';
export function appearance(db:DB,publicOnly=false){
  const site=db.prepare("SELECT payload_json FROM music_documents WHERE kind='site_appearance' AND position=0").get() as {payload_json:string}|undefined;
  const siteTitle=site?SiteTitle.parse(JSON.parse(site.payload_json).title):'群聚';
  const config=db.prepare('SELECT rotate_seconds,revision FROM wallpaper_config WHERE id=1').get() as {rotate_seconds:number;revision:number};
  const rows=db.prepare('SELECT i.*,a.size FROM wallpaper_items i LEFT JOIN wallpaper_assets a ON a.digest=i.digest ORDER BY position').all() as {id:string;name:string;source:string;enabled:number;position:number;digest:string|null;size:number|null}[];
  return Appearance.parse({revision:hash(JSON.stringify([config,rows,siteTitle])),siteTitle,rotateSeconds:config.rotate_seconds,items:rows.filter(r=>!publicOnly||r.enabled&&r.digest).map(r=>({id:r.id,name:r.name,enabled:!!r.enabled,url:imageURL(r.id),size:r.size??0,missing:!r.digest}))});
}
export async function wallpaperImage(data:string,mime:string){
  if(!data||data.length>2800000||data.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(data))throw withApiError(new DomainError('WALLPAPER_IMAGE','圖片資料損壞，請重新選擇 PNG、JPG 或 WebP'));
  const raw=Buffer.from(data,'base64');if(raw.toString('base64')!==data||raw.length>2*1024*1024)throw withApiError(new DomainError('WALLPAPER_SIZE','單張壁紙最多 2 MiB'));
  const type=mime==='image/png'?'png':mime==='image/jpeg'?'jpeg':'webp';
  // Check both declared format and the complete raster decode. Never pass SVG/HTML to a browser.
  try{
    const image=sharp(raw,{failOn:'warning',limitInputPixels:40_000_000}),meta=await image.metadata();
    if(meta.format!==type)throw Error('format');
    await image.stats();
  }catch{throw withApiError(new DomainError('WALLPAPER_IMAGE','圖片格式或內容不符；只支援 PNG、JPG、WebP，最多 4000 萬像素'));}
  return raw;
}
export function registerAppearance(app:FastifyInstance,db:DB,admin:AdminSecurity,now:()=>Date){
  app.get('/api/v2/appearance',async request=>db.transaction(()=>{EmptyHttpQuery.parse(request.query);return appearance(db,true);})());
  app.get('/api/v2/admin/appearance',async request=>db.transaction(()=>{admin.authority(request);EmptyHttpQuery.parse(request.query);return appearance(db);})());
  app.post('/api/v2/admin/appearance',{bodyLimit:3*1024*1024,config:{rateLimit:{max:20,timeWindow:'1 minute'}}},async request=>{
    const access=admin.authority(request,true),input=AppearanceCommand.parse(request.body),key=z.string().uuid().parse(request.headers['idempotency-key']);
    const signature=hash('v2:appearance:'+JSON.stringify(input));
    const previous=()=>db.prepare('SELECT signature,response_json FROM auth_requests WHERE token_hash=? AND request_key=?').get(access.receiptScope,key) as {signature:string;response_json:string}|undefined;
    const replay=(prior:NonNullable<ReturnType<typeof previous>>)=>{if(prior.signature!==signature)throw withApiError(new DomainError('REQUEST_CONFLICT','這個操作編號已用於其他內容',409));return AppearanceResult.parse(JSON.parse(prior.response_json));};
    const prior=previous();if(prior)return replay(prior);
    const raw=input.command==='upload'?await wallpaperImage(input.data,input.mime):null;
    return db.transaction(()=>{
      const freshAccess=admin.authority(request,true);if(freshAccess.scope!==access.scope)throw withApiError(new DomainError('ADMIN_CHANGED','管理權限已有變更，請重新確認',403));
      const prior=previous();if(prior)return replay(prior);
      const before=appearance(db);if(input.revision!==before.revision)throw withApiError(new DomainError('APPEARANCE_CHANGED','外觀設定已有更新，請核對最新版後重新確認',409));
      admin.preserve(request);
      let id='';
      if(input.command==='upload'){
        const name=musicText(input.name)||'壁紙';if(Array.from(name).length>40||/[\x00-\x1f\x7f]/.test(name))throw withApiError(new DomainError('WALLPAPER_NAME','壁紙名稱最多 40 字，不可包含控制字元'));
        id='w_'+randomBytes(16).toString('hex');const digest=wallpaperDigest(raw!);
        db.prepare('INSERT OR IGNORE INTO wallpaper_assets VALUES(?,?,?,?)').run(digest,input.mime,raw,raw!.length);
        const position=(db.prepare('SELECT COALESCE(max(position),-1)+1 n FROM wallpaper_items').get() as {n:number}).n;
        db.prepare('INSERT INTO wallpaper_items VALUES(?,?,?,1,?,?)').run(id,'/walls/'+id+'.'+(input.mime==='image/png'?'png':input.mime==='image/jpeg'?'jpg':'webp'),name,position,digest);
      }else if(input.command==='site')db.prepare("INSERT INTO music_documents VALUES('site_appearance',0,?) ON CONFLICT(kind,position) DO UPDATE SET payload_json=excluded.payload_json").run(JSON.stringify({title:input.siteTitle}));
      else if(input.command==='config')db.prepare('UPDATE wallpaper_config SET rotate_seconds=? WHERE id=1').run(input.rotateSeconds);
      else{
        id=input.id;const item=db.prepare('SELECT position,digest FROM wallpaper_items WHERE id=?').get(id) as {position:number;digest:string|null}|undefined;
        if(!item)throw withApiError(new DomainError('WALLPAPER_NOT_FOUND','壁紙不存在或已刪除',404));
        if(input.command==='toggle')db.prepare('UPDATE wallpaper_items SET enabled=? WHERE id=?').run(input.enabled?1:0,id);
        if(input.command==='delete'){
          db.prepare('DELETE FROM wallpaper_items WHERE id=?').run(id);
          db.prepare('DELETE FROM wallpaper_assets WHERE digest=? AND NOT EXISTS(SELECT 1 FROM wallpaper_items WHERE digest=?)').run(item.digest,item.digest);
        }
        if(input.command==='move'){
          const index=before.items.findIndex(x=>x.id===id),other=before.items[index+input.direction];
          if(other){
            const position=(db.prepare('SELECT position FROM wallpaper_items WHERE id=?').get(other.id) as {position:number}).position;
            db.prepare('UPDATE wallpaper_items SET position=-1 WHERE id=?').run(id);
            db.prepare('UPDATE wallpaper_items SET position=? WHERE id=?').run(item.position,other.id);
            db.prepare('UPDATE wallpaper_items SET position=? WHERE id=?').run(position,id);
          }
        }
      }
      db.prepare('UPDATE wallpaper_config SET revision=revision+1,initialized=1 WHERE id=1').run();
      db.prepare('INSERT INTO appearance_actions(actor_id,actor_ref,command,item_id,created_at) VALUES(?,?,?,?,?)').run(access.userId,access.actorRef,input.command,id,now().toISOString());
      const result=AppearanceResult.parse({id,command:input.command,revision:appearance(db).revision});
      db.prepare('INSERT INTO auth_requests VALUES(?,?,?,?,?)').run(access.receiptScope,key,signature,JSON.stringify(result),now().toISOString());return result;
    }).immediate();
  });
  const serve=(id:string)=>{
    const asset=db.prepare('SELECT a.mime,a.data,a.digest FROM wallpaper_items i JOIN wallpaper_assets a ON a.digest=i.digest WHERE i.id=?').get(id) as {mime:string;data:Buffer;digest:string}|undefined;
    if(!asset)throw withApiError(new DomainError('WALLPAPER_NOT_FOUND','壁紙不存在或已刪除',404));
    if(wallpaperDigest(asset.data)!==asset.digest)throw withApiError(new DomainError('WALLPAPER_UNAVAILABLE','壁紙暫時無法讀取',503));
    // Imported bytes are retained exactly; reject an incorrect raster signature on the public route.
    const raw=asset.data,valid=asset.mime==='image/png'?raw.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')):asset.mime==='image/jpeg'?raw[0]===255&&raw[1]===216&&raw[2]===255:raw.toString('ascii',0,4)==='RIFF'&&raw.toString('ascii',8,12)==='WEBP';
    if(!valid)throw withApiError(new DomainError('WALLPAPER_UNAVAILABLE','壁紙格式無法讀取，請管理員重新上傳',503));return asset;
  };
  app.get('/api/v2/appearance/walls/:id/image',async(request,reply)=>{
    const {id}=WallpaperPath.parse(request.params),asset=serve(id);
    return reply.type(asset.mime).header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff').send(asset.data);
  });
  // Preserve existing public image links. Manifest discovery uses the unified API.
  for(const prefix of ['/walls/','/music/walls/'])app.get(prefix+':file',async(request,reply)=>{
    const {file}=z.object({file:z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(png|jpg|jpeg|webp)$/).refine(x=>!x.includes('..'))}).parse(request.params);
    const row=db.prepare('SELECT id FROM wallpaper_items WHERE source=?').get('/walls/'+file) as {id:string}|undefined;
    if(!row)throw withApiError(new DomainError('WALLPAPER_NOT_FOUND','壁紙不存在或已刪除',404));const asset=serve(row.id);return reply.type(asset.mime).header('Cache-Control','no-store').send(asset.data);
  });
}
