import { execFileSync } from 'node:child_process';
import { isAbsolute,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const bytes=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)?v:typeof v==='string'&&/^[1-9][0-9]*$/.test(v)&&Number.isSafeInteger(Number(v))?Number(v):NaN;
export function canonicalRuntimeOrigin(value:unknown):string{
 if(typeof value!=='string')throw Error('An explicit canonical origin is required');
 try{
  const url=new URL(value);
  if(url.origin!==value||url.username||url.password||!['https:','http:'].includes(url.protocol)||url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error();
  return value;
 }catch{throw Error('A canonical HTTPS or isolated loopback HTTP origin is required');}
}
export function checkRuntimeCompose(input:unknown){
 const obj=(value:unknown)=>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid Compose object');return value as Record<string,unknown>;},services=obj(obj(input).services),images:Record<string,string>={};
 if(Object.keys(services).sort().join(',')!=='bot,web')throw Error('Only the intended web and bot services are allowed');
 let data:string|undefined,origin:string|undefined;
 for(const name of ['web','bot']){
  const s=obj(services[name]),image=s.image;
  if(typeof image!=='string'||!(/^(?:sha256:[a-f0-9]{64}|[a-z0-9][a-z0-9.:/_-]*@sha256:[a-f0-9]{64})$/.test(image)))throw Error('An immutable image ID or digest is required');images[name]=image;
  if(s.build||s.privileged||s.devices||s.cap_add||s.network_mode!=='host'||s.read_only!==true||s.init!==true)throw Error('Unexpected runtime privileges, build or network');
  if(typeof s.user!=='string'||!/^([1-9][0-9]*):([1-9][0-9]*)$/.test(s.user))throw Error('A non-root runtime user and group are required');
  if(JSON.stringify(s.cap_drop)!=='["ALL"]'||JSON.stringify(s.security_opt)!=='["no-new-privileges:true"]')throw Error('Capabilities and privilege escalation must be disabled');
  if(!Number.isFinite(bytes(s.mem_limit))||bytes(s.mem_limit)<=0||bytes(s.mem_limit)>512*1024*1024||bytes(s.memswap_limit)!==bytes(s.mem_limit)||!Number.isFinite(Number(s.cpus))||Number(s.cpus)<=0||Number(s.cpus)>1||!Number.isInteger(s.pids_limit)||Number(s.pids_limit)<=0||Number(s.pids_limit)>128)throw Error('Runtime resource limits are required');
  if(JSON.stringify(s.tmpfs)!=='["/tmp:rw,nosuid,nodev,noexec,size=64m"]')throw Error('A bounded, non-executable temporary filesystem is required');
  if(JSON.stringify(s.command)!==JSON.stringify(['node','.rebuild-dist/'+(name==='web'?'api':'bot')+'/start.mjs']))throw Error('Unexpected service command');
  const health=obj(s.healthcheck),test=health.test;if(health.disable||!Array.isArray(test)||test[0]!=='CMD'||test[1]!=='node'||(name==='bot'?(test.length!==4||test[2]!=='.rebuild-dist/bot/start.mjs'||test[3]!=='--check-health'):(test.length!==4||test[2]!=='-e'||typeof test[3]!=='string'||!test[3].includes('/api/v2/health')||!test[3].includes('r.ok')||!test[3].includes('AbortSignal.timeout(3000)'))))throw Error('An active bounded service health check is required');
  const externalFrontend=name==='web'&&obj(s.environment).REBUILD_FRONTEND_ROOT!==undefined;
  if(externalFrontend&&obj(s.environment).REBUILD_FRONTEND_ROOT!=='/var/lib/qgroup-frontend')throw Error('Unexpected frontend release root');
  const targets=name==='web'?['/var/lib/qgroup','/var/lib/qgroup-erasure','/var/lib/qgroup-checkpoint',...(externalFrontend?['/var/lib/qgroup-frontend']:[])]:['/var/lib/qgroup'];
  if(!Array.isArray(s.volumes)||s.volumes.length!==targets.length)throw Error('Only the explicit service data and web erasure mounts are allowed');
  const mounts=s.volumes.map(obj);
  if(JSON.stringify(mounts.map(mount=>mount.target).sort())!==JSON.stringify([...targets].sort()))throw Error('Service mount targets differ');
  for(const mount of mounts){
   if(mount.type!=='bind'||typeof mount.source!=='string'||!isAbsolute(mount.source)||resolve(mount.source)!==mount.source||['/','/var','/etc'].includes(mount.source)||obj(mount.bind).create_host_path!==false)throw Error('Explicit existing canonical bind sources are required');
   if(['/var/lib/qgroup-checkpoint','/var/lib/qgroup-frontend'].includes(String(mount.target))?mount.read_only!==true:mount.read_only!==undefined&&mount.read_only!==false)throw Error('Authority must be writable; checkpoint and frontend must be read-only');
  }
  const mount=mounts.find(mount=>mount.target==='/var/lib/qgroup')!;
  const dataSource=mount.source as string;
  if(data&&dataSource!==data)throw Error('Web and bot must use the same approved data directory');data=dataSource;
  const env=obj(s.environment);if(env.NODE_ENV!=='production'||env[name==='web'?'REBUILD_DB':'KANBAN_DB']!=='/var/lib/qgroup/kanban.sqlite3')throw Error('Production mode and web/bot database paths must agree');
  // The current fixed-image manifest has no activation receipt/copy binding.
  // Do not report that configuration as verified through the older validator.
  if(env.REBUILD_RECOVERY_ACTIVATION_ROOT!==undefined||env.REBUILD_RECOVERY_ACTIVATION_MANIFEST_SHA256!==undefined)throw Error('Recovery activation requires separate receipt and fixed-version runtime validation');
  const serviceOrigin=canonicalRuntimeOrigin(env[name==='web'?'REBUILD_ORIGIN':'KANBAN_BOT_BASE_URL']);
  if(origin&&origin!==serviceOrigin)throw Error('Web and bot origins must agree');origin=serviceOrigin;
  if(name==='web'){
   const sources=mounts.map(mount=>mount.source as string);
   for(const [i,source] of sources.entries())for(const other of sources.slice(i+1))if(source===other||source.startsWith(other+'/')||other.startsWith(source+'/'))throw Error('Data, retained authority and checkpoint sources must be separate');
   if(env.REBUILD_ERASURE_AUTHORITY_ROOT!=='/var/lib/qgroup-erasure'||env.REBUILD_ERASURE_AUTHORITY_CHECKPOINT!=='/var/lib/qgroup-checkpoint/unified.sqlite3'||typeof env.REBUILD_ERASURE_AUTHORITY_MANIFEST_SHA256!=='string'||!/^[a-f0-9]{64}$/.test(env.REBUILD_ERASURE_AUTHORITY_MANIFEST_SHA256))throw Error('Explicit retained authority and checkpoint configuration required');
  }
 }
 return {images,origin:origin!,resources:'bounded',rootfs:'read-only',sourceVersions:'check independently',deploymentPerformed:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{
  if(process.argv.length!==4||process.argv[2]!=='--file')throw Error();
  const raw=execFileSync('docker',['compose','-f',resolve(process.argv[3]!), 'config','--format','json'],{encoding:'utf8',maxBuffer:4*1024*1024});
  process.stdout.write(JSON.stringify(checkRuntimeCompose(JSON.parse(raw)))+'\n');
 }catch{process.stderr.write('Runtime Compose validation failed; no services started.\n');process.exitCode=1;}
}
