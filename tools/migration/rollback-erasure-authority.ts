import {constants,closeSync,fsyncSync,mkdirSync,openSync,unlinkSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {readRollbackPackage} from './rollback-package';
import {rollbackInside} from './rollback-capture-boundary';
import {sourceDirectory,sourceStat} from './rollback-source-files';
import {digest,parseJson} from './music-codec';
import {decodeErasureJournal,erasureJournalPath} from '../../apps/api/src/erasure-journal';
import {authorityDomains,ErasureAuthorityManifest,ErasureAuthorityHead,validateAuthorityLedger,readRollbackErasureAuthority,privateDirectory,privateFile,encode} from '../../apps/api/src/erasure-authority-protocol';
export * from '../../apps/api/src/erasure-authority-protocol';

function write(path:string,bytes:Buffer){const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}}
function sync(path:string){const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{fsyncSync(fd);}finally{closeSync(fd);}}
/** Explicit, exclusive initialization from a fully verified rollback package.
 * The caller must retain this authority outside every restore/retention scope.
 * It does not activate services or guarantee custody of the authority itself. */
export function writeRollbackErasureAuthority(packageRoot:string,packagePin:string,destination:string,now=new Date(),assertBoundary?:()=>void,nativeJournal?:{database:string;sha256:string}){
  const source=readRollbackPackage(packageRoot,packagePin);if(resolve(destination)!==destination)throw Error('Canonical authority destination required');const parent=sourceDirectory(dirname(destination)),roots=[packageRoot];
  if(source.version!==1)roots.push(dirname(source.bot.sources.database),source.bot.sources.logDirectory,...(source.bot.sources.sensitiveWordsFile?[dirname(source.bot.sources.sensitiveWordsFile)]:[]));if(source.version===3){const input=parseJson(source.captureInput.toString()) as {history:{capture:{root:string}}};roots.push(input.history.capture.root);}
  let nativeFile:ReturnType<typeof privateFile>|undefined;
  if(nativeJournal){
    if(resolve(nativeJournal.database)!==nativeJournal.database||!/^[a-f0-9]{64}$/.test(nativeJournal.sha256)||!sourceStat(nativeJournal.database)?.isFile())throw Error('Explicit native journal database and external pin required');
    privateDirectory(dirname(nativeJournal.database));
    const journalPath=erasureJournalPath(nativeJournal.database),protectedInodes=new Set<string>();
    const protect=(path:string)=>{for(const suffix of ['', '-wal','-shm','-journal']){const stat=sourceStat(nativeJournal.database+suffix);if(stat)protectedInodes.add(stat.dev+':'+stat.ino);}const stat=sourceStat(path);if(stat&&protectedInodes.has(stat.dev+':'+stat.ino))throw Error('Native authority baseline cannot alias SQLite');};
    nativeFile=privateFile(journalPath,64*1024*1024,protect);
    if(!nativeFile.bytes||nativeFile.sha256!==nativeJournal.sha256)throw Error('Original native journal pin differs');
    validateAuthorityLedger('unified',nativeFile.bytes);
    if(JSON.stringify(decodeErasureJournal(nativeFile.bytes.toString('utf8')))!==JSON.stringify(source.state.journal))throw Error('Original native journal differs from pinned checkpoint intents');
    roots.push(dirname(nativeJournal.database));
  }
  for(const root of roots)if(rollbackInside(destination,root)||rollbackInside(root,destination))throw Error('Authority must be isolated from recorded sources');
  const texts={board:source.state.erasures.boardJournal,music:source.state.erasures.musicJournal,unified:nativeFile?.bytes??source.state.erasures.unifiedJournal},baseline=authorityDomains.map(domain=>{const bytes=Buffer.from(texts[domain]);validateAuthorityLedger(domain,bytes);return {domain,path:'baseline/'+domain+'.erasures.jsonl',size:bytes.length,sha256:digest(bytes),bytes};});
  const manifest=ErasureAuthorityManifest.parse({version:1,kind:'qgroup-private-erasure-authority',authorityId:randomBytes(16).toString('hex'),createdAt:now.toISOString(),sourcePackageSha256:packagePin,checkpointSha256:source.sourcePins.checkpointSha256,journalSha256:digest(JSON.stringify(source.state.journal)),baseline:baseline.map(({bytes:_bytes,...row})=>row),rollbackEligible:false}),encoded=encode(manifest),pin=digest(encoded),head=ErasureAuthorityHead.parse({version:1,authoritySha256:pin,sequence:0,recordSha256:null,ledgers:Object.fromEntries(baseline.map(row=>[row.domain,{size:row.size,sha256:row.sha256}]))});
  function guarded(){source.assertUnchanged();nativeFile?.assertUnchanged();const value:unknown=assertBoundary?.();if(value!==null&&(typeof value==='object'||typeof value==='function')&&'then' in value)throw Error('Authority boundary guard must be synchronous');source.assertUnchanged();nativeFile?.assertUnchanged();}
  guarded();const checked=sourceDirectory(dirname(destination));if(checked.dev!==parent.dev||checked.ino!==parent.ino)throw Error('Authority parent replaced');mkdirSync(destination,{mode:0o700});const identity=privateDirectory(destination),marker=Buffer.from('{"version":1,"status":"incomplete","rollbackEligible":false}\n');
  let baselineIdentity:ReturnType<typeof privateDirectory>|undefined,recordsIdentity:ReturnType<typeof privateDirectory>|undefined;
  function owned(){const current=privateDirectory(destination),after=sourceDirectory(dirname(destination));if(current.dev!==identity.dev||current.ino!==identity.ino||after.dev!==parent.dev||after.ino!==parent.ino)throw Error('Authority output replaced');}
  function foldersHeld(){owned();for(const [path,original] of [['baseline',baselineIdentity],['records',recordsIdentity]] as const)if(original){const current=privateDirectory(join(destination,path));if(current.dev!==original.dev||current.ino!==original.ino)throw Error('Authority folder replaced');}}
  const markIncomplete=()=>{owned();if(sourceStat(join(destination,'incomplete.json'))===null)write(join(destination,'incomplete.json'),marker);sync(destination);sync(dirname(destination));};
  try{
    write(join(destination,'incomplete.json'),marker);sync(destination);sync(dirname(destination));mkdirSync(join(destination,'baseline'),{mode:0o700});baselineIdentity=privateDirectory(join(destination,'baseline'));mkdirSync(join(destination,'records'),{mode:0o700});recordsIdentity=privateDirectory(join(destination,'records'));
    for(const row of baseline){foldersHeld();write(join(destination,row.path),row.bytes);}write(join(destination,'.authority.lock'),Buffer.alloc(0));write(join(destination,'authority-head.json'),encode(head));sync(join(destination,'baseline'));sync(join(destination,'records'));sync(destination);guarded();foldersHeld();
    if(!privateFile(join(destination,'incomplete.json'),marker.length).bytes?.equals(marker))throw Error('Authority marker changed');unlinkSync(join(destination,'incomplete.json'));write(join(destination,'authority-manifest.json'),encoded);sync(destination);sync(dirname(destination));
    const result=readRollbackErasureAuthority(destination,pin);guarded();foldersHeld();result.assertUnchanged();return {status:'prepared_private_erasure_authority' as const,manifestSha256:pin,sourcePackageSha256:packagePin,records:0,rollbackEligible:false as const,markIncomplete};
  }catch(error){try{markIncomplete();}catch{/* Preserve the original failure; replacement ownership is untouched. */}throw error;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const [root,pin,destination,...extra]=process.argv.slice(2);if(!root||!pin||!destination||![0,2].includes(extra.length)){process.stderr.write('Usage: tsx tools/migration/rollback-erasure-authority.ts <private-package> <external-package-SHA256> <new-private-authority> [<native-database> <external-native-journal-SHA256>]\n');process.exitCode=1;}else try{const {markIncomplete:_guard,...result}=writeRollbackErasureAuthority(root,pin,destination,new Date(),undefined,extra.length?{database:extra[0]!,sha256:extra[1]!}:undefined);process.stdout.write(JSON.stringify(result)+'\n');}catch{process.stderr.write('Erasure authority preparation rejected. Preserve sources and incomplete output; no service was activated.\n');process.exitCode=1;}}
