import * as fs from 'node:fs';
import {dirname,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {gzipSync,gunzipSync} from 'node:zlib';
import {randomUUID} from 'node:crypto';
import Database from 'better-sqlite3';
import {afterEach,expect,it} from 'vitest';
import type {DB} from '@qgroup/database';
import {legacyHistoryFixture} from '../testsupport/legacy-history-fixture';
import {createPairedBackups} from './paired-backups';
import {createPrivacy} from './privacy';
import {erasureJournal,type ErasureIntent} from './erasure-journal';
import {hash} from './security';
import {profileId,digest} from '../../../tools/migration/music-codec';
import {captureRollbackMedia} from '../../../tools/migration/rollback-media';
import {projectRollbackStateFromCheckpoint} from '../../../tools/migration/rollback-state';
import {projectRollbackHistory} from '../../../tools/migration/rollback-history';
import {assembleRollbackPackage,assembleRollbackPackageV2,pinRollbackPackageSource,pinRollbackPackageSourceV2} from '../../../tools/migration/rollback-package-codec';
import {captureRollbackBotState} from '../../../tools/migration/rollback-bot-state';
import {captureRollbackPackage} from '../../../tools/migration/capture-rollback-package';
import {rollbackJournalPath,type RollbackCaptureInputValue} from '../../../tools/migration/rollback-capture-boundary';
import {pinRollbackServiceEvidence,type RollbackServiceEvidenceValue} from '../../../tools/migration/rollback-service-evidence';
import {BotOwnership} from '../../bot/src/ownership';
import {readRollbackPackage,writeRollbackPackage} from '../../../tools/migration/rollback-package';
import {listRollbackBoardHistories,readBoardImageArchive} from '../../../tools/migration/rollback-board-history-source';
import {projectRollbackBoardHistory,type RollbackBoardHistory} from '../../../tools/migration/rollback-board-history';
import {verifyRollbackBoardHistory} from '../../../tools/migration/rollback-board-history-reconciliation';
import {readRollbackBoardHistoryArtifact,writeRollbackBoardHistoryArtifact} from '../../../tools/migration/rollback-board-history-artifact';
const cleanup:(()=>void)[]=[];afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();});
const stamp=new Date('2026-11-19T12:00:00.000Z'),legacyStamp='20261118-010203-123456';
const bodies={private:Buffer.from('synthetic-private-bob-code'),kept:Buffer.from('synthetic-alice-code'),shared:Buffer.from('synthetic-shared-frozen-code'),blob:Buffer.from('synthetic-old-inline-receipt')};
function seed(db:DB,folder:string,images:boolean){
  db.pragma('foreign_keys=ON');
  for(const status of ['open','closed','decided']){
    const id='historical-poll-'+status;
    db.prepare("INSERT INTO time_polls(id,owner_id,title,category,location,description,timezone,duration_hours,capacity,minimum_participants,fee_policy,deadline,status,vote_revision,created_at) VALUES(?,'alice','歷史投票','其他','歷史地點','','Asia/Taipei',3,12,0,'unknown','historical',?,7,'historical')").run(id,status);
    db.prepare('INSERT INTO time_poll_options VALUES(?,?,?,?)').run(id+'-option',id,0,'historical');
    for(const user of ['alice','bob']){db.prepare('INSERT INTO time_poll_ballots VALUES(?,?,?)').run(id,user,'historical');db.prepare('INSERT INTO time_poll_votes VALUES(?,?,?,?)').run(id,user,id+'-option',user==='alice'?'maybe':'yes');}
  }
  db.prepare("INSERT INTO user_admin_roles VALUES('bob',1,4,'historical')").run();
  db.prepare("INSERT INTO admin_role_history(id,user_id,actor_ref,before_value,after_value,revision,created_at) VALUES(-7,'bob','original',0,1,4,'historical')").run();
  db.prepare("INSERT INTO settlement_history(event_id,version,total_cents,headcount,note,qr_image,updated_at,actor_id,actor_name,kind,changed_fields) VALUES('listen',1,-101,3,'凍結歷史',?,'historical','bob','原始名字','full','[]')").run(bodies.blob);
  db.prepare("INSERT INTO settlement_details VALUES('listen',1,'{}')").run();
  db.prepare("INSERT INTO settlement_receipts VALUES('listen',1,'inline',?)").run(bodies.blob);
  db.prepare("INSERT INTO finance_entries(id,event_id,kind,payload_json,occurred_at,actor_id,actor_name,created_at) VALUES('history-money','listen','expense','{\"amount_cents\":-101}','unknown-zone','bob','原帳本名字','historical')").run();
  for(const [i,status] of ['pending','sending','sent','failed','skipped'].entries())db.prepare("INSERT INTO bot_outbox(event_id,kind,dedupe_key,target,payload_json,status,attempts,claim_token,retry_at,simulated_at,delivered_payload_json,created_at,recipient_user_id) VALUES('listen','historical',?,'synthetic','{\"frozen\":true}',?,2,?,?,?,?, 'historical','bob')").run('historical-'+i,status,status==='sending'?'original-uncertain-claim':'',status==='failed'?'original-retry':null,status==='skipped'?'original-simulation':null,status==='sent'?'original-sent-body':null);
  db.prepare("INSERT INTO external_identities VALUES('qq','synthetic-app','inactive-bob-subject','bob','原 QQ 名','historical')").run();
  db.prepare("INSERT INTO external_unionids VALUES('qq','synthetic-app','inactive-bob-subject','inactive-union','historical')").run();
  db.prepare("INSERT INTO external_profiles VALUES('qq','synthetic-app','bob','inactive-avatar')").run();
  db.prepare("INSERT INTO qq_accounts VALUES('synthetic-app','inactive-bob-subject','bob','原 QQ 名','historical')").run();
  db.prepare("INSERT INTO browser_accounts VALUES(?,'bob','historical')").run(hash('fixture-bob'));
  db.prepare('INSERT INTO visitor_sessions VALUES(?,?,?)').run(hash('fixture-bob'),'future','historical');
  db.prepare('INSERT INTO auth_requests VALUES(?,?,?,?,?)').run(hash('fixture-bob'),'inactive-key','inactive-signature','{}','historical');
  db.prepare("INSERT INTO privacy_consents VALUES('bob','old-policy','historical')").run();
  db.prepare("INSERT INTO login_attempts(id,token_hash,user_id,provider,app_id,mode,status,expires_at,created_at,openid) VALUES('historical-pending',?,NULL,'qq','synthetic-app','login','pending','future','historical','inactive-bob-subject')").run(hash('fixture-alice'));
  db.prepare("INSERT INTO event_access VALUES('listen','bob','historical')").run();
  if(images){
    for(const [key,bytes] of Object.entries(bodies).filter(([key])=>key!=='blob')){const value=digest(bytes),path=join(folder,'images',value.slice(0,2),value+'.png');fs.mkdirSync(dirname(path),{recursive:true,mode:0o700});fs.writeFileSync(path,bytes,{mode:0o600});db.prepare('INSERT INTO image_assets VALUES(?,?,?,?)').run(value,bytes.length,'image/png','historical');if(key==='private')db.prepare("INSERT INTO user_payment_codes VALUES('private-code','bob','wechat','本人碼',?,'historical',NULL)").run(value);if(key==='kept')db.prepare("INSERT INTO user_payment_codes VALUES('kept-code','alice','alipay','保留碼',?,'historical',NULL)").run(value);if(key==='shared')db.prepare("INSERT INTO settlement_code_images VALUES('listen',1,'wechat','凍結碼',?)").run(value);}
  }
}
async function setup(options:{version?:1|2|3;kind?:'account'|'music'|'both'|'none';images?:boolean;earlyClosure?:boolean;nativeSchema?:13|14|15;badHistory?:(path:string)=>void}={}){
  const s=await legacyHistoryFixture();cleanup.push(()=>s.close());const data=dirname(s.db.name),journal=erasureJournal(s.db),old=join(s.root,'old-history-source');fs.mkdirSync(old,{mode:0o700});
  const oldPath=join(old,'board.sqlite3');fs.copyFileSync(join(s.capture,'current/board.sqlite3'),oldPath);const legacy=new Database(oldPath);try{seed(legacy,old,options.images!==false);legacy.prepare("UPDATE sqlite_sequence SET seq=9007199254741015 WHERE name='admin_role_history'").run();}finally{legacy.close();}
  const historyRoot=join(s.capture,'history/board');
  execFileSync('python3',['-I','-c',`import importlib.util,sys
from datetime import datetime,timezone
from pathlib import Path
spec=importlib.util.spec_from_file_location('old_backup','deploy/backup.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class Clock:
 @staticmethod
 def now(_):return datetime(2026,11,18,1,2,3,123456,tzinfo=timezone.utc)
module.datetime=Clock
module.backup(Path(sys.argv[1]),Path(sys.argv[2]))
`,oldPath,historyRoot],{timeout:10000,stdio:['ignore','pipe','pipe']});
  options.badHistory?.(historyRoot);const config=s.repin();seed(s.db,data,options.images!==false);
  const native=createPairedBackups(s.db,journal,()=>new Date('2026-11-18T01:02:03Z'))!.capture(),nativeRoot=join(data,'paired-backups');
  if(options.nativeSchema&&options.nativeSchema!==15){const base=join(nativeRoot,native.id),path=join(base,'state.sqlite3'),db=new Database(fs.readFileSync(path));try{db.exec('DROP TABLE unified_privacy_receipts; DROP TABLE unified_privacy_consents; DROP TRIGGER unified_privacy_erasure');if(options.nativeSchema===13)db.exec('DROP TABLE rebuild_storage');db.prepare('UPDATE rebuild_schema SET version=?').run(options.nativeSchema);fs.writeFileSync(path,db.serialize());}finally{db.close();}const manifestPath=join(base,'manifest.json'),manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));manifest.schema=options.nativeSchema;if(options.nativeSchema===13){manifest.version=1;delete manifest.lineageId;}for(const row of manifest.files){const bytes=fs.readFileSync(join(base,row.path));row.sha256=digest(bytes);row.size=bytes.length;}fs.writeFileSync(manifestPath,JSON.stringify(manifest));}
  const nativePins=[{id:native.id,sha256:digest(fs.readFileSync(join(nativeRoot,native.id,'manifest.json')))}];
  if(options.earlyClosure){const entry={user_id:'bob',request_id:'original-imported-closure',created_at:'original-unknown-zone'};createPrivacy(s.db,{read:()=>[entry],append(){throw Error('Read-only fixture');}});s.db.prepare('DELETE FROM erasure_applied WHERE request_id=?').run(entry.request_id);}
  else if(options.kind!=='none'){const entry={version:1,kind:options.kind??'account',userId:'bob',profileId:profileId('10002'),requestId:randomUUID(),createdAt:'2026-11-19T02:00:00.000Z',secretHash:hash('inactive-secret'),signature:hash('inactive-signature')} as ErasureIntent,privacy=createPrivacy(s.db,journal);s.db.transaction(()=>privacy.submit(entry)).immediate();privacy.guard();}
  const media=captureRollbackMedia(s.db,journal),state=projectRollbackStateFromCheckpoint(media.checkpointImage,media.journal),historyConfig={capture:config,native:{root:nativeRoot,manifests:nativePins}},history=projectRollbackHistory(state,historyConfig),historyPins={captureManifestSha256:config.manifestSha256,native:nativePins},packageRoot=join(s.root,'private-package'),logs=join(s.root,'external-bot/logs'),wordsRoot=join(s.root,'external-bot-words'),words=join(wordsRoot,'sensitive-words.json');
  let packagePin:string;
  if(options.version===2||options.version===3){
    fs.mkdirSync(logs,{recursive:true,mode:0o700});fs.mkdirSync(wordsRoot,{mode:0o700});fs.writeFileSync(join(logs,'bot-health.json'),'{"runtime_state":"stopped"}',{mode:0o600});fs.writeFileSync(words,'["合成詞庫"]',{mode:0o600});
    const input={database:s.db.name,logDirectory:logs,sensitiveWordsFile:words};
    if(options.version===3){
      if(!fs.existsSync(rollbackJournalPath(s.db.name)))fs.writeFileSync(rollbackJournalPath(s.db.name),'',{mode:0o600});
      const owner=new BotOwnership(s.db.name);owner.close();
      const observed=(['web','bot'] as const).map((role,i)=>({Id:String(i+1).repeat(64),Image:'sha256:'+String(i+3).repeat(64),Revision:String.fromCharCode(97+i).repeat(40),Service:role,State:{Running:false,Paused:false,Restarting:false,Dead:false,Status:'exited',Pid:0,StartedAt:'original-start',FinishedAt:'original-stop'},RestartCount:0,Runtime:role==='web'?'native-api':'native-bot',EnvironmentMode:'production',NodeOptionsConfigured:false,WebDatabase:'/data/unified.sqlite3',BotDatabase:'/data/unified.sqlite3',BotLogDirectory:'/logs',BotSensitiveWordsFile:'/words/sensitive-words.json',BotEnvironmentFile:'',HistoryRoot:role==='web'?'/legacy':'',HistoryManifestSha256:role==='web'?config.manifestSha256:'',Mounts:[{Type:'bind',Source:data,Destination:'/data'},{Type:'bind',Source:s.capture,Destination:'/legacy'},{Type:'bind',Source:logs,Destination:'/logs'},{Type:'bind',Source:wordsRoot,Destination:'/words'}]}) as RollbackServiceEvidenceValue);
      const capture:RollbackCaptureInputValue={database:s.db.name,expectedLineageId:(s.db.prepare('SELECT lineage_id FROM rebuild_storage WHERE id=1').get() as {lineage_id:string}).lineage_id,bot:{logDirectory:logs,sensitiveWordsFile:words},history:historyConfig,destination:packageRoot,services:observed.map(row=>({role:row.Service as 'web'|'bot',runtime:'typescript',containerId:row.Id,imageId:row.Image,commit:row.Revision!,evidenceSha256:pinRollbackServiceEvidence(row)}))},raw=Buffer.from(JSON.stringify(capture)+'\n');
      packagePin=captureRollbackPackage(raw,digest(raw),stamp,{inspect:id=>structuredClone(observed.find(row=>row.Id===id)!)}).manifestSha256;
    }else{
      const bot=captureRollbackBotState(input,stamp),pkg=assembleRollbackPackageV2(state,media,history,bot.state,pinRollbackPackageSourceV2(media,historyPins,bot.state));
      packagePin=writeRollbackPackage(pkg,packageRoot,[s.capture,data,logs,wordsRoot],stamp).manifestSha256;
    }
  }else{
    const pkg=assembleRollbackPackage(state,media,history,pinRollbackPackageSource(media,historyPins));packagePin=writeRollbackPackage(pkg,packageRoot,[s.capture,data],stamp).manifestSha256;
  }
  const pkg=readRollbackPackage(packageRoot,packagePin);
  const legacyId='legacy-board-'+legacyStamp,nativeId='native-board-'+native.id,destination=join(s.root,'board-history'),prepare=(id=legacyId,guard?:()=>void)=>writeRollbackBoardHistoryArtifact(packageRoot,packagePin,id,destination,stamp,guard);
  return {...s,data,journal,config,oldPath,historyRoot,pkg,packageRoot,packagePin,legacyId,nativeId,destination,logs,wordsRoot,prepare};
}
it.each(['legacy','native'] as const)('restores %s board history with latest account closures, exact immutable records, original bot work and referenced images',async source=>{
  const s=await setup(),id=source==='legacy'?s.legacyId:s.nativeId,before=s.db.serialize(),saved=s.prepare(id),read=readRollbackBoardHistoryArtifact(s.destination,saved.manifestSha256,s.packageRoot,s.packagePin),db=new Database(read.projection.boardImage);
  try{expect(read.report).toMatchObject({tableCount:59,imageCount:2,historyOnly:true,rollbackEligible:false});expect(read.manifest.metadata).toMatchObject(source==='legacy'?{createdAt:null,schema:null,sourceStamp:legacyStamp}:{createdAt:'2026-11-18T01:02:03.000Z',schema:15});
    expect(db.prepare("SELECT nickname FROM users WHERE id='bob'").get()).toEqual({nickname:'已注销用户'});expect(db.prepare("SELECT 1 FROM browser_sessions WHERE user_id='bob'").get()).toBeUndefined();expect(db.prepare("SELECT 1 FROM login_attempts WHERE id='historical-pending'").get()).toBeUndefined();expect(db.prepare('SELECT 1 FROM external_unionids').get()).toBeUndefined();
    expect(db.prepare('SELECT qr_image,total_cents,actor_name FROM settlement_history').get()).toEqual({qr_image:bodies.blob,total_cents:-101,actor_name:'原始名字'});expect(db.prepare('SELECT image FROM settlement_receipts').get()).toEqual({image:bodies.blob});expect(db.prepare('SELECT occurred_at,payload_json FROM finance_entries').get()).toEqual({occurred_at:'unknown-zone',payload_json:'{"amount_cents":-101}'});
    expect(db.prepare('SELECT status,claim_token,retry_at,simulated_at,delivered_payload_json FROM bot_outbox ORDER BY id').all()).toEqual(['pending','sending','sent','failed','skipped'].map(status=>({status,claim_token:status==='sending'?'original-uncertain-claim':'',retry_at:status==='failed'?'original-retry':null,simulated_at:status==='skipped'?'original-simulation':null,delivered_payload_json:status==='sent'?'original-sent-body':null})));
    expect(db.prepare('SELECT id FROM admin_role_history ORDER BY id').safeIntegers(true).all()).toEqual(source==='legacy'?[{id:-7n},{id:9007199254741016n}]:[{id:-7n},{id:1n}]);expect(read.projection.images.map(row=>digest(row.bytes)).sort()).toEqual([digest(bodies.kept),digest(bodies.shared)].sort());
    expect(db.prepare('SELECT status,vote_revision FROM time_polls ORDER BY status').all()).toEqual([{status:'closed',vote_revision:8},{status:'decided',vote_revision:7},{status:'open',vote_revision:8}]);
    expect(db.prepare('SELECT DISTINCT user_id FROM time_poll_votes').all()).toEqual([{user_id:'alice'}]);expect(db.prepare('SELECT DISTINCT user_id FROM time_poll_ballots').all()).toEqual([{user_id:'alice'}]);
    expect(fs.lstatSync(s.destination).mode&0o777).toBe(0o700);for(const row of read.manifest.files)expect(fs.lstatSync(join(s.destination,row.path)).mode&0o777).toBe(0o600);read.assertUnchanged();readRollbackPackage(s.packageRoot,s.packagePin).assertUnchanged();expect(s.db.serialize()).toEqual(before);
  }finally{db.close();}
});
it.each(['account','music','both','none'] as const)('applies only account closure semantics for %s source intents',async kind=>{const s=await setup({kind}),read=projectRollbackBoardHistory(s.pkg,s.legacyId,stamp),db=new Database(read.boardImage);try{expect(db.prepare("SELECT nickname FROM users WHERE id='bob'").get()).toEqual({nickname:kind==='account'||kind==='both'?'已注销用户':'小白'});expect(read.images).toHaveLength(kind==='account'||kind==='both'?2:3);expect(read.boardJournal).toBe(s.pkg.state.erasures.boardJournal);}finally{db.close();}});
it.each([2,3] as const)('restores both histories from a version %i package while preserving latest bot bytes and source DB',async version=>{
  const s=await setup({version}),before=s.db.serialize(),health=fs.readFileSync(join(s.logs,'bot-health.json')),words=fs.readFileSync(join(s.wordsRoot,'sensitive-words.json'));
  for(const id of [s.legacyId,s.nativeId]){const destination=join(s.root,id),saved=writeRollbackBoardHistoryArtifact(s.packageRoot,s.packagePin,id,destination,stamp),read=readRollbackBoardHistoryArtifact(destination,saved.manifestSha256,s.packageRoot,s.packagePin);expect(read.report).toMatchObject({tableCount:59,imageCount:2,historyOnly:true,rollbackEligible:false});expect(read.manifest.sourcePackageSha256).toBe(s.packagePin);read.assertUnchanged();}
  expect(s.pkg.version).toBe(version);expect(s.db.serialize()).toEqual(before);expect(fs.readFileSync(join(s.logs,'bot-health.json'))).toEqual(health);expect(fs.readFileSync(join(s.wordsRoot,'sensitive-words.json'))).toEqual(words);s.pkg.assertUnchanged();
},20000);
it.each([[2,'data'],[2,'logs'],[2,'wordsRoot'],[3,'data'],[3,'logs'],[3,'wordsRoot'],[3,'capture']] as const)('rejects version %i historical output inside recorded %s source roots before reserving it',async(version,root)=>{
  const s=await setup({version}),destination=join(s[root],'new-history');expect(()=>writeRollbackBoardHistoryArtifact(s.packageRoot,s.packagePin,s.legacyId,destination,stamp)).toThrow('isolated from sources');expect(fs.existsSync(destination)).toBe(false);s.pkg.assertUnchanged();
});
it('uses every complete native/legacy namespace without inventing a timezone or collapsing same-second backups',async()=>{const s=await setup(),rows=listRollbackBoardHistories(s.pkg);expect(rows.map(row=>row.id)).toEqual([s.legacyId,s.nativeId]);expect(rows[0]).toMatchObject({createdAt:null,schema:null});expect(rows[1]).toMatchObject({schema:15});expect(()=>projectRollbackBoardHistory(s.pkg,'20261118-010203',stamp)).toThrow('exact board history ID');});
it('retains legacy DB-only snapshots when the original asset index is empty, and old BLOB receipts remain readable',async()=>{const s=await setup({images:false,badHistory(folder){fs.rmSync(join(folder,'kanban-'+legacyStamp+'.images.tar.gz'));}}),saved=s.prepare(),read=readRollbackBoardHistoryArtifact(s.destination,saved.manifestSha256,s.packageRoot,s.packagePin);expect(read.report.imageCount).toBe(0);expect(read.manifest.metadata.assetsSha256).toBeNull();expect(fs.readdirSync(join(s.destination,'images'))).toEqual([]);});
it.each(['legacy','native'] as const)('runs original Python recover twice and original media readers on prepared %s history without changing data',async source=>{const s=await setup(),saved=s.prepare(source==='legacy'?s.legacyId:s.nativeId),before=readRollbackBoardHistoryArtifact(s.destination,saved.manifestSha256,s.packageRoot,s.packagePin),result=execFileSync('python3',['-c',`import sys,json
from pathlib import Path
from qgroup_core.privacy import recover
from qgroup_core import storage,media
root=Path(sys.argv[1])
for _ in range(2):recover(root/'board.sqlite3')
with storage.connect(root/'board.sqlite3') as db:
 assert db.execute("SELECT 1 FROM browser_sessions WHERE user_id='bob'").fetchone() is None
 assert media.receipt(db,'listen',1,'inline')==b'synthetic-old-inline-receipt'
 assert media.read(db,sys.argv[2])==b'synthetic-shared-frozen-code'
 assert not (root/'images'/sys.argv[3][:2]/(sys.argv[3]+'.png')).exists()
print(json.dumps({'oldRecoverCount':2,'oldMediaReaders':True,'workerStarted':False}))
`,s.destination,digest(bodies.shared),digest(bodies.private)],{timeout:15000,encoding:'utf8',stdio:['ignore','pipe','pipe']});expect(JSON.parse(result)).toEqual({oldRecoverCount:2,oldMediaReaders:true,workerStarted:false});before.assertUnchanged();});
it('compares the first TypeScript historical closure with the unmodified original Python recovery implementation',async()=>{
  const s=await setup(),projected=projectRollbackBoardHistory(s.pkg,s.legacyId,stamp),reference=join(s.root,'python-reference');fs.mkdirSync(reference,{mode:0o700});fs.copyFileSync(s.oldPath,join(reference,'board.sqlite3'));fs.writeFileSync(join(reference,'board.erasures.jsonl'),projected.boardJournal,{mode:0o600});fs.cpSync(join(dirname(s.oldPath),'images'),join(reference,'images'),{recursive:true});
  execFileSync('python3',['-c',`import sys
from pathlib import Path
from qgroup_core import privacy
privacy.now=lambda:sys.argv[2]
privacy.recover(Path(sys.argv[1])/'board.sqlite3')
`,reference,projected.preparedAt],{timeout:15000,stdio:['ignore','pipe','pipe']});
  const image=fs.readFileSync(join(reference,'board.sqlite3')),python:RollbackBoardHistory={...projected,boardImage:image,images:projected.images.map(row=>({path:row.path,bytes:fs.readFileSync(join(reference,row.path))}))};expect(verifyRollbackBoardHistory(s.pkg,python)).toMatchObject({tableCount:59,imageCount:2,revokedTokens:1});
});
it.each([13,14,15] as const)('restores original native schema %i history without changing its raw bytes, lineage or declared time',async nativeSchema=>{const s=await setup({nativeSchema}),raw=s.pkg.history.sources.native[0]!.files.find(row=>row.path==='state.sqlite3')!.bytes,before=Buffer.from(raw),saved=s.prepare(s.nativeId),read=readRollbackBoardHistoryArtifact(s.destination,saved.manifestSha256,s.packageRoot,s.packagePin);expect(read.manifest.metadata).toMatchObject({schema:nativeSchema,createdAt:'2026-11-18T01:02:03.000Z',databaseSha256:digest(before)});expect(read.report).toMatchObject({tableCount:59,revokedTokens:1,imageCount:2});expect(raw).toEqual(before);readRollbackPackage(s.packageRoot,s.packagePin).assertUnchanged();});
it.each(['legacy','native'] as const)('uses earlier imported closure markers absent from the unified journal for %s history',async source=>{const s=await setup({earlyClosure:true}),projected=projectRollbackBoardHistory(s.pkg,source==='legacy'?s.legacyId:s.nativeId,stamp),db=new Database(projected.boardImage);try{expect(s.pkg.state.journal).toEqual([]);expect(projected.boardJournal).toBe('{"user_id":"bob","request_id":"original-imported-closure","created_at":"original-unknown-zone"}\n');expect(db.prepare("SELECT id,created_at FROM privacy_requests WHERE user_id='bob'").get()).toEqual({id:'original-imported-closure',created_at:'original-unknown-zone'});expect(db.prepare("SELECT nickname FROM users WHERE id='bob'").get()).toEqual({nickname:'已注销用户'});expect(projected.images).toHaveLength(2);}finally{db.close();}});
it('rejects an old completed marker whose account still has active credentials, instead of skipping deletion',async()=>{
  const s=await setup({badHistory(folder){
    const db=new Database(join(folder,'kanban-'+legacyStamp+'.sqlite3'));
    try{db.exec("INSERT INTO privacy_requests VALUES('bad-marker','bob','completed','historical','historical','')");}
    finally{db.close();}
  }});
  expect(()=>s.prepare()).toThrow('closure is not effective');
  expect(fs.existsSync(s.destination)).toBe(false);
});
it.each(['votes','ballots'] as const)('rejects surviving historical %s even when the old closure marker and credentials look complete',async kind=>{
  const s=await setup(),result=projectRollbackBoardHistory(s.pkg,s.legacyId,stamp),db=new Database(result.boardImage);
  try{
    db.prepare('INSERT INTO time_poll_ballots VALUES(?,?,?)').run('historical-poll-open','bob','historical');
    if(kind==='votes')db.prepare('INSERT INTO time_poll_votes VALUES(?,?,?,?)').run('historical-poll-open','bob','historical-poll-open-option','yes');
    const image=db.serialize();expect(()=>verifyRollbackBoardHistory(s.pkg,{...result,boardImage:image})).toThrow('private data survived');
  }finally{db.close();}
});
it.each(['bad database','WAL header','extra table','extra trigger','foreign key','asset missing','asset size','asset digest','missing archive','bad gzip'])('rejects historical %s before output reservation while preserving the raw private package',async change=>{
  const s=await setup({badHistory(folder){const database=join(folder,'kanban-'+legacyStamp+'.sqlite3'),archive=join(folder,'kanban-'+legacyStamp+'.images.tar.gz');if(change==='bad database')fs.writeFileSync(database,'corrupt');else if(change==='WAL header'){const bytes=fs.readFileSync(database);bytes[18]=2;bytes[19]=2;fs.writeFileSync(database,bytes);}else if(['extra table','extra trigger','foreign key','asset missing','asset size','asset digest'].includes(change)){const db=new Database(database);db.pragma('foreign_keys=OFF');const originalTriggers=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all() as {name:string;sql:string}[];try{if(change==='extra table')db.exec('CREATE TABLE unknown(payload)');if(change==='extra trigger')db.exec('CREATE TRIGGER unknown AFTER UPDATE ON users BEGIN SELECT 1; END');if(change==='foreign key')db.exec("INSERT INTO browser_sessions VALUES('orphan','missing','historical')");if(change==='asset missing')db.exec('DROP TRIGGER image_assets_no_delete; DROP TRIGGER image_assets_no_update; DELETE FROM image_assets');if(change==='asset size')db.exec('DROP TRIGGER image_assets_no_update; UPDATE image_assets SET size=size+1');if(change==='asset digest')db.exec("DROP TRIGGER image_assets_no_update; UPDATE image_assets SET digest='invalid' WHERE digest=(SELECT min(digest) FROM image_assets)");}finally{for(const trigger of originalTriggers)if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(trigger.name))db.exec(trigger.sql);db.close();}}else if(change==='missing archive')fs.rmSync(archive);else fs.writeFileSync(archive,'not-gzip');}});
  expect(()=>s.prepare()).toThrow();expect(fs.existsSync(s.destination)).toBe(false);readRollbackPackage(s.packageRoot,s.packagePin).assertUnchanged();
});
it.each(['token reuse','name','session','business amount','bot status','audit','image missing','image changed','ledger','metadata time','checkpoint pin','extra root'])('independently rejects changed %s without trusting reports',async change=>{const s=await setup(),result=projectRollbackBoardHistory(s.pkg,s.legacyId,stamp),copy:RollbackBoardHistory={...result,metadata:{...result.metadata},boardImage:Buffer.from(result.boardImage),images:result.images.map(row=>({path:row.path,bytes:Buffer.from(row.bytes)}))};
  if(['token reuse','name','session','business amount','bot status','audit'].includes(change)){const db=new Database(copy.boardImage),originalTriggers=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all() as {name:string;sql:string}[];try{if(change==='token reuse')db.prepare("UPDATE users SET token_hash=? WHERE id='bob'").run(hash('fixture-bob'));if(change==='name')db.exec("UPDATE users SET nickname='restored' WHERE id='bob'");if(change==='session')db.exec("INSERT INTO browser_sessions VALUES('restored','bob','historical')");if(change==='business amount')db.exec('DROP TRIGGER settlement_history_no_update; UPDATE settlement_history SET total_cents=1');if(change==='bot status')db.exec("UPDATE bot_outbox SET status='pending' WHERE status='sent'");if(change==='audit')db.exec('DROP TRIGGER admin_role_history_no_delete; DELETE FROM admin_role_history');for(const trigger of originalTriggers)if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(trigger.name))db.exec(trigger.sql);copy.boardImage=db.serialize();}finally{db.close();}}
  if(change==='image missing')copy.images.pop();if(change==='image changed')copy.images[0]!.bytes=Buffer.from('changed');if(change==='ledger')copy.boardJournal='';if(change==='metadata time')copy.metadata.createdAt=stamp.toISOString();if(change==='checkpoint pin')copy.checkpointSha256='0'.repeat(64);if(change==='extra root')Object.assign(copy,{activate:true});expect(()=>verifyRollbackBoardHistory(s.pkg,copy)).toThrow();
});
it.each(['existing output','symlink output','overlap','relative output','wrong source pin','unknown ID','async guard'])('rejects %s without overwriting sources',async change=>{const s=await setup();let root=s.destination,pin=s.packagePin,id=s.legacyId;if(change==='existing output'){fs.mkdirSync(root);fs.writeFileSync(join(root,'keep'),'other');}if(change==='symlink output')fs.symlinkSync(s.packageRoot,root);if(change==='overlap')root=join(s.packageRoot,'history');if(change==='relative output')root='relative';if(change==='wrong source pin')pin='0'.repeat(64);if(change==='unknown ID')id='unknown';expect(()=>writeRollbackBoardHistoryArtifact(s.packageRoot,pin,id,root,stamp,change==='async guard'?async()=>{}:undefined)).toThrow();if(!['existing output','symlink output'].includes(change))expect(fs.existsSync(root)).toBe(false);});
it.each([1,2,3])('detects changed source package at source guard %i and preserves late failures as incomplete',async stage=>{const s=await setup();let checks=0;expect(()=>s.prepare(s.legacyId,()=>{if(++checks===stage)fs.appendFileSync(join(s.packageRoot,'projection/music/data.json'),' ');})).toThrow();if(stage===1)expect(fs.existsSync(s.destination)).toBe(false);else expect(fs.existsSync(join(s.destination,'incomplete.json'))).toBe(true);});
it.each(['root','parent','images'])('fences a replaced %s before sealing and never writes a manifest to the replacement',async change=>{const s=await setup(),parent=join(s.root,'output-parent'),destination=join(parent,'history');fs.mkdirSync(parent,{mode:0o700});let checks=0;expect(()=>writeRollbackBoardHistoryArtifact(s.packageRoot,s.packagePin,s.legacyId,destination,stamp,()=>{if(++checks!==2)return;const target=change==='root'?destination:change==='parent'?parent:join(destination,'images');fs.renameSync(target,target+'-saved');fs.mkdirSync(target,{mode:0o700});if(change==='parent')fs.mkdirSync(destination,{mode:0o700});if(change!=='images')fs.copyFileSync(join(change==='root'?target+'-saved':parent+'-saved/history','incomplete.json'),join(destination,'incomplete.json'));fs.writeFileSync(join(change==='images'?target:destination,'keep'),'other',{mode:0o600});})).toThrow();expect(fs.existsSync(join(destination,'board-history-manifest.json'))).toBe(false);expect(fs.readFileSync(join(change==='images'?join(destination,'images'):destination,'keep'),'utf8')).toBe('other');});
it.each(['file bytes','extra file','file mode','root mode','hardlink','symlink','wrong pin','manifest view','byte view'])('rejects independent artifact %s changes',async change=>{const s=await setup(),saved=s.prepare(),read=readRollbackBoardHistoryArtifact(s.destination,saved.manifestSha256,s.packageRoot,s.packagePin),path=join(s.destination,'board.sqlite3');let pin=saved.manifestSha256;if(change==='file bytes')fs.appendFileSync(path,' ');if(change==='extra file')fs.writeFileSync(join(s.destination,'extra'),'x',{mode:0o600});if(change==='file mode')fs.chmodSync(path,0o644);if(change==='root mode')fs.chmodSync(s.destination,0o755);if(change==='hardlink')fs.linkSync(path,join(s.root,'alias'));if(change==='symlink'){fs.renameSync(path,path+'-saved');fs.symlinkSync(path+'-saved',path);}if(change==='wrong pin')pin='0'.repeat(64);if(change==='manifest view')read.manifest.preparedAt='2026-11-20T12:00:00.000Z';if(change==='byte view')read.projection.images[0]!.bytes.fill(0);if(['manifest view','byte view'].includes(change))expect(()=>read.assertUnchanged()).toThrow();else expect(()=>readRollbackBoardHistoryArtifact(s.destination,pin,s.packageRoot,s.packagePin)).toThrow();});
it('rejects a rehashed artifact DB change against its independently pinned original package',async()=>{const s=await setup();s.prepare();const path=join(s.destination,'board.sqlite3'),db=new Database(path);try{db.exec("UPDATE bot_outbox SET status='pending' WHERE status='sent'");}finally{db.close();}const manifestPath=join(s.destination,'board-history-manifest.json'),manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8')),bytes=fs.readFileSync(path),row=manifest.files.find((row:{path:string})=>row.path==='board.sqlite3');row.sha256=digest(bytes);row.size=bytes.length;const encoded=Buffer.from(JSON.stringify(manifest)+'\n');fs.writeFileSync(manifestPath,encoded);expect(()=>readRollbackBoardHistoryArtifact(s.destination,digest(encoded),s.packageRoot,s.packagePin)).toThrow();});
it.each(['ledger view','image path view','extra projection field'])('rejects a changed %s after returning independently verified bytes',async change=>{const s=await setup(),saved=s.prepare(),read=readRollbackBoardHistoryArtifact(s.destination,saved.manifestSha256,s.packageRoot,s.packagePin);if(change==='ledger view')read.projection.boardJournal='';if(change==='image path view')read.projection.images[0]!.path='images/other.png';if(change==='extra projection field')Object.assign(read.projection,{activate:true});expect(()=>read.assertUnchanged()).toThrow('projection view changed');});
it('invalidates a completed-looking artifact after an identical-byte image directory replacement at the final guard',async()=>{const s=await setup();let guards=0;expect(()=>s.prepare(s.legacyId,()=>{if(++guards!==3)return;const images=join(s.destination,'images');fs.renameSync(images,images+'-saved');fs.cpSync(images+'-saved',images,{recursive:true});fs.chmodSync(images,0o700);})).toThrow();const manifest=join(s.destination,'board-history-manifest.json');expect(fs.existsSync(manifest)).toBe(true);expect(fs.existsSync(join(s.destination,'incomplete.json'))).toBe(true);expect(()=>readRollbackBoardHistoryArtifact(s.destination,digest(fs.readFileSync(manifest)),s.packageRoot,s.packagePin)).toThrow();});
it('exposes only redacted pins/counts through preparation and verification CLI',async()=>{const s=await setup(),output=execFileSync(process.execPath,['--import','tsx','tools/migration/rollback-board-history-artifact.ts',s.packageRoot,s.packagePin,s.legacyId,s.destination],{encoding:'utf8',timeout:20000}),result=JSON.parse(output);expect(result).toMatchObject({status:'prepared_private_board_history',images:2,historyOnly:true,rollbackEligible:false});const verify=execFileSync(process.execPath,['--import','tsx','tools/migration/read-rollback-board-history.ts',s.destination,result.manifestSha256,s.packageRoot,s.packagePin],{encoding:'utf8',timeout:20000});expect(JSON.parse(verify)).toMatchObject({status:'verified_private_board_history',historyOnly:true,rollbackEligible:false});expect(output+verify).not.toMatch(/original-uncertain|original-sent|inactive-secret|inactive-bob-subject|\/Users|\/tmp/);});
function repack(tar:Buffer){return gzipSync(tar);}
it.each(['checksum','path traversal','symlink','duplicate','truncated','trailing data','missing terminator','PAX'])('rejects unsafe %s in the original tar before extracting any path',async change=>{const s=await setup({kind:'none'}),raw=fs.readFileSync(join(s.historyRoot,'kanban-'+legacyStamp+'.images.tar.gz')),tar=gunzipSync(raw);let changed=Buffer.from(tar);
  const checksum=(header:Buffer)=>{header.fill(32,148,156);const sum=header.reduce((sum,byte)=>sum+byte,0).toString(8).padStart(6,'0');header.write(sum+'\0 ',148,8,'ascii');};
  const size=parseInt(tar.subarray(124,136).toString().replace(/\0/g,'').trim(),8),next=512+Math.ceil(size/512)*512;
  if(change==='checksum')changed[0]=changed[0]!^1;if(change==='path traversal'){changed.fill(0,0,100);changed.write('../secret',0);checksum(changed.subarray(0,512));}if(change==='symlink'){changed[156]=50;checksum(changed.subarray(0,512));}if(change==='PAX'){changed[156]=120;checksum(changed.subarray(0,512));}if(change==='duplicate')changed=Buffer.concat([tar.subarray(0,next),tar]);if(change==='truncated')changed=tar.subarray(0,513);if(change==='trailing data')changed[changed.length-1]=1;if(change==='missing terminator')changed=tar.subarray(0,3*next);expect(()=>readBoardImageArchive(repack(changed))).toThrow();expect(readBoardImageArchive(raw).size).toBe(3);
});
