/** Check real HTTP representations against the immutable files in a build.
 * Imports stay inside this function so the same checks can run inside the
 * network-isolated Linux image without bundling a second implementation. */
export async function verifyBuiltStatic(base,root){
  const {default:assert}=await import('node:assert/strict');
  const {readFile,readdir}=await import('node:fs/promises');
  const {join}=await import('node:path');
  const {request}=await import('node:http');
  const {brotliDecompressSync,gunzipSync}=await import('node:zlib');
  const {createHash}=await import('node:crypto');
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
  let httpChecks=0,conditionalChecks=0,headChecks=0,directSidecarsDenied=0;
  const get=(path,headers={},method='GET')=>new Promise((resolve,reject)=>{
    httpChecks++;
    const req=request(new URL(path,base),{method,headers},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);
      res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,bytes:Buffer.concat(chunks)}));
    });req.on('error',reject);req.setTimeout(10000,()=>req.destroy(Error('Static HTTP check timed out')));req.end();
  });
  const assets=[];
  const names=(await readdir(join(root,'assets'))).filter(name=>/\.(?:js|css)$/.test(name)).sort();
  assert(names.some(name=>name.endsWith('.js'))&&names.some(name=>name.endsWith('.css')),'Missing built JS or CSS');
  for(const name of names){
    const path='/assets/'+name,original=await readFile(join(root,path)),row={path,sha256:hash(original),bytes:original.length,br:null,gzip:null};
    for(const encoding of ['identity','br','gzip']){
      const response=await get(path,{'Accept-Encoding':encoding});assert.equal(response.status,200);
      assert.match(response.headers['content-type'],name.endsWith('.css')?/text\/css/:/javascript/);
      assert.equal(response.headers['cache-control'],'public, max-age=31536000, immutable');
      assert.match(response.headers.vary,/accept-encoding/i);assert.equal(response.headers['x-content-type-options'],'nosniff');
      assert.match(response.headers['content-security-policy'],/object-src 'none'/);assert.equal(response.headers['set-cookie'],undefined);
      const actual=response.headers['content-encoding'];assert(actual===undefined||actual===encoding,'Unrequested encoding');
      const decoded=actual==='br'?brotliDecompressSync(response.bytes):actual==='gzip'?gunzipSync(response.bytes):response.bytes;
      assert.deepEqual(decoded,original,'Static representation differs from archived build bytes');
      assert.equal(Number(response.headers['content-length']),response.bytes.length);
      if(actual){assert(response.bytes.length+64<original.length);row[encoding]=response.bytes.length;}
      // The entry bundles exercise conditional and HEAD semantics for every
      // negotiated encoding; byte checks above cover all lazy bundles too.
      if(/^index-/.test(name)){
        const conditional=await get(path,{'Accept-Encoding':encoding,'If-None-Match':response.headers.etag});conditionalChecks++;
        assert.equal(conditional.status,304);assert.equal(conditional.bytes.length,0);assert.equal(conditional.headers['cache-control'],response.headers['cache-control']);assert.match(conditional.headers.vary,/accept-encoding/i);
        const head=await get(path,{'Accept-Encoding':encoding},'HEAD');headChecks++;assert.equal(head.status,200);assert.equal(head.bytes.length,0);
        for(const key of ['content-type','content-encoding','content-length','cache-control','etag'])assert.equal(head.headers[key],response.headers[key]);
      }
    }
    for(const [key,suffix] of [['br','.br'],['gzip','.gz']])if(row[key]!==null){const direct=await get(path+suffix);assert.equal(direct.status,404);assert.match(direct.headers['content-type'],/json/);directSidecarsDenied++;}
    assets.push(row);
  }
  for(const extension of ['.js','.css'])assert(assets.some(row=>row.path.endsWith(extension)&&row.br!==null&&row.gzip!==null),'Missing build compression variants for '+extension);
  for(const path of ['/sw.js','/music/sw.js','/manifest.webmanifest','/music/manifest.json']){
    const original=await readFile(join(root,path));
    for(const encoding of ['identity','br','gzip']){
      const response=await get(path,{'Accept-Encoding':encoding});assert.equal(response.status,200);assert.equal(response.headers['cache-control'],'no-store');assert.equal(response.headers['set-cookie'],undefined);
      const actual=response.headers['content-encoding'];assert(actual===undefined||actual===encoding);
      const decoded=actual==='br'?brotliDecompressSync(response.bytes):actual==='gzip'?gunzipSync(response.bytes):response.bytes;assert.deepEqual(decoded,original);
    }
  }
  const shell=await get('/activities?event=synthetic',{'Accept-Encoding':'br','Accept-Language':'zh-CN'});assert.equal(shell.status,200);assert.equal(shell.headers['cache-control'],'no-store');assert.equal(shell.headers.vary,'Accept-Language');assert.equal(shell.headers['content-language'],'zh-Hans');assert.match(shell.bytes.toString(),/<html lang="zh-Hans"/);
  assert(conditionalChecks>=6&&headChecks>=6&&directSidecarsDenied>=4);
  return {assets,httpChecks,conditionalChecks,headChecks,directSidecarsDenied,originalBytesVerified:true};
}
