import {constants,closeSync,fsyncSync,mkdirSync,openSync,readdirSync,unlinkSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {z} from 'zod';
import {decodeErasureJournal} from '../../apps/api/src/erasure-journal';
import {readRollbackPackage} from './rollback-package';
import {rollbackInside} from './rollback-capture-boundary';
import {sourceDirectory,sourceStat,snapshotRollbackFile} from './rollback-source-files';
import {digest,parseJson} from './music-codec';

export const authorityDomains=['board','music','unified'] as const;
export type AuthorityDomain=typeof authorityDomains[number];
const sha=z.string().regex(/^[a-f0-9]{64}$/),domain=z.enum(authorityDomains),limit=64*1024*1024;
const descriptor=z.object({size:z.number().int().nonnegative().safe().max(limit),sha256:sha}).strict();
export const ErasureAuthorityManifest=z.object({version:z.literal(1),kind:z.literal('qgroup-private-erasure-authority'),authorityId:z.string().regex(/^[a-f0-9]{32}$/),createdAt:z.iso.datetime(),sourcePackageSha256:sha,checkpointSha256:sha,journalSha256:sha,
  baseline:z.array(z.object({domain,path:z.string(),size:descriptor.shape.size,sha256:sha}).strict()).length(3),rollbackEligible:z.literal(false)}).strict().refine(row=>JSON.stringify(row.baseline.map(file=>[file.domain,file.path]))===JSON.stringify(authorityDomains.map(domain=>[domain,'baseline/'+domain+'.erasures.jsonl'])));
export const ErasureAuthorityHead=z.object({version:z.literal(1),authoritySha256:sha,sequence:z.number().int().nonnegative().safe().max(999999999999),recordSha256:sha.nullable(),ledgers:z.object({board:descriptor,music:descriptor,unified:descriptor}).strict()}).strict().refine(row=>(row.sequence===0)===(row.recordSha256===null));
export const ErasureAuthorityRecord=z.object({version:z.literal(1),authoritySha256:sha,sequence:z.number().int().positive().safe().max(999999999999),previousRecordSha256:sha,domain,suffixBase64:z.string().max(90*1024*1024),ledgerSize:descriptor.shape.size,ledgerSha256:sha}).strict();
const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)+'\n');
function decode(bytes:Buffer){return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}
export function validateAuthorityLedger(domain:AuthorityDomain,bytes:Buffer,seen=new Map<string,string>()){
  if(bytes.length>limit)throw Error('Authority ledger exceeds limit');const text=decode(bytes);
  if(text&&!text.endsWith('\n'))throw Error('Incomplete authority ledger');
  for(const line of text.split('\n').filter(line=>line.trim()))parseJson(line);
  if(domain!=='music'){
    const rows=decodeErasureJournal(text);
    for(const row of rows){if(domain==='board'&&'version' in row)throw Error('Board authority requires original closure records');const id='request_id' in row?row.request_id:row.requestId,value=JSON.stringify(row);if(seen.has(id)&&seen.get(id)!==value)throw Error('Conflicting authority intent');seen.set(id,value);}
    return rows.length;
  }
  const rows=text.split('\n').filter(line=>line.trim()).map(line=>parseJson(line));
  for(const row of rows)if(!row||typeof row!=='object'||Array.isArray(row)||JSON.stringify(Object.keys(row).sort())!==JSON.stringify(['erased_at','qq'])||typeof row.qq!=='string'||!/^(?:[0-9]{4,12}|m_[a-f0-9]{24})$/.test(row.qq))throw Error('Invalid music authority intent');
  return rows.length;
}
function privateDirectory(path:string){const stat=sourceDirectory(path);if(!process.getuid||stat.uid!==BigInt(process.getuid())||(stat.mode&0o7777n)!==0o700n)throw Error('Authority directory must be private');return stat;}
function privateFile(path:string,maximum:number){const stat=sourceStat(path);if(!process.getuid||!stat?.isFile()||stat.nlink!==1n||stat.uid!==BigInt(process.getuid())||(stat.mode&0o7777n)!==0o600n)throw Error('Authority file must be private');return snapshotRollbackFile(path,maximum);}
function write(path:string,bytes:Buffer){const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}}
function sync(path:string){const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{fsyncSync(fd);}finally{closeSync(fd);}}
function canonical<T>(schema:z.ZodType<T>,bytes:Buffer){const value=schema.parse(parseJson(decode(bytes)));if(!bytes.equals(encode(value)))throw Error('Noncanonical authority metadata');return value;}
/** A snapshot reader. It rejects an in-progress publication rather than mixing
 * heads and records; immutable baseline is bound to an independently saved pin.
 * No live SQLite or service file is opened, modified or restored here. */
