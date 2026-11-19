import {constants,closeSync,fsyncSync,mkdirSync,openSync,readdirSync,unlinkSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {z} from 'zod';
import {readRollbackPackage} from './rollback-package';
import {snapshotRollbackFile,sourceDirectory,sourceStat} from './rollback-source-files';
import {rollbackInside} from './rollback-capture-boundary';
import {digest,parseJson} from './music-codec';
import {projectRollbackBoardHistory,type RollbackBoardHistory} from './rollback-board-history';
import {verifyRollbackBoardHistory} from './rollback-board-history-reconciliation';
const sha=z.string().regex(/^[a-f0-9]{64}$/),descriptor=z.object({path:z.string(),size:z.number().int().nonnegative().safe().max(512*1024*1024),sha256:sha}).strict();
const metadata=z.discriminatedUnion('source',[
  z.object({id:z.string(),source:z.literal('legacy_board'),sourceStamp:z.string().regex(/^[0-9]{8}-[0-9]{6}-[0-9]{6}$/),createdAt:z.null(),schema:z.null(),databaseSha256:sha,assetsSha256:sha.nullable()}).strict(),
  z.object({id:z.string(),source:z.literal('native_board'),sourceStamp:z.string().regex(/^[0-9]{8}-[0-9]{6}-[a-f0-9]{32}$/),createdAt:z.iso.datetime(),schema:z.union([z.literal(13),z.literal(14),z.literal(15)]),databaseSha256:sha,assetsSha256:sha}).strict(),
]).refine(row=>row.id===(row.source==='legacy_board'?'legacy-board-':'native-board-')+row.sourceStamp);
export const BoardHistoryArtifactManifest=z.object({version:z.literal(1),kind:z.literal('qgroup-private-board-history'),preparedAt:z.iso.datetime(),sourcePackageSha256:sha,checkpointSha256:sha,journalSha256:sha,metadata,files:z.array(descriptor),historyOnly:z.literal(true),rollbackEligible:z.literal(false)}).strict().refine(value=>{
  const paths=value.files.map(row=>row.path);return new Set(paths).size===paths.length&&JSON.stringify(paths)===JSON.stringify([...paths].sort())&&paths.includes('board.sqlite3')&&paths.includes('board.erasures.jsonl')&&paths.every(path=>['board.sqlite3','board.erasures.jsonl'].includes(path)||/^images\/[a-f0-9]{2}\/[a-f0-9]{64}\.png$/.test(path)&&path.slice(7,9)===path.slice(10,12));
});
const marker='incomplete.json',manifestName='board-history-manifest.json',maximum=16*1024*1024;
function directory(path:string){const stat=sourceDirectory(path);if(!process.getuid||(stat.mode&0o7777n)!==0o700n||stat.uid!==BigInt(process.getuid()))throw Error('Board history directory must be private');return stat;}
function file(path:string,limit:number){const stat=sourceStat(path);if(!process.getuid||!stat?.isFile()||stat.nlink!==1n||(stat.mode&0o7777n)!==0o600n||stat.uid!==BigInt(process.getuid()))throw Error('Board history file must be private');return snapshotRollbackFile(path,limit);}
function write(path:string,bytes:Buffer){const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}}
function sync(path:string){const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{fsyncSync(fd);}finally{closeSync(fd);}}
function inventory(root:string,files:string[],seal:string){
  const expected=new Set([seal,...files]),folders=new Set(['images']);for(const path of files)for(let parent=dirname(path);parent!=='.';parent=dirname(parent))folders.add(parent);
  const identities=new Map<string,ReturnType<typeof directory>>(),seen=new Set<string>();
  function visit(prefix=''){identities.set(prefix,directory(join(root,prefix)));for(const row of readdirSync(join(root,prefix),{withFileTypes:true})){const path=prefix?prefix+'/'+row.name:row.name;if(row.isDirectory()&&folders.has(path))visit(path);else if(row.isFile()&&expected.has(path))seen.add(path);else throw Error('Board history inventory differs');}}
  visit();if(seen.size!==expected.size||[...folders].some(path=>!identities.has(path)))throw Error('Board history inventory missing');return ()=>{for(const [path,identity] of identities){const current=directory(join(root,path));if(current.dev!==identity.dev||current.ino!==identity.ino)throw Error('Board history directory was replaced');}};
}
/** The original package and its independent pin are required for semantic
 * verification; an outer rehash cannot certify a tampered historical database. */
