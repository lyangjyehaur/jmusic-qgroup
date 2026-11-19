import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {openDatabase,assertDatabaseUsable,type DB} from '@qgroup/database';
import {afterEach,it,expect} from 'vitest';
import {fixture} from '../testsupport/fixture';
import {saveProfile} from './repositories';
import {createPrivacy} from './privacy';
import {hash} from './security';
import {erasureJournal,type ErasureIntent} from './erasure-journal';
import {captureRollbackCheckpoint} from '../../../tools/migration/rollback-checkpoint';
import {projectRollbackBoard} from '../../../tools/migration/rollback-board';
import {mergeForwardBoard} from '../../../tools/migration/forward-board-merge';
import {verifyForwardBoardMerge} from '../../../tools/migration/forward-board-reconciliation';
import {forwardHash,forwardCanonical,type ForwardBoardInput} from '../../../tools/migration/forward-board-storage';

const cleanup:(()=>void)[]=[];afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();});
const stamp=new Date('2026-11-20T01:00:00Z');
const pin=(bytes:Buffer)=>({bytes:Buffer.from(bytes),sha256:forwardHash(bytes)});
function setup(options:{baselineErasure?:boolean;musicReceipt?:boolean}={}){
  const native=openDatabase(':memory:');cleanup.push(()=>native.close());fixture(native);native.pragma('user_version=42');native.pragma('application_id=12345');const journal=erasureJournal(native);
  const profile=saveProfile(native,'alice',{profileId:null,revision:0,musicEpoch:0,selections:[{entryId:'sub-0',level:4}]},stamp);
  if(options.musicReceipt){native.prepare("INSERT INTO request_results VALUES('alice','synthetic-music-save','synthetic',?,200,'before')").run(JSON.stringify({id:profile.id}));native.prepare("INSERT INTO music_profile_receipts VALUES('alice','synthetic-music-save',?)").run(profile.id);}
  native.prepare("INSERT INTO notifications(id,user_id,event_id,kind,message,created_at,read_at) VALUES(-7,'bob','listen','synthetic',?,'before',NULL)").run(Buffer.from('same'));
  native.prepare("INSERT INTO settlement_history(event_id,version,total_cents,headcount,note,qr_image,updated_at,actor_id,actor_name,kind,changed_fields) VALUES('listen',1,-101,3,'保留原帳單',?,'unknown-zone','alice','原名字','full','[]')").run(Buffer.from([0,1,255]));
  for(const [index,status] of ['pending','sending','sent','failed','skipped'].entries())native.prepare("INSERT INTO bot_outbox(event_id,kind,dedupe_key,target,payload_json,status,claim_token,retry_at,simulated_at,delivered_payload_json,created_at) VALUES('listen','synthetic',?,'synthetic-group','{}',?,?,?,?,?,'before')").run('forward-'+index,status,status==='sending'?'original-unconfirmed':'',status==='failed'?'future-retry':null,status==='skipped'?'original-simulation':null,status==='sent'?'original-delivered-body':null);
  if(options.baselineErasure){const profile=saveProfile(native,'bob',{profileId:null,revision:0,musicEpoch:0,selections:[]},stamp),privacy=createPrivacy(native,journal),intent:ErasureIntent={version:1,kind:'both',userId:'bob',profileId:profile.id,requestId:randomUUID(),createdAt:stamp.toISOString(),secretHash:hash('synthetic-secret'),signature:hash('synthetic-signature')};native.transaction(()=>privacy.submit(intent)).immediate();privacy.guard();}
  const checkpoint=captureRollbackCheckpoint(native,journal),baseline=projectRollbackBoard(native);cleanup.push(()=>baseline.db.close());const baselineBytes=baseline.db.serialize(),old=new Database(baselineBytes);cleanup.push(()=>old.close());
  function input():ForwardBoardInput{return {checkpoint:pin(checkpoint.image),baselineBoard:pin(baselineBytes),baselineJournal:pin(Buffer.from(checkpoint.journal.map(row=>JSON.stringify(row)+'\n').join(''))),nativeImage:pin(captureRollbackCheckpoint(native,journal).image),nativeJournal:pin(Buffer.from(journal.read().map(row=>JSON.stringify(row)+'\n').join(''))),oldBoard:pin(old.serialize())};}
  return {native,old,journal,profile,input};
}
function open(bytes:Buffer){const db=new Database(bytes);cleanup.push(()=>db.close());return db;}
function rows(db:DB,table:string){return db.prepare(`SELECT rowid,* FROM "${table}" ORDER BY rowid`).safeIntegers(true).all();}
function alter(input:ForwardBoardInput,name:'nativeImage'|'oldBoard'|'baselineBoard'|'checkpoint',change:(db:DB)=>void){const db=new Database(input[name].bytes);try{change(db);input[name]=pin(db.serialize());}finally{db.close();}}

