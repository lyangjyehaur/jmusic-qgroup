import Database from 'better-sqlite3';
import {openDatabase} from '@qgroup/database';
import {randomUUID} from 'node:crypto';
import {afterEach,expect,it} from 'vitest';
import {fixture} from '../testsupport/fixture';
import {adminCatalogFixture,catalogProfiles} from '../testsupport/admin-catalog-fixture';
import {createPrivacy} from './privacy';
import {musicErasureScope} from './admin-music-erasure';
import {hash} from './security';
import type {ErasureIntent,ErasureJournal} from './erasure-journal';
import {forwardHash,forwardRows} from '../../../tools/migration/forward-board-storage';
import {assertAppliedNativeResetCandidateBoundary,repairAppliedNativeResetGlobal,type NativeResetSource} from '../../../tools/migration/forward-native-orphan-reset';

const cleanup:(()=>void)[]=[];afterEach(()=>cleanup.splice(0).reverse().forEach(close=>close()));
const pin=(bytes:Buffer)=>({bytes,sha256:forwardHash(bytes)});
function setup(){
  const db=openDatabase(':memory:');cleanup.push(()=>db.close());fixture(db);adminCatalogFixture(db);
  const id=catalogProfiles.bob;
  db.prepare("INSERT INTO music_profile_contacts VALUES(?,'10002','legacy',1,'before')").run(id);
  for(const table of ['music_contact_history','music_field_history','music_profile_audit'])db.prepare(`INSERT INTO ${table}(profile_id,revision,actor_id,before_json,after_json,created_at) VALUES(?,1,'bob','{}','{"private":true}','before')`).run(id);
  db.prepare("INSERT INTO music_ownership_history(profile_id,revision,actor_ref,before_user_id,after_user_id,reason,created_at) VALUES(?,1,'account:bob','bob',NULL,'original','before')").run(id);
  db.prepare("INSERT INTO music_pin_history(profile_id,revision,user_id,actor_ref,reason,created_at) VALUES(?,1,'bob','account:bob','original','before')").run(id);
  db.prepare("INSERT INTO music_entry_creations VALUES(?,'sub-0',0)").run(id);
  db.prepare("INSERT INTO login_attempts(id,token_hash,user_id,provider,mode,status,expires_at,created_at,app_id,union_id) VALUES('claim-attempt','synthetic-token','bob','qq','bind','verified','2099','before','synthetic','original-union')").run();
  db.prepare("INSERT INTO music_claim_intents VALUES('claim','synthetic-token','bob',?,0,'proof','digest',0,'authorized','claim-attempt','synthetic','subject','2099','before')").run(id);
  db.prepare("INSERT INTO request_results VALUES('bob','original-save','signature','original-response',200,'before')").run();
  db.prepare("INSERT INTO music_profile_receipts VALUES('bob','original-save',?)").run(id);
  db.prepare("INSERT INTO migration_map VALUES('music','profile','10002',?,'revision','digest','imported')").run(id);
  db.exec("INSERT INTO music_legacy_identity VALUES('sessions',0,'{\"qq\":\"10002\",\"large\":9007199254740993,\"exponent\":1e+05}'); INSERT INTO migration_map VALUES('music-identity','sessions','0','original-target','revision','digest','imported')");
  db.exec("INSERT INTO music_legacy_identity VALUES('sessions',9007199254740993,'{\"qq\":\"10002\",\"large\":9007199254740993}'); INSERT INTO migration_map VALUES('music-identity','sessions','9007199254740993','large-original-target','revision','digest','imported')");
  db.prepare("INSERT INTO music_documents VALUES('profile_source',0,?)").run(JSON.stringify({profileId:id,legacyKey:'10002',private:'original'}));
  db.prepare("INSERT INTO music_documents VALUES('profile_retirement',0,?)").run(JSON.stringify({profileId:id,private:'original'}));
  db.prepare("INSERT INTO music_documents VALUES('entry_source',0,?)").run('{"entryId":"absent-entry","entry":{"createdBy":"10002"},"large":9007199254740993,"exponent":1e+05}');
  db.prepare("INSERT INTO music_shouts VALUES('original-shout',?,'10002','原成分','原留言',1000.25,NULL,0)").run(id);
  db.prepare('INSERT INTO music_shout_authors VALUES(?,1000.25)').run(id);
  const rows:ErasureIntent[]=[],journal:ErasureJournal={read:()=>structuredClone(rows),append:entry=>rows.push(structuredClone(entry))},scope=musicErasureScope(db),intent:ErasureIntent={version:2,kind:'admin_music',command:'reset_music',actorRef:'account:alice',profiles:scope.profiles,entries:scope.entries,requestId:randomUUID(),createdAt:'2026-11-21T12:00:00.000Z',secretHash:hash('synthetic-profile-boundary'),signature:hash(randomUUID())},before=db.serialize(),privacy=createPrivacy(db,journal);
  privacy.submit(intent);privacy.guard();
  const evidence:NativeResetSource={requestId:intent.requestId,before:pin(before),beforeJournal:pin(Buffer.alloc(0)),completed:pin(db.serialize()),completedJournal:pin(Buffer.from(JSON.stringify(intent)+'\n'))};
  const candidate=new Database(evidence.completed.bytes),original=new Database(before);candidate.pragma('foreign_keys = ON');cleanup.push(()=>candidate.close(),()=>original.close());
  const restore=(table:string,where='1',offset=0n)=>{
    const metadata=original.prepare(`PRAGMA table_xinfo("${table}")`).all() as {name:string;type:string;pk:number}[],columns=metadata.map(r=>r.name),primary=metadata.filter(r=>r.pk),rowidAlias=primary.length===1&&primary[0]!.type==='INTEGER'?primary[0]!.name:null,insert=candidate.prepare(`INSERT OR REPLACE INTO "${table}"(rowid,${columns.join(',')}) VALUES(${Array(columns.length+1).fill('?').join(',')})`);
    for(const row of original.prepare(`SELECT rowid AS original_rowid,* FROM "${table}" WHERE ${where}`).safeIntegers(true).all() as (Record<string,unknown>&{original_rowid:bigint})[])insert.run(row.original_rowid+offset,...columns.map(c=>c===rowidAlias&&typeof row[c]==='bigint'?row[c]+offset:row[c]));
  };
  candidate.exec("INSERT INTO music_profiles VALUES('later-profile','alice',0,'later',NULL); UPDATE music_profile_creation SET rowid=5000 WHERE profile_id='later-profile'; INSERT INTO music_entries(rowid,id,name,kind) VALUES(5000,'later-entry','後來詞條','sub'); INSERT INTO music_profile_fields(rowid,profile_id,name,note,note_at,gender,gender_public,revision,updated_at) VALUES(5000,'later-profile','後來成分','',0,'',0,0,'later'); INSERT INTO music_profile_contacts(rowid,profile_id,contact_qq,source,revision,updated_at) VALUES(5000,'later-profile','99999','self_reported',0,'later'); INSERT INTO music_selections(rowid,profile_id,entry_id,level,position) VALUES(5000,'later-profile','later-entry',4,0)");
  const check=()=>assertAppliedNativeResetCandidateBoundary(candidate,journal,evidence),repair=()=>candidate.transaction(()=>repairAppliedNativeResetGlobal(candidate,journal,evidence)).immediate();
  const unchangedRejection=()=>{const bytes=candidate.serialize();expect(()=>check()).toThrow();expect(()=>repair()).toThrow();expect(candidate.serialize()).toEqual(bytes);};
  return {candidate,original,evidence,journal,id,restore,check,repair,unchangedRejection};
}

