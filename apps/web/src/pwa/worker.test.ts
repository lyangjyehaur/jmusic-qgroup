import {beforeAll,expect,it} from 'vitest';
import {build} from 'esbuild';
import {runInNewContext} from 'node:vm';
import {fileURLToPath} from 'node:url';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {workerVersionBytes} from '../../pwa-build';

const version='b'.repeat(64),old='qgroup-unified-shell-'+'a'.repeat(64),current='qgroup-unified-shell-'+version;
const assets=Array.from({length:85},(_,index)=>'/assets/page-'+String(index).padStart(8,'0')+'.js');
let code:string;
beforeAll(async()=>{
  const compiled=await build({entryPoints:[fileURLToPath(new URL('worker.ts',import.meta.url))],bundle:true,write:false,format:'iife',target:'es2022',minify:true,define:{__PWA_BUILD_ID__:JSON.stringify(version),__PWA_ASSETS__:JSON.stringify(assets)}});
  code=compiled.outputFiles[0]!.text;
});
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
function fixture(){
  const handlers=new Map<string,(event:{waitUntil:(promise:Promise<void>)=>void})=>void>(),batches:Request[][]=[],gates:{resolve:()=>void;reject:(error:Error)=>void;done:boolean}[]=[],deleted:string[]=[];
  const records=new Map<string,Set<string>>([[old,new Set(['original-public-asset'])],['unrelated-fixture',new Set(['unrelated-original'])]]);
  let completion!:Promise<void>,settled=false,skipWaiting=0,claims=0;
  runInNewContext(code,{URL,Request,Response,location:{origin:'https://fixture.invalid'},addEventListener:(name:string,handler:(event:{waitUntil:(promise:Promise<void>)=>void})=>void)=>handlers.set(name,handler),
    skipWaiting:()=>{skipWaiting++;},clients:{claim:()=>{claims++;}},
    caches:{async open(name:string){if(!records.has(name))records.set(name,new Set());return {async addAll(requests:Request[]){batches.push(requests);await new Promise<void>((resolve,reject)=>{const gate={done:false,resolve(){gate.done=true;resolve();},reject(error:Error){gate.done=true;reject(error);}};gates.push(gate);});for(const request of requests)records.get(name)!.add(new URL(request.url).pathname);}};},async delete(name:string){deleted.push(name);return records.delete(name);}},
    fetch:()=>{throw Error('External transport is forbidden in worker fixtures');}});
  handlers.get('install')!({waitUntil(promise){completion=promise;void promise.then(()=>{settled=true;},()=>{settled=true;});}});
  return {batches,gates,deleted,records,get completion(){return completion;},get settled(){return settled;},get activationCalls(){return {skipWaiting,claims};},
    async drain(){while(!settled){for(const gate of gates)if(!gate.done)gate.resolve();await tick();}await completion.catch(()=>undefined);}};
}

it('bounds the atomic cache working set while retaining every original request and awaiting the complete inventory',async()=>{
  const h=fixture();
  try{
    await tick();expect(h.batches).toHaveLength(1);expect(h.batches[0]!.length).toBeLessThanOrEqual(4);expect(h.settled).toBe(false);
    await h.drain();await h.completion;
    expect(h.batches.every(batch=>batch.length>0&&batch.length<=4)).toBe(true);
    const requests=h.batches.flat();expect(requests.map(request=>new URL(request.url).pathname)).toEqual(assets);
    expect(requests.every(request=>request.cache==='reload'&&request.credentials==='omit')).toBe(true);
    expect([...h.records.get(current)!]).toEqual(assets);expect(h.deleted).toEqual([]);expect(h.activationCalls).toEqual({skipWaiting:0,claims:0});
  }finally{await h.drain();}
});

it('queues no later cache operation until the current working set has finished',async()=>{
  const h=fixture();
  try{
    await tick();expect(h.batches).toHaveLength(1);expect(h.batches[0]!.length).toBeLessThanOrEqual(4);
    h.gates[0]!.resolve();await tick();expect(h.batches).toHaveLength(2);expect(h.batches[1]!.length).toBeLessThanOrEqual(4);expect(h.settled).toBe(false);
    await tick();expect(h.batches).toHaveLength(2);expect([...h.records.get(current)!]).toEqual(h.batches[0]!.map(request=>new URL(request.url).pathname));
  }finally{await h.drain();}
});

it('rejects a later cache failure, removes its completed prefix and never queues the remaining inventory or activates',async()=>{
  const h=fixture();
  try{
    await tick();h.gates[0]!.resolve();await tick();expect(h.batches).toHaveLength(2);
    h.gates[1]!.reject(Error('Synthetic cache transaction failed'));await expect(h.completion).rejects.toThrow('Synthetic cache transaction failed');
    expect(h.batches).toHaveLength(2);expect(h.deleted).toEqual([current]);expect(h.records.has(current)).toBe(false);
    expect([...h.records.get(old)!]).toEqual(['original-public-asset']);expect([...h.records.get('unrelated-fixture')!]).toEqual(['unrelated-original']);expect(h.activationCalls).toEqual({skipWaiting:0,claims:0});
  }finally{await h.drain();}
});

it('changes canonical worker version bytes for an imported-only behavior or asset inventory change without changing the entry source',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'qgroup-worker-version-')),entry=join(directory,'worker.ts'),dependency=join(directory,'message.ts'),hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
  try{
    writeFileSync(entry,"import {message} from './message'; globalThis.__fixtureMessage = message + JSON.stringify(__PWA_ASSETS__);");writeFileSync(dependency,"export const message='first public offline response';");
    const source=readFileSync(entry),first=hash(await workerVersionBytes(entry,assets));expect(hash(await workerVersionBytes(entry,assets))).toBe(first);
    writeFileSync(dependency,"export const message='second public offline response';");expect(readFileSync(entry)).toEqual(source);const second=hash(await workerVersionBytes(entry,assets));expect(second).not.toBe(first);
    expect(hash(await workerVersionBytes(entry,[...assets,'/icon.svg']))).not.toBe(second);expect(readFileSync(entry)).toEqual(source);
  }finally{rmSync(directory,{recursive:true,force:true});}
});

it('uses the rebuild compiler settings regardless of an unrelated nearest tsconfig',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'qgroup-worker-config-')),entry=join(directory,'worker.ts'),config=join(directory,'tsconfig.json');
  try{
    writeFileSync(entry,'globalThis.__fixtureStrict = (function(){return this === undefined;})();');
    writeFileSync(config,JSON.stringify({compilerOptions:{alwaysStrict:false,strict:false}}));
    const first=await workerVersionBytes(entry,[]),context:{__fixtureStrict?:boolean}={};runInNewContext(Buffer.from(first).toString(),context);
    expect(context.__fixtureStrict).toBe(true);
    writeFileSync(config,JSON.stringify({compilerOptions:{alwaysStrict:true,strict:true}}));
    expect(Buffer.from(await workerVersionBytes(entry,[]))).toEqual(Buffer.from(first));
  }finally{rmSync(directory,{recursive:true,force:true});}
});
