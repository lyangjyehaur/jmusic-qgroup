import Database from 'better-sqlite3';
import {afterEach,expect,it} from 'vitest';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import type {DB} from '@qgroup/database';
import {assertDatabaseUsable} from '@qgroup/database';
import {forwardBoardAccountFixture} from '../testsupport/forward-board-account-fixture';
import {proofPin} from '../testsupport/forward-proof-fixture';
import {mergeForwardBoardAccountClosures} from '../../../tools/migration/forward-board-account-merge';
import {verifyForwardBoardAccountClosures} from '../../../tools/migration/forward-board-account-reconciliation';
import {mergeForwardBoard} from '../../../tools/migration/forward-board-merge';
import {forwardRows,forwardEqual} from '../../../tools/migration/forward-board-storage';
import {projectRollbackStateFromCheckpoint} from '../../../tools/migration/rollback-state';
import {decodeErasureJournal,readVerifiedErasureJournal} from './erasure-journal';

const cleanup:(()=>void)[]=[];afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();});
const rows=(db:DB,table:string)=>[...forwardRows(db,table)];
function open(bytes:Buffer){const db=new Database(bytes);db.pragma('foreign_keys=ON');cleanup.push(()=>db.close());return db;}
async function setup(user:'claimant'|'fresh-native'='claimant'){const s=await forwardBoardAccountFixture(user);cleanup.push(()=>s.close());return s;}
function alter(s:Awaited<ReturnType<typeof setup>>,name:keyof typeof s.input.sources,change:(db:DB)=>void){const db=open(s.input.sources[name].bytes);db.pragma('foreign_keys=OFF');change(db);s.input.sources[name]=proofPin(db.serialize());}

