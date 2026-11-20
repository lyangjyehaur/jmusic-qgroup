import Database from 'better-sqlite3';
import {openDatabase} from '@qgroup/database';
import {randomUUID} from 'node:crypto';
import {afterEach,expect,it} from 'vitest';
import {fixture} from '../testsupport/fixture';
import {adminCatalogFixture,catalogProfiles} from '../testsupport/admin-catalog-fixture';
import {createPrivacy,replayMusicErasure} from './privacy';
import {hash} from './security';
import type {ErasureIntent,ErasureJournal} from './erasure-journal';
import {forwardHash,forwardRows} from '../../../tools/migration/forward-board-storage';
import {reconcileAppliedMusicRepair,type MusicRepairContext} from '../../../tools/migration/forward-music-repair-reconciliation';

const cleanup:(()=>void)[]=[];afterEach(()=>cleanup.splice(0).reverse().forEach(close=>close()));
function setup(){
  const db=openDatabase(':memory:');cleanup.push(()=>db.close());fixture(db);adminCatalogFixture(db);const id=catalogProfiles.bob;
  db.exec("INSERT INTO music_account_epochs VALUES('alice',7); INSERT INTO music_account_epochs VALUES('bob',9007199254740993); INSERT INTO bot_outbox(event_id,kind,dedupe_key,payload_json,created_at) VALUES('listen','activity_published','private-oracle','{}','before')");
  db.prepare("INSERT INTO music_profile_contacts VALUES(?,'10002','legacy',1,'before')").run(id);
  for(const table of ['music_contact_history','music_field_history','music_profile_audit'])db.prepare(`INSERT INTO ${table}(profile_id,revision,actor_id,before_json,after_json,created_at) VALUES(?,1,'bob','{}','{"private":true}','before')`).run(id);
  db.prepare("INSERT INTO music_ownership_history(profile_id,revision,actor_ref,before_user_id,after_user_id,reason,created_at) VALUES(?,1,'account:bob','bob',NULL,'original','before')").run(id);
  db.prepare("INSERT INTO music_pin_history(profile_id,revision,user_id,actor_ref,reason,created_at) VALUES(?,1,'bob','account:bob','original','before')").run(id);
  db.prepare("INSERT INTO music_entry_creations VALUES(?,'sub-0',0)").run(id);
  for(const [attempt,status] of [['ordinary','verified'],['claim-attempt','verified'],['completed-attempt','completed']] as const){
    db.prepare("INSERT INTO login_attempts(id,token_hash,user_id,provider,mode,status,expires_at,created_at,app_id,union_id) VALUES(?,'synthetic-token','bob','qq','bind',?,'2099','before','synthetic','original-union')").run(attempt,status);
    if(attempt!=='ordinary')db.prepare("INSERT INTO music_claim_intents VALUES(?,'synthetic-token','bob',?,0,'proof','digest',0,'authorized',?,'synthetic','subject','2099','before')").run(attempt,id,attempt);
  }
  db.exec("INSERT INTO request_results VALUES('bob','original-save','signature','original-response',200,'before'); INSERT INTO music_legacy_identity VALUES('sessions',9007199254740993,'{\"qq\":\"10002\",\"large\":9007199254740993}'); INSERT INTO migration_map VALUES('music-identity','sessions','9007199254740993','target','revision','digest','imported'); INSERT INTO music_documents VALUES('unrelated',0,'{\"large\":9007199254740993}')");
  db.prepare("INSERT INTO music_profile_receipts VALUES('bob','original-save',?)").run(id);
  db.prepare("INSERT INTO migration_map VALUES('music','profile','10002',?,'revision','digest','imported')").run(id);
  db.exec("INSERT INTO migration_map VALUES('music','entry','original-entry','sub-1','revision','digest','imported'); INSERT INTO migration_map VALUES('music','shouts','0','original-shout','revision','digest','imported')");
  db.prepare("INSERT INTO music_documents VALUES('profile_source',0,?)").run(JSON.stringify({profileId:id,legacyKey:'10002',private:'original'}));
  db.prepare("INSERT INTO music_documents VALUES('profile_retirement',0,?)").run(JSON.stringify({profileId:id,private:'original'}));
  db.exec("INSERT INTO music_documents VALUES('entry_source',0,'{\"entryId\":\"sub-1\",\"entry\":{\"createdBy\":\"10002\"},\"large\":9007199254740993,\"exponent\":1e+05}'); INSERT INTO music_documents VALUES('shouts',0,'{\"id\":\"original-shout\",\"qq\":\"10002\"}')");
  db.prepare("INSERT INTO music_shouts VALUES('original-shout',?,'10002','原成分','原留言',1000.25,NULL,0)").run(id);db.prepare('INSERT INTO music_shout_authors VALUES(?,1000.25)').run(id);
  db.prepare("INSERT INTO music_shouts VALUES('unrelated-shout',?,'10001','其他成分','其他留言',1000.5,NULL,1)").run(catalogProfiles.alice);
  const before=db.serialize(),rows:ErasureIntent[]=[],journal:ErasureJournal={read:()=>structuredClone(rows),append:entry=>rows.push(structuredClone(entry))},privacy=createPrivacy(db,journal);
  const intent:ErasureIntent={version:1,kind:'music',userId:'bob',profileId:id,requestId:randomUUID(),createdAt:'2026-11-21T12:00:00.000Z',secretHash:hash('synthetic-private-repair'),signature:hash(randomUUID())};privacy.submit(intent);privacy.guard();
  const original=new Database(before);cleanup.push(()=>original.close());
  const restore=(table:string)=>{
    const columns=(original.prepare(`PRAGMA table_xinfo("${table}")`).all() as {name:string}[]).map(r=>r.name),insert=db.prepare(`INSERT OR REPLACE INTO "${table}"(rowid,${columns.join(',')}) VALUES(${Array(columns.length+1).fill('?').join(',')})`);
    for(const row of original.prepare(`SELECT rowid AS original_rowid,* FROM "${table}"`).safeIntegers(true).all() as Record<string,unknown>[])insert.run(row.original_rowid,...columns.map(c=>row[c]));
  };
  db.prepare("UPDATE music_profiles SET user_id='bob',erased_at=NULL WHERE id=?").run(id);
  for(const table of ['music_legacy_profiles','music_profile_contacts','music_contact_history','music_ownership_history','music_pin_history','music_field_history','music_profile_fields','music_profile_audit','music_claim_intents','music_selections','music_entry_creations','music_shouts','music_shout_authors','music_legacy_identity','music_documents','migration_map','music_entry_details','login_attempts','request_results','music_profile_receipts'])restore(table);
  const source=new Database(db.serialize()),candidate=new Database(db.serialize());source.pragma('foreign_keys = ON');candidate.pragma('foreign_keys = ON');cleanup.push(()=>source.close(),()=>candidate.close());
  const context:MusicRepairContext={authoritySha256:'1'.repeat(64),headRecordSha256:null,legacyScopes:[]};
  const repair=()=>candidate.transaction(()=>{
    if(!context.legacyScopes.some(r=>r.profileId===id))replayMusicErasure(candidate,id,null,rows.at(-1)!.createdAt);
    for(const scope of context.legacyScopes){
      if(!candidate.prepare("SELECT 1 FROM migration_map WHERE source='music' AND entity_type='profile' AND source_id=?").get(scope.legacyKey))candidate.prepare("INSERT INTO migration_map VALUES('music','profile',?,?,?,?,'erased')").run(scope.legacyKey,scope.profileId,'',forwardHash(JSON.stringify({authority:context.authoritySha256,head:context.headRecordSha256,key:scope.legacyKey,profileId:scope.profileId})));
      replayMusicErasure(candidate,scope.profileId,null,scope.stamp);candidate.prepare('INSERT INTO music_legacy_erasures VALUES(?,?) ON CONFLICT(legacy_key) DO UPDATE SET erased_at_json=excluded.erased_at_json').run(scope.legacyKey,scope.originalTimeJson);
    }
  }).immediate();
  const check=()=>reconcileAppliedMusicRepair(source,candidate,journal,context);
  return {source,candidate,journal,context,id,rows,repair,check};
}

