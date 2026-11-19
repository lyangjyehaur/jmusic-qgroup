import { execFileSync } from 'node:child_process';
import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { digest, musicErasures, parseJson, readIdentity } from './music-codec';
import { captureIdentitySource } from './identity-source';
import { decodeErasureJournal } from '../../apps/api/src/erasure-journal';
import { acquireMusicLock, type CaptureLock } from './capture-lock';

const service = z.object({ role: z.enum(['web','music','bot']), containerId: z.string().regex(/^[a-f0-9]{64}$/), imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict();
export const CaptureInput = z.object({ board: z.string(), boardLedger: z.string(), music: z.string(), boardBackups: z.string(), botEvidence: z.string(), destination: z.string(), dockerSocket: z.string().optional(), services: z.array(service).length(3) }).strict().refine(input => new Set(input.services.map(row=>row.role)).size===3 && new Set(input.services.map(row=>row.containerId)).size===3);
type Input = z.infer<typeof CaptureInput>;
export type ContainerEvidence = { Id: string; Image: string; State: { Running: boolean; Paused: boolean; Restarting: boolean; Dead: boolean; Status: string; Pid: number; StartedAt: string; FinishedAt: string }; RestartCount: number; Revision: string | null; Service: string; BoardDatabase: string; MusicData: string; BotLogDir: string; Mounts: { Type: string; Source: string; Destination: string }[] };
const inspection = z.object({Id:z.string(),Image:z.string(),State:z.object({Running:z.boolean(),Paused:z.boolean(),Restarting:z.boolean(),Dead:z.boolean(),Status:z.string(),Pid:z.number().int(),StartedAt:z.string(),FinishedAt:z.string()}).strict(),RestartCount:z.number().int().nonnegative(),Revision:z.string().nullable(),Service:z.string(),BoardDatabase:z.string(),MusicData:z.string(),BotLogDir:z.string(),Mounts:z.array(z.object({Type:z.string(),Source:z.string(),Destination:z.string()}).strict())}).strict();
/** Select only data-path settings, never other environment values, credentials,
 * full Docker configuration or log text. */
function pinCaptureDockerSocket(socketPath?:string){
  const socket=socketPath??realpathSync('/var/run/docker.sock');
  if(resolve(socket)!==socket||realpathSync(socket)!==socket)throw new Error('Capture requires a canonical local Docker Unix socket');
  const original=lstatSync(socket,{bigint:true});if(!original.isSocket())throw new Error('Capture requires a canonical local Docker Unix socket');
  const assertUnchanged=()=>{const current=lstatSync(socket,{bigint:true});if(!current.isSocket()||current.dev!==original.dev||current.ino!==original.ino||realpathSync(socket)!==socket)throw new Error('Capture Docker socket was replaced');};
  return {socket,assertUnchanged};
}
export function inspectCaptureContainer(id: string, socketPath?:string): ContainerEvidence {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('A complete container ID is required');
  const pinned=pinCaptureDockerSocket(socketPath),socket=pinned.socket;
  const environment=(name:string)=>'{{ $value := "" }}{{range .Config.Env}}{{ $parts := split . "=" }}{{if eq (index $parts 0) "'+name+'" }}{{ $value = join (slice $parts 1) "=" }}{{end}}{{end}}{{json $value}}';
  const format='{"Id":{{json .Id}},"Image":{{json .Image}},"State":{"Running":{{json .State.Running}},"Paused":{{json .State.Paused}},"Restarting":{{json .State.Restarting}},"Dead":{{json .State.Dead}},"Status":{{json .State.Status}},"Pid":{{json .State.Pid}},"StartedAt":{{json .State.StartedAt}},"FinishedAt":{{json .State.FinishedAt}}},"RestartCount":{{json .RestartCount}},"Revision":{{json (index .Config.Labels "org.opencontainers.image.revision")}},"Service":{{json (index .Config.Labels "com.docker.compose.service")}},"BoardDatabase":'+environment('KANBAN_DB')+',"MusicData":'+environment('JPM_DATA')+',"BotLogDir":'+environment('KANBAN_BOT_LOG_DIR')+',"Mounts":[{{range $i,$m:=.Mounts}}{{if $i}},{{end}}{"Type":{{json $m.Type}},"Source":{{json $m.Source}},"Destination":{{json $m.Destination}}}{{end}}]}';
  const environmentVariables={...process.env};for(const name of ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH','NODE_OPTIONS'])delete environmentVariables[name];
  const result=inspection.parse(JSON.parse(execFileSync('docker',['--host','unix://'+socket,'inspect','--type','container','--format',format,id],{encoding:'utf8',timeout:5000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe'],env:environmentVariables})));
  pinned.assertUnchanged();if(result.Id!==id)throw new Error('Capture Docker inspection container differs');return result;
}
const maxFile = 512 * 1024 * 1024;
const decode = (raw: Buffer) => new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw);
function existsEntry(path:string){try{lstatSync(path);return true;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;return false;}}
function canonical(path:string, folder:boolean) {
  const full=resolve(path),stat=lstatSync(full);
  if(realpathSync(full)!==full||stat.isSymbolicLink()||(folder?!stat.isDirectory():!stat.isFile()))throw new Error('Capture requires canonical regular source paths');
  return full;
}
function read(path:string) {
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {const stat=fstatSync(fd);if(!stat.isFile()||stat.size>maxFile)throw new Error('Invalid or oversized capture source');return readFileSync(fd);}finally{closeSync(fd);}
}
function write(path:string,raw:Buffer|string) {
  mkdirSync(dirname(path),{recursive:true,mode:0o700});const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try {writeFileSync(fd,raw);fsyncSync(fd);}finally{closeSync(fd);}
}
function sync(path:string){const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{fsyncSync(fd);}finally{closeSync(fd);}}
function syncTree(path:string){for(const entry of readdirSync(path,{withFileTypes:true}))if(entry.isDirectory())syncTree(join(path,entry.name));sync(path);}
function walk(root:string,prefix=''):string[]{return readdirSync(join(root,prefix)).sort().flatMap(name=>{const path=prefix?prefix+'/'+name:name,info=lstatSync(join(root,path));if(info.isSymbolicLink()||!info.isDirectory()&&!info.isFile())throw new Error('Capture source contains a link or special file');return info.isDirectory()?walk(root,path):[path];});}
function check(db:Database.Database){if(db.pragma('integrity_check',{simple:true})!=='ok'||(db.pragma('foreign_key_check') as unknown[]).length)throw new Error('Capture database integrity failure');}
function standalone(db:Database.Database){
  const pages=Number(db.pragma('page_count',{simple:true})),size=Number(db.pragma('page_size',{simple:true}));
  if(!Number.isSafeInteger(pages)||pages*size>maxFile)throw new Error('Capture database exceeds offline size limit');
  const raw=db.serialize();raw[18]=1;raw[19]=1;return raw;
}
function sourceFor(actual:ContainerEvidence,path:string){
  if(!posix.isAbsolute(path)||posix.normalize(path)!==path)throw new Error('Source service data path requires explicit review');
  const mounts=actual.Mounts.filter(mount=>path===mount.Destination||path.startsWith(mount.Destination.replace(/\/$/,'')+'/')).sort((a,b)=>b.Destination.length-a.Destination.length);
  const mount=mounts[0];if(!mount||mount.Type!=='bind')throw new Error('Source service data must resolve to a bind mount');
  return resolve(mount.Source,posix.relative(mount.Destination,path));
}
function stopped(input:Input,inspect:(id:string)=>ContainerEvidence){
  return input.services.map(expected=>{
    const actual=inspection.parse(inspect(expected.containerId)),root=expected.role==='music'?input.music:dirname(input.board);
    if(actual.Id!==expected.containerId||actual.Image!==expected.imageId||actual.Service!==expected.role||actual.State.Running||actual.State.Paused||actual.State.Restarting||actual.State.Dead||actual.State.Pid!==0||!['exited','created'].includes(actual.State.Status))throw new Error('All source services must be stopped at the expected immutable images');
    if(!actual.Mounts.some(mount=>mount.Type==='bind'&&mount.Source===root)||sourceFor(actual,expected.role==='music'?actual.MusicData:actual.BoardDatabase)!==(expected.role==='music'?join(input.music,'data.json'):input.board)||expected.role==='bot'&&sourceFor(actual,actual.BotLogDir||posix.join(posix.dirname(actual.BoardDatabase),'bot-logs'))!==input.botEvidence)throw new Error('Source service bind mount or data path does not match capture input');
    return {...expected,state:actual.State.Status,startedAt:actual.State.StartedAt,finishedAt:actual.State.FinishedAt,restartCount:actual.RestartCount,sourceCommit:actual.Revision&&/^[a-f0-9]{40}$/.test(actual.Revision)?actual.Revision:null,commitEvidence:actual.Revision&&/^[a-f0-9]{40}$/.test(actual.Revision)?'image-label':'external-record-required'};
  });
}
/** Offline capture only: never stops/starts containers, executes bot jobs,
 * migrates a source DB, prunes source history, or publishes a service candidate.
 * Injected dependencies are for isolated tests, not CLI bypass options. */
export async function captureSnapshot(rawInput:Input, now=new Date(), dependencies:{inspect?:(id:string)=>ContainerEvidence;lock?:(path:string)=>Promise<CaptureLock>}={}){
  const input=CaptureInput.parse(rawInput);
  input.board=canonical(input.board,false);input.boardLedger=canonical(input.boardLedger,false);input.music=canonical(input.music,true);input.boardBackups=canonical(input.boardBackups,true);input.botEvidence=canonical(input.botEvidence,true);input.destination=resolve(input.destination);
  canonical(dirname(input.destination),true);if(existsEntry(input.destination))throw new Error('Refusing existing capture destination');
  const sources=[dirname(input.board),input.music,input.boardBackups,input.botEvidence,dirname(input.boardLedger)];
  for(const source of sources)if(input.destination===source||input.destination.startsWith(source+sep)||source.startsWith(input.destination+sep))throw new Error('Capture sources and destination must be isolated');
  let inspector=dependencies.inspect;
  if(!inspector){const pinned=pinCaptureDockerSocket(input.dockerSocket);inspector=(id:string)=>{pinned.assertUnchanged();const result=inspectCaptureContainer(id,pinned.socket);pinned.assertUnchanged();return result;};}
  const services=stopped(input,inspector);
  const reservation=input.destination+'.capture-lock',reservationFD=openSync(reservation,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  let musicLock:CaptureLock|undefined,board:Database.Database|undefined,identity:Database.Database|undefined,stage:string|undefined;
  try{
    musicLock=await (dependencies.lock??acquireMusicLock)(canonical(join(input.music,'.service.lock'),false));
    if(JSON.stringify(stopped(input,inspector))!==JSON.stringify(services))throw new Error('Source container evidence changed');
    const databaseFiles=[input.board,join(input.music,'identity.sqlite3')].map(path=>({path,stat:lstatSync(path,{bigint:true})}));
    board=new Database(input.board,{fileMustExist:true,timeout:0});board.exec('BEGIN IMMEDIATE');
    identity=new Database(canonical(join(input.music,'identity.sqlite3'),false),{fileMustExist:true,timeout:0});identity.exec('BEGIN IMMEDIATE');
    for(const original of databaseFiles){const current=lstatSync(original.path,{bigint:true});if(current.dev!==original.stat.dev||current.ino!==original.stat.ino)throw new Error('Source database file changed while locking');}
    musicLock.assertHeld();check(board);check(identity);readIdentity(identity);captureIdentitySource(identity);
    const originalBoard=standalone(board),originalIdentity=standalone(identity);
    const musicFiles=walk(input.music),backupFiles=walk(input.boardBackups),botFiles=walk(input.botEvidence),mediaRoot=join(dirname(input.board),'images'),mediaExists=existsEntry(mediaRoot);
    if(mediaExists)canonical(mediaRoot,true);const mediaFiles=mediaExists?walk(mediaRoot):[];
    const required=['data.json','identity.sqlite3','erasures.jsonl','walls/manifest.json','.service.lock'];
    if(required.some(path=>!musicFiles.includes(path)))throw new Error('Incomplete music capture source');
    const paired=new Set<string>();
    for(const path of musicFiles){
      if(required.includes(path)||['identity.sqlite3-wal','identity.sqlite3-shm'].includes(path)||/^walls\/[^/]+\.(?:png|jpg|jpeg|webp)$/.test(path)||/^backups\/data-[0-9]{8}-[0-9]{6}\.json$/.test(path))continue;
      const match=/^paired-backups\/([0-9]{8}-[0-9]{6})\/(?:data\.json|identity\.sqlite3|erasures\.jsonl|walls\/manifest\.json|walls\/[^/]+\.(?:png|jpg|jpeg|webp))$/.exec(path);
      if(!match)throw new Error('Unclassified music capture source');paired.add(match[1]!);
    }
    for(const id of paired)if(!musicFiles.includes(`paired-backups/${id}/data.json`)||!musicFiles.includes(`paired-backups/${id}/identity.sqlite3`))throw new Error('Incomplete historical music pair');
    for(const path of backupFiles)if(!/^(?:privacy-erasures\.jsonl|kanban-[0-9]{8}-[0-9]{6}-[0-9]{6}\.(?:sqlite3|images\.tar\.gz))$/.test(path))throw new Error('Unclassified board history source');
    for(const path of backupFiles.filter(path=>path.endsWith('.images.tar.gz')))if(!backupFiles.includes(path.replace('.images.tar.gz','.sqlite3')))throw new Error('Orphan historical board image pair');
    for(const path of botFiles)if(!/^(?:bot-group-state(?:-[a-f0-9]{20})?\.json|bot-health\.json|bot-events\.jsonl(?:\.[1-4])?)$/.test(path))throw new Error('Unclassified bot capture evidence');
    for(const path of mediaFiles)if(!/^[a-f0-9]{2}\/[a-f0-9]{64}\.png$/.test(path)||path.slice(0,2)!==path.split('/')[1]!.slice(0,2))throw new Error('Unclassified board media source');
    const files:{path:string;size:number;sha256:string}[]=[],originals:{source:string;sha256:string}[]=[];
    stage=mkdtempSync(join(dirname(input.destination),'.qgroup-capture-'));
    const save=(path:string,bytes:Buffer)=>{write(join(stage!,path),bytes);files.push({path,size:bytes.length,sha256:digest(bytes)});};
    const copy=(source:string,path:string)=>{const bytes=read(source);originals.push({source,sha256:digest(bytes)});save(path,bytes);return bytes;};
    save('current/board.sqlite3',originalBoard);save('current/music/identity.sqlite3',originalIdentity);
    const boardLedger=copy(input.boardLedger,'current/board.erasures.jsonl');decodeErasureJournal(decode(boardLedger));
    for(const path of musicFiles.filter(path=>!['.service.lock','identity.sqlite3','identity.sqlite3-wal','identity.sqlite3-shm'].includes(path))){
      const historical=path.startsWith('paired-backups/')||path.startsWith('backups/'),bytes=copy(join(input.music,path),historical?'history/music/'+path:'current/music/'+path);
      if(path.endsWith('.json'))parseJson(decode(bytes));if(path.endsWith('erasures.jsonl'))musicErasures(decode(bytes));
    }
    const walls=parseJson(decode(read(join(stage,'current/music/walls/manifest.json'))));
    if(!walls||typeof walls!=='object'||Array.isArray(walls)||!Array.isArray(walls.items))throw new Error('Invalid captured wallpaper manifest');
    for(const item of walls.items)if(!item||typeof item!=='object'||Array.isArray(item)||typeof item.src!=='string'||!/^\/walls\/[^/]+\.(?:png|jpg|jpeg|webp)$/.test(item.src)||item.src.includes('..')||!existsSync(join(stage,'current/music',item.src.slice(1))))throw new Error('Referenced captured wallpaper is missing');
    for(const path of mediaFiles){const bytes=copy(join(mediaRoot,path),'current/images/'+path);if(digest(bytes)!==path.split('/')[1]!.slice(0,-4))throw new Error('Board capture media digest mismatch');}
    // Empty media directories are explicit, not evidence of missing assets.
    mkdirSync(join(stage,'current/images'),{recursive:true,mode:0o700});
    for(const row of board.prepare('SELECT digest,size FROM image_assets').all() as {digest:string;size:number}[]){const path='current/images/'+row.digest.slice(0,2)+'/'+row.digest+'.png';if(!files.some(file=>file.path===path&&file.sha256===row.digest&&file.size===row.size))throw new Error('Referenced board capture image is missing');}
    for(const path of backupFiles)copy(join(input.boardBackups,path),'history/board/'+path);
    for(const path of botFiles){const bytes=copy(join(input.botEvidence,path),'bot-evidence/'+path);if(path.endsWith('.json'))parseJson(decode(bytes));else{const text=decode(bytes);if(text&&!text.endsWith('\n'))throw new Error('Incomplete bot evidence journal');for(const line of text.split('\n').filter(line=>line.trim()))parseJson(line);}}
    // Original history remains private and byte-identical. It is not a download
    // endpoint or a restoration package; latest erasures must govern later use.
    const assertSources=()=>{
      musicLock!.assertHeld();
      for(const original of databaseFiles){const current=lstatSync(original.path,{bigint:true});if(!current.isFile()||current.isSymbolicLink()||current.dev!==original.stat.dev||current.ino!==original.stat.ino)throw new Error('Source database file was replaced during capture');}
      if(!standalone(board!).equals(originalBoard)||!standalone(identity!).equals(originalIdentity)||originals.some(file=>digest(read(file.source))!==file.sha256)||JSON.stringify(walk(input.music))!==JSON.stringify(musicFiles)||JSON.stringify(walk(input.boardBackups))!==JSON.stringify(backupFiles)||JSON.stringify(walk(input.botEvidence))!==JSON.stringify(botFiles)||existsEntry(mediaRoot)!==mediaExists||JSON.stringify(mediaExists?walk(mediaRoot):[])!==JSON.stringify(mediaFiles))throw new Error('Capture sources changed while locked');
    };
    assertSources();
    if(JSON.stringify(stopped(input,inspector))!==JSON.stringify(services))throw new Error('Source container evidence changed');
    const manifest={version:1,createdAt:now.toISOString(),sources:{board:input.board,boardLedger:input.boardLedger,music:input.music,boardBackups:input.boardBackups,botEvidence:input.botEvidence},services,files,sourceDigest:digest(JSON.stringify(files)),locks:{music:'linux-flock',board:'sqlite-immediate',identity:'sqlite-immediate'},history:{musicPairs:paired.size,musicJson:musicFiles.filter(path=>path.startsWith('backups/')).length,boardSnapshots:backupFiles.filter(path=>path.endsWith('.sqlite3')).length},botEvidenceFiles:botFiles.length,releaseEligible:false,remaining:['verify_source_commits_without_image_labels','verify_historical_pair_integrity_and_latest_erasure_downloads','verify_actual_web_bot_version_pair','rollback_export','full_capability_acceptance']};
    write(join(stage,'capture-manifest.json'),JSON.stringify(manifest,null,2)+'\n');syncTree(stage);
    if(JSON.stringify(stopped(input,inspector))!==JSON.stringify(services))throw new Error('Source container evidence changed');assertSources();
    canonical(dirname(input.destination),true);if(existsEntry(input.destination))throw new Error('Capture destination appeared');renameSync(stage,input.destination);stage=undefined;sync(dirname(input.destination));
    return {status:'captured' as const,sourceDigest:manifest.sourceDigest,releaseEligible:false};
  }finally{
    try{if(identity){try{if(identity.inTransaction)identity.exec('ROLLBACK');}finally{identity.close();}}}
    finally{try{if(board){try{if(board.inTransaction)board.exec('ROLLBACK');}finally{board.close();}}}
      finally{try{await musicLock?.release();}finally{try{if(stage)rmSync(stage,{recursive:true,force:true});}finally{closeSync(reservationFD);rmSync(reservation);}}}}
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [config,...extra]=process.argv.slice(2);
  if(!config||extra.length){process.stderr.write('Usage: npm run capture:rebuild -- <private-capture-input.json>\n');process.exitCode=1;}
  else try{const input=CaptureInput.parse(parseJson(decode(read(canonical(config,false)))));process.stdout.write(JSON.stringify(await captureSnapshot(input))+'\n');}
  catch{process.stderr.write('Capture rejected; no service was started or stopped. Inspect the private sources, locks and immutable container evidence.\n');process.exitCode=1;}
}
