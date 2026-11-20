import Database from 'better-sqlite3';
import {openDatabase} from '@qgroup/database';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {afterEach,expect,it} from 'vitest';
import {createPrivacy} from './privacy';
import {musicErasureScope} from './admin-music-erasure';
import {hash} from './security';
import type {ErasureIntent,ErasureJournal} from './erasure-journal';
import {forwardHash,forwardRows} from '../../../tools/migration/forward-board-storage';
import {verifyNativeOrphanResetSource,repairAppliedNativeOrphanResetGlobal,reconcileAppliedNativeOrphanResetGlobal,type NativeOrphanResetSource} from '../../../tools/migration/forward-native-orphan-reset';

const cleanup:(()=>void)[]=[];
afterEach(()=>cleanup.splice(0).reverse().forEach(close=>close()));
const pin=(bytes:Buffer)=>({bytes,sha256:forwardHash(bytes)});
const memory=(bytes:Buffer)=>{const db=new Database(bytes);db.pragma('foreign_keys = ON');cleanup.push(()=>db.close());return db;};
function setup(){
  const db=openDatabase(':memory:');cleanup.push(()=>db.close());
  const entries:ErasureIntent[]=[],journal:ErasureJournal={read:()=>structuredClone(entries),append:entry=>entries.push(structuredClone(entry))};
  const privacy=createPrivacy(db,journal);
  db.exec("INSERT INTO users VALUES('owner','unusable','保留帳號','before'); INSERT INTO music_profiles VALUES('inactive',NULL,0,'before','2026-11-20T00:00:00.000Z'); INSERT INTO music_shouts VALUES('original-active',NULL,'anon','匿名','原活躍留言',1000.25,NULL,0),('original-history',NULL,'anon','匿名','原歷史留言',1000.5,1001.25,1); INSERT INTO music_shout_authors VALUES('inactive',1000.25)");
  for(const [kind,value] of [['shouts',{id:'original-active',qq:'anon',text:'原活躍留言'}],['shoutHistory',{id:'original-history',qq:'anon',text:'原歷史留言'}],['trend',{t:1000.25,counts:{opaque:1}}],['trend_sample',{t:1001.25,counts:{opaque:2}}]] as const)db.prepare('INSERT INTO music_documents VALUES(?,0,?)').run(kind,JSON.stringify(value));
  for(const kind of ['shouts','shoutHistory','trend'])db.prepare("INSERT INTO migration_map VALUES('music',?,'0','original','revision','digest','imported')").run(kind);
  db.exec("INSERT INTO migration_map VALUES('music','trend','missing','retained-scope','revision','digest','erased'),('other','trend','0','other','revision','digest','imported'); INSERT INTO music_documents VALUES('settings',0,'{\"rate\":7}')");
  const before=db.serialize(),intent:ErasureIntent={version:2,kind:'admin_music',command:'reset_music',actorRef:'account:owner',profiles:[],entries:[],requestId:randomUUID(),createdAt:'2026-11-21T01:00:00.000Z',secretHash:hash('fixture-secret'),signature:hash('fixture-reset')};
  privacy.submit(intent);privacy.guard();
  const evidence:NativeOrphanResetSource={requestId:intent.requestId,before:pin(before),beforeJournal:pin(Buffer.alloc(0)),completed:pin(db.serialize()),completedJournal:pin(Buffer.from(JSON.stringify(intent)+'\n'))};
  const source=memory(evidence.completed.bytes),original=memory(before);
  // Simulate a mixed restore with genuine completed authority intact, rather
  // than inventing a completed marker or copying a new reset intent.
  for(const table of ['music_shouts','music_shout_authors','music_documents','migration_map']){
    source.prepare('DELETE FROM '+table).run();
    const cols=(original.prepare('PRAGMA table_xinfo('+table+')').all() as {name:string}[]).map(row=>row.name);
    const insert=source.prepare('INSERT INTO '+table+'(rowid,'+cols.join(',')+') VALUES('+Array(cols.length+1).fill('?').join(',')+')');
    for(const row of original.prepare('SELECT rowid AS _rid,* FROM '+table+' ORDER BY rowid').all() as Record<string,unknown>[])insert.run(row._rid,...cols.map(col=>row[col]));
  }
  source.exec("INSERT INTO music_profiles VALUES('later-profile','owner',1,'after',NULL); INSERT INTO music_entries VALUES('later-entry','後來詞條','main'); INSERT INTO music_shouts VALUES('later-shout','later-profile','','後來成分','後來留言',2001.25,NULL,2); INSERT INTO music_shout_authors VALUES('later-profile',2001.25); UPDATE rebuild_storage SET recovery_required=1 WHERE id=1");
  source.prepare("INSERT INTO music_documents VALUES('trend_sample',1,?)").run(JSON.stringify({t:2001.25,counts:{opaque:3}}));
  const candidate=memory(source.serialize());
  return {source,candidate,evidence,journal,intent,repair:()=>candidate.transaction(()=>repairAppliedNativeOrphanResetGlobal(candidate,journal,evidence)).immediate(),verify:()=>reconcileAppliedNativeOrphanResetGlobal(source,candidate,journal,evidence)};
}