export function readRollbackBoardHistoryArtifact(root:string,pin:string,packageRoot:string,packagePin:string){
  if(resolve(root)!==root||!sha.safeParse(pin).success)throw Error('Board history needs an external complete pin');
  const original=directory(root),encoded=file(join(root,manifestName),maximum);if(!encoded.bytes||encoded.sha256!==pin)throw Error('Board history manifest pin differs');
  const manifest=BoardHistoryArtifactManifest.parse(parseJson(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(encoded.bytes)));if(!encoded.bytes.equals(Buffer.from(JSON.stringify(manifest)+'\n'))||manifest.sourcePackageSha256!==packagePin)throw Error('Board history source or canonical manifest differs');
  const checkDirectories=inventory(root,manifest.files.map(row=>row.path),manifestName),source=readRollbackPackage(packageRoot,packagePin),files=manifest.files.map(row=>{const held=file(join(root,row.path),row.size);if(!held.bytes||held.bytes.length!==row.size||held.sha256!==row.sha256)throw Error('Board history checksum differs');return {...row,held,bytes:held.bytes};});
  const read=(path:string)=>{const bytes=files.find(row=>row.path===path)?.bytes;if(!bytes)throw Error('Missing board history component');return bytes;};
  const projection:RollbackBoardHistory={version:1,preparedAt:manifest.preparedAt,metadata:manifest.metadata,checkpointSha256:manifest.checkpointSha256,journalSha256:manifest.journalSha256,boardImage:read('board.sqlite3'),boardJournal:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(read('board.erasures.jsonl')),images:files.filter(row=>row.path.startsWith('images/')).map(row=>({path:row.path,bytes:row.bytes}))};
  const report=verifyRollbackBoardHistory(source,projection);
  const view=()=>digest(JSON.stringify({...projection,boardImage:digest(projection.boardImage),images:projection.images.map(row=>({...row,bytes:digest(row.bytes)}))})),initialView=view();
  function assertUnchanged(){const current=directory(root);if(current.dev!==original.dev||current.ino!==original.ino)throw Error('Board history root was replaced');if(!encoded.bytes?.equals(Buffer.from(JSON.stringify(manifest)+'\n'))||view()!==initialView)throw Error('Board history manifest or projection view changed');encoded.assertUnchanged();for(const row of files){if(digest(row.bytes)!==row.sha256)throw Error('Board history byte view changed');row.held.assertUnchanged();}source.assertUnchanged();checkDirectories();inventory(root,manifest.files.map(row=>row.path),manifestName);}
  assertUnchanged();return {manifest,manifestSha256:pin,projection,report,assertUnchanged,rollbackEligible:false as const};
}
export function writeRollbackBoardHistoryArtifact(packageRoot:string,packagePin:string,id:string,destination:string,now=new Date(),assertBoundary?:()=>void){
  const source=readRollbackPackage(packageRoot,packagePin);if(resolve(destination)!==destination)throw Error('Canonical board history destination required');
  const parent=sourceDirectory(dirname(destination)),roots=[packageRoot];if(source.version!==1)roots.push(dirname(source.bot.sources.database),source.bot.sources.logDirectory,...(source.bot.sources.sensitiveWordsFile?[dirname(source.bot.sources.sensitiveWordsFile)]:[]));if(source.version===3){const input=parseJson(source.captureInput.toString()) as {history:{capture:{root:string}}};roots.push(input.history.capture.root);}for(const root of roots)if(rollbackInside(destination,root)||rollbackInside(root,destination))throw Error('Board history output must be isolated from sources');
  const projected=projectRollbackBoardHistory(source,id,now),files=[{path:'board.sqlite3',bytes:projected.boardImage},{path:'board.erasures.jsonl',bytes:Buffer.from(projected.boardJournal)},...projected.images].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  const manifest=BoardHistoryArtifactManifest.parse({version:1,kind:'qgroup-private-board-history',preparedAt:projected.preparedAt,sourcePackageSha256:packagePin,checkpointSha256:projected.checkpointSha256,journalSha256:projected.journalSha256,metadata:projected.metadata,files:files.map(row=>({path:row.path,size:row.bytes.length,sha256:digest(row.bytes)})),historyOnly:true,rollbackEligible:false}),encoded=Buffer.from(JSON.stringify(manifest)+'\n');if(encoded.length>maximum)throw Error('Board history manifest exceeds limit');
  function sourceHeld(){source.assertUnchanged();const result:unknown=assertBoundary?.();if(result!==null&&(typeof result==='object'||typeof result==='function')&&'then' in result)throw Error('Board history guard must be synchronous');source.assertUnchanged();}
  sourceHeld();const afterParent=sourceDirectory(dirname(destination));if(afterParent.dev!==parent.dev||afterParent.ino!==parent.ino)throw Error('Board history output parent was replaced');mkdirSync(destination,{mode:0o700});const identity=directory(destination),incomplete=Buffer.from('{"version":1,"status":"incomplete","rollbackEligible":false}\n');
  const folders=new Map<string,ReturnType<typeof directory>>();
  function rootOwned(){const current=directory(destination),after=sourceDirectory(dirname(destination));if(current.dev!==identity.dev||current.ino!==identity.ino||after.dev!==parent.dev||after.ino!==parent.ino)throw Error('Board history output was replaced');}
  function owned(){rootOwned();for(const [path,original] of folders){const checked=directory(join(destination,path));if(checked.dev!==original.dev||checked.ino!==original.ino)throw Error('Board history image directory was replaced');}}
  const markIncomplete=()=>{rootOwned();if(sourceStat(join(destination,marker))===null)write(join(destination,marker),incomplete);sync(destination);sync(dirname(destination));};
  try{
    write(join(destination,marker),incomplete);sync(destination);sync(dirname(destination));mkdirSync(join(destination,'images'),{mode:0o700});folders.set('images',directory(join(destination,'images')));for(const prefix of [...new Set(projected.images.map(row=>dirname(row.path)))].sort()){owned();mkdirSync(join(destination,prefix),{mode:0o700});folders.set(prefix,directory(join(destination,prefix)));}
    for(const row of files){owned();directory(dirname(join(destination,row.path)));write(join(destination,row.path),row.bytes);}
    const held=inventory(destination,files.map(row=>row.path),marker);for(const row of files)if(file(join(destination,row.path),row.bytes.length).sha256!==digest(row.bytes))throw Error('Board history saved bytes differ');
    for(const prefix of [...new Set(projected.images.map(row=>dirname(row.path)))].sort())sync(join(destination,prefix));sync(join(destination,'images'));sync(destination);held();owned();sourceHeld();owned();held();if(!file(join(destination,marker),incomplete.length).bytes?.equals(incomplete))throw Error('Board history incomplete marker changed');unlinkSync(join(destination,marker));sync(destination);write(join(destination,manifestName),encoded);sync(destination);sync(dirname(destination));
    owned();const result=readRollbackBoardHistoryArtifact(destination,digest(encoded),packageRoot,packagePin);sourceHeld();owned();held();result.assertUnchanged();return {status:'prepared_private_board_history' as const,manifestSha256:result.manifestSha256,sourcePackageSha256:packagePin,historyId:id,images:projected.images.length,historyOnly:true as const,rollbackEligible:false as const,markIncomplete};
  }catch(error){try{markIncomplete();}catch{/* Retain original failure and surviving evidence; replacements are untouched. */}throw error;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const [root,pin,id,destination,...extra]=process.argv.slice(2);if(!root||!pin||!id||!destination||extra.length){process.stderr.write('Usage: npm run prepare:rollback-board-history -- <private-package> <external-package-SHA256> <exact-history-ID> <new-private-destination>\n');process.exitCode=1;}else try{const {markIncomplete:_guard,...result}=writeRollbackBoardHistoryArtifact(root,pin,id,destination);process.stdout.write(JSON.stringify(result)+'\n');}catch{process.stderr.write('Board history preparation rejected. Preserve private sources and incomplete output; no service or historical bot work was activated.\n');process.exitCode=1;}}
