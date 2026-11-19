import * as fs from 'node:fs';
import {dirname,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {afterEach,expect,it} from 'vitest';
import {legacyHistoryFixture} from '../testsupport/legacy-history-fixture';
import {erasureJournal} from './erasure-journal';
import {createPairedBackups} from './paired-backups';
import {captureRollbackMedia} from '../../../tools/migration/rollback-media';
import {projectRollbackStateFromCheckpoint} from '../../../tools/migration/rollback-state';
import {projectRollbackHistory} from '../../../tools/migration/rollback-history';
import {assembleRollbackPackage,pinRollbackPackageSource} from '../../../tools/migration/rollback-package-codec';
import {readRollbackPackage,writeRollbackPackage} from '../../../tools/migration/rollback-package';
import {readRollbackHistoryCatalog,writeRollbackHistoryCatalog} from '../../../tools/migration/rollback-history-catalog';
import {digest} from '../../../tools/migration/music-codec';
const cleanup:(()=>void)[]=[];afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();});
const stamp=new Date('2026-11-19T10:00:00Z');
async function setup(options:{baseline?:boolean}={}){
  const s=await legacyHistoryFixture();cleanup.push(()=>s.close());const data=dirname(s.db.name),journal=erasureJournal(s.db);if(options.baseline)s.db.prepare('INSERT INTO music_legacy_erasures VALUES(?,?)').run('99998','"synthetic-original-erasure"');
  s.db.prepare("INSERT INTO bot_outbox(event_id,kind,dedupe_key,target,payload_json,status,claim_token,created_at) VALUES('listen','fixed','adapter-fixture','synthetic','{}','sending','private-claim','after')").run();
  const archive=createPairedBackups(s.db,journal,()=>new Date('2026-11-18T01:02:03Z'))!.capture(),nativeRoot=join(data,'paired-backups'),native=[{id:archive.id,sha256:digest(fs.readFileSync(join(nativeRoot,archive.id,'manifest.json')))}],media=captureRollbackMedia(s.db,journal),state=projectRollbackStateFromCheckpoint(media.checkpointImage,media.journal),history=projectRollbackHistory(state,{capture:s.config,native:{root:nativeRoot,manifests:native}}),pkg=assembleRollbackPackage(state,media,history,pinRollbackPackageSource(media,{captureManifestSha256:s.config.manifestSha256,native})),packageRoot=join(s.root,'private-package'),packagePin=writeRollbackPackage(pkg,packageRoot,[s.capture,data],stamp).manifestSha256,destination=join(s.root,'history-catalog'),old=join(s.root,'old-music');
  fs.mkdirSync(old,{mode:0o700});fs.writeFileSync(join(old,'data.json'),JSON.stringify(state.music.data)+'\n',{mode:0o600});fs.writeFileSync(join(old,'identity.sqlite3'),state.identityImage,{mode:0o600});fs.writeFileSync(join(old,'erasures.jsonl'),state.erasures.musicJournal,{mode:0o600});fs.mkdirSync(join(old,'paired-backups',s.stamp),{recursive:true,mode:0o700});fs.writeFileSync(join(old,'paired-backups',s.stamp,'data.json'),JSON.stringify(history.projections.find(row=>row.source==='legacy_pair')!.data)+'\n',{mode:0o600});
  const prepare=(guard?:()=>void)=>writeRollbackHistoryCatalog(packageRoot,packagePin,destination,stamp,guard);
  return {...s,data,archive,state,history,packageRoot,packagePin,destination,old,prepare};
}
const runtimeScript=`import http.client,importlib.util,json,os,sys,threading
from pathlib import Path
from urllib.parse import quote
root,pin,folder,case=sys.argv[1:]
os.environ['JPM_DATA']=str(Path(folder)/'data.json');os.environ['KANBAN_ORIGIN']='https://fixture.invalid';os.environ['KANBAN_MUSIC_PROXY_KEY']='synthetic-proxy-key-'+('a'*32)
from music_site import service
service.STORE=service.Store(Path(folder)/'identity.sqlite3');service.upstream.data=json.loads(Path(service.upstream.DATA_FILE).read_text())
spec=importlib.util.spec_from_file_location('rollback_overlay','tools/migration/rollback_history_runtime.py');overlay=importlib.util.module_from_spec(spec);spec.loader.exec_module(overlay)
catalog=overlay.install_rollback_history_adapter(service,root,pin)
server=service.ThreadingHTTPServer(('127.0.0.1',0),service.Handler);thread=threading.Thread(target=server.serve_forever);thread.start()
import base64
def request(path,admin=True,key=True,method='GET'):
 headers={'X-Music-Identity':base64.urlsafe_b64encode(json.dumps({'admin_actor':'synthetic-admin'} if admin else {'user_id':'synthetic-member'}).encode()).decode()}
 if key:headers['X-Music-Proxy-Key']=os.environ['KANBAN_MUSIC_PROXY_KEY']
 conn=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=5)
 try:conn.request(method,path,headers=headers);response=conn.getresponse();raw=response.read();return response.status,dict(response.getheaders()),json.loads(raw) if raw else None
 finally:conn.close()
try:
 manifest,files=catalog.read();names=[row['id'] for row in manifest['histories']];name=next(row['id'] for row in manifest['histories'] if row['source']=='legacy_pair');url='/api/admin/backup?name='+quote(name)
 assert request('/api/admin/backups',key=False)[0]==403 and request(url,key=False)[0]==403
 assert request('/api/admin/backups',admin=False)[0]==401 and request(url,admin=False)[0]==401
 if case=='normal':
  status,headers,listing=request('/api/admin/backups');assert status==200 and headers['Cache-Control']=='no-store'
  assert set(row['name'] for row in listing['backups'])==set(names+['20261118-010203'])
  for row in manifest['histories']:
   status,headers,data=request('/api/admin/backup?name='+quote(row['id']));assert status==200 and headers['Cache-Control']=='no-store'
   assert headers['Content-Disposition']=='attachment; filename="music-data-'+row['id']+'.json"'
   assert data==overlay._json(files[row['path']]);assert 'HISTORICAL-PIN' not in json.dumps(data) and 'private-claim' not in json.dumps(data)
  assert request('/api/admin/backup?name=20261118-010203')[0]==200
  assert request(url,method='HEAD')[0]==405
  assert request('/api/admin/backups?unexpected=1')[0]==400
  assert request(url+'&name=another')[0]==400
  assert request('/api/admin/backup?name=legacy-pair-19990101-000000')[0]==404
  assert request('/api/admin/backup?name=legacy-pair-../../data.json')[0]==404
  assert request('/api/admin/backup?name=invalid')[0]==400
 elif case=='current authority':
  with service.STORE.connect() as db:
   db.execute('DELETE FROM prelinks WHERE qq=?',('10002',));db.execute('DELETE FROM links WHERE qq=?',('10002',));db.execute('INSERT OR REPLACE INTO link_overrides VALUES(?,?,?,?)',('10002','',1,1000))
  service.upstream.data['members']['10002']['pinHash']='NEW-CURRENT-PIN'
  service.upstream.data['members']['10002']['contactQQ']=''
  for identifier in names:
   status,_,data=request('/api/admin/backup?name='+quote(identifier));assert status==200
   assert data['members']['10002']['pinHash']=='NEW-CURRENT-PIN' and data['members']['10002']['boardUserId']==''
   assert data['members']['10002']['contactQQ']==''
   if '10004' in data['members']:assert all(data['members']['10004'][field]=='' for field in ['pinHash','boardUserId','contactQQ'])
 elif case=='current deletion':
  with open(Path(folder)/'erasures.jsonl','a') as ledger:ledger.write(json.dumps({'qq':'10002','erased_at':1001})+'\\n')
  for identifier in names:
   status,_,data=request('/api/admin/backup?name='+quote(identifier));assert status==200 and '10002' not in data['members'];assert data['entries']['e']['createdBy']=='';assert all(row['qq']!='10002' for row in data['shouts']+data['shoutHistory'])
 elif case=='observed ledger rollback':
  path=Path(folder)/'erasures.jsonl';baseline=path.read_bytes()
  with path.open('a') as ledger:ledger.write(json.dumps({'qq':'10002','erased_at':1001})+'\\n')
  assert request(url)[0]==200;path.write_bytes(baseline);assert request(url)[0]==503
 elif case=='missing ledger':
  (Path(folder)/'erasures.jsonl').unlink();status,_,data=request(url);assert status==503 and folder not in json.dumps(data)
 elif case=='lost baseline':
  (Path(folder)/'erasures.jsonl').write_text('');assert request(url)[0]==503
 elif case=='bad ledger':
  (Path(folder)/'erasures.jsonl').write_text('{"qq":"10002","qq":"10001","erased_at":1}\\n');assert request(url)[0]==503
 elif case=='missing identity':
  (Path(folder)/'identity.sqlite3').unlink();assert request(url)[0]==503 and not (Path(folder)/'identity.sqlite3').exists()
 elif case=='changed catalog':
  (Path(root)/manifest['histories'][0]['path']).write_text('{}');status,_,data=request('/api/admin/backups');assert status==503 and root not in json.dumps(data)
 elif case=='extra catalog':
  (Path(root)/'private.sqlite3').write_text('synthetic');assert request('/api/admin/backups')[0]==503
 elif case=='replaced root':
  source=Path(root);source.rename(str(source)+'-saved');source.mkdir(mode=0o700);assert request('/api/admin/backups')[0]==503
 else:raise AssertionError('Unknown isolated case')
 print(json.dumps({'case':case,'historyCount':len(names),'realOldHttp':True,'rollbackEligible':False}))
finally:server.shutdown();server.server_close();thread.join()
`;
it('builds a fixed three-namespace catalog from the full package without exporting raw credentials/DB/history assets or inventing old timestamps',async()=>{const s=await setup(),before=s.db.serialize(),saved=s.prepare(),read=readRollbackHistoryCatalog(s.destination,saved.manifestSha256);expect(saved.rollbackEligible).toBe(false);expect(read.manifest.histories).toHaveLength(3);expect(read.manifest.histories.map(row=>row.sourceStamp)).toEqual([s.stamp,s.stamp,s.archive.id]);expect(read.manifest.histories.slice(0,2).every(row=>row.createdAt===null&&row.schema===null)).toBe(true);expect(read.manifest.histories[2]).toMatchObject({createdAt:'2026-11-18T01:02:03.000Z',schema:15});for(const row of read.manifest.histories)expect(JSON.parse(fs.readFileSync(join(s.destination,row.path),'utf8'))).toEqual(s.history.projections.find(projection=>projection.id===row.id)!.data);expect(fs.readdirSync(s.destination).sort()).toEqual(['baseline-music.erasures.jsonl','histories','history-catalog-manifest.json']);read.assertUnchanged();readRollbackPackage(s.packageRoot,s.packagePin).assertUnchanged();expect(s.db.serialize()).toEqual(before);});
it.each(['normal','current authority','current deletion','observed ledger rollback','missing ledger','lost baseline','bad ledger','missing identity','changed catalog','extra catalog','replaced root'])('rehearses %s through the actual isolated old HTTP Handler and explicit overlay, retaining original endpoints and bot/package sources',async scenario=>{const s=await setup({baseline:scenario==='lost baseline'}),before=s.db.serialize(),saved=s.prepare(),result=execFileSync('python3',['-c',runtimeScript,s.destination,saved.manifestSha256,s.old,scenario],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:20000});expect(JSON.parse(result)).toMatchObject({case:scenario,realOldHttp:true,historyCount:3,rollbackEligible:false});readRollbackPackage(s.packageRoot,s.packagePin).assertUnchanged();expect(s.db.serialize()).toEqual(before);});
it.each(['existing directory','existing file','symlink','overlap','noncanonical','wrong pin','async guard'])('rejects %s before overwriting any source or sealing a catalog',async change=>{const s=await setup();let destination=s.destination,pin=s.packagePin;if(change==='existing directory'){fs.mkdirSync(destination,{mode:0o700});fs.writeFileSync(join(destination,'keep'),'other');}if(change==='existing file')fs.writeFileSync(destination,'other');if(change==='symlink')fs.symlinkSync(s.packageRoot,destination);if(change==='overlap')destination=join(s.packageRoot,'catalog');if(change==='noncanonical')destination='relative';if(change==='wrong pin')pin='0'.repeat(64);expect(()=>writeRollbackHistoryCatalog(s.packageRoot,pin,destination,stamp,change==='async guard'?async()=>{}:undefined)).toThrow();if(!['existing directory','existing file','symlink'].includes(change))expect(fs.existsSync(destination)).toBe(false);});
it.each([1,2,3])('invalidates a changed original package at catalog source guard %i and preserves a private partial after reservation',async stage=>{const s=await setup();let checks=0;expect(()=>s.prepare(()=>{if(++checks===stage)fs.appendFileSync(join(s.packageRoot,'projection/music/data.json'),' ');})).toThrow();expect(checks).toBe(stage);if(stage===1)expect(fs.existsSync(s.destination)).toBe(false);else{expect(fs.existsSync(join(s.destination,'incomplete.json'))).toBe(true);expect(()=>readRollbackHistoryCatalog(s.destination,'0'.repeat(64))).toThrow();}});
it.each(['root','parent','histories'])('fences a replaced catalog %s at the last guard and leaves other ownership untouched',async change=>{const s=await setup(),parent=join(s.root,'output-parent'),destination=join(parent,'catalog');fs.mkdirSync(parent,{mode:0o700});let checks=0;expect(()=>writeRollbackHistoryCatalog(s.packageRoot,s.packagePin,destination,stamp,()=>{if(++checks!==3)return;const target=change==='root'?destination:change==='parent'?parent:join(destination,'histories');fs.renameSync(target,target+'-saved');fs.mkdirSync(target,{mode:0o700});if(change==='parent')fs.mkdirSync(destination,{mode:0o700});fs.writeFileSync(join(change==='histories'?target:destination,'keep'),'other');})).toThrow();if(change==='histories')expect(fs.existsSync(join(destination,'incomplete.json'))).toBe(true);else expect(fs.readdirSync(destination)).toEqual(['keep']);});
it.each(['payload','missing file','extra file','public root','public file','hardlink','symlink','wrong pin','manifest view'])('rejects catalog %s changes independently',async change=>{const s=await setup(),saved=s.prepare(),read=readRollbackHistoryCatalog(s.destination,saved.manifestSha256),path=join(s.destination,read.manifest.histories[0]!.path);let pin=saved.manifestSha256;if(change==='payload')fs.appendFileSync(path,' ');if(change==='missing file')fs.rmSync(path);if(change==='extra file')fs.writeFileSync(join(s.destination,'extra'),'extra',{mode:0o600});if(change==='public root')fs.chmodSync(s.destination,0o755);if(change==='public file')fs.chmodSync(path,0o644);if(change==='hardlink')fs.linkSync(path,join(s.root,'extra-link'));if(change==='symlink'){fs.rmSync(path);fs.symlinkSync(join(s.packageRoot,'projection/music/data.json'),path);}if(change==='wrong pin')pin='0'.repeat(64);if(change==='manifest view')read.manifest.createdAt='2026-11-20T00:00:00Z';if(change==='manifest view')expect(()=>read.assertUnchanged()).toThrow();else expect(()=>readRollbackHistoryCatalog(s.destination,pin)).toThrow();});
it.each(['name','path','fake time','lost row','duplicate row','eligible'])('rejects rehashed %s metadata against the strict namespace/inventory contract',async change=>{const s=await setup();s.prepare();const path=join(s.destination,'history-catalog-manifest.json'),manifest=JSON.parse(fs.readFileSync(path,'utf8'));if(change==='name')manifest.histories[0].id='20261118-010203';if(change==='path')manifest.histories[0].path='../private.json';if(change==='fake time')manifest.histories[0].createdAt='2026-11-18T01:02:03Z';if(change==='lost row')manifest.histories.pop();if(change==='duplicate row')manifest.histories.push(manifest.histories[0]);if(change==='eligible')manifest.rollbackEligible=true;const raw=Buffer.from(JSON.stringify(manifest)+'\n');fs.writeFileSync(path,raw);expect(()=>readRollbackHistoryCatalog(s.destination,digest(raw))).toThrow();});
it('prepares the catalog through a redacted CLI without starting HTTP or revealing raw history',async()=>{const s=await setup(),stdout=execFileSync(process.execPath,['--import','tsx','tools/migration/rollback-history-catalog.ts',s.packageRoot,s.packagePin,s.destination],{encoding:'utf8'}),result=JSON.parse(stdout);expect(result).toMatchObject({status:'prepared_private_history_catalog',histories:3,rollbackEligible:false});expect(stdout).not.toMatch(/HISTORICAL|PIN|private-claim|\/tmp|\/Users/);readRollbackHistoryCatalog(s.destination,result.manifestSha256).assertUnchanged();});
