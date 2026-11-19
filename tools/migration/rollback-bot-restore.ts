import {execFileSync} from 'node:child_process';
import {constants,closeSync,fstatSync,fsyncSync,lstatSync,mkdirSync,openSync,readdirSync,unlinkSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {z} from 'zod';
import {BotStateIndex,describeRollbackBotState,verifyRollbackBotIndex,verifyRollbackBotState,type RollbackBotState} from './rollback-bot-state';
import {readRollbackPackage} from './rollback-package';
import {rollbackInside} from './rollback-capture-boundary';
import {sourceDirectory,sourceStat,snapshotRollbackFile} from './rollback-source-files';
import {digest,parseJson} from './music-codec';

const manifestName='bot-restore-manifest.json',marker='incomplete.json',sha=z.string().regex(/^[a-f0-9]{64}$/),limit=16*1024*1024;
const Descriptor=z.object({path:z.string(),sourcePath:z.string(),size:z.number().int().nonnegative().safe().max(512*1024*1024),sha256:sha,mtimeNs:z.string().regex(/^-?[0-9]{1,30}$/)}).strict();
export const BotRestoreManifest=z.object({version:z.literal(1),kind:z.literal('qgroup-private-bot-restore'),createdAt:z.iso.datetime(),sourcePackageSha256:sha,sourceBotStateSha256:sha,sourceIndex:BotStateIndex,files:z.array(Descriptor),rollbackEligible:z.literal(false)}).strict();
const targetPath=(path:string)=>path.startsWith('logs/')?'bot-logs/'+path.slice(5):path.startsWith('abbreviations/')?'bot-abbreviation-results/'+path.slice(14):path==='configuration/sensitive-words.json'?'sensitive-words.json':(()=>{throw Error('Unknown bot restore role');})();
const owner=()=>{if(!process.getuid)throw Error('Bot restore requires POSIX permissions');return BigInt(process.getuid());};
function privateDirectory(path:string){const stat=sourceDirectory(path);if((stat.mode&0o7777n)!==0o700n||stat.uid!==owner())throw Error('Bot restore directory must be private');return stat;}
function privateFile(path:string,max:number){const before=sourceStat(path);if(!before?.isFile()||before.nlink!==1n||(before.mode&0o7777n)!==0o600n||before.uid!==owner())throw Error('Bot restore file must be private');return snapshotRollbackFile(path,max);}
function sync(path:string){const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{fsyncSync(fd);}finally{closeSync(fd);}}
function write(path:string,bytes:Buffer){const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}}
function restoredDirectories(state:RollbackBotState){return state.directories.filter(row=>row.exists).map(row=>row.role==='logs'?'bot-logs':'bot-abbreviation-results');}
function inventory(root:string,state:RollbackBotState,paths:string[]){
  const folders=restoredDirectories(state),expected=[...folders,...paths.filter(path=>!path.includes('/'))].sort();if(JSON.stringify(readdirSync(root).sort())!==JSON.stringify(expected))throw Error('Bot restore root inventory differs');
  for(const folder of folders){privateDirectory(join(root,folder));const names=paths.filter(path=>path.startsWith(folder+'/')).map(path=>path.slice(folder.length+1)).sort();if(JSON.stringify(readdirSync(join(root,folder)).sort())!==JSON.stringify(names))throw Error('Bot restore file inventory differs');}
}
function stateFromManifest(manifest:z.infer<typeof BotRestoreManifest>,root:string){
  verifyRollbackBotIndex(manifest.sourceIndex,manifest.sourceBotStateSha256);
  const {sourceIndex:index}=manifest,files=index.files.map(file=>{const path=join(root,targetPath(file.path)),held=privateFile(path,file.size);if(!held.bytes||held.bytes.length!==file.size||held.sha256!==file.sha256||lstatSync(path,{bigint:true}).mtimeNs.toString()!==file.mtimeNs)throw Error('Bot restore original bytes or time differ');return {path:file.path,bytes:held.bytes,mtimeNs:file.mtimeNs};});
  const state:RollbackBotState={version:1,capturedAt:index.capturedAt,sources:index.sources,directories:index.directories,files};verifyRollbackBotState(state,manifest.sourceBotStateSha256);
  const descriptors=index.files.map(file=>({path:targetPath(file.path),sourcePath:file.path,size:file.size,sha256:file.sha256,mtimeNs:file.mtimeNs}));if(JSON.stringify(manifest.files)!==JSON.stringify(descriptors))throw Error('Bot restore mapping differs');return state;
}
/** Private original-time verification only; no live paths, service, worker,
 * SQLite, environment files, delivery or cleanup. Full rollback stays blocked. */
