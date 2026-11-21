import { constants,closeSync,fstatSync,openSync,readSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { BuildSource } from '@qgroup/runtime';
import { canonicalRuntimeOrigin,checkRuntimeCompose } from './check-runtime-compose';

const imageId=z.string().regex(/^sha256:[a-f0-9]{64}$/);
const imageReference=z.string().regex(/^(?:sha256:[a-f0-9]{64}|[a-z0-9][a-z0-9.:/_-]*@sha256:[a-f0-9]{64})$/);
const pin=z.object({image:imageReference,source:BuildSource}).strict();
export const RuntimeManifest=z.object({
 version:z.literal(1),purpose:z.enum(['rehearsal','release']),
 platform:z.enum(['linux/amd64','linux/arm64']),origin:z.string().transform(canonicalRuntimeOrigin),
 erasureAuthorityManifestSha256:z.string().regex(/^[a-f0-9]{64}$/),
 services:z.object({web:pin,bot:pin}).strict(),
}).strict();
const runtimeVersion=BuildSource.extend({service:z.enum(['web','bot']),runtime:z.literal('typescript')}).strict();
const imageInspect=z.object({
 Id:imageId,RepoDigests:z.array(imageReference).nullable().optional(),Os:z.literal('linux'),Architecture:z.enum(['amd64','arm64']),
 Config:z.object({Labels:z.record(z.string(),z.string()).nullable()}),
});
const observations=z.object({
 manifest:RuntimeManifest,compose:z.unknown(),
 images:z.object({web:z.array(imageInspect).length(1),bot:z.array(imageInspect).length(1)}).strict(),
 versions:z.object({web:runtimeVersion,bot:runtimeVersion}).strict(),
}).strict();

/** Offline identity cross-check only. Observations need independent custody;
 * matching metadata never proves source authorization or functional compatibility. */
export function checkRuntimeManifest(input:unknown){
 const {manifest,compose,images,versions}=observations.parse(input),config=checkRuntimeCompose(compose);
 if(config.origin!==manifest.origin)throw Error('Manifest and Compose origins differ');
 const webEnvironment=(compose as {services:{web:{environment:Record<string,unknown>}}}).services.web.environment;
 if(webEnvironment.REBUILD_ERASURE_AUTHORITY_MANIFEST_SHA256!==manifest.erasureAuthorityManifestSha256)throw Error('Retained authority manifest pin differs');
 const verified={} as Record<'web'|'bot',{image:string;imageId:string;source:z.infer<typeof BuildSource>}>;
 for(const name of ['web','bot'] as const){
  const expected=manifest.services[name],spec=images[name][0]!,version=versions[name];
  if(config.images[name]!==expected.image)throw Error('Compose image reference differs');
  if(expected.image.startsWith('sha256:')?spec.Id!==expected.image:!spec.RepoDigests?.includes(expected.image))throw Error('Inspected image does not resolve the manifest reference');
  if('linux/'+spec.Architecture!==manifest.platform)throw Error('Image platform differs');
  if(spec.Config.Labels?.['org.opencontainers.image.revision']!==expected.source.commit)throw Error('Image source label differs');
  if(version.service!==name||version.commit!==expected.source.commit||version.tree!==expected.source.tree||version.source!==expected.source.source)throw Error('Service runtime source differs');
  if(expected.source.source!==(manifest.purpose==='release'?'origin-main':'rehearsal'))throw Error('Manifest purpose and source metadata differ');
  verified[name]={image:expected.image,imageId:spec.Id,source:expected.source};
 }
 if(verified.web.source.commit===verified.bot.source.commit&&verified.web.source.tree!==verified.bot.source.tree)throw Error('A single commit cannot have conflicting trees');
 if(verified.web.imageId===verified.bot.imageId&&JSON.stringify(verified.web.source)!==JSON.stringify(verified.bot.source))throw Error('A single image cannot have conflicting sources');
 return {version:1,identityVerified:true,platform:manifest.platform,origin:manifest.origin,
  erasureAuthorityManifestSha256:manifest.erasureAuthorityManifestSha256,services:verified,
  deploymentPerformed:false,sourceAuthorizationVerified:false,functionalCompatibilityVerified:false,releaseEligible:false};
}

export function readRuntimeEvidenceDocument(path:string):{value:unknown;sha256:string}{
 if(!isAbsolute(path))throw Error('An absolute evidence path is required');
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const stat=fstatSync(fd);
  if(!stat.isFile()||stat.size>8*1024*1024)throw Error('Invalid or oversized runtime evidence');
  const buffer=Buffer.alloc(8*1024*1024+1);let used=0;
  while(used<buffer.length){const n=readSync(fd,buffer,used,buffer.length-used,null);if(!n)break;used+=n;}
  if(used>8*1024*1024)throw Error('Oversized runtime evidence');
  const bytes=buffer.subarray(0,used);
  return {value:JSON.parse(bytes.toString('utf8')) as unknown,sha256:createHash('sha256').update(bytes).digest('hex')};
 }finally{closeSync(fd);}
}
export function readRuntimeEvidence(path:string):unknown{return readRuntimeEvidenceDocument(path).value;}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{
  if(process.argv.length!==4||process.argv[2]!=='--file')throw Error();
  process.stdout.write(JSON.stringify(checkRuntimeManifest(readRuntimeEvidence(process.argv[3]!)))+'\n');
 }catch{process.stderr.write('Runtime manifest validation failed; no services started or updated.\n');process.exitCode=1;}
}
