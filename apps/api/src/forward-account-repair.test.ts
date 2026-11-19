import {afterEach,expect,it} from 'vitest';
import {forwardAccountFixture,accountCopy,accountRows,accountStamp} from '../testsupport/forward-account-fixture';
import {repairAppliedAccountErasures,erasedAccountToken} from '../../../tools/migration/forward-account-erasures';
import {reconcileAppliedAccountRepair} from '../../../tools/migration/forward-account-reconciliation';
import {forwardEqual} from '../../../tools/migration/forward-board-storage';
import {createPrivacy} from './privacy';
import {hash} from './security';
import {profileId} from '../../../tools/migration/music-codec';
import type {DB} from '@qgroup/database';

const cleanup:(()=>void)[]=[];afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();});
async function setup(kind:'legacy'|'account'|'both'='legacy'){const s=await forwardAccountFixture(kind);cleanup.push(()=>s.close());const source=accountCopy(s.db);cleanup.push(()=>source.close());return {...s,source};}
function repair(s:Awaited<ReturnType<typeof setup>>){s.db.transaction(()=>repairAppliedAccountErasures(s.db,s.journal)).immediate();return reconcileAppliedAccountRepair(s.source,s.db,s.journal);}
const row=(db:DB,table:string,predicate:string)=>db.prepare(`SELECT rowid,* FROM ${table} WHERE ${predicate}`).safeIntegers(true).get();
it.each(['legacy','account','both'] as const)('repairs an already-applied %s closure with original review, receipts, shared history, music IDs and every unaffected row preserved',async kind=>{
 const s=await setup(kind),before=s.source.serialize(),report=repair(s);
 expect(report).toMatchObject({accountClosures:1,allRowsVerified:true});expect(report.removedRows).toBeGreaterThan(25);
 for(const table of ['privacy_requests','privacy_receipts','erasure_applied','account_audit','admin_role_history','events','attendees','registrations','settlement_history','settlement_details','settlement_code_images','settlement_receipt_images','finance_entries','bot_outbox','bot_settings','bot_settings_history','bot_runtime','music_profile_audit','music_ownership_history','music_profile_creation','music_selections'])expect(accountRows(s.db,table),table).toEqual(accountRows(s.source,table));
 expect(row(s.db,'privacy_requests',"user_id='alice'")).toMatchObject({note:'original review note',status:'shared_review',updated_at:'original-review-time'});
 for(const table of ['external_identities','external_profiles','privacy_consents','unified_privacy_consents','unified_privacy_receipts','event_access','notifications','request_results','music_profile_receipts','device_links','browser_sessions','browser_accounts','user_payment_codes','time_poll_ballots','admin_user_metadata'])expect(s.db.prepare(`SELECT 1 FROM ${table} WHERE user_id='alice'`).get(),table).toBeUndefined();
 expect(s.db.prepare("SELECT 1 FROM external_unionids WHERE subject='closed-subject'").get()).toBeUndefined();
 expect(row(s.db,'users',"id='bob'")).toEqual(row(s.source,'users',"id='bob'"));expect(row(s.db,'users',"id='contact-owner'")).toEqual(row(s.source,'users',"id='contact-owner'"));
 expect(s.db.prepare('SELECT user_id,erased_at FROM music_profiles WHERE id=?').get(profileId('10001'))).toEqual({user_id:null,erased_at:null});
 expect(s.source.serialize()).toEqual(before);
 const once=accountCopy(s.db);cleanup.push(()=>once.close());repair(s);for(const table of s.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[])expect(accountRows(s.db,table.name),table.name).toEqual(accountRows(once,table.name));
});
it('revokes selected closed-account sessions and their device proofs while preserving another active account with a dormant closed-account row',async()=>{
 const s=await setup();repair(s);
 for(const table of ['browser_sessions','browser_accounts','auth_requests','visitor_sessions','login_attempts'])expect(s.db.prepare(`SELECT 1 FROM ${table} WHERE token_hash='closed-device'`).get(),table).toBeUndefined();
 for(const table of ['browser_sessions','browser_accounts','auth_requests','visitor_sessions'])expect(row(s.db,table,"token_hash='other-device' AND "+(table==='browser_accounts'?"user_id='bob'":"1=1")),table).toEqual(row(s.source,table,"token_hash='other-device' AND "+(table==='browser_accounts'?"user_id='bob'":"1=1")));
});
it('removes only provider-matched orphan QQ attempts, invalidates closed-target OAuth claims, and retains completed or unrelated attempt evidence',async()=>{
 const s=await setup();repair(s);
 expect(s.db.prepare("SELECT 1 FROM login_attempts WHERE id IN ('closed-owned','closed-orphan')").get()).toBeUndefined();expect(s.db.prepare("SELECT 1 FROM music_claim_intents WHERE target_user_id='alice'").get()).toBeUndefined();
 expect(row(s.db,'login_attempts',"id='target-closed'")).toMatchObject({status:'failed',union_id:'',created_at:accountStamp,openid:'claim-subject'});
 for(const id of ['target-used','unrelated-app','unrelated-subject'])expect(row(s.db,'login_attempts',`id='${id}'`)).toEqual(row(s.source,'login_attempts',`id='${id}'`));
});
it('retains separate music data and frozen ownership evidence while removing account links, source sessions and source-only authorization proofs',async()=>{
 const s=await setup();
 for(const [table,number,value] of [['sessions',991,{qq:'unrelated-qq',source_session:'closed-device'}],['entry_intents',992,{qq:'unrelated-qq',source_session:'closed-device'}],['entry_intents',993,{qq:'unrelated-qq',target_user_id:'alice'}],['link_audit',994,{qq:'10001',before_user_id:'alice',after_user_id:'bob',actor:'account:alice'}]] as const){s.db.prepare('INSERT INTO music_legacy_identity VALUES(?,?,?)').run(table,number,JSON.stringify(value));s.db.prepare("INSERT INTO migration_map VALUES('music-identity',?,?,?,'','fixture','imported')").run(table,String(number),'proof-'+number);}
 s.source.close();const source=accountCopy(s.db);cleanup.push(()=>source.close());s.db.transaction(()=>repairAppliedAccountErasures(s.db,s.journal)).immediate();reconcileAppliedAccountRepair(source,s.db,s.journal);
 for(const number of [991,992,993]){expect(s.db.prepare('SELECT 1 FROM music_legacy_identity WHERE row_number=?').get(number)).toBeUndefined();expect(s.db.prepare("SELECT status FROM migration_map WHERE source='music-identity' AND source_id=?").get(String(number))).toEqual({status:'erased'});}
 expect(row(s.db,'music_legacy_identity',"table_name='link_audit' AND row_number=994")).toEqual(row(source,'music_legacy_identity',"table_name='link_audit' AND row_number=994"));expect(s.db.prepare("SELECT 1 FROM music_legacy_identity WHERE table_name IN ('prelinks','links') AND json_extract(payload_json,'$.user_id')='alice'").get()).toBeUndefined();
});
it('prunes captured private-code assets while retaining shared, settlement and unrelated orphan assets',async()=>{
 const s=await setup();repair(s);expect(s.db.prepare("SELECT 1 FROM image_assets WHERE digest='private-code'").get()).toBeUndefined();
 for(const digest of ['shared-code','other-code','settlement-code','settlement-receipt','unrelated-orphan'])expect(row(s.db,'image_assets',`digest='${digest}'`)).toEqual(row(s.source,'image_assets',`digest='${digest}'`));
});
it('increments open/closed poll revisions exactly once per restored voter and retains decided results and bot work',async()=>{
 const s=await setup();repair(s);for(const id of ['open-poll','closed-poll'])expect(s.db.prepare('SELECT vote_revision FROM time_polls WHERE id=?').get(id)).toEqual({vote_revision:11});expect(row(s.db,'time_polls',"id='decided-poll'")).toEqual(row(s.source,'time_polls',"id='decided-poll'"));
 expect(s.db.prepare('SELECT 1 FROM time_poll_ballots').get()).toBeUndefined();repair(s);expect(s.db.prepare("SELECT vote_revision FROM time_polls WHERE id='open-poll'").get()).toEqual({vote_revision:11});
});
it.each(['-1','9223372036854775807','1.5',"'invalid'"])('rolls back closure repair when a restored ballot poll has unsafe revision %s',async revision=>{
 const s=await setup();s.db.exec(`UPDATE time_polls SET vote_revision=${revision} WHERE id='open-poll'`);const before=s.db.serialize();expect(()=>s.db.transaction(()=>repairAppliedAccountErasures(s.db,s.journal)).immediate()).toThrow('capacity');expect(s.db.serialize()).toEqual(before);
});
it('uses a stable non-credential token while preserving account creation and requiring original journal authorization',async()=>{
 const s=await setup();repair(s);const closure=s.db.prepare("SELECT id FROM privacy_requests WHERE user_id='alice'").get() as {id:string},token=erasedAccountToken('alice',closure.id);
 expect(row(s.db,'users',"id='alice'")).toMatchObject({nickname:'已注销用户',token_hash:token,created_at:(row(s.source,'users',"id='alice'") as {created_at:string}).created_at});expect(token).not.toMatch(/^[a-f0-9]{64}$/);expect(s.db.prepare('SELECT id FROM users WHERE token_hash=?').get(hash('fixture-alice'))).toBeUndefined();expect(s.db.prepare('SELECT id FROM users WHERE token_hash=?').get(hash(token))).toBeUndefined();expect(erasedAccountToken('bob',closure.id)).not.toBe(token);
 expect(()=>repairAppliedAccountErasures(s.db,s.journal)).toThrow('held transaction');
});
it.each(['missing closure','request mismatch','time mismatch','missing marker','unknown marker','missing receipt','receipt secret','receipt target','receipt request'])('rejects %s without inventing closure records or native proof',async change=>{
 const s=await setup('account');
 if(change==='missing closure')s.db.prepare("DELETE FROM privacy_requests WHERE user_id='alice'").run();if(change==='request mismatch')s.db.prepare("UPDATE privacy_requests SET id='unknown' WHERE user_id='alice'").run();if(change==='time mismatch')s.db.prepare("UPDATE privacy_requests SET created_at='different-time' WHERE user_id='alice'").run();if(change==='missing marker')s.db.prepare('DELETE FROM erasure_applied WHERE request_id=?').run((s.intents[0] as {requestId:string}).requestId);if(change==='unknown marker')s.db.prepare("INSERT INTO erasure_applied VALUES('unknown')").run();
 const intent=s.intents[0] as {requestId:string};if(change==='missing receipt')s.db.prepare('DELETE FROM privacy_receipts WHERE request_id=?').run(intent.requestId);if(change==='receipt secret')s.db.prepare("UPDATE privacy_receipts SET secret_hash=? WHERE request_id=?").run('f'.repeat(64),intent.requestId);if(change==='receipt target')s.db.prepare("UPDATE privacy_receipts SET result_json=json_set(result_json,'$.target','music') WHERE request_id=?").run(intent.requestId);if(change==='receipt request')s.db.prepare("UPDATE privacy_receipts SET result_json=json_set(result_json,'$.requestId',?) WHERE request_id=?").run(crypto.randomUUID(),intent.requestId);
 const before=s.db.serialize();expect(()=>s.db.transaction(()=>repairAppliedAccountErasures(s.db,s.journal)).immediate()).toThrow();expect(s.db.serialize()).toEqual(before);
});
it.each(['added table','added row','retained row deletion','rowid','storage class','sequence','sequence rowid','review','receipt','role revision','account creation','bot delivery','retained asset','private revival','metadata'])('independently rejects candidate tampering: %s',async change=>{
 const s=await setup();repair(s);
 const commands:Record<string,string>={
  'added table':'CREATE TABLE unauthorized(value TEXT)', 'added row':"INSERT INTO auth_requests VALUES('unrelated-new','new','sig','{}','new')",'retained row deletion':"DELETE FROM auth_requests WHERE token_hash='other-device'",rowid:"UPDATE auth_requests SET rowid=rowid+1000 WHERE token_hash='other-device'",'storage class':"UPDATE users SET created_at=X'32303236' WHERE id='bob'",sequence:"UPDATE sqlite_sequence SET seq=seq+1 WHERE name='notifications'",'sequence rowid':"UPDATE sqlite_sequence SET rowid=rowid+1000 WHERE name='notifications'",review:"UPDATE privacy_requests SET note='changed' WHERE user_id='alice'",receipt:"UPDATE privacy_receipts SET result_json='{}'",'role revision':"UPDATE user_admin_roles SET revision=revision+1 WHERE user_id='alice'",'account creation':"UPDATE users SET created_at='new' WHERE id='alice'",'bot delivery':"UPDATE bot_outbox SET status='pending',delivered_payload_json=NULL WHERE status='sent'",'retained asset':"UPDATE image_assets SET size=4 WHERE digest='shared-code'",'private revival':"INSERT INTO external_profiles VALUES('qq','revived','alice','private-avatar')"};
 if(change==='metadata')s.db.pragma('application_id=99');else if(change==='retained asset'){const triggers=s.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='image_assets'").all() as {name:string;sql:string}[];for(const trigger of triggers)s.db.exec('DROP TRIGGER "'+trigger.name+'"');try{s.db.exec(commands[change]!);}finally{for(const trigger of triggers)s.db.exec(trigger.sql);}}else s.db.exec(commands[change]!);expect(()=>reconcileAppliedAccountRepair(s.source,s.db,s.journal)).toThrow();
});
it('accounts for multiple closed voters in a shared poll and refuses aggregate revision overflow',async()=>{
 const s=await setup(),intents=[...s.intents,{user_id:'bob',request_id:'second-original-closure',created_at:'original-second-time'}];createPrivacy(s.db,{read:()=>intents,append(){throw Error();}});for(const user of ['alice','bob'])s.db.prepare("INSERT OR IGNORE INTO time_poll_ballots VALUES('open-poll',?,?)").run(user,accountStamp);s.db.prepare("UPDATE time_polls SET vote_revision=9223372036854775806 WHERE id='open-poll'").run();const before=s.db.serialize();expect(()=>s.db.transaction(()=>repairAppliedAccountErasures(s.db,{read:()=>intents,append(){throw Error();}})).immediate()).toThrow('capacity');expect(s.db.serialize()).toEqual(before);
 s.db.prepare("UPDATE time_polls SET vote_revision=20 WHERE id='open-poll'").run();const source=accountCopy(s.db);cleanup.push(()=>source.close());s.db.transaction(()=>repairAppliedAccountErasures(s.db,{read:()=>intents,append(){throw Error();}})).immediate();expect(reconcileAppliedAccountRepair(source,s.db,{read:()=>intents,append(){throw Error();}})).toMatchObject({accountClosures:2,allRowsVerified:true});expect(s.db.prepare("SELECT vote_revision FROM time_polls WHERE id='open-poll'").get()).toEqual({vote_revision:22});expect(forwardEqual(accountRows(source,'privacy_requests'),accountRows(s.db,'privacy_requests'))).toBe(true);
});
it('invalidates a later closed target before an earlier closed device removes its cross-account claim',async()=>{
 const s=await setup(),intents=[...s.intents,{user_id:'bob',request_id:'second-original-closure',created_at:'original-second-time'}],journal={read:()=>intents,append(){throw Error();}};createPrivacy(s.db,journal);
 s.db.prepare("INSERT INTO login_attempts(id,token_hash,provider,app_id,mode,status,expires_at,created_at,union_id) VALUES('cross-closed','orphan-independent','qq','cross-app','bind','exchanging',?,?,'private-union')").run(accountStamp,accountStamp);
 s.db.prepare("INSERT INTO music_claim_intents VALUES('cross-closed','closed-device','bob',?,0,'proof','digest',0,'authorized','cross-closed','cross-app','subject',?,?)").run(profileId('10002'),accountStamp,accountStamp);const source=accountCopy(s.db);cleanup.push(()=>source.close());s.db.transaction(()=>repairAppliedAccountErasures(s.db,journal)).immediate();expect(reconcileAppliedAccountRepair(source,s.db,journal)).toMatchObject({accountClosures:2,allRowsVerified:true});expect(s.db.prepare("SELECT status,union_id FROM login_attempts WHERE id='cross-closed'").get()).toEqual({status:'failed',union_id:''});
});
it('rejects a transaction without foreign-key enforcement before deleting any restored footprint',async()=>{
 const s=await setup();s.db.pragma('foreign_keys=OFF');const before=s.db.serialize();expect(()=>s.db.transaction(()=>repairAppliedAccountErasures(s.db,s.journal)).immediate()).toThrow('foreign key enforcement');expect(s.db.serialize()).toEqual(before);
});
