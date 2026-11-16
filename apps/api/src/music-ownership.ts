import { retireLegacyProfileProofs, type DB } from '@qgroup/database';

/** Revoke only proofs for this music; ordinary website login stays valid. */
export function invalidateMusicClaimProofs(db: DB, profileId: string, exceptClaimId = '') {
  const pending = db.prepare('SELECT attempt_id FROM music_claim_intents WHERE profile_id=? AND id!=?').all(profileId, exceptClaimId) as { attempt_id: string | null }[];
  for (const row of pending) if (row.attempt_id) db.prepare("UPDATE login_attempts SET status='failed',union_id='' WHERE id=? AND status IN ('pending','exchanging','verified')").run(row.attempt_id);
  db.prepare('DELETE FROM music_claim_intents WHERE profile_id=? AND id!=?').run(profileId, exceptClaimId);
  retireLegacyProfileProofs(db, profileId);
}
/** Run with the ownership write in its IMMEDIATE transaction. */
export function invalidateMusicOwnership(db: DB, profileId: string, userIds: (string | null)[], exceptClaimId = '') {
  invalidateMusicClaimProofs(db, profileId, exceptClaimId);
  for (const userId of new Set(userIds.filter((id): id is string => !!id))) {
    db.prepare('INSERT INTO music_account_epochs VALUES(?,1) ON CONFLICT(user_id) DO UPDATE SET epoch=epoch+1').run(userId);
    // A target cannot keep another profile's proof after being assigned music.
    const others = db.prepare("SELECT attempt_id FROM music_claim_intents WHERE target_user_id=? AND id!=?").all(userId, exceptClaimId) as { attempt_id: string | null }[];
    for (const row of others) if (row.attempt_id) db.prepare("UPDATE login_attempts SET status='failed',union_id='' WHERE id=? AND status IN ('pending','exchanging','verified')").run(row.attempt_id);
    db.prepare('DELETE FROM music_claim_intents WHERE target_user_id=? AND id!=?').run(userId, exceptClaimId);
  }
  // Even an ABA relink must not revive a former owner's saved response or content.
  db.prepare(`UPDATE request_results SET response_status=410,response_json=? WHERE (user_id,request_key) IN
    (SELECT user_id,request_key FROM music_profile_receipts WHERE profile_id=?)`).run(JSON.stringify({ code: 'PROFILE_REASSIGNED', message: '成分關聯已變更，請核對目前成分；原操作不會重新保存' }), profileId);
}
