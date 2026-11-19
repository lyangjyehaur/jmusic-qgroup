import {constants,closeSync,fstatSync,fsyncSync,openSync,renameSync,writeSync} from 'node:fs';
import {basename,dirname,join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {REBUILD_SCHEMA_VERSION,type DB} from '@qgroup/database';
import Database from 'better-sqlite3';
import type {z} from 'zod';
import {decodeErasureJournal,erasureJournalPath,type ErasureIntent,type ErasureJournal} from './erasure-journal';
import {acquireErasureAuthorityLock,type ErasureAuthorityLock} from './erasure-authority-lock';
import {encode,ErasureAuthorityRecord,privateDirectory,privateFile,readRollbackErasureAuthority,validateAuthorityLedger} from './erasure-authority-protocol';
import {sourceDirectory,sourceStat,snapshotRollbackFile} from '../../../packages/runtime/src/private-source-files';
import {digest} from '../../../packages/runtime/src/strict-json';
import {RetainedErasureConfig} from './retained-erasure-config';
export {RetainedErasureConfig} from './retained-erasure-config';

type Config=z.infer<typeof RetainedErasureConfig>;
type Snapshot=ReturnType<typeof readRollbackErasureAuthority>;
export type RetainedJournal=ErasureJournal&{close():Promise<void>};
/** Native website continuation of the exact private authority protocol. The
 * authority must be retained independently; no origin or credentials are read.
 * All writer operations are synchronous inside the lifetime OS exclusion. */
export async function createRetainedErasureJournal(db:DB,input:Config,dependencies:{acquireLock?:(path:string)=>Promise<ErasureAuthorityLock>;fault?:(stage:string)=>void}={}):Promise<RetainedJournal>{
  const config=RetainedErasureConfig.parse(input),root=config.root,pin=config.manifestSha256,path=erasureJournalPath(db.name),folder=dirname(path);
  if(db.name===':memory:'||resolve(path)!==path||root===folder||root.startsWith(folder+'/')||folder.startsWith(root+'/'))throw Error('Authority and existing service storage must be isolated');
  const directories=new Map([root,join(root,'baseline'),join(root,'records'),folder].map(path=>[path,privateDirectory(path)])),parent=sourceDirectory(dirname(root)),sqliteInodes=new Set<string>();
  let lock:ErasureAuthorityLock|undefined,closed=false,failed=false,observedPins:string[]=[],lineage:string|undefined;
  function captureSQLite(){for(const suffix of ['', '-wal','-shm','-journal']){const stat=sourceStat(db.name+suffix);if(stat)sqliteInodes.add(stat.dev+':'+stat.ino);}}
  function owned(){if(closed)throw Error('Retained journal is closed');for(const [path,held] of directories){const current=privateDirectory(path);if(current.dev!==held.dev||current.ino!==held.ino)throw Error('Authority or service directory replaced');}const current=sourceDirectory(dirname(root));if(current.dev!==parent.dev||current.ino!==parent.ino)throw Error('Authority parent replaced');lock?.assertHeld();}
  function protect(path:string){owned();captureSQLite();const stat=sourceStat(path);if(stat&&sqliteInodes.has(stat.dev+':'+stat.ino))throw Error('Authority file cannot alias a live SQLite inode');}
  function fault(stage:string){const value:unknown=dependencies.fault?.(stage);if(value!==null&&(typeof value==='object'||typeof value==='function')&&'then' in value)throw Error('Retained journal hook must be synchronous');owned();}
  function snapshot(includeUnpublished=false){owned();const saved=readRollbackErasureAuthority(root,pin,{beforeFile:protect,includeUnpublished});if(saved.recordPins.length<observedPins.length||observedPins.some((sha,index)=>saved.recordPins[index]!==sha))throw Error('Observed authority records were rewound or replaced');
    // A resumed old service can write board/music intents after rollback. These
    // need a complete forward projection; unified-only replay cannot apply them.
    if(saved.records.some(row=>row.domain!=='unified'))throw Error('Latest old-service erasures require forward projection before native startup');
    for(const domain of ['board','music'] as const){const baseline=saved.manifest.baseline.find(row=>row.domain===domain)!;if(saved.head.ledgers[domain].size!==baseline.size||saved.head.ledgers[domain].sha256!==baseline.sha256)throw Error('Latest old-service erasures require forward projection before native startup');}
    return saved;}
  function observe(saved:Snapshot){observedPins=[...saved.recordPins];}
  function writeNew(path:string,bytes:Buffer){protect(path);const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{let offset=0;while(offset<bytes.length){const count=writeSync(fd,bytes,offset,bytes.length-offset);if(!count)throw Error('Retained journal write interrupted');offset+=count;}fsyncSync(fd);}finally{closeSync(fd);}owned();}
  function sync(path:string){owned();privateDirectory(path);const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{fsyncSync(fd);}finally{closeSync(fd);}owned();}
  function publish(saved:Snapshot){
    const head=join(root,'authority-head.json'),temporary=join(root,'.head-'+randomBytes(16).toString('hex')+'.tmp');saved.assertUnchanged();writeNew(temporary,encode(saved.head));fault('head_temporary_fsynced');
    saved.assertUnchanged([basename(temporary)]);
    const current=privateFile(head,4096,protect),replacement=privateFile(temporary,4096,protect);if(!current.bytes?.equals(saved.sourceHeadBytes)||!replacement.bytes?.equals(encode(saved.head)))throw Error('Authority head changed during publication');current.assertUnchanged();replacement.assertUnchanged();saved.assertUnchanged([basename(temporary)]);owned();renameSync(temporary,head);sync(root);
  }
  function source(){protect(path);const stat=sourceStat(path);if(stat===null)return snapshotRollbackFile(path,64*1024*1024,true);return privateFile(path,64*1024*1024,protect);}
  function sourceAppend(original:ReturnType<typeof source>,suffix:Buffer){
    protect(path);original.assertUnchanged();const before=sourceStat(path),fd=openSync(path,constants.O_WRONLY|constants.O_APPEND|constants.O_NOFOLLOW|(before===null?constants.O_CREAT|constants.O_EXCL:0),0o600);
    try{const held=fstatSync(fd,{bigint:true});if(before&&(held.dev!==before.dev||held.ino!==before.ino))throw Error('Service ledger inode changed');let offset=0;while(offset<suffix.length){const count=writeSync(fd,suffix,offset,suffix.length-offset);if(!count)throw Error('Service ledger write interrupted');offset+=count;}fsyncSync(fd);}finally{closeSync(fd);}sync(folder);
    const after=source();if(!after.bytes?.equals(Buffer.concat([original.bytes??Buffer.alloc(0),suffix])))throw Error('Service ledger append differs');after.assertUnchanged();
  }
  function currentLineage(){const rows=db.prepare('SELECT lineage_id,recovery_required FROM rebuild_storage WHERE id=1').all() as {lineage_id:string;recovery_required:number}[];if(rows.length!==1||!rows[0]||!/^[a-f0-9]{32}$/.test(rows[0].lineage_id)||rows[0].recovery_required!==0)throw Error('Native storage lineage requires review');return rows[0].lineage_id;}
  function verify(){if(failed)throw Error('Retained journal write failed; restart and verify authority');if(currentLineage()!==lineage)throw Error('Native storage differs from retained checkpoint lineage');const saved=snapshot(),local=source();if(!local.bytes?.equals(saved.ledgers.unified))throw Error('Latest retained intent absent from service ledger');saved.assertUnchanged();local.assertUnchanged();observe(saved);return {saved,local};}
  try{
    protect(join(root,'.authority.lock'));lock=await (dependencies.acquireLock??acquireErasureAuthorityLock)(join(root,'.authority.lock'));owned();
    let saved=snapshot(true);
    const checkpoint=privateFile(config.sourceCheckpoint,512*1024*1024,protect);if(!checkpoint.bytes||checkpoint.sha256!==saved.manifest.checkpointSha256)throw Error('Retained checkpoint source pin differs');
    const fixed=new Database(checkpoint.bytes);try{const versions=fixed.prepare('SELECT version FROM rebuild_schema').all() as {version:number}[],rows=fixed.prepare('SELECT lineage_id,recovery_required FROM rebuild_storage WHERE id=1').all() as {lineage_id:string;recovery_required:number}[];if(versions.length!==1||versions[0]?.version!==REBUILD_SCHEMA_VERSION||rows.length!==1||!rows[0]||!/^[a-f0-9]{32}$/.test(rows[0].lineage_id)||rows[0].recovery_required!==0)throw Error('Retained checkpoint lineage requires review');lineage=rows[0].lineage_id;}finally{fixed.close();}
    checkpoint.assertUnchanged();saved.assertUnchanged();if(currentLineage()!==lineage)throw Error('Native storage differs from retained checkpoint lineage');
    if(saved.pendingPublication){publish(saved);saved=snapshot();}observe(saved);
    const local=source(),original=local.bytes??Buffer.alloc(0);if(!saved.ledgers.unified.subarray(0,original.length).equals(original))throw Error('Service ledger contains unrecorded or conflicting authority bytes');
    saved.assertUnchanged();local.assertUnchanged();if(local.bytes===null||original.length!==saved.ledgers.unified.length)sourceAppend(local,saved.ledgers.unified.subarray(original.length));verify();
    return {
      read(){const {saved}=verify();return decodeErasureJournal(saved.ledgers.unified.toString('utf8'));},
      assertReadable(){verify();},
      append(entry:ErasureIntent){try{
        const suffix=encode(entry),parsed=decodeErasureJournal(suffix.toString('utf8'));if(parsed.length!==1||!('version' in parsed[0]!))throw Error('Native erasure intent required');
        const {saved,local}=verify(),combined=Buffer.concat([saved.ledgers.unified,suffix]);validateAuthorityLedger('unified',combined);
        const sequence=saved.head.sequence+1;if(sequence>100000)throw Error('Authority record limit reached');const record=ErasureAuthorityRecord.parse({version:1,authoritySha256:pin,sequence,previousRecordSha256:saved.head.recordSha256??pin,domain:'unified',suffixBase64:suffix.toString('base64'),ledgerSize:combined.length,ledgerSha256:digest(combined)}),bytes=encode(record);
        saved.assertUnchanged();local.assertUnchanged();writeNew(join(root,'records',String(sequence).padStart(12,'0')+'.json'),bytes);sync(join(root,'records'));fault('record_fsynced');
        const pending=snapshot(true);if(!pending.pendingPublication||pending.head.sequence!==sequence||pending.head.recordSha256!==digest(bytes))throw Error('Retained record publication differs');publish(pending);fault('head_published');fault('before_source');sourceAppend(local,suffix);fault('source_fsynced');verify();
      }catch(error){failed=true;throw error;}},
      async close(){if(closed)return;closed=true;await lock!.release();},
    };
  }catch(error){closed=true;await lock?.release();throw error;}
}
