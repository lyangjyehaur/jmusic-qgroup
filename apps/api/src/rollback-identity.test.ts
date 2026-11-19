import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it} from 'vitest';
import Database from 'better-sqlite3';
import {openDatabase,type DB} from '@qgroup/database';
import {fixture} from '../testsupport/fixture';
import {legacyHistoryFixture} from '../testsupport/legacy-history-fixture';
import {hash} from './security';
import {erasureJournal,type ErasureJournal} from './erasure-journal';
import {createPrivacy} from './privacy';
import {saveProfile} from './repositories';
import {captureRollbackCheckpoint} from '../../../tools/migration/rollback-checkpoint';
import {projectRollbackMusic} from '../../../tools/migration/rollback-music';
import {projectRollbackIdentity} from '../../../tools/migration/rollback-identity';
import {verifyRollbackIdentity} from '../../../tools/migration/rollback-identity-reconciliation';
import {identitySchema} from '../../../tools/migration/identity-schema';
import {captureIdentitySource} from '../../../tools/migration/identity-source';
import {readIdentity,profileId} from '../../../tools/migration/music-codec';
const cleanup:(()=>void)[]=[];afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();});
async function setup(){const s=await legacyHistoryFixture();cleanup.push(()=>s.close());const journal=erasureJournal(s.db);return {...s,journal};}
function project(db:DB,journal:ErasureJournal){const music=projectRollbackMusic(db,journal),result=projectRollbackIdentity(db,journal,music);cleanup.push(()=>{result.db.close();});return {...result,music};}
function replaceOriginal(db:DB,change:(old:DB)=>void){
  const old=new Database(':memory:');try{
    old.exec(identitySchema);change(old);const evidence=captureIdentitySource(old),rows=readIdentity(old);
    db.exec('DELETE FROM music_legacy_identity');db.prepare("UPDATE music_documents SET payload_json=? WHERE kind='identity_source'").run(JSON.stringify(evidence));
    for(const [table,records] of Object.entries(rows))records.forEach((row,index)=>db.prepare('INSERT INTO music_legacy_identity VALUES(?,?,?)').run(table,index,JSON.stringify(row)));
  }finally{old.close();}
}
it('rebuilds original prelinks and latest native contacts while preserving schema, source rowids and all source bytes',async()=>{
  const s=await setup(),before=s.db.serialize(),result=project(s.db,s.journal);
  expect(result.report.rollbackEligible).toBe(false);expect(result.db.prepare('SELECT qq,user_id,created FROM prelinks ORDER BY rowid').all()).toEqual([{qq:'10001',user_id:'alice',created:123},{qq:'10002',user_id:'bob',created:123},{qq:'m_'+'a'.repeat(24),user_id:'contact-owner',created:123}]);
  expect(result.db.prepare('SELECT * FROM links').all()).toEqual([]);expect(result.db.prepare('SELECT * FROM sessions').all()).toEqual([]);expect(result.db.prepare('SELECT * FROM entry_intents').all()).toEqual([]);
  expect(result.db.prepare('SELECT qq,number FROM profile_contacts').all()).toEqual([{qq:'m_'+'a'.repeat(24),number:'12345'}]);
  expect(s.db.serialize()).toEqual(before);expect(s.db.transaction(()=>verifyRollbackIdentity(s.db,result.db,result.music,[],result.report.auditMappings)).immediate().rowsDigest).toBe(result.report.rowsDigest);
});
it('preserves native profile creation ownership and maps its recovery body to the generated old key',()=>{
  const db=openDatabase(':memory:');cleanup.push(()=>{db.close();});fixture(db);const journal=erasureJournal(db);
  const profile=saveProfile(db,'alice',{profileId:null,revision:0,musicEpoch:0,selections:[{entryId:'sub-0',level:4}]},new Date('2026-11-19T02:00:00Z'));
  const result=project(db,journal),key=result.music.keys.find(row=>row.profileId===profile.id)!.legacyKey;
  expect(result.db.prepare('SELECT * FROM prelinks').all()).toEqual([{qq:key,user_id:'alice',created:1795053600}]);expect(JSON.parse((result.db.prepare('SELECT payload FROM native_profiles').get() as {payload:string}).payload)).toEqual((result.music.data.members as Record<string,unknown>)[key]);
});
it('keeps original OAuth links only when the latest board identity agrees, and invalidates source sessions and entry intents',async()=>{
  const s=await setup();replaceOriginal(s.db,old=>{
    old.prepare("INSERT INTO links VALUES('10001','fixture-app','fixture-subject','alice',123,'legacy_pin_and_qq_oauth')").run();old.prepare("INSERT INTO prelinks VALUES('10002','bob',123)").run();old.prepare('INSERT INTO prelinks VALUES(?,?,123)').run('m_'+'a'.repeat(24),'contact-owner');
    old.prepare("INSERT INTO sessions VALUES('old-token','10001',9999999999,'source',9999999999)").run();old.prepare("INSERT INTO entry_intents VALUES('old-intent','10001','source','alice','{}',9999999999)").run();old.prepare("INSERT INTO used_oauth VALUES('consumed',123)").run();
  });
  s.db.prepare("INSERT INTO external_identities(provider,client_id,subject,user_id,display_name,created_at) VALUES('qq','fixture-app','fixture-subject','alice','fixture','after')").run();
  const result=project(s.db,s.journal);expect(result.db.prepare('SELECT * FROM links').all()).toEqual([{qq:'10001',app_id:'fixture-app',openid:'fixture-subject',user_id:'alice',created:123,source:'legacy_pin_and_qq_oauth'}]);expect(result.db.prepare('SELECT * FROM used_oauth').all()).toEqual([{attempt:'consumed',created:123}]);
  expect(result.report.authentication).toMatchObject({sessions:'invalidated',entryIntents:'invalidated'});
  result.db.prepare("INSERT INTO prelinks VALUES('10001','alice',123)").run();expect(()=>s.db.transaction(()=>verifyRollbackIdentity(s.db,result.db,result.music,[],result.report.auditMappings)).immediate()).toThrow('reconciliation failed');
  s.db.prepare("DELETE FROM external_identities WHERE client_id='fixture-app'").run();expect(()=>project(s.db,s.journal)).toThrow('current identity');
});
it('projects administrative unlink and relink using newest owner, original audit IDs and high-water with reversible audit mappings',async()=>{
  const s=await setup();replaceOriginal(s.db,old=>{
    old.prepare("INSERT INTO prelinks VALUES('10002','bob',123)").run();old.prepare('INSERT INTO prelinks VALUES(?,?,123)').run('m_'+'a'.repeat(24),'contact-owner');
    old.prepare("INSERT INTO link_audit VALUES(5,'10001','account:alice','','alice',100)").run();old.prepare("UPDATE sqlite_sequence SET seq=999 WHERE name='link_audit'").run();
  });
  s.db.prepare('UPDATE music_profiles SET user_id=NULL WHERE id=?').run(profileId('10001'));
  s.db.prepare("INSERT INTO music_ownership_history(profile_id,revision,actor_ref,before_user_id,after_user_id,reason,created_at) VALUES(?,1,'account:alice','alice',NULL,'detach','2026-11-19T02:00:00Z')").run(profileId('10001'));
  const result=project(s.db,s.journal);expect(result.db.prepare("SELECT user_id FROM prelinks WHERE qq='10001'").get()).toBeUndefined();expect(result.db.prepare("SELECT * FROM link_overrides WHERE qq='10001'").get()).toMatchObject({user_id:'',revision:1});
  expect(result.db.prepare('SELECT id,qq,before_user_id,after_user_id FROM link_audit ORDER BY id').all()).toEqual([{id:5,qq:'10001',before_user_id:'',after_user_id:'alice'},{id:1000,qq:'10001',before_user_id:'alice',after_user_id:''}]);expect(result.report.auditMappings).toEqual([{source:'ownership',sourceId:'1',legacyId:'1000'}]);
});
it('preserves original signed rowids, empty audit high-water, orphan contact reservations and latest rate attempts',async()=>{
  const s=await setup();replaceOriginal(s.db,old=>{
    old.prepare("INSERT INTO prelinks(rowid,qq,user_id,created) VALUES(-7,'10001','alice',123)").run();old.prepare("INSERT INTO prelinks VALUES('10002','bob',123)").run();old.prepare('INSERT INTO prelinks VALUES(?,?,123)').run('m_'+'a'.repeat(24),'contact-owner');
    old.prepare("INSERT INTO profile_contacts(rowid,qq,number,updated) VALUES(-9,'m_bbbbbbbbbbbbbbbbbbbbbbbb','98765',120)").run();old.prepare("INSERT INTO sqlite_sequence VALUES('link_audit',?)").run(9223372036854775807n);
    old.prepare('INSERT INTO login_attempts VALUES(?,123)').run('qq:'+hash('10001'));
  });
  s.db.prepare('INSERT INTO music_claim_attempts VALUES(?,123)').run('qq:'+hash('10001'));s.db.prepare('INSERT INTO music_claim_attempts VALUES(?,456)').run('ip:'+hash('synthetic'));
  const result=project(s.db,s.journal);expect(result.db.prepare("SELECT rowid FROM prelinks WHERE qq='10001'").get()).toEqual({rowid:-7});expect(result.db.prepare("SELECT rowid,number FROM profile_contacts WHERE number='98765'").get()).toEqual({rowid:-9,number:'98765'});expect(result.report.highWater).toBe('9223372036854775807');expect(result.db.prepare('SELECT * FROM login_attempts ORDER BY rowid').all()).toEqual([{bucket:'qq:'+hash('10001'),created:123},{bucket:'ip:'+hash('synthetic'),created:456}]);
});
it('preserves latest contact clearing and regenerated recovery payload without projecting stale original values',async()=>{
  const s=await setup(),key='m_'+'a'.repeat(24);replaceOriginal(s.db,old=>{
    old.prepare("INSERT INTO prelinks VALUES('10001','alice',123)").run();old.prepare("INSERT INTO prelinks VALUES('10002','bob',123)").run();old.prepare('INSERT INTO prelinks VALUES(?,?,123)').run(key,'contact-owner');old.prepare('INSERT INTO profile_contacts VALUES(?,?,123)').run(key,'12345');old.prepare('INSERT INTO native_profiles VALUES(?,?)').run(key,JSON.stringify(s.data.members[key]));
  });
  s.db.prepare("UPDATE music_profile_contacts SET contact_qq='',updated_at='2026-11-19T02:00:00Z' WHERE profile_id=?").run(profileId(key));s.db.prepare("UPDATE music_profile_fields SET note='new note' WHERE profile_id=?").run(profileId(key));
  const result=project(s.db,s.journal);expect(result.db.prepare('SELECT * FROM profile_contacts WHERE qq=?').get(key)).toMatchObject({number:'',updated:1795053600});expect(JSON.parse((result.db.prepare('SELECT payload FROM native_profiles WHERE qq=?').get(key) as {payload:string}).payload)).toMatchObject({contactQQ:'',note:'new note'});
});
it.each(['music','account','both'] as const)('honors latest %s erasure and never restores a former owner',async(kind)=>{
  const s=await setup(),privacy=createPrivacy(s.db,s.journal);s.db.transaction(()=>privacy.submit({version:1,kind,userId:'bob',profileId:profileId('10002'),requestId:randomUUID(),createdAt:'2026-11-19T02:00:00.000Z',secretHash:hash('secret'),signature:hash('signature')})).immediate();privacy.guard();
  const result=project(s.db,s.journal);expect(result.db.prepare("SELECT * FROM links WHERE qq='10002'").all()).toEqual([]);expect(result.db.prepare("SELECT * FROM prelinks WHERE qq='10002'").all()).toEqual([]);expect(result.db.prepare("SELECT * FROM native_profiles WHERE qq='10002'").all()).toEqual([]);
});
it.each(['owner','contact','native body','old proof','audit','sequence','rowid','schema'])('independently rejects modified %s projections',async(kind)=>{
  const s=await setup(),result=project(s.db,s.journal),db=result.db;
  if(kind==='owner')db.prepare("UPDATE prelinks SET user_id='wrong' WHERE qq='10001'").run();
  if(kind==='contact')db.prepare("UPDATE profile_contacts SET number='99999'").run();
  if(kind==='native body')db.prepare("INSERT INTO native_profiles VALUES('10001','{}')").run();
  if(kind==='old proof')db.prepare("INSERT INTO sessions VALUES('bad','10001',9999999999,'',0)").run();
  if(kind==='audit')db.prepare("INSERT INTO link_audit VALUES(1,'10001','wrong','','alice',1)").run();
  if(kind==='sequence')db.prepare("INSERT INTO sqlite_sequence VALUES('link_audit',999)").run();
  if(kind==='rowid')db.prepare("UPDATE prelinks SET rowid=-999 WHERE qq='10001'").run();
  if(kind==='schema')db.exec('DROP INDEX contact_number');
  expect(()=>s.db.transaction(()=>verifyRollbackIdentity(s.db,db,result.music,[],result.report.auditMappings)).immediate()).toThrow('reconciliation failed');
});
it('requires source evidence and provenance, rejects nested transactions, and retains the complete checkpoint on rejection',async()=>{
  const s=await setup(),checkpoint=captureRollbackCheckpoint(s.db,s.journal),music=projectRollbackMusic(s.db,s.journal);
  s.db.transaction(()=>expect(()=>projectRollbackIdentity(s.db,s.journal,music)).toThrow('standalone')).deferred();
  s.db.prepare("DELETE FROM music_documents WHERE kind='identity_source'").run();expect(()=>projectRollbackIdentity(s.db,s.journal,music)).toThrow('source evidence');
  const saved=new Database(checkpoint.image);cleanup.push(()=>{saved.close();});expect(saved.prepare('SELECT * FROM music_legacy_identity').all()).not.toEqual([]);
});
it('projects consecutive owner changes and retains the independent mapping of each audit',async()=>{
  const s=await setup(),id=profileId('10001');
  s.db.prepare("INSERT INTO users VALUES('new-owner',?,'new owner','after')").run(hash('new-owner'));
  s.db.prepare("UPDATE music_profiles SET user_id='new-owner' WHERE id=?").run(id);
  s.db.prepare("DELETE FROM music_legacy_identity WHERE table_name='prelinks' AND json_extract(payload_json,'$.qq')='10001'").run();
  const insert=s.db.prepare("INSERT INTO music_ownership_history(profile_id,revision,actor_ref,before_user_id,after_user_id,reason,created_at) VALUES(?,?,'account:alice',?,?,'checked',?)");
  insert.run(id,1,'alice',null,'2026-11-19T02:00:00Z');insert.run(id,2,null,'new-owner','2026-11-19T02:01:00Z');
  const result=project(s.db,s.journal);expect(result.db.prepare("SELECT * FROM prelinks WHERE qq='10001'").get()).toEqual({qq:'10001',user_id:'new-owner',created:1795053660});expect(result.db.prepare("SELECT * FROM link_overrides WHERE qq='10001'").get()).toMatchObject({user_id:'new-owner',revision:2});
  expect(result.report.auditMappings).toEqual([{source:'ownership',sourceId:'1',legacyId:'1'},{source:'ownership',sourceId:'2',legacyId:'2'}]);
  expect(()=>s.db.transaction(()=>verifyRollbackIdentity(s.db,result.db,result.music,[],[])).immediate()).toThrow('reconciliation failed');
});
it('rejects unclassified source row fields and missing numeric provenance instead of guessing identity timestamps',async()=>{
  const s=await setup(),before=captureRollbackCheckpoint(s.db,s.journal).image;s.db.prepare("UPDATE music_legacy_identity SET payload_json=json_set(payload_json,'$.unknown','must reject') WHERE table_name='prelinks' AND row_number=0").run();
  expect(()=>project(s.db,s.journal)).toThrow('Unclassified');
  const saved=new Database(before);cleanup.push(()=>{saved.close();});
  saved.prepare("DELETE FROM music_legacy_identity WHERE table_name='prelinks' AND row_number=0").run();expect(()=>project(saved,{read:()=>[],append(){throw Error();}})).toThrow('ownership provenance');
});
it('rebuilds a completed fresh QQ claim with its exact provider identity, consumed attempt and claim audit',async()=>{
  const s=await setup(),id=profileId('10001');
  replaceOriginal(s.db,old=>{old.prepare("INSERT INTO prelinks VALUES('10002','bob',123)").run();old.prepare('INSERT INTO prelinks VALUES(?,?,123)').run('m_'+'a'.repeat(24),'contact-owner');});
  const stamp='2026-11-19T02:00:00Z';
  s.db.prepare("INSERT INTO external_identities(provider,client_id,subject,user_id,display_name,created_at) VALUES('qq','fixture-app','fresh-subject','alice','fixture',?)").run(stamp);
  s.db.prepare("INSERT INTO login_attempts(id,token_hash,user_id,provider,mode,status,expires_at,created_at,app_id,openid) VALUES('fresh-attempt',?,'alice','qq','bind','used',?,?,'fixture-app','fresh-subject')").run(hash('fixture-alice'),stamp,stamp);
  s.db.prepare("INSERT INTO music_claim_intents(id,current_token_hash,target_user_id,profile_id,profile_revision,pin_proof,input_digest,music_epoch,stage,attempt_id,app_id,subject,expires_at,created_at) VALUES('fresh-claim',?,'alice',?,0,'','',0,'completed','fresh-attempt','fixture-app','fresh-subject',?,?)").run(hash('fixture-alice'),id,stamp,stamp);
  s.db.prepare("INSERT INTO music_profile_audit(profile_id,revision,actor_id,before_json,after_json,created_at) VALUES(?,1,'alice','{\"userId\":null,\"action\":\"legacy_claim\"}','{\"userId\":\"alice\",\"action\":\"legacy_claim\"}',?)").run(id,stamp);
  const result=project(s.db,s.journal);expect(result.db.prepare('SELECT * FROM links').all()).toEqual([{qq:'10001',app_id:'fixture-app',openid:'fresh-subject',user_id:'alice',created:1795053600,source:'legacy_pin_and_qq_oauth'}]);expect(result.db.prepare('SELECT * FROM used_oauth').all()).toEqual([{attempt:'fresh-attempt',created:1795053600}]);expect(result.report.auditMappings).toEqual([{source:'claim',sourceId:'1',legacyId:'1'}]);
  s.db.prepare("DELETE FROM music_claim_intents WHERE id='fresh-claim'").run();expect(()=>project(s.db,s.journal)).toThrow('claim proof');
});
it('supports an original Python Store reading and writing only the disposable projected identity and music data',async()=>{
  const s=await setup(),result=project(s.db,s.journal),root=mkdtempSync(join(tmpdir(),'qgroup-rollback-identity-python-'));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
  const path=join(root,'identity.sqlite3');writeFileSync(path,result.db.serialize(),{mode:0o600});
  const output=execFileSync('python3',['-c',`import json,sys
from music_site.identity_store import Store,Rejected
from music_site import contacts,admin_links
store=Store(sys.argv[1]);data=json.load(sys.stdin)
before=store.linked_qq({'user_id':'alice'})
key='m_'+('a'*24)
contacts.save(data,store,key,'')
with store.connect() as db: state=store.admin_state(db,'10001')
store.admin_change('10001','',state['revision'],'account:alice')
admin_links.projection(data,store)
print(json.dumps({'before':before,'after':store.linked_qq({'user_id':'alice'}),'cleared':contacts.number(data,key),'owner':data['members']['10001']['boardUserId'],'audit':len([1 for _ in store.connect().execute('SELECT * FROM link_audit')]),'oldSession':bool(store.session('unknown'))}))`,path],{input:JSON.stringify(result.music.data),encoding:'utf8'});
  expect(JSON.parse(output)).toEqual({before:'10001',after:'',cleared:'',owner:'',audit:1,oldSession:false});
});
it('rejects exhausted original audit capacity without modifying retained histories',async()=>{
  const s=await setup();replaceOriginal(s.db,old=>{old.prepare("INSERT INTO prelinks VALUES('10001','alice',123)").run();old.prepare("INSERT INTO prelinks VALUES('10002','bob',123)").run();old.prepare('INSERT INTO prelinks VALUES(?,?,123)').run('m_'+'a'.repeat(24),'contact-owner');old.prepare("INSERT INTO sqlite_sequence VALUES('link_audit',?)").run(9223372036854775807n);});
  s.db.prepare("INSERT INTO music_ownership_history(profile_id,revision,actor_ref,before_user_id,after_user_id,reason,created_at) VALUES(?,1,'account:alice','alice','alice','kept','2026-11-19T02:00:00Z')").run(profileId('10001'));
  const before=s.db.serialize();expect(()=>project(s.db,s.journal)).toThrow('audit capacity');expect(s.db.serialize()).toEqual(before);
});
it('keeps audit revision order across clock rollback and rejects ambiguous shared revisions',async()=>{
  const s=await setup(),id=profileId('10001');
  s.db.prepare("INSERT INTO music_ownership_history(profile_id,revision,actor_ref,before_user_id,after_user_id,reason,created_at) VALUES(?,1,'account:alice','alice','alice','first','2026-11-19T03:00:00Z')").run(id);
  s.db.prepare("INSERT INTO music_profile_audit(profile_id,revision,actor_id,before_json,after_json,created_at) VALUES(?,2,'alice','{\"userId\":null,\"action\":\"legacy_claim\"}','{\"userId\":\"alice\",\"action\":\"legacy_claim\"}','2026-11-19T02:00:00Z')").run(id);
  // Retained original prelink alone cannot prove the newer claimed OAuth link.
  expect(()=>project(s.db,s.journal)).toThrow('claim proof');
  s.db.prepare("INSERT INTO music_ownership_history(profile_id,revision,actor_ref,before_user_id,after_user_id,reason,created_at) VALUES(?,3,'account:alice','alice','alice','later','2026-11-19T01:00:00Z')").run(id);
  const result=project(s.db,s.journal);expect(result.report.auditMappings.map(row=>row.source)).toEqual(['ownership','claim','ownership']);expect(result.db.prepare('SELECT created FROM link_audit ORDER BY id').all()).toEqual([{created:1795057200},{created:1795053600},{created:1795050000}]);
  s.db.prepare("INSERT INTO music_ownership_history(profile_id,revision,actor_ref,before_user_id,after_user_id,reason,created_at) VALUES(?,2,'account:alice','alice','alice','ambiguous','2026-11-19T02:00:00Z')").run(id);
  // Latest rows still differ, but every cross-table revision must be unique.
  expect(()=>project(s.db,s.journal)).toThrow('Ambiguous');
});
it('rejects a generated profile key reserved by an orphan source identity',async()=>{
  const s=await setup();s.db.prepare("INSERT INTO users VALUES('new-owner',?,'new owner','after')").run(hash('new-owner'));const native=saveProfile(s.db,'new-owner',{profileId:null,revision:0,musicEpoch:0,selections:[]},new Date('2026-11-19T02:00:00Z'));
  const key=projectRollbackMusic(s.db,s.journal).keys.find(row=>row.profileId===native.id)!.legacyKey;
  replaceOriginal(s.db,old=>{
    old.prepare("INSERT INTO prelinks VALUES('10001','alice',123)").run();old.prepare("INSERT INTO prelinks VALUES('10002','bob',123)").run();old.prepare('INSERT INTO prelinks VALUES(?,?,123)').run('m_'+'a'.repeat(24),'contact-owner');old.prepare('INSERT INTO profile_contacts VALUES(?,?,123)').run(key,'98765');
  });
  expect(()=>project(s.db,s.journal)).toThrow('collides');
});
