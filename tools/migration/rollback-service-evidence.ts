import {execFileSync} from 'node:child_process';
import {lstatSync,realpathSync} from 'node:fs';
import {posix,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {z} from 'zod';
import {digest} from './music-codec';
export const RollbackService=z.object({role:z.enum(['web','bot']),runtime:z.enum(['typescript','python']),containerId:z.string().regex(/^[a-f0-9]{64}$/),imageId:z.string().regex(/^sha256:[a-f0-9]{64}$/),commit:z.string().regex(/^[a-f0-9]{40}$/),evidenceSha256:z.string().regex(/^[a-f0-9]{64}$/),commitRecordSha256:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict();
export const RollbackServices=z.array(RollbackService).length(2).refine(rows=>new Set(rows.map(row=>row.role)).size===2&&new Set(rows.map(row=>row.containerId)).size===2&&rows.every(row=>row.role!=='web'||row.runtime==='typescript'));
export const RollbackServiceEvidence=z.object({
  Id:z.string().regex(/^[a-f0-9]{64}$/),Image:z.string().regex(/^sha256:[a-f0-9]{64}$/),Revision:z.string().nullable(),Service:z.string(),
  State:z.object({Running:z.boolean(),Paused:z.boolean(),Restarting:z.boolean(),Dead:z.boolean(),Status:z.string(),Pid:z.number().int().nonnegative(),StartedAt:z.string(),FinishedAt:z.string()}).strict(),RestartCount:z.number().int().nonnegative(),
  Runtime:z.enum(['native-api','native-bot','python-bot','unknown']),EnvironmentMode:z.string(),NodeOptionsConfigured:z.boolean(),
  WebDatabase:z.string(),BotDatabase:z.string(),BotLogDirectory:z.string(),BotSensitiveWordsFile:z.string(),BotEnvironmentFile:z.string(),HistoryRoot:z.string(),HistoryManifestSha256:z.string(),
  Mounts:z.array(z.object({Type:z.string(),Source:z.string(),Destination:z.string()}).strict()),
}).strict();
export type RollbackServiceEvidenceValue=z.infer<typeof RollbackServiceEvidence>;
export const pinRollbackServiceEvidence=(value:RollbackServiceEvidenceValue)=>digest(JSON.stringify(RollbackServiceEvidence.parse(value))+'\n');
/** Pure path resolution for independent package verification. Deepest mounts
 * win; file/shadow mounts must match the explicit source, never be ignored. */
export function rollbackBindSource(actual:RollbackServiceEvidenceValue,path:string){
  if(!posix.isAbsolute(path)||posix.normalize(path)!==path)throw Error('Rollback service path must be explicit and canonical');
  const mounts=actual.Mounts;for(const mount of mounts)if(!posix.isAbsolute(mount.Destination)||posix.normalize(mount.Destination)!==mount.Destination||!posix.isAbsolute(mount.Source)||posix.normalize(mount.Source)!==mount.Source)throw Error('Rollback service mount must be canonical');
  if(new Set(mounts.map(mount=>mount.Destination)).size!==mounts.length)throw Error('Ambiguous rollback service mount');
  const applicable=mounts.filter(mount=>path===mount.Destination||path.startsWith(mount.Destination==='/'?'/':mount.Destination+'/')).sort((a,b)=>b.Destination.length-a.Destination.length),mount=applicable[0];
  if(!mount||mount.Type!=='bind')throw Error('Rollback service source must use a bind mount');
  return posix.resolve(mount.Source,posix.relative(mount.Destination,path));
}
/** Narrow inspection only: no raw command, entrypoint, complete environment,
 * credentials, Docker logs, service execution or remote Docker endpoint. */
export function inspectRollbackService(id:string,socketPath?:string){
  if(!/^[a-f0-9]{64}$/.test(id))throw Error('Rollback capture requires a complete container ID');
  const socket=socketPath??realpathSync('/var/run/docker.sock');
  if(resolve(socket)!==socket||realpathSync(socket)!==socket)throw Error('Rollback capture requires a canonical local Docker socket');
  const original=lstatSync(socket,{bigint:true});if(!original.isSocket())throw Error('Rollback capture requires a canonical local Docker socket');
  const environment=(name:string)=>'{{ $value := "" }}{{range .Config.Env}}{{ $parts := split . "=" }}{{if eq (index $parts 0) "'+name+'" }}{{ $value = join (slice $parts 1) "=" }}{{end}}{{end}}{{json $value}}';
  const runtime='{{if and (eq .Config.WorkingDir "/app") (or (eq (json .Config.Entrypoint) "null") (eq (json .Config.Entrypoint) "[]") (eq (json .Config.Entrypoint) "[\\"docker-entrypoint.sh\\"]"))}}{{if eq (json .Config.Cmd) "[\\"node\\",\\".rebuild-dist/api/start.mjs\\"]"}}"native-api"{{else if eq (json .Config.Cmd) "[\\"node\\",\\".rebuild-dist/bot/start.mjs\\"]"}}"native-bot"{{else if eq (json .Config.Cmd) "[\\\"python3\\\",\\\"-m\\\",\\\"qgroup_bot.main\\\"]"}}"python-bot"{{else}}"unknown"{{end}}{{else}}"unknown"{{end}}';
  const nodeOptions='{{ $configured := false }}{{range .Config.Env}}{{ $parts := split . "=" }}{{if and (eq (index $parts 0) "NODE_OPTIONS") (ne (join (slice $parts 1) "=") "")}}{{ $configured = true }}{{end}}{{end}}{{json $configured}}';
  const format='{"Id":{{json .Id}},"Image":{{json .Image}},"Revision":{{json (index .Config.Labels "org.opencontainers.image.revision")}},"Service":{{json (index .Config.Labels "com.docker.compose.service")}},"State":{"Running":{{json .State.Running}},"Paused":{{json .State.Paused}},"Restarting":{{json .State.Restarting}},"Dead":{{json .State.Dead}},"Status":{{json .State.Status}},"Pid":{{json .State.Pid}},"StartedAt":{{json .State.StartedAt}},"FinishedAt":{{json .State.FinishedAt}}},"RestartCount":{{json .RestartCount}},"Runtime":'+runtime+',"NodeOptionsConfigured":'+nodeOptions+','+Object.entries({EnvironmentMode:'NODE_ENV',WebDatabase:'REBUILD_DB',BotDatabase:'KANBAN_DB',BotLogDirectory:'KANBAN_BOT_LOG_DIR',BotSensitiveWordsFile:'KANBAN_BOT_SENSITIVE_WORDS_FILE',BotEnvironmentFile:'KANBAN_BOT_ENV',HistoryRoot:'REBUILD_LEGACY_HISTORY_ROOT',HistoryManifestSha256:'REBUILD_LEGACY_HISTORY_MANIFEST_SHA256'}).map(([key,value])=>'"'+key+'":'+environment(value)).join(',')+',"Mounts":[{{range $i,$m:=.Mounts}}{{if $i}},{{end}}{"Type":{{json $m.Type}},"Source":{{json $m.Source}},"Destination":{{json $m.Destination}}}{{end}}]}';
  const env={...process.env};for(const name of ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH','NODE_OPTIONS'])delete env[name];
  const result=RollbackServiceEvidence.parse(JSON.parse(execFileSync('docker',['--host','unix://'+socket,'inspect','--type','container','--format',format,id],{encoding:'utf8',timeout:5000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe'],env})));
  const after=lstatSync(socket,{bigint:true});if(!after.isSocket()||after.dev!==original.dev||after.ino!==original.ino||realpathSync(socket)!==socket)throw Error('Rollback Docker socket was replaced');
  if(result.Id!==id)throw Error('Rollback Docker inspection container differs');
  return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [id,socket,...extra]=process.argv.slice(2);
  if(!id||extra.length){process.stderr.write('Usage: npm run inspect:rollback -- <complete-container-id> <canonical-local-docker-socket>\n');process.exitCode=1;}
  else try{
    const evidence=inspectRollbackService(id,socket),runtime=evidence.Runtime==='python-bot'?'python':'typescript';
    if(!['web','bot'].includes(evidence.Service)||evidence.Runtime!==(evidence.Service==='web'?'native-api':runtime==='python'?'python-bot':'native-bot')||runtime==='typescript'&&evidence.EnvironmentMode!=='production'||evidence.NodeOptionsConfigured||evidence.State.Running||evidence.State.Paused||evidence.State.Restarting||evidence.State.Dead||evidence.State.Pid!==0||!['created','exited'].includes(evidence.State.Status)||(evidence.Revision===null?runtime!=='python':!/^[a-f0-9]{40}$/.test(evidence.Revision)))throw Error('Unsupported stopped service evidence');
    process.stdout.write(JSON.stringify({role:evidence.Service,runtime,containerId:evidence.Id,imageId:evidence.Image,commit:evidence.Revision,evidenceSha256:pinRollbackServiceEvidence(evidence),state:evidence.State.Status,releaseSourceCertified:false})+'\n');
  }catch{process.stderr.write('Rollback service inspection rejected; no service was started or stopped.\n');process.exitCode=1;}
}
