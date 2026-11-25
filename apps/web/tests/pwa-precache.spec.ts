import {createServer} from 'node:http';
import {once} from 'node:events';
import {readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import type {Page} from '@playwright/test';
import {test,expect} from './fixtures';

test.use({serviceWorkers:'allow'});
const dist=new URL('../../../.rebuild-dist/web/',import.meta.url);
const worker=readFileSync(new URL('sw.js',dist),'utf8');
const build=readFileSync(new URL('index.html',dist),'utf8').match(/name="qgroup-build" content="([a-f0-9]{64})"/)![1]!;
const paths=[...readdirSync(new URL('assets/',dist)).filter(name=>! /\.(?:br|gz|deflate)$/.test(name)).map(name=>'/assets/'+name),'/icon.svg','/icon-192.png','/icon-512.png'].sort();
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const originals=paths.map(path=>{const bytes=readFileSync(new URL(path.slice(1),dist));return {path,bytes:bytes.length,sha256:digest(bytes)};});
const cacheName=(version:string)=>'qgroup-unified-shell-'+version;

/** Only an empty document, the real compiled worker and public build files are
 * served here. The upstream API is the isolated native preview fixture. */
async function host(){
  const state={version:build,failPath:'',inFlight:0,peak:0,requests:[] as string[],bytes:0};
  const allowed=new Set(paths),gates=new Map<string,{promise:Promise<void>;release:()=>void;reached:boolean}>();
  const server=createServer(async(request,response)=>{
    const path=new URL(request.url??'/','http://localhost').pathname;
    if(path==='/blank'){response.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'});response.end('<!doctype html><title>Isolated worker verification</title>');return;}
    if(path==='/sw.js'){response.writeHead(200,{'Content-Type':'text/javascript','Cache-Control':'no-store'});response.end(worker.replaceAll(build,state.version));return;}
    if(!allowed.has(path)){response.writeHead(404,{'Content-Type':'text/plain','Cache-Control':'no-store'});response.end('Not found');return;}
    state.requests.push(path);state.inFlight++;state.peak=Math.max(state.peak,state.inFlight);
    try{
      // A fixed delay keeps overlap observable rather than relying on fast
      // localhost requests accidentally completing one after another.
      await new Promise(resolve=>setTimeout(resolve,25));
      const gate=gates.get(path);if(gate){gate.reached=true;await gate.promise;}
      if(state.failPath===path){response.writeHead(503,{'Content-Type':'text/plain','Cache-Control':'no-store'});response.end('Synthetic asset unavailable');return;}
      const upstream=await fetch(`http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`+path,{headers:{'Accept-Encoding':'identity'},signal:AbortSignal.timeout(10000)});
      for(const [key,value] of upstream.headers)if(!['content-length','content-encoding','transfer-encoding','connection'].includes(key))response.setHeader(key,value);
      const bytes=Buffer.from(await upstream.arrayBuffer());state.bytes+=bytes.length;response.statusCode=upstream.status;response.end(bytes);
    }catch{response.writeHead(502,{'Content-Type':'text/plain','Cache-Control':'no-store'});response.end('Synthetic upstream unavailable');}
    finally{state.inFlight--;}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  return {state,origin:'http://127.0.0.1:'+(server.address() as AddressInfo).port,
    hold(path:string){let release!:()=>void;const gate={promise:new Promise<void>(resolve=>{release=resolve;}),release:()=>release(),reached:false};gates.set(path,gate);return gate;},
    reset(){expect(state.inFlight).toBe(0);state.requests=[];state.peak=0;state.bytes=0;},
    async close(){for(const gate of gates.values())gate.release();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}
async function install(page:Page,origin:string){
  await page.goto(origin+'/blank');
  await page.evaluate(async()=>{await navigator.serviceWorker.register('/sw.js',{scope:'/',updateViaCache:'none'});});
  await expect.poll(()=>version(page)).toBe(build);
}
async function version(page:Page){return page.evaluate(async()=>{
  const controller=navigator.serviceWorker.controller;if(!controller)return '';
  return new Promise<string>(resolve=>{const channel=new MessageChannel(),timer=setTimeout(()=>{channel.port1.close();resolve('');},1000);channel.port1.onmessage=event=>{clearTimeout(timer);channel.port1.close();resolve(event.data.build);};controller.postMessage({type:'QGROUP_GET_VERSION'},[channel.port2]);});
});}
async function snapshot(page:Page,version:string){return page.evaluate(async({name,paths})=>{
  const cache=await caches.open(name),keys=(await cache.keys()).map(request=>new URL(request.url).pathname).filter(path=>path!=='/.qgroup-worker-retirements').sort(),rows=[];
  for(const path of paths){const response=await cache.match(path);if(!response){rows.push({path,missing:true});continue;}const bytes=await response.arrayBuffer(),hash=await crypto.subtle.digest('SHA-256',bytes);rows.push({path,bytes:bytes.byteLength,sha256:Array.from(new Uint8Array(hash),value=>value.toString(16).padStart(2,'0')).join('')});}
  return {keys,rows};
},{name:cacheName(version),paths});}
async function update(page:Page){await page.evaluate(async()=>{const registration=await navigator.serviceWorker.getRegistration('/');if(!registration)throw Error('Missing fixture registration');await registration.update();});}

test('precache bounds download overlap and retains every original split asset byte',async({page},testInfo)=>{
  const h=await host();
  try{
    await install(page,h.origin);
    expect(h.state.peak).toBeLessThanOrEqual(4);expect(h.state.inFlight).toBe(0);
    expect([...h.state.requests].sort()).toEqual(paths);expect(h.state.bytes).toBe(originals.reduce((sum,row)=>sum+row.bytes,0));
    const cache=await snapshot(page,build);expect(cache).toEqual({keys:paths,rows:originals});
    await testInfo.attach('precache-resources',{contentType:'application/json',body:JSON.stringify({build,assetCount:paths.length,identityBodyBytes:h.state.bytes,peakRequests:h.state.peak,requests:h.state.requests,cache})});
  }finally{await page.goto('about:blank');await h.close();}
});

test('a held final batch cannot become a waiting version and leaves the complete active cache untouched',async({page})=>{
  const h=await host(),next='a'.repeat(64);
  try{
    await install(page,h.origin);const original=await snapshot(page,build);h.reset();h.state.version=next;
    const gate=h.hold('/icon-512.png');await update(page);
    await expect.poll(()=>gate.reached).toBe(true);
    expect(await page.evaluate(async()=>{const reg=await navigator.serviceWorker.getRegistration('/');return {installing:reg?.installing?.state,waiting:reg?.waiting?.state??null};})).toEqual({installing:'installing',waiting:null});
    expect(await version(page)).toBe(build);expect(await snapshot(page,build)).toEqual(original);
    await expect.poll(()=>h.state.requests.length).toBe(paths.length);expect((await snapshot(page,next)).rows.filter(row=>'missing' in row).map(row=>row.path)).toEqual(h.state.requests.slice(Math.floor((paths.length-1)/4)*4).sort()); // Verify the actual final download batch, including its other resources.
    gate.release();await expect.poll(()=>page.evaluate(async()=>{const reg=await navigator.serviceWorker.getRegistration('/');return reg?.waiting?.state??'';})).toBe('installed');
    expect(await snapshot(page,next)).toEqual({keys:paths,rows:originals});expect(await version(page)).toBe(build);expect(h.state.peak).toBeLessThanOrEqual(4);
  }finally{await page.goto('about:blank');await h.close();}
});

test('late batch failure removes all partial new assets, preserves the active version and permits a complete retry',async({page})=>{
  const h=await host(),next='b'.repeat(64);
  try{
    await install(page,h.origin);const original=await snapshot(page,build);h.reset();h.state.version=next;h.state.failPath='/icon-512.png';await update(page);
    await expect.poll(()=>h.state.requests.includes('/icon-512.png')).toBe(true);
    await expect.poll(()=>page.evaluate(async()=>{const reg=await navigator.serviceWorker.getRegistration('/');return {installing:!!reg?.installing,waiting:!!reg?.waiting,caches:await caches.keys()};})).toEqual({installing:false,waiting:false,caches:[cacheName(build)]});
    expect(await version(page)).toBe(build);expect(await snapshot(page,build)).toEqual(original);expect(h.state.peak).toBeLessThanOrEqual(4);
    h.reset();h.state.failPath='';await update(page);
    await expect.poll(()=>page.evaluate(async()=>{const reg=await navigator.serviceWorker.getRegistration('/');return reg?.waiting?.state??'';})).toBe('installed');
    expect(await snapshot(page,next)).toEqual({keys:paths,rows:originals});expect([...h.state.requests].sort()).toEqual(paths);expect(await version(page)).toBe(build);expect(h.state.peak).toBeLessThanOrEqual(4);
  }finally{await page.goto('about:blank');await h.close();}
});
