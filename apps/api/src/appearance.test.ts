import { randomUUID } from 'node:crypto';
import sharp,{type Sharp} from 'sharp';
import { afterEach,describe,expect,it } from 'vitest';
import { openDatabase,wallpaperDigest } from '@qgroup/database';
import { Appearance } from '@qgroup/contracts';
import { createApp } from './app';
import { fixture } from '../testsupport/fixture';
import { sharedRecords } from './privacy';
const origin='https://rebuild.example',cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function setup(){
  const db=openDatabase(':memory:');fixture(db);db.prepare("INSERT INTO user_admin_roles VALUES('alice',1,1,'synthetic')").run();
  const app=createApp({db,origin});await app.ready();cleanup.push(async()=>{await app.close();db.close();});
  const cookie='kanban_session=fixture-alice',viewer=(await app.inject({url:'/api/v2/session',headers:{cookie}})).json(),headers={cookie,origin,'x-account-scope':viewer.scope,'x-csrf-token':viewer.csrf};
  const access=(await app.inject({url:'/api/v2/admin/session',headers})).json(),admin={...headers,'x-admin-csrf':access.adminCsrf};
  const read=async(publicOnly=false)=>Appearance.parse((await app.inject({url:publicOnly?'/api/v2/appearance':'/api/v2/admin/appearance',headers})).json());
  const send=async(body:object,key:string=randomUUID(),h=admin)=>app.inject({method:'POST',url:'/api/v2/admin/appearance',headers:{...h,'idempotency-key':key},payload:body});
  const command=async<T extends object>(body:T)=>({revision:(await read()).revision,confirm:true,...body});
  const upload=async(name='圖片',format:'png'|'jpeg'|'webp'='png')=>{const raw=await sharp({create:{width:5,height:4,channels:3,background:'#286f83'}}).toFormat(format).toBuffer(),body=await command({command:'upload',name,mime:'image/'+format,data:raw.toString('base64')}),response=await send(body);expect(response.statusCode,response.body).toBe(200);return{raw,body,result:response.json()};};
  return{db,app,read,send,command,upload,admin};
}
describe('transactional wallpaper and appearance administration',()=>{
  it('retains exact PNG/JPEG/WebP bytes, serves old links, orders/toggles/removes and preserves every bot table',async()=>{
    const s=await setup(),tables=['users','events','attendees','bot_outbox','bot_settings'],before=tables.map(t=>s.db.prepare('SELECT * FROM '+t).all());
    expect(await s.read(true)).toMatchObject({rotateSeconds:24,items:[]});
    const uploads=[];for(const format of ['png','jpeg','webp'] as const)uploads.push(await s.upload(format,format));
    for(const image of uploads){const item=(await s.read()).items.find(x=>x.id===image.result.id)!;expect(item).toMatchObject({name:image.result.command==='upload'?image.body.name:'',enabled:true,missing:false,size:image.raw.length});const response=await s.app.inject({url:item.url});expect(response.rawPayload).toEqual(image.raw);expect(response.headers['x-content-type-options']).toBe('nosniff');expect(response.headers['cache-control']).toBe('no-store');
      const source=(s.db.prepare('SELECT source FROM wallpaper_items WHERE id=?').get(item.id) as {source:string}).source;for(const url of [source,'/music'+source])expect((await s.app.inject({url})).rawPayload).toEqual(image.raw);
    }
    const first=uploads[0]!.result.id,last=uploads[2]!.result.id;
    expect((await s.send(await s.command({command:'move',id:last,direction:-1}))).statusCode).toBe(200);expect((await s.read()).items.map(x=>x.id)).toEqual([first,last,uploads[1]!.result.id]);
    await s.send(await s.command({command:'toggle',id:first,enabled:false}));expect((await s.read(true)).items.map(x=>x.id)).toEqual([last,uploads[1]!.result.id]);
    await s.send(await s.command({command:'config',rotateSeconds:8}));expect((await s.read(true)).rotateSeconds).toBe(8);
    await s.send(await s.command({command:'delete',id:first}));expect((await s.app.inject({url:'/api/v2/appearance/walls/'+first+'/image'})).statusCode).toBe(404);
    expect(tables.map(t=>s.db.prepare('SELECT * FROM '+t).all())).toEqual(before);expect(s.db.pragma('foreign_key_check')).toEqual([]);
  });
  it('replays the exact receipt after deletion, rejects changed UUID content, and forbids stale-revision writes',async()=>{
    const s=await setup(),body=await s.command({command:'config',rotateSeconds:30}),key=randomUUID(),result=await s.send(body,key);
    expect(result.statusCode).toBe(200);expect((await s.send(body,key)).json()).toEqual(result.json());expect((await s.send({...body,rotateSeconds:31},key)).statusCode).toBe(409);
    expect((await s.send({...body,rotateSeconds:32})).json().code).toBe('APPEARANCE_CHANGED');expect((await s.read()).rotateSeconds).toBe(30);expect(s.db.prepare('SELECT count(*) n FROM appearance_actions').get()).toEqual({n:1});
    const image=await s.upload(),remove=await s.command({command:'delete',id:image.result.id}),removeKey=randomUUID(),deleted=await s.send(remove,removeKey);expect((await s.send(remove,removeKey)).json()).toEqual(deleted.json());
  });
  it('checks current authority, origin, account scope, CSRF, UUID and explicit confirmation',async()=>{
    const s=await setup(),body=await s.command({command:'config',rotateSeconds:40});
    expect((await s.app.inject({url:'/api/v2/admin/appearance'})).statusCode).toBe(401);
    for(const patch of [{origin:'https://evil.example'},{'x-admin-csrf':'invalid'},{'x-account-scope':'invalid'},{'x-csrf-token':'invalid'},{cookie:''}])expect((await s.send(body,randomUUID(),{...s.admin,...patch})).statusCode).toBeGreaterThanOrEqual(400);
    for(const invalid of [{...body,confirm:false},{...body,extra:'discarded'},{...body,rotateSeconds:7},{...body,rotateSeconds:601},{...body,rotateSeconds:8.5}])expect((await s.send(invalid)).statusCode).toBe(400);
    expect((await s.send(body,'bad-key')).statusCode).toBe(400);expect((await s.read()).rotateSeconds).toBe(24);
    expect((await s.send(body)).statusCode).toBe(200);const revoked=await s.command({command:'config',rotateSeconds:50});s.db.prepare("UPDATE user_admin_roles SET is_admin=0,revision=revision+1 WHERE user_id='alice'").run();expect((await s.send(revoked) ).statusCode).toBeGreaterThanOrEqual(400);
  });
  it('rejects spoofed MIME, SVG, corrupt/truncated raster data, invalid base64, oversized and huge-pixel images without any stored residue',async()=>{
    const s=await setup(),valid=await sharp({create:{width:8,height:8,channels:3,background:'#fff'}}).png().toBuffer();
    const largePixels=await sharp({create:{width:6400,height:6400,channels:3,background:'#fff'}}).png().toBuffer();
    const invalid=[{mime:'image/jpeg',data:valid.toString('base64')},{mime:'image/png',data:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')},{mime:'image/png',data:valid.subarray(0,40).toString('base64')},{mime:'image/png',data:'AA=='+'\n'},{mime:'image/png',data:Buffer.alloc(2*1024*1024+1).toString('base64')},{mime:'image/png',data:largePixels.toString('base64')}];
    for(const image of invalid){const r=await s.send(await s.command({command:'upload',name:'invalid',...image}));expect(r.statusCode,r.body).toBe(400);}
    expect((await s.read()).items).toEqual([]);expect(s.db.prepare('SELECT count(*) n FROM appearance_actions').get()).toEqual({n:0});expect(s.db.prepare('SELECT count(*) n FROM auth_requests').get()).toEqual({n:0});
  });
  it('accepts the exact 2 MiB boundary byte-for-byte and rechecks authority after asynchronous decoding',async()=>{
    const s=await setup(),png=await sharp({create:{width:2,height:2,channels:3,background:'#fff'}}).png().toBuffer(),raw=Buffer.concat([png,Buffer.alloc(2*1024*1024-png.length)]);
    const body=await s.command({command:'upload',name:'邊界',mime:'image/png',data:raw.toString('base64')});expect((await s.send(body)).statusCode).toBe(200);expect((await s.app.inject({url:(await s.read()).items[0]!.url})).rawPayload).toEqual(raw);
    let arrived!:()=>void,release!:()=>void;const captured=new Promise<void>(resolve=>{arrived=resolve;}),pending=new Promise<void>(resolve=>{release=resolve;}),descriptor=Object.getOwnPropertyDescriptor(sharp.prototype,'stats')!;
    const second=await s.command({command:'upload',name:'撤權',mime:'image/png',data:png.toString('base64')});
    Object.defineProperty(sharp.prototype,'stats',{...descriptor,value:async function(this:Sharp){arrived();await pending;return descriptor.value.call(this);}});
    try{const response=s.send(second);await captured;s.db.prepare("UPDATE user_admin_roles SET is_admin=0,revision=revision+1 WHERE user_id='alice'").run();release();expect((await response).statusCode).toBe(403);expect((await s.read(true)).items).toHaveLength(1);expect(s.db.prepare('SELECT count(*) n FROM appearance_actions').get()).toEqual({n:1});}finally{release();Object.defineProperty(sharp.prototype,'stats',descriptor);}
  });
  it('deduplicates assets without dropping another reference; audit failure rolls assets, order, config and receipt back together',async()=>{
    const s=await setup(),a=await s.upload('A'),b=await s.upload('B');expect(s.db.prepare('SELECT count(*) n FROM wallpaper_assets').get()).toEqual({n:1});
    await s.send(await s.command({command:'delete',id:a.result.id}));expect((await s.app.inject({url:(await s.read()).items[0]!.url})).rawPayload).toEqual(b.raw);
    const before=await s.read(),receipts=s.db.prepare('SELECT * FROM auth_requests').all();s.db.exec("CREATE TRIGGER synthetic_wallpaper_failure BEFORE INSERT ON appearance_actions BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
    const body=await s.command({command:'delete',id:b.result.id});expect((await s.send(body)).statusCode).toBe(500);expect(await s.read()).toEqual(before);expect(s.db.prepare('SELECT * FROM auth_requests').all()).toEqual(receipts);expect(s.db.prepare('SELECT digest FROM wallpaper_assets').all()).toEqual([{digest:wallpaperDigest(b.raw)}]);
    s.db.exec('DROP TRIGGER synthetic_wallpaper_failure');await s.send(body);expect(s.db.prepare('SELECT * FROM wallpaper_assets').all()).toEqual([]);
  });
  it('retains minimal shared administrator audit, blocks private actor erasure from bypassing it and never leaks credentials in public output',async()=>{
    const s=await setup();await s.upload();expect(sharedRecords(s.db,'alice')).toMatchObject({appearance_actions:1});
    expect(()=>s.db.prepare("UPDATE appearance_actions SET actor_id=NULL").run()).toThrow('append-only');expect(()=>s.db.prepare('DELETE FROM appearance_actions').run()).toThrow('append-only');
    const response=await s.read(true);expect(JSON.stringify(response)).not.toMatch(/actor|csrf|token|fixture-alice|receipt|base64/);expect(Object.keys(response).sort()).toEqual(['items','revision','rotateSeconds']);
  });
  it('fails closed on corrupted imported bytes and digest mismatch',async()=>{
    const s=await setup(),image=await s.upload(),url=(await s.read()).items[0]!.url;
    s.db.prepare('UPDATE wallpaper_assets SET data=?,size=?').run(Buffer.from('bad'),3);expect((await s.app.inject({url})).statusCode).toBe(503);
    expect((await s.app.inject({url:'/api/v2/appearance/walls/w_'+ 'a'.repeat(32)+'/image'})).statusCode).toBe(404);expect(image.result.id).toMatch(/^w_/);
  });
});