it('merges real Python activity/roster/broadcast creation with native-only music changes and retains old finance/history and all five delivery states',()=>{
  const s=setup();saveProfile(s.native,'alice',{profileId:s.profile.id,revision:1,musicEpoch:0,selections:[{entryId:'sub-1',level:2}]},stamp);
  const folder=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'qgroup-forward-board-')));cleanup.push(()=>fs.rmSync(folder,{recursive:true,force:true}));const path=join(folder,'old.sqlite3');fs.writeFileSync(path,s.old.serialize(),{mode:0o600});
  const result=JSON.parse(execFileSync('python3',['-c',`import json,sqlite3,sys
from qgroup_core import events
with sqlite3.connect(sys.argv[1]) as db:
 db.row_factory=sqlite3.Row
 db.execute("UPDATE bot_settings SET config_json=?",(json.dumps(dict(enabled=True,groups=[dict(id='synthetic-group',name='合成群',replies=True,broadcast=True)])),))
 user=db.execute("SELECT * FROM users WHERE id='alice'").fetchone()
 event=events.create(db,user,dict(title='舊站新增活動',category='约K',location='合成地點',starts_at='2099-12-12T06:00:00+00:00',deadline='2099-12-11T06:00:00+00:00',capacity=8,description='原活動內容',duration_hours=3,timezone='Asia/Taipei',visibility='public',bot_enabled=True,join_owner=True))
 db.execute("INSERT INTO finance_entries(id,event_id,kind,payload_json,occurred_at,actor_id,actor_name,created_at) VALUES('old-money',?,'expense','{\\"amount_cents\\":-103}','unknown-zone','alice','原帳本名字','after')",(event,))
 count=db.execute('SELECT count(*) FROM bot_outbox WHERE event_id=?',(event,)).fetchone()[0]
 assert count>0
 print(json.dumps(dict(event=event,work=count)))`,path],{encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH,PYTHONPATH:process.cwd(),KANBAN_BOT_BASE_URL:'https://rebuild.example',KANBAN_BOT_ENABLED:'1'}}));
  const input=s.input();input.oldBoard=pin(fs.readFileSync(path));const beforeNative=Buffer.from(input.nativeImage.bytes),beforeOld=Buffer.from(input.oldBoard.bytes),merged=mergeForwardBoard(input),db=open(merged.nativeImage),old=open(input.oldBoard.bytes);
  for(const table of ['events','roster_parties','attendees','attendee_consents','event_roles','event_audit','finance_entries','settlement_history','bot_outbox','bot_settings','bot_settings_history','bot_runtime'])expect(rows(db,table),table).toEqual(rows(old,table));
  for(const table of ['music_profiles','music_selections','music_profile_audit','music_profile_fields','music_profile_receipts','music_account_epochs','music_entries','migration_map','privacy_receipts','erasure_applied'])expect(rows(db,table),table).toEqual(rows(s.native,table));
  expect(db.prepare('SELECT title FROM events WHERE id=?').get(result.event)).toEqual({title:'舊站新增活動'});expect(db.prepare('SELECT count(*) n FROM bot_outbox WHERE event_id=?').get(result.event)).toEqual({n:result.work});expect(merged.nativeJournal).toEqual(input.nativeJournal.bytes);expect(input.nativeImage.bytes).toEqual(beforeNative);expect(input.oldBoard.bytes).toEqual(beforeOld);expect(merged.report).toMatchObject({boardOnly:true,recoveryRequired:true,releaseEligible:false,rollbackEligible:false});expect(()=>assertDatabaseUsable(db)).toThrow('offline review');expect(verifyForwardBoardMerge(input,merged.nativeImage).rowsDigest).toBe(merged.report.reconciliation.rowsDigest);
});
it('keeps native-only board changes, copies old inserts/updates/deletes, coalesces identical concurrent rows, and preserves metadata and sequence maxima',()=>{
  const s=setup();s.native.prepare("UPDATE events SET description='native-only-change' WHERE id='karaoke'").run();s.old.prepare("UPDATE events SET title='old-change' WHERE id='listen'").run();s.native.prepare("UPDATE users SET nickname='same-change' WHERE id='alice'").run();s.old.prepare("UPDATE users SET nickname='same-change' WHERE id='alice'").run();s.old.prepare('DELETE FROM notifications WHERE id=-7').run();s.old.prepare("INSERT INTO admin_audit(id,action,before_value,after_value,created_at) VALUES(?,'old',1.25,4,'unknown-zone')").run(9007199254740993n);s.old.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES('finance_reports',?)").run(9223372036854775807n);s.old.pragma('application_id=333');
  const input=s.input(),merged=mergeForwardBoard(input),db=open(merged.nativeImage);expect(db.prepare("SELECT title FROM events WHERE id='listen'").get()).toEqual({title:'old-change'});expect(db.prepare("SELECT description FROM events WHERE id='karaoke'").get()).toEqual({description:'native-only-change'});expect(db.prepare('SELECT 1 FROM notifications').get()).toBeUndefined();expect(db.prepare('SELECT id,before_value,typeof(before_value) storage FROM admin_audit').safeIntegers(true).get()).toEqual({id:9007199254740993n,before_value:1.25,storage:'real'});expect(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='finance_reports'").safeIntegers(true).get()).toEqual({seq:9223372036854775807n});expect(db.pragma('user_version',{simple:true})).toBe(42);expect(db.pragma('application_id',{simple:true})).toBe(333);expect(merged.report.decisions.users?.coalesced).toBe(1);verifyForwardBoardMerge(input,merged.nativeImage);
});
it('supports a valid old UNIQUE-value exchange without imposing transient insert order, and restores native append-only and read-only triggers',()=>{
  const s=setup(),tokens=s.old.prepare('SELECT id,token_hash FROM users ORDER BY id').all() as {id:string;token_hash:string}[];s.old.prepare("UPDATE users SET token_hash='temporary' WHERE id='alice'").run();s.old.prepare("UPDATE users SET token_hash=? WHERE id='bob'").run(tokens[0]!.token_hash);s.old.prepare("UPDATE users SET token_hash=? WHERE id='alice'").run(tokens[1]!.token_hash);const db=open(mergeForwardBoard(s.input()).nativeImage);expect(rows(db,'users')).toEqual(rows(s.old,'users'));expect(()=>db.prepare("UPDATE settlement_history SET note='lost-history'").run()).toThrow('append-only');expect(()=>db.prepare("INSERT INTO registrations(event_id,user_id,note,created_at) VALUES('listen','alice','','now')").run()).toThrow('read-only');expect(()=>db.prepare('UPDATE rebuild_storage SET recovery_required=0').run()).toThrow('immutable');
});
it('preserves exact negative rowids, BLOB/text/null storage and semantic replay, without inventing audits, receipts, mappings or new bot work',()=>{
  const s=setup();s.old.prepare('UPDATE notifications SET id=-8').run();s.old.prepare("INSERT INTO notifications(id,user_id,event_id,kind,message,created_at,read_at) VALUES(-9,'alice','listen','synthetic','same','opaque-time',NULL)").run();const input=s.input(),first=mergeForwardBoard(input),next={...input,nativeImage:pin(first.nativeImage)},second=mergeForwardBoard(next),a=open(first.nativeImage),b=open(second.nativeImage);for(const table of ['notifications','bot_outbox','settlement_history','privacy_receipts','erasure_applied','migration_map','music_profile_audit','events'])expect(rows(b,table),table).toEqual(rows(a,table));expect(b.prepare('SELECT id,typeof(message) storage,read_at FROM notifications ORDER BY id').all()).toEqual([{id:-9,storage:'text',read_at:null},{id:-8,storage:'blob',read_at:null}]);expect(first.report.reconciliation.rowsDigest).toBe(second.report.reconciliation.rowsDigest);expect(first.nativeJournal).toEqual(second.nativeJournal);
});
it.each(['row','delete vs update','update vs delete','rowid collision','primary key collision','metadata','storage'])('rejects a divergent %s without changing any supplied source',change=>{
  const s=setup();
  if(change==='row'){s.native.prepare("UPDATE events SET description='native' WHERE id='listen'").run();s.old.prepare("UPDATE events SET title='old' WHERE id='listen'").run();}
  if(change==='delete vs update'){s.native.prepare("UPDATE notifications SET message='native' WHERE id=-7").run();s.old.prepare('DELETE FROM notifications WHERE id=-7').run();}
  if(change==='update vs delete'){s.native.prepare('DELETE FROM notifications WHERE id=-7').run();s.old.prepare("UPDATE notifications SET message='old' WHERE id=-7").run();}
  if(change==='rowid collision'){s.native.prepare("INSERT INTO users VALUES('native-user','native-token','native','now')").run();s.old.prepare("INSERT INTO users VALUES('old-user','old-token','old','now')").run();}
  if(change==='primary key collision'){s.native.prepare("INSERT INTO users(rowid,id,token_hash,nickname,created_at) VALUES(101,'same-id','native-token','native','now')").run();s.old.prepare("INSERT INTO users(rowid,id,token_hash,nickname,created_at) VALUES(100,'same-id','old-token','old','now')").run();}
  if(change==='metadata'){s.native.pragma('user_version=43');s.old.pragma('user_version=44');}
  if(change==='storage'){s.native.prepare("UPDATE notifications SET message='same' WHERE id=-7").run();s.old.prepare('UPDATE notifications SET message=? WHERE id=-7').run(Buffer.from('different'));}
  const input=s.input(),original=Object.values(input).map(item=>Buffer.from(item.bytes));expect(()=>mergeForwardBoard(input)).toThrow();expect(Object.values(input).map(item=>item.bytes)).toEqual(original);
});
it.each(['checkpoint','baselineBoard','baselineJournal','nativeImage','nativeJournal','oldBoard'] as const)('rejects a wrong %s pin',name=>{
  const s=setup(),input=s.input();input[name].sha256='f'.repeat(64);expect(()=>mergeForwardBoard(input)).toThrow('pin differs');
});
it.each(['old schema','native schema','WAL header','foreign lineage','baseline board','native sequence','old sequence rewind','metadata disagreement','lost journal prefix','unrecorded applied'])('rejects unsafe or unrelated source: %s',change=>{
  const s=setup({baselineErasure:change==='lost journal prefix'||change==='unrecorded applied'}),input=s.input();
  if(change==='old schema')alter(input,'oldBoard',db=>db.exec('CREATE TABLE unexpected(value TEXT)'));if(change==='native schema')alter(input,'nativeImage',db=>db.exec('CREATE TABLE unexpected(value TEXT)'));
  if(change==='WAL header'){input.oldBoard.bytes[18]=2;input.oldBoard=pin(input.oldBoard.bytes);}
  if(change==='foreign lineage'){const db=openDatabase(':memory:');try{fixture(db);input.nativeImage=pin(captureRollbackCheckpoint(db,erasureJournal(db)).image);}finally{db.close();}}
  if(change==='baseline board')alter(input,'baselineBoard',db=>db.prepare("UPDATE events SET title='different-baseline' WHERE id='listen'").run());
  if(change==='native sequence')alter(input,'nativeImage',db=>db.prepare("UPDATE sqlite_sequence SET seq=-1 WHERE name='bot_outbox'").run());if(change==='old sequence rewind')alter(input,'oldBoard',db=>{db.prepare('DELETE FROM bot_outbox').run();db.prepare("UPDATE sqlite_sequence SET seq=0 WHERE name='bot_outbox'").run();});
  if(change==='metadata disagreement'){alter(input,'oldBoard',db=>db.pragma('user_version=44'));alter(input,'nativeImage',db=>db.pragma('user_version=45'));}
  if(change==='lost journal prefix')input.nativeJournal=pin(Buffer.alloc(0));if(change==='unrecorded applied')alter(input,'nativeImage',db=>db.prepare("INSERT INTO erasure_applied VALUES('unrecorded')").run());expect(()=>mergeForwardBoard(input)).toThrow();
});
it.each(['old row','native-only row','sequence','trigger','metadata','recovery flag'])('independently rejects a candidate with tampered %s even when its image is re-pinned',change=>{
  const s=setup();s.old.prepare("UPDATE events SET title='old-change' WHERE id='listen'").run();const input=s.input(),first=mergeForwardBoard(input),db=open(first.nativeImage);
  if(change==='old row')db.prepare("UPDATE events SET title='lost-old-change' WHERE id='listen'").run();if(change==='native-only row')db.prepare('DELETE FROM music_selections').run();if(change==='sequence')db.prepare("UPDATE sqlite_sequence SET seq=99 WHERE name='bot_outbox'").run();if(change==='trigger')db.exec('DROP TRIGGER finance_entries_no_update');if(change==='metadata')db.pragma('user_version=99');if(change==='recovery flag'){db.exec('DROP TRIGGER rebuild_storage_no_update');db.prepare('UPDATE rebuild_storage SET recovery_required=0').run();}
  const bytes=db.serialize();expect(forwardHash(bytes)).not.toBe(first.report.nativeImageSha256);expect(()=>verifyForwardBoardMerge(input,bytes)).toThrow();
});
it('rejects late byte/pin mutation or an asynchronous boundary and leaves original buffers intact otherwise',()=>{
  const s=setup(),input=s.input();expect(()=>mergeForwardBoard(input,()=>{input.oldBoard.bytes[100]=input.oldBoard.bytes[100]!^1;})).toThrow('source changed');const other=s.input(),before=Object.values(other).map(item=>forwardCanonical(item.bytes));expect(()=>mergeForwardBoard(other,(()=>Promise.resolve()) as unknown as ()=>void)).toThrow('synchronous');expect(Object.values(other).map(item=>forwardCanonical(item.bytes))).toEqual(before);
});
it.each(['old history delete','native history rewrite','sent replay','sent body','simulated replay','retargeted work','removed work','frozen payload'])('rejects loss of retained history or delivery semantics: %s',change=>{
  const s=setup();
  if(change==='old history delete'){const trigger=s.old.prepare("SELECT sql FROM sqlite_master WHERE name='settlement_history_no_delete'").get() as {sql:string};s.old.exec('DROP TRIGGER settlement_history_no_delete');s.old.exec('DELETE FROM settlement_history');s.old.exec(trigger.sql);}
  if(change==='native history rewrite'){const trigger=s.native.prepare("SELECT sql FROM sqlite_master WHERE name='settlement_history_no_update'").get() as {sql:string};s.native.exec('DROP TRIGGER settlement_history_no_update');s.native.exec("UPDATE settlement_history SET total_cents=999");s.native.exec(trigger.sql);}
  if(change==='sent replay')s.old.prepare("UPDATE bot_outbox SET status='pending' WHERE status='sent'").run();if(change==='sent body')s.old.prepare("UPDATE bot_outbox SET delivered_payload_json='rewritten' WHERE status='sent'").run();if(change==='simulated replay')s.old.prepare("UPDATE bot_outbox SET status='pending',simulated_at=NULL WHERE status='skipped'").run();if(change==='retargeted work')s.old.prepare("UPDATE bot_outbox SET target='different-group' WHERE status='pending'").run();if(change==='removed work')s.old.prepare("DELETE FROM bot_outbox WHERE status='failed'").run();
  if(change==='frozen payload'){const trigger=s.old.prepare("SELECT sql FROM sqlite_master WHERE name='bot_outbox_payload_immutable'").get() as {sql:string};s.old.exec('DROP TRIGGER bot_outbox_payload_immutable');s.old.exec("UPDATE bot_outbox SET payload_json='changed' WHERE status='pending'");s.old.exec(trigger.sql);}
  expect(()=>mergeForwardBoard(s.input())).toThrow();
});
it.each(['bytes','pin'])('rejects a source %s change at the final boundary after the merge was computed',change=>{
  const s=setup(),input=s.input(),native=Buffer.from(input.nativeImage.bytes);let calls=0;expect(()=>mergeForwardBoard(input,()=>{if(++calls===2){if(change==='bytes')input.oldBoard.bytes[100]=input.oldBoard.bytes[100]!^1;else input.oldBoard.sha256='e'.repeat(64);}})).toThrow('source changed');expect(calls).toBe(2);expect(input.nativeImage.bytes).toEqual(native);
});
it('independently reconciles every one of the 59 shared tables and all native-only tables in read-only Python without relying on the TypeScript report',()=>{
  const s=setup();s.old.prepare("UPDATE events SET title='old-change' WHERE id='listen'").run();s.native.prepare("UPDATE events SET description='native-change' WHERE id='karaoke'").run();const input=s.input(),merged=mergeForwardBoard(input),folder=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'qgroup-forward-oracle-')));cleanup.push(()=>fs.rmSync(folder,{recursive:true,force:true}));for(const [name,bytes] of [['base',input.baselineBoard.bytes],['native',input.nativeImage.bytes],['old',input.oldBoard.bytes],['candidate',merged.nativeImage]] as const)fs.writeFileSync(join(folder,name+'.sqlite3'),bytes,{mode:0o600});
  const result=execFileSync('python3',['-c',`import json,sqlite3,sys
from pathlib import Path
from contextlib import ExitStack,closing
root=Path(sys.argv[1])
with ExitStack() as stack:
 dbs={name:stack.enter_context(closing(sqlite3.connect((root/(name+'.sqlite3')).as_uri()+'?mode=ro',uri=True))) for name in ('base','native','old','candidate')}
 tables=lambda db:[row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
 shared=tables(dbs['base']);assert len(shared)==59
 def rows(db,table):
  columns=[row[1] for row in db.execute('PRAGMA table_xinfo("'+table+'")')]
  query='SELECT rowid,*,'+','.join('typeof("'+column+'")' for column in columns)+' FROM "'+table+'" ORDER BY rowid'
  return {row[0]:row for row in db.execute(query)}
 for table in shared:
  base,current,old,actual=[rows(dbs[name],table) for name in ('base','native','old','candidate')]
  expected={}
  for id in set(base)|set(current)|set(old):
   b,n,o=base.get(id),current.get(id),old.get(id)
   if o==b:wanted=n
   else:assert n==b or n==o,(table,id);wanted=o
   if wanted is not None:expected[id]=wanted
  assert actual==expected,table
 for table in set(tables(dbs['native']))-set(shared):
  before,after=rows(dbs['native'],table),rows(dbs['candidate'],table)
  if table=='rebuild_storage':
   assert list(after.values())[0][2]==1
   after={id:row[:2]+(before[id][2],)+row[3:] for id,row in after.items()}
  assert before==after,table
 assert dbs['candidate'].execute('PRAGMA integrity_check').fetchone()==('ok',) and not dbs['candidate'].execute('PRAGMA foreign_key_check').fetchall()
 print(json.dumps(dict(sharedTables=59,nativeOnlyPreserved=True,storageClasses=True,recoveryBlocked=True)))`,folder],{encoding:'utf8',timeout:10000});expect(JSON.parse(result)).toEqual({sharedTables:59,nativeOnlyPreserved:true,storageClasses:true,recoveryBlocked:true});
});
it('rejects opposed infinite SQLite REAL values instead of collapsing both to JSON null',()=>{
  const s=setup();for(const [db,value] of [[s.native,Infinity],[s.old,-Infinity]] as const)db.prepare("INSERT INTO admin_audit(id,action,before_value,after_value,created_at) VALUES(77,'synthetic',?,0,'before')").run(value);expect(()=>mergeForwardBoard(s.input())).toThrow('row conflict');
});
it('keeps all sources and blocks a partial board merge that would orphan native music receipts after an old private-result deletion',()=>{
  const s=setup({musicReceipt:true});s.old.prepare("DELETE FROM request_results WHERE user_id='alice'").run();const input=s.input(),native=Buffer.from(input.nativeImage.bytes),old=Buffer.from(input.oldBoard.bytes);expect(()=>mergeForwardBoard(input)).toThrow('cross-domain reference reconciliation');expect(input.nativeImage.bytes).toEqual(native);expect(input.oldBoard.bytes).toEqual(old);expect(s.native.prepare('SELECT 1 FROM music_profile_receipts').get()).toBeDefined();
});