export function readRollbackBotRestore(root:string,manifestSha256:string){
  if(resolve(root)!==root||!sha.safeParse(manifestSha256).success)throw Error('Bot restore requires an external complete manifest pin');
  const original=privateDirectory(root),heldManifest=privateFile(join(root,manifestName),limit);if(!heldManifest.bytes||heldManifest.sha256!==manifestSha256)throw Error('Bot restore manifest pin differs');
  const manifest=BotRestoreManifest.parse(parseJson(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(heldManifest.bytes)));if(!heldManifest.bytes.equals(Buffer.from(JSON.stringify(manifest)+'\n')))throw Error('Noncanonical bot restore manifest');
  const state=stateFromManifest(manifest,root),paths=[manifestName,...manifest.files.map(file=>file.path)];inventory(root,state,paths);
  const directories=restoredDirectories(state).map(folder=>({path:join(root,folder),identity:privateDirectory(join(root,folder))})),heldFiles=manifest.files.map(file=>privateFile(join(root,file.path),file.size));
  function assertUnchanged(){const current=privateDirectory(root);if(current.dev!==original.dev||current.ino!==original.ino)throw Error('Bot restore root was replaced');if(!heldManifest.bytes?.equals(Buffer.from(JSON.stringify(manifest)+'\n')))throw Error('Bot restore manifest view changed');heldManifest.assertUnchanged();for(const directory of directories){const current=privateDirectory(directory.path);if(current.dev!==directory.identity.dev||current.ino!==directory.identity.ino)throw Error('Bot restore directory was replaced');}for(const file of heldFiles)file.assertUnchanged();inventory(root,state,paths);stateFromManifest(manifest,root);}
  assertUnchanged();return {manifest,manifestSha256,state,assertUnchanged,rollbackEligible:false as const};
}
/** Restore latest bot bytes and exact original mtime to a new isolated private
 * evidence directory. It has no DB/owner/config; this tool activates no service. */
