import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,readdirSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import Database from 'better-sqlite3';
import {afterEach,expect,it,vi} from 'vitest';
import {legacyHistoryFixture} from '../testsupport/legacy-history-fixture';
import {erasureJournal,type ErasureIntent} from './erasure-journal';
import {createPrivacy} from './privacy';
import {createPairedBackups} from './paired-backups';
import {saveProfile} from './repositories';
import {hash} from './security';
import {putPaymentImage} from './payment-media';
import {digest,profileId} from '../../../tools/migration/music-codec';
import {projectRollbackState,type RollbackState} from '../../../tools/migration/rollback-state';
import {projectRollbackHistory,type RollbackHistory} from '../../../tools/migration/rollback-history';
import {verifyRollbackHistory} from '../../../tools/migration/rollback-history-reconciliation';
import {readRollbackHistorySources,type HistoryConfig,type HistorySources} from '../../../tools/migration/rollback-history-source';
import * as native from '../../../tools/migration/rollback-history-music';

const cleanup:(()=>void)[]=[];afterEach(()=>{vi.restoreAllMocks();for(const close of cleanup.splice(0).reverse())close();});
async function setup(){const s=await legacyHistoryFixture();cleanup.push(()=>s.close());const journal=erasureJournal(s.db),backups=createPairedBackups(s.db,journal,()=>new Date('2026-11-18T01:02:03.000Z'))!,nativeRoot=join(dirname(s.db.name),'paired-backups');
  function config():HistoryConfig{return {capture:s.repin(),native:{root:nativeRoot,manifests:exists(nativeRoot)?readdirSync(nativeRoot).sort().map(id=>({id,sha256:digest(readFileSync(join(nativeRoot,id,'manifest.json')))})):[]}};}
  function freeze(){return projectRollbackState(s.db,journal);}
  function submit(fields:Record<string,unknown>){const privacy=createPrivacy(s.db,journal),entry={...fields,requestId:randomUUID(),secretHash:hash('secret'),signature:hash('command'),createdAt:'2026-11-19T02:00:00.000Z'} as ErasureIntent;s.db.transaction(()=>privacy.submit(entry)).immediate();privacy.guard();return entry;}
  return {...s,journal,backups,nativeRoot,config,freeze,submit};
}
function exists(path:string){try{readdirSync(path);return true;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;return false;}}
function cloneSources(s:HistorySources):HistorySources{return {captureManifest:Buffer.from(s.captureManifest),captureFiles:s.captureFiles.map(file=>({path:file.path,bytes:Buffer.from(file.bytes)})),native:s.native.map(row=>({id:row.id,manifest:Buffer.from(row.manifest),files:row.files.map(file=>({path:file.path,bytes:Buffer.from(file.bytes)}))}))};}
function retained(root:string){const out=new Map<string,Buffer>();const walk=(path:string,prefix='')=>{for(const entry of readdirSync(path,{withFileTypes:true})){const relative=prefix+entry.name;if(entry.isDirectory())walk(join(path,entry.name),relative+'/');else out.set(relative,readFileSync(join(path,entry.name)));}};walk(root);return out;}
function verify(state:RollbackState,result:RollbackHistory,expected:HistorySources,config:HistoryConfig){const db=new Database(state.checkpointImage);try{return db.transaction(()=>verifyRollbackHistory(db,state,result,expected,{captureManifestSha256:config.capture.manifestSha256,native:config.native.manifests})).immediate();}finally{db.close();}}
function nativeRehash(root:string,id:string){const path=join(root,id,'manifest.json'),m=JSON.parse(readFileSync(path,'utf8'));for(const file of m.files){const bytes=readFileSync(join(root,id,file.path));file.size=bytes.length;file.sha256=digest(bytes);}writeFileSync(path,JSON.stringify(m)+'\n');}

