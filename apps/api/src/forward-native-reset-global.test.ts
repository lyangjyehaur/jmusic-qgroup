import Database from 'better-sqlite3';
import {openDatabase} from '@qgroup/database';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {afterEach,expect,it} from 'vitest';
import {fixture} from '../testsupport/fixture';
import {adminCatalogFixture,catalogProfiles} from '../testsupport/admin-catalog-fixture';
import {createPrivacy} from './privacy';
import {musicErasureScope} from './admin-music-erasure';
import {saveProfile} from './repositories';
import {hash} from './security';
import type {ErasureIntent,ErasureJournal} from './erasure-journal';
import {forwardHash,forwardRows} from '../../../tools/migration/forward-board-storage';
import {verifyNativeResetSource,repairAppliedNativeResetGlobal,reconcileAppliedNativeResetGlobal,type NativeResetSource} from '../../../tools/migration/forward-native-orphan-reset';

const cleanup:(()=>void)[]=[];afterEach(()=>cleanup.splice(0).reverse().forEach(close=>close()));
const pin=(bytes:Buffer)=>({bytes,sha256:forwardHash(bytes)});
const memory=(bytes:Buffer)=>{const db=new Database(bytes);db.pragma('foreign_keys = ON');cleanup.push(()=>db.close());return db;};
function setup(){
  const db=openDatabase(':memory:');cleanup.push(()=>db.close());fixture(db);adminCatalogFixture(db);
  const entries:ErasureIntent[]=[],journal:ErasureJournal={read:()=>structuredClone(entries),append:entry=>entries.push(structuredClone(entry))},privacy=createPrivacy(db,journal);
  db.prepare("INSERT INTO music_shouts VALUES('old-linked',?,'10002','原稱呼','原關聯留言',1000.25,NULL,0),('old-anonymous',NULL,'anon','匿名','原匿名歷史',1000.5,1001.25,1)").run(catalogProfiles.bob);
  db.prepare('INSERT INTO music_shout_authors VALUES(?,1000.25)').run(catalogProfiles.bob);
  for(const [kind,value] of [['shouts',{id:'old-linked',qq:'10002',text:'原關聯留言'}],['shoutHistory',{id:'old-anonymous',qq:'anon',text:'原匿名歷史'}],['trend',{t:1000.25,counts:{'sub-1':2}}],['trend_sample',{t:1001.25,counts:{'sub-1':3}}]] as const)db.prepare('INSERT INTO music_documents VALUES(?,0,?)').run(kind,JSON.stringify(value));
  for(const kind of ['shouts','shoutHistory','trend'])db.prepare("INSERT INTO migration_map VALUES('music',?,'0','old-global','revision','digest','imported')").run(kind);
  db.prepare("INSERT INTO music_legacy_identity VALUES('sessions',200,?)").run(JSON.stringify({qq:'10002',token_hash:'synthetic-old-secret'}));
  for(const name of ['claim','ordinary'])db.prepare("INSERT INTO login_attempts(id,token_hash,user_id,provider,mode,status,expires_at,created_at,app_id,union_id) VALUES(?,'token','bob','qq','bind','verified','2099','before','synthetic','original-union')").run(name);
  db.prepare("INSERT INTO music_claim_intents VALUES('claim','token','bob',?,0,'proof','digest',0,'authorized','claim','synthetic','subject','2099','before')").run(catalogProfiles.bob);
  db.prepare("INSERT INTO request_results VALUES('bob','old-save','original-signature','private-original-response',200,'before')").run();
  db.prepare("INSERT INTO music_profile_receipts VALUES('bob','old-save',?)").run(catalogProfiles.bob);
  const scope=musicErasureScope(db),intent:ErasureIntent={version:2,kind:'admin_music',command:'reset_music',actorRef:'account:alice',profiles:scope.profiles,entries:scope.entries,requestId:randomUUID(),createdAt:'2026-11-21T03:00:00.000Z',secretHash:hash('synthetic-reset-secret'),signature:hash('synthetic-reset-signature')},before=db.serialize();
  privacy.submit(intent);privacy.guard();
  const evidence:NativeResetSource={requestId:intent.requestId,before:pin(before),beforeJournal:pin(Buffer.alloc(0)),completed:pin(db.serialize()),completedJournal:pin(Buffer.from(JSON.stringify(intent)+'\n'))},source=memory(evidence.completed.bytes),original=memory(before);
  for(const table of ['music_shouts','music_shout_authors','music_documents','migration_map']){
    const where=table==='music_documents'?" WHERE kind IN ('shouts','shoutHistory','trend','trend_sample')":table==='migration_map'?" WHERE source='music' AND entity_type IN ('shouts','shoutHistory','trend')":'';
    source.prepare('DELETE FROM '+table+where).run();
    const cols=(original.prepare('PRAGMA table_xinfo('+table+')').all() as {name:string}[]).map(row=>row.name),insert=source.prepare('INSERT INTO '+table+'(rowid,'+cols.join(',')+') VALUES('+Array(cols.length+1).fill('?').join(',')+')');
    for(const row of original.prepare('SELECT rowid AS _rid,* FROM '+table+where+' ORDER BY rowid').all() as Record<string,unknown>[])insert.run(row._rid,...cols.map(col=>row[col]));
  }
  const epoch=(source.prepare("SELECT epoch FROM music_account_epochs WHERE user_id='alice'").get() as {epoch:number}|undefined)?.epoch??0;
  const later=saveProfile(source,'alice',{profileId:null,revision:0,musicEpoch:epoch,selections:[]},new Date('2026-11-21T04:00:00.000Z'));
  source.prepare("INSERT INTO music_entries VALUES('later-entry','後來詞條','sub')").run();
  source.prepare("INSERT INTO music_shouts VALUES('later-shout',?,'','後來稱呼','後來留言',2001.25,NULL,2)").run(later.id);
  source.prepare('INSERT INTO music_shout_authors VALUES(?,2001.25)').run(later.id);
  source.prepare("INSERT INTO music_documents VALUES('trend_sample',1,?)").run(JSON.stringify({t:2001.25,counts:{'later-entry':1}}));
  source.prepare('UPDATE rebuild_storage SET recovery_required=1 WHERE id=1').run();
  const candidate=memory(source.serialize());
  return {source,candidate,evidence,journal,intent,laterId:later.id,repair:()=>candidate.transaction(()=>repairAppliedNativeResetGlobal(candidate,journal,evidence)).immediate(),verify:()=>reconcileAppliedNativeResetGlobal(source,candidate,journal,evidence)};
}

