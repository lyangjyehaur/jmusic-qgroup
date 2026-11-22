import {execFileSync} from 'node:child_process';
import {constants,closeSync,fstatSync,fsyncSync,mkdirSync,openSync,readdirSync,renameSync,unlinkSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {z} from 'zod';
import {REBUILD_SCHEMA_VERSION} from '@qgroup/database';
import {readRollbackPackage} from './rollback-package';
import {describeRollbackBotState} from './rollback-bot-state';
import {rollbackInside} from './rollback-capture-boundary';
import {sourceDirectory,sourceStat,pinRollbackTree} from './rollback-source-files';
import {digest,parseJson} from './music-codec';
import {authorityDomains,encode,privateDirectory,privateFile,readRollbackErasureAuthority} from '../../apps/api/src/erasure-authority-protocol';
import {RecoveryActivationReview,RecoveryActivationManifest,createActivatedRecoveryImage,readRecoveryActivation} from '../../apps/api/src/recovery-activation-protocol';

const absolute=z.string().refine(path=>resolve(path)===path),sha=z.string().regex(/^[a-f0-9]{64}$/);
const document=z.object({path:absolute,sha256:sha}).strict();
export const RecoveryActivationInput=z.object({packageRoot:absolute,packageSha256:sha,authorityRoot:absolute,authoritySha256:sha,
  review:document,evidence:z.object({source:document,capture:document,versions:document,bot:document}).strict(),destination:absolute}).strict();
export type RecoveryActivationInputValue=z.infer<typeof RecoveryActivationInput>;
const decode=(raw:Buffer)=>new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw);
function write(path:string,bytes:Buffer){const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}}
function sync(path:string){const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{fsyncSync(fd);}finally{closeSync(fd);}}
function originalTime(path:string,mtimeNs:string){
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);let held;try{held=fstatSync(fd,{bigint:true});}finally{closeSync(fd);}
  const env={...process.env};for(const key of ['PYTHONHOME','PYTHONPATH','PYTHONSTARTUP'])delete env[key];
  execFileSync('python3',['-I',fileURLToPath(new URL('./restore-bot-file-times.py',import.meta.url)),path,held.dev.toString(),held.ino.toString(),mtimeNs],{env,timeout:5000,maxBuffer:1024,stdio:['ignore','pipe','pipe']});
}
const botPath=(path:string)=>path.startsWith('logs/')?'data/bot-logs/'+path.slice(5):path.startsWith('abbreviations/')?'data/bot-abbreviation-results/'+path.slice(14):path==='configuration/sensitive-words.json'?'data/sensitive-words.json':(()=>{throw Error('Unknown reviewed bot state role');})();
/** Produce an isolated copy after a separately pinned private review. This
 * tool never starts a service, changes the original authority or resolves a
 * platform delivery. Review metadata is not functional compatibility proof. */
