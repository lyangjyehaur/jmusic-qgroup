import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync,spawnSync } from 'node:child_process';
const args=process.argv.slice(2);
if(args.length!==4||args[0]!=='--image'||!/^sha256:[a-f0-9]{64}$/.test(args[1]??'')||args[2]!=='--commit'||!/^[a-f0-9]{40}$/.test(args[3]??''))throw Error('Use --image <complete local image ID> --commit <complete source SHA>');
const image=args[1],commit=args[3],docker=(...argv)=>execFileSync('docker',argv,{encoding:'utf8',timeout:30000,stdio:['pipe','pipe','pipe']}).trim();
const context=docker('context','show'),endpoint=JSON.parse(docker('context','inspect',context,'--format','{{json .Endpoints.docker.Host}}'));
assert(endpoint.startsWith('unix://'),'Only a local Unix Docker engine may run this rehearsal');
const spec=JSON.parse(docker('image','inspect',image))[0];assert.equal(spec.Id,image);assert.equal(spec.Config.Labels['org.opencontainers.image.revision'],commit);assert.equal(spec.Config.User,'qgroupsvc');
const id='qgroup-rebuild-'+randomUUID(),volume=id+'-data',authorityVolume=id+'-authority',checkpointVolume=id+'-checkpoint',name=id+'-web';
const limits=['--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--memory','512m','--memory-swap','512m','--cpus','1','--pids-limit','128','--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=64m','--platform','linux/'+spec.Architecture];
// Synthetic empty storage only; the image owns all three new private roots.
// Export no source data and never prepare an authority from an existing DB.
const emptyAuthorityScript=String.raw`
import fs from 'node:fs';import path from 'node:path';import Database from 'better-sqlite3';import {createHash,randomBytes} from 'node:crypto';import {openDatabase} from './.rebuild-dist/api/database.mjs';
const [database,authority,checkpoint]=process.argv.slice(1),roots=[path.dirname(database),authority,checkpoint],digest=b=>createHash('sha256').update(b).digest('hex');
if(roots.length!==3||roots.some(p=>!path.isAbsolute(p)||path.resolve(p)!==p)||new Set(roots).size!==3)throw Error('Explicit synthetic fixture roots required');
for(const [i,p] of roots.entries()){const stat=fs.lstatSync(p);if(!stat.isDirectory()||fs.realpathSync(p)!==p||stat.uid!==process.getuid()||(stat.mode&0o7777)!==0o700||fs.readdirSync(p).length)throw Error('Synthetic fixture root must already be private and empty');for(const other of roots.slice(i+1))if(p.startsWith(other+'/')||other.startsWith(p+'/'))throw Error('Fixture roots overlap');}
const checkpointPath=path.join(checkpoint,'unified.sqlite3'),db=openDatabase(database);try{await db.backup(checkpointPath);}finally{db.close();}const fixed=new Database(checkpointPath);try{fixed.pragma('journal_mode = DELETE');}finally{fixed.close();}fs.chmodSync(checkpointPath,0o600);const bytes=fs.readFileSync(checkpointPath),write=(p,b)=>fs.writeFileSync(p,b,{flag:'wx',mode:0o600}),encode=v=>Buffer.from(JSON.stringify(v)+'\n');
write(database.replace(/\.[^/.]+$/,'')+'.erasures.jsonl','');fs.mkdirSync(path.join(authority,'baseline'),{mode:0o700});fs.mkdirSync(path.join(authority,'records'),{mode:0o700});
const domains=['board','music','unified'],baseline=domains.map(domain=>({domain,path:'baseline/'+domain+'.erasures.jsonl',size:0,sha256:digest('')}));
for(const row of baseline)write(path.join(authority,row.path),'');write(path.join(authority,'.authority.lock'),'');
const manifest={version:1,kind:'qgroup-private-erasure-authority',authorityId:randomBytes(16).toString('hex'),createdAt:new Date().toISOString(),sourcePackageSha256:digest('synthetic-empty-image-fixture'),checkpointSha256:digest(bytes),journalSha256:digest('[]'),baseline,rollbackEligible:false},raw=encode(manifest),pin=digest(raw);
write(path.join(authority,'authority-manifest.json'),raw);write(path.join(authority,'authority-head.json'),encode({version:1,authoritySha256:pin,sequence:0,recordSha256:null,ledgers:Object.fromEntries(baseline.map(row=>[row.domain,{size:row.size,sha256:row.sha256}]))}));
console.log(JSON.stringify({manifestSha256:pin,checkpointSha256:manifest.checkpointSha256,uid:process.getuid(),gid:process.getgid(),synthetic:true}));
`;
const madeVolumes=[];let attemptedContainer=false,result,failure;
try{
 for(const v of [volume,authorityVolume,checkpointVolume]){docker('volume','create','--label','qgroup.rehearsal=true',v);madeVolumes.push(v);}
 // Docker populates this new volume from the image's service-owned data
 // directory. Initialize the fixture as that same user; no root or CHOWN
 // capability is needed, and every database sidecar keeps service ownership.
 const fixture=JSON.parse(docker('run','--rm',...limits,'-v',volume+':/var/lib/qgroup','-v',authorityVolume+':/var/lib/qgroup-erasure','-v',checkpointVolume+':/var/lib/qgroup-checkpoint','--entrypoint','node',image,'--input-type=module','-e',emptyAuthorityScript,'/var/lib/qgroup/isolated.sqlite3','/var/lib/qgroup-erasure','/var/lib/qgroup-checkpoint'));
 assert(fixture.synthetic&&fixture.uid===994&&fixture.gid===992&&/^[a-f0-9]{64}$/.test(fixture.manifestSha256));
 attemptedContainer=true;
 docker('run','-d','--name',name,'--label','qgroup.rehearsal=true','--init','--stop-timeout','15',...limits,'-v',volume+':/var/lib/qgroup','-v',authorityVolume+':/var/lib/qgroup-erasure','-v',checkpointVolume+':/var/lib/qgroup-checkpoint:ro','-e','REBUILD_DB=/var/lib/qgroup/isolated.sqlite3','-e','REBUILD_ERASURE_AUTHORITY_ROOT=/var/lib/qgroup-erasure','-e','REBUILD_ERASURE_AUTHORITY_MANIFEST_SHA256='+fixture.manifestSha256,'-e','REBUILD_ERASURE_AUTHORITY_CHECKPOINT=/var/lib/qgroup-checkpoint/unified.sqlite3','-e','REBUILD_PORT=8791','-e','REBUILD_ORIGIN=http://127.0.0.1:8791',image);
 const command=(script,...rest)=>docker('exec',name,'node','-e',script,...rest);
 let ready=false;for(let n=0;n<60;n++){
  const r=spawnSync('docker',['exec',name,'node','-e',"fetch('http://127.0.0.1:8791/api/v2/health',{signal:AbortSignal.timeout(1000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],{timeout:3000,stdio:'ignore'});
  if(r.status===0){ready=true;break;}await new Promise(resolve=>setTimeout(resolve,250));
 }assert(ready,'Isolated web failed to become healthy');
 const web=JSON.parse(command("(async()=>{const base='http://127.0.0.1:8791',v=await(await fetch(base+'/api/v2/version')).json(),html=await(await fetch(base+'/activities')).text();let blocked=false;try{require('fs').writeFileSync('/app/should-not-write','x')}catch(e){blocked=['EROFS','EACCES'].includes(e.code)}const Database=require('better-sqlite3'),db=new Database(process.env.REBUILD_DB,{readonly:true});const users=db.prepare('SELECT count(*) AS n FROM users').get().n,schema=db.prepare('SELECT version FROM rebuild_schema').get().version,consents=db.prepare('SELECT count(*) AS n FROM unified_privacy_consents').get().n,receipts=db.prepare('SELECT count(*) AS n FROM unified_privacy_receipts').get().n;db.close();const png=await require('sharp')(Buffer.from('<svg width=\"1\" height=\"1\" xmlns=\"http://www.w3.org/2000/svg\"/>')).png().toBuffer();console.log(JSON.stringify({v,uid:process.getuid(),gid:process.getgid(),blocked,users,schema,consents,receipts,react:html.includes('/assets/'),png:png.subarray(1,4).toString()==='PNG',legacy:require('fs').existsSync('/app/server.py')}))})().catch(error=>{console.error(error);process.exit(1)})"));
 const retained=JSON.parse(command("const fs=require('fs'),cp=require('child_process'),crypto=require('crypto');let blocked=false;try{fs.writeFileSync(process.env.REBUILD_ERASURE_AUTHORITY_CHECKPOINT,'x')}catch(e){blocked=e.code==='EROFS'}const rival=cp.spawnSync('/usr/bin/flock',['--exclusive','--nonblock','/var/lib/qgroup-erasure/.authority.lock','true'],{timeout:3000}),checkpoint=crypto.createHash('sha256').update(fs.readFileSync(process.env.REBUILD_ERASURE_AUTHORITY_CHECKPOINT)).digest('hex');console.log(JSON.stringify({checkpointReadOnly:blocked,rivalStatus:rival.status,checkpoint}))"));
 assert(retained.checkpointReadOnly);assert.equal(retained.rivalStatus,1);assert.equal(retained.checkpoint,fixture.checkpointSha256);
 assert.equal(web.v.commit,commit);assert.equal(web.v.source,'rehearsal');assert.equal(web.v.service,'web');assert.equal(web.uid,994);assert.equal(web.gid,992);assert(web.blocked&&web.react&&web.png&&!web.legacy);assert.equal(web.users,0);assert.equal(web.schema,15);assert.equal(web.consents,0);assert.equal(web.receipts,0);
 const sourceArchive=JSON.parse(command(`(async()=>{const m=await import('/app/.rebuild-dist/api/database.mjs'),db=m.openDatabase(':memory:');try{
   db.prepare('INSERT INTO music_documents VALUES(?,?,?)').run('profile_source',0,JSON.stringify({profileId:'synthetic-profile',legacyKey:'10000',source:'json',member:{name:'private-source',pinHash:'inactive-proof'}}));
   db.prepare('INSERT INTO music_documents VALUES(?,?,?)').run('profile_source',1,JSON.stringify({profileId:'synthetic-other',legacyKey:'10001',source:'json',member:{name:'source-keep',boardUserId:'synthetic-closed',selection:['original-choice'],pinHash:'separate-music'}}));
   db.prepare('INSERT INTO music_documents VALUES(?,?,?)').run('entry_source',0,JSON.stringify({entryId:'synthetic-term',entry:{text:'original-term',aliases:['original-alias'],createdBy:'synthetic-profile'}}));
   db.prepare("INSERT INTO migration_map VALUES('music','profile','10002','synthetic-old','','source-digest','preserved')").run();
   db.prepare('INSERT INTO music_documents VALUES(?,?,?)').run('entry_source',1,JSON.stringify({entryId:'synthetic-old-term',entry:{createdBy:'10002'}}));
   db.prepare('INSERT INTO music_legacy_identity VALUES(?,?,?)').run('sessions',0,JSON.stringify({qq:'10002',token_hash:'inactive-old-proof'}));
   m.detachLegacyAccount(db,'synthetic-closed');m.eraseLegacyProfile(db,'synthetic-profile','synthetic-stamp');m.eraseLegacyProfile(db,'synthetic-profile','synthetic-stamp');
   m.eraseLegacyProfile(db,'synthetic-old','synthetic-stamp');
   const docs=db.prepare('SELECT kind,payload_json FROM music_documents').all(),profile=JSON.parse(docs.find(row=>row.kind==='profile_source').payload_json),term=JSON.parse(docs.find(row=>row.kind==='entry_source').payload_json);
   const old=JSON.parse(docs.filter(row=>row.kind==='entry_source')[1].payload_json),proofs=db.prepare('SELECT count(*) n FROM music_legacy_identity').get().n;
   console.log(JSON.stringify({rows:docs.length,erased:profile.profileId==='synthetic-other',closed:profile.member.boardUserId===''&&profile.member.name==='source-keep'&&profile.member.pinHash==='separate-music'&&profile.member.selection[0]==='original-choice',creator:term.entry.createdBy===''&&term.entry.text==='original-term'&&term.entry.aliases[0]==='original-alias',orphan:old.entry.createdBy===''&&proofs===0&&db.prepare("SELECT status FROM migration_map WHERE source='music'").get().status==='erased'}));
 }finally{db.close()}})().catch(error=>{console.error(error);process.exit(1)})`));
 assert.equal(sourceArchive.rows,3);assert(sourceArchive.erased&&sourceArchive.closed&&sourceArchive.creator&&sourceArchive.orphan);
 const languages=JSON.parse(command("(async()=>{const rows=[];for(const header of ['zh-CN','zh-Hant-CN','en-US,zh-CN;q=0.9'])for(const path of ['/activities','/guide','/guide.html','/privacy'])for(const method of ['GET','HEAD']){const response=await fetch('http://127.0.0.1:8791'+path,{method,headers:{'Accept-Language':header}}),html=await response.text();rows.push({header,path,method,status:response.status,language:response.headers.get('content-language'),vary:response.headers.get('vary'),cache:response.headers.get('cache-control'),cookie:response.headers.get('set-cookie'),html:method==='HEAD'?html:html.match(/<html lang=\"([^\"]+)\"/)[1]})}if(!require('fs').readdirSync('/app/.rebuild-dist/web/assets').some(name=>/^guide-.*\\.js$/.test(name)))throw Error('Missing handbook bundle');console.log(JSON.stringify(rows))})().catch(error=>{console.error(error);process.exit(1)})"));
 assert.equal(languages.length,24);for(const row of languages){assert.equal(row.status,200);assert.equal(row.language,row.header==='zh-CN'?'zh-Hans':'zh-Hant');assert.equal(row.html,row.method==='HEAD'?'':row.language);assert.equal(row.vary,'Accept-Language');assert.equal(row.cache,'no-store');assert.equal(row.cookie,null);}
 const failures=JSON.parse(command("(async()=>{const rows=[];for(const header of ['zh-CN','zh-Hant-CN'])for(const path of ['/api/v2/activities/synthetic-missing','/api/v2/activities?period=invalid']){const response=await fetch('http://127.0.0.1:8791'+path,{headers:{'Accept-Language':header}});rows.push({path,status:response.status,cookie:response.headers.get('set-cookie'),body:await response.json()})}console.log(JSON.stringify(rows))})().catch(error=>{console.error(error);process.exit(1)})"));
 assert.equal(failures.length,4);for(const row of failures){assert.equal(row.cookie,null);if(row.path.includes('?')){assert.equal(row.status,400);assert.deepEqual(row.body,{code:'INVALID_INPUT',message:'輸入格式不符，請檢查欄位與確認項目',messageDisplay:{hans:'输入格式不符，请检查栏位与确认项目',hant:'輸入格式不符，請檢查欄位與確認項目'}});}else{assert.equal(row.status,404);assert.deepEqual(row.body,{code:'NOT_FOUND',message:'找不到活動或尚未公開',messageDisplay:{hans:'找不到活动或尚未公开',hant:'找不到活動或尚未公開'}});}}
 const bot=JSON.parse(docker('exec',name,'node','.rebuild-dist/bot/start.mjs','--version'));assert.equal(bot.commit,commit);assert.equal(bot.service,'bot');assert.equal(bot.source,'rehearsal');
 const health=()=>spawnSync('docker',['exec',name,'node','.rebuild-dist/bot/start.mjs','--check-health'],{timeout:10000,stdio:'ignore'}).status;
 assert.equal(health(),1);command("const fs=require('fs'),dir='/var/lib/qgroup/bot-logs',now=Date.now()/1000;fs.mkdirSync(dir,{mode:0o700});fs.writeFileSync(dir+'/bot-health.json',JSON.stringify({runtime_state:'running',gateway_connected:true,policy_resolved:true,updated_at:now,last_poll:now,last_ack:now,last_ready:now}),{mode:0o600})");assert.equal(health(),0);
 command("const fs=require('fs'),p='/var/lib/qgroup/bot-logs/bot-health.json',h=JSON.parse(fs.readFileSync(p));h.last_poll-=120;fs.writeFileSync(p,JSON.stringify(h))");assert.equal(health(),1);
 const running=JSON.parse(docker('inspect',name))[0];assert(running.HostConfig.ReadonlyRootfs);assert.equal(running.HostConfig.Memory,512*1024*1024);assert.equal(running.HostConfig.MemorySwap,running.HostConfig.Memory);assert.equal(running.HostConfig.NanoCpus,1e9);assert.equal(running.HostConfig.PidsLimit,128);assert.equal(running.HostConfig.NetworkMode,'none');assert.equal(running.Mounts.find(m=>m.Destination==='/var/lib/qgroup-checkpoint')?.RW,false);assert.equal(running.Mounts.find(m=>m.Destination==='/var/lib/qgroup-erasure')?.RW,true);assert.deepEqual(running.HostConfig.CapDrop,['ALL']);assert(running.HostConfig.SecurityOpt.includes('no-new-privileges:true'));
 assert.equal(command("console.log(['/usr/bin/python3','/app/node_modules/tsx','/app/node_modules/typescript'].some(p=>require('fs').existsSync(p)))"),'false');
 docker('stop','--time','15',name);const stopped=JSON.parse(docker('inspect',name))[0];assert.equal(stopped.State.ExitCode,0);assert(!stopped.State.OOMKilled);docker('run','--rm',...limits,'-v',authorityVolume+':/var/lib/qgroup-erasure','--entrypoint','/usr/bin/flock',image,'--exclusive','--nonblock','/var/lib/qgroup-erasure/.authority.lock','true');
 result={image,commit,architecture:spec.Architecture,web:'native-runtime-passed',retainedAuthority:'empty-fixture-startup-lock-checkpoint-passed',realErasurePerformed:false,schema:web.schema,publicShellChecks:languages.length,errorDisplayChecks:failures.length,sourceArchiveChecks:4,bot:'version-and-synthetic-health-passed',network:'none',memoryMiB:512,swapMiB:0,pids:128,rootfs:'read-only',uid:994,gracefulStop:true,releaseEligible:false};
}catch(error){
 failure=error;
 // This exact container has only fresh empty synthetic volumes and no external
 // network or credentials. Preserve its own startup diagnostics before cleanup.
 if(attemptedContainer){
  const log=spawnSync('docker',['logs','--tail','100',name],{timeout:10000,encoding:'utf8'});
  process.stderr.write('Isolated image diagnostics:\n'+(log.stdout??'').slice(-16384)+(log.stderr??'').slice(-16384));
 }
 throw error;
}finally{
 const cleanupErrors=[];
 if(attemptedContainer){
  // A successful inventory query distinguishes absence from an engine error.
  try{
   const inventory=()=>docker('container','ls','--all','--filter','name=^/'+name+'$','--format','{{.ID}}');
   if(inventory())docker('rm','-f',name);
   assert.equal(inventory(),'','Owned image container remains after cleanup');
  }catch(error){cleanupErrors.push(error);}
 }
 for(const v of madeVolumes.reverse())try{docker('volume','rm',v);}catch(error){cleanupErrors.push(error);}
 if(cleanupErrors.length)throw new AggregateError([...(failure?[failure]:[]),...cleanupErrors],
   'Isolated image cleanup did not complete');
}
process.stdout.write(JSON.stringify({...result,cleanupVerified:true})+'\n');