it('accepts exact original private relationships and both original and completed proof/result bytes without touching later profiles',()=>{
  const s=setup();s.check();s.restore('music_entries');
  for(const table of ['music_profile_creation','music_legacy_profiles','music_profile_contacts','music_contact_history','music_ownership_history','music_pin_history','music_field_history','music_profile_fields','music_profile_audit','music_claim_intents','music_profile_receipts','music_selections','music_entry_creations','music_shouts','music_shout_authors','music_legacy_identity'])s.restore(table);
  s.restore('music_documents');s.restore('login_attempts');s.restore('request_results');s.check();
  const bytes=s.candidate.serialize();s.check();expect(s.candidate.serialize()).toEqual(bytes);s.repair();
  expect(s.candidate.prepare("SELECT name FROM music_profile_fields WHERE profile_id='later-profile'").get()).toEqual({name:'後來成分'});
  expect(s.candidate.prepare("SELECT level FROM music_selections WHERE profile_id='later-profile'").get()).toEqual({level:4});
});

it.each(['music_profile_creation','music_legacy_profiles','music_profile_contacts','music_contact_history','music_ownership_history','music_pin_history','music_field_history','music_profile_fields','music_profile_audit','music_claim_intents','music_profile_receipts'])('rejects original profile relationship rowid reuse before writers: %s',table=>{
  const s=setup();s.restore(table,"profile_id='"+(table==='music_profile_creation'?catalogProfiles.alice:s.id)+"'",100n);s.unchangedRejection();
});