it.each(['claimant','fresh-native'] as const)('merges actual old Python closure and real native selection/fields receipts for %s with all histories and bot states retained',async user=>{
  const s=await setup(user),input=s.input,before=Object.values(input.sources).map(item=>Buffer.from(item.bytes)),head=readFileSync(join(input.authorityRoot,'authority-head.json'));
  const native=open(input.sources.nativeImage.bytes),old=open(input.sources.oldBoard.bytes);
  for(const key of s.receiptKeys){expect(native.prepare('SELECT profile_id FROM music_profile_receipts WHERE user_id=? AND request_key=?').get(user,key)).toEqual({profile_id:s.profileId});expect(old.prepare('SELECT 1 FROM request_results WHERE user_id=? AND request_key=?').get(user,key)).toBeUndefined();}
  expect(()=>mergeForwardBoard(input.sources)).toThrow('cross-domain reference reconciliation');
  const result=mergeForwardBoardAccountClosures(input),db=open(result.nativeImage),again=mergeForwardBoardAccountClosures(input),repeat=open(again.nativeImage);
  expect(result.report).toMatchObject({boardAccountOnly:true,recoveryRequired:true,releaseEligible:false,reconciliation:{allRowsVerified:true,references:{originalClosures:1},account:{accountClosures:1}}});
  expect(result.report.reconciliation.references.pendingAccountReceiptReferences).toBeGreaterThanOrEqual(2);
  expect(verifyForwardBoardAccountClosures(input,result.nativeImage)).toEqual(result.report.reconciliation);
  expect(Object.values(input.sources).map(item=>item.bytes)).toEqual(before);expect(readFileSync(join(input.authorityRoot,'authority-head.json'))).toEqual(head);
  expect(rows(db,'privacy_requests')).toEqual(rows(old,'privacy_requests'));expect(db.prepare('SELECT id,status FROM privacy_requests WHERE user_id=?').get(user)).toEqual({id:s.closure.request_id,status:s.closure.status});
  expect(db.prepare('SELECT 1 FROM privacy_receipts WHERE request_id=?').get(s.closure.request_id)).toBeUndefined();
  for(const table of ['music_profile_audit','music_field_history','music_ownership_history','music_profile_creation','bot_outbox','bot_settings','bot_settings_history','bot_runtime','events','settlement_history','finance_entries','migration_runs','sqlite_sequence'])expect(rows(db,table),table).toEqual(rows(native,table));
  for(const table of ['browser_sessions','browser_accounts','external_identities','request_results','music_profile_receipts','music_claim_intents']){
    const column=table==='music_claim_intents'?'target_user_id':'user_id';expect(db.prepare('SELECT 1 FROM '+table+' WHERE '+column+'=?').get(user),table).toBeUndefined();
  }
  expect(db.prepare('SELECT user_id,erased_at FROM music_profiles WHERE id=?').get(s.profileId)).toEqual({user_id:null,erased_at:null});expect(()=>assertDatabaseUsable(db)).toThrow('offline review');
  for(const table of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[])expect(rows(repeat,table.name),table.name).toEqual(rows(db,table.name));
  const journal=decodeErasureJournal(result.nativeJournal.toString());readVerifiedErasureJournal(db,{read:()=>journal,append(){throw Error('Read-only test journal');}});
  const state=projectRollbackStateFromCheckpoint(result.nativeImage,journal);expect(state.music.keys.find(row=>row.profileId===s.profileId)).toEqual(s.state.music.keys.find(row=>row.profileId===s.profileId));expect(state.identityAuditMappings).toEqual(s.state.identityAuditMappings);
  const root=join(s.fixtureRoot,'account-reference-oracle');mkdirSync(root,{mode:0o700});
  for(const [name,bytes] of [['native.sqlite3',input.sources.nativeImage.bytes],['old.sqlite3',input.sources.oldBoard.bytes],['candidate.sqlite3',result.nativeImage],['repeat.sqlite3',again.nativeImage],['journal.jsonl',result.nativeJournal]] as const)writeFileSync(join(root,name),bytes,{mode:0o600});
  const oracle=JSON.parse(execFileSync('python3',['-c',`import hashlib,json,sqlite3,sys
from pathlib import Path
from contextlib import ExitStack,closing
root=Path(sys.argv[1]);uid=sys.argv[2];profile=sys.argv[3];keys=json.loads(sys.argv[4])
with ExitStack() as stack:
 dbs={name:stack.enter_context(closing(sqlite3.connect((root/(name+'.sqlite3')).as_uri()+'?mode=ro',uri=True))) for name in ['native','old','candidate','repeat']};native,old,candidate,repeat=[dbs[n] for n in dbs]
 for db in dbs.values():assert db.execute('PRAGMA integrity_check').fetchone()==('ok',) and not db.execute('PRAGMA foreign_key_check').fetchall()
 tables=[row[0] for row in candidate.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
 def rows(db,table):
  columns=[r[1] for r in db.execute('PRAGMA table_xinfo("'+table+'")')]
  return db.execute('SELECT rowid,*,'+','.join('typeof("'+c+'")' for c in columns)+' FROM "'+table+'" ORDER BY rowid').fetchall()
 for table in tables:assert rows(candidate,table)==rows(repeat,table),table
 for table in ['privacy_requests']:assert rows(candidate,table)==rows(old,table),table
 for table in ['music_profile_audit','music_field_history','music_ownership_history','music_profile_creation','bot_outbox','bot_settings','bot_settings_history','bot_runtime','events','settlement_history','finance_entries','migration_runs','sqlite_sequence']:assert rows(candidate,table)==rows(native,table),table
 for key in keys:
  assert native.execute('SELECT profile_id FROM music_profile_receipts WHERE user_id=? AND request_key=?',(uid,key)).fetchone()==(profile,)
  assert native.execute('SELECT response_status FROM request_results WHERE user_id=? AND request_key=?',(uid,key)).fetchone()==(200,)
  assert not old.execute('SELECT 1 FROM request_results WHERE user_id=? AND request_key=?',(uid,key)).fetchall()
  assert not candidate.execute('SELECT 1 FROM music_profile_receipts WHERE user_id=? AND request_key=?',(uid,key)).fetchall()
 for table in ['music_profile_receipts','request_results']:
  assert candidate.execute('SELECT rowid,* FROM '+table+' WHERE user_id<>? ORDER BY rowid',(uid,)).fetchall()==native.execute('SELECT rowid,* FROM '+table+' WHERE user_id<>? ORDER BY rowid',(uid,)).fetchall(),table
 request=candidate.execute('SELECT id,created_at FROM privacy_requests WHERE user_id=?',(uid,)).fetchone();journal=[json.loads(r) for r in (root/'journal.jsonl').read_text().splitlines()];assert any(r.get('user_id')==uid and r.get('request_id')==request[0] and r.get('created_at')==request[1] for r in journal)
 token='erased-account-v1:'+hashlib.sha256(json.dumps([uid,request[0]],separators=(',',':')).encode()).hexdigest();assert candidate.execute('SELECT token_hash FROM users WHERE id=?',(uid,)).fetchone()==(token,)
 assert not candidate.execute('SELECT 1 FROM privacy_receipts WHERE request_id=?',(request[0],)).fetchall();assert candidate.execute('SELECT user_id,erased_at FROM music_profiles WHERE id=?',(profile,)).fetchone()==(None,None)
 print(json.dumps(dict(realNativeReceipts=len(keys),originalClosure=True,allTablesRepeatStorageExact=len(tables),botAndHistoryExact=True,otherAccountReceiptsExact=True)))`,root,user,s.profileId,JSON.stringify(s.receiptKeys)],{encoding:'utf8',timeout:10000}));
  expect(oracle).toMatchObject({realNativeReceipts:2,originalClosure:true,botAndHistoryExact:true,otherAccountReceiptsExact:true});
});

