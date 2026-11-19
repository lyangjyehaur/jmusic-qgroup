import {detachLegacyAccount,type DB} from '@qgroup/database';
import {ErasureResult} from '@qgroup/contracts';
import {readVerifiedErasureJournal,type ErasureJournal} from '../../apps/api/src/erasure-journal';
import {forwardHash} from './forward-board-storage';

const privateTables=['external_profiles','external_identities','qq_accounts','qq_attempts','login_attempts','privacy_consents','user_payment_codes','notifications','request_results','device_links','admin_user_metadata','event_access','time_poll_votes','time_poll_ballots','unified_privacy_receipts','unified_privacy_consents'] as const;
/** A non-SHA value cannot match the original credential's SHA256 lookup. The
 * stable sentinel has no usable password preimage and repeated repair is exact. */
export const erasedAccountToken=(userId:string,requestId:string)=>'erased-account-v1:'+forwardHash(JSON.stringify([userId,requestId]));
export function verifiedAccountClosures(db:DB,journal:ErasureJournal){
  const intents=readVerifiedErasureJournal(db,journal),scopes=new Map<string,Map<string,string>>();
  for(const entry of intents){
    if('version' in entry&&(entry.version===2||entry.kind==='music'))continue;
    const [userId,requestId,createdAt]='user_id' in entry?[entry.user_id,entry.request_id,entry.created_at]:[entry.userId,entry.requestId,entry.createdAt];
    if('version' in entry){const receipt=db.prepare('SELECT result_json FROM privacy_receipts WHERE request_id=?').get(requestId) as {result_json:string};const result=ErasureResult.parse(JSON.parse(receipt.result_json));if(result.requestId!==requestId||result.target!==entry.kind)throw Error('Account closure receipt scope differs');}
    const requests=scopes.get(userId)??new Map<string,string>();requests.set(requestId,createdAt);scopes.set(userId,requests);
  }
  const closures:{userId:string;requestId:string;createdAt:string}[]=[];
  for(const [userId,requests] of scopes){
    if(!db.prepare('SELECT 1 FROM users WHERE id=?').get(userId))continue;
    const row=db.prepare('SELECT id,created_at FROM privacy_requests WHERE user_id=?').get(userId) as {id:string;created_at:string}|undefined;
    if(!row||requests.get(row.id)!==row.created_at)throw Error('Account closure record lacks its original verified intent');
    closures.push({userId,requestId:row.id,createdAt:row.created_at});
  }
  return {intents,closures};
}
/** Cleanup of an already applied closure, inside an isolated forward repair.
 * Preserve the original review, receipts and all shared audit/business rows;
 * never call closeAccount again or append a replacement user intent. */
export function repairAppliedAccountErasures(db:DB,journal:ErasureJournal){
  if(!db.inTransaction)throw Error('Account erasure repair requires a held transaction');
  if(db.pragma('foreign_keys',{simple:true})!==1)throw Error('Account erasure repair requires foreign key enforcement');
  const {closures}=verifiedAccountClosures(db,journal);
  // Capture/invalidate before any device cleanup can remove another closed
  // target's claim. Closure ordering must not leave its OAuth attempt usable.
  for(const {userId} of closures)db.prepare("UPDATE login_attempts SET status='failed',union_id='' WHERE status IN ('pending','exchanging','verified') AND id IN (SELECT attempt_id FROM music_claim_intents WHERE target_user_id=?)").run(userId);
  for(const {userId,requestId} of closures){
    const tokens=(db.prepare('SELECT token_hash FROM browser_sessions WHERE user_id=?').all(userId) as {token_hash:string}[]).map(row=>row.token_hash);
    const digests=(db.prepare('SELECT DISTINCT digest FROM user_payment_codes WHERE user_id=?').all(userId) as {digest:string}[]).map(row=>row.digest);
    const polls=db.prepare("SELECT vote_revision FROM time_polls WHERE status IN ('open','closed') AND id IN (SELECT poll_id FROM time_poll_ballots WHERE user_id=?)").safeIntegers(true).all(userId) as {vote_revision:bigint}[];
    if(polls.some(row=>typeof row.vote_revision!=='bigint'||row.vote_revision<0n||row.vote_revision>=9223372036854775807n))throw Error('Account erasure poll revision exceeds capacity');
    db.prepare("UPDATE time_polls SET vote_revision=vote_revision+1 WHERE status IN ('open','closed') AND id IN (SELECT poll_id FROM time_poll_ballots WHERE user_id=?)").run(userId);
    db.prepare(`DELETE FROM login_attempts WHERE provider='qq' AND EXISTS(SELECT 1 FROM external_identities x WHERE x.user_id=? AND x.provider='qq' AND x.client_id=login_attempts.app_id AND x.subject=login_attempts.openid)`).run(userId);
    for(const token of tokens){
      db.prepare('DELETE FROM music_claim_intents WHERE current_token_hash=?').run(token);
      for(const table of ['login_attempts','auth_requests','browser_accounts','browser_sessions','visitor_sessions'])db.prepare(`DELETE FROM ${table} WHERE token_hash=?`).run(token);
      db.prepare(`UPDATE migration_map SET status='erased' WHERE source='music-identity' AND EXISTS(SELECT 1 FROM music_legacy_identity i WHERE i.table_name=migration_map.entity_type AND CAST(i.row_number AS TEXT)=migration_map.source_id AND i.table_name IN ('sessions','entry_intents') AND json_extract(i.payload_json,'$.source_session')=?)`).run(token);
      db.prepare("DELETE FROM music_legacy_identity WHERE table_name IN ('sessions','entry_intents') AND json_extract(payload_json,'$.source_session')=?").run(token);
    }
    for(const table of privateTables)db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(userId);
    db.prepare('DELETE FROM browser_accounts WHERE user_id=?').run(userId);
    db.prepare('DELETE FROM music_claim_intents WHERE target_user_id=?').run(userId);
    db.prepare('UPDATE user_admin_roles SET is_admin=0 WHERE user_id=? AND is_admin<>0').run(userId);
    db.prepare("UPDATE music_legacy_profiles SET ownership_source='closed_account' WHERE profile_id IN (SELECT id FROM music_profiles WHERE user_id=?)").run(userId);
    db.prepare('UPDATE music_profiles SET user_id=NULL WHERE user_id=?').run(userId);
    const token=erasedAccountToken(userId,requestId);
    db.prepare("UPDATE users SET nickname='已注销用户',token_hash=? WHERE id=? AND (nickname<>'已注销用户' OR token_hash<>?)").run(token,userId,token);
    detachLegacyAccount(db,userId);
    for(const digest of digests)db.prepare(`DELETE FROM image_assets WHERE digest=? AND NOT EXISTS(SELECT 1 FROM user_payment_codes WHERE digest=image_assets.digest) AND NOT EXISTS(SELECT 1 FROM settlement_code_images WHERE digest=image_assets.digest) AND NOT EXISTS(SELECT 1 FROM settlement_receipt_images WHERE digest=image_assets.digest)`).run(digest);
  }
  return {accountClosures:closures.length};
}
