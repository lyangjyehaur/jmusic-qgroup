import {afterAll,beforeAll,expect,it} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {brotliDecompressSync,gunzipSync} from 'node:zlib';
import {openDatabase,type DB} from '@qgroup/database';
import {createApp} from './app';
import {compressStaticAssets} from '../../web/static-compression';

let root:string,db:DB,app:ReturnType<typeof createApp>;
const script='export const value="public static fixture";\n'.repeat(800),style='.fixture{display:flex;color:#286f67}\n'.repeat(300),asset='/assets/index-abcdefgh.js';
beforeAll(async()=>{
  root=mkdtempSync(join(tmpdir(),'qgroup-static-assets-'));mkdirSync(join(root,'assets'));mkdirSync(join(root,'music'));
  writeFileSync(join(root,'index.html'),'<html lang="zh-Hant"><head></head><body><div id="root"></div></body></html>');
  writeFileSync(join(root,'assets/index-abcdefgh.js'),script);writeFileSync(join(root,'assets/index-ijklmnop.css'),style);
  writeFileSync(join(root,'sw.js'),'/* public update worker */\n'.repeat(200));writeFileSync(join(root,'music/sw.js'),'/* retired public worker */\n'.repeat(200));
  const manifest=JSON.stringify({name:'fixture',description:'public manifest fixture '.repeat(100)});
  writeFileSync(join(root,'manifest.webmanifest'),manifest);writeFileSync(join(root,'music/manifest.json'),manifest);
  writeFileSync(join(root,'icon.svg'),'<svg xmlns="http://www.w3.org/2000/svg"></svg>');writeFileSync(join(root,'tiny.js'),'export const small=true;');
  await compressStaticAssets(root,['assets/index-abcdefgh.js','assets/index-ijklmnop.css','sw.js','music/sw.js','manifest.webmanifest','music/manifest.json','icon.svg','tiny.js','index.html']);
  db=openDatabase(':memory:');app=createApp({db,origin:'https://fixture.invalid',staticRoot:root,pairedBackupScheduling:false});await app.ready();
});
afterAll(async()=>{await app?.close();db?.close();if(root)rmSync(root,{recursive:true,force:true});});
it('produces smaller Brotli/gzip representations while retaining every original asset byte and leaving small assets alone',()=>{
  for(const [file,bytes] of [['assets/index-abcdefgh.js',script],['assets/index-ijklmnop.css',style]]){
    const original=readFileSync(join(root,file!));expect(original.toString()).toBe(bytes);const br=readFileSync(join(root,file!+'.br')),gz=readFileSync(join(root,file!+'.gz'));expect(br.length).toBeLessThan(original.length);expect(gz.length).toBeLessThan(original.length);expect(brotliDecompressSync(br)).toEqual(original);expect(gunzipSync(gz)).toEqual(original);
  }
  for(const file of ['tiny.js','icon.svg','index.html']){expect(existsSync(join(root,file+'.br'))).toBe(false);expect(existsSync(join(root,file+'.gz'))).toBe(false);}
});
it.each(['br','gzip','identity'] as const)('serves %s public JS with the correct MIME, cache policy, bytes and encoding variation',async encoding=>{
  const response=await app.inject({method:'GET',url:asset,headers:{'accept-encoding':encoding}});expect(response.statusCode).toBe(200);expect(response.headers['content-type']).toMatch(/javascript/);expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');expect(response.headers.vary?.toString().toLowerCase()).toContain('accept-encoding');
  if(encoding==='identity'){expect(response.headers['content-encoding']).toBeUndefined();expect(response.rawPayload.toString()).toBe(script);}else{expect(response.headers['content-encoding']).toBe(encoding);expect((encoding==='br'?brotliDecompressSync(response.rawPayload):gunzipSync(response.rawPayload)).toString()).toBe(script);}
  expect(response.headers['x-content-type-options']).toBe('nosniff');expect(response.headers['content-security-policy']).toContain("object-src 'none'");
});
it('respects encoding quality and explicit exclusions instead of sending a forbidden representation',async()=>{
  const gzip=await app.inject({url:asset,headers:{'accept-encoding':'br;q=0, gzip;q=1'}});expect(gzip.headers['content-encoding']).toBe('gzip');
  const identity=await app.inject({url:asset,headers:{'accept-encoding':'gzip;q=0, br;q=0'}});expect(identity.headers['content-encoding']).toBeUndefined();expect(identity.rawPayload.toString()).toBe(script);
});
it('falls back to original bytes for unsupported encodings and keeps Vary on the fallback',async()=>{
  const response=await app.inject({url:asset,headers:{'accept-encoding':'unsupported'}});expect(response.statusCode).toBe(200);expect(response.headers['content-encoding']).toBeUndefined();expect(response.rawPayload.toString()).toBe(script);expect(response.headers.vary?.toString().toLowerCase()).toContain('accept-encoding');
});
it('serves compressed CSS using its logical MIME instead of the sibling suffix type',async()=>{
  const response=await app.inject({url:'/assets/index-ijklmnop.css',headers:{'accept-encoding':'br'}});expect(response.headers['content-type']).toMatch(/text\/css/);expect(brotliDecompressSync(response.rawPayload).toString()).toBe(style);
});
it('returns a conditional 304 for the same representation and a full response for a different encoding',async()=>{
  const br=await app.inject({url:asset,headers:{'accept-encoding':'br'}});expect(br.headers.etag).toBeTruthy();
  const same=await app.inject({url:asset,headers:{'accept-encoding':'br','if-none-match':String(br.headers.etag)}});expect(same.statusCode).toBe(304);expect(same.rawPayload.length).toBe(0);expect(same.headers.vary?.toString().toLowerCase()).toContain('accept-encoding');expect(same.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  const identity=await app.inject({url:asset,headers:{'accept-encoding':'identity','if-none-match':String(br.headers.etag)}});expect(identity.statusCode).toBe(200);expect(identity.rawPayload.toString()).toBe(script);
});
it('keeps GET/HEAD representation headers consistent and preserves byte ranges on uncompressed assets',async()=>{
  const get=await app.inject({url:asset,headers:{'accept-encoding':'gzip'}}),head=await app.inject({method:'HEAD',url:asset,headers:{'accept-encoding':'gzip'}});expect(head.statusCode).toBe(200);expect(head.rawPayload.length).toBe(0);for(const key of ['content-type','content-encoding','content-length','cache-control','etag'])expect(head.headers[key],key).toBe(get.headers[key]);
  const range=await app.inject({url:asset,headers:{'accept-encoding':'identity',range:'bytes=0-15'}});expect(range.statusCode).toBe(206);expect(range.rawPayload.toString()).toBe(script.slice(0,16));expect(range.headers['content-range']).toBe('bytes 0-15/'+Buffer.byteLength(script));
});
it.each(['/sw.js','/music/sw.js','/manifest.webmanifest','/music/manifest.json'])('keeps update asset %s out of long-lived caches even when a compressed sibling exists',async url=>{
  expect(existsSync(join(root,url+'.gz'))).toBe(true);
  const response=await app.inject({url,headers:{'accept-encoding':'gzip'}});expect(response.statusCode).toBe(200);expect(response.headers['content-encoding']).toBe('gzip');expect(response.headers['cache-control']).toBe('no-store');expect(gunzipSync(response.rawPayload)).toEqual(readFileSync(join(root,url)));
});
it('revalidates fixed-name icons and keeps translated SPA shells and bot deep links uncached',async()=>{
  const icon=await app.inject('/icon.svg');expect(icon.headers['cache-control']).toBe('public, max-age=0, must-revalidate');expect(icon.headers['content-type']).toMatch(/image\/svg\+xml/);
  for(const url of ['/','/index.html','/music/index.html','/activities?event=fixture']){
    const response=await app.inject({url,headers:{'accept-language':'zh-CN','accept-encoding':'br','if-none-match':String(icon.headers.etag)}});expect(response.statusCode).toBe(200);expect(response.headers['cache-control']).toBe('no-store');expect(response.headers['content-language']).toBe('zh-Hans');expect(response.headers.vary).toBe('Accept-Language');expect(response.rawPayload.toString()).toContain('lang="zh-Hans"');
  }
});
it('does not cache or compress API/session responses and preserves their cookie variation',async()=>{
  for(const url of ['/api/v2/session','/api/v2/activities','/api/v2/health']){const response=await app.inject({url,headers:{'accept-encoding':'br'}});expect(response.statusCode).toBe(200);expect(response.headers['cache-control']).toBe('no-store');expect(response.headers.vary).toBe('Cookie');expect(response.headers['content-encoding']).toBeUndefined();if(url.endsWith('/session')){expect(response.json().scope).toBeTruthy();expect(response.headers['set-cookie']).toBeTruthy();}}
});
it.each([asset+'.gz',asset+'.br','/.private','/assets/missing.js'])('does not expose a direct representation or missing static path %s as a SPA shell',async url=>{
  const response=await app.inject(url);expect(response.statusCode).toBe(404);expect(response.headers['content-type']).toMatch(/json/);
});
