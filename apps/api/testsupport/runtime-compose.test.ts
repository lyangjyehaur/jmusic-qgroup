import { it,expect } from 'vitest';
import { checkRuntimeCompose } from '../../../tools/rebuild/check-runtime-compose';
import { runtimeComposeService } from './runtime-compose.fixture';
it.each(['http://127.0.0.1:8791','http://[::1]:8791','http://localhost:8791'])('allows an explicit isolated origin shared by both services: %s',origin=>{
 const web=runtimeComposeService('web'),bot=runtimeComposeService('bot');web.environment.REBUILD_ORIGIN=origin;bot.environment.KANBAN_BOT_BASE_URL=origin;
 expect(checkRuntimeCompose({services:{web,bot}}).origin).toBe(origin);
});
it.each(['missing web','missing bot','different origin','public http','trailing slash','credentials','query','uppercase host'])('rejects unsafe or divergent candidate origin: %s',change=>{
 const web=runtimeComposeService('web'),bot=runtimeComposeService('bot');
 if(change==='missing web')delete web.environment.REBUILD_ORIGIN;
 else if(change==='missing bot')delete bot.environment.KANBAN_BOT_BASE_URL;
 else if(change==='different origin')bot.environment.KANBAN_BOT_BASE_URL='https://other.example';
 else for(const env of [web.environment,bot.environment]){
  const value=change==='public http'?'http://qgroup.example':change==='trailing slash'?'https://qgroup.example/':change==='credentials'?'https://user:secret@qgroup.example':change==='query'?'https://qgroup.example?query=1':'https://QGROUP.example';
  if(env.REBUILD_ORIGIN)env.REBUILD_ORIGIN=value;else env.KANBAN_BOT_BASE_URL=value;
 }
 expect(()=>checkRuntimeCompose({services:{web,bot}})).toThrow();
});
it('allows independent immutable web/bot image references without requiring matching versions',()=>{const r=checkRuntimeCompose({services:{web:runtimeComposeService('web'),bot:runtimeComposeService('bot')}});expect(r.images.web).not.toBe(r.images.bot);expect(r.deploymentPerformed).toBe(false);expect(r.sourceVersions).toBe('check independently');expect(checkRuntimeCompose({services:{web:{...runtimeComposeService('web'),mem_limit:'536870912',memswap_limit:'536870912'},bot:runtimeComposeService('bot')}}).deploymentPerformed).toBe(false);});
it.each(['root','pin','pair'])('refuses an unbound recovery activation %s in the existing runtime manifest validator',shape=>{
 const web=runtimeComposeService('web'),bot=runtimeComposeService('bot');
 if(shape!=='pin')Object.assign(web.environment,{REBUILD_RECOVERY_ACTIVATION_ROOT:'/var/lib/qgroup-checkpoint/activation'});
 if(shape!=='root')Object.assign(web.environment,{REBUILD_RECOVERY_ACTIVATION_MANIFEST_SHA256:'a'.repeat(64)});
 expect(()=>checkRuntimeCompose({services:{web,bot}})).toThrow('separate receipt and fixed-version');
});
it('rejects mutable image tags, unbounded resources, privilege escalation, extra services and different databases',()=>{
 for(const patch of [{healthcheck:{disable:true}},{image:'qgroup:latest'},{image:'qgroup:main'},{build:{}},{privileged:true},{read_only:false},{init:false},{mem_limit:0},{memswap_limit:-1},{cpus:undefined},{cpus:0},{cpus:2},{pids_limit:0},{user:'0:0'},{cap_add:['SYS_ADMIN']},{security_opt:['no-new-privileges:true','seccomp:unconfined']},{tmpfs:['/tmp']},{volumes:[{type:'bind',source:'/different/data',target:'/var/lib/qgroup'}]},{environment:{KANBAN_DB:'/other.sqlite3'}}])expect(()=>checkRuntimeCompose({services:{web:runtimeComposeService('web'),bot:{...runtimeComposeService('bot'),...patch}}})).toThrow();
 expect(()=>checkRuntimeCompose({services:{web:runtimeComposeService('web'),bot:runtimeComposeService('bot'),other:runtimeComposeService('web')}})).toThrow();
});

it.each(['missing authority','missing checkpoint','duplicate target','extra mount','writable checkpoint','read-only authority','auto create','source overlap','source same','noncanonical','wrong root','wrong checkpoint','missing pin','mutable pin','development web','development bot'])('rejects %s before candidate services can be started',change=>{
 const web=runtimeComposeService('web'),bot=runtimeComposeService('bot');
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