export function readRollbackErasureAuthority(root:string,pin:string){
  if(resolve(root)!==root||!sha.safeParse(pin).success)throw Error('Canonical authority and external pin required');
  const identity=privateDirectory(root),baselineIdentity=privateDirectory(join(root,'baseline')),recordsIdentity=privateDirectory(join(root,'records'));
  const manifestFile=privateFile(join(root,'authority-manifest.json'),16*1024*1024);if(!manifestFile.bytes||manifestFile.sha256!==pin)throw Error('Authority manifest pin differs');
  const manifest=canonical(ErasureAuthorityManifest,manifestFile.bytes),headFile=privateFile(join(root,'authority-head.json'),4096),lockFile=privateFile(join(root,'.authority.lock'),0);if(!headFile.bytes||!lockFile.bytes||lockFile.bytes.length)throw Error('Invalid authority components');
  const head=canonical(ErasureAuthorityHead,headFile.bytes);if(head.authoritySha256!==pin||head.sequence>100000)throw Error('Authority head belongs to another baseline or exceeds limit');
  const held=[manifestFile,headFile,lockFile],ledgers={} as Record<AuthorityDomain,Buffer>,chunks={} as Record<AuthorityDomain,Buffer[]>,sizes={} as Record<AuthorityDomain,number>,hashes={} as Record<AuthorityDomain,ReturnType<typeof createHash>>,seen={} as Record<AuthorityDomain,Map<string,string>>;
  for(const row of manifest.baseline){const file=privateFile(join(root,row.path),limit);if(!file.bytes||file.bytes.length!==row.size||file.sha256!==row.sha256)throw Error('Authority baseline differs');held.push(file);ledgers[row.domain]=Buffer.from(file.bytes);chunks[row.domain]=[ledgers[row.domain]];sizes[row.domain]=file.bytes.length;hashes[row.domain]=createHash('sha256').update(file.bytes);seen[row.domain]=new Map();validateAuthorityLedger(row.domain,file.bytes,seen[row.domain]);}
  let previous=pin;
  const paths=Array.from({length:head.sequence},(_,i)=>String(i+1).padStart(12,'0')+'.json');
  for(const [index,path] of paths.entries()){
    const file=privateFile(join(root,'records',path),90*1024*1024);if(!file.bytes)throw Error('Missing authority record');held.push(file);const row=canonical(ErasureAuthorityRecord,file.bytes),suffix=Buffer.from(row.suffixBase64,'base64');
    if(row.authoritySha256!==pin||row.sequence!==index+1||row.previousRecordSha256!==previous||suffix.toString('base64')!==row.suffixBase64||!suffix.length)throw Error('Authority record chain differs');
    sizes[row.domain]+=suffix.length;hashes[row.domain].update(suffix);if(sizes[row.domain]!==row.ledgerSize||hashes[row.domain].copy().digest('hex')!==row.ledgerSha256)throw Error('Authority record ledger differs');validateAuthorityLedger(row.domain,suffix,seen[row.domain]);chunks[row.domain].push(suffix);previous=file.sha256!;
  }
  if((head.sequence?previous:null)!==head.recordSha256)throw Error('Authority head lost a recorded intent');
  for(const domain of authorityDomains){if(head.ledgers[domain].size!==sizes[domain]||head.ledgers[domain].sha256!==hashes[domain].digest('hex'))throw Error('Authority head ledger differs');ledgers[domain]=Buffer.concat(chunks[domain]);}
  function inventory(){if(JSON.stringify(readdirSync(root).sort())!==JSON.stringify(['.authority.lock','authority-head.json','authority-manifest.json','baseline','records'].sort())||JSON.stringify(readdirSync(join(root,'baseline')).sort())!==JSON.stringify(authorityDomains.map(domain=>domain+'.erasures.jsonl').sort())||JSON.stringify(readdirSync(join(root,'records')).sort())!==JSON.stringify(paths))throw Error('Authority publication incomplete or inventory differs');}
  const view=()=>digest(JSON.stringify({manifest,head,ledgerKeys:Object.keys(ledgers).sort(),ledgers:Object.fromEntries(authorityDomains.map(domain=>[domain,digest(ledgers[domain])]))})),originalView=view();
  function assertUnchanged(){for(const [path,original] of [[root,identity],[join(root,'baseline'),baselineIdentity],[join(root,'records'),recordsIdentity]] as const){const current=privateDirectory(path);if(current.dev!==original.dev||current.ino!==original.ino)throw Error('Authority directory replaced');}for(const file of held)file.assertUnchanged();if(view()!==originalView)throw Error('Authority snapshot view changed');inventory();}
  assertUnchanged();return {manifest,head,ledgers,manifestSha256:pin,assertUnchanged,rollbackEligible:false as const};
}
/** Explicit, exclusive initialization from a fully verified rollback package.
 * The caller must retain this authority outside every restore/retention scope.
 * It does not activate services or guarantee custody of the authority itself. */