it('independently verifies the complete music repair while preserving every unrelated row, authority and bot work',()=>{
  const s=setup(),before=s.source.serialize();s.repair();expect(s.check()).toMatchObject({profileScopes:1,allRowsVerified:true,oracleUsesServiceWriter:false,releaseEligible:false});
  expect(s.source.serialize()).toEqual(before);expect([...forwardRows(s.candidate,'bot_outbox')]).toEqual([...forwardRows(s.source,'bot_outbox')]);
  expect(s.candidate.prepare("SELECT status,union_id FROM login_attempts WHERE id='ordinary'").get()).toEqual({status:'verified',union_id:'original-union'});
  expect(s.candidate.prepare("SELECT status,union_id FROM login_attempts WHERE id='completed-attempt'").get()).toEqual({status:'completed',union_id:'original-union'});
  expect(s.candidate.prepare("SELECT epoch FROM music_account_epochs WHERE user_id='bob'").safeIntegers(true).get()).toEqual({epoch:9007199254740995n});
  expect(s.candidate.prepare("SELECT payload_json FROM music_documents WHERE kind='entry_source'").get()).toEqual({payload_json:'{"entryId":"sub-1","entry":{"createdBy":""},"large":9007199254740993,"exponent":1e+05}'});
});

it.each(['private fields','contact','ownership history','claim','claim proof','saved result','creator','creator mapping','identity mapping','shout mapping','opaque number','unrelated login','unrelated selection','unrelated source','unrelated shout','bot state','new history','new receipt','authority','owner epoch','sequence'])('rejects incomplete music repair or collateral mutation: %s',change=>{
  const s=setup();s.repair();const sql:Record<string,string>={
    'private fields':`INSERT INTO music_profile_fields VALUES('${s.id}','未刪除','',0,'',0,0,'before')`,
    contact:`INSERT INTO music_profile_contacts VALUES('${s.id}','10002','legacy',1,'before')`,
    'ownership history':`INSERT INTO music_ownership_history(profile_id,revision,actor_ref,before_user_id,after_user_id,reason,created_at) VALUES('${s.id}',2,'account:bob','bob',NULL,'new','later')`,
    claim:`INSERT INTO music_claim_intents VALUES('new-claim','synthetic-token','bob','${s.id}',0,'proof','digest',0,'pending',NULL,'','','2099','before')`,
    'claim proof':"UPDATE login_attempts SET status='verified',union_id='original-union' WHERE id='claim-attempt'",
    'saved result':"UPDATE request_results SET response_status=200 WHERE request_key='original-save'",
    creator:"UPDATE music_entry_details SET created_by='10002' WHERE entry_id='sub-1'",
    'creator mapping':"UPDATE migration_map SET status='imported' WHERE source='music' AND entity_type='entry'",
    'identity mapping':"UPDATE migration_map SET status='imported' WHERE source='music-identity'",
    'shout mapping':"UPDATE migration_map SET status='imported' WHERE source='music' AND entity_type='shouts'",
    'opaque number':"UPDATE music_documents SET payload_json=replace(payload_json,'9007199254740993','9007199254740992') WHERE kind='entry_source'",
    'unrelated login':"DELETE FROM login_attempts WHERE id='ordinary'",
    'unrelated selection':`DELETE FROM music_selections WHERE profile_id='${catalogProfiles.alice}'`,
    'unrelated source':"UPDATE music_documents SET payload_json='{}' WHERE kind='unrelated'",
    'unrelated shout':"DELETE FROM music_shouts WHERE id='unrelated-shout'",
    'bot state':"UPDATE bot_outbox SET status='failed' WHERE status='pending'",
    'new history':`INSERT INTO music_field_history(profile_id,revision,actor_id,before_json,after_json,created_at) VALUES('${catalogProfiles.alice}',99,'alice','{}','{}','later')`,
    'new receipt':`UPDATE music_profile_receipts SET profile_id='${catalogProfiles.alice}' WHERE request_key='original-save'`,
    authority:'DELETE FROM privacy_receipts',
    'owner epoch':"UPDATE music_account_epochs SET epoch=epoch-1 WHERE user_id='bob'",
    sequence:"UPDATE sqlite_sequence SET seq=seq+100 WHERE name='music_field_history'",
  };s.candidate.exec(sql[change]!);const before=s.candidate.serialize();expect(()=>s.check()).toThrow();expect(s.candidate.serialize()).toEqual(before);
});

