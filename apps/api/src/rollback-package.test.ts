import * as fs from 'node:fs';
import {dirname,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {afterEach,expect,it,vi} from 'vitest';
import Database from 'better-sqlite3';
import {legacyHistoryFixture} from '../testsupport/legacy-history-fixture';
import {erasureJournal} from './erasure-journal';
import {createPairedBackups} from './paired-backups';
import {putPaymentImage} from './payment-media';
import {createApp} from './app';
import {captureRollbackMedia} from '../../../tools/migration/rollback-media';
import {projectRollbackStateFromCheckpoint} from '../../../tools/migration/rollback-state';
import {projectRollbackHistory} from '../../../tools/migration/rollback-history';
import * as codec from '../../../tools/migration/rollback-package-codec';
import {readRollbackPackage,writeRollbackPackage} from '../../../tools/migration/rollback-package';
import {digest} from '../../../tools/migration/music-codec';
vi.mock('node:fs',async importOriginal=>{const real=await importOriginal<typeof import('node:fs')>();return {...real,fsyncSync:vi.fn(real.fsyncSync)};});
const cleanup:(()=>void)[]=[];afterEach(()=>{vi.restoreAllMocks();vi.mocked(fs.fsyncSync).mockReset();for(const close of cleanup.splice(0).reverse())close();});
function originals(root:string){const files=new Map<string,Buffer>();function walk(path:string,prefix=''){for(const file of fs.readdirSync(path,{withFileTypes:true})){const relative=prefix+file.name;if(file.isDirectory())walk(join(path,file.name),relative+'/');else files.set(relative,fs.readFileSync(join(path,file.name)));}}walk(root);return files;}
async function setup(options:{schema14?:boolean}={}){
  const s=await legacyHistoryFixture();cleanup.push(()=>s.close());const current=dirname(s.db.name),journal=erasureJournal(s.db);
  s.db.prepare("INSERT INTO user_admin_roles VALUES('alice',1,1,'synthetic')").run();
  const raw=Buffer.from('synthetic-private-receipt'),image=s.db.transaction(()=>putPaymentImage(s.db,raw,new Date())).immediate();
  s.db.prepare("INSERT INTO bot_outbox(event_id,kind,dedupe_key,target,payload_json,status,claim_token,created_at) VALUES('listen','fixed','fixed','synthetic','{}','sending','private-claim','after')").run();
  const backup=createPairedBackups(s.db,journal,()=>new Date('2026-11-19T00:00:00Z'))!.capture(),nativeRoot=join(current,'paired-backups');
  if(options.schema14){const base=join(nativeRoot,backup.id),path=join(base,'state.sqlite3'),copy=new Database(fs.readFileSync(path));try{copy.exec('DROP TABLE unified_privacy_receipts; DROP TABLE unified_privacy_consents; DROP TRIGGER unified_privacy_erasure; UPDATE rebuild_schema SET version=14');fs.writeFileSync(path,copy.serialize());}finally{copy.close();}const mPath=join(base,'manifest.json'),manifest=JSON.parse(fs.readFileSync(mPath,'utf8'));manifest.schema=14;const file=manifest.files.find((row:{path:string})=>row.path==='state.sqlite3'),raw=fs.readFileSync(path);file.size=raw.length;file.sha256=digest(raw);fs.writeFileSync(mPath,JSON.stringify(manifest)+'\n');}
  const native=[{id:backup.id,sha256:digest(fs.readFileSync(join(nativeRoot,backup.id,'manifest.json')))}],media=captureRollbackMedia(s.db,journal),pins=codec.pinRollbackPackageSource(media,{captureManifestSha256:s.config.manifestSha256,native});
  const state=projectRollbackStateFromCheckpoint(media.checkpointImage,media.journal),history=projectRollbackHistory(state,{capture:s.config,native:{root:nativeRoot,manifests:native}}),pkg=codec.assembleRollbackPackage(state,media,history,pins),destination=join(s.root,'rollback-package'),sourceRoots=[s.capture,current];
  function save(){return writeRollbackPackage(pkg,destination,sourceRoots,new Date('2026-11-19T08:00:00Z'));}
  return {...s,current,journal,raw,image,backup,media,state,history,pkg,destination,sourceRoots,save};
}
it('seals every domain with private modes, full source pins and exact raw bytes, and reconstructs the same fixed state without source/bot writes',async()=>{
  const s=await setup(),before=s.db.serialize(),capture=originals(s.capture),current=originals(s.current),result=s.save(),read=readRollbackPackage(s.destination,result.manifestSha256);
  expect(result.status).toBe('sealed_private_package');expect(result.rollbackEligible).toBe(false);expect(read.report.rollbackEligible).toBe(false);expect(read.state.checkpointImage).toEqual(s.state.checkpointImage);expect(read.state.boardImage).toEqual(s.state.boardImage);expect(read.state.identityImage).toEqual(s.state.identityImage);expect(read.state.music).toEqual(s.state.music);expect(read.state.erasures).toEqual(s.state.erasures);expect(read.history.projections).toEqual(s.history.projections);
  expect(read.manifest.createdAt).toBe('2026-11-19T08:00:00.000Z');expect(fs.existsSync(join(s.destination,'incomplete.json'))).toBe(false);
  for(const [path,bytes] of capture)expect(fs.readFileSync(join(s.destination,'private/legacy-capture',path))).toEqual(bytes);
  expect(fs.readFileSync(join(s.destination,'projection/board/images',s.image.slice(0,2),s.image+'.png'))).toEqual(s.raw);
  const db=new Database(read.state.boardImage);try{expect(db.prepare('SELECT claim_token FROM bot_outbox').get()).toEqual({claim_token:'private-claim'});}finally{db.close();}
  function modes(root:string){expect(fs.statSync(root).mode&0o7777).toBe(0o700);for(const file of fs.readdirSync(root,{withFileTypes:true})){const path=join(root,file.name);if(file.isDirectory())modes(path);else expect(fs.statSync(path).mode&0o7777).toBe(0o600);}}modes(s.destination);
  read.assertUnchanged();expect(s.db.serialize()).toEqual(before);expect(originals(s.capture)).toEqual(capture);expect(originals(s.current)).toEqual(current);
});
it.each(['existing directory','existing file','destination symlink','source descendant','source ancestor','root source','noncanonical path','missing source roots'])('rejects %s without overwriting or modifying a source',async(change)=>{
  const s=await setup(),before=s.db.serialize();let destination=s.destination,roots=s.sourceRoots;
  if(change==='existing directory'){fs.mkdirSync(destination,{mode:0o700});fs.writeFileSync(join(destination,'keep'),'private');}
  if(change==='existing file')fs.writeFileSync(destination,'private');if(change==='destination symlink')fs.symlinkSync(s.capture,destination);
  if(change==='source descendant')destination=join(s.capture,'package');if(change==='source ancestor')destination=s.root;if(change==='root source')roots=['/'];if(change==='noncanonical path')destination=s.destination+'/../package';if(change==='missing source roots')roots=[];
  expect(()=>writeRollbackPackage(s.pkg,destination,roots)).toThrow();expect(s.db.serialize()).toEqual(before);
  if(change==='existing directory')expect(fs.readFileSync(join(destination,'keep'),'utf8')).toBe('private');if(change==='existing file')expect(fs.readFileSync(destination,'utf8')).toBe('private');if(change==='destination symlink')expect(fs.lstatSync(destination).isSymbolicLink()).toBe(true);
});
it.each(['source pin','media bytes','board data','music identity','history selection','fake eligibility'])('verifies %s before reserving an output and never trusts caller reports',async(change)=>{
  const s=await setup();if(change==='source pin')s.pkg.sourcePins.checkpointSha256='0'.repeat(64);if(change==='media bytes')s.pkg.media.originalFiles[0]!.bytes=Buffer.from('wrong');
  if(change==='board data'){const db=new Database(s.pkg.state.boardImage);try{db.prepare("UPDATE users SET nickname='wrong' WHERE id='alice'").run();s.pkg.state.boardImage=db.serialize();}finally{db.close();}}
  if(change==='music identity')s.pkg.state.music.data.members={};if(change==='history selection')s.pkg.history.projections[0]!.data.members={};
  if(change==='fake eligibility'){Object.assign(s.pkg.report,{rollbackEligible:true});const result=s.save();expect(result.rollbackEligible).toBe(false);expect(readRollbackPackage(s.destination,result.manifestSha256).report.rollbackEligible).toBe(false);return;}
  expect(()=>s.save()).toThrow();expect(fs.existsSync(s.destination)).toBe(false);
});
it.each(['wrong pin','manifest bytes','missing file','extra file','extra folder','file symlink','folder symlink','hardlinked file','public file','public folder','public root'])('rejects stored %s and leaves all evidence intact',async(change)=>{
  const s=await setup(),saved=s.save(),file=join(s.destination,'projection/music/data.json');let pin=saved.manifestSha256;
  if(change==='wrong pin')pin='0'.repeat(64);if(change==='manifest bytes')fs.appendFileSync(join(s.destination,'rollback-manifest.json'),' ');if(change==='missing file')fs.rmSync(file);if(change==='extra file')fs.writeFileSync(join(s.destination,'extra'),'private',{mode:0o600});if(change==='extra folder')fs.mkdirSync(join(s.destination,'extra'),{mode:0o700});
  if(change==='file symlink'){fs.rmSync(file);fs.symlinkSync(join(s.capture,'current/music/data.json'),file);}if(change==='folder symlink'){fs.renameSync(join(s.destination,'projection/music'),join(s.destination,'moved-music'));fs.symlinkSync(join(s.destination,'moved-music'),join(s.destination,'projection/music'));}
  if(change==='hardlinked file')fs.linkSync(file,join(s.root,'linked-private-file'));if(change==='public file')fs.chmodSync(file,0o644);if(change==='public folder')fs.chmodSync(join(s.destination,'projection/music'),0o755);if(change==='public root')fs.chmodSync(s.destination,0o755);
  expect(()=>readRollbackPackage(s.destination,pin)).toThrow();expect(fs.existsSync(s.destination)).toBe(true);
});
it.each(['changed projection','changed private media','changed raw capture','traversal index','duplicate files','unknown metadata','eligible flag'])('rejects %s even with a new valid output manifest hash',async(change)=>{
  const s=await setup();s.save();const path=join(s.destination,'rollback-manifest.json'),manifest=JSON.parse(fs.readFileSync(path,'utf8'));
  function changeFile(relative:string,mutate:(data:any)=>void){const path=join(s.destination,relative),data=JSON.parse(fs.readFileSync(path,'utf8'));mutate(data);fs.writeFileSync(path,JSON.stringify(data)+'\n');const file=manifest.files.find((file:{path:string})=>file.path===relative),bytes=fs.readFileSync(path);file.size=bytes.length;file.sha256=digest(bytes);}
  if(change==='changed projection')changeFile('projection/music/data.json',data=>{data.members['10002'].boardUserId='alice';});
  if(change==='changed private media'){const file=manifest.files.find((file:{path:string})=>file.path==='private/original-media/walls/manifest.json');fs.writeFileSync(join(s.destination,file.path),'wrong');file.size=5;file.sha256=digest('wrong');}
  if(change==='changed raw capture'){const file=manifest.files.find((file:{path:string})=>file.path.startsWith('private/legacy-capture/history/music/')&&file.path.endsWith('/data.json'));fs.writeFileSync(join(s.destination,file.path),'{}');file.size=2;file.sha256=digest('{}');}
  if(change==='traversal index')changeFile('private/latest/media-index.json',data=>{data.originalFiles=['../outside'];});if(change==='duplicate files')manifest.files[1]=manifest.files[0];if(change==='unknown metadata')manifest.activation=true;if(change==='eligible flag')manifest.rollbackEligible=true;
  const encoded=JSON.stringify(manifest)+'\n';fs.writeFileSync(path,encoded);expect(()=>readRollbackPackage(s.destination,digest(encoded))).toThrow();
});
it.each(['fsync failure','preseal validation failure','postseal validation failure','directory replacement'])('retains an unusable private partial directory after %s',async(change)=>{
  const s=await setup(),decode=codec.decodeRollbackPackage;
  if(change==='fsync failure')vi.mocked(fs.fsyncSync).mockImplementationOnce(()=>{throw Error('synthetic fsync failure');});
  if(change==='preseal validation failure')vi.spyOn(codec,'decodeRollbackPackage').mockImplementationOnce(()=>{throw Error('synthetic validation failure');});
  if(change==='postseal validation failure')vi.spyOn(codec,'decodeRollbackPackage').mockImplementationOnce(decode).mockImplementationOnce(()=>{throw Error('synthetic postseal failure');});
  if(change==='directory replacement')vi.spyOn(codec,'decodeRollbackPackage').mockImplementationOnce((...args)=>{const result=decode(...args);fs.renameSync(s.destination,s.destination+'-saved');fs.mkdirSync(s.destination,{mode:0o700});fs.writeFileSync(join(s.destination,'keep'),'user-owned',{mode:0o600});return result;});
  expect(()=>s.save()).toThrow();vi.restoreAllMocks();expect(fs.existsSync(s.destination)).toBe(true);
  if(change==='directory replacement'){expect(fs.readFileSync(join(s.destination,'keep'),'utf8')).toBe('user-owned');expect(fs.existsSync(s.destination+'-saved')).toBe(true);}
  else{expect(fs.existsSync(join(s.destination,'incomplete.json'))).toBe(true);expect(()=>readRollbackPackage(s.destination,digest(fs.existsSync(join(s.destination,'rollback-manifest.json'))?fs.readFileSync(join(s.destination,'rollback-manifest.json')):Buffer.from('missing')))).toThrow();expect(()=>s.save()).toThrow();}
});
it('keeps a returned package pinned and rejects later bytes or inventory changes',async()=>{
  const s=await setup(),saved=s.save(),read=readRollbackPackage(s.destination,saved.manifestSha256);read.assertUnchanged();fs.appendFileSync(join(s.destination,'projection/music/data.json'),' ');expect(()=>read.assertUnchanged()).toThrow();
});
it('verifies a pinned private package through the CLI and redacts rejected paths or raw credentials',async()=>{
  const s=await setup(),saved=s.save(),cli='tools/migration/read-rollback-package.ts',runtime=join(process.cwd(),'node_modules/.bin/tsx');
  const result=execFileSync(runtime,[cli,s.destination,saved.manifestSha256],{encoding:'utf8'});expect(JSON.parse(result)).toMatchObject({status:'verified_private_package',rollbackEligible:false});expect(result).not.toMatch(/HISTORICAL-PIN|private-claim|fixture-alice|\/Users|\/tmp/);
  try{execFileSync(runtime,[cli,s.destination,'0'.repeat(64)],{encoding:'utf8',stdio:['ignore','pipe','pipe']});throw Error('Expected CLI rejection');}catch(error){expect(error).toHaveProperty('status',1);expect(String((error as {stderr?:string}).stderr)).toContain('Rollback package rejected');expect(String((error as {stderr?:string}).stderr)).not.toContain(s.destination);}
});
it('syncs every payload file and all directories before publishing the final manifest',async()=>{
  const s=await setup(),real=await vi.importActual<typeof import('node:fs')>('node:fs'),events:{directory:boolean;published:boolean}[]=[];
  vi.mocked(fs.fsyncSync).mockImplementation(fd=>{events.push({directory:fs.fstatSync(fd).isDirectory(),published:fs.existsSync(join(s.destination,'rollback-manifest.json'))});real.fsyncSync(fd);});
  const decode=codec.decodeRollbackPackage;vi.spyOn(codec,'decodeRollbackPackage').mockImplementationOnce((...args)=>{expect(fs.existsSync(join(s.destination,'rollback-manifest.json'))).toBe(false);expect(fs.existsSync(join(s.destination,'incomplete.json'))).toBe(true);return decode(...args);});
  const saved=s.save();expect(events.filter(event=>!event.directory&&!event.published)).toHaveLength(saved.files+1);expect(events.filter(event=>!event.directory&&event.published)).toHaveLength(1);expect(events.filter(event=>event.directory&&!event.published).length).toBeGreaterThan(2);expect(events.filter(event=>event.directory&&event.published).length).toBeGreaterThan(0);
});
it('keeps version2 schema14 archives readable, upgrades only disposable copies, and preserves their original schema and bytes in the package',async()=>{
  const s=await setup({schema14:true}),base=join(s.current,'paired-backups',s.backup.id),original=fs.readFileSync(join(base,'state.sqlite3')),backups=createPairedBackups(s.db,s.journal,()=>new Date())!;
  expect(backups.list()[0]!.schema).toBe(14);const copy=backups.open(s.backup.id,s.state.journal);try{expect(copy.prepare('SELECT version FROM rebuild_schema').get()).toEqual({version:15});expect(copy.prepare('SELECT count(*) AS n FROM unified_privacy_consents').get()).toEqual({n:0});expect(copy.prepare('SELECT claim_token FROM bot_outbox').get()).toEqual({claim_token:'private-claim'});}finally{copy.close();}
  const saved=s.save(),read=readRollbackPackage(s.destination,saved.manifestSha256);expect(read.history.projections.find(row=>row.source==='native')!.schema).toBe(14);expect(read.history.sources.native[0]!.files.find(file=>file.path==='state.sqlite3')!.bytes).toEqual(original);expect(fs.readFileSync(join(base,'state.sqlite3'))).toEqual(original);expect(read.report.rollbackEligible).toBe(false);
  const app=createApp({db:s.db,origin:'https://rebuild.example',pairedBackupScheduling:false});await app.ready();try{const cookie='kanban_session=fixture-alice',viewer=(await app.inject({url:'/api/v2/session',headers:{cookie}})).json(),response=await app.inject({url:'/api/v2/admin/music-export?backup='+s.backup.id,headers:{cookie,'x-account-scope':viewer.scope}});expect(response.statusCode,response.body).toBe(200);expect(response.json().members['10002']).toMatchObject({qq:'10002',boardUserId:'bob'});expect(fs.readFileSync(join(base,'state.sqlite3'))).toEqual(original);}finally{await app.close();}
});