export function writeRollbackErasureAuthority(packageRoot:string,packagePin:string,destination:string,now=new Date(),assertBoundary?:()=>void){
  const source=readRollbackPackage(packageRoot,packagePin);if(resolve(destination)!==destination)throw Error('Canonical authority destination required');const parent=sourceDirectory(dirname(destination)),roots=[packageRoot];
  if(source.version!==1)roots.push(dirname(source.bot.sources.database),source.bot.sources.logDirectory,...(source.bot.sources.sensitiveWordsFile?[dirname(source.bot.sources.sensitiveWordsFile)]:[]));if(source.version===3){const input=parseJson(source.captureInput.toString()) as {history:{capture:{root:string}}};roots.push(input.history.capture.root);}
  for(const root of roots)if(rollbackInside(destination,root)||rollbackInside(root,destination))throw Error('Authority must be isolated from recorded sources');
  const texts={board:source.state.erasures.boardJournal,music:source.state.erasures.musicJournal,unified:source.state.erasures.unifiedJournal},baseline=authorityDomains.map(domain=>{const bytes=Buffer.from(texts[domain]);validateAuthorityLedger(domain,bytes);return {domain,path:'baseline/'+domain+'.erasures.jsonl',size:bytes.length,sha256:digest(bytes),bytes};});
  const manifest=ErasureAuthorityManifest.parse({version:1,kind:'qgroup-private-erasure-authority',authorityId:randomBytes(16).toString('hex'),createdAt:now.toISOString(),sourcePackageSha256:packagePin,checkpointSha256:source.sourcePins.checkpointSha256,journalSha256:digest(JSON.stringify(source.state.journal)),baseline:baseline.map(({bytes:_bytes,...row})=>row),rollbackEligible:false}),encoded=encode(manifest),pin=digest(encoded),head=ErasureAuthorityHead.parse({version:1,authoritySha256:pin,sequence:0,recordSha256:null,ledgers:Object.fromEntries(baseline.map(row=>[row.domain,{size:row.size,sha256:row.sha256}]))});
  function guarded(){source.assertUnchanged();const value:unknown=assertBoundary?.();if(value!==null&&(typeof value==='object'||typeof value==='function')&&'then' in value)throw Error('Authority boundary guard must be synchronous');source.assertUnchanged();}
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
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const [root,pin,destination,...extra]=process.argv.slice(2);if(!root||!pin||!destination||extra.length){process.stderr.write('Usage: tsx tools/migration/rollback-erasure-authority.ts <private-package> <external-package-SHA256> <new-private-authority>\n');process.exitCode=1;}else try{const {markIncomplete:_guard,...result}=writeRollbackErasureAuthority(root,pin,destination);process.stdout.write(JSON.stringify(result)+'\n');}catch{process.stderr.write('Erasure authority preparation rejected. Preserve sources and incomplete output; no service was activated.\n');process.exitCode=1;}}
