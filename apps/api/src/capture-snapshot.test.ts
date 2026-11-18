import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { legacySchema } from '../../../packages/database/src/legacy-schema';
import { identitySchema } from '../../../tools/migration/identity-schema';
import { captureSnapshot, inspectCaptureContainer, type ContainerEvidence } from '../../../tools/migration/capture-snapshot';
import { acquireMusicLock } from '../../../tools/migration/capture-lock';
import { importSnapshot } from '../../../tools/migration/import-snapshot';
import { digest } from '../../../tools/migration/music-codec';
import { fixture } from '../testsupport/fixture';
import { createLegacyMusicHistory } from './legacy-music-history';
const cleanup:(()=>void)[]=[];afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();});
function setup(){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'qgroup-capture-test-'))),boardRoot=join(root,'board'),music=join(root,'music'),boardBackups=join(root,'backups'),botEvidence=join(boardRoot,'bot-logs'),destination=join(root,'capture');
  for(const path of [join(boardRoot,'images'),join(music,'walls'),boardBackups,botEvidence])mkdirSync(path,{recursive:true,mode:0o700});
  const board=new Database(join(boardRoot,'kanban.sqlite3'));board.exec(legacySchema);board.exec('CREATE TEMP TABLE music_entries(id TEXT,name TEXT,kind TEXT)');fixture(board);board.exec("INSERT INTO site_settings(id) VALUES(1); INSERT INTO bot_settings VALUES(1,0,'{}','source-baseline'); INSERT INTO bot_settings_history VALUES(0,'{}','source-baseline','','baseline'); INSERT INTO bot_runtime(id) VALUES(1)");board.pragma('journal_mode=WAL');
  for(const [index,status] of ['pending','sending','sent','failed','skipped','pending'].entries())board.prepare(`INSERT INTO bot_outbox(event_id,kind,dedupe_key,target,payload_json,status,attempts,last_error,claim_token,retry_at,simulated_at,created_at,delivered_payload_json)
    VALUES('listen','synthetic',?,'synthetic','{"original":true}',?,2,?,?,?,?,'source',?)`).run('capture-'+index,status,status==='sending'?'delivery unconfirmed':'',status==='sending'?'claim-preserved':'',status==='failed'?'retry-preserved':null,index===5?'simulation-preserved':null,status==='sent'?'frozen body':null);
  const identity=new Database(join(music,'identity.sqlite3'));identity.exec(identitySchema);identity.prepare('INSERT INTO native_profiles VALUES(?,?)').run('10003',JSON.stringify({qq:'10003',name:'原生私人資料',selection:['entry'],created:[]}));identity.pragma('journal_mode=WAL');
  const data={entries:{entry:{id:'entry',text:'保留詞條',kind:'sub'}},members:{'10001':{qq:'10001',name:'原始私人名稱',selection:['entry'],created:[]}},settings:{},shouts:[],shoutHistory:[],trend:[]};
  const save=(path:string,value:unknown)=>writeFileSync(path,typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value),{mode:0o600});
  save(join(music,'data.json'),data);save(join(music,'erasures.jsonl'),'');save(join(music,'.service.lock'),'');save(join(music,'walls/manifest.json'),{items:[]});save(join(boardRoot,'kanban.erasures.jsonl'),'');
  save(join(botEvidence,'bot-health.json'),{updated_at:123,last_ack:120});save(join(botEvidence,'bot-events.jsonl'),JSON.stringify({event:'synthetic',privateBody:'private bot evidence'})+'\n');save(join(botEvidence,'bot-group-state.json'),{push_authorized:true});
  const services=(['web','music','bot'] as const).map((role,i)=>({role,containerId:String(i+1).repeat(64),imageId:'sha256:'+String(i+4).repeat(64)}));
  const inspect=(id:string):ContainerEvidence=>{const expected=services.find(item=>item.containerId===id)!;return {Id:id,Image:expected.imageId,State:{Running:false,Paused:false,Restarting:false,Dead:false,Status:'exited',Pid:0,StartedAt:'original-start',FinishedAt:'original-stop'},RestartCount:0,Service:expected.role,BoardDatabase:'/var/lib/qgroup/kanban.sqlite3',MusicData:'/data/data.json',BotLogDir:'',Revision:expected.role==='music'?null:'a'.repeat(40),Mounts:[{Type:'bind',Source:expected.role==='music'?music:boardRoot,Destination:expected.role==='music'?'/data':'/var/lib/qgroup'}]};};
  let held=false,releases=0;
  const lock=async()=>{held=true;return {assertHeld(){if(!held)throw Error('lost test lock');},async release(){held=false;releases++;}};};
  const input={board:board.name,boardLedger:join(boardRoot,'kanban.erasures.jsonl'),music,boardBackups,botEvidence,destination,services};
  cleanup.push(()=>{identity.close();board.close();rmSync(root,{recursive:true,force:true});});
  return {root,input,board,identity,data,save,inspect,lock,releases:()=>releases,held:()=>held,loseLock:()=>{held=false;}};
}
function unchanged(db:Database.Database){return db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row)=>{const name=(row as {name:string}).name;return [name,db.prepare('SELECT rowid,* FROM "'+name+'" ORDER BY rowid').safeIntegers(true).all()];});}
it('captures committed WAL, original bot/data/schema rows, independent history, source images and permissions, then imports only the current snapshot',async()=>{
  const s=setup(),originalBoard=unchanged(s.board),originalIdentity=unchanged(s.identity),bytes=Buffer.from('private immutable image'),key=digest(bytes);
  mkdirSync(join(s.root,'board/images',key.slice(0,2)));s.save(join(s.root,'board/images',key.slice(0,2),key+'.png'),bytes);s.board.prepare('INSERT INTO image_assets VALUES(?,?,?,?)').run(key,bytes.length,'image/png','source');
  const historic='20261118-010203',pair=join(s.input.music,'paired-backups',historic);mkdirSync(join(pair,'walls'),{recursive:true});mkdirSync(join(s.input.music,'backups'));
  s.save(join(pair,'data.json'),{...s.data,members:{'10004':{qq:'10004',name:'protected historical original'}}});const image=s.identity.serialize();image[18]=1;image[19]=1;s.save(join(pair,'identity.sqlite3'),image);s.save(join(pair,'walls/manifest.json'),{items:[]});s.save(join(s.input.music,'backups/data-'+historic+'.json'),s.data);
  const oldBoard=s.board.serialize();oldBoard[18]=1;oldBoard[19]=1;s.save(join(s.input.boardBackups,'kanban-20261118-010203-123456.sqlite3'),oldBoard);const tar=Buffer.from('opaque private history bundle');s.save(join(s.input.boardBackups,'kanban-20261118-010203-123456.images.tar.gz'),tar);
  const result=await captureSnapshot(s.input,new Date('2026-11-19T00:00:00Z'),{inspect:s.inspect,lock:s.lock});expect(result.status).toBe('captured');expect(result.releaseEligible).toBe(false);expect(s.releases()).toBe(1);
  const manifest=JSON.parse(readFileSync(join(s.input.destination,'capture-manifest.json'),'utf8'));expect(manifest.history).toEqual({musicPairs:1,musicJson:1,boardSnapshots:1});expect(manifest.services.find((item:{role:string})=>item.role==='music')).toMatchObject({sourceCommit:null,commitEvidence:'external-record-required'});
  expect(statSync(s.input.destination).mode&0o777).toBe(0o700);for(const file of manifest.files){expect(statSync(join(s.input.destination,file.path)).mode&0o777).toBe(0o600);expect(digest(readFileSync(join(s.input.destination,file.path)))).toBe(file.sha256);}
  expect(readFileSync(join(s.input.destination,'history/music/paired-backups',historic,'identity.sqlite3'))).toEqual(image);expect(readFileSync(join(s.input.destination,'history/board/kanban-20261118-010203-123456.images.tar.gz'))).toEqual(tar);
  expect(readFileSync(join(s.input.destination,'current/music/data.json'))).toEqual(readFileSync(join(s.input.music,'data.json')));expect(JSON.stringify(result)).not.toContain('private');expect(JSON.stringify(manifest)).not.toContain('protected historical original');
  const capturedBoard=new Database(join(s.input.destination,'current/board.sqlite3'),{readonly:true}),capturedIdentity=new Database(join(s.input.destination,'current/music/identity.sqlite3'),{readonly:true});
  try{expect(unchanged(capturedBoard)).toEqual(unchanged(s.board));expect(unchanged(capturedIdentity)).toEqual(originalIdentity);}finally{capturedBoard.close();capturedIdentity.close();}
  expect(unchanged(s.board).filter(row=>row[0]!=='image_assets')).toEqual(originalBoard.filter(row=>row[0]!=='image_assets'));
  expect((await importSnapshot(join(s.input.destination,'current'),join(s.root,'candidate'))).status).toBe('imported');expect(existsSync(s.input.destination+'.capture-lock')).toBe(false);
  const candidate=new Database(join(s.root,'candidate/unified.sqlite3'));
  try {
    const history=createLegacyMusicHistory(candidate,{root:s.input.destination,manifestSha256:digest(readFileSync(join(s.input.destination,'capture-manifest.json')))});
    expect(history.list()).toHaveLength(2);
    expect(history.export('legacy-pair-'+historic,[]).members).toHaveProperty('10004');
    expect(history.export('legacy-json-'+historic,[]).members).toHaveProperty('10001');
  } finally { candidate.close(); }
});
it('holds both real SQLite writer locks through final service inspection and leaves both sources writable after release',async()=>{
  const s=setup(),board=new Database(s.board.name,{timeout:0}),identity=new Database(s.identity.name,{timeout:0});
  let inspections=0;
  try{await captureSnapshot(s.input,new Date(),{lock:s.lock,inspect:id=>{inspections++;if(inspections>=7){expect(s.held()).toBe(true);expect(()=>board.prepare("UPDATE events SET title='must stay original'").run()).toThrow(/locked/);expect(()=>identity.prepare("UPDATE native_profiles SET payload='{}'").run()).toThrow(/locked/);}return s.inspect(id);}});expect(inspections).toBe(12);expect(()=>board.prepare('UPDATE events SET title=title').run()).not.toThrow();expect(()=>identity.prepare('UPDATE native_profiles SET payload=payload').run()).not.toThrow();}finally{board.close();identity.close();}
});
it.each(['running','paused','restarting','dead','pid','wrong image','wrong container','wrong bind','shadow database bind','wrong service','wrong database','wrong music data','wrong bot logs','invalid revision state'])('rejects unsafe actual source evidence: %s',async(kind)=>{
  const s=setup();
  await expect(captureSnapshot(s.input,new Date(),{lock:s.lock,inspect:id=>{const value=s.inspect(id);if(kind==='running')value.State.Running=true;if(kind==='paused')value.State.Paused=true;if(kind==='restarting')value.State.Restarting=true;if(kind==='dead')value.State.Dead=true;if(kind==='pid')value.State.Pid=123;if(kind==='wrong image')value.Image='sha256:'+'b'.repeat(64);if(kind==='wrong container')value.Id='d'.repeat(64);if(kind==='wrong bind')value.Mounts[0]!.Source='/unrelated';if(kind==='shadow database bind')value.Mounts.push({Type:'bind',Source:'/unrelated.sqlite3',Destination:value.BoardDatabase});if(kind==='wrong service')value.Service='another';if(kind==='wrong database')value.BoardDatabase='/var/lib/qgroup/another.sqlite3';if(kind==='wrong music data')value.MusicData='/data/another.json';if(kind==='wrong bot logs')value.BotLogDir='/var/lib/qgroup/other-logs';if(kind==='invalid revision state')value.State.Status='removing';return value;}})).rejects.toThrow();
  expect(existsSync(s.input.destination)).toBe(false);expect(existsSync(s.input.destination+'.capture-lock')).toBe(false);expect(s.releases()).toBe(0);
});
it.each(['service resumed','restart interval changed','file changed','file added','database replaced','lock lost','destination appeared'])('revalidates the locked final capture and preserves original or competing writes: %s',async(kind)=>{
  const s=setup();let inspections=0;
  await expect(captureSnapshot(s.input,new Date(),{lock:s.lock,inspect:id=>{const value=s.inspect(id);inspections++;if(inspections===7){if(kind==='service resumed')value.State.Running=true;if(kind==='restart interval changed'){value.State.StartedAt='a newer run';value.RestartCount=1;}if(kind==='file changed')s.save(join(s.input.music,'data.json'),{...s.data,settings:{note:'newer source write'}});if(kind==='file added')s.save(join(s.input.music,'walls/new.png'),Buffer.from('added'));if(kind==='database replaced'){const original=s.board.name+'.old';renameSync(s.board.name,original);copyFileSync(original,s.board.name);}if(kind==='lock lost')s.loseLock();if(kind==='destination appeared'){mkdirSync(s.input.destination);s.save(join(s.input.destination,'competing-write'),'keep');}}return value;}})).rejects.toThrow();
  expect(s.releases()).toBe(1);expect(existsSync(s.input.destination+'.capture-lock')).toBe(false);expect(readdirSync(s.root).some(name=>name.startsWith('.qgroup-capture-'))).toBe(false);
  if(kind==='destination appeared')expect(readFileSync(join(s.input.destination,'competing-write'),'utf8')).toBe('keep');else expect(existsSync(s.input.destination)).toBe(false);
  if(kind==='file changed')expect(readFileSync(join(s.input.music,'data.json'),'utf8')).toContain('newer source write');
});
it.each(['music JSON invalid','missing ledger','unknown music file','missing wall','orphan music pair','orphan board pair','unknown bot file','incomplete bot log','symlink media'])('rejects incomplete source sets without publishing: %s',async(kind)=>{
  const s=setup();
  if(kind==='music JSON invalid')s.save(join(s.input.music,'data.json'),'{');if(kind==='missing ledger')rmSync(join(s.input.music,'erasures.jsonl'));if(kind==='unknown music file')s.save(join(s.input.music,'data.json.tmp'),'pending source write');if(kind==='missing wall')s.save(join(s.input.music,'walls/manifest.json'),{items:[{src:'/walls/missing.png'}]});
  if(kind==='orphan music pair'){const pair=join(s.input.music,'paired-backups/20261118-010203');mkdirSync(pair,{recursive:true});s.save(join(pair,'data.json'),s.data);}if(kind==='orphan board pair')s.save(join(s.input.boardBackups,'kanban-20261118-010203-123456.images.tar.gz'),'incomplete');if(kind==='unknown bot file')s.save(join(s.input.botEvidence,'unclassified.env'),'private');if(kind==='incomplete bot log')s.save(join(s.input.botEvidence,'bot-events.jsonl'),'{}');if(kind==='symlink media')symlinkSync(join(s.input.music,'data.json'),join(s.root,'board/images','link'));
  await expect(captureSnapshot(s.input,new Date(),{inspect:s.inspect,lock:s.lock})).rejects.toThrow();expect(existsSync(s.input.destination)).toBe(false);expect(s.releases()).toBe(1);expect(existsSync(s.input.destination+'.capture-lock')).toBe(false);expect(readdirSync(s.root).some(name=>name.startsWith('.qgroup-capture-'))).toBe(false);
});
it('rejects source containment, repeated roles, aliases and existing or dangling destinations before any source lock',async()=>{
  const s=setup();const candidate={...s.input,destination:join(s.input.music,'capture')};await expect(captureSnapshot(candidate,new Date(),{inspect:s.inspect,lock:s.lock})).rejects.toThrow('isolated');
  await expect(captureSnapshot({...s.input,services:[s.input.services[0]!,s.input.services[0]!,s.input.services[2]!]},new Date(),{inspect:s.inspect,lock:s.lock})).rejects.toThrow();
  symlinkSync(join(s.root,'absent'),s.input.destination);await expect(captureSnapshot(s.input,new Date(),{inspect:s.inspect,lock:s.lock})).rejects.toThrow('existing');expect(s.releases()).toBe(0);
});
it('cleans the reservation and earlier SQLite lock when the second writer lock cannot be acquired',async()=>{
  const s=setup();s.identity.exec('BEGIN IMMEDIATE');
  try{await expect(captureSnapshot(s.input,new Date(),{inspect:s.inspect,lock:s.lock})).rejects.toThrow(/locked/);expect(s.releases()).toBe(1);expect(existsSync(s.input.destination+'.capture-lock')).toBe(false);const rival=new Database(s.board.name,{timeout:0});try{expect(()=>rival.prepare('UPDATE events SET title=title').run()).not.toThrow();}finally{rival.close();}}finally{s.identity.exec('ROLLBACK');}
});
it('captures an absent media directory as an explicit empty set when the source has no image references',async()=>{
  const s=setup();rmSync(join(s.root,'board/images'),{recursive:true});
  await captureSnapshot(s.input,new Date(),{inspect:s.inspect,lock:s.lock});expect(existsSync(join(s.root,'board/images'))).toBe(false);expect(statSync(join(s.input.destination,'current/images')).isDirectory()).toBe(true);
});
it('has no permissive CLI assertion or test dependency option, and reports usage without source contents',()=>{
  expect(()=>execFileSync(process.execPath,['--import','tsx','tools/migration/capture-snapshot.ts'],{encoding:'utf8',stdio:['ignore','pipe','pipe']})).toThrow();
  if(process.platform!=='linux')return expect(acquireMusicLock('/not-a-source')).rejects.toThrow('Linux flock');
});
it('rejects remote endpoint syntax before Docker execution and requires complete container IDs',()=>{
  expect(()=>inspectCaptureContainer('short','/unavailable')).toThrow('complete container ID');
  expect(()=>inspectCaptureContainer('a'.repeat(64),'tcp://untrusted.invalid:2375')).toThrow();
});
