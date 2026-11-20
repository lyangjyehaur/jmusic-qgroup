import Database from 'better-sqlite3';
import {openDatabase} from '@qgroup/database';
import {randomUUID} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
import {fixture} from '../testsupport/fixture';
import {adminCatalogFixture,catalogProfiles} from '../testsupport/admin-catalog-fixture';
import {createPrivacy} from './privacy';
import {musicErasureScope} from './admin-music-erasure';
import {hash} from './security';
import type {ErasureIntent,ErasureJournal} from './erasure-journal';
import {forwardHash} from '../../../tools/migration/forward-board-storage';
import {verifyNativeResetSource,type NativeResetSource} from '../../../tools/migration/forward-native-orphan-reset';

const poison=vi.hoisted(()=>({enabled:false,calls:0}));
vi.mock('./privacy',async original=>{
  const actual=await original<typeof import('./privacy')>();
  return {...actual,replayMusicErasure:(...args:Parameters<typeof actual.replayMusicErasure>)=>{
    poison.calls++;actual.replayMusicErasure(...args);
    if(poison.enabled)args[0].exec("UPDATE login_attempts SET status='failed' WHERE id='ordinary'");
  }};
});
const cleanup:(()=>void)[]=[];afterEach(()=>{poison.enabled=false;poison.calls=0;cleanup.splice(0).reverse().forEach(close=>close());});
const pin=(bytes:Buffer)=>({bytes,sha256:forwardHash(bytes)});
function setup(){
  const db=openDatabase(':memory:');cleanup.push(()=>db.close());fixture(db);adminCatalogFixture(db);
  db.exec("INSERT INTO music_profiles VALUES('old-erased',NULL,7,'original-update','old-erasure'); INSERT INTO music_profile_fields VALUES('old-erased','retained','','0','',0,7,'original-update'); INSERT INTO music_account_epochs VALUES('alice',9007199254740993); INSERT INTO music_legacy_erasures VALUES('10002','\"old\"')");
  for(const id of [catalogProfiles.bob,'old-erased']){
    db.prepare("INSERT INTO music_profile_contacts VALUES(?,'','self_reported',1,'before')").run(id);
    for(const table of ['music_contact_history','music_field_history','music_profile_audit'])db.prepare(`INSERT INTO ${table}(profile_id,revision,actor_id,before_json,after_json,created_at) VALUES(?,1,'bob','{}','{"private":true}','before')`).run(id);
    db.prepare("INSERT INTO music_ownership_history(profile_id,revision,actor_ref,before_user_id,after_user_id,reason,created_at) VALUES(?,1,'account:bob','bob',NULL,'synthetic','before')").run(id);
    db.prepare("INSERT INTO music_pin_history(profile_id,revision,user_id,actor_ref,reason,created_at) VALUES(?,1,'bob','account:bob','synthetic','before')").run(id);
  }
  for(const [id,status] of [['ordinary','verified'],['claim-pending','pending'],['claim-exchanging','exchanging'],['claim-verified','verified'],['claim-completed','completed'],['claim-failed','failed']] as const){
    db.prepare("INSERT INTO login_attempts(id,token_hash,user_id,provider,mode,status,expires_at,created_at,app_id,union_id) VALUES(?,'synthetic-token','bob','qq','bind',?,'2099','before','synthetic','original-union')").run(id,status);
    if(id!=='ordinary')db.prepare("INSERT INTO music_claim_intents VALUES(?,'synthetic-token','bob',?,0,'proof','digest',0,'authorized',?,'synthetic','subject','2099','before')").run(id,id==='claim-completed'?'old-erased':catalogProfiles.bob,id);
  }
  db.prepare("INSERT INTO request_results VALUES('bob','save','signature','private-response',200,'before')").run();
  db.prepare("INSERT INTO music_profile_receipts VALUES('bob','save',?)").run(catalogProfiles.bob);
  for(const [profile,key] of [[catalogProfiles.bob,'10002'],[catalogProfiles.orphan,'alias-orphan']] as const)db.prepare("INSERT INTO migration_map VALUES('music','profile',?,?,'rev','digest','imported')").run(key,profile);
  for(const [position,key] of ['10002','alias-orphan','other'].entries()){
    db.prepare("INSERT INTO music_legacy_identity VALUES('sessions',?,?)").run(position,JSON.stringify({qq:key,opaque:'retained-exact'}));
    db.prepare("INSERT INTO migration_map VALUES('music-identity','sessions',?,'target','rev','digest','imported')").run(String(position));
  }
  db.prepare("INSERT INTO music_documents VALUES('profile_source',0,?)").run(JSON.stringify({profileId:catalogProfiles.bob,legacyKey:'10002',private:'erase'}));
  db.prepare("INSERT INTO music_documents VALUES('profile_source',1,'{\"legacyKey\":\"alias-orphan\",\"private\":true}')").run();
  db.prepare("INSERT INTO music_documents VALUES('profile_retirement',0,?)").run(JSON.stringify({profileId:catalogProfiles.orphan,private:'erase'}));
  // A stray source document has no live entry. Preserve its opaque numeric
  // lexemes exactly as SQLite json_set does while redacting its creator.
  db.prepare("INSERT INTO music_documents VALUES('entry_source',0,?)").run('{"entryId":"absent-term","entry":{"createdBy":"alias-orphan"},"large":9007199254740993,"exponent":1e+05,"negative":-0}');
  db.prepare("INSERT INTO music_documents VALUES('unrelated',0,'{\"private\":\"retain\",\"large\":9007199254740993}')").run();
  const entries:ErasureIntent[]=[],journal:ErasureJournal={read:()=>structuredClone(entries),append:entry=>entries.push(structuredClone(entry))},privacy=createPrivacy(db,journal),scope=musicErasureScope(db);
  const intent:ErasureIntent={version:2,kind:'admin_music',command:'reset_music',actorRef:'account:alice',profiles:scope.profiles,entries:scope.entries,requestId:randomUUID(),createdAt:'2026-11-21T08:00:00.000Z',secretHash:hash('synthetic-private-reset'),signature:hash(randomUUID())};
  const before=db.serialize();privacy.submit(intent);privacy.guard();
  const evidence:NativeResetSource={requestId:intent.requestId,before:pin(before),beforeJournal:pin(Buffer.alloc(0)),completed:pin(db.serialize()),completedJournal:pin(Buffer.from(JSON.stringify(intent)+'\n'))};
  const change=(sql:string)=>{const copy=new Database(evidence.completed.bytes);cleanup.push(()=>copy.close());copy.exec(sql);evidence.completed=pin(copy.serialize());};
  const restore=(table:string,where:string)=>{
    const original=new Database(evidence.before.bytes),copy=new Database(evidence.completed.bytes);cleanup.push(()=>original.close(),()=>copy.close());
    const cols=(original.prepare(`PRAGMA table_xinfo("${table}")`).all() as {name:string}[]).map(r=>r.name),insert=copy.prepare(`INSERT INTO "${table}"(rowid,${cols.join(',')}) VALUES(${Array(cols.length+1).fill('?').join(',')})`);
    for(const row of original.prepare(`SELECT rowid AS original_rowid,* FROM "${table}" WHERE ${where}`).safeIntegers(true).all() as Record<string,unknown>[])insert.run(row.original_rowid,...cols.map(c=>row[c]));
    evidence.completed=pin(copy.serialize());
  };
  return {db,evidence,change,restore};
}