export function activateRecoveryCopy(raw:RecoveryActivationInputValue,now=new Date(),assertBoundary?:()=>void){
  const input=RecoveryActivationInput.parse(raw),source=readRollbackPackage(input.packageRoot,input.packageSha256);
  if(source.version===1)throw Error('Recovery activation requires complete external bot state');
  const authority=readRollbackErasureAuthority(input.authorityRoot,input.authoritySha256);
  const reviewedFile=privateFile(input.review.path,4*1024*1024);if(!reviewedFile.bytes||reviewedFile.sha256!==input.review.sha256)throw Error('Recovery review external pin differs');
  const review=RecoveryActivationReview.parse(parseJson(decode(reviewedFile.bytes)));
  const evidence=Object.fromEntries((['source','capture','versions','bot'] as const).map(name=>{
    const spec=input.evidence[name],saved=privateFile(spec.path,4*1024*1024);
    if(!saved.bytes||saved.sha256!==spec.sha256||spec.sha256!==review.evidence[name])throw Error('Recovery evidence external pin differs');
    const doc=parseJson(decode(saved.bytes));if(doc===null||typeof doc!=='object'||Array.isArray(doc))throw Error('Recovery evidence must be a review document');
    return [name,saved];
  })) as Record<keyof typeof input.evidence,ReturnType<typeof privateFile>>;
  if(review.checkpointSha256!==source.sourcePins.checkpointSha256||review.botStateSha256!==source.sourcePins.botStateSha256||review.authorityManifestSha256!==input.authoritySha256||review.authorityHeadSha256!==digest(encode(authority.head))||authority.manifest.sourcePackageSha256!==input.packageSha256||authority.manifest.checkpointSha256!==review.checkpointSha256||review.journalSha256!==digest(authority.ledgers.unified))throw Error('Recovery review is stale or belongs to another source');
  if(Date.parse(review.reviewedAt)>now.getTime()||Date.parse(review.reviewedAt)<Math.max(Date.parse(source.manifest.createdAt),Date.parse(authority.manifest.createdAt)))throw Error('Recovery review must follow the pinned sources');
  if(authority.records.some(row=>row.domain!=='unified')||authorityDomains.some(domain=>domain!=='unified'&&authority.head.ledgers[domain].size!==authority.manifest.baseline.find(row=>row.domain===domain)!.size))throw Error('Old-service erasures require full forward projection before activation');
  const journal=authority.ledgers.unified,activated=createActivatedRecoveryImage(source.state.checkpointImage,journal,review);
  const roots=[input.packageRoot,input.authorityRoot,dirname(source.bot.sources.database),source.bot.sources.logDirectory,source.bot.sources.abbreviationDirectory,...(source.bot.sources.sensitiveWordsFile?[dirname(source.bot.sources.sensitiveWordsFile)]:[])];
  if(source.version===3){const capture=parseJson(decode(source.captureInput)) as {history:{capture:{root:string}}};roots.push(capture.history.capture.root);}
  for(const root of [...roots,input.review.path,...Object.values(input.evidence).map(file=>file.path)])if(rollbackInside(input.destination,root)||rollbackInside(root,input.destination))throw Error('Recovery copy must be isolated from all retained sources');
  const parent=sourceDirectory(dirname(input.destination));
  const files:{path:string;bytes:Buffer;mtimeNs?:string}[]=[{path:'data/unified.sqlite3',bytes:activated.image},{path:'data/unified.erasures.jsonl',bytes:journal}];
  // Full original media inventory is retained, including inactive files.
  for(const file of source.media.originalFiles)files.push({path:'data/'+file.path,bytes:file.bytes});
  for(const file of source.bot.files)files.push({path:botPath(file.path),bytes:file.bytes,mtimeNs:file.mtimeNs});
  files.push({path:'activation/review.json',bytes:reviewedFile.bytes},{path:'activation/activated-checkpoint.sqlite3',bytes:activated.image},{path:'activation/unified.erasures.jsonl',bytes:journal});
  for(const name of ['source','capture','versions','bot'] as const)files.push({path:'activation/'+(name==='versions'?'version-review.json':name+'-review.json'),bytes:evidence[name].bytes!});
  const receipt=RecoveryActivationManifest.parse({version:1,kind:'qgroup-private-recovery-activation',createdAt:now.toISOString(),sourcePackageSha256:input.packageSha256,botStateSha256:review.botStateSha256,reviewSha256:input.review.sha256,checkpointSha256:review.checkpointSha256,activatedCheckpointSha256:digest(activated.image),journalSha256:review.journalSha256,lineageId:review.lineageId,authorityHead:authority.head,
    files:files.filter(file=>file.path.startsWith('activation/')).map(file=>({path:file.path.slice(11),size:file.bytes.length,sha256:digest(file.bytes)})),schema:REBUILD_SCHEMA_VERSION,schemaSha256:activated.schemaSha256,tables:activated.tables,deploymentPerformed:false,releaseEligible:false});
  const receiptBytes=encode(receipt),receiptPin=digest(receiptBytes);files.push({path:'activation/activation-manifest.json',bytes:receiptBytes});
  const manifest={version:1,kind:'qgroup-private-activated-recovery-copy',createdAt:now.toISOString(),sourcePackageSha256:input.packageSha256,authorityManifestSha256:input.authoritySha256,activationManifestSha256:receiptPin,botStateIndex:describeRollbackBotState(source.bot),
    files:files.map(({path,bytes,mtimeNs})=>({path,size:bytes.length,sha256:digest(bytes),...(mtimeNs===undefined?{}:{mtimeNs})})),deploymentPerformed:false,releaseEligible:false};
  const manifestBytes=encode(manifest),marker=Buffer.from('{"version":1,"status":"incomplete","releaseEligible":false}\n');
  function sourcesHeld(){source.assertUnchanged();authority.assertUnchanged();reviewedFile.assertUnchanged();for(const file of Object.values(evidence))file.assertUnchanged();const result:unknown=assertBoundary?.();if(result!==null&&(typeof result==='object'||typeof result==='function')&&'then' in result)throw Error('Recovery activation guard must be synchronous');source.assertUnchanged();authority.assertUnchanged();reviewedFile.assertUnchanged();for(const file of Object.values(evidence))file.assertUnchanged();}
  sourcesHeld();const currentParent=sourceDirectory(dirname(input.destination));if(currentParent.dev!==parent.dev||currentParent.ino!==parent.ino)throw Error('Recovery copy parent replaced');
  mkdirSync(input.destination,{mode:0o700});const root=privateDirectory(input.destination),directories=new Map<string,ReturnType<typeof privateDirectory>>();let databaseIdentity:NonNullable<ReturnType<typeof sourceStat>>|undefined;
  function rootOwned(){const current=privateDirectory(input.destination),currentParent=sourceDirectory(dirname(input.destination));if(current.dev!==root.dev||current.ino!==root.ino||currentParent.dev!==parent.dev||currentParent.ino!==parent.ino)throw Error('Recovery copy output replaced');}
  function owned(){rootOwned();for(const [path,before] of directories){const after=privateDirectory(path);if(after.dev!==before.dev||after.ino!==before.ino)throw Error('Recovery copy subdirectory replaced');}}
  function markIncomplete(){rootOwned();const path=join(input.destination,'incomplete.json');if(sourceStat(path)===null)write(path,marker);else if(!privateFile(path,marker.length).bytes?.equals(marker))throw Error('Recovery marker differs');sync(input.destination);sync(dirname(input.destination));
    // Preserve a failed copy for inspection, but remove its normal service DB
    // entry point and invalidate its receipt. Only our held output inodes move.
    owned();const database=join(input.destination,'data/unified.sqlite3'),current=sourceStat(database);
    if(databaseIdentity&&current?.dev===databaseIdentity.dev&&current.ino===databaseIdentity.ino){const incomplete=database+'.incomplete';if(sourceStat(incomplete)!==null)throw Error('Incomplete database destination exists');renameSync(database,incomplete);sync(dirname(database));}
    if(directories.has(join(input.destination,'activation'))&&sourceStat(join(input.destination,'activation/incomplete.json'))===null){write(join(input.destination,'activation/incomplete.json'),marker);sync(join(input.destination,'activation'));}
  }
  try{
    write(join(input.destination,'incomplete.json'),marker);sync(input.destination);sync(dirname(input.destination));
    const folders=new Set(['data','activation']);for(const file of files)for(let path=dirname(file.path);path!=='.';path=dirname(path))folders.add(path);
    for(const directory of source.bot.directories)if(directory.exists)folders.add(directory.role==='logs'?'data/bot-logs':'data/bot-abbreviation-results');
    const ordered=[...folders].sort((a,b)=>a.split('/').length-b.split('/').length||a.localeCompare(b));
    for(const path of ordered){owned();const full=join(input.destination,path);mkdirSync(full,{mode:0o700});directories.set(full,privateDirectory(full));}
    for(const file of files){owned();const path=join(input.destination,file.path);write(path,file.bytes);if(file.path==='data/unified.sqlite3')databaseIdentity=sourceStat(path)!;if(file.mtimeNs!==undefined)originalTime(path,file.mtimeNs);}
    const held=files.map(file=>{const path=join(input.destination,file.path),saved=privateFile(path,file.bytes.length);if(!saved.bytes?.equals(file.bytes)||file.mtimeNs!==undefined&&sourceStat(path)!.mtimeNs.toString()!==file.mtimeNs)throw Error('Recovery copy lost original file bytes or time');return saved;});
    function inventory(complete:boolean){owned();const expected=['activation','data',complete?'recovery-copy-manifest.json':'incomplete.json'];if(JSON.stringify(readdirSync(input.destination).sort())!==JSON.stringify(expected.sort()))throw Error('Recovery copy inventory differs');for(const folder of ordered){const expected=[...folders].filter(path=>dirname(path)===folder).map(path=>path.slice(folder.length+1)).concat(files.filter(file=>dirname(file.path)===folder).map(file=>file.path.slice(folder.length+1)));if(JSON.stringify(readdirSync(join(input.destination,folder)).sort())!==JSON.stringify(expected.sort()))throw Error('Recovery copy file inventory differs');}}
    const activation=readRecoveryActivation(join(input.destination,'activation'),receiptPin,source.state.checkpointImage,authority);
    function unchanged(complete:boolean){inventory(complete);for(const file of held)file.assertUnchanged();activation.assertUnchanged();}
    unchanged(false);for(const folder of [...ordered].reverse())sync(join(input.destination,folder));sync(input.destination);sourcesHeld();unchanged(false);
    if(!privateFile(join(input.destination,'incomplete.json'),marker.length).bytes?.equals(marker))throw Error('Recovery copy marker changed');unlinkSync(join(input.destination,'incomplete.json'));write(join(input.destination,'recovery-copy-manifest.json'),manifestBytes);sync(input.destination);sync(dirname(input.destination));
    const heldManifest=privateFile(join(input.destination,'recovery-copy-manifest.json'),manifestBytes.length),tree=pinRollbackTree(input.destination);
    if(!heldManifest.bytes?.equals(manifestBytes))throw Error('Recovery copy manifest differs');unchanged(true);sourcesHeld();unchanged(true);tree.assertUnchanged();heldManifest.assertUnchanged();
    return {status:'activated_private_recovery_copy' as const,manifestSha256:digest(manifestBytes),activationManifestSha256:receiptPin,files:files.length,uncertainDeliveriesPreserved:review.deliveries.length,deploymentPerformed:false as const,releaseEligible:false as const,
      assertUnchanged(){unchanged(true);tree.assertUnchanged();heldManifest.assertUnchanged();},markIncomplete};
  }catch(error){try{markIncomplete();}catch{/* Preserve surviving private evidence; never touch a replacement. */}throw error;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [path,pin,...extra]=process.argv.slice(2);
  if(!path||!pin||extra.length){process.stderr.write('Usage: npm run activate:recovery-copy -- <private-input.json> <external-input-sha256>\n');process.exitCode=1;}
  else try{const input=privateFile(path,4*1024*1024);if(!input.bytes||input.sha256!==pin)throw Error('Activation input external pin differs');const {assertUnchanged:_check,markIncomplete:_marker,...result}=activateRecoveryCopy(RecoveryActivationInput.parse(parseJson(decode(input.bytes))),new Date(),()=>input.assertUnchanged());process.stdout.write(JSON.stringify(result)+'\n');}
  catch{process.stderr.write('Recovery activation rejected. Preserve private sources and incomplete output; no service was started or message delivered.\n');process.exitCode=1;}
}
