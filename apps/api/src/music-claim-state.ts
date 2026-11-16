import type { DB } from '@qgroup/database';
/** Used by every session revocation path; a new account scope cannot inherit a proof. */
export function clearMusicClaims(db: DB, tokenHash: string, exceptId = '') {
  db.prepare('DELETE FROM music_claim_intents WHERE current_token_hash=? AND id!=?').run(tokenHash, exceptId);
}
export function clearMusicClaimAuthorization(db: DB, tokenHash: string) {
  db.prepare("UPDATE music_claim_intents SET stage='pending',attempt_id=NULL,app_id='',subject='' WHERE current_token_hash=? AND stage!='completed'").run(tokenHash);
}