it.each(['missing closure','unrecorded closure','wrong closure time','wrong account','restored old private results','open user orphan','native orphan','native profile orphan','unrelated orphan','rewound sequence','changed history','wrong schema','wrong authority checkpoint','wrong native journal'] as const)('rejects unproven original source: %s',async kind=>{
  const s=await setup();
  if(kind==='missing closure')alter(s,'oldBoard',db=>db.prepare('DELETE FROM privacy_requests WHERE user_id=?').run(s.userId));
  if(kind==='unrecorded closure')alter(s,'oldBoard',db=>db.prepare("INSERT INTO privacy_requests(id,user_id,status,created_at,updated_at) VALUES('unrecorded','claimant2','completed','synthetic','synthetic')").run());
  if(kind==='wrong closure time')alter(s,'oldBoard',db=>db.prepare("UPDATE privacy_requests SET created_at='changed' WHERE user_id=?").run(s.userId));
  if(kind==='wrong account')alter(s,'oldBoard',db=>db.prepare("UPDATE privacy_requests SET user_id='claimant2' WHERE user_id=?").run(s.userId));
  if(kind==='restored old private results')alter(s,'oldBoard',db=>db.prepare('INSERT INTO request_results VALUES(?,?,?,?,200,?)').run(s.userId,'restored','signature','{}','synthetic'));
  if(kind==='open user orphan')alter(s,'oldBoard',db=>db.prepare("DELETE FROM request_results WHERE user_id='alice'").run());
  if(kind==='native orphan')alter(s,'nativeImage',db=>db.prepare('DELETE FROM request_results WHERE user_id=?').run(s.userId));
  if(kind==='native profile orphan')alter(s,'nativeImage',db=>db.prepare("UPDATE music_profile_receipts SET profile_id='missing'").run());
  if(kind==='unrelated orphan')alter(s,'oldBoard',db=>{db.prepare("DELETE FROM browser_accounts WHERE user_id='contact-owner'").run();db.prepare("DELETE FROM browser_sessions WHERE user_id='contact-owner'").run();db.prepare("DELETE FROM users WHERE id='contact-owner'").run();expect(db.pragma('foreign_key_check')).toEqual([]);});
  if(kind==='rewound sequence')alter(s,'oldBoard',db=>db.prepare("UPDATE sqlite_sequence SET seq=0 WHERE name='bot_outbox'").run());
  if(kind==='changed history')alter(s,'nativeImage',db=>{const sql=(db.prepare("SELECT sql FROM sqlite_master WHERE name='music_audit_no_update'").get() as {sql:string}).sql;db.exec('DROP TRIGGER music_audit_no_update');db.prepare("UPDATE music_profile_audit SET after_json='{}'").run();db.exec(sql);});
  if(kind==='wrong schema')alter(s,'nativeImage',db=>db.exec('CREATE TABLE unexpected(value TEXT)'));
  if(kind==='wrong authority checkpoint')s.input.sources.checkpoint=s.input.sources.nativeImage=proofPin(s.base.checkpointImage);
  if(kind==='wrong native journal')s.input.sources.nativeJournal=proofPin(Buffer.from('\n'));
  const before=Object.values(s.input.sources).map(row=>Buffer.from(row.bytes));
  // Some exact-schema/history checks run at ordinary source opening; all fail
  // before a repaired image or replacement receipt can leave the stage.
  expect(()=>mergeForwardBoardAccountClosures(s.input)).toThrow();expect(Object.values(s.input.sources).map(row=>row.bytes)).toEqual(before);
});

