import {constants,closeSync,fstatSync,lstatSync,openSync,readFileSync,readdirSync,realpathSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {digest} from './music-codec';
export function sourceStat(path:string){try{return lstatSync(path,{bigint:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}}
export function sourceDirectory(path:string){const stat=sourceStat(path);if(resolve(path)!==path||!stat?.isDirectory()||stat.isSymbolicLink()||realpathSync(path)!==path)throw Error('Unsafe rollback source directory');return stat;}
const fingerprint=(stat:NonNullable<ReturnType<typeof sourceStat>>)=>[stat.dev,stat.ino,stat.mode,stat.nlink,stat.uid,stat.gid,stat.size,stat.mtimeNs,stat.ctimeNs].map(String);
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
/** External files only. Never pass a SQLite/owner inode held by this process:
 * closing an extra FD would release its POSIX record locks. No chmod/cleanup. */
export function snapshotRollbackFile(path:string,limit:number,allowMissing=false){
  if(resolve(path)!==path)throw Error('Rollback source file must be canonical');
  const parent=sourceDirectory(dirname(path)),original=sourceStat(path);
  function parentHeld(){const after=sourceDirectory(dirname(path));if(after.dev!==parent.dev||after.ino!==parent.ino)throw Error('Rollback source parent was replaced');}
  function read(expected:NonNullable<ReturnType<typeof sourceStat>>){
    parentHeld();const before=sourceStat(path);if(!before?.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size>BigInt(limit)||realpathSync(path)!==path)throw Error('Unsafe rollback source file');
    if(!equal(fingerprint(before),fingerprint(expected)))throw Error('Rollback source file changed before opening');
    const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{const held=fstatSync(fd,{bigint:true});if(!equal(fingerprint(before),fingerprint(held)))throw Error('Rollback source changed before reading');const bytes=readFileSync(fd),after=sourceStat(path);if(BigInt(bytes.length)!==held.size||!after||!equal(fingerprint(held),fingerprint(fstatSync(fd,{bigint:true})))||!equal(fingerprint(held),fingerprint(after)))throw Error('Rollback source changed while reading');return {bytes,stat:held};}finally{closeSync(fd);}
  }
  if(original===null){if(!allowMissing)throw Error('Missing rollback source file');return {bytes:null,sha256:null,assertUnchanged(){parentHeld();if(sourceStat(path)!==null)throw Error('Rollback source file appeared');}};}
  const captured=read(original);if(!equal(fingerprint(original),fingerprint(captured.stat)))throw Error('Rollback source changed before capture');
  return {bytes:Buffer.from(captured.bytes),sha256:digest(captured.bytes),assertUnchanged(){const after=read(captured.stat);if(!equal(fingerprint(captured.stat),fingerprint(after.stat))||!captured.bytes.equals(after.bytes))throw Error('Rollback source file changed');}};
}
/** Full immutable tree identity/inventory fence, including empty directories.
 * It reads metadata only; content authority still comes from domain pins. */
export function pinRollbackTree(root:string,allowMissing=false){
  if(resolve(root)!==root)throw Error('Rollback tree must be canonical');
  const parent=sourceDirectory(dirname(root));
  function snapshot(){
    const after=sourceDirectory(dirname(root));if(after.dev!==parent.dev||after.ino!==parent.ino)throw Error('Rollback tree parent was replaced');
    if(sourceStat(root)===null){if(!allowMissing)throw Error('Missing rollback source tree');return null;}
    const entries:{path:string;identity:string[]}[]=[];
    function visit(path:string){const full=join(root,path),stat=sourceStat(full);if(!stat||stat.isSymbolicLink()||realpathSync(full)!==full||!stat.isFile()&&!stat.isDirectory()||stat.isFile()&&stat.nlink!==1n)throw Error('Unsafe rollback source tree');entries.push({path,identity:fingerprint(stat)});if(stat.isDirectory())for(const name of readdirSync(full).sort())visit(path?path+'/'+name:name);}
    sourceDirectory(root);visit('');return entries;
  }
  const original=snapshot();return {assertUnchanged(){if(!equal(snapshot(),original))throw Error('Rollback source tree changed');}};
}