it('preserves complete raw capture/native history, colliding namespaces, unknown legacy times and current authority without source/bot writes',async()=>{
  const s=await setup();s.save(s.pair+'/erasures.jsonl','');s.save('history/board/kanban-20261118-010203-123456.sqlite3',Buffer.from('synthetic-private-board-history'));s.save('history/board/kanban-20261118-010203-123456.images.tar.gz',Buffer.from('synthetic-private-image-archive'));s.save('history/board/privacy-erasures.jsonl','');s.save('bot-evidence/bot-health.json',{state:'synthetic'});s.save('bot-evidence/bot-events.jsonl.1','{"event":"synthetic"}\n');
  s.db.prepare("INSERT INTO bot_outbox(event_id,kind,dedupe_key,target,payload_json,status,claim_token,created_at) VALUES('listen','fixed','fixed','synthetic','{}','sending','private-claim','after')").run();
  const image=Buffer.from('synthetic-private-receipt');s.db.transaction(()=>putPaymentImage(s.db,image,new Date())).immediate();const archive=s.backups.capture();
  s.db.prepare("UPDATE music_legacy_profiles SET pin_hash='LATEST-PIN' WHERE profile_id=?").run(profileId('10002'));s.db.prepare('UPDATE music_profiles SET user_id=NULL WHERE id=?').run(profileId('10002'));
  s.db.prepare("INSERT INTO music_ownership_history(profile_id,revision,actor_ref,before_user_id,after_user_id,reason,created_at) VALUES(?,1,'account:alice','bob',NULL,'unlinked','2026-11-19T01:00:00Z')").run(profileId('10002'));
  const state=s.freeze(),config=s.config(),before=s.db.serialize(),raw=retained(s.root),result=projectRollbackHistory(state,config);
  expect(result.report).toMatchObject({rollbackEligible:false,legacyPairs:1,legacyJson:1,nativeBackups:1});expect(result.projections.map(row=>row.id)).toEqual(['legacy-json-'+s.stamp,'legacy-pair-'+s.stamp,'native-'+archive.id]);
  for(const projection of result.projections){expect(projection.data.members).toHaveProperty('10002.pinHash','LATEST-PIN');expect(projection.data.members).toHaveProperty('10002.boardUserId','');expect(projection.data.settings).toEqual({});expect(JSON.stringify(projection.data)).not.toMatch(/HISTORICAL-PIN|HISTORICAL-ADMIN|private-claim|fixture-alice/);}
  expect(result.projections[0]).toMatchObject({createdAt:null,schema:null});expect(result.projections[2]).toMatchObject({createdAt:'2026-11-18T01:02:03.000Z',schema:15});
  expect(result.sources.captureFiles.find(file=>file.path.endsWith('.images.tar.gz'))?.bytes).toEqual(Buffer.from('synthetic-private-image-archive'));
  expect(result.sources.native[0]!.files.find(file=>file.path.startsWith('images/'))?.bytes).toEqual(image);
  expect(result.sources.captureFiles.find(file=>file.path===s.pair+'/data.json')?.bytes.toString()).toContain('HISTORICAL-PIN');
  const historical=new Database(result.sources.native[0]!.files.find(file=>file.path==='state.sqlite3')!.bytes);try{expect(historical.prepare('SELECT claim_token FROM bot_outbox').get()).toEqual({claim_token:'private-claim'});}finally{historical.close();}
  expect(verify(state,result,cloneSources(result.sources),config)).toEqual(result.report);expect(s.db.serialize()).toEqual(before);expect(retained(s.root)).toEqual(raw);
});
it('replays pre-reset native history while preserving every post-reset native write and generated key',async()=>{
  const s=await setup(),before=s.backups.capture();
  s.submit({version:2,kind:'admin_music',command:'reset_music',actorRef:'account:alice',profiles:s.db.prepare('SELECT id,user_id AS userId FROM music_profiles WHERE erased_at IS NULL ORDER BY rowid').all(),entries:['e']});
  s.db.prepare("INSERT INTO music_entries VALUES('after','重置後新詞條','sub')").run();const epoch=(s.db.prepare("SELECT epoch FROM music_account_epochs WHERE user_id='bob'").get() as {epoch:number}).epoch;
  const profile=saveProfile(s.db,'bob',{profileId:null,revision:0,musicEpoch:epoch,selections:[{entryId:'after',level:4}]},new Date('2026-11-19T03:00:00Z'));
  s.db.prepare("INSERT INTO music_shouts(id,profile_id,legacy_key,name,body,created_at,archived_at,ordinal) VALUES('new-shout',?,?,'合成','重置後新喊話',123,NULL,0)").run(profile.id,profile.id);
  s.db.prepare("INSERT INTO music_documents VALUES('trend_sample',0,?)").run(JSON.stringify({t:123,counts:{after:1}}));
  const after=s.backups.capture(),state=s.freeze(),config=s.config(),raw=retained(s.root),result=projectRollbackHistory(state,config),key=state.music.keys.find(row=>row.profileId===profile.id)!.legacyKey;
  const pre=result.projections.find(row=>row.id==='native-'+before.id)!,post=result.projections.find(row=>row.id==='native-'+after.id)!;
  expect(pre.data).toMatchObject({entries:{},members:{},shouts:[],shoutHistory:[],trend:[]});
  expect(post.data.members).toHaveProperty(key+'.selection',[{id:'after',level:4}]);expect(post.data.entries).toHaveProperty('after.text','重置後新詞條');expect(post.data.shouts).toEqual([{id:'new-shout',qq:key,name:'合成',text:'重置後新喊話',createdAt:123}]);expect(post.data.trend).toEqual([{t:123,counts:{after:1}}]);
  for(const legacy of result.projections.filter(row=>row.source!=='native')){expect(legacy.data.entries).toEqual({});expect(legacy.data.shouts).toEqual([]);expect(legacy.data.shoutHistory).toEqual([]);expect(legacy.data.trend).toEqual([]);expect(legacy.data.members).not.toHaveProperty('10002');expect(legacy.data.members).toHaveProperty('10004.pinHash','');}
  expect(verify(state,result,cloneSources(result.sources),config)).toEqual(result.report);expect(retained(s.root)).toEqual(raw);
});
it.each(['music','both','account'] as const)('preserves %s closure scope across legacy/native histories',async(kind)=>{
  const s=await setup(),item=s.backups.capture();s.submit({version:1,kind,userId:'bob',profileId:profileId('10002')});const result=projectRollbackHistory(s.freeze(),s.config());
  for(const row of result.projections){if(kind==='account'){expect(row.data.members).toHaveProperty('10002.boardUserId','');expect(JSON.stringify(row.data.shouts)).toContain('歷史私人喊話');}else{expect(row.data.members).not.toHaveProperty('10002');expect(JSON.stringify(row.data.shouts)).not.toContain('歷史私人喊話');expect(row.data.entries).toHaveProperty('e.createdBy','');}}
  expect(result.projections).toEqual(expect.arrayContaining([expect.objectContaining({id:'native-'+item.id})]));
});
it('uses the fixed state for history authority even after live data and journal change',async()=>{
  const s=await setup();s.backups.capture();const state=s.freeze(),config=s.config();s.submit({version:1,kind:'both',userId:'bob',profileId:profileId('10002')});s.db.prepare("UPDATE music_entries SET name='LIVE NEW VALUE' WHERE id='e'").run();
  const result=projectRollbackHistory(state,config);expect(result.projections.every(row=>Object.hasOwn(row.data.members as object,'10002'))).toBe(true);expect(result.projections.every(row=>(row.data.entries as Record<string,{text:string}>).e!.text==='歷史詞條')).toBe(true);
});
it('requires acquisition-time and optional paired music erasures and scrubs history-only members',async()=>{
  const s=await legacyHistoryFixture({musicLedger:'{"qq":"10004","erased_at":123}\n'});cleanup.push(()=>s.close());s.save(s.pair+'/erasures.jsonl','{"qq":"10004","erased_at":122}\n');
  const config={capture:s.repin(),native:{root:join(dirname(s.db.name),'paired-backups'),manifests:[]}},state=projectRollbackState(s.db,erasureJournal(s.db)),result=projectRollbackHistory(state,config);
  expect(result.projections.every(row=>!Object.hasOwn(row.data.members as object,'10004'))).toBe(true);expect(result.sources.captureFiles.find(file=>file.path===s.pair+'/erasures.jsonl')?.bytes.toString()).toContain('122');
});
it.each(['capture pin','native pin','missing capture','missing native','extra capture file','extra capture folder','extra native file','extra native folder','symlink capture file','symlink capture folder','symlink native file','foreign import','foreign lineage','optional ledger lost','optional ledger corrupt','unknown data field','duplicate data key','missing wall','broken identity','captured board intent lost','native journal lost','native receipt differs','native schema differs','omitted native image'])('rejects %s and leaves all source data inactive',async(change)=>{
  const s=await setup();s.db.transaction(()=>putPaymentImage(s.db,Buffer.from('private-image'),new Date())).immediate();const item=s.backups.capture(),base=join(s.nativeRoot,item.id);let config=s.config();const state=s.freeze(),before=s.db.serialize();
  if(change==='capture pin')config.capture.manifestSha256='0'.repeat(64);
  if(change==='native pin')config.native.manifests[0]!.sha256='0'.repeat(64);
  if(change==='missing capture')rmSync(join(s.capture,s.pair,'data.json'));
  if(change==='missing native')rmSync(join(base,'state.sqlite3'));
  if(change==='extra capture file')s.save('history/unknown.env','private');
  if(change==='extra capture folder')mkdirSync(join(s.capture,'history/unclassified'));
  if(change==='extra native file')writeFileSync(join(base,'unknown.env'),'private');
  if(change==='extra native folder')mkdirSync(join(s.nativeRoot,'unclassified'));
  if(change==='symlink capture file'){rmSync(join(s.capture,s.pair,'data.json'));symlinkSync(join(s.capture,'current/music/data.json'),join(s.capture,s.pair,'data.json'));}
  if(change==='symlink capture folder'){rmSync(join(s.capture,s.pair,'walls'),{recursive:true});symlinkSync(join(s.capture,'current/music/walls'),join(s.capture,s.pair,'walls'));}
  if(change==='symlink native file'){rmSync(join(base,'state.sqlite3'));symlinkSync(s.db.name,join(base,'state.sqlite3'));}
  if(change==='foreign import'){const fixed=new Database(state.checkpointImage);try{fixed.prepare('DELETE FROM migration_runs').run();state.checkpointImage=fixed.serialize();}finally{fixed.close();}}
  if(change==='optional ledger lost'){s.save(s.pair+'/erasures.jsonl','{"qq":"10004","erased_at":123}\n');config=s.config();}
  if(change==='optional ledger corrupt'){s.save(s.pair+'/erasures.jsonl','{"qq":"10004"}');config=s.config();}
  if(change==='unknown data field'){s.save(s.pair+'/data.json',{...s.historical,credentials:'private'});config=s.config();}
  if(change==='duplicate data key'){s.save(s.pair+'/data.json','{"members":{},"members":{},"entries":{}}');config=s.config();}
  if(change==='missing wall'){s.save(s.pair+'/walls/manifest.json',{items:[{src:'/walls/missing.png'}]});config=s.config();}
  if(change==='broken identity'){s.save(s.pair+'/identity.sqlite3',Buffer.from('private'));config=s.config();}
  if(change==='captured board intent lost'){s.save('history/board/privacy-erasures.jsonl','{"user_id":"bob","request_id":"missing","created_at":"source"}\n');config=s.config();}
  if(['foreign lineage','native journal lost','native receipt differs','native schema differs'].includes(change)){
    const db=new Database(readFileSync(join(base,'state.sqlite3')));try{
      if(change==='foreign lineage'){db.exec('DROP TRIGGER rebuild_storage_no_update');db.prepare("UPDATE rebuild_storage SET lineage_id=?").run('a'.repeat(32));const path=join(base,'manifest.json'),m=JSON.parse(readFileSync(path,'utf8'));m.lineageId='a'.repeat(32);writeFileSync(path,JSON.stringify(m));}
      if(change==='native schema differs')db.prepare('UPDATE rebuild_schema SET version=14').run();
      if(change==='native journal lost'){const entry={user_id:'bob',request_id:'missing',created_at:'source'};createPrivacy(db,{read:()=>[entry],append(){throw Error();}});writeFileSync(join(base,'state.erasures.jsonl'),JSON.stringify(entry)+'\n');}
      if(change==='native receipt differs'){const entry={version:1,kind:'music',userId:'bob',profileId:profileId('10002'),requestId:randomUUID(),secretHash:hash('secret'),signature:hash('sig'),createdAt:'2026-11-19T02:00:00.000Z'} as ErasureIntent;createPrivacy(db,{read:()=>[entry],append(){throw Error();}});db.prepare('UPDATE privacy_receipts SET signature=?').run(hash('wrong'));writeFileSync(join(base,'state.erasures.jsonl'),JSON.stringify(entry)+'\n');}
      writeFileSync(join(base,'state.sqlite3'),db.serialize());
    }finally{db.close();}nativeRehash(s.nativeRoot,item.id);config=s.config();
  }
  if(change==='omitted native image'){const path=join(base,'manifest.json'),m=JSON.parse(readFileSync(path,'utf8')),file=m.files.find((row:{path:string})=>row.path.startsWith('images/'));rmSync(join(base,file.path));rmSync(join(base,'images'),{recursive:true});m.files=m.files.filter((row:{path:string})=>!row.path.startsWith('images/'));writeFileSync(path,JSON.stringify(m));config=s.config();}
  expect(()=>projectRollbackHistory(state,config)).toThrow();expect(s.db.serialize()).toEqual(before);expect(s.db.inTransaction).toBe(false);
});
it.each(['missing raw history','changed raw history','changed raw manifest','missing native archive','changed native bytes','changed native manifest','duplicate native archive','extra raw field','changed legacy selection','changed native selection','changed authority','changed keys','invented legacy time','changed namespace','duplicate projection','missing projection','changed checkpoint digest','changed journal digest','changed version','extra component'])('independently rejects %s without trusting the projection report',async(change)=>{
  const s=await setup();s.backups.capture();const state=s.freeze(),config=s.config(),result=projectRollbackHistory(state,config),expected=cloneSources(result.sources),copy:RollbackHistory={version:1,checkpointDigest:result.checkpointDigest,journalDigest:result.journalDigest,sources:cloneSources(result.sources),projections:structuredClone(result.projections)};
  if(change==='missing raw history')copy.sources.captureFiles.pop();if(change==='changed raw history')copy.sources.captureFiles[0]!.bytes=Buffer.from('wrong');if(change==='changed raw manifest')copy.sources.captureManifest=Buffer.from('wrong');
  if(change==='missing native archive')copy.sources.native=[];if(change==='changed native bytes')copy.sources.native[0]!.files[0]!.bytes=Buffer.from('wrong');if(change==='changed native manifest')copy.sources.native[0]!.manifest=Buffer.from('wrong');if(change==='duplicate native archive')copy.sources.native.push(copy.sources.native[0]!);
  if(change==='extra raw field')Object.assign(copy.sources.captureFiles[0]!,{activate:true});
  if(change==='changed legacy selection')(copy.projections[0]!.data.members as Record<string,Record<string,unknown>>)['10002']!.selection=[];
  if(change==='changed native selection')(copy.projections[2]!.data.members as Record<string,Record<string,unknown>>)['10002']!.selection=[];
  if(change==='changed authority')(copy.projections[2]!.data.members as Record<string,Record<string,unknown>>)['10002']!.pinHash='historical-pin';
  if(change==='changed keys')copy.projections[2]!.keys[0]!.legacyKey='99999';if(change==='invented legacy time')copy.projections[0]!.createdAt='2026-11-18T01:02:03Z';if(change==='changed namespace')copy.projections[0]!.source='native';if(change==='duplicate projection')copy.projections.push(copy.projections[0]!);if(change==='missing projection')copy.projections.pop();if(change==='changed checkpoint digest')copy.checkpointDigest='0'.repeat(64);if(change==='changed journal digest')copy.journalDigest='0'.repeat(64);if(change==='changed version')Object.assign(copy,{version:2});if(change==='extra component')Object.assign(copy,{activate:true});
  expect(()=>verify(state,copy,expected,config)).toThrow();expect(verify(state,result,expected,config)).toEqual(result.report);
});
it.each(['capture bytes','capture inventory','native bytes','native inventory'])('rejects %s changed during projection and retains all original files',async(change)=>{
  const s=await setup(),item=s.backups.capture(),state=s.freeze(),config=s.config(),original=native.projectNativeHistory;
  vi.spyOn(native,'projectNativeHistory').mockImplementationOnce((...args)=>{const result=original(...args);if(change==='capture bytes')s.save(s.pair+'/data.json','changed');if(change==='capture inventory')s.save(s.pair+'/new.env','changed');if(change==='native bytes')writeFileSync(join(s.nativeRoot,item.id,'state.sqlite3'),'changed');if(change==='native inventory')mkdirSync(join(s.nativeRoot,'new'));return result;});
  const before=s.db.serialize();expect(()=>projectRollbackHistory(state,config)).toThrow(/changed|inventory/);expect(s.db.serialize()).toEqual(before);expect(exists(s.capture)).toBe(true);
});
it('lets the actual old snapshot/sanitize functions read projected reset history twice without reviving removed content',async()=>{
  const s=await setup();s.submit({version:2,kind:'admin_music',command:'reset_music',actorRef:'account:alice',profiles:s.db.prepare('SELECT id,user_id AS userId FROM music_profiles WHERE erased_at IS NULL ORDER BY rowid').all(),entries:['e']});
  const result=projectRollbackHistory(s.freeze(),s.config()),root=join(s.root,'old-history-rehearsal');mkdirSync(join(root,'paired-backups',s.stamp),{recursive:true});writeFileSync(join(root,'paired-backups',s.stamp,'data.json'),JSON.stringify(result.projections.find(row=>row.source==='legacy_pair')!.data));writeFileSync(join(root,'erasures.jsonl'),'');
  const script=`import ast,json,pathlib,re,copy,sys,types
def extracted(path,name,scope):
 tree=ast.parse(pathlib.Path(path).read_text()); node=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name==name); exec(compile(ast.Module(body=[node],type_ignores=[]),path,'exec'),scope); return scope[name]
scope={'copy':copy,'Path':pathlib.Path,'re':re,'json':json,'Rejected':RuntimeError,'upstream':types.SimpleNamespace(data={})}
scope['sanitize']=extracted('music_site/maintenance.py','sanitize',{})
snapshot=extracted('music_site/administration.py','snapshot',scope)
for _ in range(2):
 data=snapshot(sys.argv[1],sys.argv[2]); assert data['entries']=={} and data['shouts']==[] and data['shoutHistory']==[] and data['trend']==[]; assert '10002' not in data['members']; assert data['members']['10004']['pinHash']==''
print('old-snapshot-read-twice')`;
  expect(execFileSync('python3',['-c',script,root,s.stamp],{encoding:'utf8'}).trim()).toBe('old-snapshot-read-twice');
});
it('requires an explicit empty native inventory and canonical source paths, rejecting duplicate pins',async()=>{
  const s=await setup(),state=s.freeze(),config=s.config();expect(projectRollbackHistory(state,config).report.nativeBackups).toBe(0);
  const item=s.backups.capture(),latest=s.config();expect(()=>projectRollbackHistory(state,config)).toThrow('inventory');
  latest.native.manifests.push(latest.native.manifests[0]!);expect(()=>projectRollbackHistory(state,latest)).toThrow('Duplicate');
  expect(()=>projectRollbackHistory(state,{...config,capture:{...config.capture,root:s.capture+'/../capture'}})).toThrow('canonical');
  const fixed=new Database(state.checkpointImage);try{const source=readRollbackHistorySources(fixed,state.journal,s.config());expect(source.sources.native[0]!.id).toBe(item.id);source.assertUnchanged();}finally{fixed.close();}
});
it('projects schema13 backups using exact source receipts, retaining raw old bytes without inventing lineage or times',async()=>{
  const s=await setup(),item=s.backups.capture(),base=join(s.nativeRoot,item.id),path=join(base,'state.sqlite3'),db=new Database(readFileSync(path));
  try{db.exec('DROP TABLE unified_privacy_receipts; DROP TABLE unified_privacy_consents; DROP TRIGGER unified_privacy_erasure; DROP TABLE rebuild_storage; UPDATE rebuild_schema SET version=13');writeFileSync(path,db.serialize());}finally{db.close();}
  const manifestPath=join(base,'manifest.json'),m=JSON.parse(readFileSync(manifestPath,'utf8'));m.version=1;m.schema=13;delete m.lineageId;writeFileSync(manifestPath,JSON.stringify(m));nativeRehash(s.nativeRoot,item.id);
  const state=s.freeze(),config=s.config(),raw=readFileSync(path),result=projectRollbackHistory(state,config),projection=result.projections.find(row=>row.source==='native')!;
  expect(projection.schema).toBe(13);expect(projection.createdAt).toBe('2026-11-18T01:02:03.000Z');expect(projection.data.members).toHaveProperty('10002.boardUserId','bob');expect(result.sources.native[0]!.files.find(file=>file.path==='state.sqlite3')!.bytes).toEqual(raw);expect(readFileSync(path)).toEqual(raw);
  expect(verify(state,result,cloneSources(result.sources),config)).toEqual(result.report);
});
it.each(['opaque member field','unsafe numeric export','conflicting old key','schema13 missing provenance','extra schema trigger'])('rejects native %s after all checksum pins are updated',async(change)=>{
  const s=await setup(),item=s.backups.capture(),base=join(s.nativeRoot,item.id),path=join(base,'state.sqlite3'),db=new Database(readFileSync(path));
  try{
    if(change==='opaque member field')db.prepare('UPDATE music_legacy_profiles SET fields_json=? WHERE profile_id=?').run('{"credentials":"PRIVATE-UNKNOWN"}',profileId('10002'));
    if(change==='unsafe numeric export')db.prepare('UPDATE music_legacy_profiles SET fields_json=? WHERE profile_id=?').run('{"lastJoinAt":9007199254740993}',profileId('10002'));
    if(change==='conflicting old key')db.prepare("UPDATE music_legacy_profiles SET legacy_key='99999' WHERE profile_id=?").run(profileId('10002'));
    if(change==='extra schema trigger')db.exec("CREATE TRIGGER unexpected_history_trigger AFTER INSERT ON music_entries BEGIN SELECT 1; END");
    if(change==='schema13 missing provenance'){db.exec('DROP TABLE unified_privacy_receipts; DROP TABLE unified_privacy_consents; DROP TRIGGER unified_privacy_erasure; DROP TABLE rebuild_storage; UPDATE rebuild_schema SET version=13; DELETE FROM migration_runs');const manifestPath=join(base,'manifest.json'),m=JSON.parse(readFileSync(manifestPath,'utf8'));m.version=1;m.schema=13;delete m.lineageId;writeFileSync(manifestPath,JSON.stringify(m));}
    writeFileSync(path,db.serialize());
  }finally{db.close();}nativeRehash(s.nativeRoot,item.id);const state=s.freeze(),config=s.config(),before=s.db.serialize();expect(()=>projectRollbackHistory(state,config)).toThrow();expect(s.db.serialize()).toEqual(before);
});
it('retains history-only native data with deterministic old keys but clears every historical credential and contact',async()=>{
  const s=await setup(),item=s.backups.capture(),base=join(s.nativeRoot,item.id),path=join(base,'state.sqlite3'),db=new Database(readFileSync(path)),id='m_'+'c'.repeat(32);
  try{db.prepare('INSERT INTO music_profiles VALUES(?,NULL,1,?,NULL)').run(id,'2026-11-18T00:00:00Z');db.prepare('INSERT INTO music_profile_fields VALUES(?,?,?,?,?,?,0,?)').run(id,'歷史獨有原生成分','私人歷史',123,'custom',1,'2026-11-18T00:00:00Z');db.prepare('INSERT INTO music_selections VALUES(?,?,?,?)').run(id,'e',4,0);db.prepare("INSERT INTO music_profile_contacts VALUES(?,'12346','self_reported',1,'2026-11-18T00:00:00Z')").run(id);writeFileSync(path,db.serialize());}finally{db.close();}nativeRehash(s.nativeRoot,item.id);
  const state=s.freeze(),config=s.config(),result=projectRollbackHistory(state,config),projection=result.projections.find(row=>row.source==='native')!,key='m_'+digest('qgroup:rollback-music-key:v1:'+id).slice(0,24);
  expect(projection.keys).toContainEqual({profileId:id,legacyKey:key});expect(projection.data.members).toHaveProperty(key,{qq:key,name:'歷史獨有原生成分',consent:true,selection:[{id:'e',level:4}],created:[],pinHash:'',boardUserId:'',contactQQ:'',note:'私人歷史',noteAt:123,gender:'custom',genderPublic:true,createdAt:Date.parse('2026-11-18T00:00:00Z')/1000});
  expect(verify(state,result,cloneSources(result.sources),config)).toEqual(result.report);
});
it('rejects ambiguous duplicate native journal fields even when receipts, latest intent and all pins match',async()=>{
  const s=await setup(),entry={user_id:'bob',request_id:'legacy-close',created_at:'2026-11-19T01:00:00Z'};
  s.save('../candidate/unified.erasures.jsonl',JSON.stringify(entry)+'\n');createPrivacy(s.db,s.journal);
  const item=s.backups.capture(),path=join(s.nativeRoot,item.id,'state.erasures.jsonl');writeFileSync(path,'{"user_id":"bob","user_id":"bob","request_id":"legacy-close","created_at":"2026-11-19T01:00:00Z"}\n');nativeRehash(s.nativeRoot,item.id);
  const state=s.freeze(),config=s.config();expect(()=>projectRollbackHistory(state,config)).toThrow('Duplicate JSON object key');
});