it('verifies every private reset transition without invoking the profile service writer',()=>{
  const s=setup();poison.enabled=true;
  const originalBefore=Buffer.from(s.evidence.before.bytes),originalCompleted=Buffer.from(s.evidence.completed.bytes);
  expect(verifyNativeResetSource(s.evidence)).toMatchObject({allTransitionRowsVerified:true,profileProjectionUsesServiceWriter:false,fullPrivateScopeIndependentlyVerified:true,releaseEligible:false});
  expect(poison.calls).toBe(0);
  expect(s.evidence.before.bytes).toEqual(originalBefore);expect(s.evidence.completed.bytes).toEqual(originalCompleted);
  expect(s.db.prepare("SELECT epoch FROM music_account_epochs WHERE user_id='alice'").safeIntegers(true).get()).toEqual({epoch:9007199254740994n});
  expect(s.db.prepare("SELECT payload_json FROM music_documents WHERE kind='entry_source'").get()).toEqual({payload_json:'{"entryId":"absent-term","entry":{"createdBy":""},"large":9007199254740993,"exponent":1e+05,"negative":-0}'});
});

it.each(['music_profile_creation','music_legacy_profiles','music_profile_contacts','music_contact_history','music_ownership_history','music_pin_history','music_field_history','music_profile_fields','music_profile_audit','music_claim_intents','profile_source','profile_retirement','music_legacy_identity'])('rejects original private rows restored into a purported completion: %s',table=>{
  const s=setup();
  if(table==='profile_source'||table==='profile_retirement')s.restore('music_documents',"kind='"+table+"'");
  else if(table==='music_legacy_identity')s.restore(table,'row_number=0');
  else s.restore(table,"profile_id='"+(table==='music_profile_creation'?catalogProfiles.alice:catalogProfiles.bob)+"'");
  expect(()=>verifyNativeResetSource(s.evidence)).toThrow();
});

