import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { linkSync, mkdtempSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { BotOwnership } from './ownership';
import { until } from '../testsupport/platform';
const cleanup:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
function setup(){const dir=mkdtempSync(join(tmpdir(),'bot-owner-')),path=join(dir,'state.sqlite3'),db=openDatabase(path);db.close();cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));return {dir,path};}
function python(path:string,code:string){return execFileSync('python3',['-c',`import sys\nfrom qgroup_bot.ownership import BotOwnership\n${code}`,path],{encoding:'utf8',env:{PATH:process.env.PATH,PYTHONPATH:process.cwd()}});}
describe('delivery owner protocol',()=>{
  it('rejects another TS owner and Python process, then releases without deleting the persistent lock',()=>{
    const s=setup(),owner=new BotOwnership(s.path);cleanup.push(()=>owner.close());
    expect(()=>new BotOwnership(s.path)).toThrow('already held');
    expect(python(s.path,"try:\n BotOwnership(sys.argv[1]);print('WRONG')\nexcept RuntimeError:print('blocked')").trim()).toBe('blocked');
    expect(python(s.path,"import types\nfrom qgroup_bot import main\nmain.Config=lambda:types.SimpleNamespace(db=sys.argv[1],validate=lambda:[])\nmain.obs.configure=lambda _:None\nmain.obs.event=lambda *a,**k:None\nmain.ws_connect=lambda:None\nmain.Bot=lambda _:(_ for _ in ()).throw(AssertionError('Business must not start'))\nprint(main.main())").trim()).toBe('2');
    expect(statSync(owner.path).mode&0o777).toBe(0o600);owner.close();
    expect(python(s.path,"owner=BotOwnership(sys.argv[1]);owner.check();owner.close();print('released')").trim()).toBe('released');
    const next=new BotOwnership(s.path);next.close();expect(statSync(owner.path).isFile()).toBe(true);
  });
  it('honors a live Python lock and recovers after the owning process crashes',async()=>{
    const s=setup(),child=spawn('python3',['-u','-c',"import sys,time\nfrom qgroup_bot.ownership import BotOwnership\nowner=BotOwnership(sys.argv[1]);print('locked',flush=True);time.sleep(120)",s.path],{env:{PATH:process.env.PATH,PYTHONPATH:process.cwd()},stdio:['ignore','pipe','pipe']});
    const exited=once(child,'exit');cleanup.push(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;});let output='';child.stdout.on('data',chunk=>{output+=chunk;});await until(()=>output.includes('locked'));
    expect(()=>new BotOwnership(s.path)).toThrow('unavailable');child.kill('SIGKILL');await exited;
    const owner=new BotOwnership(s.path);owner.assert();owner.close();
  });
  it.each(['','-journal','-wal','-shm'])('rejects an owner inode hardlinked as %s before opening it and keeps the original TS lock',suffix=>{
    const s=setup(),other=setup(),owner=new BotOwnership(s.path);cleanup.push(()=>owner.close());
    if(suffix){const prepared=new BotOwnership(other.path);prepared.close();}
    const alias=join(other.dir,'.bot-owner.sqlite3')+suffix;linkSync(owner.path,alias);
    expect(()=>new BotOwnership(other.path)).toThrow(/Invalid bot owner/);
    rmSync(alias);owner.assert();
    expect(python(s.path,"try:\n BotOwnership(sys.argv[1]);print('WRONG')\nexcept RuntimeError:print('blocked')").trim()).toBe('blocked');
    owner.close();const next=new BotOwnership(other.path);next.close();
  });
  it('rejects a renamed live owner inode in another directory without dropping its OS lock',()=>{
    const s=setup(),other=setup(),owner=new BotOwnership(s.path);cleanup.push(()=>owner.close());const alias=join(other.dir,'.bot-owner.sqlite3');
    renameSync(owner.path,alias);
    try{
      expect(()=>new BotOwnership(other.path)).toThrow('Invalid bot owner file');
      expect(python(alias,"import sqlite3\ntry:\n db=sqlite3.connect(sys.argv[1],timeout=0);db.execute('BEGIN EXCLUSIVE');print('WRONG')\nexcept sqlite3.OperationalError:print('blocked')").trim()).toBe('blocked');
    }finally{renameSync(alias,owner.path);}
    owner.assert();
  });
  it('keeps Python locks through rejected hardlink/rename aliases and never opens an existing owner with a raw descriptor',()=>{
    const s=setup(),other=setup();expect(python(s.path,`import os,sqlite3,subprocess
from pathlib import Path
from unittest.mock import patch
other=Path(${JSON.stringify(other.path)})
owner=BotOwnership(sys.argv[1])
alias=other.parent/'.bot-owner.sqlite3'
for suffix in ('','-journal','-wal','-shm'):
 if suffix:
  prepared=BotOwnership(other);prepared.close()
 path=Path(str(alias)+suffix);os.link(owner.path,path)
 try:
  with patch('qgroup_bot.ownership.os.open',side_effect=AssertionError('raw FD on an existing owner')) as opened:
   try:BotOwnership(other);raise AssertionError('alias accepted')
   except RuntimeError:pass
   assert opened.call_count==0
 finally:path.unlink()
 owner.check()
 result=subprocess.run([sys.executable,'-c',"import sqlite3,sys;d=sqlite3.connect(sys.argv[1],timeout=0);d.execute('BEGIN EXCLUSIVE')",str(owner.path)],capture_output=True)
 assert result.returncode!=0 and b'locked' in result.stderr
 if alias.exists():alias.unlink()
os.rename(owner.path,alias)
try:
 with patch('qgroup_bot.ownership.os.open',side_effect=AssertionError('raw FD on renamed owner')) as opened:
  try:BotOwnership(other);raise AssertionError('renamed alias accepted')
  except RuntimeError:pass
  assert opened.call_count==0
 result=subprocess.run([sys.executable,'-c',"import sqlite3,sys;d=sqlite3.connect(sys.argv[1],timeout=0);d.execute('BEGIN EXCLUSIVE')",str(alias)],capture_output=True)
 assert result.returncode!=0 and b'locked' in result.stderr
finally:os.rename(alias,owner.path)
owner.check();owner.close()
with patch('qgroup_bot.ownership.os.open',side_effect=AssertionError('raw FD on existing lock')) as opened:
 next=BotOwnership(sys.argv[1]);next.check();next.close();assert opened.call_count==0
print('all-aliases-blocked-lock-retained')`).trim()).toBe('all-aliases-blocked-lock-retained');
  });
  it('keeps Python in-process exclusion and refuses symlinks/hardlinks or a replaced owner file',()=>{
    const s=setup();expect(python(s.path,"owner=BotOwnership(sys.argv[1])\ntry:\n BotOwnership(sys.argv[1]);print('WRONG')\nexcept RuntimeError:print('blocked')\nowner.close()").trim()).toBe('blocked');
    const target=join(s.dir,'target');writeFileSync(target,'private');const lock=join(s.dir,'.bot-owner.sqlite3');rmSync(lock);symlinkSync(target,lock);expect(()=>new BotOwnership(s.path)).toThrow();rmSync(lock);linkSync(target,lock);expect(()=>new BotOwnership(s.path)).toThrow();rmSync(lock);
    const owner=new BotOwnership(s.path);renameSync(lock,lock+'.old');writeFileSync(lock,'');expect(()=>owner.assert()).toThrow('replaced');owner.close();
  });
  it('terminates an idle Python entrypoint on SIGTERM before releasing ownership',async()=>{
    const s=setup(),program=`import asyncio,sys,types
from qgroup_bot import main
from qgroup_bot.ownership import BotOwnership
class SyntheticBot:
 def __init__(self,config):
  self.api=types.SimpleNamespace(http_json=lambda *a,**k:None)
  self.stopping=False;self.heartbeat_task=None
 async def run(self):
  print('ready',flush=True)
  await asyncio.Event().wait()
main.Bot=SyntheticBot
main.obs.event=lambda *a,**k:None
owner=BotOwnership(sys.argv[1])
try:main._run_owned(types.SimpleNamespace(),owner)
finally:owner.close()
`;
    const child=spawn('python3',['-u','-c',program,s.path],{env:{PATH:process.env.PATH,PYTHONPATH:process.cwd()},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',chunk=>{output+=chunk;});const exited=once(child,'exit');cleanup.push(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;});
    await until(()=>output.includes('ready'));expect(()=>new BotOwnership(s.path)).toThrow();child.kill('SIGTERM');const [code]=await exited;expect(code).toBe(0);const owner=new BotOwnership(s.path);owner.close();
  });
  it('blocks Python restart when prior sending work needs review without modifying that work',()=>{
    const s=setup(),db=openDatabase(s.path);
    db.exec("INSERT INTO users(id,token_hash,nickname,created_at) VALUES('synthetic','hash','name','before'); INSERT INTO events(id,owner_id,title,category,location,starts_at,deadline,capacity,description,status,created_at) VALUES('event','synthetic','title','其他','place','2099-01-01','2099-01-01',1,'','open','before'); INSERT INTO bot_outbox(event_id,kind,dedupe_key,payload_json,status,created_at,attempts) VALUES('event','custom','key','{}','sending','before',2)");db.close();
    expect(python(s.path,"owner=BotOwnership(sys.argv[1])\ntry:\n owner.check_pending();print('WRONG')\nexcept RuntimeError:print('blocked')\nfinally:owner.close()").trim()).toBe('blocked');
    const check=openDatabase(s.path);expect(check.prepare('SELECT status,attempts FROM bot_outbox').get()).toEqual({status:'sending',attempts:2});check.close();
  });
  it('holds Python ownership until executor work stops and rejects late HTTP after SIGTERM',async()=>{
    const s=setup(),release=join(s.dir,'release'),program=`import asyncio,sys,time,types
from pathlib import Path
from qgroup_bot import main
from qgroup_bot.ownership import BotOwnership
class SyntheticBot:
 def __init__(self,config):
  self.api=types.SimpleNamespace(http_json=lambda *a,**k:print('WRONG HTTP',flush=True))
  self.stopping=False;self.heartbeat_task=None
 async def run(self):
  def work():
   print('worker-ready',flush=True)
   while not Path(sys.argv[2]).exists():time.sleep(.01)
   try:self.api.http_json()
   except RuntimeError:print('send-blocked',flush=True)
  await asyncio.to_thread(work)
main.Bot=SyntheticBot
main.obs.event=lambda event,*a,**k:print(event,flush=True)
owner=BotOwnership(sys.argv[1])
try:main._run_owned(types.SimpleNamespace(),owner)
finally:owner.close()
`;
    const child=spawn('python3',['-u','-c',program,s.path,release],{env:{PATH:process.env.PATH,PYTHONPATH:process.cwd()},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',chunk=>{output+=chunk;});const exited=once(child,'exit');cleanup.push(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;});
    await until(()=>output.includes('worker-ready'));child.kill('SIGTERM');await until(()=>output.includes('bot_stopping'));
    expect(child.exitCode).toBeNull();expect(()=>new BotOwnership(s.path)).toThrow();writeFileSync(release,'');
    const [code]=await exited;expect(code).toBe(0);expect(output).toContain('send-blocked');expect(output).not.toContain('WRONG HTTP');const owner=new BotOwnership(s.path);owner.close();
  });
});