it.each(['contact','field','claim','new alias','new receipt','new selection','new creation','new history','new shout','new shout author','identity payload','new identity slot','identity mapping','profile mapping','profile source','retirement source','new source slot','creator source','proof data','saved result'])('rejects changed or new private relationships under an original tombstone: %s',change=>{
  const s=setup(),id=s.id;
  const sql:Record<string,string>={
    contact:`INSERT INTO music_profile_contacts VALUES('${id}','123456','self_reported',0,'later')`,
    field:`INSERT INTO music_profile_fields VALUES('${id}','後來資料','',0,'',0,0,'later')`,
    claim:`INSERT INTO music_claim_intents VALUES('later-claim','later-token','bob','${id}',0,'later-proof','later-digest',0,'pending',NULL,'','','2099','later')`,
    'new alias':`INSERT INTO migration_map VALUES('music','profile','later-alias','${id}','later','later','imported')`,
    'new receipt':`INSERT INTO request_results VALUES('bob','later-save','later-signature','later-response',200,'later'); INSERT INTO music_profile_receipts VALUES('bob','later-save','${id}')`,
    'new selection':`INSERT INTO music_selections VALUES('${id}','later-entry',4,0)`,
    'new creation':`INSERT INTO music_entry_creations VALUES('${id}','later-entry',0)`,
    'new history':`INSERT INTO music_contact_history(profile_id,revision,actor_id,before_json,after_json,created_at) VALUES('${id}',2,'bob','{}','{"later":true}','later')`,
    'new shout':`INSERT INTO music_shouts VALUES('later-shout-old-profile','${id}','10002','後來資料','後來留言',2000.25,NULL,1)`,
    'new shout author':`INSERT INTO music_shout_authors VALUES('${id}',2000.25)`,
    'identity payload':"INSERT INTO music_legacy_identity VALUES('sessions',0,'{\"qq\":\"10002\",\"large\":9007199254740992,\"exponent\":1e+05}')",
    'new identity slot':"INSERT INTO music_legacy_identity VALUES('sessions',9,'{\"qq\":\"10002\",\"later\":true}')",
    'identity mapping':"UPDATE migration_map SET payload_digest='later' WHERE source='music-identity' AND entity_type='sessions' AND source_id='0'",
    'profile mapping':"UPDATE migration_map SET target_id='later-profile' WHERE source='music' AND entity_type='profile' AND source_id='10002'",
    'profile source':`INSERT INTO music_documents VALUES('profile_source',0,'{"profileId":"${id}","private":"later"}')`,
    'retirement source':`INSERT INTO music_documents VALUES('profile_retirement',0,'{"profileId":"${id}","private":"later"}')`,
    'new source slot':`INSERT INTO music_documents VALUES('profile_source',9,'{"profileId":"${id}","private":"later"}')`,
    'creator source':`INSERT INTO music_documents VALUES('entry_source',9,'{"entryId":"later-entry","entry":{"createdBy":"${id}"}}')`,
    'proof data':"UPDATE login_attempts SET openid='later-subject' WHERE id='claim-attempt'",
    'saved result':"UPDATE request_results SET response_json='later-response' WHERE user_id='bob' AND request_key='original-save'",
  };
  if(change==='proof data')s.restore('music_claim_intents');s.candidate.exec(sql[change]!);s.unchangedRejection();
});

it('preserves unrelated login and opaque identity data with exact 64-bit primary keys',()=>{
  const s=setup();s.candidate.exec("INSERT INTO music_legacy_identity VALUES('sessions',9007199254740993,'{\"qq\":\"later-alias\",\"large\":9007199254740993,\"exponent\":1e+05}'); INSERT INTO login_attempts(id,token_hash,user_id,provider,mode,status,expires_at,created_at,app_id) VALUES('ordinary','later-token','alice','qq','bind','verified','2099','later','synthetic')");
  const before=[...forwardRows(s.candidate,'music_legacy_identity')];s.check();s.repair();expect([...forwardRows(s.candidate,'music_legacy_identity')]).toEqual(before);expect(s.candidate.prepare("SELECT status FROM login_attempts WHERE id='ordinary'").get()).toEqual({status:'verified'});
});

it.each(['receipt target','result signature','proof rowid','scoped 64-bit identity key'])('rejects reassigned retained private evidence: %s',change=>{
  const s=setup();
  if(change==='receipt target')s.candidate.exec("UPDATE music_profile_receipts SET profile_id='later-profile' WHERE request_key='original-save'");
  else if(change==='result signature')s.candidate.exec("UPDATE request_results SET signature='later-signature' WHERE request_key='original-save'");
  else if(change==='proof rowid')s.candidate.exec("UPDATE login_attempts SET rowid=rowid+100 WHERE id='claim-attempt'");
  else{s.restore('music_legacy_identity','row_number=9007199254740993');s.candidate.exec('UPDATE music_legacy_identity SET row_number=9007199254740992 WHERE row_number=9007199254740993');}
  s.unchangedRejection();
});
