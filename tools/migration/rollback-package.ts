import {constants,closeSync,fstatSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,readdirSync,realpathSync,unlinkSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve,sep} from 'node:path';
import {digest,parseJson} from './music-codec';
import {PackageManifest,encodeRollbackPackage,decodeRollbackPackage,packageDecode,safePackagePath,type RollbackPackage,type PackageManifestValue} from './rollback-package-codec';
import type {MediaSourceFile} from './rollback-media';

const marker='incomplete.json',manifestName='rollback-manifest.json';
const owner=()=>{if(!process.getuid)throw Error('Rollback package requires POSIX permissions');return process.getuid();};
function directory(path:string,privateMode=false){const stat=lstatSync(path,{bigint:true});if(!stat.isDirectory()||stat.isSymbolicLink()||realpathSync(path)!==path||privateMode&&(stat.mode&0o7777n)!==0o700n||privateMode&&stat.uid!==BigInt(owner()))throw Error('Unsafe rollback package directory');return stat;}
function read(path:string,limit:number){const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const stat=fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||(stat.mode&0o7777)!==0o600||stat.uid!==owner()||stat.size>limit)throw Error('Unsafe rollback package file');return readFileSync(fd);}finally{closeSync(fd);}}
function sync(path:string){const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{fsyncSync(fd);}finally{closeSync(fd);}}
function write(path:string,bytes:Buffer){const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}}
function sameDirectory(path:string,expected:ReturnType<typeof directory>,privateMode=false){const next=directory(path,privateMode);if(next.dev!==expected.dev||next.ino!==expected.ino)throw Error('Rollback package directory was replaced');}
function inventory(root:string,paths:string[]){
  const expected=new Set(paths);if(expected.size!==paths.length)throw Error('Duplicate rollback package files');const folders=new Set<string>();for(const path of paths){safePackagePath(path);for(let parent=dirname(path);parent!=='.';parent=dirname(parent))folders.add(parent);}
  const seen=new Set<string>(),directories=new Map<string,ReturnType<typeof directory>>();function visit(prefix=''){directories.set(prefix,directory(join(root,prefix),true));for(const item of readdirSync(join(root,prefix),{withFileTypes:true})){const path=prefix?prefix+'/'+item.name:item.name;if(item.isDirectory()&&folders.has(path))visit(path);else if(item.isFile()&&expected.has(path))seen.add(path);else throw Error('Unclassified rollback package inventory');}}
  visit();if(seen.size!==expected.size)throw Error('Missing rollback package files');return ()=>{for(const [path,stat] of directories)sameDirectory(join(root,path),stat,true);};
}
/** External complete manifest pin is mandatory. Permissions, inventories,
 * bytes and full cross-domain semantics are verified before returning evidence. */
export function readRollbackPackage(root:string,manifestSha256:string){
  if(resolve(root)!==root||!/^[a-f0-9]{64}$/.test(manifestSha256))throw Error('Invalid rollback package path or pin');
  const rootStat=directory(root,true),encoded=read(join(root,manifestName),16*1024*1024);if(digest(encoded)!==manifestSha256)throw Error('Rollback package manifest pin differs');
  const manifest=PackageManifest.parse(parseJson(packageDecode(encoded))),paths=[manifestName,...manifest.files.map(file=>file.path)],checkDirectories=inventory(root,paths);
  const files=manifest.files.map(file=>({path:file.path,bytes:read(join(root,file.path),file.size)})),result=decodeRollbackPackage(manifest,files);
  function assertUnchanged(){sameDirectory(root,rootStat,true);const check=inventory(root,paths);if(!read(join(root,manifestName),16*1024*1024).equals(encoded))throw Error('Rollback package manifest changed');for(const file of files)if(!read(join(root,file.path),file.bytes.length).equals(file.bytes))throw Error('Rollback package bytes changed');checkDirectories();check();}
  assertUnchanged();return {...result,manifest,manifestSha256,assertUnchanged};
}
/** Exclusively reserves the final private directory, never renames onto an
 * existing target. A manifest is written last after all files/dirs are synced;
 * incomplete directories are retained for inspection and never auto-resumed. */
