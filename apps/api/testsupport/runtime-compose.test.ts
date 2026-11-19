import { it,expect } from 'vitest';
import { checkRuntimeCompose } from '../../../tools/rebuild/check-runtime-compose';
const service=(name:string)=>({image:'sha256:'+(name==='web'?'a':'b').repeat(64),network_mode:'host',user:'994:992',init:true,read_only:true,cap_drop:['ALL'],security_opt:['no-new-privileges:true'],mem_limit:512*1024*1024,memswap_limit:512*1024*1024,cpus:1,pids_limit:128,tmpfs:['/tmp:rw,nosuid,nodev,noexec,size=64m'],healthcheck:{test:name==='web'?['CMD','node','-e',"fetch('/api/v2/health',{signal:AbortSignal.timeout(3000)}).then(r=>r.ok)"]:['CMD','node','.rebuild-dist/bot/start.mjs','--check-health']},command:['node','.rebuild-dist/'+(name==='web'?'api':'bot')+'/start.mjs'],volumes:[{type:'bind',source:'/isolated/qgroup',target:'/var/lib/qgroup',bind:{create_host_path:false}},...(name==='web'?[{type:'bind',source:'/isolated/authority',target:'/var/lib/qgroup-erasure',bind:{create_host_path:false}},{type:'bind',source:'/isolated/checkpoint',target:'/var/lib/qgroup-checkpoint',read_only:true,bind:{create_host_path:false}}]:[])],environment:{NODE_ENV:'production',[name==='web'?'REBUILD_DB':'KANBAN_DB']:'/var/lib/qgroup/kanban.sqlite3',...(name==='web'?{REBUILD_ERASURE_AUTHORITY_ROOT:'/var/lib/qgroup-erasure',REBUILD_ERASURE_AUTHORITY_CHECKPOINT:'/var/lib/qgroup-checkpoint/unified.sqlite3',REBUILD_ERASURE_AUTHORITY_MANIFEST_SHA256:'c'.repeat(64)}:{})}});
it('allows independent immutable web/bot image references without requiring matching versions',()=>{const r=checkRuntimeCompose({services:{web:service('web'),bot:service('bot')}});expect(r.images.web).not.toBe(r.images.bot);expect(r.deploymentPerformed).toBe(false);expect(r.sourceVersions).toBe('check independently');expect(checkRuntimeCompose({services:{web:{...service('web'),mem_limit:'536870912',memswap_limit:'536870912'},bot:service('bot')}}).deploymentPerformed).toBe(false);});
it('rejects mutable image tags, unbounded resources, privilege escalation, extra services and different databases',()=>{
 for(const patch of [{healthcheck:{disable:true}},{image:'qgroup:latest'},{image:'qgroup:main'},{build:{}},{privileged:true},{read_only:false},{init:false},{mem_limit:0},{memswap_limit:-1},{cpus:undefined},{cpus:0},{cpus:2},{pids_limit:0},{user:'0:0'},{cap_add:['SYS_ADMIN']},{security_opt:['no-new-privileges:true','seccomp:unconfined']},{tmpfs:['/tmp']},{volumes:[{type:'bind',source:'/different/data',target:'/var/lib/qgroup'}]},{environment:{KANBAN_DB:'/other.sqlite3'}}])expect(()=>checkRuntimeCompose({services:{web:service('web'),bot:{...service('bot'),...patch}}})).toThrow();
 expect(()=>checkRuntimeCompose({services:{web:service('web'),bot:service('bot'),other:service('web')}})).toThrow();
});

it.each(['missing authority','missing checkpoint','duplicate target','extra mount','writable checkpoint','read-only authority','auto create','source overlap','source same','noncanonical','wrong root','wrong checkpoint','missing pin','mutable pin','development web','development bot'])('rejects %s before candidate services can be started',change=>{
 const web=service('web'),bot=service('bot');
 if(change==='missing authority')web.volumes=web.volumes.filter(m=>m.target!=='/var/lib/qgroup-erasure');
 if(change==='missing checkpoint')web.volumes=web.volumes.filter(m=>m.target!=='/var/lib/qgroup-checkpoint');
 if(change==='duplicate target')web.volumes[1]!.target='/var/lib/qgroup';
 if(change==='extra mount')web.volumes.push({...web.volumes[0]!,target:'/unexpected'});
 if(change==='writable checkpoint')web.volumes[2]!.read_only=false;
 if(change==='read-only authority')web.volumes[1]!.read_only=true;
 if(change==='auto create')web.volumes[1]!.bind.create_host_path=true;
 if(change==='source overlap')web.volumes[1]!.source='/isolated/qgroup/authority';
 if(change==='source same')web.volumes[2]!.source=web.volumes[1]!.source;
 if(change==='noncanonical')web.volumes[1]!.source='/isolated/../authority';
 if(change==='wrong root')web.environment.REBUILD_ERASURE_AUTHORITY_ROOT='/var/lib/qgroup';
 if(change==='wrong checkpoint')web.environment.REBUILD_ERASURE_AUTHORITY_CHECKPOINT='/var/lib/qgroup/kanban.sqlite3';
 if(change==='missing pin')delete web.environment.REBUILD_ERASURE_AUTHORITY_MANIFEST_SHA256;
 if(change==='mutable pin')web.environment.REBUILD_ERASURE_AUTHORITY_MANIFEST_SHA256='latest';
 if(change==='development web')web.environment.NODE_ENV='development';
 if(change==='development bot')bot.environment.NODE_ENV='development';
 expect(()=>checkRuntimeCompose({services:{web,bot}})).toThrow();
});
