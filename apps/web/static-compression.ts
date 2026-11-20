import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {promisify} from 'node:util';
import {brotliCompress,gzip,constants} from 'node:zlib';
import type {Plugin} from 'vite';

const brotli=promisify(brotliCompress),gzipBytes=promisify(gzip);
/** Create alternate encodings of public build assets; original bytes and URLs
 * remain the source used by the PWA and browser integrity checks. */
export async function compressStaticAssets(root:string,files:Iterable<string>){
  for(const file of files){
    if(!/\.(?:js|css|svg|json|webmanifest|txt)$/.test(file))continue;
    const bytes=await readFile(join(root,file));if(bytes.length<1024)continue;
    const variants=await Promise.all([brotli(bytes,{params:{[constants.BROTLI_PARAM_QUALITY]:9}}),gzipBytes(bytes,{level:9})]);
    for(const [index,suffix] of ['.br','.gz'].entries())if(variants[index]!.length+64<bytes.length)await writeFile(join(root,file+suffix),variants[index]!);
  }
}
export function staticCompression():Plugin{
  let root:string;
  return {name:'unified-static-compression',apply:'build',configResolved(config){root=resolve(config.root,config.build.outDir);},
    writeBundle:{order:'post',async handler(_options,bundle){await compressStaticAssets(root,Object.values(bundle).map(row=>row.fileName));}}};
}