it.each(['original review','open account receipt','restored closed receipt','bot payload','history','sequence','recovery','token','owner','extra marker','metadata'] as const)('independently rejects a re-pinned final candidate with altered %s',async kind=>{
  const s=await setup(),result=mergeForwardBoardAccountClosures(s.input),db=open(result.nativeImage);db.pragma('foreign_keys=OFF');
  if(kind==='original review')db.prepare("UPDATE privacy_requests SET note='forged review'").run();
  if(kind==='open account receipt')db.prepare("DELETE FROM music_profile_receipts WHERE user_id='alice'").run();
  if(kind==='restored closed receipt')db.prepare('INSERT INTO music_profile_receipts VALUES(?,?,?)').run(s.userId,s.receiptKeys[0]!,s.profileId);
  if(kind==='bot payload')db.prepare("UPDATE bot_outbox SET delivered_payload_json='forged' WHERE status='sent'").run();
  if(kind==='history'){db.exec('DROP TRIGGER music_audit_no_update');db.prepare("UPDATE music_profile_audit SET after_json='{}'").run();}
  if(kind==='sequence')db.prepare("UPDATE sqlite_sequence SET seq=999 WHERE name='music_profile_audit'").run();
  if(kind==='recovery'){db.exec('DROP TRIGGER rebuild_storage_no_update');db.prepare('UPDATE rebuild_storage SET recovery_required=0').run();}
  if(kind==='token')db.prepare('UPDATE users SET token_hash=? WHERE id=?').run('f'.repeat(64),s.userId);
  if(kind==='owner')db.prepare('UPDATE music_profiles SET user_id=? WHERE id=?').run(s.userId,s.profileId);
  if(kind==='extra marker')db.prepare("INSERT INTO erasure_applied VALUES('forged')").run();
  if(kind==='metadata')db.pragma('application_id=888');
  expect(()=>verifyForwardBoardAccountClosures(s.input,proofPin(db.serialize()).bytes)).toThrow();
});

it.each(['early bytes','late bytes','late pin','async','authority identity'] as const)('rejects mutation at the boundary: %s',async kind=>{
  const s=await setup();let calls=0;const boundary=()=>{
    ++calls;if(kind==='async')return Promise.resolve();if(kind==='authority identity'){s.input.manifestSha256='e'.repeat(64);return;}
    if(kind==='early bytes'&&calls===1||kind==='late bytes'&&calls===2)s.input.sources.oldBoard.bytes[100]=s.input.sources.oldBoard.bytes[100]!^1;
    if(kind==='late pin'&&calls===2)s.input.sources.oldBoard.sha256='f'.repeat(64);
  };
  expect(()=>mergeForwardBoardAccountClosures(s.input,boundary)).toThrow();expect(calls).toBe(kind==='late bytes'||kind==='late pin'?2:1);
});

it('retains independent old/native business changes along with the original closure and refuses opposed changes',async()=>{
  const s=await setup();alter(s,'oldBoard',db=>db.prepare("UPDATE events SET title='old title' WHERE id='listen'").run());alter(s,'nativeImage',db=>db.prepare("UPDATE events SET description='native description' WHERE id='karaoke'").run());
  const db=open(mergeForwardBoardAccountClosures(s.input).nativeImage);expect(db.prepare("SELECT title FROM events WHERE id='listen'").get()).toEqual({title:'old title'});expect(db.prepare("SELECT description FROM events WHERE id='karaoke'").get()).toEqual({description:'native description'});
  alter(s,'nativeImage',db=>db.prepare("UPDATE events SET title='opposed title' WHERE id='listen'").run());expect(()=>mergeForwardBoardAccountClosures(s.input)).toThrow('row conflict');
});

it('keeps complete account-reference output logically deterministic',async()=>{
  const s=await setup(),a=mergeForwardBoardAccountClosures(s.input),b=mergeForwardBoardAccountClosures(s.input);expect(forwardEqual(a.report,b.report)).toBe(true);expect(a.nativeJournal).toEqual(b.nativeJournal);
});