it('verifies every row of the genuine empty-profile reset transition without replaying an administrative writer',()=>{
  const s=setup(),original=Buffer.from(s.evidence.before.bytes),completed=Buffer.from(s.evidence.completed.bytes);
  expect(verifyNativeOrphanResetSource(s.evidence)).toMatchObject({requestId:s.intent.requestId,erasedRows:7,allTransitionRowsVerified:true,stoppedCaptureCustodyVerified:false,allResetGenerationsReconciled:false,releaseEligible:false});
  expect(s.evidence.before.bytes).toEqual(original);expect(s.evidence.completed.bytes).toEqual(completed);
});

it('removes restored original anonymous shouts, trend samples and publication records while retaining later generations and all authority',()=>{
  const s=setup(),original=s.source.serialize();s.repair();
  expect(s.verify()).toMatchObject({removedRows:7,changedRows:4,allRowsVerified:true,releaseEligible:false});
  expect(s.candidate.prepare('SELECT id FROM music_shouts').all()).toEqual([{id:'later-shout'}]);
  expect(s.candidate.prepare('SELECT profile_id FROM music_shout_authors').all()).toEqual([{profile_id:'later-profile'}]);
  expect(s.candidate.prepare('SELECT kind,position FROM music_documents ORDER BY rowid').all()).toEqual([{kind:'settings',position:0},{kind:'trend_sample',position:1}]);
  for(const table of ['users','music_profiles','music_entries','privacy_receipts','erasure_applied','music_catalog_actions','bot_outbox','bot_settings','bot_runtime','sqlite_sequence'])expect([...forwardRows(s.candidate,table)],table).toEqual([...forwardRows(s.source,table)]);
  expect(s.source.serialize()).toEqual(original);const repaired=s.candidate.serialize();s.repair();expect(s.candidate.serialize()).toEqual(repaired);
});

it.each(['before bytes','completed bytes','before journal','completed journal','request identity','profile scope','completion result','extra completed row','collateral completed change','missing completed marker'])('rejects a mismatched source pair before writing: %s',change=>{
  const s=setup();
  if(change==='before bytes')s.evidence.before.bytes[100]=s.evidence.before.bytes[100]!^1;
  if(change==='completed bytes')s.evidence.completed.bytes[100]=s.evidence.completed.bytes[100]!^1;
  if(change==='before journal')s.evidence.beforeJournal=pin(Buffer.from(JSON.stringify(s.intent)+'\n'));
  if(change==='completed journal')s.evidence.completedJournal=pin(Buffer.from(JSON.stringify({...s.intent,signature:hash('changed')})+'\n'));
  if(change==='request identity')s.evidence.requestId=randomUUID();
  if(change==='profile scope'){
    const db=memory(s.evidence.before.bytes);db.exec("INSERT INTO music_profiles VALUES('unexpected-active',NULL,0,'before',NULL)");s.evidence.before=pin(db.serialize());
  }
  if(['completion result','extra completed row','collateral completed change','missing completed marker'].includes(change)){
    const db=memory(s.evidence.completed.bytes);
    if(change==='completion result')db.prepare("UPDATE privacy_receipts SET result_json=json_set(result_json,'$.entries',1)").run();
    if(change==='extra completed row')db.prepare("INSERT INTO music_entries VALUES('unexpected','extra','sub')").run();
    if(change==='collateral completed change')db.prepare("UPDATE users SET nickname='changed'").run();
    if(change==='missing completed marker')db.prepare('DELETE FROM erasure_applied').run();
    s.evidence.completed=pin(db.serialize());
  }
  const original=s.candidate.serialize();expect(()=>s.repair()).toThrow();expect(s.candidate.serialize()).toEqual(original);
});

