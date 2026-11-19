import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {chmodSync,existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {legacyHistoryFixture} from '../../apps/api/testsupport/legacy-history-fixture';
import {BotOwnership} from '../../apps/bot/src/ownership';
import {erasureJournal} from '../../apps/api/src/erasure-journal';
import {createPairedBackups} from '../../apps/api/src/paired-backups';
import {captureRollbackPackage} from '../migration/capture-rollback-package';
import {inspectCaptureContainer} from '../migration/capture-snapshot';
import {digest} from '../migration/music-codec';
import {rollbackJournalPath,verifyStoppedRollbackServices,type RollbackCaptureInputValue} from '../migration/rollback-capture-boundary';
import {readRollbackPackage} from '../migration/rollback-package';
import {inspectRollbackService,pinRollbackServiceEvidence,type RollbackServiceEvidenceValue} from '../migration/rollback-service-evidence';

/** Explicit integration rehearsal. Every container is created but never started.
 * The scratch image has metadata only and cannot execute an application. No
 * existing container, volume, credential, log or service configuration is read.
 * A labelled archived image is inspected, not certified as a rollback candidate. */
export async function verifyRollbackInspection(socket:string,image:string,commit:string){
  assert.match(image,/^sha256:[a-f0-9]{64}$/);assert.match(commit,/^[a-f0-9]{40}$/);
  assert.equal(resolve(socket),socket);assert.equal(realpathSync(socket),socket);
  const socketIdentity=lstatSync(socket,{bigint:true});assert(socketIdentity.isSocket());
  const assertSocket=()=>{const current=lstatSync(socket,{bigint:true});assert(current.isSocket());assert.equal(current.dev,socketIdentity.dev);assert.equal(current.ino,socketIdentity.ino);assert.equal(realpathSync(socket),socket);};
  const env={...process.env};for(const name of ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH','NODE_OPTIONS'])delete env[name];
  const docker=(...args:string[])=>{assertSocket();const result=execFileSync('docker',['--host','unix://'+socket,...args],{encoding:'utf8',timeout:30000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe'],env}).trim();assertSocket();return result;};
  const imageSpec=JSON.parse(docker('image','inspect','--format','{"Id":{{json .Id}},"Revision":{{json (index .Config.Labels "org.opencontainers.image.revision")}},"Architecture":{{json .Architecture}},"Volumes":{{json (index .Config "Volumes")}}}',image)) as {Id:string;Revision:string;Architecture:string;Volumes:unknown};
  assert.equal(imageSpec.Id,image);assert.equal(imageSpec.Revision,commit);assert(['amd64','arm64'].includes(imageSpec.Architecture));assert(imageSpec.Volumes===null||JSON.stringify(imageSpec.Volumes)==='{}','Refuse implicit image volumes');
  const root=realpathSync(mkdtempSync(join(tmpdir(),'qgroup-inert-inspection-')));chmodSync(root,0o700);
  const runId=randomUUID(),owner='inert-inspection-'+runId,tag='qgroup-inert-inspection:'+runId;
  const resources:{id:string;name:string;cidfile:string}[]=[],checks:string[]=[];
  let built=false,syntheticArchitecture='',fixture:Awaited<ReturnType<typeof legacyHistoryFixture>>|undefined;
  const check=(name:string,run:()=>void)=>{run();checks.push(name);};
  const constraints=['--network','none','--read-only','--memory','64m','--memory-swap','64m','--cpus','1','--pids-limit','16','--cap-drop','ALL','--security-opt','no-new-privileges:true'];
  const create=(source:string,role:string|null,command:string[]|null,extra:string[]=[])=>{
    const name='qgroup-inert-'+runId+'-'+resources.length,cidfile=join(root,'cid-'+resources.length),resource={id:'',name,cidfile};resources.push(resource);
    const id=docker('create','--name',name,'--cidfile',cidfile,'--label','qgroup.rehearsal='+owner,...(role===null?[]:['--label','com.docker.compose.service='+role]),'--platform','linux/'+(source===image?imageSpec.Architecture:syntheticArchitecture),...constraints,...extra,source,...(command??[]));
    assert.match(id,/^[a-f0-9]{64}$/);resource.id=id;assert.equal(readFileSync(cidfile,'utf8').trim(),id);
    const limits=JSON.parse(docker('inspect','--type','container','--format','{"Id":{{json .Id}},"Name":{{json .Name}},"Owner":{{json (index .Config.Labels "qgroup.rehearsal")}},"State":{{json .State.Status}},"Pid":{{json .State.Pid}},"Memory":{{json .HostConfig.Memory}},"Swap":{{json .HostConfig.MemorySwap}},"Cpus":{{json .HostConfig.NanoCpus}},"Pids":{{json .HostConfig.PidsLimit}},"Network":{{json .HostConfig.NetworkMode}},"ReadOnly":{{json .HostConfig.ReadonlyRootfs}},"Capabilities":{{json .HostConfig.CapDrop}},"Security":{{json .HostConfig.SecurityOpt}}}',id));
    assert.equal(limits.Id,id);assert.equal(limits.Name,'/'+name);assert.equal(limits.Owner,owner);assert.equal(limits.State,'created');assert.equal(limits.Pid,0);assert.equal(limits.Memory,64*1024*1024);assert.equal(limits.Swap,limits.Memory);assert.equal(limits.Cpus,1e9);assert.equal(limits.Pids,16);assert.equal(limits.Network,'none');assert.equal(limits.ReadOnly,true);assert.deepEqual(limits.Capabilities,['ALL']);assert(limits.Security.includes('no-new-privileges:true'));
    return id;
  };
  // Deliberately hostile inherited endpoint settings must not change either
  // inspector's explicit local endpoint. The parent process remains unchanged.
  const cli=(id:string,success:boolean)=>{
    const result=spawnSync(process.execPath,['--import','tsx','tools/migration/rollback-service-evidence.ts',id,socket],{encoding:'utf8',timeout:15000,maxBuffer:1024*1024,env:{...env,DOCKER_HOST:'tcp://forbidden.invalid:2376',DOCKER_CONTEXT:'forbidden',DOCKER_TLS_VERIFY:'1',DOCKER_CERT_PATH:join(root,'nonexistent-certs')}});
    assert.equal(result.status,success?0:1);assert(!result.error);assert(!result.signal);
    assert(!result.stdout.includes(root)&&!result.stderr.includes(root));assert(!result.stdout.includes('inactive-secret')&&!result.stderr.includes('inactive-secret'));
    if(success){const resultValue=JSON.parse(result.stdout);assert.equal(resultValue.containerId,id);assert.equal(resultValue.releaseSourceCertified,false);assert.equal(resultValue.state,'created');return resultValue as {commit:string|null};}
    assert.equal(result.stdout,'');assert.match(result.stderr,/inspection rejected/);return null;
  };
  const inspect=(id:string)=>{assertSocket();const result=inspectRollbackService(id,socket);assertSocket();assert.equal(result.Id,id);assert.equal(result.State.Status,'created');assert.equal(result.State.Pid,0);assert.equal(result.State.Running,false);return result;};
  try{
    const context=join(root,'context');mkdirSync(context,{mode:0o700});writeFileSync(join(context,'Dockerfile'),'FROM scratch\nWORKDIR /app\nCMD ["never-run"]\n',{mode:0o600});
    // No RUN, COPY, credentials, app source, network, pull or runtime execution.
    docker('build','--network','none','--pull=false','--label','qgroup.rehearsal='+owner,'--tag',tag,context);built=true;
    const syntheticImage=docker('image','inspect','--format','{{.Id}}',tag);assert.match(syntheticImage,/^sha256:[a-f0-9]{64}$/);syntheticArchitecture=docker('image','inspect','--format','{{.Architecture}}',tag);assert(['amd64','arm64'].includes(syntheticArchitecture));
    fixture=await legacyHistoryFixture();const s=fixture,data=dirname(s.db.name),logs=join(data,'bot-logs'),words=join(data,'sensitive-words.json');
    mkdirSync(logs,{mode:0o700});writeFileSync(join(logs,'bot-group-state.json'),'{"push_authorized":false,"code":40034105}',{mode:0o600});writeFileSync(words,'["合成詞"]',{mode:0o600});
    const journal=rollbackJournalPath(s.db.name);writeFileSync(journal,'\n {"user_id":"synthetic-erased","request_id":"synthetic-deletion","created_at":"before"}\n',{mode:0o600});s.db.prepare("INSERT INTO erasure_applied VALUES('synthetic-deletion')").run();
    for(const [i,status] of ['pending','sending','sent','failed','skipped'].entries())s.db.prepare("INSERT INTO bot_outbox(event_id,kind,dedupe_key,target,payload_json,status,attempts,claim_token,retry_at,simulated_at,delivered_payload_json,created_at) VALUES('listen','synthetic',?,'synthetic','{}',?,2,?,?,?,?, 'after')").run('inert-'+i,status,status==='sending'?'inactive-secret-claim':'',status==='failed'?'original-retry':null,status==='skipped'?'original-simulation':null,status==='sent'?'frozen-private-body':null);
    const now=new Date('2026-11-19T09:00:00Z'),backup=createPairedBackups(s.db,erasureJournal(s.db),()=>now)!.capture();const ownerLock=new BotOwnership(s.db.name);ownerLock.close();
    const mounts=['--mount','type=bind,source='+data+',target=/data','--mount','type=bind,source='+s.capture+',target=/legacy'];
    const settings=['-e','NODE_ENV=production','-e','REBUILD_DB=/data/unified.sqlite3','-e','KANBAN_DB=/data/unified.sqlite3','-e','KANBAN_BOT_LOG_DIR=/data/bot-logs','-e','KANBAN_BOT_SENSITIVE_WORDS_FILE=/data/sensitive-words.json'];
    const web=create(image,'web',null,[...mounts,...settings,'-e','REBUILD_LEGACY_HISTORY_ROOT=/legacy','-e','REBUILD_LEGACY_HISTORY_MANIFEST_SHA256='+s.config.manifestSha256]);
    const bot=create(image,'bot',['node','.rebuild-dist/bot/start.mjs'],[...mounts,...settings]);
    const webEvidence=inspect(web),botEvidence=inspect(bot);
    check('archived-native-api-metadata',()=>{assert.equal(webEvidence.Runtime,'native-api');assert.equal(webEvidence.Revision,commit);cli(web,true);});
    check('archived-native-bot-metadata',()=>{assert.equal(botEvidence.Runtime,'native-bot');assert.equal(botEvidence.Revision,commit);cli(bot,true);});
    const input:RollbackCaptureInputValue={database:s.db.name,expectedLineageId:(s.db.prepare('SELECT lineage_id FROM rebuild_storage WHERE id=1').get() as {lineage_id:string}).lineage_id,bot:{logDirectory:logs,sensitiveWordsFile:words},history:{capture:s.config,native:{root:join(data,'paired-backups'),manifests:[{id:backup.id,sha256:digest(readFileSync(join(data,'paired-backups',backup.id,'manifest.json')))}]}},destination:join(s.root,'actual-inert-package'),dockerSocket:socket,services:[webEvidence,botEvidence].map(row=>({role:row.Service as 'web'|'bot',runtime:'typescript',containerId:row.Id,imageId:row.Image,commit:row.Revision!,evidenceSha256:pinRollbackServiceEvidence(row)}))};
    const observed=(row:RollbackServiceEvidenceValue)=>[{role:'web' as const,evidence:webEvidence},{role:'bot' as const,evidence:row}];
    const declaredCommit='a'.repeat(40),python=create(syntheticImage,'bot',['python3','-m','qgroup_bot.main'],[...mounts,...settings,'--label','org.opencontainers.image.revision='+declaredCommit]);
    check('python-command-go-template',()=>{const row=inspect(python);assert.equal(row.Runtime,'python-bot');assert.equal(row.Revision,declaredCommit);cli(python,true);});
    const unlabelled=create(syntheticImage,'bot',['python3','-m','qgroup_bot.main'],[...mounts,...settings]),unlabelledEvidence=inspect(unlabelled);
    check('absent-python-revision-preserved',()=>{assert.equal(unlabelledEvidence.Revision,null);assert.equal(unlabelledEvidence.Runtime,'python-bot');assert.equal(cli(unlabelled,true)!.commit,null);});
    const pythonInput=structuredClone(input);pythonInput.services[1]={role:'bot',runtime:'python',containerId:unlabelled,imageId:syntheticImage,commit:declaredCommit,evidenceSha256:pinRollbackServiceEvidence(unlabelledEvidence)};
    check('absent-revision-requires-external-reference',()=>{assert.throws(()=>verifyStoppedRollbackServices(pythonInput,observed(unlabelledEvidence)));pythonInput.services[1]!.commitRecordSha256='b'.repeat(64);verifyStoppedRollbackServices(pythonInput,observed(unlabelledEvidence));});
    for(const revision of ['', 'not-a-commit']){
      const id=create(syntheticImage,'bot',['python3','-m','qgroup_bot.main'],['--label','org.opencontainers.image.revision='+revision]);
      check(revision?'malformed-revision-rejected':'empty-revision-not-absent',()=>{assert.equal(inspect(id).Revision,revision);cli(id,false);});
    }
    const rejectedCommands:[string,string[],string[]][]=[['extra-command-argument',['node','.rebuild-dist/bot/start.mjs','--version'],[]],['shell-command-wrapper',['sh','-c','node .rebuild-dist/bot/start.mjs'],[]],['foreign-working-directory',['python3','-m','qgroup_bot.main'],['--workdir','/unrelated']],['foreign-entrypoint',['python3','-m','qgroup_bot.main'],['--entrypoint','unrelated-wrapper']]];
    for(const [name,command,extra] of rejectedCommands){const id=create(syntheticImage,'bot',command,['--label','org.opencontainers.image.revision='+declaredCommit,...extra]);check(name,()=>{assert.equal(inspect(id).Runtime,'unknown');cli(id,false);});}
    const standardEntrypoint=create(syntheticImage,'bot',['node','.rebuild-dist/bot/start.mjs'],['--entrypoint','docker-entrypoint.sh','--label','org.opencontainers.image.revision='+declaredCommit,'-e','NODE_ENV=production']);
    check('known-node-entrypoint-shape',()=>{assert.equal(inspect(standardEntrypoint).Runtime,'native-bot');cli(standardEntrypoint,true);});
    for(const options of ['', '--require /inactive-secret']){const id=create(image,'bot',['node','.rebuild-dist/bot/start.mjs'],['-e','NODE_OPTIONS='+options]);check(options?'node-options-rejected':'empty-node-options-accepted',()=>{assert.equal(inspect(id).NodeOptionsConfigured,Boolean(options));cli(id,!options);});}
    const development=create(image,'web',null,['-e','NODE_ENV=development']);check('development-runtime-rejected',()=>{assert.equal(inspect(development).EnvironmentMode,'development');cli(development,false);});
    const missingRole=create(syntheticImage,null,['python3','-m','qgroup_bot.main']);check('missing-role-rejected',()=>{assert.throws(()=>inspect(missingRole));cli(missingRole,false);});
    const equals=create(syntheticImage,'bot',['python3','-m','qgroup_bot.main'],[...mounts,...settings,'--label','org.opencontainers.image.revision='+declaredCommit,'-e','KANBAN_DB=/data/unified=fixture.sqlite3','-e','REBUILD_DB=/data/unified=fixture.sqlite3','-e','JPM_DATA=/legacy/music=data.json','-e','KANBAN_BOT_LOG_DIR=/data/logs=fixture','-e','KANBAN_BOT_ENV=/data/override=inactive.env','-e','QQBOT_APP_SECRET=inactive-secret','-e','PREFIX_KANBAN_DB=inactive-secret']);
    const equalsEvidence=inspect(equals);
    check('rollback-environment-preserves-equals',()=>{assert.equal(equalsEvidence.WebDatabase,'/data/unified=fixture.sqlite3');assert.equal(equalsEvidence.BotDatabase,'/data/unified=fixture.sqlite3');assert.equal(equalsEvidence.BotLogDirectory,'/data/logs=fixture');assert.equal(equalsEvidence.BotEnvironmentFile,'/data/override=inactive.env');assert(!JSON.stringify(equalsEvidence).includes('inactive-secret'));});
    check('original-capture-environment-preserves-equals',()=>{const row=inspectCaptureContainer(equals,socket);assert.equal(row.Id,equals);assert.equal(row.BoardDatabase,'/data/unified=fixture.sqlite3');assert.equal(row.MusicData,'/legacy/music=data.json');assert.equal(row.BotLogDir,'/data/logs=fixture');assert(!JSON.stringify(row).includes('inactive-secret'));});
    const override=structuredClone(equalsEvidence);override.BotDatabase=botEvidence.BotDatabase;override.BotLogDirectory=botEvidence.BotLogDirectory;
    const overrideInput=structuredClone(pythonInput);overrideInput.services[1]={role:'bot',runtime:'python',containerId:override.Id,imageId:override.Image,commit:override.Revision!,evidenceSha256:pinRollbackServiceEvidence(override)};
    check('bot-file-override-remains-blocked',()=>assert.throws(()=>verifyStoppedRollbackServices(overrideInput,observed(override)),/effective configuration/));
    const shadowPath=join(s.root,'synthetic-shadow.sqlite3');writeFileSync(shadowPath,'inert-shadow-only',{mode:0o600});
    const shadow=create(image,'bot',['node','.rebuild-dist/bot/start.mjs'],[...mounts,...settings,'--mount','type=bind,source='+shadowPath+',target=/data/unified.sqlite3']),shadowEvidence=inspect(shadow),shadowInput=structuredClone(input);
    shadowInput.services[1]={role:'bot',runtime:'typescript',containerId:shadow,imageId:shadowEvidence.Image,commit:shadowEvidence.Revision!,evidenceSha256:pinRollbackServiceEvidence(shadowEvidence)};
    check('actual-file-shadow-mount-rejected',()=>assert.throws(()=>verifyStoppedRollbackServices(shadowInput,observed(shadowEvidence)),/database bind differs/));
    const raw=Buffer.from(JSON.stringify(input)+'\n'),before=s.db.serialize();let probes=0;
    const saved=captureRollbackPackage(raw,digest(raw),now,{assertInputUnchanged(){
      probes++;const output=execFileSync('python3',['-I','-c',"import sqlite3,sys\nfor path in sys.argv[1:]:\n db=sqlite3.connect(path,timeout=0)\n try:db.execute('BEGIN EXCLUSIVE');raise AssertionError('Lock absent')\n except sqlite3.OperationalError:print('blocked')\n finally:db.close()",s.db.name,join(data,'.bot-owner.sqlite3')],{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe']});assert.equal(output,'blocked\nblocked\n');
    }});
    const read=readRollbackPackage(input.destination,saved.manifestSha256);assert.equal(read.version,3);if(read.version!==3)throw Error('Expected v3');
    check('actual-docker-held-capture-and-fixed-reader',()=>{assert.equal(saved.rollbackEligible,false);assert.equal(probes,5);assert.deepEqual(read.boundary.services,observed(botEvidence));assert.deepEqual(read.captureInput,raw);assert.equal(read.boundary.coordination.deployment,'not-coordinated');assert.equal(read.boundary.coordination.retention,'source-fence-only');});
    check('actual-capture-source-and-all-outbox-states-preserved',()=>{const after=s.db.serialize();before[18]=1;before[19]=1;after[18]=1;after[19]=1;assert.deepEqual(after,before);assert.deepEqual(read.sourceJournal,readFileSync(journal));assert.equal(read.report.rollbackEligible,false);assert(read.report.remaining.includes('actual_candidate_version_pair'));assert.deepEqual(inspect(web),webEvidence);assert.deepEqual(inspect(bot),botEvidence);read.assertUnchanged();});
    pythonInput.destination=join(s.root,'actual-inert-python-package');const pythonRaw=Buffer.from(JSON.stringify(pythonInput)+'\n'),pythonSaved=captureRollbackPackage(pythonRaw,digest(pythonRaw),now),pythonRead=readRollbackPackage(pythonInput.destination,pythonSaved.manifestSha256);
    check('actual-unlabelled-python-capture-reference-retained',()=>{assert.equal(pythonRead.version,3);if(pythonRead.version!==3)throw Error('Expected v3');assert.deepEqual(pythonRead.boundary.services,observed(unlabelledEvidence));assert.equal(pythonRead.boundary.services[1]!.evidence.Revision,null);assert.deepEqual(pythonRead.captureInput,pythonRaw);assert.equal(pythonRead.report.rollbackEligible,false);assert(pythonRead.report.remaining.includes('actual_candidate_version_pair'));pythonRead.assertUnchanged();});
    // Observe every owned object again before cleanup. No started/exited
    // container is acceptable evidence for this create-only rehearsal.
    for(const resource of resources){const state=docker('inspect','--type','container','--format','{{.State.Status}}',resource.id);assert.equal(state,'created');}
    return {status:'inert-docker-inspection-passed' as const,image,commit,containers:resources.length,checks:checks.length,checkNames:checks,lockProbes:probes,containerExecution:false,realQQ:false,releaseSourceCertified:false,rollbackEligible:false};
  }finally{
    let cleanupFailed=false;
    // Exact own IDs/names/labels only. No force, stop, start, exec, prune,
    // volume, existing service enumeration or candidate image removal.
    for(const resource of [...resources].reverse())try{
      const id=resource.id||(existsSync(resource.cidfile)?readFileSync(resource.cidfile,'utf8').trim():'');assert.match(id,/^[a-f0-9]{64}$/);
      const own=JSON.parse(docker('inspect','--type','container','--format','{"Id":{{json .Id}},"Name":{{json .Name}},"Owner":{{json (index .Config.Labels "qgroup.rehearsal")}},"State":{{json .State.Status}}}',id));
      assert.equal(own.Id,id);assert.equal(own.Name,'/'+resource.name);assert.equal(own.Owner,owner);assert.equal(own.State,'created');docker('rm',id);
    }catch{cleanupFailed=true;}
    if(built)try{assert.equal(docker('image','inspect','--format','{{index .Config.Labels "qgroup.rehearsal"}}',tag),owner);docker('image','rm',tag);}catch{cleanupFailed=true;}
    if(cleanupFailed){fixture?.db.close();throw Error('Inert rehearsal cleanup incomplete; preserve its private fixtures');}
    fixture?.close();rmSync(root,{recursive:true});
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const args=process.argv.slice(2);
  if(args.length!==6||args[0]!=='--socket'||args[2]!=='--image'||args[4]!=='--commit'){
    process.stderr.write('Usage: npm run verify:rollback-inspection -- --socket <canonical-local-socket> --image <complete-image-ID> --commit <complete-SHA>\n');process.exitCode=1;
  }else try{process.stdout.write(JSON.stringify(await verifyRollbackInspection(args[1]!,args[3]!,args[5]!))+'\n');}
  catch{process.stderr.write('Inert rollback inspection rejected. No container was started or stopped; preserve any private incomplete fixtures.\n');process.exitCode=1;}
}
