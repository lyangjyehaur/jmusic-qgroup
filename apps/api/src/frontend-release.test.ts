import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {gzipSync} from 'node:zlib';
import {openDatabase,type DB} from '@qgroup/database';
import {createApp} from './app';

const apiCommit='a'.repeat(40),hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
let root:string,db:DB,app:ReturnType<typeof createApp>;
afterEach(async()=>{await app?.close();db?.close();if(root)rmSync(root,{recursive:true,force:true});});
function artifact(label:string){
  const directory=join(root,'artifact-'+label),buildId=hash(label),file=`assets/page-${label.repeat(8)}.js`;
  mkdirSync(join(directory,'assets'),{recursive:true});mkdirSync(join(directory,'music'));
  const files:Record<string,string|Buffer>={
    'index.html':`<html lang="zh-Hant"><head><meta name="qgroup-build" content="${buildId}" /></head><body>${label}<script src="/${file}"></script></body></html>`,
    [file]:`export const release="${label}";\n`.repeat(500),'assets/page-12345678.css':'.fixture{color:pink}',
    'sw.js':`/* ${buildId} */`,'music/sw.js':`/* ${buildId} */`,
    'manifest.webmanifest':'{}','music/manifest.json':'{}','icon.svg':'<svg/>','icon-192.png':'icon','icon-512.png':'icon',
  };
  files[file+'.gz']=gzipSync(files[file]!);
  for(const [name,bytes] of Object.entries(files))writeFileSync(join(directory,name),bytes);
  const manifest={version:1,source:'origin-main',commit:(label==='A'?'b':'c').repeat(40),tree:'d'.repeat(40),apiCommit,backendFingerprint:hash('backend'),buildId,files:Object.fromEntries(Object.entries(files).map(([name,bytes])=>[name,hash(bytes)]))};
  const raw=JSON.stringify(manifest);writeFileSync(join(directory,'frontend-release.json'),raw);
  return {directory,manifestSha:hash(raw),file,buildId};
}
function activate(a:ReturnType<typeof artifact>,api=apiCommit){return JSON.parse(execFileSync('python3',[resolve('deploy/frontend_release.py'),'activate','--artifact',a.directory,'--root',join(root,'public'),'--api-commit',api,'--manifest-sha256',a.manifestSha],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));}
async function setup(){
  root=mkdtempSync(join(tmpdir(),'qgroup-frontend-release-'));const a=artifact('A'),b=artifact('B');activate(a);
  db=openDatabase(':memory:');
  app=createApp({db,origin:'https://fixture.invalid',frontendRoot:join(root,'public'),runtimeInfo:{service:'web',runtime:'typescript',version:1,source:'origin-main',commit:apiCommit,tree:'e'.repeat(40)},pairedBackupScheduling:false});
  await app.ready();return {a,b};
}
it('switches HTML, worker, manifests and newly named assets without restarting; retains old lazy chunks and supports rollback',async()=>{
  const {a,b}=await setup();const before=await app.inject('/api/v2/version');
  expect((await app.inject('/activities')).body).toContain(a.buildId);
  activate(b);
  expect((await app.inject('/activities')).body).toContain(b.buildId);
  expect((await app.inject('/sw.js')).body).toContain(b.buildId);
  expect((await app.inject('/frontend-version.json')).json()).toMatchObject({buildId:b.buildId,apiCommit});
  for(const file of [a.file,b.file]){const response=await app.inject('/'+file);expect(response.statusCode).toBe(200);expect(response.headers['cache-control']).toContain('immutable');}
  expect((await app.inject('/api/v2/version')).body).toBe(before.body);
  activate(a);
  expect((await app.inject('/activities')).body).toContain(a.buildId);
  expect((await app.inject('/'+b.file)).statusCode).toBe(200);
});
it('preserves compression, MIME, HEAD, validators, cache policy, language and bot deep links',async()=>{
  const {a}=await setup();
  const response=await app.inject({url:'/'+a.file,headers:{'accept-encoding':'gzip'}});
  expect(response.headers['content-encoding']).toBe('gzip');expect(response.headers['content-type']).toMatch(/javascript/);expect(response.headers['x-content-type-options']).toBe('nosniff');expect(response.headers['content-security-policy']).toContain("object-src 'none'");
  const conditional=await app.inject({url:'/'+a.file,headers:{'accept-encoding':'gzip','if-none-match':String(response.headers.etag)}});expect(conditional.statusCode).toBe(304);
  const head=await app.inject({method:'HEAD',url:'/'+a.file,headers:{'accept-encoding':'gzip'}});expect(head.rawPayload.length).toBe(0);expect(head.headers['content-length']).toBe(response.headers['content-length']);
  for(const url of ['/sw.js','/music/sw.js','/manifest.webmanifest','/music/manifest.json','/frontend-version.json'])expect((await app.inject(url)).headers['cache-control']).toBe('no-store');
  for(const url of ['/','/index.html','/music/index.html','/activities/fixture?invite=fixture','/time-polls/fixture','/auth/confirm']){
    const r=await app.inject({url,headers:{'accept-language':'zh-CN'}});expect(r.statusCode).toBe(200);expect(r.body).toContain('lang="zh-Hans"');expect(r.headers['cache-control']).toBe('no-store');expect(r.headers.vary).toBe('Accept-Language');expect(r.headers['set-cookie']).toBeUndefined();
  }
});
it('does not expose private release metadata, sidecars, missing files or unknown API/auth paths as HTML',async()=>{
  const {a}=await setup();
  for(const url of ['/frontend-release.json','/activation.json','/releases/private/index.html','/'+a.file+'.gz','/assets/missing.js','/.release.lock','/api/v2/missing','/api/missing','/music/api/me','/auth/missing','/assets/%2e%2e%2findex.html'])expect((await app.inject(url)).statusCode,url).toBe(404);
  expect((await app.inject({method:'POST',url:'/activities'})).statusCode).toBe(404);
  expect((await app.inject('/api/v2/admin/users')).statusCode).toBe(401);
  const session=await app.inject('/api/v2/session');expect(session.json().scope).toBeTruthy();expect(session.headers['set-cookie']).toBeTruthy();expect(session.headers['cache-control']).toBe('no-store');
});
it('keeps the previous release active after integrity, API compatibility or immutable asset collision failures',async()=>{
  const {a,b}=await setup(),pointer=readlinkSync(join(root,'public/current'));
  expect(()=>activate(b,'f'.repeat(40))).toThrow();
  const collision=join(root,'public',b.file);writeFileSync(collision,'collision');expect(()=>activate(b)).toThrow();rmSync(collision);
  writeFileSync(join(b.directory,'index.html'),'tampered');expect(()=>activate(b)).toThrow();
  expect(readlinkSync(join(root,'public/current'))).toBe(pointer);expect((await app.inject('/activities')).body).toContain(a.buildId);
});
it('does not spend API rate budget on static files, but keeps API limits active',async()=>{
  const {a}=await setup(),remoteAddress='198.51.100.155';
  for(let n=0;n<181;n++)expect((await app.inject({url:'/'+a.file,remoteAddress})).statusCode).toBe(200);
  for(let n=0;n<180;n++)expect((await app.inject({url:'/api/v2/health',remoteAddress})).statusCode).toBe(200);
  expect((await app.inject({url:'/api/v2/health',remoteAddress})).statusCode).toBe(429);
  expect((await app.inject({url:'/'+a.file,remoteAddress})).statusCode).toBe(200);
});
it('checks the actual API and updates only frontend metadata in the runtime manifest',async()=>{
  const {b}=await setup(),base=await app.listen({host:'127.0.0.1',port:0});
  const runtimePath=join(root,'runtime.json'),services={web:{sourceCommit:apiCommit,imageId:'unchanged-web',containerId:'unchanged-web-id'},bot:{sourceCommit:'e'.repeat(40),imageId:'unchanged-bot',containerId:'unchanged-bot-id'}};
  writeFileSync(runtimePath,JSON.stringify({services}));
  const args=[resolve('deploy/frontend_release.py'),'activate','--artifact',b.directory,'--root',join(root,'public'),'--api-commit',apiCommit,'--manifest-sha256',b.manifestSha,'--api-url',base,'--release-manifest',runtimePath];
  await promisify(execFile)('python3',args);
  const runtime=JSON.parse((await import('node:fs')).readFileSync(runtimePath,'utf8'));
  expect(runtime.services).toEqual(services);expect(runtime.frontend).toMatchObject({buildId:b.buildId,apiCommit,containersRestarted:false});
  expect((await app.inject('/activities')).body).toContain(b.buildId);
  const previous=readlinkSync(join(root,'public/current'));
  writeFileSync(runtimePath,JSON.stringify({services:{...services,web:{...services.web,sourceCommit:'f'.repeat(40)}}}));
  await expect(promisify(execFile)('python3',args)).rejects.toThrow();
  expect(readlinkSync(join(root,'public/current'))).toBe(previous);
});
