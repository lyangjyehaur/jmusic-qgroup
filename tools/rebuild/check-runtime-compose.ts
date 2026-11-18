import { execFileSync } from 'node:child_process';
import { isAbsolute,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const bytes=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)?v:typeof v==='string'&&/^[1-9][0-9]*$/.test(v)&&Number.isSafeInteger(Number(v))?Number(v):NaN;
export function checkRuntimeCompose(input:unknown){
 const obj=(value:unknown)=>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid Compose object');return value as Record<string,unknown>;},services=obj(obj(input).services),images:Record<string,string>={};
 if(Object.keys(services).sort().join(',')!=='bot,web')throw Error('Only the intended web and bot services are allowed');
 let data:string|undefined;
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
  if(!Array.isArray(s.volumes)||s.volumes.length!==1)throw Error('Only the explicit data mount is allowed');const mount=obj(s.volumes[0]);
  if(mount.type!=='bind'||mount.target!=='/var/lib/qgroup'||typeof mount.source!=='string'||!isAbsolute(mount.source)||mount.source==='/'||mount.source==='/var'||mount.source==='/etc'||mount.read_only)throw Error('Invalid explicit data mount');
  if(data&&mount.source!==data)throw Error('Web and bot must use the same approved data directory');data=mount.source;
  const env=obj(s.environment);if(env[name==='web'?'REBUILD_DB':'KANBAN_DB']!=='/var/lib/qgroup/kanban.sqlite3')throw Error('Web and bot database paths must agree');
 }
 return {images,resources:'bounded',rootfs:'read-only',sourceVersions:'check independently',deploymentPerformed:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{
  if(process.argv.length!==4||process.argv[2]!=='--file')throw Error();
  const raw=execFileSync('docker',['compose','-f',resolve(process.argv[3]!), 'config','--format','json'],{encoding:'utf8',maxBuffer:4*1024*1024});
  process.stdout.write(JSON.stringify(checkRuntimeCompose(JSON.parse(raw)))+'\n');
 }catch{process.stderr.write('Runtime Compose validation failed; no services started.\n');process.exitCode=1;}
}