export function writeRollbackPackage(input:RollbackPackage,destination:string,sourceRoots:string[],now=new Date(),assertSourceUnchanged?:()=>void){
  function sourcesUnchanged(){const result:unknown=assertSourceUnchanged?.();if(result!==null&&(typeof result==='object'||typeof result==='function')&&'then' in result)throw Error('Rollback package source guard must be synchronous');}
  if(resolve(destination)!==destination||!sourceRoots.length)throw Error('Explicit canonical destination and isolated source roots are required');
  const parent=dirname(destination),parentStat=directory(parent),inside=(path:string,root:string)=>path===root||path.startsWith(root.endsWith(sep)?root:root+sep);for(const root of sourceRoots){directory(root);if(inside(destination,root)||inside(root,destination))throw Error('Rollback package source and destination must be isolated');}
  const files=encodeRollbackPackage(input),manifest:PackageManifestValue=PackageManifest.parse({version:input.version,kind:'qgroup-private-rollback-package',createdAt:now.toISOString(),sourcePins:input.sourcePins,files:files.map(file=>({path:file.path,size:file.bytes.length,sha256:digest(file.bytes)})),rollbackEligible:false}),encoded=Buffer.from(JSON.stringify(manifest)+'\n');
  if(encoded.length>16*1024*1024)throw Error('Rollback package manifest exceeds supported size');sourcesUnchanged();sameDirectory(parent,parentStat);
  mkdirSync(destination,{mode:0o700});const rootStat=directory(destination,true),incomplete=Buffer.from('{"version":1,"status":"incomplete","rollbackEligible":false}\n');
  function owned(){sameDirectory(parent,parentStat);sameDirectory(destination,rootStat,true);}
  try{
    write(join(destination,marker),incomplete);sync(destination);sync(parent);
    const folders=new Set<string>();for(const file of files){for(let path=dirname(file.path);path!=='.';path=dirname(path))folders.add(path);}
    const ordered=[...folders].sort((a,b)=>a.split('/').length-b.split('/').length||a.localeCompare(b));for(const path of ordered){owned();mkdirSync(join(destination,path),{mode:0o700});directory(join(destination,path),true);}
    for(const file of files){owned();directory(dirname(join(destination,file.path)),true);write(join(destination,file.path),file.bytes);}
    owned();const check=inventory(destination,[marker,...files.map(file=>file.path)]);
    const saved:MediaSourceFile[]=files.map(file=>({path:file.path,bytes:read(join(destination,file.path),file.bytes.length)}));decodeRollbackPackage(manifest,saved);
    for(const path of ordered.reverse())sync(join(destination,path));sync(destination);check();owned();
    sourcesUnchanged();if(!read(join(destination,marker),incomplete.length).equals(incomplete))throw Error('Rollback package incomplete marker changed');unlinkSync(join(destination,marker));sync(destination);
    write(join(destination,manifestName),encoded);sync(destination);sync(parent);owned();
    const result=readRollbackPackage(destination,digest(encoded));result.assertUnchanged();sourcesUnchanged();
    const markIncomplete=()=>{owned();const path=join(destination,marker);try{lstatSync(path);if(!read(path,incomplete.length).equals(incomplete))throw Error('Rollback failure marker differs');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;write(path,incomplete);}sync(destination);sync(parent);};
    return {markIncomplete,status:'sealed_private_package' as const,manifestSha256:digest(encoded),files:files.length,bytes:files.reduce((n,file)=>n+file.bytes.length,0),checkpointDigest:manifest.sourcePins.checkpointSha256,rollbackEligible:false as const,remaining:result.report.remaining};
  }catch(error){
    // Only our original inode may receive a failure marker. Never follow a
    // replaced directory or remove someone else's files after a failed write.
    try{owned();const path=join(destination,marker);try{lstatSync(path);}catch(missing){if((missing as NodeJS.ErrnoException).code!=='ENOENT')throw missing;write(path,incomplete);sync(destination);}}catch{/* Retain every surviving file; original failure remains authoritative. */}
    throw error;
  }
}
