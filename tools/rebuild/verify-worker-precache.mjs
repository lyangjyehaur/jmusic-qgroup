/** Execute the actual compiled install handler with a bounded cache recorder.
 * Real browser cases separately cover activation, cache storage and recovery.
 * Imports stay inside the function for use in a network-isolated image. */
export async function verifyWorkerPrecache(root){
  const {default:assert}=await import('node:assert/strict');
  const {readFile,readdir}=await import('node:fs/promises');
  const {join}=await import('node:path');
  const {createHash}=await import('node:crypto');
  const {runInNewContext}=await import('node:vm');
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
  const shell=await readFile(join(root,'index.html'),'utf8'),build=shell.match(/name="qgroup-build" content="([a-f0-9]{64})"/)?.[1];assert(build);
  const worker=await readFile(join(root,'sw.js')),origin='https://fixture.invalid',cacheName='qgroup-unified-shell-'+build;
  const expected=[...(await readdir(join(root,'assets'))).filter(name=>! /\.(?:br|gz|deflate)$/.test(name)).map(name=>'/assets/'+name),'/icon.svg','/icon-192.png','/icon-512.png'].sort();
  const allowed=new Set(expected),handlers=new Map(),batches=[],assets=[],deleted=[];
  let completion,active=0,peakCacheOperations=0,activationCalls=0;
  runInNewContext(worker.toString(),{URL,Request,Response,location:{origin},
    addEventListener:(name,handler)=>handlers.set(name,handler),
    skipWaiting:()=>{activationCalls++;},clients:{claim:()=>{activationCalls++;}},
    fetch:()=>{throw Error('Compiled precache must not use external transport');},
    caches:{async open(name){assert.equal(name,cacheName);return {async addAll(requests){
      assert(requests.length>0&&requests.length<=4,'Unbounded atomic cache operation');
      active++;peakCacheOperations=Math.max(peakCacheOperations,active);assert.equal(active,1,'Cache operations overlap');
      try{
        const rows=[];
        for(const request of requests){
          const url=new URL(request.url);assert.equal(url.origin,origin);assert.equal(url.search,'');assert.equal(url.hash,'');assert(allowed.has(url.pathname));
          assert.equal(request.method,'GET');assert.equal(request.credentials,'omit');assert.equal(request.cache,'reload');
          const bytes=await readFile(join(root,url.pathname));rows.push({path:url.pathname,bytes:bytes.length,sha256:hash(bytes)});
        }
        assets.push(...rows);batches.push({assets:rows.map(row=>row.path),decodedBytes:rows.reduce((sum,row)=>sum+row.bytes,0)});
      }finally{active--;}
    }};},async delete(name){deleted.push(name);return true;}}},{timeout:1000});
  assert(handlers.has('install'));handlers.get('install')({waitUntil(promise){assert.equal(completion,undefined);completion=promise;}});assert(completion);
  let timer;try{await Promise.race([completion,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Compiled precache did not finish')),10000);})]);}finally{clearTimeout(timer);}
  assert.deepEqual(assets.map(row=>row.path).sort(),expected);assert.equal(new Set(assets.map(row=>row.path)).size,expected.length);assert.equal(active,0);assert.equal(activationCalls,0);assert.deepEqual(deleted,[]);
  return {build,workerSha256:hash(worker),assetCount:assets.length,assets:assets.sort((a,b)=>a.path.localeCompare(b.path)),batches,
    decodedBytes:assets.reduce((sum,row)=>sum+row.bytes,0),maxAtomicDecodedBytes:Math.max(...batches.map(batch=>batch.decodedBytes)),
    maxBatchAssets:Math.max(...batches.map(batch=>batch.assets.length)),peakCacheOperations,completeInventory:true,noForcedActivation:true};
}
