import Database from 'better-sqlite3';
import {openDatabase} from '@qgroup/database';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {afterEach,expect,it} from 'vitest';
import {createPrivacy} from './privacy';
import {hash} from './security';
import type {ErasureIntent,ErasureJournal} from './erasure-journal';
import {repairAppliedNativeResetEntries,reconcileAppliedNativeResetEntries} from '../../../tools/migration/forward-native-reset-entries';
import {forwardEqual,forwardRows} from '../../../tools/migration/forward-board-storage';
const cleanup:(()=>void)[]=[];
afterEach(()=>cleanup.splice(0).reverse().forEach(close=>close()));
function setup(){
  const source=openDatabase(':memory:');cleanup.push(()=>source.close());
  source.exec("INSERT INTO users VALUES('owner','unusable','保留帳號','before'); INSERT INTO music_entries VALUES('reset-entry','原詞條','main'); INSERT INTO music_profiles VALUES('unrelated','owner',4,'before',NULL)");
  const intent:ErasureIntent={version:2,kind:'admin_music',command:'reset_music',actorRef:'account:owner',profiles:[],entries:['reset-entry','absent-entry'],requestId:randomUUID(),createdAt:'2026-11-20T02:00:00.000Z',secretHash:hash('synthetic-secret'),signature:hash('synthetic-signature')};
  const journal:ErasureJournal={read:()=>[structuredClone(intent)],append(){throw Error('Read-only fixture');}};
  createPrivacy(source,journal);
  // Mixed restore retains the genuine applied marker, receipt and audit but
  // revives catalog children. Later entry/shout generations must survive.
  source.exec("INSERT INTO music_entries VALUES('reset-entry','恢復的原詞條','main'),('after-reset','重置後詞條','sub'); INSERT INTO music_entry_details VALUES('reset-entry','原類別','[]','','1001','1002'),('after-reset','新類別','[]','','2001','2002'); INSERT INTO music_selections VALUES('unrelated','reset-entry',4,0),('unrelated','after-reset',2,1); INSERT INTO music_entry_creations VALUES('unrelated','reset-entry',0),('unrelated','after-reset',1)");
  for(const [position,id] of ['reset-entry','after-reset'].entries()){
    source.prepare("INSERT INTO music_documents VALUES('entry_source',?,?)").run(position,JSON.stringify({entryId:id,entry:{text:'原 JSON 與額外欄位',opaque:[null,false,{a:1}]}}));
    source.prepare("INSERT INTO migration_map VALUES('music','entry',?,?,'original-sha','original-content','imported')").run('legacy-'+id,id);
  }
  source.prepare("INSERT INTO migration_map VALUES('other','entry','reset-entry','reset-entry','other-sha','other-content','retained')").run();
  for(const kind of ['shouts','shoutHistory','trend','trend_sample'])source.prepare('INSERT INTO music_documents VALUES(?,0,?)').run(kind,JSON.stringify({qq:'unrelated',opaque:'重置後資料'}));
  source.exec("INSERT INTO music_shouts VALUES('new-shout','unrelated','','保留稱呼','重置後喊話',2001.25,NULL,0); INSERT INTO music_shout_authors VALUES('unrelated',2001.25)");
  const candidate=new Database(source.serialize());candidate.pragma('foreign_keys = ON');cleanup.push(()=>candidate.close());
  return {source,candidate,journal,intent,repair:()=>candidate.transaction(()=>repairAppliedNativeResetEntries(candidate,journal)).immediate(),verify:()=>reconcileAppliedNativeResetEntries(source,candidate,journal)};
}
it('repairs all restored children of original reset IDs and verifies every retained SQLite row, storage class, receipt and action',()=>{
  const s=setup(),before=s.source.serialize();s.repair();expect(s.verify()).toMatchObject({entryScopes:2,nativeResetRequests:1,removedRows:5,changedRows:1,allRowsVerified:true,globalResetGenerationsVerified:false,releaseEligible:false});
  expect(s.candidate.prepare("SELECT 1 FROM music_entries WHERE id='reset-entry'").get()).toBeUndefined();
  for(const table of ['music_entries','music_entry_details','music_selections','music_entry_creations'])expect(s.candidate.prepare('SELECT count(*) n FROM '+table).get()).toEqual({n:1});
  for(const table of ['users','music_profiles','music_shouts','music_shout_authors','music_catalog_actions','privacy_receipts','erasure_applied','sqlite_sequence'])expect(forwardEqual([...forwardRows(s.source,table)],[...forwardRows(s.candidate,table)]),table).toBe(true);
  expect(s.source.serialize()).toEqual(before);
  const repaired=s.candidate.serialize();s.repair();expect(s.candidate.serialize()).toEqual(repaired);expect(s.verify().allRowsVerified).toBe(true);
});
it.each(['missing receipt','signature','result request','result command','result profiles','result entries','missing marker'])('rejects original authority mismatch: %s',change=>{
  const s=setup();if(change==='missing receipt')s.candidate.prepare('DELETE FROM privacy_receipts').run();
  else if(change==='missing marker')s.candidate.prepare('DELETE FROM erasure_applied').run();
  else if(change==='signature')s.candidate.prepare("UPDATE privacy_receipts SET signature=?").run(hash('wrong'));
  else{const row=s.candidate.prepare('SELECT result_json FROM privacy_receipts').get() as {result_json:string},result=JSON.parse(row.result_json) as Record<string,unknown>;result[change==='result request'?'requestId':change.slice(7)]=change==='result request'?randomUUID():change==='result command'?'delete_profile':99;s.candidate.prepare('UPDATE privacy_receipts SET result_json=?').run(JSON.stringify(result));}
  const before=s.candidate.serialize();expect(()=>s.repair()).toThrow();expect(s.candidate.serialize()).toEqual(before);
});
it.each(['unremoved scope','unrelated entry','later shout','receipt','action','mapping provenance','other mapping','extra row','schema','metadata','creation membership'])('independent oracle rejects candidate corruption: %s',change=>{
  const s=setup();if(change!=='unremoved scope')s.repair();
  if(change==='unrelated entry')s.candidate.prepare("UPDATE music_entries SET name='changed' WHERE id='after-reset'").run();
  if(change==='later shout')s.candidate.prepare("UPDATE music_shouts SET body='changed'").run();
  if(change==='receipt')s.candidate.prepare("UPDATE privacy_receipts SET result_json=json_set(result_json,'$.entries',9)").run();
  if(change==='action')s.candidate.prepare("INSERT INTO music_catalog_actions(actor_ref,command,entry_id,target_id,affected_profiles,created_at) VALUES('synthetic','reset_music','','',0,'extra')").run();
  if(change==='mapping provenance')s.candidate.prepare("UPDATE migration_map SET payload_digest='changed' WHERE source='music' AND target_id='reset-entry'").run();
  if(change==='other mapping')s.candidate.prepare("UPDATE migration_map SET status='deleted' WHERE source='other'").run();
  if(change==='extra row')s.candidate.prepare("INSERT INTO music_entries VALUES('unexpected','extra','sub')").run();
  if(change==='schema')s.candidate.exec('CREATE INDEX unexpected_reset_index ON music_entries(name)');
  if(change==='metadata')s.candidate.pragma('application_id = 17');
  if(change==='creation membership')s.candidate.prepare("DELETE FROM music_entry_creations WHERE entry_id='after-reset'").run();
  expect(()=>s.verify()).toThrow();
});
it('requires the held transaction and foreign-key enforcement before deleting any row',()=>{
  const s=setup(),before=s.candidate.serialize();expect(()=>repairAppliedNativeResetEntries(s.candidate,s.journal)).toThrow('held foreign-key transaction');
  s.candidate.pragma('foreign_keys = OFF');expect(()=>s.repair()).toThrow('held foreign-key transaction');expect(s.candidate.serialize()).toEqual(before);
});
it('rolls back all repaired rows when independent reconciliation rejects an unexpected write in the held transaction',()=>{
  const s=setup(),before=s.candidate.serialize();
  expect(()=>s.candidate.transaction(()=>{
    repairAppliedNativeResetEntries(s.candidate,s.journal);
    s.candidate.prepare("INSERT INTO music_entries VALUES('unexpected','extra','sub')").run();
    reconcileAppliedNativeResetEntries(s.source,s.candidate,s.journal);
  }).immediate()).toThrow('reconciliation failed');
  expect(s.candidate.serialize()).toEqual(before);expect(s.source.serialize()).toEqual(before);
});
it('uses the union of original reset IDs across successive resets without duplicating original receipts or clearing a later entry generation',()=>{
  const s=setup(),second:ErasureIntent={...s.intent,requestId:randomUUID(),entries:['reset-entry','after-reset'],createdAt:'2026-11-20T03:00:00.000Z',signature:hash('second-reset')},journal:ErasureJournal={read:()=>[s.intent,second],append(){throw Error();}};
  createPrivacy(s.source,journal);
  s.source.exec("INSERT INTO music_entries VALUES('reset-entry','復活第一世代','main'),('after-reset','復活第二世代','sub'),('latest','第三世代','sub')");
  const candidate=new Database(s.source.serialize());candidate.pragma('foreign_keys = ON');cleanup.push(()=>candidate.close());
  const report=candidate.transaction(()=>{repairAppliedNativeResetEntries(candidate,journal);return reconcileAppliedNativeResetEntries(s.source,candidate,journal);}).immediate();
  expect(report).toMatchObject({nativeResetRequests:2,entryScopes:3,allRowsVerified:true});expect(candidate.prepare('SELECT id FROM music_entries').all()).toEqual([{id:'latest'}]);
  for(const table of ['privacy_receipts','music_catalog_actions','erasure_applied'])expect([...forwardRows(candidate,table)]).toEqual([...forwardRows(s.source,table)]);
});
it('verifies the serialized repair and untouched original using an independent Python SQLite process',()=>{
  const s=setup();s.repair();const root=mkdtempSync(join(tmpdir(),'qgroup-native-reset-'));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
  writeFileSync(join(root,'source.sqlite3'),s.source.serialize(),{mode:0o600});writeFileSync(join(root,'candidate.sqlite3'),s.candidate.serialize(),{mode:0o600});
  const result=execFileSync('python3',['-c',`import json,sqlite3,sys
from pathlib import Path
from contextlib import closing
root=Path(sys.argv[1]);scope={'reset-entry','absent-entry'}
with closing(sqlite3.connect((root/'source.sqlite3').as_uri()+'?mode=ro',uri=True)) as source, closing(sqlite3.connect((root/'candidate.sqlite3').as_uri()+'?mode=ro',uri=True)) as candidate:
 assert candidate.execute('PRAGMA integrity_check').fetchone()==('ok',) and not candidate.execute('PRAGMA foreign_key_check').fetchall()
 assert source.execute('SELECT * FROM sqlite_master ORDER BY name').fetchall()==candidate.execute('SELECT * FROM sqlite_master ORDER BY name').fetchall()
 for pragma in ('user_version','application_id','encoding'):assert source.execute('PRAGMA '+pragma).fetchall()==candidate.execute('PRAGMA '+pragma).fetchall()
 tables=[r[0] for r in source.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
 removed=changed=retained=0
 for table in tables:
  cols=[r[1] for r in source.execute('PRAGMA table_xinfo("'+table+'")')];query='SELECT rowid,*,'+','.join('typeof("'+c+'")' for c in cols)+' FROM "'+table+'" ORDER BY rowid';wanted=[]
  for row in source.execute(query):
   value=dict(zip(['_rowid']+cols,row[:len(cols)+1]));drop=(table=='music_entries' and value['id'] in scope) or (table in ('music_entry_details','music_selections','music_entry_creations') and value['entry_id'] in scope)
   if table=='music_documents' and value['kind']=='entry_source':drop=json.loads(value['payload_json']).get('entryId') in scope
   if drop:removed+=1;continue
   next=list(row)
   if table=='migration_map' and value['source']=='music' and value['entity_type']=='entry' and value['target_id'] in scope:next[1+cols.index('status')]='deleted'
   if next==list(row):retained+=1
   else:changed+=1
   wanted.append(tuple(next))
  assert wanted==candidate.execute(query).fetchall(),table
 assert removed==5 and changed==1 and retained>0
 print(json.dumps(dict(allTables=len(tables),removedRows=removed,changedRows=changed,retainedRows=retained,allRowsAndStorageVerified=True)))`,root],{encoding:'utf8',timeout:10000});
  expect(JSON.parse(result)).toMatchObject({removedRows:5,changedRows:1,allRowsAndStorageVerified:true});expect(JSON.parse(result).allTables).toBeGreaterThan(80);
});