it('rejects completion corruption even when a poisoned shared writer would reproduce the same unrelated login failure',()=>{
  const s=setup();s.change("UPDATE login_attempts SET status='failed' WHERE id='ordinary'");poison.enabled=true;
  expect(()=>verifyNativeResetSource(s.evidence)).toThrow();expect(poison.calls).toBe(0);
});

it.each(['pending proof','exchanging proof','verified proof','completed proof','failed proof','unrelated legacy identity','identity provenance','erasure timestamp','legacy erasure order','profile revision','old tombstone','saved response','new owner epoch','large owner epoch','opaque number','unrelated document'])('rejects private completion collateral changes or incomplete erasure: %s',change=>{
  const s=setup();
  const changes:Record<string,string>={
    'pending proof':"UPDATE login_attempts SET status='pending',union_id='original-union' WHERE id='claim-pending'",
    'exchanging proof':"UPDATE login_attempts SET status='exchanging',union_id='original-union' WHERE id='claim-exchanging'",
    'verified proof':"UPDATE login_attempts SET status='verified',union_id='original-union' WHERE id='claim-verified'",
    'completed proof':"UPDATE login_attempts SET union_id='' WHERE id='claim-completed'",
    'failed proof':"UPDATE login_attempts SET union_id='' WHERE id='claim-failed'",
    'unrelated legacy identity':"DELETE FROM music_legacy_identity WHERE row_number=2",
    'identity provenance':"UPDATE migration_map SET payload_digest='changed' WHERE source='music-identity' AND source_id='0'",
    'erasure timestamp':"UPDATE music_legacy_erasures SET erased_at_json='\"wrong\"' WHERE legacy_key='10002'",
    'legacy erasure order':"UPDATE music_legacy_erasures SET rowid=rowid+10 WHERE legacy_key='alias-orphan'",
    'profile revision':"UPDATE music_profiles SET revision=revision+1 WHERE id='"+catalogProfiles.bob+"'",
    'old tombstone':"UPDATE music_profile_fields SET name='changed' WHERE profile_id='old-erased'",
    'saved response':"UPDATE request_results SET response_status=200 WHERE request_key='save'",
    'new owner epoch':"UPDATE music_account_epochs SET rowid=rowid+10 WHERE user_id='bob'",
    'large owner epoch':"UPDATE music_account_epochs SET epoch=9007199254740993 WHERE user_id='alice'",
    'opaque number':"UPDATE music_documents SET payload_json=replace(payload_json,'9007199254740993','9007199254740992') WHERE kind='entry_source'",
    'unrelated document':"UPDATE music_documents SET payload_json='{}' WHERE kind='unrelated'",
  };
  s.change(changes[change]!);expect(()=>verifyNativeResetSource(s.evidence)).toThrow();
});
