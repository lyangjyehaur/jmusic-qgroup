import Database from 'better-sqlite3';
import type {DB} from '@qgroup/database';
import {randomUUID} from 'node:crypto';
import {legacyHistoryFixture} from './legacy-history-fixture';
import {createPrivacy} from '../src/privacy';
import {hash} from '../src/security';
import type {StoredIntent,ErasureJournal} from '../src/erasure-journal';
import {profileId} from '../../../tools/migration/music-codec';

export const accountStamp='2026-11-20T04:00:00.000Z';
/** Synthetic mixed restore, including orphan authorization and shared images.
 * All original closure rows/receipts survive; only live private rows are copied
 * back from the older image. Never used by a runtime or a production capture. */
export async function forwardAccountFixture(kind:'legacy'|'account'|'both'='legacy'){
  const s=await legacyHistoryFixture(),db=s.db;
  try{
    db.prepare("INSERT INTO user_admin_roles VALUES('alice',1,7,'original-role-time')").run();
    db.prepare("INSERT INTO admin_user_metadata VALUES('alice','private note','12345',8,'original','account:alice')").run();
    for(const [token,user] of [['closed-device','alice'],['other-device','bob']]){
      db.prepare('INSERT INTO browser_sessions VALUES(?,?,?)').run(token,user,accountStamp);
      for(const account of ['alice','bob'])db.prepare('INSERT INTO browser_accounts VALUES(?,?,?)').run(token,account,accountStamp);
      db.prepare('INSERT INTO auth_requests VALUES(?,?,?,?,?)').run(token,'request','signature','{"private":"reply"}',accountStamp);
      db.prepare('INSERT INTO visitor_sessions VALUES(?,?,?)').run(token,accountStamp,accountStamp);
    }
    db.prepare("INSERT INTO external_identities VALUES('qq','fixture-app','closed-subject','alice','private name',?)").run(accountStamp);
    db.prepare("INSERT INTO external_unionids VALUES('qq','fixture-app','closed-subject','private-union',?)").run(accountStamp);
    db.prepare("INSERT INTO external_profiles VALUES('qq','fixture-app','alice','private-avatar')").run();
    db.prepare("INSERT INTO privacy_consents VALUES('alice','original',?)").run(accountStamp);
    db.prepare("INSERT INTO unified_privacy_consents VALUES('alice','original',?,'explicit')").run(accountStamp);
    db.prepare("INSERT INTO unified_privacy_receipts VALUES('alice','consent','original','original-signature')").run();
    db.prepare("INSERT INTO event_access VALUES('listen','alice',?)").run(accountStamp);
    db.prepare("INSERT INTO notifications(user_id,event_id,kind,message,created_at) VALUES('alice','listen','original','private notification',?)").run(accountStamp);
    db.prepare("INSERT INTO request_results VALUES('alice','private-result','original-signature','{\"private\":\"reply\"}',200,?)").run(accountStamp);
    db.prepare("INSERT INTO music_profile_receipts VALUES('alice','private-result',?)").run(profileId('10001'));
    db.prepare("INSERT INTO device_links VALUES('closed-link','private-link','alice','pending',?,?,'original-proof')").run(accountStamp,accountStamp);
    const attempt=(id:string,token:string,user:string|null,app:string,subject:string,status='pending')=>db.prepare("INSERT INTO login_attempts(id,token_hash,user_id,provider,app_id,mode,status,expires_at,created_at,openid,union_id) VALUES(?,?,?,'qq',?,'bind',?,?,?,?, 'private-union')").run(id,token,user,app,status,accountStamp,accountStamp,subject);
    attempt('closed-owned','closed-device',null,'other-app','other-subject');
    attempt('closed-orphan','orphan-device',null,'fixture-app','closed-subject');
    attempt('unrelated-app','other-device',null,'other-app','closed-subject');
    attempt('unrelated-subject','other-device',null,'fixture-app','other-subject');
    attempt('target-closed','other-device',null,'claim-app','claim-subject','verified');
    attempt('target-used','other-device',null,'claim-app','claim-subject','used');
    for(const [id,attemptId,stage] of [['restore-target','target-closed','authorized'],['restore-used','target-used','completed']])db.prepare("INSERT INTO music_claim_intents VALUES(?,?,'alice',?,0,'private-pin','private-digest',0,?,?, 'claim-app','claim-subject',?,?)").run(id,'other-device',profileId('10001'),stage,attemptId,accountStamp,accountStamp);
    for(const digest of ['private-code','shared-code','other-code','settlement-code','settlement-receipt','unrelated-orphan'])db.prepare('INSERT INTO image_assets VALUES(?,3,?,?)').run(digest,'image/png',accountStamp);
    for(const [id,user,digest] of [['private','alice','private-code'],['shared-a','alice','shared-code'],['shared-b','bob','shared-code'],['other','bob','other-code'],['settlement-a','alice','settlement-code'],['receipt-a','alice','settlement-receipt']])db.prepare("INSERT INTO user_payment_codes VALUES(?,?,'other','private name',?,?,NULL)").run(id,user,digest,accountStamp);
    db.prepare("INSERT INTO settlement_history(event_id,version,total_cents,headcount,note,updated_at,actor_id,actor_name,kind,changed_fields) VALUES('listen',1,101,2,'原帳單',?,'alice','原名','full','[]')").run(accountStamp);
    db.prepare("INSERT INTO settlement_code_images VALUES('listen',1,'other','原圖片','settlement-code')").run();
    db.prepare("INSERT INTO settlement_details VALUES('listen',1,'{}')").run();
    db.prepare("INSERT INTO settlement_receipt_images VALUES('listen',1,'original-item','settlement-receipt')").run();
    for(const [id,status] of [['open-poll','open'],['closed-poll','closed'],['decided-poll','decided']]){
      db.prepare("INSERT INTO time_polls(id,owner_id,title,category,location,description,timezone,duration_hours,capacity,minimum_participants,fee_policy,deadline,status,vote_revision,created_at) VALUES(?,'bob','原投票','','','','Asia/Taipei',1,2,1,'',?,?,9,?)").run(id,accountStamp,status,accountStamp);
      db.prepare("INSERT INTO time_poll_ballots VALUES(?,'alice',?)").run(id,accountStamp);
    }
    for(const [i,status] of ['pending','sending','sent','failed','skipped'].entries())db.prepare("INSERT INTO bot_outbox(event_id,kind,dedupe_key,target,payload_json,status,claim_token,retry_at,simulated_at,delivered_payload_json,created_at,recipient_user_id) VALUES('listen','closure',?,'synthetic','{\"private\":\"frozen\"}',?,?,?,?,?,?,'alice')").run('account-'+i,status,status==='sending'?'uncertain':'',status==='failed'?'retry':null,status==='skipped'?'simulation':null,status==='sent'?'actual-saved-payload':null,accountStamp);
    const original=accountCopy(db);
    const intents:StoredIntent[]=[kind==='legacy'?{user_id:'alice',request_id:'original-old-closure',created_at:'original-unknown-zone'}:{version:1,kind,userId:'alice',profileId:kind==='both'?profileId('10001'):null,requestId:randomUUID(),createdAt:accountStamp,secretHash:hash('synthetic-account-secret'),signature:hash('synthetic-account-signature')},{version:1,kind:'music',userId:'contact-owner',profileId:profileId('m_'+'a'.repeat(24)),requestId:randomUUID(),createdAt:accountStamp,secretHash:hash('synthetic-secret'),signature:hash('synthetic-signature')}];
    const journal:ErasureJournal={read:()=>structuredClone(intents),append(){throw Error('Read-only synthetic journal');}};
    createPrivacy(db,journal);
    db.prepare("UPDATE privacy_requests SET note='original review note',status='shared_review',updated_at='original-review-time' WHERE user_id='alice'").run();
    // Restore exact selected live rows, including rowids and the canonical
    // insert trigger which a mixed snapshot's existing consent can bypass.
    const consentDDL=(db.prepare("SELECT sql FROM sqlite_master WHERE name='unified_privacy_consents_no_closed_account'").get() as {sql:string}).sql;
    db.exec('DROP TRIGGER unified_privacy_consents_no_closed_account');
    try{
      for(const table of ['external_identities','external_unionids','external_profiles','privacy_consents','unified_privacy_consents','unified_privacy_receipts','event_access','notifications','request_results','music_profile_receipts','device_links','browser_sessions','browser_accounts','auth_requests','visitor_sessions','login_attempts','music_claim_intents','image_assets','user_payment_codes','time_poll_ballots','admin_user_metadata','music_legacy_identity','migration_map','music_documents']){
        const columns=(original.prepare(`PRAGMA table_info("${table}")`).all() as {name:string}[]).map(row=>row.name),insert=db.prepare(`INSERT OR IGNORE INTO "${table}"(rowid,${columns.map(name=>'"'+name+'"').join(',')}) VALUES(${Array(columns.length+1).fill('?').join(',')})`);
        for(const row of original.prepare(`SELECT rowid AS __id__,* FROM "${table}" ORDER BY rowid`).safeIntegers().all() as Record<string,unknown>[])insert.run(row.__id__,...columns.map(name=>row[name]));
      }
    }finally{db.exec(consentDDL);original.close();}
    db.prepare("UPDATE users SET nickname='restored private name',token_hash=? WHERE id='alice'").run(hash('fixture-alice'));
    db.prepare("UPDATE user_admin_roles SET is_admin=1 WHERE user_id='alice'").run();
    db.prepare('UPDATE music_profiles SET user_id=?,erased_at=NULL WHERE id=?').run('alice',profileId('10001'));
    db.prepare("UPDATE music_legacy_profiles SET ownership_source='prelink' WHERE profile_id=?").run(profileId('10001'));
    return {...s,intents,journal};
  }catch(error){s.close();throw error;}
}

export function accountRows(db:DB,table:string){return db.prepare(`SELECT rowid,* FROM "${table}" ORDER BY rowid`).safeIntegers(true).all();}
export function accountCopy(db:DB){const bytes=db.serialize();bytes[18]=1;bytes[19]=1;const copy=new Database(bytes);copy.pragma('foreign_keys = ON');return copy;}
