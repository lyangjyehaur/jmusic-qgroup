import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { fixture } from '../testsupport/fixture';
import { createApp } from './app';
import { projectRollbackBoard } from '../../../tools/migration/rollback-board';
import { verifyRollbackBoard } from '../../../tools/migration/rollback-board-reconciliation';
const cleanup:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
function setup(){const db=openDatabase(':memory:');fixture(db);cleanup.push(()=>{db.close();});return db;}
function project(db:ReturnType<typeof setup>){const result=projectRollbackBoard(db);cleanup.push(()=>{result.db.close();});return result;}
it('refuses nested reader transactions instead of treating a savepoint as a source writer lock',()=>{
  const db=setup();db.transaction(()=>{expect(()=>projectRollbackBoard(db)).toThrow('standalone source transaction');expect(db.inTransaction).toBe(true);}).deferred();expect(db.inTransaction).toBe(false);
});
it('preserves every current board row, frozen schema and all bot delivery states without projecting an old pre-write backup',async()=>{
  const db=setup(),app=createApp({db,origin:'https://rebuild.example'});await app.ready();cleanup.push(()=>app.close());
  const cookie='kanban_session=fixture-alice',viewer=(await app.inject({url:'/api/v2/session',headers:{cookie}})).json(),key=randomUUID();
  const response=await app.inject({method:'POST',url:'/api/v2/activities/drafts',headers:{cookie,origin:'https://rebuild.example','x-account-scope':viewer.scope,'x-csrf-token':viewer.csrf,'idempotency-key':key},payload:{values:{title:'切換後新活動',category:'约K',location:'保留地點',startsAt:'2099-12-12T14:30:00+08:00',deadline:'2099-12-11T08:30:00+08:00',capacity:12,description:'保留輸入',durationHours:3,withdrawalDeadline:null,visibility:'public',timezone:'Asia/Taipei',minimumParticipants:2,feePolicy:'原金額規則',botEnabled:false,joinOwner:false}}});expect(response.statusCode,response.body).toBe(200);
  for(const [index,status] of ['pending','sending','sent','failed','skipped','pending'].entries())db.prepare(`INSERT INTO bot_outbox(event_id,kind,dedupe_key,target,payload_json,status,attempts,last_error,claim_token,retry_at,simulated_at,created_at,delivered_payload_json)
    VALUES('listen','synthetic',?,'isolated','{"frozen":true}',?,2,?,?,?,?,'after',?)`).run('rollback-'+index,status,status==='sending'?'delivery unconfirmed':'',status==='sending'?'original-claim':'',status==='failed'?'future-retry':null,index===5?'simulation-kept':null,status==='sent'?'frozen delivered body':null);
  db.prepare("INSERT INTO settlement_history(event_id,version,total_cents,headcount,note,qr_image,updated_at,actor_id,actor_name,kind,changed_fields) VALUES('listen',7,10001,3,'原帳單',?,'after','alice','原名稱','detailed','原版次')").run(Buffer.from([0,1,255]));
  const bot=db.prepare('SELECT * FROM bot_outbox').all(),result=project(db);
  expect(result.report.tableCount).toBe(59);expect(result.report.rollbackEligible).toBe(false);expect(result.report.tables.events).toBe(7);expect(result.db.prepare('SELECT * FROM bot_outbox').all()).toEqual(bot);
  expect(result.db.prepare('SELECT title FROM events WHERE id=?').get(response.json().id)).toEqual({title:'切換後新活動'});expect(result.db.prepare('SELECT * FROM request_results WHERE request_key=?').get(key)).toEqual(db.prepare('SELECT * FROM request_results WHERE request_key=?').get(key));
  expect(result.db.prepare('SELECT * FROM settlement_history').all()).toEqual(db.prepare('SELECT * FROM settlement_history').all());
  expect(()=>result.db.prepare("UPDATE settlement_history SET note='rewrite'").run()).toThrow(/append-only/);expect(()=>result.db.prepare("INSERT INTO registrations(event_id,user_id,note,created_at) VALUES('listen','alice','rewrite','now')").run()).toThrow(/read-only/);
  expect(verifyRollbackBoard(db,result.db).rowsDigest).toBe(result.report.rowsDigest);expect(db.prepare('SELECT * FROM bot_outbox').all()).toEqual(bot);
});
it('preserves signed rowids, integers beyond Number safety, native BLOB/null types, empty-table sequence high-water and database metadata',()=>{
  const db=setup();db.pragma('user_version=42');db.pragma('application_id=12345');
  db.prepare("INSERT INTO admin_audit(id,action,before_value,after_value,created_at) VALUES(?,?,-3,4,'original')").run(9007199254740993n,'unsafe-number-safe-sqlite');
  db.prepare("INSERT INTO notifications(id,user_id,event_id,kind,message,created_at,read_at) VALUES(-7,'bob','listen','synthetic',?,'original',NULL)").run(Buffer.from([4,0,250]));
  db.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES('finance_reports',?)").run(9223372036854775807n);
  const result=project(db);
  expect(result.db.prepare('SELECT id FROM admin_audit').safeIntegers(true).get()).toEqual({id:9007199254740993n});
  expect(result.db.prepare("SELECT rowid,message,typeof(message) AS storage,read_at FROM notifications WHERE rowid=-7").get()).toEqual({id:-7,message:Buffer.from([4,0,250]),storage:'blob',read_at:null});
  expect(result.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='finance_reports'").safeIntegers(true).get()).toEqual({seq:9223372036854775807n});
  expect(result.db.pragma('user_version',{simple:true})).toBe(42);expect(result.db.pragma('application_id',{simple:true})).toBe(12345);
});
it.each(['row','storage','rowid','sequence','missing sequence','schema','metadata'])('independently rejects changed %s evidence',kind=>{
  const db=setup();db.prepare("INSERT INTO notifications(id,user_id,event_id,kind,message,created_at) VALUES(5,'bob','listen','test','same','original')").run();const result=project(db),copy=result.db;
  if(kind==='row')copy.prepare("UPDATE events SET title='lost new write' WHERE id='listen'").run();
  if(kind==='storage')copy.prepare("UPDATE notifications SET message=? WHERE id=5").run(Buffer.from('same'));
  if(kind==='rowid')copy.prepare('UPDATE notifications SET id=-8 WHERE id=5').run();
  if(kind==='sequence')copy.prepare("UPDATE sqlite_sequence SET seq=9999 WHERE name='notifications'").run();
  if(kind==='missing sequence')copy.prepare("DELETE FROM sqlite_sequence WHERE name='notifications'").run();
  if(kind==='schema')copy.exec('DROP TRIGGER finance_entries_no_update');
  if(kind==='metadata')copy.pragma('application_id=9');
  expect(()=>verifyRollbackBoard(db,copy)).toThrow('reconciliation failed');
});
it.each(['unknown schema','low sequence','missing sequence','invalid sequence'])('rejects %s sources without repairing them',kind=>{
  const db=setup();db.prepare("INSERT INTO notifications(id,user_id,event_id,kind,message,created_at) VALUES(7,'bob','listen','test','body','original')").run();
  if(kind==='unknown schema')db.exec('CREATE TABLE unknown(payload TEXT)');
  if(kind==='low sequence')db.prepare("UPDATE sqlite_sequence SET seq=2 WHERE name='notifications'").run();
  if(kind==='missing sequence')db.prepare("DELETE FROM sqlite_sequence WHERE name='notifications'").run();
  if(kind==='invalid sequence')db.prepare("UPDATE sqlite_sequence SET seq='not integer' WHERE name='notifications'").run();
  const before=db.prepare('SELECT * FROM sqlite_sequence').all();expect(()=>projectRollbackBoard(db)).toThrow();expect(db.prepare('SELECT * FROM sqlite_sequence').all()).toEqual(before);
});
it('is readable through a separate readonly Python SQLite connection without creating tables or consuming jobs',()=>{
  const db=setup(),copy=project(db).db,root=mkdtempSync(join(tmpdir(),'qgroup-rollback-board-'));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));const path=join(root,'board.sqlite3');writeFileSync(path,copy.serialize(),{mode:0o600});
  const result=execFileSync('python3',['-c',`import json,sqlite3,sys
db=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
print(json.dumps({'integrity':db.execute('PRAGMA integrity_check').fetchone()[0],'tables':db.execute("SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchone()[0],'events':db.execute('SELECT count(*) FROM events').fetchone()[0],'bot':db.execute('SELECT count(*) FROM bot_outbox').fetchone()[0]}))
db.close()`,path],{encoding:'utf8'});
  expect(JSON.parse(result)).toEqual({integrity:'ok',tables:59,events:6,bot:0});
});
