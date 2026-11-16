import type { DB } from './index';

function markIdentity(db: DB, status: string, predicate: string, values: string[]) {
  db.prepare(`UPDATE migration_map SET status=? WHERE source='music-identity' AND EXISTS (
    SELECT 1 FROM music_legacy_identity i WHERE i.table_name=migration_map.entity_type
    AND CAST(i.row_number AS TEXT)=migration_map.source_id AND (${predicate}))`).run(status, ...values);
}
function deleteIdentity(db: DB, predicate: string, values: string[]) {
  markIdentity(db, 'erased', predicate, values);
  db.prepare(`DELETE FROM music_legacy_identity WHERE ${predicate}`).run(...values);
}
export function retireLegacyProfileProofs(db: DB, profileId: string) {
  const row = db.prepare('SELECT legacy_key FROM music_legacy_profiles WHERE profile_id=?').get(profileId) as { legacy_key: string } | undefined;
  if (row) deleteIdentity(db, "table_name IN ('sessions','entry_intents') AND json_extract(payload_json,'$.qq')=?", [row.legacy_key]);
}

/** Remove imported private fields and recovery proofs together with the live profile. */
export function eraseLegacyProfile(db: DB, profileId: string, stamp: string) {
  const row = db.prepare('SELECT legacy_key FROM music_legacy_profiles WHERE profile_id=?').get(profileId) as { legacy_key: string } | undefined;
  if (!row) return;
  const key = row.legacy_key;
  db.prepare('DELETE FROM music_legacy_profiles WHERE profile_id=?').run(profileId);
  db.prepare("UPDATE migration_map SET status='erased' WHERE source='music' AND entity_type='profile' AND source_id=?").run(key);
  deleteIdentity(db, "json_extract(payload_json,'$.qq')=?", [key]);
  db.prepare(`UPDATE migration_map SET status='erased' WHERE source='music' AND EXISTS (
    SELECT 1 FROM music_documents d WHERE d.kind=migration_map.entity_type AND CAST(d.position AS TEXT)=migration_map.source_id
    AND d.kind IN ('shouts','shoutHistory') AND json_extract(d.payload_json,'$.qq')=?)`).run(key);
  db.prepare("DELETE FROM music_documents WHERE kind IN ('shouts','shoutHistory') AND json_extract(payload_json,'$.qq')=?").run(key);
  db.prepare("UPDATE migration_map SET status='erasure_redacted' WHERE source='music' AND entity_type='entry' AND target_id IN (SELECT entry_id FROM music_entry_details WHERE created_by=?)").run(key);
  db.prepare("UPDATE music_entry_details SET created_by='' WHERE created_by=?").run(key);
  db.prepare('INSERT INTO music_legacy_erasures VALUES(?,?) ON CONFLICT(legacy_key) DO UPDATE SET erased_at_json=excluded.erased_at_json').run(key, JSON.stringify(stamp));
}

export function detachLegacyAccount(db: DB, userId: string) {
  const keys = db.prepare(`SELECT DISTINCT json_extract(payload_json,'$.qq') AS legacy_key FROM music_legacy_identity
    WHERE table_name IN ('links','prelinks') AND json_extract(payload_json,'$.user_id')=?`).all(userId) as { legacy_key: string }[];
  for (const { legacy_key: key } of keys) {
    deleteIdentity(db, "table_name IN ('links','prelinks','sessions','entry_intents') AND json_extract(payload_json,'$.qq')=?", [key]);
    db.prepare("UPDATE migration_map SET status='erasure_redacted' WHERE source='music' AND entity_type='profile' AND source_id=? AND status!='erased'").run(key);
    db.prepare(`UPDATE music_legacy_profiles SET ownership_source='closed_account' WHERE legacy_key=?`).run(key);
  }
  deleteIdentity(db, "table_name='entry_intents' AND json_extract(payload_json,'$.target_user_id')=?", [userId]);
  // Native recovery keeps the music itself, but no longer retains account ownership.
  markIdentity(db, 'erasure_redacted', "table_name='native_profiles' AND json_extract(json_extract(payload_json,'$.payload'),'$.boardUserId')=?", [userId]);
  db.prepare(`UPDATE music_legacy_identity SET payload_json=json_set(payload_json,'$.payload',
    json_set(json_extract(payload_json,'$.payload'),'$.boardUserId','')||'') WHERE table_name='native_profiles'
    AND json_extract(json_extract(payload_json,'$.payload'),'$.boardUserId')=?`).run(userId);
}