it.each(['shout ID','document slot','author ID','mapping provenance','shadow at new slot','authority receipt','candidate lineage'])('requires explicit generation evidence for reused or changed candidate identity: %s',change=>{
  const s=setup();
  if(change==='shout ID')s.candidate.exec("UPDATE music_shouts SET body='同 ID 的後來留言' WHERE id='original-active'");
  if(change==='document slot')s.candidate.exec("UPDATE music_documents SET payload_json='{\"t\":9999,\"counts\":{}}' WHERE kind='trend'");
  if(change==='author ID')s.candidate.exec("UPDATE music_shout_authors SET last_post_at=3000 WHERE profile_id='inactive'");
  if(change==='mapping provenance')s.candidate.exec("UPDATE migration_map SET payload_digest='new-generation' WHERE source='music' AND entity_type='trend'");
  if(change==='shadow at new slot')s.candidate.prepare("INSERT INTO music_documents VALUES('shouts',2,?)").run(JSON.stringify({id:'original-active',text:'後來來源'}));
  if(change==='authority receipt')s.candidate.exec("UPDATE privacy_receipts SET result_json=json_set(result_json,'$.profiles',1)");
  if(change==='candidate lineage')Object.assign(s.evidence,setup().evidence);
  const original=s.candidate.serialize();expect(()=>s.repair()).toThrow();expect(s.candidate.serialize()).toEqual(original);
});

it.each(['unremoved original','later shout','later trend','settings','other mapping','bot state','extra row'])('independent complete-row oracle rejects an invalid repair: %s',change=>{
  const s=setup();if(change!=='unremoved original')s.repair();
  if(change==='later shout')s.candidate.exec("DELETE FROM music_shouts WHERE id='later-shout'");
  if(change==='later trend')s.candidate.exec("DELETE FROM music_documents WHERE kind='trend_sample' AND position=1");
  if(change==='settings')s.candidate.exec("DELETE FROM music_documents WHERE kind='settings'");
  if(change==='other mapping')s.candidate.exec("UPDATE migration_map SET status='deleted' WHERE source='other'");
  if(change==='bot state')s.candidate.exec('DELETE FROM bot_runtime WHERE id=1');
  if(change==='extra row')s.candidate.exec("INSERT INTO music_entries VALUES('unexpected','extra','sub')");
  expect(()=>s.verify()).toThrow();
});

it('rolls back the complete repair when its independent oracle rejects collateral data loss',()=>{
  const s=setup(),original=s.candidate.serialize();
  expect(()=>s.candidate.transaction(()=>{repairAppliedNativeOrphanResetGlobal(s.candidate,s.journal,s.evidence);s.candidate.exec("DELETE FROM music_shouts WHERE id='later-shout'");s.verify();}).immediate()).toThrow('reconciliation failed');
  expect(s.candidate.serialize()).toEqual(original);
});

it('requires an isolated memory transaction with foreign keys before touching the restored image',()=>{
  const s=setup(),original=s.candidate.serialize();expect(()=>repairAppliedNativeOrphanResetGlobal(s.candidate,s.journal,s.evidence)).toThrow('held foreign-key transaction');
  s.candidate.pragma('foreign_keys = OFF');expect(()=>s.repair()).toThrow('held foreign-key transaction');expect(s.candidate.serialize()).toEqual(original);
});

it('verifies every serialized SQLite row and storage class with an independent Python process',()=>{
  const s=setup();s.repair();const root=mkdtempSync(join(tmpdir(),'qgroup-orphan-reset-oracle-'));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
  for(const [name,bytes] of [['before',s.evidence.before.bytes],['source',s.source.serialize()],['candidate',s.candidate.serialize()]] as const)writeFileSync(join(root,name+'.sqlite3'),bytes,{mode:0o600});
  const result=JSON.parse(execFileSync('python3',['apps/api/testsupport/native-orphan-reset-row-oracle.py',root],{encoding:'utf8',timeout:10000}));
  expect(result).toMatchObject({removedRows:7,changedRows:4,allRowsAndStorageVerified:true});expect(result.allTables).toBeGreaterThan(80);
});

it('rejects an identical original ID and body reused after a genuinely completed later reset',()=>{
  const s=setup(),scope=musicErasureScope(s.candidate),later:ErasureIntent={...s.intent,requestId:randomUUID(),profiles:scope.profiles,entries:scope.entries,createdAt:'2026-11-21T02:00:00.000Z',signature:hash('genuine-later-reset')};
  s.journal.append(later);createPrivacy(s.candidate,s.journal);
  s.candidate.exec("INSERT INTO music_shouts(rowid,id,profile_id,legacy_key,name,body,created_at,archived_at,ordinal) VALUES(1,'original-active',NULL,'anon','匿名','原活躍留言',1000.25,NULL,0)");
  const original=s.candidate.serialize();expect(()=>s.repair()).toThrow('later reset requires generation ancestry');expect(s.candidate.serialize()).toEqual(original);
});
