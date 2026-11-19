import * as fs from 'node:fs';
import {dirname,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {afterEach,expect,it} from 'vitest';
import {legacyHistoryFixture} from '../testsupport/legacy-history-fixture';
import {createApp,hash} from './app';
import {createPrivacy} from './privacy';
import {erasureJournal,erasureJournalPath,type ErasureIntent} from './erasure-journal';
import {createRetainedErasureJournal,type RetainedJournal} from './retained-erasure-journal';
import {acquireInheritedAuthorityLock,acquireErasureAuthorityLock} from './erasure-authority-lock';
import {readRollbackErasureAuthority,writeRollbackErasureAuthority} from '../../../tools/migration/rollback-erasure-authority';
import {captureRollbackMedia} from '../../../tools/migration/rollback-media';
import {projectRollbackStateFromCheckpoint} from '../../../tools/migration/rollback-state';
import {projectRollbackHistory} from '../../../tools/migration/rollback-history';
import {assembleRollbackPackage,pinRollbackPackageSource} from '../../../tools/migration/rollback-package-codec';
import {writeRollbackPackage,readRollbackPackage} from '../../../tools/migration/rollback-package';
import {profileId,digest} from '../../../tools/migration/music-codec';
import {createPairedBackups} from './paired-backups';

const cleanup:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
const origin='https://fixture.invalid',stamp=new Date('2026-11-19T14:00:00Z');
const helper="import fcntl,sys\nfcntl.flock(3,fcntl.LOCK_EX|fcntl.LOCK_NB)\nprint('locked',flush=True)\nsys.stdin.read()";
const acquireLock=(path:string)=>acquireInheritedAuthorityLock(path,'python3',['-c',helper]);
async function setup(){
  const s=await legacyHistoryFixture();cleanup.push(()=>s.close());const journal=erasureJournal(s.db),privacy=createPrivacy(s.db,journal);
  s.db.transaction(()=>privacy.submit({version:1,kind:'both',userId:'bob',profileId:profileId('10002'),requestId:randomUUID(),createdAt:stamp.toISOString(),secretHash:hash('baseline-secret'),signature:hash('baseline-signature')})).immediate();privacy.guard();
  // The actual admin API writes createdAt after the proof fields. A canonical
  // projection has equivalent intents but different bytes; native preparation
  // must retain this original journal rather than rewrite its formatting.
  s.db.transaction(()=>privacy.submit({version:2,kind:'admin_music',command:'delete_profile',actorRef:'account:alice',profiles:[{id:profileId('10002'),userId:'bob'}],entries:[],requestId:randomUUID(),secretHash:hash('baseline-admin-secret'),signature:hash('baseline-admin-signature'),createdAt:stamp.toISOString()})).immediate();privacy.guard();
  for(const [i,status] of ['pending','sending','sent','failed','skipped'].entries())s.db.prepare("INSERT INTO bot_outbox(event_id,kind,dedupe_key,target,payload_json,status,claim_token,retry_at,simulated_at,delivered_payload_json,created_at) VALUES('listen','retained',?,'synthetic','{}',?,?,?,?,?,'historical')").run('retained-'+i,status,status==='sending'?'uncertain-fixture':'',status==='failed'?'retry-fixture':null,status==='skipped'?'simulation-fixture':null,status==='sent'?'sent-fixture':null);
  const media=captureRollbackMedia(s.db,journal),state=projectRollbackStateFromCheckpoint(media.checkpointImage,media.journal),history=projectRollbackHistory(state,{capture:s.config,native:{root:join(dirname(s.db.name),'paired-backups'),manifests:[]}}),pkg=assembleRollbackPackage(state,media,history,pinRollbackPackageSource(media,{captureManifestSha256:s.config.manifestSha256,native:[]})),packageRoot=join(s.root,'package'),packagePin=writeRollbackPackage(pkg,packageRoot,[s.capture,dirname(s.db.name)],stamp).manifestSha256,authority=join(s.root,'authority'),saved=writeRollbackErasureAuthority(packageRoot,packagePin,authority,stamp,undefined,{database:s.db.name,sha256:digest(fs.readFileSync(erasureJournalPath(s.db.name)))}),config={root:authority,manifestSha256:saved.manifestSha256,sourceCheckpoint:join(packageRoot,'private/latest/unified.sqlite3')},path=erasureJournalPath(s.db.name),baseline=fs.readFileSync(path),before=s.db.serialize();
  const bot=s.db.prepare('SELECT * FROM bot_outbox ORDER BY id').all();
  async function open(fault?:(stage:string)=>void){const journal=await createRetainedErasureJournal(s.db,config,{acquireLock,fault});cleanup.push(()=>journal.close());return journal;}
  return Object.assign(s,{packageRoot,packagePin,authority,config,path,baseline,before,bot,open});
}
function intent(_s:Awaited<ReturnType<typeof setup>>,kind:'account'|'music'|'both'='music'):Extract<ErasureIntent,{version:1}>{return {version:1,kind,userId:kind==='music'?'alice':'contact-owner',profileId:kind==='music'?profileId('10001'):profileId('m_'+'a'.repeat(24)),requestId:randomUUID(),createdAt:stamp.toISOString(),secretHash:hash('new-secret'),signature:hash('new-signature')};}
function apply(s:Awaited<ReturnType<typeof setup>>,journal:RetainedJournal,entry:ErasureIntent){const privacy=createPrivacy(s.db,journal);s.db.transaction(()=>privacy.submit(entry)).immediate();privacy.guard();return privacy;}
async function appFor(s:Awaited<ReturnType<typeof setup>>,journal:RetainedJournal){const app=createApp({db:s.db,origin,now:()=>stamp,erasureJournal:journal,pairedBackupScheduling:false,publicAPIKeys:()=> 'A'.repeat(48)});cleanup.push(()=>app.close());await app.ready();return app;}
async function headers(app:Awaited<ReturnType<typeof createApp>>,account='alice'){const cookie='kanban_session=fixture-'+account,viewer=(await app.inject({url:'/api/v2/session',headers:{cookie}})).json();return {cookie,origin,'x-account-scope':viewer.scope,'x-csrf-token':viewer.csrf};}
it.each(['music','account','both'] as const)('continues the retained native %s intent, verifies original bytes with Python, and preserves all bot statuses',async kind=>{
  const s=await setup(),journal=await s.open(),entry=intent(s,kind),privacy=apply(s,journal,entry);expect(privacy.receipt(entry.requestId,'new-secret')).toMatchObject({requestId:entry.requestId,target:kind});
  const read=readRollbackErasureAuthority(s.authority,s.config.manifestSha256);expect(read.head.sequence).toBe(1);expect(read.ledgers.unified).toEqual(fs.readFileSync(s.path));expect(read.ledgers.unified.subarray(0,s.baseline.length)).toEqual(s.baseline);read.assertUnchanged();
  await journal.close();const stdout=execFileSync('python3',['-c',"from tools.migration.rollback_erasure_authority import ErasureAuthority\nimport sys,json\nc=ErasureAuthority(sys.argv[1],sys.argv[2],{'unified':sys.argv[3]})\ntry:\n h,l=c.snapshot();assert h['sequence']==1\n with c.guard('unified') as b:assert b==l['unified']\n print(json.dumps({'nativePythonBytes':True}))\nfinally:c.close()",s.authority,s.config.manifestSha256,s.path],{encoding:'utf8',timeout:10000});expect(JSON.parse(stdout)).toEqual({nativePythonBytes:true});expect(s.db.prepare('SELECT * FROM bot_outbox ORDER BY id').all()).toEqual(s.bot);readRollbackPackage(s.packageRoot,s.packagePin).assertUnchanged();
});
it.each(['missing','baseline','partial'])('recovers %s service journal after restoring the old DB, replays native privacy twice and preserves frozen bot work',async shape=>{
  const s=await setup(),journal=await s.open(),entry=intent(s,'both');apply(s,journal,entry);await journal.close();
  const after=fs.readFileSync(s.path);if(shape==='missing')fs.rmSync(s.path);else fs.writeFileSync(s.path,shape==='baseline'?s.baseline:after.subarray(0,after.length-5));
  // Restore the old content through SQLite itself, without opening a raw FD for
  // the live DB. The original backup image is opened in a separate disposable DB.
  s.db.close();fs.writeFileSync(s.db.name,s.before);fs.rmSync(s.db.name+'-wal',{force:true});fs.rmSync(s.db.name+'-shm',{force:true});
  const {openServiceDatabase}=await import('@qgroup/database');s.db=openServiceDatabase(s.db.name);cleanup.push(()=>{s.db.close();});
  for(let i=0;i<2;i++){const next=await s.open(),privacy=createPrivacy(s.db,next);privacy.guard();expect(s.db.prepare("SELECT nickname FROM users WHERE id='contact-owner'").get()).toEqual({nickname:'已注销用户'});expect(s.db.prepare('SELECT * FROM bot_outbox ORDER BY id').all()).toEqual(s.bot);expect(fs.readFileSync(s.path)).toEqual(after);await next.close();}
});
it.each(['record_fsynced','head_published','before_source','source_fsynced'])('recovers a real native Node exit after %s and verifies the unpublished intent using the independent Python chain reader',async stage=>{
  const s=await setup(),entry=intent(s,'both'),code=`import {openServiceDatabase} from '@qgroup/database';
import {createRetainedErasureJournal} from './apps/api/src/retained-erasure-journal.ts';
import {acquireInheritedAuthorityLock} from './apps/api/src/erasure-authority-lock.ts';
import {createPrivacy} from './apps/api/src/privacy.ts';
const [database,root,pin,sourceCheckpoint,stage,raw]=process.argv.slice(1),db=openServiceDatabase(database),journal=await createRetainedErasureJournal(db,{root,manifestSha256:pin,sourceCheckpoint},{acquireLock:path=>acquireInheritedAuthorityLock(path,'python3',['-c',${JSON.stringify(helper)}]),fault:reached=>{if(reached===stage)process.exit(77);}}),privacy=createPrivacy(db,journal);
db.transaction(()=>privacy.submit(JSON.parse(raw))).immediate();throw Error('Expected real process exit');`;
  let failure:unknown;try{execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',code,s.db.name,s.authority,s.config.manifestSha256,s.config.sourceCheckpoint,stage,JSON.stringify(entry)],{encoding:'utf8',timeout:20000});}catch(error){failure=error;}expect((failure as {status:number}).status).toBe(77);
  // stdin EOF terminates the inherited holder after its parent exits.
  const next=await s.open(),privacy=createPrivacy(s.db,next);privacy.guard();expect(privacy.receipt(entry.requestId,'new-secret').target).toBe('both');expect(readRollbackErasureAuthority(s.authority,s.config.manifestSha256).head.sequence).toBe(1);expect(s.db.prepare('SELECT * FROM bot_outbox ORDER BY id').all()).toEqual(s.bot);
});
it('records an actual native API music erasure and blocks reads, exports and partner API after local ledger rewind',async()=>{
  const s=await setup(),journal=await s.open(),app=await appFor(s,journal),auth=await headers(app),profile=(await app.inject({url:'/api/v2/me/music',headers:auth})).json(),body={requestId:randomUUID(),secret:'ab'.repeat(32),target:'music',confirm:true,profileId:profile.id,profileRevision:profile.revision};
  const response=await app.inject({method:'POST',url:'/api/v2/me/privacy/erase',headers:auth,payload:body});expect(response.statusCode,response.body).toBe(200);expect(readRollbackErasureAuthority(s.authority,s.config.manifestSha256).head.sequence).toBe(1);
  const partner={authorization:'Bearer '+'A'.repeat(48)};expect((await app.inject({url:'/api/public/v1/events',headers:partner})).statusCode).toBe(200);fs.writeFileSync(s.path,s.baseline);
  for(const url of ['/api/v2/health','/api/v2/me/music','/api/v2/admin/music-export','/api/public/v1/events']){const r=await app.inject({url,headers:url.includes('/public/')?partner:auth});expect(r.statusCode,r.body).toBe(503);expect(r.body).not.toMatch(/10001|baseline-secret|new-secret|\/Users|\/tmp/);}
});
it.each(['delete_profile','reset_music'] as const)('preserves the exact native administrative %s scopes, retries and backup erasure filters',async command=>{
  const s=await setup();s.db.prepare("INSERT INTO user_admin_roles VALUES('alice',1,1,'synthetic')").run();const journal=await s.open(),app=await appFor(s,journal),auth=await headers(app),session=(await app.inject({url:'/api/v2/admin/session',headers:auth})).json(),admin={...auth,'x-admin-csrf':session.adminCsrf},path=command==='reset_music'?'/api/v2/admin/music-reset':'/api/v2/admin/music/'+profileId('10001')+'/erase',preview=(await app.inject({url:path,headers:auth})).json(),body={revision:preview.revision,confirm:command==='reset_music'?'RESET':'DELETE',requestId:randomUUID(),secret:'ab'.repeat(32)};
  const backups=createPairedBackups(s.db,journal,()=>stamp)!,old=backups.capture();const response=await app.inject({method:'POST',url:path,headers:admin,payload:body});expect(response.statusCode,response.body).toBe(200);expect((await app.inject({method:'POST',url:path,headers:admin,payload:body})).json()).toEqual(response.json());
  const rows=journal.read(),last=rows.at(-1)!;expect(last).toMatchObject({version:2,kind:'admin_music',command,requestId:body.requestId});if('entries' in last)expect(last.entries).toHaveLength(command==='reset_music'?1:0);expect(s.db.prepare('SELECT * FROM bot_outbox ORDER BY id').all()).toEqual(s.bot);
  const exported=await app.inject({url:'/api/v2/admin/music-export?backup='+old.id,headers:auth});expect(exported.statusCode,exported.body).toBe(200);expect(exported.json().members).not.toHaveProperty('10001');if(command==='reset_music')expect(exported.json().entries).toEqual({});
});
it('rechecks the same immutable head before replacement and retains an interrupted head temporary file for audited repair',async()=>{
  const s=await setup(),old=fs.readFileSync(join(s.authority,'authority-head.json')),journal=await s.open(stage=>{if(stage==='head_temporary_fsynced'){const path=join(s.authority,'authority-head.json');fs.renameSync(path,path+'.saved');fs.writeFileSync(path,old,{mode:0o600});}});
  expect(()=>journal.append(intent(s))).toThrow();expect(fs.readFileSync(s.path)).toEqual(s.baseline);expect(()=>journal.read()).toThrow('write failed');await journal.close();await expect(s.open()).rejects.toThrow();expect(fs.readdirSync(s.authority).some(name=>/^\.head-/.test(name))).toBe(true);
});
it('rejects a retained head/record rewind observed in this lifetime before another native write or readonly operation',async()=>{
  const s=await setup(),old=fs.readFileSync(join(s.authority,'authority-head.json')),journal=await s.open();apply(s,journal,intent(s));fs.writeFileSync(join(s.authority,'authority-head.json'),old);fs.rmSync(join(s.authority,'records/000000000001.json'));fs.writeFileSync(s.path,s.baseline);expect(()=>journal.assertReadable!()).toThrow('rewound');expect(()=>journal.append(intent(s))).toThrow('rewound');
});
it('excludes an actual Python authority process for the entire native lifetime, then permits its original byte append after native close',async()=>{
  const s=await setup(),journal=await s.open(),code="from tools.migration.rollback_erasure_authority import ErasureAuthority\nimport sys,json\nc=ErasureAuthority(sys.argv[1],sys.argv[2],{'unified':sys.argv[3]})\ntry:\n c.record('unified',(json.dumps({'user_id':'contact-owner','request_id':'old-after-native','created_at':'original-time'},separators=(',',':'))+'\\n').encode())\nfinally:c.close()";
  expect(()=>execFileSync('python3',['-c',code,s.authority,s.config.manifestSha256,s.path],{timeout:10000,stdio:'pipe'})).toThrow();await journal.close();execFileSync('python3',['-c',code,s.authority,s.config.manifestSha256,s.path],{timeout:10000,stdio:'pipe'});const next=await s.open(),privacy=createPrivacy(s.db,next);privacy.guard();expect(s.db.prepare("SELECT nickname FROM users WHERE id='contact-owner'").get()).toEqual({nickname:'已注销用户'});expect(readRollbackErasureAuthority(s.authority,s.config.manifestSha256).head.sequence).toBe(1);
});
it.each(['foreign ledger','missing head','wrong pin','public source','async fault'])('rejects native %s without silently discarding intent or changing bot work',async change=>{
  const s=await setup();if(change==='foreign ledger')fs.appendFileSync(s.path,'{"user_id":"alice","request_id":"foreign","created_at":"original"}\n');if(change==='missing head')fs.rmSync(join(s.authority,'authority-head.json'));if(change==='public source')fs.chmodSync(s.path,0o644);
  if(change==='wrong pin')await expect(createRetainedErasureJournal(s.db,{...s.config,manifestSha256:'0'.repeat(64)},{acquireLock})).rejects.toThrow();else if(change==='async fault'){const journal=await s.open(async()=>{});expect(()=>journal.append(intent(s))).toThrow('synchronous');expect(()=>journal.read()).toThrow('write failed');}else await expect(s.open()).rejects.toThrow();expect(s.db.prepare('SELECT * FROM bot_outbox ORDER BY id').all()).toEqual(s.bot);
});
it('rejects a live native SQLite inode alias before opening raw FDs and leaves its real writer lock held',async()=>{
  const s=await setup(),journal=await s.open();s.db.pragma('journal_mode = DELETE');s.db.exec('BEGIN IMMEDIATE');const saved=s.path+'.saved';fs.renameSync(s.path,saved);fs.renameSync(s.db.name,s.path);
  try{expect(()=>journal.assertReadable!()).toThrow('SQLite inode');const code="import sqlite3,sys\nc=sqlite3.connect(sys.argv[1],timeout=0)\ntry:\n c.execute('BEGIN IMMEDIATE')\nexcept sqlite3.OperationalError as e:\n assert 'locked' in str(e)\nelse:\n raise AssertionError('Native SQLite lock lost')\nfinally:c.close()";execFileSync('python3',['-c',code,s.path],{timeout:10000,stdio:'pipe'});}finally{s.db.exec('ROLLBACK');fs.renameSync(s.path,s.db.name);fs.renameSync(saved,s.path);}
});
it('requires the real Linux lock in native runtime and rejects unsupported hosts without creating a lock file',async()=>{if(process.platform==='linux')return;await expect(acquireErasureAuthorityLock('/missing-private-authority')).rejects.toThrow('Linux flock');});
it('keeps real flock exclusion through the parent FD after the inherited holder is killed, until native close releases it',async()=>{
  const s=await setup(),pidFile=join(s.root,'holder-pid'),script="import fcntl,sys,os\nfcntl.flock(3,fcntl.LOCK_EX|fcntl.LOCK_NB)\nwith open(sys.argv[1],'x') as f:\n os.chmod(sys.argv[1],0o600);f.write(str(os.getpid()));f.flush();os.fsync(f.fileno())\nprint('locked',flush=True)\nsys.stdin.read()",journal=await createRetainedErasureJournal(s.db,s.config,{acquireLock:path=>acquireInheritedAuthorityLock(path,'python3',['-c',script,pidFile])});cleanup.push(()=>journal.close());
  const pid=Number(fs.readFileSync(pidFile,'utf8'));expect(Number.isSafeInteger(pid)&&pid>1).toBe(true);process.kill(pid,'SIGKILL');await new Promise(resolve=>setTimeout(resolve,100));expect(()=>journal.assertReadable!()).toThrow('exclusion');
  const rival="from tools.migration.rollback_erasure_authority import ErasureAuthority\nimport sys\nc=ErasureAuthority(sys.argv[1],sys.argv[2])\ntry:c.snapshot()\nfinally:c.close()";expect(()=>execFileSync('python3',['-c',rival,s.authority,s.config.manifestSha256],{timeout:10000,stdio:'pipe'})).toThrow();await journal.close();expect(()=>execFileSync('python3',['-c',rival,s.authority,s.config.manifestSha256],{timeout:10000,stdio:'pipe'})).not.toThrow();
});
it.each(['missing checkpoint','corrupt checkpoint','different lineage','live checkpoint alias'])('rejects native %s before completing pending publication or erasure recovery',async change=>{
  const s=await setup(),config={...s.config},original=fs.readFileSync(s.path),head=fs.readFileSync(join(s.authority,'authority-head.json'));
  let database=s.db;
  if(change==='missing checkpoint')config.sourceCheckpoint=join(s.root,'absent.sqlite3');if(change==='corrupt checkpoint')fs.appendFileSync(config.sourceCheckpoint,'x');if(change==='live checkpoint alias')config.sourceCheckpoint=s.db.name;
  if(change==='different lineage'){const folder=join(s.root,'other-native');fs.mkdirSync(folder,{mode:0o700});const {openDatabase}=await import('@qgroup/database');database=openDatabase(join(folder,'unified.sqlite3'));cleanup.push(()=>{database.close();});fs.writeFileSync(erasureJournalPath(database.name),s.baseline,{mode:0o600});}
  await expect(createRetainedErasureJournal(database,config,{acquireLock})).rejects.toThrow();expect(fs.readFileSync(s.path)).toEqual(original);expect(fs.readFileSync(join(s.authority,'authority-head.json'))).toEqual(head);expect(s.db.prepare('SELECT * FROM bot_outbox ORDER BY id').all()).toEqual(s.bot);
});
it('prepares original native admin journal bytes from a pinned CLI input without replacing them with canonical projection formatting',async()=>{
  const s=await setup(),projected=fs.readFileSync(join(s.packageRoot,'private/latest/unified.erasures.jsonl'));expect(s.baseline).not.toEqual(projected);
  const root=join(s.root,'cli-authority'),stdout=execFileSync(process.execPath,['--import','tsx','tools/migration/rollback-erasure-authority.ts',s.packageRoot,s.packagePin,root,s.db.name,digest(s.baseline)],{encoding:'utf8',timeout:20000}),result=JSON.parse(stdout);expect(result).toMatchObject({status:'prepared_private_erasure_authority',records:0,rollbackEligible:false});
  const read=readRollbackErasureAuthority(root,result.manifestSha256);expect(read.ledgers.unified).toEqual(s.baseline);read.assertUnchanged();expect(stdout).not.toMatch(/baseline-admin-secret|10001|\/Users|\/tmp/);expect(fs.readFileSync(s.path)).toEqual(s.baseline);
  const journal=await createRetainedErasureJournal(s.db,{...s.config,root,manifestSha256:result.manifestSha256},{acquireLock});cleanup.push(()=>journal.close());apply(s,journal,intent(s));expect(journal.read()).toHaveLength(3);
});
it.each(['wrong raw pin','unrecorded raw intent','late raw change'])('rejects native authority preparation with %s and preserves source bytes or the incomplete output',async change=>{
  const s=await setup(),root=join(s.root,'rejected-authority');let pin=digest(s.baseline),calls=0;
  if(change==='wrong raw pin')pin='0'.repeat(64);if(change==='unrecorded raw intent'){fs.appendFileSync(s.path,JSON.stringify(intent(s))+'\n');pin=digest(fs.readFileSync(s.path));}
  const original=fs.readFileSync(s.path);expect(()=>writeRollbackErasureAuthority(s.packageRoot,s.packagePin,root,stamp,change==='late raw change'?()=>{if(++calls===2)fs.appendFileSync(s.path,' ');}:undefined,{database:s.db.name,sha256:pin})).toThrow();
  if(change==='late raw change')expect(fs.existsSync(join(root,'incomplete.json'))).toBe(true);else{expect(fs.existsSync(root)).toBe(false);expect(fs.readFileSync(s.path)).toEqual(original);}readRollbackPackage(s.packageRoot,s.packagePin).assertUnchanged();
});
it.each(['board','music'])('blocks native startup after a real old %s writer adds an intent until complete forward projection is verified',async domain=>{
  const s=await setup(),folder=join(s.root,'resumed-old'),path=join(folder,'erasures.jsonl');fs.mkdirSync(folder,{mode:0o700});const original=fs.readFileSync(s.path),image=s.db.serialize(),code="from tools.migration.rollback_erasure_authority import ErasureAuthority\nimport sys,json\nroot,pin,domain,path=sys.argv[1:]\nc=ErasureAuthority(root,pin,{domain:path})\ntry:\n c.recover(domain)\n row={'user_id':'alice','request_id':'resumed-old-account','created_at':'original-time'} if domain=='board' else {'qq':'10001','erased_at':1234}\n c.record(domain,(json.dumps(row,separators=(',',':'))+'\\n').encode())\nfinally:c.close()";
  execFileSync('python3',['-c',code,s.authority,s.config.manifestSha256,domain,path],{timeout:10000,stdio:'pipe'});await expect(s.open()).rejects.toThrow('forward projection');expect(fs.readFileSync(s.path)).toEqual(original);expect(s.db.serialize()).toEqual(image);expect(readRollbackErasureAuthority(s.authority,s.config.manifestSha256).head.sequence).toBe(1);
});
it('preserves a retained native intent across actual SQL rollback, recovers after repair and never appends the original request twice',async()=>{
  const s=await setup(),journal=await s.open(),privacy=createPrivacy(s.db,journal),entry=intent(s);s.db.exec("CREATE TRIGGER isolated_receipt_failure BEFORE INSERT ON privacy_receipts BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END;");
  expect(()=>s.db.transaction(()=>privacy.submit(entry)).immediate()).toThrow('receipt failure');expect(readRollbackErasureAuthority(s.authority,s.config.manifestSha256).head.sequence).toBe(1);expect(s.db.prepare('SELECT erased_at FROM music_profiles WHERE id=?').get(entry.profileId)).toEqual({erased_at:null});expect(()=>privacy.assertReadable()).toThrow();expect(s.db.prepare('SELECT * FROM bot_outbox ORDER BY id').all()).toEqual(s.bot);
  s.db.exec('DROP TRIGGER isolated_receipt_failure');privacy.guard();expect(privacy.receipt(entry.requestId,'new-secret')).toMatchObject({target:'music',status:'completed'});s.db.transaction(()=>privacy.submit(entry)).immediate();privacy.guard();expect(readRollbackErasureAuthority(s.authority,s.config.manifestSha256).head.sequence).toBe(1);
});