it('verifies an exact legacy override and new missing tombstone/mapping without rounding original time JSON',()=>{
  const s=setup();s.context.legacyScopes=[{legacyKey:'90099',profileId:'missing-original-profile',stamp:'2026-11-21T13:00:00.000Z',originalTimeJson:'{"original":9007199254740993,"exponent":1e+05}'}];s.repair();expect(s.check()).toMatchObject({profileScopes:2,legacyScopes:1,addedRows:3,allRowsVerified:true,externalLegacyScopeIndependentlyDerived:false});
  expect(s.candidate.prepare("SELECT erased_at_json FROM music_legacy_erasures WHERE legacy_key='90099'").get()).toEqual({erased_at_json:'{"original":9007199254740993,"exponent":1e+05}'});
  s.candidate.exec("UPDATE migration_map SET payload_digest='forged' WHERE source_id='90099'");expect(()=>s.check()).toThrow();
});

it('rejects a legacy override which rebinds an original key to another profile',()=>{
  const s=setup();s.context.legacyScopes=[{legacyKey:'10002',profileId:catalogProfiles.alice,stamp:'2026-11-21T13:00:00.000Z',originalTimeJson:'123'}];s.repair();expect(()=>s.check()).toThrow();
});

it('uses latest applied journal order even when its wall-clock timestamp goes backwards',()=>{
  const s=setup(),later:ErasureIntent={version:1,kind:'music',userId:'bob',profileId:s.id,requestId:randomUUID(),createdAt:'2026-11-21T11:00:00.000Z',secretHash:hash('later-secret'),signature:hash(randomUUID())};
  for(const db of [s.source,s.candidate]){const journal:ErasureJournal={read:()=>[...s.rows],append:()=>{}};createPrivacy(db,journal).submit(later);}s.rows.push(later);
  // Both disposable images now contain the later applied intent. The oracle
  // must preserve its exact timestamp even when a replay is already idempotent.
  s.repair();expect(s.check().allRowsVerified).toBe(true);expect(s.candidate.prepare('SELECT erased_at FROM music_profiles WHERE id=?').get(s.id)).toEqual({erased_at:later.createdAt});
  s.candidate.prepare('UPDATE music_profiles SET erased_at=? WHERE id=?').run(s.rows[0]!.createdAt,s.id);expect(()=>s.check()).toThrow();
});

