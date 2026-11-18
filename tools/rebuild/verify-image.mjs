import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync,spawnSync } from 'node:child_process';
const args=process.argv.slice(2);
if(args.length!==4||args[0]!=='--image'||!/^sha256:[a-f0-9]{64}$/.test(args[1]??'')||args[2]!=='--commit'||!/^[a-f0-9]{40}$/.test(args[3]??''))throw Error('Use --image <complete local image ID> --commit <complete source SHA>');
const image=args[1],commit=args[3],docker=(...argv)=>execFileSync('docker',argv,{encoding:'utf8',timeout:30000,stdio:['pipe','pipe','pipe']}).trim();
const context=docker('context','show'),endpoint=JSON.parse(docker('context','inspect',context,'--format','{{json .Endpoints.docker.Host}}'));
assert(endpoint.startsWith('unix://'),'Only a local Unix Docker engine may run this rehearsal');
const spec=JSON.parse(docker('image','inspect',image))[0];assert.equal(spec.Id,image);assert.equal(spec.Config.Labels['org.opencontainers.image.revision'],commit);assert.equal(spec.Config.User,'qgroupsvc');
const id='qgroup-rebuild-'+randomUUID(),volume=id+'-data',name=id+'-web';
const limits=['--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--memory','512m','--memory-swap','512m','--cpus','1','--pids-limit','128','--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=64m','--platform','linux/'+spec.Architecture];
let madeVolume=false,started=false;
try{
 docker('volume','create','--label','qgroup.rehearsal=true',volume);madeVolume=true;
 docker('run','--rm',...limits,'--user','0','-v',volume+':/var/lib/qgroup','--entrypoint','node',image,'--input-type=module','-e',"import {openDatabase} from '/app/.rebuild-dist/api/database.mjs';import fs from 'node:fs';const db=openDatabase('/var/lib/qgroup/isolated.sqlite3');db.close();for(const p of ['/var/lib/qgroup','/var/lib/qgroup/isolated.sqlite3'])fs.chownSync(p,994,992);fs.chmodSync('/var/lib/qgroup',0o700)");
 docker('run','-d','--name',name,'--label','qgroup.rehearsal=true','--init','--stop-timeout','15',...limits,'-v',volume+':/var/lib/qgroup','-e','REBUILD_DB=/var/lib/qgroup/isolated.sqlite3','-e','REBUILD_PORT=8791','-e','REBUILD_ORIGIN=http://127.0.0.1:8791',image);started=true;
 const command=(script,...rest)=>docker('exec',name,'node','-e',script,...rest);
 let ready=false;for(let n=0;n<60;n++){
  const r=spawnSync('docker',['exec',name,'node','-e',"fetch('http://127.0.0.1:8791/api/v2/health',{signal:AbortSignal.timeout(1000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],{timeout:3000,stdio:'ignore'});
  if(r.status===0){ready=true;break;}await new Promise(resolve=>setTimeout(resolve,250));
 }assert(ready,'Isolated web failed to become healthy');
 const web=JSON.parse(command("(async()=>{const base='http://127.0.0.1:8791',v=await(await fetch(base+'/api/v2/version')).json(),html=await(await fetch(base+'/activities')).text();let blocked=false;try{require('fs').writeFileSync('/app/should-not-write','x')}catch(e){blocked=['EROFS','EACCES'].includes(e.code)}const Database=require('better-sqlite3'),db=new Database(process.env.REBUILD_DB,{readonly:true});const users=db.prepare('SELECT count(*) AS n FROM users').get().n;db.close();const png=await require('sharp')(Buffer.from('<svg width=\"1\" height=\"1\" xmlns=\"http://www.w3.org/2000/svg\"/>')).png().toBuffer();console.log(JSON.stringify({v,uid:process.getuid(),gid:process.getgid(),blocked,users,react:html.includes('/assets/'),png:png.subarray(1,4).toString()==='PNG',legacy:require('fs').existsSync('/app/server.py')}))})().catch(()=>process.exit(1))"));
 assert.equal(web.v.commit,commit);assert.equal(web.v.source,'rehearsal');assert.equal(web.v.service,'web');assert.equal(web.uid,994);assert.equal(web.gid,992);assert(web.blocked&&web.react&&web.png&&!web.legacy);assert.equal(web.users,0);
 const bot=JSON.parse(docker('exec',name,'node','.rebuild-dist/bot/start.mjs','--version'));assert.equal(bot.commit,commit);assert.equal(bot.service,'bot');assert.equal(bot.source,'rehearsal');
 const health=()=>spawnSync('docker',['exec',name,'node','.rebuild-dist/bot/start.mjs','--check-health'],{timeout:10000,stdio:'ignore'}).status;
 assert.equal(health(),1);command("const fs=require('fs'),dir='/var/lib/qgroup/bot-logs',now=Date.now()/1000;fs.mkdirSync(dir,{mode:0o700});fs.writeFileSync(dir+'/bot-health.json',JSON.stringify({runtime_state:'running',gateway_connected:true,policy_resolved:true,updated_at:now,last_poll:now,last_ack:now,last_ready:now}),{mode:0o600})");assert.equal(health(),0);
 command("const fs=require('fs'),p='/var/lib/qgroup/bot-logs/bot-health.json',h=JSON.parse(fs.readFileSync(p));h.last_poll-=120;fs.writeFileSync(p,JSON.stringify(h))");assert.equal(health(),1);
 const running=JSON.parse(docker('inspect',name))[0];assert(running.HostConfig.ReadonlyRootfs);assert.equal(running.HostConfig.Memory,512*1024*1024);assert.equal(running.HostConfig.MemorySwap,running.HostConfig.Memory);assert.equal(running.HostConfig.PidsLimit,128);assert.equal(running.HostConfig.NetworkMode,'none');
 docker('stop','--time','15',name);const stopped=JSON.parse(docker('inspect',name))[0];assert.equal(stopped.State.ExitCode,0);assert(!stopped.State.OOMKilled);
 process.stdout.write(JSON.stringify({image,commit,architecture:spec.Architecture,web:'native-runtime-passed',bot:'version-and-synthetic-health-passed',network:'none',memoryMiB:512,swapMiB:0,pids:128,rootfs:'read-only',uid:994,gracefulStop:true,releaseEligible:false})+'\n');
}finally{
 if(started)spawnSync('docker',['rm','-f',name],{timeout:30000,stdio:'ignore'});
 if(madeVolume)spawnSync('docker',['volume','rm',volume],{timeout:30000,stdio:'ignore'});
}