it('verifies a genuine full native reset including linked and unlinked profiles, terms, OAuth proofs, epochs and saved responses',()=>{
  const s=setup(),result=verifyNativeResetSource(s.evidence);
  expect(result).toMatchObject({requestId:s.intent.requestId,allTransitionRowsVerified:true,profileProjectionUsesServiceWriter:true,fullPrivateScopeIndependentlyVerified:false,releaseEligible:false});
  expect(s.intent.profiles.length).toBeGreaterThan(1);expect(s.intent.entries.length).toBeGreaterThan(0);
  const completed=memory(s.evidence.completed.bytes);
  expect(completed.prepare('SELECT 1 FROM music_profiles WHERE erased_at IS NULL').get()).toBeUndefined();expect(completed.prepare('SELECT 1 FROM music_entries').get()).toBeUndefined();
  expect(completed.prepare("SELECT status,union_id FROM login_attempts WHERE id='claim'").get()).toEqual({status:'failed',union_id:''});
  expect(completed.prepare("SELECT status,union_id FROM login_attempts WHERE id='ordinary'").get()).toEqual({status:'verified',union_id:'original-union'});
  expect(completed.prepare("SELECT response_status FROM request_results WHERE request_key='old-save'").get()).toEqual({response_status:410});
});

it('repairs the full reset global generation without erasing the later profile, terms, ordinary login, retained receipts or bot state',()=>{
  const s=setup(),original=s.source.serialize();s.repair();expect(s.verify()).toMatchObject({removedRows:7,changedRows:3,allRowsVerified:true,releaseEligible:false});
  expect(s.candidate.prepare('SELECT id FROM music_shouts').all()).toEqual([{id:'later-shout'}]);expect(s.candidate.prepare('SELECT id FROM music_profiles WHERE erased_at IS NULL').all()).toEqual([{id:s.laterId}]);
  expect(s.candidate.prepare('SELECT id FROM music_entries').all()).toEqual([{id:'later-entry'}]);
  for(const table of ['users','music_profiles','music_account_epochs','music_profile_audit','music_profile_receipts','request_results','login_attempts','music_claim_intents','music_entries','privacy_receipts','erasure_applied','music_catalog_actions','bot_outbox','bot_settings','bot_runtime','sqlite_sequence'])expect([...forwardRows(s.candidate,table)],table).toEqual([...forwardRows(s.source,table)]);
  expect(s.source.serialize()).toEqual(original);const repaired=s.candidate.serialize();s.repair();expect(s.candidate.serialize()).toEqual(repaired);
});

it.each(['profile owner','missing profile','missing term','claim retirement','ordinary login','saved response','account epoch','extra completion row'])('rejects a full reset source that does not match its actual scope or completion: %s',change=>{
  const s=setup();
  if(['profile owner','missing profile','missing term'].includes(change)){
    const intent=structuredClone(s.intent);
    if(change==='profile owner')intent.profiles[0]!.userId=intent.profiles[0]!.userId==='bob'?'alice':'bob';
    if(change==='missing profile')intent.profiles.pop();
    if(change==='missing term')intent.entries.pop();
    s.evidence.completedJournal=pin(Buffer.from(JSON.stringify(intent)+'\n'));
  }else{
    const completed=memory(s.evidence.completed.bytes);
    if(change==='claim retirement')completed.exec("UPDATE login_attempts SET status='verified',union_id='original-union' WHERE id='claim'");
    if(change==='ordinary login')completed.exec("UPDATE login_attempts SET status='failed' WHERE id='ordinary'");
    if(change==='saved response')completed.exec("UPDATE request_results SET response_status=200,response_json='private-original-response' WHERE request_key='old-save'");
    if(change==='account epoch')completed.exec("UPDATE music_account_epochs SET epoch=epoch+1 WHERE user_id='bob'");
    if(change==='extra completion row')completed.exec("INSERT INTO music_entries VALUES('unexpected','extra','main')");
    s.evidence.completed=pin(completed.serialize());
  }
  const original=s.candidate.serialize();expect(()=>s.repair()).toThrow();expect(s.candidate.serialize()).toEqual(original);
});

