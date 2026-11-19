import Database from 'better-sqlite3';
import {constants,closeSync,lstatSync,openSync,readSync,realpathSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {isMainThread} from 'node:worker_threads';
const registry=globalThis as typeof globalThis & {[key:symbol]:unknown};
const activeOwners=(registry[Symbol.for('qgroup.bot.ownership.v1')]??=new Set<string>()) as Set<string>;
function regular(path:string){
  if(resolve(path)!==path||realpathSync(path)!==path)throw Error('Bot exclusion requires canonical files');
  const stat=lstatSync(path,{bigint:true});if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1n)throw Error('Unsafe bot exclusion file');return stat;
}
/** Use only an existing delivery-owner file. Never chmod it, inspect/reclaim
 * outbox work, start workers, or read configuration/credentials. SQLite may
 * create its transient owner journal while acquiring the existing protocol.
 * The OS lock excludes participating Python/TS entry points; other hosts,
 * bypassing workers and service/deployment/retention control remain separate. */
export function withRollbackBotExclusion<T>(database:string,work:(guard:{assertHeld:()=>void})=>T):T{
  if(!isMainThread)throw Error('Bot exclusion requires the main thread');
  const source=regular(database),path=join(dirname(database),'.bot-owner.sqlite3'),original=regular(path);
  if((original.mode&0o7777n)!==0o600n||!process.getuid||original.uid!==BigInt(process.getuid()))throw Error('Bot exclusion requires the existing private owner file');
  if(activeOwners.has(path))throw Error('Bot delivery ownership already held in this process');
  for(const suffix of ['-wal','-shm','-journal']){try{lstatSync(path+suffix);throw Error('Bot exclusion owner has a sidecar');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const header=Buffer.alloc(100),size=readSync(fd,header,0,100,0);if(original.size!==0n&&(size!==100||!header.subarray(0,16).equals(Buffer.from('SQLite format 3\0'))||header[18]!==1||header[19]!==1))throw Error('Bot exclusion requires an existing DELETE owner file');}finally{closeSync(fd);}
  activeOwners.add(path);let db:Database.Database|undefined,active=true;
  function assertHeld(){
    if(!active||!db?.inTransaction)throw Error('Bot exclusion lock was released');
    // POSIX record locks are process-wide: opening then closing any additional
    // descriptor for this inode would release SQLite's lock. Stat only here,
    // including the business DB which may already hold its own writer lock.
    const next=regular(database),owner=regular(path);
    if(next.dev!==source.dev||next.ino!==source.ino)throw Error('Bot exclusion database was replaced');
    if(owner.dev!==original.dev||owner.ino!==original.ino||owner.size!==original.size||owner.mtimeNs!==original.mtimeNs||owner.mode!==original.mode||owner.uid!==original.uid)throw Error('Bot exclusion owner file was changed');
  }
  try{
    // Header/sidecars were checked before opening. Retain the native DELETE
    // protocol; do not recover/switch a WAL owner or read it through another FD.
    db=new Database(path,{fileMustExist:true,timeout:0});
    if(db.pragma('journal_mode = DELETE',{simple:true})!=='delete')throw Error('Bot exclusion owner journal mode differs');
    db.exec('BEGIN EXCLUSIVE');assertHeld();
    const result=work({assertHeld});
    if(result!==null&&(typeof result==='object'||typeof result==='function')&&'then' in result)throw Error('Bot exclusion callback must be synchronous');
    assertHeld();return result;
  }finally{active=false;try{db?.close();}finally{activeOwners.delete(path);}}
}