export function writeRollbackBotRestore(packageRoot:string,packageSha256:string,destination:string,now=new Date(),assertBoundary?:()=>void){
  const source=readRollbackPackage(packageRoot,packageSha256);if(source.version===1)throw Error('Rollback package has no latest external bot state');
  verifyRollbackBotState(source.bot,source.sourcePins.botStateSha256);if(resolve(destination)!==destination)throw Error('Canonical bot restore destination required');
  const parent=sourceDirectory(dirname(destination)),roots=[packageRoot,dirname(source.bot.sources.database),source.bot.sources.logDirectory,...(source.bot.sources.sensitiveWordsFile?[dirname(source.bot.sources.sensitiveWordsFile)]:[])];
  if(source.version===3){const input=parseJson(source.captureInput.toString()) as {history:{capture:{root:string}}};roots.push(input.history.capture.root);}
  for(const root of roots)if(rollbackInside(destination,root)||rollbackInside(root,destination))throw Error('Bot restore must be isolated from all original sources');
  const state=source.bot,index=describeRollbackBotState(state),manifest=BotRestoreManifest.parse({version:1,kind:'qgroup-private-bot-restore',createdAt:now.toISOString(),sourcePackageSha256:packageSha256,sourceBotStateSha256:source.sourcePins.botStateSha256,sourceIndex:index,files:index.files.map(file=>({path:targetPath(file.path),sourcePath:file.path,size:file.size,sha256:file.sha256,mtimeNs:file.mtimeNs})),rollbackEligible:false});
  const encoded=Buffer.from(JSON.stringify(manifest)+'\n');if(encoded.length>limit)throw Error('Bot restore manifest exceeds supported size');
  function sourcesHeld(){source.assertUnchanged();const result:unknown=assertBoundary?.();if(result!==null&&(typeof result==='object'||typeof result==='function')&&'then' in result)throw Error('Bot restore guard must be synchronous');source.assertUnchanged();}
  sourcesHeld();const beforeParent=sourceDirectory(dirname(destination));if(beforeParent.dev!==parent.dev||beforeParent.ino!==parent.ino)throw Error('Bot restore parent was replaced');mkdirSync(destination,{mode:0o700});const original=privateDirectory(destination),incomplete=Buffer.from('{"version":1,"status":"incomplete","rollbackEligible":false}\n');
  const directories=new Map<string,ReturnType<typeof privateDirectory>>();
  function rootOwned(){const currentParent=sourceDirectory(dirname(destination)),current=privateDirectory(destination);if(currentParent.dev!==parent.dev||currentParent.ino!==parent.ino||current.dev!==original.dev||current.ino!==original.ino)throw Error('Bot restore output was replaced');}
  function owned(){rootOwned();for(const [path,before] of directories){const after=privateDirectory(path);if(after.dev!==before.dev||after.ino!==before.ino)throw Error('Bot restore directory was replaced');}}
  const markIncomplete=()=>{rootOwned();if(sourceStat(join(destination,marker))===null)write(join(destination,marker),incomplete);else{const held=privateFile(join(destination,marker),incomplete.length);if(!held.bytes?.equals(incomplete))throw Error('Bot restore marker differs');}sync(destination);sync(dirname(destination));};
  try{
    write(join(destination,marker),incomplete);sync(destination);sync(dirname(destination));for(const folder of restoredDirectories(state)){owned();const path=join(destination,folder);mkdirSync(path,{mode:0o700});directories.set(path,privateDirectory(path));}
    const environment={...process.env};for(const name of ['PYTHONPATH','PYTHONHOME','PYTHONSTARTUP'])delete environment[name];
    for(const file of state.files){owned();const path=join(destination,targetPath(file.path));privateDirectory(dirname(path));write(path,file.bytes);const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);let identity;try{identity=fstatSync(fd,{bigint:true});}finally{closeSync(fd);}
      execFileSync('python3',['-I',fileURLToPath(new URL('./restore-bot-file-times.py',import.meta.url)),path,identity.dev.toString(),identity.ino.toString(),file.mtimeNs],{timeout:5000,maxBuffer:1024,stdio:['ignore','pipe','pipe'],env:environment});owned();
      const held=privateFile(path,file.bytes.length);if(!held.bytes?.equals(file.bytes)||lstatSync(path,{bigint:true}).mtimeNs.toString()!==file.mtimeNs)throw Error('Bot restore original time differs');
    }
    stateFromManifest(manifest,destination);inventory(destination,state,[marker,...manifest.files.map(file=>file.path)]);for(const folder of restoredDirectories(state))sync(join(destination,folder));sync(destination);owned();sourcesHeld();
    if(!privateFile(join(destination,marker),incomplete.length).bytes?.equals(incomplete))throw Error('Bot restore incomplete marker changed');unlinkSync(join(destination,marker));sync(destination);write(join(destination,manifestName),encoded);sync(destination);sync(dirname(destination));owned();
    const result=readRollbackBotRestore(destination,digest(encoded));result.assertUnchanged();sourcesHeld();owned();result.assertUnchanged();return {status:'restored_private_bot_evidence' as const,manifestSha256:digest(encoded),sourcePackageSha256:packageSha256,files:manifest.files.length,rollbackEligible:false as const,markIncomplete};
  }catch(error){try{markIncomplete();}catch{/* Keep original failure and surviving private evidence; replacements are untouched. */}throw error;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [root,pin,destination,...extra]=process.argv.slice(2);if(!root||!pin||!destination||extra.length){process.stderr.write('Usage: npm run restore:rollback-bot -- <private-package-directory> <external-manifest-sha256> <new-private-destination>\n');process.exitCode=1;}
  else try{const {markIncomplete:_guard,...result}=writeRollbackBotRestore(root,pin,destination);process.stdout.write(JSON.stringify(result)+'\n');}catch{process.stderr.write('Bot restore rejected. Preserve private sources and incomplete output; no service was activated or work delivered.\n');process.exitCode=1;}
}
