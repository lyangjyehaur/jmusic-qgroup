// Offline synthetic Linux probe. Run with the bundled capture tool and frozen
// schema JSON in a bounded, network-none container; no Docker socket is needed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync,mkdtempSync,readFileSync,renameSync,rmSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
if(process.platform!=='linux')throw Error('This probe requires Linux kernel locks');
const bundle=process.argv[2]||'/probe';
const {default:Database}=await import('/app/node_modules/better-sqlite3/lib/index.js');
const {captureSnapshot}=await import(pathToFileURL(join(bundle,'capture.mjs')).href);
const {acquireMusicLock}=await import(pathToFileURL(join(bundle,'lock.mjs')).href);
const schema=JSON.parse(readFileSync(join(bundle,'schema.json'),'utf8'));
const root=mkdtempSync('/tmp/qgroup-capture-probe-'),boardRoot=join(root,'board'),music=join(root,'music'),history=join(root,'history'),evidence=join(boardRoot,'bot-logs');
for(const folder of [join(boardRoot,'images'),join(music,'walls'),history,evidence])mkdirSync(folder,{recursive:true,mode:0o700});
const save=(path,value)=>writeFileSync(path,typeof value==='string'?value:JSON.stringify(value),{mode:0o600});
const board=new Database(join(boardRoot,'board.sqlite3')),identity=new Database(join(music,'identity.sqlite3'));
let holder;
try{
 board.exec(schema.board);board.exec('INSERT INTO site_settings(id) VALUES(1)');board.pragma('journal_mode=WAL');identity.exec(schema.identity);identity.pragma('journal_mode=WAL');
 board.prepare("INSERT INTO users VALUES('synthetic','source-token','original name','source')").run();
 identity.prepare('INSERT INTO native_profiles VALUES(?,?)').run('10000',JSON.stringify({qq:'10000',name:'original music',selection:[],created:[]}));
 save(join(music,'.service.lock'),'');save(join(music,'data.json'),{entries:{},members:{},settings:{},shouts:[],shoutHistory:[],trend:[]});save(join(music,'erasures.jsonl'),'');save(join(music,'walls/manifest.json'),{items:[]});save(join(boardRoot,'board.erasures.jsonl'),'');save(join(evidence,'bot-health.json'),{updated_at:123});
 const services=['web','music','bot'].map((role,i)=>({role,containerId:String(i+1).repeat(64),imageId:'sha256:'+String(i+4).repeat(64)}));
 const input={board:board.name,boardLedger:join(boardRoot,'board.erasures.jsonl'),music,boardBackups:history,botEvidence:evidence,destination:join(root,'capture'),services};
 let inspections=0;
 const rivalBoard=new Database(board.name,{timeout:0}),rivalIdentity=new Database(identity.name,{timeout:0});
 const inspect=id=>{
  const role=services.find(row=>row.containerId===id);inspections++;
  if(inspections>=7){assert.throws(()=>rivalBoard.prepare('UPDATE users SET nickname=nickname').run(),/locked/);assert.throws(()=>rivalIdentity.prepare('UPDATE native_profiles SET payload=payload').run(),/locked/);assert.throws(()=>execFileSync('/usr/bin/flock',['--exclusive','--nonblock',join(music,'.service.lock'),'/usr/bin/true'],{stdio:'ignore'}));}
  return {Id:id,Image:role.imageId,State:{Running:false,Paused:false,Restarting:false,Dead:false,Status:'exited',Pid:0,StartedAt:'original-start',FinishedAt:'original-stop'},RestartCount:0,Revision:null,Service:role.role,BoardDatabase:'/var/lib/qgroup/board.sqlite3',MusicData:'/data/data.json',BotLogDir:'',Mounts:[{Type:'bind',Source:role.role==='music'?music:boardRoot,Destination:role.role==='music'?'/data':'/var/lib/qgroup'}]};
 };
 try{
  holder=await acquireMusicLock(join(music,'.service.lock'));
  assert.throws(()=>execFileSync('/usr/bin/flock',['--exclusive','--nonblock',join(music,'.service.lock'),'/usr/bin/true'],{stdio:'ignore'}));
  await assert.rejects(captureSnapshot(input,new Date(),{inspect}),/maintenance lock/);await holder.release();holder=undefined;
  // Replacement detection protects against locking an old inode while a new
  // service opens a different file at the same path.
  holder=await acquireMusicLock(join(music,'.service.lock'));renameSync(join(music,'.service.lock'),join(music,'.old-lock'));save(join(music,'.service.lock'),'');assert.throws(()=>holder.assertHeld(),/replaced/);await holder.release();holder=undefined;rmSync(join(music,'.old-lock'));
  inspections=0;const result=await captureSnapshot(input,new Date(),{inspect});assert.equal(result.status,'captured');assert.equal(inspections,12);
  assert.doesNotThrow(()=>execFileSync('/usr/bin/flock',['--exclusive','--nonblock',join(music,'.service.lock'),'/usr/bin/true'],{stdio:'ignore'}));
  assert.doesNotThrow(()=>rivalBoard.prepare('UPDATE users SET nickname=nickname').run());assert.doesNotThrow(()=>rivalIdentity.prepare('UPDATE native_profiles SET payload=payload').run());
  const captured=new Database(join(input.destination,'current/board.sqlite3'),{readonly:true});try{assert.deepEqual(captured.prepare('SELECT * FROM users').all(),board.prepare('SELECT * FROM users').all());}finally{captured.close();}
  process.stdout.write('Linux flock exclusion/replacement/release, both SQLite writer locks, committed WAL capture and unchanged synthetic rows passed; container evidence injected; no service or QQ connection started\n');
 }finally{rivalBoard.close();rivalIdentity.close();}
}finally{await holder?.release();identity.close();board.close();rmSync(root,{recursive:true,force:true});}
