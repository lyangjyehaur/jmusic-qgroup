import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach,expect,it } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { fixture } from '../testsupport/fixture';
import { legacyHistoryFixture } from '../testsupport/legacy-history-fixture';
import { erasureJournal } from './erasure-journal';
import { createPrivacy } from './privacy';
import { hash } from './security';
import { captureRollbackCheckpoint } from '../../../tools/migration/rollback-checkpoint';
import { verifyRollbackCheckpoint } from '../../../tools/migration/rollback-checkpoint-reconciliation';
import { projectRollbackBoard } from '../../../tools/migration/rollback-board';
import { projectRollbackMusic } from '../../../tools/migration/rollback-music';
const cleanup:(()=>void)[]=[];afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();});
function setup(){const db=openDatabase(':memory:');fixture(db);cleanup.push(()=>{db.close();});return db;}
function copy(image:Buffer){const db=new Database(image);cleanup.push(()=>{db.close();});return db;}
it('preserves all current domains, schemas, raw rows, audits, receipts, consent and high-water without altering the source',async()=>{
  const s=await legacyHistoryFixture();cleanup.push(()=>s.close());const journal=erasureJournal(s.db);
  s.db.prepare("INSERT INTO admin_audit VALUES(?,?,-2,3,'after')").run(9007199254740993n,'checkpoint');
  s.db.prepare("INSERT INTO notifications(id,user_id,event_id,kind,message,created_at,read_at) VALUES(-8,'bob','listen','checkpoint',?,'after',NULL)").run(Buffer.from([0,255,1]));
  s.db.prepare("INSERT INTO sqlite_sequence VALUES('music_ownership_history',?)").run(9223372036854775807n);
  s.db.prepare("INSERT INTO bot_outbox(event_id,kind,dedupe_key,target,payload_json,status,claim_token,created_at) VALUES('listen','checkpoint','checkpoint','synthetic','{}','sending','kept-claim','after')").run();
  s.db.prepare("INSERT INTO unified_privacy_consents VALUES('bob','fixture-consent','after','explicit')").run();
  s.db.prepare("INSERT INTO unified_privacy_receipts VALUES('bob','fixture-receipt','fixture-consent','fixture-signature')").run();
  s.db.pragma('application_id=123');s.db.pragma('user_version=45');
  const before=s.db.serialize(),snapshot=captureRollbackCheckpoint(s.db,journal),saved=copy(snapshot.image);
  expect(snapshot.report.rollbackEligible).toBe(false);expect(snapshot.report.tableCount).toBeGreaterThan(59);expect(snapshot.report.tables.music_documents).toBeGreaterThan(0);
  expect(saved.prepare('SELECT id FROM admin_audit').safeIntegers(true).get()).toEqual({id:9007199254740993n});
  expect(saved.prepare('SELECT message,typeof(message) AS storage,read_at FROM notifications WHERE id=-8').get()).toEqual({message:Buffer.from([0,255,1]),storage:'blob',read_at:null});
  expect(snapshot.report.sequences).toContainEqual({name:'music_ownership_history',seq:'9223372036854775807'});
  expect(saved.prepare('SELECT * FROM bot_outbox').all()).toEqual(s.db.prepare('SELECT * FROM bot_outbox').all());
  expect(saved.prepare('SELECT * FROM unified_privacy_consents').all()).toEqual(s.db.prepare('SELECT * FROM unified_privacy_consents').all());
  expect(saved.prepare('SELECT * FROM unified_privacy_receipts').all()).toEqual(s.db.prepare('SELECT * FROM unified_privacy_receipts').all());
  expect(saved.pragma('application_id',{simple:true})).toBe(123);expect(saved.pragma('user_version',{simple:true})).toBe(45);
  expect(s.db.serialize()).toEqual(before);
  expect(s.db.transaction(()=>verifyRollbackCheckpoint(s.db,snapshot.image,snapshot.journal)).immediate().imageDigest).toBe(snapshot.report.imageDigest);
});
it('captures latest erasure receipts and journal without reviving deleted data or changing delivery work',async()=>{
  const s=await legacyHistoryFixture();cleanup.push(()=>s.close());const journal=erasureJournal(s.db),privacy=createPrivacy(s.db,journal);
  s.db.transaction(()=>privacy.submit({version:1,kind:'music',userId:'bob',profileId:(s.db.prepare("SELECT id FROM music_profiles WHERE user_id='bob'").get() as {id:string}).id,requestId:randomUUID(),createdAt:'2026-11-19T00:00:00.000Z',secretHash:hash('secret'),signature:hash('signature')})).immediate();privacy.guard();
  const saved=captureRollbackCheckpoint(s.db,journal),db=copy(saved.image);
  expect(saved.report.journalRequests).toBe(1);expect(db.prepare('SELECT * FROM privacy_receipts').all()).toEqual(s.db.prepare('SELECT * FROM privacy_receipts').all());
  const music=projectRollbackMusic(db,{read:()=>saved.journal,append(){throw Error('snapshot is immutable');}});expect(music.data.members).not.toHaveProperty('10002');
  expect(()=>s.db.transaction(()=>verifyRollbackCheckpoint(s.db,saved.image,[])).immediate()).toThrow('reconciliation failed');
});
it('provides one frozen source for both domain projections despite subsequent current writes',async()=>{
  const s=await legacyHistoryFixture();cleanup.push(()=>s.close());const snapshot=captureRollbackCheckpoint(s.db,erasureJournal(s.db));
  s.db.prepare("UPDATE events SET title='later activity' WHERE id='listen'").run();s.db.prepare("UPDATE music_entries SET name='later music' WHERE id='e'").run();
  const db=copy(snapshot.image),board=projectRollbackBoard(db);cleanup.push(()=>{board.db.close();});const music=projectRollbackMusic(db,{read:()=>snapshot.journal,append(){throw Error();}});
  expect(board.db.prepare("SELECT title FROM events WHERE id='listen'").get()).not.toEqual({title:'later activity'});expect(music.data.entries).toHaveProperty('e.text','歷史詞條');
});
it.each(['row','storage','rowid','schema','metadata','sequence','missing receipt'])('independently rejects modified %s in a checkpoint',async(kind)=>{
  const s=await legacyHistoryFixture();cleanup.push(()=>s.close());const journal=erasureJournal(s.db);
  s.db.prepare("INSERT INTO notifications(id,user_id,event_id,kind,message,created_at) VALUES(8,'bob','listen','checkpoint','kept','after')").run();
  s.db.prepare("INSERT INTO unified_privacy_consents VALUES('bob','fixture-consent','after','explicit')").run();
  s.db.prepare("INSERT INTO unified_privacy_receipts VALUES('bob','fixture-receipt','fixture-consent','fixture-signature')").run();
  const snapshot=captureRollbackCheckpoint(s.db,journal),db=copy(snapshot.image);
  if(kind==='row')db.prepare("UPDATE music_entries SET name='lost' WHERE id='e'").run();
  if(kind==='storage')db.prepare('UPDATE notifications SET message=? WHERE id=8').run(Buffer.from('kept'));
  if(kind==='rowid')db.prepare('UPDATE notifications SET id=-7 WHERE id=8').run();
  if(kind==='schema')db.exec('DROP TRIGGER music_ownership_no_update');
  if(kind==='metadata')db.pragma('application_id=999');
  if(kind==='sequence')db.prepare("UPDATE sqlite_sequence SET seq=999 WHERE name='notifications'").run();
  if(kind==='missing receipt')expect(db.prepare("DELETE FROM unified_privacy_receipts WHERE user_id='bob'").run().changes).toBe(1);
  const image=db.serialize();image[18]=1;image[19]=1;
  expect(()=>s.db.transaction(()=>verifyRollbackCheckpoint(s.db,image,snapshot.journal)).immediate()).toThrow('reconciliation failed');
  expect(()=>s.db.prepare("UPDATE events SET title='source remains usable' WHERE id='listen'").run()).not.toThrow();
});
it('rejects nested sources, unknown schema, invalid sequence and incomplete journal without repairing anything',()=>{
  const db=setup(),journal=erasureJournal(db);
  db.transaction(()=>expect(()=>captureRollbackCheckpoint(db,journal)).toThrow('standalone')).deferred();
  expect(()=>verifyRollbackCheckpoint(db,db.serialize(),[])).toThrow('held source transaction');
  db.prepare("INSERT INTO sqlite_sequence VALUES('music_pin_history','invalid')").run();const before=db.serialize();expect(()=>captureRollbackCheckpoint(db,journal)).toThrow('reconciliation failed');expect(db.serialize()).toEqual(before);
  db.prepare("DELETE FROM sqlite_sequence WHERE name='music_pin_history'").run();db.prepare("INSERT INTO erasure_applied VALUES('missing')").run();expect(()=>captureRollbackCheckpoint(db,journal)).toThrow('markers differ');
  db.exec('CREATE TABLE unexpected(value TEXT)');expect(()=>captureRollbackCheckpoint(db,journal)).toThrow('schema');
});
it('captures a WAL database into standalone bytes without checkpointing or depending on its sidecar',()=>{
  const root=mkdtempSync(join(tmpdir(),'qgroup-rollback-checkpoint-'));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
  const db=openDatabase(join(root,'source.sqlite3'));cleanup.push(()=>{db.close();});fixture(db);db.pragma('wal_autocheckpoint=0');db.prepare("UPDATE events SET title='committed WAL write' WHERE id='listen'").run();
  const image=captureRollbackCheckpoint(db,erasureJournal(db)).image;expect(image[18]).toBe(1);expect(image[19]).toBe(1);
  expect(copy(image).prepare("SELECT title FROM events WHERE id='listen'").get()).toEqual({title:'committed WAL write'});expect(db.pragma('journal_mode',{simple:true})).toBe('wal');
});
it('holds the source writer lock while reading the journal and releases it without writing after capture failure',()=>{
  const root=mkdtempSync(join(tmpdir(),'qgroup-rollback-checkpoint-lock-'));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
  const path=join(root,'source.sqlite3'),db=openDatabase(path);cleanup.push(()=>{db.close();});fixture(db);const before=db.serialize();
  const reader=()=>{
    const result=execFileSync('python3',['-c',`import sqlite3,sys
db=sqlite3.connect(sys.argv[1],timeout=0.05)
try:
 db.execute("UPDATE events SET title='must not write' WHERE id='listen'")
 db.commit()
 print('unexpected write')
except sqlite3.OperationalError as e:
 print(str(e))
finally: db.close()`,path],{encoding:'utf8'}).trim();
    expect(result).toBe('database is locked');return [];
  };
  captureRollbackCheckpoint(db,{read:reader,append(){throw Error();}});
  expect(()=>captureRollbackCheckpoint(db,{read(){reader();throw Error('journal unavailable');},append(){throw Error();}})).toThrow('journal unavailable');
  expect(db.inTransaction).toBe(false);expect(db.serialize()).toEqual(before);
  execFileSync('python3',['-c',`import sqlite3,sys
db=sqlite3.connect(sys.argv[1],timeout=0.05)
db.execute("UPDATE events SET title='write after capture' WHERE id='listen'")
db.commit()
db.close()`,path]);
  expect(db.prepare("SELECT title FROM events WHERE id='listen'").get()).toEqual({title:'write after capture'});
});
it('compares nonfinite SQLite REAL values without JSON converting both signs to null',async()=>{
  const s=await legacyHistoryFixture();cleanup.push(()=>s.close());
  s.db.prepare("UPDATE music_shouts SET created_at=? WHERE id='old'").run(Infinity);
  const snapshot=captureRollbackCheckpoint(s.db,erasureJournal(s.db)),saved=copy(snapshot.image);
  expect(saved.prepare("SELECT created_at FROM music_shouts WHERE id='old'").get()).toEqual({created_at:Infinity});
  saved.prepare("UPDATE music_shouts SET created_at=? WHERE id='old'").run(-Infinity);const image=saved.serialize();image[18]=1;image[19]=1;
  expect(()=>s.db.transaction(()=>verifyRollbackCheckpoint(s.db,image,[])).immediate()).toThrow('reconciliation failed');
});
