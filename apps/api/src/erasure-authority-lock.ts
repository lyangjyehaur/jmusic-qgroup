import {spawn, type SpawnOptions} from 'node:child_process';
import {constants,closeSync,fstatSync,openSync} from 'node:fs';
import {privateFile} from './erasure-authority-protocol';
import {sourceStat} from '../../../packages/runtime/src/private-source-files';

export type ErasureAuthorityLock={assertHeld():void;release():Promise<void>};
/** The child locks the inherited open description. Keeping the parent FD open
 * retains flock exclusion even if the helper exits before Node observes it. */
export async function acquireErasureAuthorityLock(path:string):Promise<ErasureAuthorityLock>{
  if(process.platform!=='linux')throw Error('Native erasure authority requires Linux flock');
  // flock's descriptor form takes no command. A bounded child call locks FD 3;
  // the parent and holder retain that same description after flock exits.
  const holder="const r=require('node:child_process').spawnSync('/usr/bin/flock',['--exclusive','--nonblock','3'],{stdio:['ignore','ignore','ignore',3],timeout:2000});if(r.status!==0)process.exit(1);process.stdout.write('locked\\n');process.stdin.resume();";
  return acquireInheritedAuthorityLock(path,process.execPath,['-e',holder]);
}
/** Explicit helper selection is for isolated interoperability tests only;
 * production startup calls acquireErasureAuthorityLock. No helper reads data. */
export async function acquireInheritedAuthorityLock(path:string,command:string,args:string[]):Promise<ErasureAuthorityLock>{
  privateFile(path,0).assertUnchanged();
  const before=sourceStat(path)!,fd=openSync(path,constants.O_RDWR|constants.O_NOFOLLOW),held=fstatSync(fd,{bigint:true});
  if(held.dev!==before.dev||held.ino!==before.ino){closeSync(fd);throw Error('Authority lock replaced before acquisition');}
  const env={...process.env};delete env.NODE_OPTIONS;
  const options:SpawnOptions={stdio:['pipe','pipe','pipe',fd],env},holder=spawn(command,args,options);
  if(!holder.stdin||!holder.stdout||!holder.stderr){closeSync(fd);holder.kill('SIGKILL');throw Error('Authority holder pipes unavailable');}
  holder.stdin.on('error',()=>{});holder.stderr.resume();
  const exited=new Promise<void>(resolve=>{holder.once('exit',()=>resolve());holder.once('error',()=>resolve());});
  let released=false;
  async function release(){if(released)return;released=true;holder.stdin!.end();const timeout=setTimeout(()=>holder.kill('SIGKILL'),1500);try{await exited;}finally{clearTimeout(timeout);closeSync(fd);}}
  try{
    await new Promise<void>((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(Error('Authority lock timed out')),3000),fail=()=>{clearTimeout(timeout);reject(Error('Authority is busy or unavailable'));};
      holder.once('error',fail);holder.once('exit',fail);holder.stdout!.once('data',raw=>{clearTimeout(timeout);if(String(raw)==='locked\n')resolve();else fail();});
    });
    const assertHeld=()=>{const current=sourceStat(path),owned=fstatSync(fd,{bigint:true});if(released||holder.exitCode!==null||holder.signalCode!==null||!current?.isFile()||current.nlink!==1n||current.dev!==held.dev||current.ino!==held.ino||owned.dev!==held.dev||owned.ino!==held.ino||(current.mode&0o7777n)!==0o600n||current.uid!==held.uid||current.size!==0n)throw Error('Authority exclusion was lost or replaced');};
    assertHeld();return {assertHeld,release};
  }catch(error){await release();throw error;}
}
