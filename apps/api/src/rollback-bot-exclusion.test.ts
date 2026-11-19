import {execFileSync} from 'node:child_process';
import {chmodSync,copyFileSync,existsSync,linkSync,lstatSync,mkdtempSync,readFileSync,realpathSync,renameSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it} from 'vitest';
import Database from 'better-sqlite3';
import {openDatabase} from '@qgroup/database';
import {BotOwnership} from '../../bot/src/ownership';
import {withRollbackBotExclusion} from '../../../tools/migration/rollback-bot-exclusion';
const cleanup:(()=>void)[]=[];afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();});
function setup(){const root=realpathSync(mkdtempSync(join(tmpdir(),'qgroup-rollback-owner-'))),database=join(root,'unified.sqlite3');cleanup.push(()=>rmSync(root,{recursive:true,force:true}));const db=openDatabase(database);db.close();const owner=new BotOwnership(database);owner.close();return {root,database,path:join(root,'.bot-owner.sqlite3')};}
function python(database:string,code:string){return execFileSync('python3',['-c',`import sys\nfrom qgroup_bot.ownership import BotOwnership\n${code}`,database],{encoding:'utf8',env:{PATH:process.env.PATH,PYTHONPATH:process.cwd()}}).trim();}
it('holds the existing OS exclusion against native TS and Python entrypoints without reclaiming business work, and expires the guard after release',()=>{
  const s=setup(),db=readFileSync(s.database),lock=readFileSync(s.path),mode=lstatSync(s.path).mode,mtime=lstatSync(s.path,{bigint:true}).mtimeNs;let guard=()=>{};
  const result=withRollbackBotExclusion(s.database,({assertHeld})=>{
    guard=assertHeld;expect(()=>new BotOwnership(s.database)).toThrow('already held');
    expect(python(s.database,"try:\n BotOwnership(sys.argv[1]);print('WRONG')\nexcept RuntimeError:print('blocked')")).toBe('blocked');
    assertHeld();return 'held';
  });
  expect(result).toBe('held');expect(()=>guard()).toThrow('released');expect(readFileSync(s.database)).toEqual(db);expect(readFileSync(s.path)).toEqual(lock);expect(lstatSync(s.path).mode).toBe(mode);expect(lstatSync(s.path,{bigint:true}).mtimeNs).toBe(mtime);expect(existsSync(s.path+'-journal')).toBe(false);
  const next=new BotOwnership(s.database);next.close();expect(python(s.database,"owner=BotOwnership(sys.argv[1]);owner.close();print('released')")).toBe('released');
});
it('rejects live local or external ownership and leaves the source database unchanged',()=>{
  const s=setup(),before=readFileSync(s.database),owner=new BotOwnership(s.database);try{expect(()=>withRollbackBotExclusion(s.database,()=>{throw Error('Must not run');})).toThrow('already held');}finally{owner.close();}
  const blocker=new Database(s.path,{timeout:0});try{blocker.exec('BEGIN EXCLUSIVE');expect(()=>withRollbackBotExclusion(s.database,()=>{throw Error('Must not run');})).toThrow();}finally{blocker.close();}
  expect(readFileSync(s.database)).toEqual(before);withRollbackBotExclusion(s.database,({assertHeld})=>assertHeld());
});
it.each(['missing lock','symlink lock','hardlink lock','public lock','invalid lock bytes','WAL owner','sidecar','noncanonical database'])('rejects %s without creating/chmod/reformatting the lock or running the callback',change=>{
  const s=setup();if(change==='missing lock')rmSync(s.path);if(change==='symlink lock'){renameSync(s.path,s.path+'.saved');symlinkSync(s.path+'.saved',s.path);}if(change==='hardlink lock')linkSync(s.path,s.path+'.linked');if(change==='public lock')chmodSync(s.path,0o644);if(change==='invalid lock bytes')writeFileSync(s.path,'not-sqlite');
  if(change==='WAL owner'){const db=new Database(s.path);db.pragma('journal_mode = WAL');db.exec('CREATE TABLE synthetic(id)');db.close();}if(change==='sidecar')writeFileSync(s.path+'-journal','private-evidence',{mode:0o600});
  const before=existsSync(s.path)?readFileSync(s.path):null,mode=existsSync(s.path)?lstatSync(s.path).mode:null,database=change==='noncanonical database'?s.database+'/../unified.sqlite3':s.database;let ran=false;
  expect(()=>withRollbackBotExclusion(database,()=>{ran=true;})).toThrow();expect(ran).toBe(false);expect(existsSync(s.path)?readFileSync(s.path):null).toEqual(before);expect(existsSync(s.path)?lstatSync(s.path).mode:null).toBe(mode);
});
it.each(['callback failure','async callback','replaced owner','replaced database','changed owner mode'])('rejects %s during exclusion, releases the OS lock and retains every changed file',change=>{
  const s=setup();expect(()=>withRollbackBotExclusion(s.database,()=>{
    if(change==='callback failure')throw Error('synthetic callback');if(change==='async callback')return Promise.resolve('invalid');
    if(change==='replaced owner'){renameSync(s.path,s.path+'.saved');writeFileSync(s.path,'',{mode:0o600});}
    if(change==='replaced database'){renameSync(s.database,s.database+'.saved');copyFileSync(s.database+'.saved',s.database);}
    if(change==='changed owner mode')chmodSync(s.path,0o644);return 'invalid';
  })).toThrow();
  expect(existsSync(s.path)).toBe(true);if(change==='changed owner mode')chmodSync(s.path,0o600);
  const owner=new BotOwnership(s.database);owner.close();
});
it('acquires and releases an existing initialized DELETE owner without changing its rows or bytes',()=>{
  const s=setup(),db=new Database(s.path);db.exec('CREATE TABLE synthetic(id);INSERT INTO synthetic VALUES(1)');db.close();const before=readFileSync(s.path),mtime=lstatSync(s.path,{bigint:true}).mtimeNs,ctime=lstatSync(s.path,{bigint:true}).ctimeNs;
  withRollbackBotExclusion(s.database,({assertHeld})=>assertHeld());expect(readFileSync(s.path)).toEqual(before);expect(lstatSync(s.path,{bigint:true}).mtimeNs).toBe(mtime);expect(lstatSync(s.path,{bigint:true}).ctimeNs).toBe(ctime);
});