it('preserves SQLite automatic rowids when the retained table maximum is negative',()=>{
  const s=setup();for(const db of [s.source,s.candidate])db.exec("DELETE FROM music_account_epochs WHERE user_id='bob'; UPDATE music_account_epochs SET rowid=-2 WHERE user_id='alice'; UPDATE music_legacy_erasures SET rowid=-2");
  s.context.legacyScopes=[{legacyKey:'90099',profileId:'missing-original-profile',stamp:'2026-11-21T13:00:00.000Z',originalTimeJson:'123'}];s.repair();expect(s.check().allRowsVerified).toBe(true);
  expect(s.candidate.prepare("SELECT rowid FROM music_account_epochs WHERE user_id='bob'").safeIntegers(true).get()).toEqual({rowid:-1n});
  expect(s.candidate.prepare("SELECT rowid FROM music_legacy_erasures WHERE legacy_key='90099'").safeIntegers(true).get()).toEqual({rowid:-1n});
});

it('rejects unprovable randomized automatic rowid allocation at the SQLite maximum',()=>{
  const s=setup();for(const db of [s.source,s.candidate])db.prepare('UPDATE music_profiles SET rowid=9223372036854775807 WHERE id=?').run(catalogProfiles.alice);
  s.context.legacyScopes=[{legacyKey:'90099',profileId:'missing-original-profile',stamp:'2026-11-21T13:00:00.000Z',originalTimeJson:'123'}];s.repair();expect(()=>s.check()).toThrow();
});
