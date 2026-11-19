import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,realpathSync,renameSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach,expect,it,vi} from 'vitest';
import Database from 'better-sqlite3';
import {openDatabase} from '@qgroup/database';
import sharp from 'sharp';
import {legacyHistoryFixture} from '../testsupport/legacy-history-fixture';
import {fixture} from '../testsupport/fixture';
import {putPaymentImage} from './payment-media';
import {erasureJournal} from './erasure-journal';
import {createPrivacy} from './privacy';
import {hash} from './security';
import {captureRollbackMedia,type RollbackMedia} from '../../../tools/migration/rollback-media';
import * as reconciliation from '../../../tools/migration/rollback-media-reconciliation';
import {projectRollbackBoard} from '../../../tools/migration/rollback-board';
import {verifyRollbackBoard} from '../../../tools/migration/rollback-board-reconciliation';
import {digest} from '../../../tools/migration/music-codec';
import {projectRollbackStateFromCheckpoint} from '../../../tools/migration/rollback-state';
const cleanup:(()=>void)[]=[];afterEach(()=>{vi.restoreAllMocks();for(const close of cleanup.splice(0).reverse())close();});
const a='w_'+'a'.repeat(24),b='w_'+'b'.repeat(24),missing='w_'+'c'.repeat(24);
async function setup(){
  const s=await legacyHistoryFixture();cleanup.push(()=>s.close());const root=dirname(s.db.name),journal=erasureJournal(s.db);
  const raw=await sharp({create:{width:2,height:2,channels:3,background:'#f00'}}).png().toBuffer(),next=await sharp({create:{width:2,height:2,channels:3,background:'#00f'}}).png().toBuffer();
  const key=s.db.transaction(()=>putPaymentImage(s.db,raw,new Date('2026-11-19T04:00:00Z'))).immediate();
  s.db.prepare("INSERT INTO user_payment_codes VALUES('private-code','bob','wechat','原收款碼',?,'before',NULL)").run(key);
  for(const version of [1,2]){
    s.db.prepare("INSERT INTO settlement_history(event_id,version,total_cents,headcount,note,qr_image,updated_at,actor_id,actor_name,kind,changed_fields) VALUES('listen',?,100,2,'原結算',?,'before','alice','原作者','synthetic','[]')").run(version,next);
    s.db.prepare("INSERT INTO settlement_details VALUES('listen',?,'{}')").run(version);
    s.db.prepare("INSERT INTO settlement_receipts VALUES('listen',?,'inline',?)").run(version,next);
    s.db.prepare("INSERT INTO settlement_code_images VALUES('listen',?,'wechat','原圖',?)").run(version,key);
    s.db.prepare("INSERT INTO settlement_receipt_images VALUES('listen',?,'file',?)").run(version,key);
  }
  s.db.prepare("INSERT INTO settlements(event_id,total_cents,headcount,qr_image,updated_at) VALUES('listen',100,2,?,'before')").run(next);
  const manifest=JSON.stringify({items:[{src:'/walls/original.png',enabled:false},{src:'/walls/second.png',name:'第二張'},{src:'/walls/missing.webp',name:'原本遺失'}],rotateSeconds:'12'},null,2);
  s.db.prepare('UPDATE wallpaper_config SET initialized=1,rotate_seconds=12,legacy_manifest_json=? WHERE id=1').run(manifest);
  s.db.prepare("INSERT INTO wallpaper_assets VALUES(?,'image/png',?,?)").run(digest(raw),raw,raw.length);
  s.db.prepare('INSERT INTO wallpaper_items VALUES(?,?,?,?,?,?)').run(a,'/walls/original.png','original.png',0,0,digest(raw));
  s.db.prepare('INSERT INTO wallpaper_items VALUES(?,?,?,?,?,?)').run(b,'/walls/second.png','第二張',1,4,digest(raw));
  s.db.prepare('INSERT INTO wallpaper_items VALUES(?,?,?,?,?,NULL)').run(missing,'/walls/missing.webp','原本遺失',1,9);
  writeFileSync(join(root,'walls/manifest.json'),manifest,{mode:0o600});writeFileSync(join(root,'walls/original.png'),raw,{mode:0o600});writeFileSync(join(root,'walls/second.png'),raw,{mode:0o600});
  const orphan=Buffer.from('unreferenced-private-image'),orphanKey=digest(orphan);mkdirSync(join(root,'images',orphanKey.slice(0,2)),{recursive:true,mode:0o700});writeFileSync(join(root,'images',orphanKey.slice(0,2),orphanKey+'.png'),orphan,{mode:0o600});
  const result=()=>captureRollbackMedia(s.db,journal);
  return {...s,root,journal,raw,next,key,orphan,orphanKey,manifest,result};
}
function clone(value:RollbackMedia):RollbackMedia{return {...value,checkpointImage:Buffer.from(value.checkpointImage),journal:structuredClone(value.journal),originalFiles:value.originalFiles.map(file=>({...file,bytes:Buffer.from(file.bytes)})),boardImages:value.boardImages.map(file=>({...file,bytes:Buffer.from(file.bytes)})),walls:{...value.walls,mapping:structuredClone(value.walls.mapping),archivedFields:[...value.walls.archivedFields],files:value.walls.files.map(file=>({...file,bytes:Buffer.from(file.bytes)}))}};}
it('captures referenced and orphan image bytes, exact unchanged wall manifest and missing wall state without changing source',async()=>{
  const s=await setup(),before=s.db.serialize(),result=s.result();
  expect(result.boardImages).toEqual([{digest:s.key,bytes:s.raw}]);expect(result.walls.manifest).toBe(s.manifest);expect(result.walls.files).toEqual([{source:'/walls/original.png',digest:s.key,bytes:s.raw},{source:'/walls/second.png',digest:s.key,bytes:s.raw}]);
  expect(result.walls.mapping).toEqual([{id:a,source:'/walls/original.png',digest:s.key,position:'0',missing:false},{id:b,source:'/walls/second.png',digest:s.key,position:'4',missing:false},{id:missing,source:'/walls/missing.webp',digest:null,position:'9',missing:true}]);
  expect(result.originalFiles.some(file=>file.path==='images/'+s.orphanKey.slice(0,2)+'/'+s.orphanKey+'.png'&&file.bytes.equals(s.orphan))).toBe(true);
  expect(result.report).toMatchObject({rollbackEligible:false,sourcePolicy:'private_original_files_latest_active_projection',boardImages:1,orphanBoardFiles:1,wallItems:3,missingWalls:1,wallFiles:2,archivedManifestFields:0});
  expect(s.db.serialize()).toEqual(before);expect(readFileSync(join(s.root,'walls/manifest.json'),'utf8')).toBe(s.manifest);
  const fixed=new Database(result.checkpointImage);try{expect(fixed.transaction(()=>reconciliation.verifyRollbackMedia(fixed,result,result.originalFiles,result.journal)).immediate()).toEqual(result.report);}finally{fixed.close();}
});
it('projects latest wall bytes/names/order/toggles/rotation and new filenames while preserving stale external walls only as private originals',async()=>{
  const s=await setup(),id='w_'+'d'.repeat(32);
  s.db.prepare("INSERT INTO wallpaper_assets VALUES(?,'image/png',?,?)").run(digest(s.next),s.next,s.next.length);
  s.db.prepare('UPDATE wallpaper_items SET name=?,enabled=1,position=2,digest=? WHERE id=?').run('最新名稱',digest(s.next),a);
  s.db.prepare('UPDATE wallpaper_items SET position=1,enabled=0 WHERE id=?').run(b);
  s.db.prepare('INSERT INTO wallpaper_items VALUES(?,?,?,?,?,?)').run(id,'/walls/new.png','新上傳',1,3,digest(s.next));
  s.db.prepare('UPDATE wallpaper_config SET rotate_seconds=60,revision=2 WHERE id=1').run();const result=s.result();
  expect(JSON.parse(result.walls.manifest)).toEqual({rotateSeconds:60,items:[{src:'/walls/second.png',name:'第二張',enabled:false},{src:'/walls/original.png',name:'最新名稱',enabled:true},{src:'/walls/new.png',name:'新上傳',enabled:true},{src:'/walls/missing.webp',name:'原本遺失'}]});
  expect(result.walls.files.map(file=>[file.source,file.bytes])).toEqual([['/walls/second.png',s.raw],['/walls/original.png',s.next],['/walls/new.png',s.next]]);
  expect(result.originalFiles.find(file=>file.path==='walls/original.png')!.bytes).toEqual(s.raw);expect(result.report.inactiveOriginalWallFiles).toBe(1);
});
it('never resurrects a removed or currently missing wall from leftover original files',async()=>{
  const s=await setup();s.db.prepare('DELETE FROM wallpaper_items WHERE id=?').run(a);writeFileSync(join(s.root,'walls/missing.webp'),'old-private-leftover',{mode:0o600});
  const result=s.result();expect(result.walls.files.map(file=>file.source)).toEqual(['/walls/second.png']);expect(result.walls.mapping.find(row=>row.id===missing)).toMatchObject({missing:true,digest:null});expect(result.originalFiles.find(file=>file.path==='walls/missing.webp')).toBeDefined();expect(result.report.inactiveOriginalWallFiles).toBe(2);
});
it.each(['jpg','jpeg','webp'] as const)('preserves new %s wallpaper bytes and compatible old file URLs without transcoding',async(extension)=>{
  const s=await setup(),format=extension==='webp'?'webp':'jpeg',raw=await sharp({create:{width:2,height:2,channels:3,background:'#0f0'}}).toFormat(format).toBuffer(),id='w_'+'d'.repeat(32),source='/walls/new.'+extension;
  s.db.prepare('INSERT INTO wallpaper_assets VALUES(?,?,?,?)').run(digest(raw),'image/'+format,raw,raw.length);s.db.prepare('INSERT INTO wallpaper_items VALUES(?,?,?,?,?,?)').run(id,source,'新原圖',1,15,digest(raw));
  const result=s.result(),file=result.walls.files.find(file=>file.source===source)!;expect(file.bytes).toEqual(raw);expect(file.digest).toBe(digest(raw));expect(result.walls.mapping.find(row=>row.id===id)).toMatchObject({source,missing:false});
});
it('honors latest account erasure while retaining immutable historical images and removing unreferenced private codes',async()=>{
  const s=await setup(),key=s.db.transaction(()=>putPaymentImage(s.db,s.next,new Date('2026-11-19T04:00:00Z'))).immediate();s.db.prepare("INSERT INTO user_payment_codes VALUES('only-private','bob','alipay','私人碼',?,'before',NULL)").run(key);
  const privacy=createPrivacy(s.db,s.journal),requestId=randomUUID();s.db.transaction(()=>privacy.submit({version:1,kind:'account',userId:'bob',profileId:null,requestId,createdAt:'2026-11-19T05:00:00.000Z',secretHash:hash('secret'),signature:hash('command')})).immediate();privacy.guard();
  const result=s.result();expect(result.journal).toHaveLength(1);expect(result.boardImages.map(image=>image.digest)).toEqual([s.key]);expect(result.originalFiles.some(file=>file.path.endsWith(key+'.png'))).toBe(false);
  const fixed=new Database(result.checkpointImage);try{expect(fixed.prepare('SELECT * FROM user_payment_codes').all()).toEqual([]);expect(fixed.prepare('SELECT qr_image FROM settlement_history ORDER BY version').all()).toEqual([{qr_image:s.next},{qr_image:s.next}]);expect(fixed.prepare('SELECT signature FROM privacy_receipts WHERE request_id=?').get(requestId)).toEqual({signature:hash('command')});}finally{fixed.close();}
});
it('archives unused original manifest fields and unsupported flag values without publishing their private contents',async()=>{
  const s=await setup(),manifest=JSON.parse(s.manifest);manifest.credentials={token:'PRIVATE-WALL-TOKEN'};manifest.items[0].unused='PRIVATE-WALL-TOKEN';manifest.items[1].enabled={token:'PRIVATE-WALL-TOKEN'};manifest.rotateSeconds=false;
  s.db.prepare('UPDATE wallpaper_config SET legacy_manifest_json=?,rotate_seconds=24').run(JSON.stringify(manifest));const result=s.result();
  expect(result.walls.archivedFields).toEqual(['$["credentials"]','$.rotateSeconds','$.items[0]["unused"]','$.items[1].enabled']);expect(result.walls.manifest).not.toContain('PRIVATE-WALL-TOKEN');expect(JSON.parse(result.walls.manifest).rotateSeconds).toBe(24);
  const fixed=new Database(result.checkpointImage);try{expect((fixed.prepare('SELECT legacy_manifest_json FROM wallpaper_config').get() as {legacy_manifest_json:string}).legacy_manifest_json).toContain('PRIVATE-WALL-TOKEN');}finally{fixed.close();}
});
it.each(['board missing','board bytes','board digest','original missing','original bytes','original path','wall bytes','wall source','wall missing','wall mapping','wall order','wall enabled','wall name','wall seconds representation','wall extra','archived fields','checkpoint','journal','extra root'])('independently rejects changed %s output',async(change)=>{
  const s=await setup(),original=s.result(),result=clone(original),manifest=JSON.parse(result.walls.manifest);
  if(change==='board missing')result.boardImages=[];if(change==='board bytes')result.boardImages[0]!.bytes=s.next;if(change==='board digest')result.boardImages[0]!.digest=digest(s.next);
  if(change==='original missing')result.originalFiles.pop();if(change==='original bytes')result.originalFiles[0]!.bytes=s.next;if(change==='original path')result.originalFiles[0]!.path='images/../private.png';
  if(change==='wall bytes')result.walls.files[0]!.bytes=s.next;if(change==='wall source')result.walls.files[0]!.source='/walls/changed.png';if(change==='wall missing')result.walls.files.pop();
  if(change==='wall mapping')result.walls.mapping[0]!.id=b;if(change==='wall order')manifest.items.reverse();if(change==='wall enabled')manifest.items[0].enabled=true;if(change==='wall name')manifest.items[0].name='wrong';if(change==='wall seconds representation')manifest.rotateSeconds=12;if(change==='wall extra')manifest.items[0].credentials='bad';
  if(change.startsWith('wall ')&&!['wall bytes','wall source','wall missing','wall mapping'].includes(change))result.walls.manifest=JSON.stringify(manifest)+'\n';
  if(change==='archived fields')result.walls.archivedFields=['missing'];if(change==='checkpoint'){const db=new Database(result.checkpointImage);try{db.prepare("UPDATE users SET nickname='wrong' WHERE id='alice'").run();result.checkpointImage=db.serialize();}finally{db.close();}}
  if(change==='journal')Object.assign(result,{journal:[{user_id:'bob',request_id:'not-applied',created_at:'before'}]});if(change==='extra root')Object.assign(result,{serve:true});
  const fixed=new Database(original.checkpointImage);try{expect(()=>fixed.transaction(()=>reconciliation.verifyRollbackMedia(fixed,result,original.originalFiles,original.journal)).immediate()).toThrow();}finally{fixed.close();}
});
it.each(['missing image','corrupt image','image symlink','image folder symlink','walls symlink','wall file symlink','extra file','unsafe wall source','wall bytes','wall MIME','duplicate manifest keys','missing journal'])('rejects %s source and leaves the database untouched',async(change)=>{
  const s=await setup(),path=join(s.root,'images',s.key.slice(0,2),s.key+'.png');
  if(change==='missing image')rmSync(path);if(change==='corrupt image')writeFileSync(path,s.next);
  if(change==='image symlink'){rmSync(path);symlinkSync(join(s.root,'walls/original.png'),path);}
  if(change==='image folder symlink'){rmSync(dirname(path),{recursive:true});symlinkSync(join(s.root,'walls'),dirname(path));}
  if(change==='walls symlink'){rmSync(join(s.root,'walls'),{recursive:true});symlinkSync(join(s.capture,'current/music/walls'),join(s.root,'walls'));}
  if(change==='wall file symlink'){rmSync(join(s.root,'walls/original.png'));symlinkSync(path,join(s.root,'walls/original.png'));}
  if(change==='extra file')writeFileSync(join(s.root,'walls/unknown.env'),'PRIVATE-UNKNOWN');
  if(change==='unsafe wall source')s.db.prepare("UPDATE wallpaper_items SET source='/walls/../private.png' WHERE id=?").run(a);
  if(change==='wall bytes')s.db.prepare('UPDATE wallpaper_assets SET data=?,size=?').run(s.next,s.next.length);
  if(change==='wall MIME')s.db.prepare("UPDATE wallpaper_assets SET mime='image/jpeg'").run();
  if(change==='duplicate manifest keys')s.db.prepare('UPDATE wallpaper_config SET legacy_manifest_json=?').run('{"items":[],"items":[]}');
  if(change==='missing journal')s.db.prepare("INSERT INTO erasure_applied VALUES('missing')").run();
  const before=s.db.serialize();expect(()=>s.result()).toThrow();expect(s.db.serialize()).toEqual(before);expect(s.db.inTransaction).toBe(false);
});
it('holds the actual writer lock through external media capture, then releases it',async()=>{
  const s=await setup(),original=reconciliation.verifyRollbackMedia;let locked=false;
  vi.spyOn(reconciliation,'verifyRollbackMedia').mockImplementationOnce((db,result,files,intents)=>{
    expect(db).toBe(s.db);expect(db.inTransaction).toBe(true);
    const text=execFileSync('python3',['-c',`import sqlite3,sys
db=sqlite3.connect(sys.argv[1],timeout=0)
try: db.execute('BEGIN IMMEDIATE')
except sqlite3.OperationalError: print('locked')
else: raise AssertionError('writer lock was absent')
finally: db.close()
`,s.db.name],{encoding:'utf8'});locked=text.trim()==='locked';return original(db,result,files,intents);
  });
  s.result();expect(locked).toBe(true);const db=new Database(s.db.name,{timeout:0});try{db.exec('BEGIN IMMEDIATE');db.exec('ROLLBACK');}finally{db.close();}
});
it('rejects an external inventory change after the captured bytes and leaves the new file intact for investigation',async()=>{
  const s=await setup(),original=reconciliation.verifyRollbackMedia,path=join(s.root,'walls/added.png');
  vi.spyOn(reconciliation,'verifyRollbackMedia').mockImplementationOnce((db,result,files,intents)=>{writeFileSync(path,s.next,{mode:0o600});return original(db,result,files,intents);});
  const before=s.db.serialize();expect(()=>s.result()).toThrow('changed while locked');expect(readFileSync(path)).toEqual(s.next);expect(s.db.serialize()).toEqual(before);expect(s.result().originalFiles.some(file=>file.path==='walls/added.png')).toBe(true);
});
it('rejects a database file replacement during capture',async()=>{
  const s=await setup(),original=reconciliation.verifyRollbackMedia,path=s.db.name,held=path+'.original';
  vi.spyOn(reconciliation,'verifyRollbackMedia').mockImplementationOnce((db,result,files,intents)=>{renameSync(path,held);writeFileSync(path,result.checkpointImage,{mode:0o600});return original(db,result,files,intents);});
  try{expect(()=>s.result()).toThrow('database file changed');}finally{rmSync(path);renameSync(held,path);}
  expect(s.db.inTransaction).toBe(false);
});
it('requires a canonical file-backed source and a standalone transaction, and supports explicitly absent original folders',async()=>{
  const s=await setup();s.db.transaction(()=>expect(()=>s.result()).toThrow('standalone')).deferred();const memory=openDatabase(':memory:');try{expect(()=>captureRollbackMedia(memory,erasureJournal(memory))).toThrow('file-backed');}finally{memory.close();}
  const root=realpathSync(mkdtempSync(join(tmpdir(),'qgroup-rollback-media-absent-')));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));const db=openDatabase(join(root,'state.sqlite3'));cleanup.push(()=>db.close());fixture(db);
  db.prepare("INSERT INTO wallpaper_assets VALUES(?,'image/png',?,?)").run(s.key,s.raw,s.raw.length);db.prepare('INSERT INTO wallpaper_items VALUES(?,?,?,?,?,?)').run(a,'/walls/native.png','資料庫原圖',1,0,s.key);
  const result=captureRollbackMedia(db,erasureJournal(db));expect(result.originalFiles).toEqual([]);expect(result.boardImages).toEqual([]);expect(result.walls.files).toEqual([{source:'/walls/native.png',digest:s.key,bytes:s.raw}]);
});
it('uses the media checkpoint for all state projections despite later current database writes',async()=>{
  const s=await setup(),media=s.result();s.db.prepare("UPDATE events SET title='later activity' WHERE id='listen'").run();s.db.prepare("UPDATE wallpaper_items SET name='later wall' WHERE id=?").run(a);
  const before=Buffer.from(media.checkpointImage),state=projectRollbackStateFromCheckpoint(media.checkpointImage,media.journal),board=new Database(state.boardImage);try{
    expect(board.prepare("SELECT title FROM events WHERE id='listen'").get()).not.toEqual({title:'later activity'});expect(state.report.checkpoint.imageDigest).toBe(media.report.checkpoint.imageDigest);expect(state.checkpointImage).toEqual(media.checkpointImage);expect(media.checkpointImage).toEqual(before);
    const fixed=new Database(state.checkpointImage);try{expect(fixed.prepare('SELECT name FROM wallpaper_items WHERE id=?').get(a)).toEqual({name:'original.png'});expect(fixed.transaction(()=>reconciliation.verifyRollbackMedia(fixed,media,media.originalFiles,media.journal)).immediate()).toEqual(media.report);}finally{fixed.close();}
  }finally{board.close();}
  const corrupt=Buffer.from(media.checkpointImage);corrupt[18]=2;expect(()=>projectRollbackStateFromCheckpoint(corrupt,media.journal)).toThrow('standalone checkpoint');
  expect(()=>projectRollbackStateFromCheckpoint(media.checkpointImage,[{user_id:'bob',request_id:'absent',created_at:'before'}])).toThrow('markers differ');
});
it('reads all projected historical file/BLOB images with the actual old Python media module and preserves all SQLite rows',async()=>{
  const s=await setup(),result=s.result(),fixed=new Database(result.checkpointImage),board=projectRollbackBoard(fixed),root=mkdtempSync(join(tmpdir(),'qgroup-rollback-media-python-'));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));cleanup.push(()=>fixed.close());cleanup.push(()=>board.db.close());
  const path=join(root,'board.sqlite3');writeFileSync(path,board.db.serialize(),{mode:0o600});for(const image of result.boardImages){const folder=join(root,'images',image.digest.slice(0,2));mkdirSync(folder,{recursive:true,mode:0o700});writeFileSync(join(folder,image.digest+'.png'),image.bytes,{mode:0o600});}
  const output=execFileSync('python3',['-c',`import hashlib,json,sys
from qgroup_core import media,storage
with storage.connect(sys.argv[1]) as db:
    values=[hashlib.sha256(media.read(db,sys.argv[2])).hexdigest()]
    for version in (1,2):
        for item in ('file','inline'): values.append(hashlib.sha256(media.receipt(db,'listen',version,item)).hexdigest())
    print(json.dumps(values))
`,path,s.key],{encoding:'utf8'});
  expect(JSON.parse(output)).toEqual([s.key,s.key,digest(s.next),s.key,digest(s.next)]);
  const after=new Database(path);try{expect(fixed.transaction(()=>verifyRollbackBoard(fixed,after)).immediate()).toEqual(board.report);}finally{after.close();}
});
it('reads and writes the projected wall manifest using the original Python wall functions without initializing the old service',async()=>{
  const s=await setup(),result=s.result(),root=mkdtempSync(join(tmpdir(),'qgroup-rollback-walls-python-'));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
  const walls=join(root,'walls');mkdirSync(walls,{mode:0o700});writeFileSync(join(walls,'manifest.json'),result.walls.manifest,{mode:0o600});for(const file of result.walls.files)writeFileSync(join(root,file.source.slice(1)),file.bytes,{mode:0o600});
  const output=execFileSync('python3',['-c',`import ast,json,os,sys
from pathlib import Path
source=Path('music_site/upstream.py').read_text()
names={'load_walls','save_walls','walls_payload'}
nodes=[node for node in ast.parse(source).body if isinstance(node,ast.FunctionDef) and node.name in names]
assert {node.name for node in nodes}==names
env={'json':json,'os':os,'WALLS_DIR':sys.argv[1],'WALLS_MANIFEST':str(Path(sys.argv[1])/'manifest.json')}
exec(compile(ast.Module(body=nodes,type_ignores=[]),'music_site/upstream.py','exec'),env)
before=env['walls_payload']()
manifest=env['load_walls']();manifest['rotateSeconds']=30;manifest['items'][0]['enabled']=True
env['save_walls'](manifest)
print(json.dumps({'before':before,'after':env['walls_payload']()}))
`,walls],{encoding:'utf8'});
  const value=JSON.parse(output);expect(value.before).toEqual({rotateSeconds:12,items:[{name:'original.png',src:'/walls/original.png',size:s.raw.length,missing:false,enabled:false},{name:'第二張',src:'/walls/second.png',size:s.raw.length,missing:false,enabled:true},{name:'原本遺失',src:'/walls/missing.webp',size:0,missing:true,enabled:true}]});expect(value.after.rotateSeconds).toBe(30);expect(value.after.items[0].enabled).toBe(true);expect(readFileSync(join(s.root,'walls/manifest.json'),'utf8')).toBe(s.manifest);
});
