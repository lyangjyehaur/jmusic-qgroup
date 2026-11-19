import Database from 'better-sqlite3';
import {realpathSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {decodeErasureJournal,type ErasureJournal} from '../../apps/api/src/erasure-journal';
import {captureRollbackBotState} from './rollback-bot-state';
import {withRollbackBotExclusion} from './rollback-bot-exclusion';
import {withRollbackMediaCapture} from './rollback-media';
import {projectRollbackStateFromCheckpoint} from './rollback-state';
import {readRollbackHistorySources} from './rollback-history-source';
import {projectRollbackHistoryFromSources} from './rollback-history';
import {assembleRollbackPackageV3,pinRollbackPackageSourceV2,pinRollbackPackageSourceV3} from './rollback-package-codec';
import {writeRollbackPackage} from './rollback-package';
import {RollbackCaptureBoundary,RollbackCaptureInput,observeStoppedRollbackServices,rollbackJournalPath,validateRollbackCapturePaths} from './rollback-capture-boundary';
import {inspectRollbackService,type RollbackServiceEvidenceValue} from './rollback-service-evidence';
import {pinRollbackTree,snapshotRollbackFile,sourceDirectory,sourceStat} from './rollback-source-files';
import {digest,parseJson} from './music-codec';

/** Build private evidence from the actual held source. No stop/start, deployment,
 * migration, worker, QQ call, source cleanup or activation. Inspection injection
 * supports isolated tests; the CLI has no bypass/assertion/activation flags. */
export function captureRollbackPackage(captureInput:Buffer,inputSha256:string,now=new Date(),dependencies:{inspect?:(id:string)=>RollbackServiceEvidenceValue;assertInputUnchanged?:()=>void}={}){
  if(!Buffer.isBuffer(captureInput)||captureInput.length>64*1024||!/^[a-f0-9]{64}$/.test(inputSha256)||digest(captureInput)!==inputSha256)throw Error('Rollback capture input pin differs');
  const decode=(bytes:Buffer)=>new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes),input=RollbackCaptureInput.parse(parseJson(decode(captureInput))),capturedAt=now.toISOString();validateRollbackCapturePaths(input);
  const data=dirname(input.database),parent=sourceDirectory(data),database=sourceStat(input.database);if(!database?.isFile()||database.isSymbolicLink()||database.nlink!==1n||resolve(input.database)!==input.database)throw Error('Rollback capture requires an existing canonical database');
  sourceDirectory(input.history.capture.root);sourceDirectory(dirname(input.destination));if(sourceStat(input.destination)!==null)throw Error('Rollback capture destination already exists');
  let inspect=dependencies.inspect;
  if(!inspect){
    const socket=input.dockerSocket??realpathSync('/var/run/docker.sock'),original=sourceStat(socket);if(!original?.isSocket()||realpathSync(socket)!==socket)throw Error('Rollback Docker socket must be canonical and local');
    const identity={dev:original.dev,ino:original.ino};
    const socketHeld=()=>{const current=sourceStat(socket);if(!current?.isSocket()||current.dev!==identity.dev||current.ino!==identity.ino||realpathSync(socket)!==socket)throw Error('Rollback Docker socket was replaced');};
    inspect=(id:string)=>{socketHeld();const result=inspectRollbackService(id,socket);socketHeld();return result;};
  }
  const serviceInspector=inspect,observed=observeStoppedRollbackServices(input,serviceInspector);
  let sealed:ReturnType<typeof writeRollbackPackage>|undefined;
  try{
    const result=withRollbackBotExclusion(input.database,({assertHeld})=>{
      const source=new Database(input.database,{fileMustExist:true,timeout:0});
      try{
        const trees=[pinRollbackTree(input.history.capture.root),pinRollbackTree(input.history.native.root,true),pinRollbackTree(join(data,'images'),true),pinRollbackTree(join(data,'walls'),true)];
        const journalPath=rollbackJournalPath(input.database),journalStat=sourceStat(journalPath);if(journalStat&&journalStat.dev===database.dev&&journalStat.ino===database.ino)throw Error('Rollback journal cannot alias its database');
        const journalSource=snapshotRollbackFile(journalPath,64*1024*1024,true),raw=journalSource.bytes?decode(journalSource.bytes):'';for(const line of raw.split('\n').filter(line=>line.trim()))parseJson(line);
        const entries=decodeErasureJournal(raw),journal:ErasureJournal={read(){journalSource.assertUnchanged();return structuredClone(entries);},append(){throw Error('Read-only rollback source');}};
        return withRollbackMediaCapture(source,journal,({media,assertUnchanged})=>{
          const storage=source.prepare('SELECT lineage_id,recovery_required FROM rebuild_storage WHERE id=1').get() as {lineage_id:string;recovery_required:number}|undefined;if(storage?.lineage_id!==input.expectedLineageId||storage.recovery_required!==0)throw Error('Rollback capture source lineage differs');
          const bot=captureRollbackBotState({database:input.database,...input.bot},now),historySource=readRollbackHistorySources(source,media.journal,input.history);
          function guard(){
            const after=observeStoppedRollbackServices(input,serviceInspector);if(JSON.stringify(after)!==JSON.stringify(observed))throw Error('Rollback source service evidence changed');
            const currentParent=sourceDirectory(data);if(currentParent.dev!==parent.dev||currentParent.ino!==parent.ino)throw Error('Rollback data directory was replaced');
            const checked:unknown=dependencies.assertInputUnchanged?.();if(checked!==null&&(typeof checked==='object'||typeof checked==='function')&&'then' in checked)throw Error('Rollback capture input guard must be synchronous');
            assertHeld();for(const tree of trees)tree.assertUnchanged();assertUnchanged();journalSource.assertUnchanged();bot.assertUnchanged();historySource.assertUnchanged();
          }
          guard();
          const state=projectRollbackStateFromCheckpoint(media.checkpointImage,media.journal),history=projectRollbackHistoryFromSources(state,historySource.sources,historySource.pins),v2=pinRollbackPackageSourceV2(media,historySource.pins,bot.state);
          const boundary=RollbackCaptureBoundary.parse({version:1,kind:'qgroup-offline-capture-boundary',capturedAt,inputSha256,checkpointSha256:v2.checkpointSha256,journalEntriesSha256:digest(JSON.stringify(media.journal)),mediaFilesSha256:digest(JSON.stringify(v2.mediaFiles)),botStateSha256:v2.botStateSha256,captureManifestSha256:v2.captureManifestSha256,nativeManifests:v2.native,lineageId:storage.lineage_id,
            journal:{path:journalPath,present:journalSource.bytes!==null,size:journalSource.bytes?.length??null,sha256:journalSource.sha256},services:observed,coordination:{deliveryOwner:'existing-local-sqlite',businessDatabase:'standalone-immediate',services:'stopped-observations',retention:'source-fence-only',deployment:'not-coordinated'},rollbackEligible:false});
          const pins=pinRollbackPackageSourceV3(media,historySource.pins,bot.state,boundary),pkg=assembleRollbackPackageV3(state,media,history,bot.state,boundary,Buffer.from(captureInput),journalSource.bytes,pins);
          const roots=[...new Set([data,input.history.capture.root,dirname(input.bot.logDirectory),...(input.bot.sensitiveWordsFile?[dirname(input.bot.sensitiveWordsFile)]:[])])];
          sealed=writeRollbackPackage(pkg,input.destination,roots,now,guard);guard();return sealed;
        });
      }finally{source.close();}
    });
    return {status:'captured_private_package' as const,manifestSha256:result.manifestSha256,checkpointDigest:result.checkpointDigest,files:result.files,bytes:result.bytes,rollbackEligible:false as const,remaining:result.remaining};
  }catch(error){
    // Late source/ownership/close failures after a writer returned must not
    // leave a complete-looking output. The closure fences our original root
    // and parent inodes; it never marks a replacement directory or auto-resumes.
    try{sealed?.markIncomplete();}catch{/* Preserve original failure and all evidence. */}
    throw error;
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [path,pin,...extra]=process.argv.slice(2);
  if(!path||!pin||extra.length){process.stderr.write('Usage: npm run capture:rollback -- <private-capture-input.json> <external-input-sha256>\n');process.exitCode=1;}
  else try{
    const stat=sourceStat(path);if(resolve(path)!==path||!stat?.isFile()||(stat.mode&0o7777n)!==0o600n||!process.getuid||stat.uid!==BigInt(process.getuid()))throw Error('Private capture input required');
    const input=snapshotRollbackFile(path,64*1024);if(input.bytes===null)throw Error('Missing capture input');
    const result=captureRollbackPackage(input.bytes,pin,new Date(),{assertInputUnchanged:input.assertUnchanged});process.stdout.write(JSON.stringify(result)+'\n');
  }catch{process.stderr.write('Rollback capture rejected. Preserve private sources and any incomplete output; no service was started, stopped or activated.\n');process.exitCode=1;}
}
