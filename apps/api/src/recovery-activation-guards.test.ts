import * as fs from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import Database from 'better-sqlite3';
import {openServiceDatabase} from '@qgroup/database';
import {afterEach,expect,it} from 'vitest';
import {recoveryActivationFixture,recoveryStamp} from '../testsupport/recovery-activation-fixture';
import {activateRecoveryCopy} from '../../../tools/migration/activate-recovery-copy';
import {readRecoveryActivation} from './recovery-activation-protocol';
import {createRetainedErasureJournal} from './retained-erasure-journal';
import {acquireInheritedAuthorityLock} from './erasure-authority-lock';
import {digest} from '../../../tools/migration/music-codec';
import {encode} from './erasure-authority-protocol';

const cleanup:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function setup(){const s=await recoveryActivationFixture();cleanup.push(()=>s.close());return s;}
it('rejects a coherently rehashed altered activation image by comparing it with the original blocked source',async()=>{
  const s=await setup(),saved=activateRecoveryCopy(s.input,recoveryStamp),root=join(s.input.destination,'activation'),path=join(root,'activated-checkpoint.sqlite3'),db=new Database(fs.readFileSync(path));let changed:Buffer;
  try{db.exec("UPDATE users SET nickname='altered' WHERE id='alice'");changed=db.serialize();changed[18]=1;changed[19]=1;}finally{db.close();}
  fs.writeFileSync(path,changed);const manifestPath=join(root,'activation-manifest.json'),manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));manifest.activatedCheckpointSha256=digest(changed);const file=manifest.files.find((file:{path:string})=>file.path==='activated-checkpoint.sqlite3');file.size=changed.length;file.sha256=digest(changed);const raw=encode(manifest);fs.writeFileSync(manifestPath,raw);
  expect(()=>readRecoveryActivation(root,digest(raw),s.source.state.checkpointImage,s.authority)).toThrow('changed a data table');expect(saved.activationManifestSha256).not.toBe(digest(raw));s.source.assertUnchanged();
});
it('refuses a receipt alias of the live SQLite inode before opening another FD and preserves its real writer lock',async()=>{
  const s=await setup(),saved=activateRecoveryCopy(s.input,recoveryStamp),path=join(s.input.destination,'data/unified.sqlite3'),root=join(s.input.destination,'activation'),db=openServiceDatabase(path);cleanup.push(()=>{db.close();});
  const helper="import fcntl,sys\nfcntl.flock(3,fcntl.LOCK_EX|fcntl.LOCK_NB)\nprint('locked',flush=True)\nsys.stdin.read()",journal=await createRetainedErasureJournal(db,{root:s.authorityRoot,manifestSha256:s.authorityPin,sourceCheckpoint:join(s.packageRoot,'private/latest/unified.sqlite3'),recoveryActivation:{root,manifestSha256:saved.activationManifestSha256}},{acquireLock:path=>acquireInheritedAuthorityLock(path,'python3',['-c',helper])});cleanup.push(()=>journal.close());
  db.pragma('journal_mode=DELETE');db.exec('BEGIN IMMEDIATE');const receipt=join(root,'activated-checkpoint.sqlite3'),savedReceipt=join(s.root,'receipt.saved');fs.renameSync(receipt,savedReceipt);fs.renameSync(path,receipt);
  try{expect(()=>journal.read()).toThrow('live SQLite inode');execFileSync('python3',['-I','-c',"import sqlite3,sys\nc=sqlite3.connect(sys.argv[1],timeout=0)\ntry:\n c.execute('begin immediate')\nexcept sqlite3.OperationalError as e:\n assert 'locked' in str(e)\nelse:\n raise AssertionError('Writer lock was released')\nfinally:c.close()",receipt],{timeout:10000,stdio:'pipe'});}finally{db.exec('ROLLBACK');fs.renameSync(receipt,path);fs.renameSync(savedReceipt,receipt);}
});
it.each(['root','subdirectory','file'])('fences final output %s replacement and preserves replacement contents',async change=>{
  const s=await setup();let calls=0;const destination=s.input.destination;
  expect(()=>activateRecoveryCopy(s.input,recoveryStamp,()=>{if(++calls!==3)return;if(change==='root'){fs.renameSync(destination,destination+'.saved');fs.mkdirSync(destination,{mode:0o700});fs.writeFileSync(join(destination,'keep'),'other');}else if(change==='subdirectory'){const path=join(destination,'data');fs.renameSync(path,path+'.saved');fs.mkdirSync(path,{mode:0o700});fs.writeFileSync(join(path,'keep'),'other');}else fs.appendFileSync(join(destination,'data/unified.erasures.jsonl'),' ');})).toThrow();
  if(change==='root')expect(fs.readdirSync(destination)).toEqual(['keep']);else if(change==='subdirectory')expect(fs.readdirSync(join(destination,'data'))).toEqual(['keep']);else{expect(fs.existsSync(join(destination,'incomplete.json'))).toBe(true);expect(fs.existsSync(join(destination,'data/unified.sqlite3'))).toBe(false);}s.source.assertUnchanged();s.authority.assertUnchanged();
});
