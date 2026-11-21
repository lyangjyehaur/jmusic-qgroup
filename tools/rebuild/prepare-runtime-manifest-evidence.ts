import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync,mkdirSync,readFileSync,writeFileSync } from 'node:fs';
import { isAbsolute,join,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { BuildSource } from '@qgroup/runtime';
import { checkRuntimeManifest,readRuntimeEvidenceDocument } from './check-runtime-manifest';

/** Assemble rehearsal evidence from original image observations. The only
 * subprocess resolves Compose against fresh empty files; it starts no service. */
export function prepareRuntimeManifestEvidence(input:{source:string;imageReport:string;imageInspect:string;output:string}){
 if(!Object.values(input).every(isAbsolute)||existsSync(input.output))throw Error('Absolute inputs and a new private output directory are required');
 if(Object.values(input).some(path=>resolve(path)!==path)||input.output.startsWith(input.source+'/'))throw Error('Canonical paths and an output outside the archived source are required');
 const sourceDocument=readRuntimeEvidenceDocument(join(input.source,'release-source.json')),source=BuildSource.parse(sourceDocument.value);
 if(source.source!=='rehearsal')throw Error('Only archived rehearsal sources are supported');
 for(const name of ['prepare-runtime-manifest-evidence.ts','check-runtime-manifest.ts','check-runtime-compose.ts']){
  if(!readFileSync(new URL(name,import.meta.url)).equals(readFileSync(join(input.source,'tools/rebuild',name))))throw Error('Verifier differs from the archived source');
 }
 const reportDocument=readRuntimeEvidenceDocument(input.imageReport);
 const report=z.object({image:z.string(),commit:z.string(),architecture:z.enum(['amd64','arm64']),
  versions:z.object({web:z.unknown(),bot:z.unknown()}),erasureAuthorityManifestSha256:z.string(),
  network:z.literal('none'),cleanupVerified:z.literal(true),releaseEligible:z.literal(false),
 }).parse(reportDocument.value);
 if(report.commit!==source.commit)throw Error('Image report and archive commits differ');
 const inspectDocument=readRuntimeEvidenceDocument(input.imageInspect),inspect=inspectDocument.value;
 mkdirSync(input.output,{mode:0o700});
 for(const name of ['data','authority','checkpoint'])mkdirSync(join(input.output,name),{mode:0o700});
 const emptyEnv=join(input.output,'empty.env');writeFileSync(emptyEnv,'',{flag:'wx',mode:0o600});
 const composePath=join(input.source,'deploy/unified-compose.yaml');
 const compose=JSON.parse(execFileSync('docker',['compose','-f',composePath,'config','--format','json'],{
  cwd:input.output,encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024,
  env:{PATH:process.env.PATH,COMPOSE_DISABLE_ENV_FILE:'1',
   QGROUP_WEB_IMAGE:report.image,QGROUP_BOT_IMAGE:report.image,QGROUP_UID:'994',QGROUP_GID:'992',
   QGROUP_DATA_DIR:join(input.output,'data'),QGROUP_ERASURE_AUTHORITY_DIR:join(input.output,'authority'),
   QGROUP_ERASURE_CHECKPOINT_DIR:join(input.output,'checkpoint'),QGROUP_ERASURE_AUTHORITY_MANIFEST_SHA256:report.erasureAuthorityManifestSha256,
   QGROUP_WEB_ENV_FILE:emptyEnv,QGROUP_BOT_ENV_FILE:emptyEnv,QGROUP_ORIGIN:'http://127.0.0.1:8791',QGROUP_WEB_PORT:'8791',
  },stdio:['ignore','pipe','pipe'],
 })) as unknown;
 const evidence={manifest:{version:1,purpose:'rehearsal',platform:'linux/'+report.architecture,origin:'http://127.0.0.1:8791',
  erasureAuthorityManifestSha256:report.erasureAuthorityManifestSha256,services:{web:{image:report.image,source},bot:{image:report.image,source}}},
  compose,images:{web:inspect,bot:inspect},versions:report.versions};
 const result=checkRuntimeManifest(evidence),hash=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');
 writeFileSync(join(input.output,'runtime-evidence.json'),JSON.stringify(evidence)+'\n',{flag:'wx',mode:0o600});
 const receipt={...result,observations:'original-isolated-image-report',composeOnly:true,emptyConfiguration:true,
  inputs:{imageReportSha256:reportDocument.sha256,imageInspectSha256:inspectDocument.sha256,composeSourceSha256:hash(composePath),
   buildSourceSha256:sourceDocument.sha256},
  verifierPins:['prepare-runtime-manifest-evidence.ts','check-runtime-manifest.ts','check-runtime-compose.ts'].map(name=>({path:'tools/rebuild/'+name,sha256:hash(join(input.source,'tools/rebuild',name))})),
  authorityContentsVerified:false,runningServiceCombinationVerified:false};
 writeFileSync(join(input.output,'runtime-verification.json'),JSON.stringify(receipt)+'\n',{flag:'wx',mode:0o600});
 return receipt;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{
  const args=process.argv.slice(2),names=['--source','--image-report','--image-inspect','--output'];
  if(args.length!==8||args.some((arg,i)=>i%2===0&&!names.includes(arg)))throw Error();
  const value=(name:string)=>{if(args.filter(a=>a===name).length!==1)throw Error();return args[args.indexOf(name)+1]!;};
  process.stdout.write(JSON.stringify(prepareRuntimeManifestEvidence({source:value('--source'),imageReport:value('--image-report'),imageInspect:value('--image-inspect'),output:value('--output')}))+'\n');
 }catch{process.stderr.write('Runtime evidence preparation failed; no services started or updated.\n');process.exitCode=1;}
}
