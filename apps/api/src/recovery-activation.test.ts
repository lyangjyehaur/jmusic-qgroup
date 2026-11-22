import * as fs from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import Database from 'better-sqlite3';
import {openDatabase,openServiceDatabase} from '@qgroup/database';
import {afterEach,expect,it} from 'vitest';
import {recoveryActivationFixture,recoveryStamp} from '../testsupport/recovery-activation-fixture';
import {createActivatedRecoveryImage,verifyRecoveryActivationImage,readRecoveryActivation} from './recovery-activation-protocol';
import {activateRecoveryCopy} from '../../../tools/migration/activate-recovery-copy';
import {digest} from '../../../tools/migration/music-codec';
import {encode,readRollbackErasureAuthority} from './erasure-authority-protocol';
import {retainedErasureConfig} from './retained-erasure-config';
import {createRetainedErasureJournal} from './retained-erasure-journal';
import {acquireInheritedAuthorityLock} from './erasure-authority-lock';
import {createPrivacy} from './privacy';

const cleanup:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function setup(){const s=await recoveryActivationFixture();cleanup.push(()=>s.close());return s;}
const helper="import fcntl,sys\nfcntl.flock(3,fcntl.LOCK_EX|fcntl.LOCK_NB)\nprint('locked',flush=True)\nsys.stdin.read()";
const acquireLock=(path:string)=>acquireInheritedAuthorityLock(path,'python3',['-c',helper]);
it('activates only a new image, independently compares all SQLite values, storage classes, rowids, sequences and DDL using Python, and preserves uncertain bot work',async()=>{
  const s=await setup(),before=s.source.state.checkpointImage,result=activateRecoveryCopy(s.input,recoveryStamp),path=join(s.input.destination,'data/unified.sqlite3');
  expect(result).toMatchObject({status:'activated_private_recovery_copy',uncertainDeliveriesPreserved:2,deploymentPerformed:false,releaseEligible:false});
  const after=fs.readFileSync(path),verification=verifyRecoveryActivationImage(before,after,s.originalJournal,s.review);expect(Object.keys(verification.tables).length).toBeGreaterThan(90);
  const output=execFileSync('python3',['-I','-c',`import sqlite3,sys,json
a,b=[sqlite3.connect('file:'+p+'?mode=ro',uri=True) for p in sys.argv[1:]]
q=lambda s:'"'+s.replace('"','""')+'"'
ddl="select type,name,tbl_name,sql from sqlite_master order by type,name"
assert a.execute(ddl).fetchall()==b.execute(ddl).fetchall()
tables=[r[0] for r in a.execute("select name from sqlite_master where type='table' order by name")]
for table in tables:
 cols=[r[1] for r in a.execute('pragma table_xinfo('+q(table)+')')]
 if table=='rebuild_storage':cols=[c for c in cols if c!='recovery_required']
 sql='select rowid,'+','.join('typeof('+q(c)+'),'+q(c) for c in cols)+' from '+q(table)+' order by rowid'
 assert a.execute(sql).fetchall()==b.execute(sql).fetchall(),table
assert a.execute('select recovery_required from rebuild_storage').fetchone()==(1,)
assert b.execute('select recovery_required from rebuild_storage').fetchone()==(0,)
print(json.dumps({'tablesCompared':len(tables),'onlyRecoveryFlagChanged':True}))
`,join(s.packageRoot,'private/latest/unified.sqlite3'),path],{encoding:'utf8',timeout:10000});expect(JSON.parse(output)).toMatchObject({onlyRecoveryFlagChanged:true});
  const current=openServiceDatabase(path);cleanup.push(()=>{current.close();});expect(current.prepare('SELECT * FROM bot_outbox ORDER BY id').all()).toEqual(s.db.prepare('SELECT * FROM bot_outbox ORDER BY id').all());expect(()=>current.exec('UPDATE rebuild_storage SET recovery_required=1; UPDATE rebuild_storage SET recovery_required=0')).toThrow('immutable');
  for(const file of s.bot.state.files){const target=file.path.startsWith('logs/')?'bot-logs/'+file.path.slice(5):file.path.startsWith('abbreviations/')?'bot-abbreviation-results/'+file.path.slice(14):'sensitive-words.json',path=join(s.input.destination,'data',target);expect(fs.readFileSync(path)).toEqual(file.bytes);expect(fs.lstatSync(path,{bigint:true}).mtimeNs.toString()).toBe(file.mtimeNs);}
  for(const file of s.media.originalFiles)expect(fs.readFileSync(join(s.input.destination,'data',file.path))).toEqual(file.bytes);
  // The deliberate local trigger probe changed only this disposable service DB;
  // the source, journal and authority stay exact, blocked and independently held.
  expect(()=>openDatabase(join(s.packageRoot,'private/latest/unified.sqlite3'))).toThrow('offline review');s.source.assertUnchanged();s.authority.assertUnchanged();s.bot.assertUnchanged();expect(fs.readFileSync(join(s.input.destination,'data/unified.erasures.jsonl'))).toEqual(s.originalJournal);
});
it.each(['missing delivery','changed delivery','wrong checkpoint','wrong journal','wrong lineage','wrong bot state','stale head','future review','missing evidence','changed evidence','async guard','source destination','authority destination','existing destination'])('rejects %s review or boundary without changing the original source',async change=>{
  const s=await setup(),review=structuredClone(s.review);let destination=s.input.destination;
  if(change==='missing delivery')review.deliveries.pop();if(change==='changed delivery')review.deliveries[0]!.rowSha256='0'.repeat(64);if(change==='wrong checkpoint')review.checkpointSha256='0'.repeat(64);if(change==='wrong journal')review.journalSha256='0'.repeat(64);if(change==='wrong lineage')review.lineageId='0'.repeat(32);if(change==='wrong bot state')review.botStateSha256='0'.repeat(64);if(change==='stale head')review.authorityHeadSha256='0'.repeat(64);if(change==='future review')review.reviewedAt='2027-01-01T00:00:00.000Z';s.replaceReview(review);
  if(change==='missing evidence')fs.rmSync(s.input.evidence.bot.path);if(change==='changed evidence')fs.appendFileSync(s.input.evidence.bot.path,' ');if(change==='source destination')destination=join(s.packageRoot,'activation');if(change==='authority destination')destination=join(s.authorityRoot,'activation');if(change==='existing destination'){fs.mkdirSync(destination,{mode:0o700});fs.writeFileSync(join(destination,'keep'),'other');}
  expect(()=>activateRecoveryCopy({...s.input,destination},recoveryStamp,change==='async guard'?async()=>{}:undefined)).toThrow();expect(fs.existsSync(join(destination,'recovery-copy-manifest.json'))).toBe(false);if(change==='existing destination')expect(fs.readFileSync(join(destination,'keep'),'utf8')).toBe('other');else expect(fs.existsSync(destination)).toBe(false);s.source.assertUnchanged();s.authority.assertUnchanged();s.bot.assertUnchanged();
});
it.each(['bot row','sequence','ddl','metadata','rowid'])('independent verification rejects rehashed %s drift even after a flag-only writer succeeds',async change=>{
  const s=await setup(),checkpoint=s.source.state.checkpointImage,{image}=createActivatedRecoveryImage(checkpoint,s.originalJournal,s.review),db=new Database(image);
  try{if(change==='bot row')db.exec("UPDATE bot_outbox SET status='pending' WHERE status='sending'");if(change==='sequence')db.exec("UPDATE sqlite_sequence SET seq=seq+1");if(change==='ddl')db.exec('CREATE TABLE extra_data(id INTEGER)');if(change==='metadata')db.pragma('application_id=99');if(change==='rowid')db.exec('UPDATE users SET rowid=rowid+100');const next=db.serialize();next[18]=1;next[19]=1;expect(()=>verifyRecoveryActivationImage(checkpoint,next,s.originalJournal,s.review)).toThrow();}finally{db.close();}
});
it.each([1,2,3])('fences late evidence mutation at guard %i and retains incomplete output after reservation',async stage=>{
  const s=await setup();let calls=0;expect(()=>activateRecoveryCopy(s.input,recoveryStamp,()=>{if(++calls===stage)fs.appendFileSync(s.input.evidence.bot.path,' ');})).toThrow();expect(calls).toBe(stage);if(stage===1)expect(fs.existsSync(s.input.destination)).toBe(false);else{expect(fs.existsSync(join(s.input.destination,'incomplete.json'))).toBe(true);expect(fs.existsSync(join(s.input.destination,'data/unified.sqlite3'))).toBe(false);expect(fs.existsSync(join(s.input.destination,'data/unified.sqlite3.incomplete'))).toBe(true);expect(fs.existsSync(join(s.input.destination,'activation/incomplete.json'))).toBe(true);}s.source.assertUnchanged();s.authority.assertUnchanged();
});
it('holds the original retained authority, continues native erasures across restart, and leaves old-service erasures blocking startup',async()=>{
  const s=await setup(),result=activateRecoveryCopy(s.input,recoveryStamp),db=openServiceDatabase(join(s.input.destination,'data/unified.sqlite3'));cleanup.push(()=>{db.close();});const config={root:s.authorityRoot,manifestSha256:s.authorityPin,sourceCheckpoint:join(s.packageRoot,'private/latest/unified.sqlite3'),recoveryActivation:{root:join(s.input.destination,'activation'),manifestSha256:result.activationManifestSha256}};
  await expect(createRetainedErasureJournal(db,{...config,recoveryActivation:undefined},{acquireLock})).rejects.toThrow('requires review');
  const journal=await createRetainedErasureJournal(db,config,{acquireLock});cleanup.push(()=>journal.close());const privacy=createPrivacy(db,journal),entry={...s.entry,userId:'contact-owner',profileId:null,kind:'account' as const,requestId:crypto.randomUUID()};db.transaction(()=>privacy.submit(entry)).immediate();privacy.guard();await journal.close();
  const reopened=await createRetainedErasureJournal(db,config,{acquireLock});cleanup.push(()=>reopened.close());expect(reopened.read()).toHaveLength(2);expect(readRollbackErasureAuthority(s.authorityRoot,s.authorityPin).head.sequence).toBe(1);expect(db.prepare('SELECT * FROM bot_outbox ORDER BY id').all()).toEqual(s.db.prepare('SELECT * FROM bot_outbox ORDER BY id').all());await reopened.close();
  const oldRoot=join(s.root,'old-service');fs.mkdirSync(oldRoot,{mode:0o700});const old=join(oldRoot,'erasures.jsonl');execFileSync('python3',['-c',"from tools.migration.rollback_erasure_authority import ErasureAuthority\nimport sys,json\nc=ErasureAuthority(sys.argv[1],sys.argv[2],{'music':sys.argv[3]})\ntry:\n c.recover('music');c.record('music',(json.dumps({'qq':'10001','erased_at':1234},separators=(',',':'))+'\\n').encode())\nfinally:c.close()",s.authorityRoot,s.authorityPin,old],{timeout:10000,stdio:'pipe'});
  await expect(createRetainedErasureJournal(db,config,{acquireLock})).rejects.toThrow('forward projection');
});
it('rejects receipt mutation during a held native lifetime before reads or another append',async()=>{
  const s=await setup(),result=activateRecoveryCopy(s.input,recoveryStamp),db=openServiceDatabase(join(s.input.destination,'data/unified.sqlite3'));cleanup.push(()=>{db.close();});const activationRoot=join(s.input.destination,'activation'),journal=await createRetainedErasureJournal(db,{root:s.authorityRoot,manifestSha256:s.authorityPin,sourceCheckpoint:join(s.packageRoot,'private/latest/unified.sqlite3'),recoveryActivation:{root:activationRoot,manifestSha256:result.activationManifestSha256}},{acquireLock});cleanup.push(()=>journal.close());
  fs.appendFileSync(join(activationRoot,'bot-review.json'),' ');expect(()=>journal.read()).toThrow();expect(()=>journal.append({...s.entry,requestId:crypto.randomUUID()})).toThrow();expect(readRollbackErasureAuthority(s.authorityRoot,s.authorityPin).head.sequence).toBe(0);s.source.assertUnchanged();
});
it.each(['wrong pin','extra file','same-byte replacement','bot pin','table pin'])('rejects %s activation receipt changes with an independently supplied manifest pin',async change=>{
  const s=await setup(),result=activateRecoveryCopy(s.input,recoveryStamp),root=join(s.input.destination,'activation');let pin=result.activationManifestSha256;
  if(change==='wrong pin')pin='0'.repeat(64);if(change==='extra file')fs.writeFileSync(join(root,'extra'),'extra',{mode:0o600});if(change==='same-byte replacement'){const read=readRecoveryActivation(root,pin,s.source.state.checkpointImage,s.authority);const path=join(root,'bot-review.json'),raw=fs.readFileSync(path);fs.unlinkSync(path);fs.writeFileSync(path,raw,{mode:0o600});expect(()=>read.assertUnchanged()).toThrow();return;}
  if(change==='bot pin'||change==='table pin'){const path=join(root,'activation-manifest.json'),manifest=JSON.parse(fs.readFileSync(path,'utf8'));if(change==='bot pin')manifest.botStateSha256='0'.repeat(64);else manifest.tables.bot_outbox='0'.repeat(64);const raw=encode(manifest);fs.writeFileSync(path,raw);pin=digest(raw);}
  expect(()=>readRecoveryActivation(root,pin,s.source.state.checkpointImage,s.authority)).toThrow();
});
it('parses recovery configuration completely before opening storage and rejects omitted authority or partial activation pairs',()=>{
  const authority={REBUILD_ERASURE_AUTHORITY_ROOT:'/private/authority',REBUILD_ERASURE_AUTHORITY_MANIFEST_SHA256:'a'.repeat(64),REBUILD_ERASURE_AUTHORITY_CHECKPOINT:'/private/source.sqlite3'},activation={REBUILD_RECOVERY_ACTIVATION_ROOT:'/private/activation',REBUILD_RECOVERY_ACTIVATION_MANIFEST_SHA256:'b'.repeat(64)};
  expect(retainedErasureConfig({...authority,...activation},true)).toMatchObject({recoveryActivation:{root:'/private/activation',manifestSha256:'b'.repeat(64)}});expect(()=>retainedErasureConfig(activation,false)).toThrow();expect(()=>retainedErasureConfig({...authority,REBUILD_RECOVERY_ACTIVATION_ROOT:activation.REBUILD_RECOVERY_ACTIVATION_ROOT},false)).toThrow();expect(()=>retainedErasureConfig({...authority,REBUILD_RECOVERY_ACTIVATION_MANIFEST_SHA256:activation.REBUILD_RECOVERY_ACTIVATION_MANIFEST_SHA256},false)).toThrow();expect(retainedErasureConfig({},false)).toBeUndefined();
});
it('runs a redacted offline CLI from a separately pinned private input and leaves a verifiable isolated copy',async()=>{
  const s=await setup(),path=join(s.root,'activation-input.json'),raw=encode(s.input);fs.writeFileSync(path,raw,{mode:0o600});const stdout=execFileSync(process.execPath,['--import','tsx','tools/migration/activate-recovery-copy.ts',path,digest(raw)],{encoding:'utf8',timeout:20000});const result=JSON.parse(stdout);expect(result).toMatchObject({status:'activated_private_recovery_copy',releaseEligible:false,deploymentPerformed:false});expect(stdout).not.toMatch(/\/Users|\/tmp|fixture|secret|group/);readRecoveryActivation(join(s.input.destination,'activation'),result.activationManifestSha256,s.source.state.checkpointImage,s.authority).assertUnchanged();s.source.assertUnchanged();
});
