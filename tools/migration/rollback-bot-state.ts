import {constants,closeSync,fstatSync,lstatSync,openSync,readFileSync,readdirSync,realpathSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {z} from 'zod';
import {digest} from './music-codec';

const maxFile=512*1024*1024,order=(a:string,b:string)=>a<b?-1:a>b?1:0;
const Sources=z.object({database:z.string().min(1),logDirectory:z.string().min(1),abbreviationDirectory:z.string().min(1),sensitiveWordsFile:z.string().min(1).nullable()}).strict();
const Directory=z.object({role:z.enum(['logs','abbreviations']),exists:z.boolean()}).strict();
const File=z.object({path:z.string().min(1),size:z.number().int().nonnegative().safe().max(maxFile),sha256:z.string().regex(/^[a-f0-9]{64}$/),mtimeNs:z.string().regex(/^-?[0-9]{1,30}$/)}).strict();
export const BotStateIndex=z.object({version:z.literal(1),capturedAt:z.iso.datetime(),sources:Sources,directories:z.array(Directory).length(2),files:z.array(File)}).strict();
export type RollbackBotFile={path:string;bytes:Buffer;mtimeNs:string};
export type RollbackBotState={version:1;capturedAt:string;sources:z.infer<typeof Sources>;directories:z.infer<typeof Directory>[];files:RollbackBotFile[]};
export const RollbackBotInput=z.object({database:z.string().min(1),logDirectory:z.string().min(1),sensitiveWordsFile:z.string().min(1).nullable()}).strict();
export type RollbackBotInputValue=z.infer<typeof RollbackBotInput>;
const log=/^logs\/(?:bot-group-state(?:-[a-f0-9]{20})?\.json|bot-health\.json|bot-events\.jsonl(?:\.[1-4])?|\.bot-(?:group|health)-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp)$/;
const abbreviation=/^abbreviations\/[a-f0-9]{24}(?:\.[a-f0-9]{12})?\.(?:json|txt)(?:\.[a-f0-9]{12}\.tmp)?$/;
function canonical(path:string){if(resolve(path)!==path)throw Error('Bot capture requires canonical paths');}
function stat(path:string){try{return lstatSync(path,{bigint:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}}
function directory(path:string){canonical(path);const value=stat(path);if(!value?.isDirectory()||value.isSymbolicLink()||realpathSync(path)!==path)throw Error('Unsafe bot capture directory');return value;}
const fingerprint=(value:NonNullable<ReturnType<typeof stat>>)=>[value.dev,value.ino,value.mode,value.nlink,value.uid,value.gid,value.size,value.mtimeNs,value.ctimeNs].map(String);
function file(path:string){
  canonical(path);directory(dirname(path));const before=stat(path);if(!before?.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size>BigInt(maxFile)||realpathSync(path)!==path)throw Error('Unsafe bot capture file');
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const held=fstatSync(fd,{bigint:true});if(JSON.stringify(fingerprint(held))!==JSON.stringify(fingerprint(before)))throw Error('Bot capture file changed before reading');const bytes=readFileSync(fd);if(BigInt(bytes.length)!==held.size||JSON.stringify(fingerprint(fstatSync(fd,{bigint:true})))!==JSON.stringify(fingerprint(held))||JSON.stringify(fingerprint(stat(path)!))!==JSON.stringify(fingerprint(held)))throw Error('Bot capture file changed while reading');return {bytes,stat:held};}finally{closeSync(fd);}
}
export function describeRollbackBotState(state:RollbackBotState){return BotStateIndex.parse({...state,files:state.files.map(file=>({path:file.path,size:file.bytes.length,sha256:digest(file.bytes),mtimeNs:file.mtimeNs}))});}
export function encodeRollbackBotIndex(state:RollbackBotState){return Buffer.from(JSON.stringify(describeRollbackBotState(state))+'\n');}
/** The pin is saved at acquisition, never inferred from a claimed report. */
export function pinRollbackBotState(state:RollbackBotState){return digest(encodeRollbackBotIndex(state));}
/** Private raw evidence only. No auth/health claims, cursor reset, TTL renewal,
 * cleanup, normalization, source file writes or activation. Temporary/inactive
 * files are retained, including incomplete bytes, rather than treated as work. */
export function verifyRollbackBotState(state:RollbackBotState,externalPin:string){
  if(JSON.stringify(Object.keys(state).sort())!==JSON.stringify(['version','capturedAt','sources','directories','files'].sort())||!state.files.every(file=>Buffer.isBuffer(file.bytes)&&JSON.stringify(Object.keys(file).sort())===JSON.stringify(['path','bytes','mtimeNs'].sort())))throw Error('Invalid bot capture components');
  const index=describeRollbackBotState(state);for(const path of Object.values(index.sources))if(path!==null)canonical(path);
  if(index.sources.abbreviationDirectory!==join(dirname(index.sources.database),'bot-abbreviation-results'))throw Error('Bot continuation source differs');
  if(JSON.stringify(index.directories.map(row=>row.role))!==JSON.stringify(['logs','abbreviations']))throw Error('Bot capture directory roles differ');
  const paths=index.files.map(file=>file.path);if(new Set(paths).size!==paths.length||JSON.stringify(paths)!==JSON.stringify([...paths].sort(order)))throw Error('Ambiguous bot capture inventory');
  for(const path of paths){if(!log.test(path)&&!abbreviation.test(path)&&path!=='configuration/sensitive-words.json')throw Error('Unclassified bot capture file');if(path.startsWith('logs/')&&!index.directories[0]!.exists||path.startsWith('abbreviations/')&&!index.directories[1]!.exists)throw Error('Absent bot capture directory contains files');}
  if(paths.includes('configuration/sensitive-words.json')!==(index.sources.sensitiveWordsFile!==null))throw Error('Bot word list inventory differs');
  if(!/^[a-f0-9]{64}$/.test(externalPin)||pinRollbackBotState(state)!==externalPin)throw Error('Bot capture pin differs');
  return {version:1 as const,files:paths.length,pin:externalPin,rollbackEligible:false as const};
}
/** Caller must exclude the native delivery owner and retain the business DB
 * lock for the whole operation. This reader does not establish quiescence.
 * Source paths are explicit; it never reads environment files or credentials. */
export function captureRollbackBotState(raw:RollbackBotInputValue,now=new Date()){
  const input=RollbackBotInput.parse(raw),sources={...input,abbreviationDirectory:join(dirname(input.database),'bot-abbreviation-results')};
  canonical(input.database);directory(dirname(input.database));const db=stat(input.database);
  if(!db?.isFile()||db.isSymbolicLink()||db.nlink!==1n||realpathSync(input.database)!==input.database)throw Error('Unsafe bot capture database');
  const sourceIdentity={dev:db.dev,ino:db.ino};
  const parents=new Map<string,ReturnType<typeof directory>>([[dirname(input.database),directory(dirname(input.database))]]);
  const ownerPath=join(dirname(input.database),'.bot-owner.sqlite3'),ownerIdentity=stat(ownerPath);
  const sqliteSources=new Set([input.database,ownerPath].flatMap(path=>[path,path+'-wal',path+'-shm',path+'-journal']));
  function externalFile(path:string){
    const before=stat(path);if(sqliteSources.has(path)||before&&(before.dev===sourceIdentity.dev&&before.ino===sourceIdentity.ino||ownerIdentity&&before.dev===ownerIdentity.dev&&before.ino===ownerIdentity.ino))throw Error('Bot external source cannot alias a SQLite lock file');
    // No extra descriptor may be closed on an inode holding a POSIX SQLite
    // lock in this process. Only distinct external files reach the reader.
    return file(path);
  }
  const held=new Map<string,{bytes:Buffer;stat:NonNullable<ReturnType<typeof stat>>}>(),directories:RollbackBotState['directories']=[];
  const roots=[['logs',input.logDirectory],['abbreviations',sources.abbreviationDirectory]] as const;
  const observed=new Map<string,NonNullable<ReturnType<typeof stat>>|null>();
  const inventories=new Map<string,string[]>();
  const files:RollbackBotFile[]=[];
  for(const [role,root] of roots){
    canonical(root);parents.set(dirname(root),directory(dirname(root)));const exists=stat(root)!==null;
    directories.push({role,exists});observed.set(root,exists?directory(root):null);
    if(!exists)continue;
    const names=readdirSync(root).sort(order);inventories.set(root,names);
    for(const name of names){
      const path=role+'/'+name;if(!(role==='logs'?log:abbreviation).test(path))throw Error('Unclassified bot capture source');
      const source=join(root,name),captured=externalFile(source);held.set(source,captured);files.push({path,bytes:Buffer.from(captured.bytes),mtimeNs:captured.stat.mtimeNs.toString()});
    }
  }
  if(input.sensitiveWordsFile!==null){const captured=externalFile(input.sensitiveWordsFile);parents.set(dirname(input.sensitiveWordsFile),directory(dirname(input.sensitiveWordsFile)));held.set(input.sensitiveWordsFile,captured);files.push({path:'configuration/sensitive-words.json',bytes:Buffer.from(captured.bytes),mtimeNs:captured.stat.mtimeNs.toString()});}
  files.sort((a,b)=>order(a.path,b.path));
  const state:RollbackBotState={version:1,capturedAt:now.toISOString(),sources,directories,files},pin=pinRollbackBotState(state),report=verifyRollbackBotState(state,pin);
  function assertUnchanged(){
    // Business DB contents belong to the held checkpoint verifier, not this
    // external-file reader. Its identity must nevertheless remain unchanged.
    const current=stat(input.database);if(!current?.isFile()||current.nlink!==1n||current.ino!==sourceIdentity.ino||current.dev!==sourceIdentity.dev||realpathSync(input.database)!==input.database)throw Error('Bot capture database was replaced');
    for(const [path,before] of parents){const after=directory(path);if(after.ino!==before.ino||after.dev!==before.dev)throw Error('Bot capture parent was replaced');}
    for(const [,root] of roots){const before=observed.get(root)!;if(before===null){if(stat(root)!==null)throw Error('Bot capture directory appeared');continue;}
      const after=directory(root);if(JSON.stringify(fingerprint(after))!==JSON.stringify(fingerprint(before)))throw Error('Bot capture directory changed');
      if(JSON.stringify(readdirSync(root).sort(order))!==JSON.stringify(inventories.get(root)))throw Error('Bot capture inventory changed');
    }
    for(const [path,before] of held){const after=externalFile(path);if(JSON.stringify(fingerprint(after.stat))!==JSON.stringify(fingerprint(before.stat))||!after.bytes.equals(before.bytes))throw Error('Bot capture source changed');}
  }
  assertUnchanged();return {state,pin,report,assertUnchanged};
}