it.each(['shout identity','trend slot','author record','mapping provenance'])('blocks reused full-reset generation data before writing: %s',change=>{
  const s=setup();
  if(change==='shout identity')s.candidate.exec("UPDATE music_shouts SET body='後來相同 ID 留言' WHERE id='old-linked'");
  if(change==='trend slot')s.candidate.exec("UPDATE music_documents SET payload_json='{\"t\":9999,\"counts\":{}}' WHERE kind='trend'");
  if(change==='author record')s.candidate.prepare('UPDATE music_shout_authors SET last_post_at=3000 WHERE profile_id=?').run(catalogProfiles.bob);
  if(change==='mapping provenance')s.candidate.exec("UPDATE migration_map SET source_revision='different' WHERE source='music' AND entity_type='trend'");
  const original=s.candidate.serialize();expect(()=>s.repair()).toThrow();expect(s.candidate.serialize()).toEqual(original);
});

it.each(['later profile','later login','original receipt','later trend'])('independent global oracle rejects collateral changes after repairing a full reset: %s',change=>{
  const s=setup();s.repair();
  if(change==='later profile')s.candidate.prepare("UPDATE music_profiles SET revision=revision+1 WHERE id=?").run(s.laterId);
  if(change==='later login')s.candidate.exec("UPDATE login_attempts SET status='failed' WHERE id='ordinary'");
  if(change==='original receipt')s.candidate.exec("UPDATE privacy_receipts SET result_json=json_set(result_json,'$.entries',99)");
  if(change==='later trend')s.candidate.exec("DELETE FROM music_documents WHERE kind='trend_sample' AND position=1");
  expect(()=>s.verify()).toThrow();
});

it('verifies a term-only reset and its cascading creation memberships without requiring anonymous history',()=>{
  const db=openDatabase(':memory:');cleanup.push(()=>db.close());
  db.exec("INSERT INTO music_profiles VALUES('inactive',NULL,0,'before','2026-11-20T00:00:00.000Z'); INSERT INTO music_entries VALUES('term-only','原詞條','sub'); INSERT INTO music_entry_details VALUES('term-only','原類別','[]','','',''); INSERT INTO music_entry_creations VALUES('inactive','term-only',0); INSERT INTO music_selections VALUES('inactive','term-only',2,0)");
  const entries:ErasureIntent[]=[],journal:ErasureJournal={read:()=>structuredClone(entries),append:entry=>entries.push(structuredClone(entry))},privacy=createPrivacy(db,journal),before=db.serialize(),intent:ErasureIntent={version:2,kind:'admin_music',command:'reset_music',actorRef:'synthetic-admin',profiles:[],entries:['term-only'],requestId:randomUUID(),createdAt:'2026-11-21T03:00:00.000Z',secretHash:hash('term-only-secret'),signature:hash('term-only-signature')};
  privacy.submit(intent);privacy.guard();const source:NativeResetSource={requestId:intent.requestId,before:pin(before),beforeJournal:pin(Buffer.alloc(0)),completed:pin(db.serialize()),completedJournal:pin(Buffer.from(JSON.stringify(intent)+'\n'))};
  expect(verifyNativeResetSource(source)).toMatchObject({profileScopes:0,entryScopes:1,globalSourceRows:0,allTransitionRowsVerified:true,profileProjectionUsesServiceWriter:false,releaseEligible:false});
  for(const table of ['music_entries','music_entry_details','music_entry_creations','music_selections'])expect(db.prepare('SELECT 1 FROM '+table).get()).toBeUndefined();
});

it('independently verifies all serialized general-reset candidate rows and storage types with Python',()=>{
  const s=setup();s.repair();const root=mkdtempSync(join(tmpdir(),'qgroup-general-reset-oracle-'));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
  for(const [name,bytes] of [['before',s.evidence.before.bytes],['source',s.source.serialize()],['candidate',s.candidate.serialize()]] as const)writeFileSync(join(root,name+'.sqlite3'),bytes,{mode:0o600});
  const result=JSON.parse(execFileSync('python3',['apps/api/testsupport/native-orphan-reset-row-oracle.py',root,'3'],{encoding:'utf8',timeout:10000}));
  expect(result).toMatchObject({removedRows:7,changedRows:3,allRowsAndStorageVerified:true});expect(result.allTables).toBeGreaterThan(80);
});
