import Database from 'better-sqlite3';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {mkdirSync,writeFileSync,cpSync,readFileSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {assertDatabaseUsable,type DB} from '@qgroup/database';
import {forwardAccountBusinessFixture,accountRebasedAt} from '../testsupport/forward-account-business-fixture';
import {accountPin,prepareForwardAccountEpoch,verifyForwardAccountEpoch,type ForwardAccountEpoch} from '../../../tools/migration/forward-account-epoch';
import {reconstructForwardAccountBusiness,verifyForwardAccountBusiness,type ForwardAccountBusinessInput,type ForwardAccountBusinessBundle} from '../../../tools/migration/forward-account-business';
import {rebaseForwardAccountBusiness,verifyForwardAccountRebase} from '../../../tools/migration/forward-account-rebase';
import {copyForwardMusicInput} from '../../../tools/migration/forward-music-sources';
import {mergeForwardMusic} from '../../../tools/migration/forward-music-merge';
import {rebaseForwardSources} from '../../../tools/migration/forward-source-rebase';
import {forwardRows,forwardHash} from '../../../tools/migration/forward-board-storage';
import {projectRollbackStateFromCheckpoint} from '../../../tools/migration/rollback-state';
import {captureRollbackMedia} from '../../../tools/migration/rollback-media';
import {projectRollbackHistory} from '../../../tools/migration/rollback-history';
import {assembleRollbackPackage,pinRollbackPackageSource} from '../../../tools/migration/rollback-package-codec';
import {writeRollbackPackage,readRollbackPackage} from '../../../tools/migration/rollback-package';
import {decodeErasureJournal} from './erasure-journal';

type Fixture=Awaited<ReturnType<typeof forwardAccountBusinessFixture>>;
type Case={s:Fixture;input:ForwardAccountBusinessInput;business:ReturnType<typeof reconstructForwardAccountBusiness>;rebased:ReturnType<typeof rebaseForwardAccountBusiness>};
const cases:Case[]=[],dbs:DB[]=[];
const open=(bytes:Buffer)=>{const db=new Database(bytes);dbs.push(db);return db;};
const rows=(db:DB,table:string)=>[...forwardRows(db,table)];
const inputCopy=(c:Case)=>({...c.input,sources:copyForwardMusicInput(c.input.sources)});
function epochCopy(e:ForwardAccountEpoch):ForwardAccountEpoch{return {sources:copyForwardMusicInput(e.sources),accountBase:accountPin(e.accountBase.bytes),rawMusic:accountPin(e.rawMusic.bytes),rawIdentity:accountPin(e.rawIdentity.bytes),cleanMusic:accountPin(e.cleanMusic.bytes),cleanIdentity:accountPin(e.cleanIdentity.bytes)};}
function bundleCopy(b:ForwardAccountBusinessBundle):ForwardAccountBusinessBundle{return {epoch:epochCopy(b.epoch),nativeImage:Buffer.from(b.nativeImage),nativeJournal:Buffer.from(b.nativeJournal),retainedBusinessImage:Buffer.from(b.retainedBusinessImage),musicSources:Buffer.from(b.musicSources),identitySources:Buffer.from(b.identitySources)};}
beforeAll(async()=>{for(const id of ['claimant','fresh-native'] as const){const s=await forwardAccountBusinessFixture(id);try{const input=s.accountInput(),business=reconstructForwardAccountBusiness(input),rebased=rebaseForwardAccountBusiness(input,business,accountRebasedAt);cases.push({s,input,business,rebased});}catch(error){s.close();throw error;}}},60000);
afterAll(()=>{for(const db of dbs.reverse())db.close();for(const c of cases)c.s.close();});

it.each([0,1])('reconstructs all domains and repeated source evidence after original account closure %i',index=>{
  const c=cases[index]!,{s,business,rebased}=c,db=open(rebased.nativeImage),raw=JSON.parse(business.epoch.rawMusic.bytes.toString()),clean=JSON.parse(business.epoch.cleanMusic.bytes.toString());
  expect(raw.data.members[s.accountKey].boardUserId).toBe(s.userId);expect(clean.data.members[s.accountKey].boardUserId).toBe('');
  expect(clean.data.members[s.accountKey].note).toBe('old closed profile content retained');expect(clean.data.members['10002'].note).toBe('old open profile change');expect(clean.data.entries.e.text).toBe('old entry change');expect(clean.data.members['10006'].name).toBe('old new profile');
  expect(db.prepare('SELECT user_id FROM music_profiles WHERE id=?').get(s.profileId)).toEqual({user_id:null});expect(db.prepare('SELECT count(*) n FROM music_profiles').get()).toEqual({n:6});
  expect(db.prepare("SELECT title FROM events WHERE id='listen'").get()).toEqual({title:'old independent activity'});expect(db.prepare('SELECT message FROM notifications WHERE id=?').get(s.notificationId)).toEqual({message:'old message'});
  expect(db.prepare('SELECT count(*) n FROM music_profile_receipts WHERE user_id=?').get(s.userId)).toEqual({n:0});expect(db.prepare('SELECT * FROM privacy_requests WHERE id=?').get(s.closure.request_id)).toEqual(s.accountOldBoard.prepare('SELECT * FROM privacy_requests WHERE id=?').get(s.closure.request_id));
  expect(db.prepare('SELECT 1 FROM browser_sessions WHERE user_id=?').get(s.userId)).toBeUndefined();expect(db.pragma('foreign_key_check')).toEqual([]);expect(db.pragma('integrity_check',{simple:true})).toBe('ok');expect(()=>assertDatabaseUsable(db)).toThrow();
  expect(verifyForwardAccountBusiness(c.input,business).allSourcesBusinessAndProofsVerified).toBe(true);expect(verifyForwardAccountRebase(c.input,business,accountRebasedAt,rebased)).toMatchObject({completeOriginalAccountParentVerified:true,originalSourceBytesRetained:true,releaseEligible:false});
  expect(rebased.report).toMatchObject({externalRetentionVerified:false,authorityActivationRequired:true,recoveryRequired:true,rollbackEligible:false,releaseEligible:false});
});
it.each([0,1])('cleans only closed ownership and device scopes while preserving source proofs, audit and types %i',index=>{
  const c=cases[index]!,db=open(c.business.epoch.cleanIdentity.bytes),original=c.s.accountOldIdentity,key=c.s.accountKey;
  expect(db.prepare('SELECT 1 FROM links WHERE user_id=?').get(c.s.userId)).toBeUndefined();expect(db.prepare('SELECT 1 FROM prelinks WHERE user_id=?').get(c.s.userId)).toBeUndefined();
  expect(db.prepare('SELECT user_id,revision,updated,typeof(updated) t FROM link_overrides WHERE qq=?').get(key)).toEqual({user_id:'',revision:8,updated:Date.parse((c.s.accountOldBoard.prepare('SELECT created_at FROM privacy_requests WHERE user_id=?').get(c.s.userId) as {created_at:string}).created_at)/1000,t:'real'});
  expect(db.prepare('SELECT token_hash FROM sessions ORDER BY rowid').all()).toEqual([{token_hash:'open-device'}]);expect(db.prepare('SELECT token_hash FROM entry_intents ORDER BY rowid').all()).toEqual([{token_hash:'open-device'}]);
  expect(rows(db,'sessions')).toEqual(rows(original,'sessions').filter(row=>row.token_hash==='open-device'));expect(rows(db,'entry_intents')).toEqual(rows(original,'entry_intents').filter(row=>row.token_hash==='open-device'));
  expect(JSON.parse((db.prepare("SELECT payload FROM native_profiles WHERE qq='10002'").get() as {payload:string}).payload).boardUserId).toBe('');expect(db.prepare("SELECT user_id FROM prelinks WHERE qq='10002'").get()).toEqual({user_id:'bob'});
  for(const table of ['used_oauth','login_attempts','link_audit','profile_contacts','sqlite_sequence'])expect(rows(db,table)).toEqual(rows(original,table));
});
it.each([0,1])('preserves every bot row, delivery state, frozen history and sequence through the full account pipeline %i',index=>{
  const c=cases[index]!,base=open(c.business.epoch.accountBase.bytes),db=open(c.rebased.nativeImage);
  for(const table of ['bot_outbox','bot_settings_history','bot_runtime','music_profile_audit','music_ownership_history'])expect(rows(db,table)).toEqual(rows(base,table));
  expect(rows(db,'bot_outbox')).toEqual(rows(c.s.accountOldBoard,'bot_outbox'));
  expect(db.prepare("SELECT status FROM bot_outbox WHERE kind='account-reference' ORDER BY id").all()).toEqual(['pending','sending','sent','failed','skipped'].map(status=>({status})));
  const before=new Map(rows(base,'sqlite_sequence').map(row=>[row.name,row.seq]));for(const row of rows(db,'sqlite_sequence'))expect(row.seq).toBeGreaterThanOrEqual(before.get(row.name) as bigint);
  expect(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='notifications'").get()).toEqual(c.s.accountOldBoard.prepare("SELECT seq FROM sqlite_sequence WHERE name='notifications'").get());
});
it.each([0,1])('projects all native content, audit mappings and a private package after account source rebase %i',index=>{
  const c=cases[index]!,journal=decodeErasureJournal(c.rebased.nativeJournal.toString()),state=projectRollbackStateFromCheckpoint(c.rebased.nativeImage,journal),identity=open(state.identityImage),db=open(c.rebased.nativeImage);
  expect(db.pragma('integrity_check',{simple:true})).toBe('ok');const members=state.music.data.members as Record<string,Record<string,unknown>>;expect(members[c.s.accountKey]!.boardUserId).toBe('');expect(members[c.s.accountKey]!.note).toBe('old closed profile content retained');expect(members['10002']!.boardUserId).toBe('bob');expect(members['10002']!.note).toBe('old open profile change');expect(members['10006']!.name).toBe('old new profile');
  expect(state.music.keys.slice(0,c.s.state.music.keys.length)).toEqual(c.s.state.music.keys);expect(identity.prepare('SELECT id FROM link_audit ORDER BY id').all()).toEqual([{id:1},{id:12}]);expect(identity.prepare("SELECT seq FROM sqlite_sequence WHERE name='link_audit'").get()).toEqual({seq:40});
  expect(rows(identity,'sessions')).toEqual([]);expect(rows(identity,'entry_intents')).toEqual([]);expect(state.identityAuditMappings).toHaveLength(c.s.state.identityAuditMappings.length);
  const historyRoot=join(c.s.fixtureRoot,'empty-account-history');mkdirSync(historyRoot,{mode:0o700});
  const dataRoot=join(c.s.fixtureRoot,'final-account-media');mkdirSync(dataRoot,{mode:0o700});const database=join(dataRoot,'unified.sqlite3');writeFileSync(database,c.rebased.nativeImage,{mode:0o600});const mediaDb=new Database(database);dbs.push(mediaDb);
  const media=captureRollbackMedia(mediaDb,{read:()=>journal,append(){throw Error('read only');}}),history=projectRollbackHistory(state,{capture:c.s.captureConfig,native:{root:historyRoot,manifests:[]}}),pkg=assembleRollbackPackage(state,media,history,pinRollbackPackageSource(media,{captureManifestSha256:c.s.captureConfig.manifestSha256,native:[]}));
  const root=join(c.s.fixtureRoot,'account-final-package'),written=writeRollbackPackage(pkg,root,[c.input.authorityRoot],new Date('2026-11-20T05:04:00Z')),read=readRollbackPackage(root,written.manifestSha256);
  expect(read.state.music).toEqual(state.music);expect(read.state.identityAuditMappings).toEqual(state.identityAuditMappings);expect(read.state.checkpointImage).toEqual(state.checkpointImage);expect(read.report.rollbackEligible).toBe(false);
});

it('keeps ordinary source merge and ordinary repeated rebase closed to unverified account epochs',()=>{
  const c=cases[0]!;expect(()=>mergeForwardMusic(c.input.sources)).toThrow('Closed forward owner');
  const b=c.business,input={proofs:{sources:b.epoch.sources,businessImage:accountPin(b.retainedBusinessImage),musicSources:accountPin(b.musicSources),identitySources:accountPin(b.identitySources),reconstructedAt:c.input.reconstructedAt,reconciledAt:c.input.reconciledAt},proofImage:accountPin(b.nativeImage),rebasedAt:accountRebasedAt};
  expect(()=>rebaseForwardSources(input)).toThrow('already rebased');
});
it('retains open-owner proofs when an original closed session token now belongs to that open owner',()=>{
  const c=cases[0]!,input=inputCopy(c),board=open(input.sources.oldBoard.bytes);
  board.prepare("INSERT INTO browser_sessions VALUES(?,'bob','2026-11-20T04:59:00Z')").run(c.s.closedSession);input.sources.oldBoard=accountPin(board.serialize());
  const result=prepareForwardAccountEpoch(input),identity=open(result.cleanIdentity.bytes);
  expect(identity.prepare('SELECT token_hash FROM sessions ORDER BY rowid').all()).toEqual([{token_hash:'closed-device'},{token_hash:'open-device'}]);expect(identity.prepare('SELECT token_hash FROM entry_intents ORDER BY rowid').all()).toEqual([{token_hash:'closed-device'},{token_hash:'open-device'}]);
  expect(verifyForwardAccountEpoch(input,result).cleanup.allRowsVerified).toBe(true);
});
it('rejects closed override revision exhaustion without producing a partial epoch',()=>{
  const c=cases[0]!,input=inputCopy(c),identity=open(input.sources.oldIdentity.bytes);identity.prepare('UPDATE link_overrides SET revision=?').run(Number.MAX_SAFE_INTEGER);input.sources.oldIdentity=accountPin(identity.serialize());expect(()=>prepareForwardAccountEpoch(input)).toThrow('revision exceeds capacity');
});
it.each(['prepare','business','rebase'] as const)('rejects late original authority changes during %s',stage=>{
  const c=cases[0]!,input=inputCopy(c),root=join(c.s.fixtureRoot,'authority-'+stage);cpSync(input.authorityRoot,root,{recursive:true});for(const path of [root,join(root,'baseline'),join(root,'records')])chmodSync(path,0o700);input.authorityRoot=root;
  const parent=stage==='rebase'?reconstructForwardAccountBusiness(input):c.business;let calls=0;
  const boundary=()=>{if(++calls===2){const path=join(root,'authority-head.json');writeFileSync(path,Buffer.concat([readFileSync(path),Buffer.from(' ')]),{mode:0o600});}};
  expect(()=>stage==='prepare'?prepareForwardAccountEpoch(input,boundary):stage==='business'?reconstructForwardAccountBusiness(input,boundary):rebaseForwardAccountBusiness(input,parent,accountRebasedAt,boundary)).toThrow();expect(calls).toBe(2);
});
it.each(['rawMusic','cleanMusic','rawIdentity','cleanIdentity','accountBase'] as const)('rejects re-pinned account %s evidence changed outside original authority',key=>{
  const c=cases[0]!,e=epochCopy(c.business.epoch);
  if(key.endsWith('Music')){const m=JSON.parse(e[key].bytes.toString());m.data.members['10002'].note='forged';e[key]=accountPin(Buffer.from(JSON.stringify(m)));}
  else{const db=open(e[key].bytes);if(key==='accountBase')db.prepare("UPDATE events SET title='forged' WHERE id='listen'").run();else db.prepare("UPDATE used_oauth SET created=0 WHERE attempt='old-consumed'").run();e[key]=accountPin(db.serialize());}
  expect(()=>verifyForwardAccountEpoch(c.input,e)).toThrow();
});
it.each(['override-revision','override-time','open-proof','proof-rowid','closed-proof','stale-payload','private-high-water','open-owner','member-order'] as const)('rejects re-pinned cleaned account %s divergence',kind=>{
  const c=cases[0]!,e=epochCopy(c.business.epoch),db=open(e.cleanIdentity.bytes);
  if(kind==='override-revision')db.prepare('UPDATE link_overrides SET revision=9').run();
  if(kind==='override-time')db.prepare('UPDATE link_overrides SET updated=0').run();
  if(kind==='open-proof')db.prepare("DELETE FROM sessions WHERE token_hash='open-device'").run();
  if(kind==='proof-rowid')db.prepare("UPDATE sessions SET rowid=999 WHERE token_hash='open-device'").run();
  if(kind==='closed-proof')db.prepare("INSERT INTO sessions VALUES('forged',?,9999999999,'source',0)").run(c.s.accountKey);
  if(kind==='stale-payload')db.prepare("UPDATE native_profiles SET payload=json_set(payload,'$.boardUserId',?) WHERE qq='10002'").run(c.s.userId);
  if(kind==='private-high-water')db.prepare("UPDATE sqlite_sequence SET seq=999 WHERE name='link_audit'").run();
  if(kind==='open-owner')db.prepare("DELETE FROM prelinks WHERE qq='10002'").run();
  if(kind==='member-order'){const music=JSON.parse(e.cleanMusic.bytes.toString());music.data.members=Object.fromEntries(Object.entries(music.data.members).reverse());e.cleanMusic=accountPin(Buffer.from(JSON.stringify(music)));}
  e.cleanIdentity=accountPin(db.serialize());expect(()=>verifyForwardAccountEpoch(c.input,e)).toThrow();
});
it.each(['checkpoint','baselineBoard','baselineMusic','baselineIdentity','oldMusic','oldIdentity','nativeImage','nativeJournal','baselineJournal'] as const)('rejects re-pinned derived %s sources',key=>{
  const c=cases[0]!,e=epochCopy(c.business.epoch);e.sources[key]=accountPin(Buffer.from(key.includes('Journal')?'{}\n':'{}'));expect(()=>verifyForwardAccountEpoch(c.input,e)).toThrow();
});
it.each(['nativeImage','nativeJournal','retainedBusinessImage','musicSources','identitySources'] as const)('requires full account business/proof %s bytes',key=>{
  const c=cases[0]!,b=bundleCopy(c.business);b[key]=Buffer.from(b[key].length?b[key]:Buffer.from([0]));b[key][0]=b[key][0]!^1;expect(()=>verifyForwardAccountBusiness(c.input,b)).toThrow();expect(()=>rebaseForwardAccountBusiness(c.input,b,accountRebasedAt)).toThrow();
});
it.each(['run','bot-work','history','sequence','recovery','metadata','schema'] as const)('rejects independently re-pinned derived checkpoint %s changes',kind=>{
  const c=cases[0]!,e=epochCopy(c.business.epoch),db=open(e.sources.checkpoint.bytes);
  if(kind==='run')db.prepare("UPDATE migration_runs SET manifest_json='{}' WHERE source_digest=?").run(verifyForwardAccountEpoch(c.input,c.business.epoch).sourceDigest);
  if(kind==='bot-work')db.prepare("UPDATE bot_outbox SET retry_at='forged' WHERE status='failed'").run();
  if(kind==='history'){const sql=(db.prepare("SELECT sql FROM sqlite_master WHERE name='music_audit_no_update'").get() as {sql:string}).sql;db.exec('DROP TRIGGER music_audit_no_update');db.prepare("UPDATE music_profile_audit SET after_json='{}'").run();db.exec(sql);}
  if(kind==='sequence')db.prepare("UPDATE sqlite_sequence SET seq=999 WHERE name='bot_outbox'").run();
  if(kind==='recovery'){const sql=(db.prepare("SELECT sql FROM sqlite_master WHERE name='rebuild_storage_no_update'").get() as {sql:string}).sql;db.exec('DROP TRIGGER rebuild_storage_no_update');db.prepare('UPDATE rebuild_storage SET recovery_required=0').run();db.exec(sql);}
  if(kind==='metadata')db.pragma('application_id=999');if(kind==='schema')db.exec('CREATE TABLE forged(value TEXT)');
  e.sources.checkpoint=accountPin(db.serialize());e.sources.nativeImage=accountPin(e.sources.checkpoint.bytes);expect(()=>verifyForwardAccountEpoch(c.input,e)).toThrow();
});
it.each(['closure','closure-time','private-restore','audit-history','identity-sequence','source-pin','member-conflict'] as const)('rejects original source %s divergence',kind=>{
  const c=cases[0]!,input=inputCopy(c);
  if(['closure','closure-time','private-restore'].includes(kind)){const db=open(input.sources.oldBoard.bytes);if(kind==='closure')db.prepare('DELETE FROM privacy_requests WHERE user_id=?').run(c.s.userId);if(kind==='closure-time')db.prepare("UPDATE privacy_requests SET created_at='2026-11-20T04:00:00Z' WHERE user_id=?").run(c.s.userId);if(kind==='private-restore')db.prepare("INSERT INTO request_results VALUES(?,'forged','signature','{}',200,'synthetic')").run(c.s.userId);input.sources.oldBoard=accountPin(db.serialize());}
  if(['audit-history','identity-sequence'].includes(kind)){const db=open(input.sources.oldIdentity.bytes);if(kind==='audit-history')db.prepare("UPDATE link_audit SET actor='forged' WHERE id=1").run();else db.prepare("UPDATE sqlite_sequence SET seq=0 WHERE name='link_audit'").run();input.sources.oldIdentity=accountPin(db.serialize());}
  if(kind==='source-pin')input.sources.oldMusic.sha256='0'.repeat(64);
  if(kind==='member-conflict'){const db=open(input.sources.nativeImage.bytes);db.prepare("INSERT INTO music_profile_fields SELECT id,'bob','opposed native note',123,'',0,0,'synthetic' FROM music_profiles WHERE user_id='bob' ON CONFLICT(profile_id) DO UPDATE SET note=excluded.note").run();input.sources.nativeImage=accountPin(db.serialize());}
  expect(()=>reconstructForwardAccountBusiness(input)).toThrow();
});
it.each(['nativeImage','nativeJournal','retainedProofImage','retainedBusinessImage','musicSources','identitySources','retainedAccountInput','retainedAccountParent'] as const)('requires complete final account rebase %s retention',key=>{
  const c=cases[0]!,b={...c.rebased};
  if(key==='retainedAccountInput'){b.retainedAccountInput=inputCopy(c);b.retainedAccountInput.sources.oldMusic=accountPin(Buffer.from('{}'));}
  else if(key==='retainedAccountParent'){b.retainedAccountParent=bundleCopy(c.business);b.retainedAccountParent.epoch.cleanMusic=accountPin(Buffer.from('{}'));}
  else b[key]=Buffer.from([0]);
  expect(()=>verifyForwardAccountRebase(c.input,c.business,accountRebasedAt,b)).toThrow();
});
it.each(['prepare','business','rebase'] as const)('rejects early, late and asynchronous %s boundaries without output',stage=>{
  const c=cases[0]!;
  for(const at of [1,2]){const input=inputCopy(c),parent=bundleCopy(c.business);let calls=0;const boundary=()=>{if(++calls===at)input.sources.oldMusic.bytes[0]=input.sources.oldMusic.bytes[0]!^1;};
    expect(()=>stage==='prepare'?prepareForwardAccountEpoch(input,boundary):stage==='business'?reconstructForwardAccountBusiness(input,boundary):rebaseForwardAccountBusiness(input,parent,accountRebasedAt,boundary)).toThrow();expect(calls).toBe(at);
  }
  const asyncBoundary=(()=>Promise.resolve()) as unknown as ()=>void;
  expect(()=>stage==='prepare'?prepareForwardAccountEpoch(c.input,asyncBoundary):stage==='business'?reconstructForwardAccountBusiness(c.input,asyncBoundary):rebaseForwardAccountBusiness(c.input,c.business,accountRebasedAt,asyncBoundary)).toThrow('synchronous');
});
it('rejects a late parent mutation and operation times out of order',()=>{
  const c=cases[0]!,parent=bundleCopy(c.business);let calls=0;expect(()=>rebaseForwardAccountBusiness(c.input,parent,accountRebasedAt,()=>{if(++calls===2)parent.epoch.rawIdentity.bytes[0]=0;})).toThrow('epoch changed');expect(calls).toBe(2);
  expect(()=>reconstructForwardAccountBusiness({...c.input,reconciledAt:c.input.preparedAt})).toThrow('out of order');expect(()=>rebaseForwardAccountBusiness(c.input,c.business,c.input.preparedAt)).toThrow('predates');
});
it('retains independent source buffers and deterministically reconstructs the original account parent',()=>{
  const c=cases[0]!,input=inputCopy(c),parent=bundleCopy(c.business),a=rebaseForwardAccountBusiness(input,parent,accountRebasedAt);expect(a.nativeImage).toEqual(c.rebased.nativeImage);expect(a.report).toEqual(c.rebased.report);expect(a.retainedAccountParent.nativeImage).not.toBe(parent.nativeImage);
  input.sources.oldMusic.bytes[0]=0;parent.nativeImage[0]=0;expect(a.retainedAccountInput.sources.oldMusic.bytes).toEqual(c.input.sources.oldMusic.bytes);expect(a.retainedAccountParent.nativeImage).toEqual(c.business.nativeImage);
});
it('independently checks complete private sources, retained epochs and final bot states with readonly Python',()=>{
  const c=cases[0]!,root=join(c.s.fixtureRoot,'account-python-oracle');mkdirSync(root,{mode:0o700});
  for(const [name,bytes] of [['original',c.input.sources.nativeImage.bytes],['board',c.input.sources.oldBoard.bytes],['raw',c.business.epoch.rawIdentity.bytes],['clean',c.business.epoch.cleanIdentity.bytes],['business',c.business.retainedBusinessImage],['proof',c.business.nativeImage],['final',c.rebased.nativeImage]] as const)writeFileSync(join(root,name+'.sqlite3'),bytes,{mode:0o600});
  for(const [name,row] of Object.entries(c.rebased.retainedAccountInput.sources))expect(row.sha256).toBe(forwardHash(c.input.sources[name as keyof typeof c.input.sources].bytes));
  const result=JSON.parse(execFileSync('python3',['-c',`import json,sqlite3,sys
from pathlib import Path
from contextlib import ExitStack,closing
root=Path(sys.argv[1]);uid=sys.argv[2];key=sys.argv[3]
with ExitStack() as stack:
 dbs={name:stack.enter_context(closing(sqlite3.connect((root/(name+'.sqlite3')).as_uri()+'?mode=ro',uri=True))) for name in ('original','board','raw','clean','business','proof','final')}
 def rows(db,table):
  columns=[r[1] for r in db.execute('PRAGMA table_xinfo("'+table+'")')]
  return list(db.execute('SELECT rowid,*,'+','.join('typeof("'+name+'")' for name in columns)+' FROM "'+table+'" ORDER BY rowid'))
 final=dbs['final'];assert final.execute('PRAGMA integrity_check').fetchone()==('ok',) and not final.execute('PRAGMA foreign_key_check').fetchall()
 for name in ('bot_outbox','bot_settings_history','bot_runtime'):
  assert rows(final,name)==rows(dbs['board'],name)==rows(dbs['proof'],name),name
 for name in ('music_profile_audit','music_ownership_history'):assert rows(final,name)==rows(dbs['original'],name),name
 for name in ('used_oauth','link_audit','login_attempts','profile_contacts','sqlite_sequence'):assert rows(dbs['raw'],name)==rows(dbs['clean'],name),name
 assert dbs['clean'].execute('SELECT user_id,revision,typeof(updated) FROM link_overrides WHERE qq=?',(key,)).fetchone()==('',8,'real')
 assert dbs['clean'].execute('SELECT rowid,token_hash FROM sessions').fetchall()==[(42,'open-device')]
 assert dbs['clean'].execute('SELECT rowid,token_hash FROM entry_intents').fetchall()==[(53,'open-device')]
 assert final.execute('SELECT count(*) FROM music_profile_receipts WHERE user_id=?',(uid,)).fetchone()==(0,)
 assert final.execute('SELECT recovery_required FROM rebuild_storage').fetchone()==(1,)
 assert final.execute('SELECT count(*) FROM migration_runs').fetchone()[0]>dbs['original'].execute('SELECT count(*) FROM migration_runs').fetchone()[0]
 print(json.dumps(dict(allBotRowsExact=True,originalHistoriesExact=True,sourcePrivateTypesExact=True,closedReceiptsRemoved=True,recoveryBlocked=True)))`,root,c.s.userId,c.s.accountKey],{encoding:'utf8',timeout:10000}));
  expect(result).toEqual({allBotRowsExact:true,originalHistoriesExact:true,sourcePrivateTypesExact:true,closedReceiptsRemoved:true,recoveryBlocked:true});
});
