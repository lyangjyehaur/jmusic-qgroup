import type { DB } from '@qgroup/database';

/** ID-only evidence: no selecting person's identity is retained in the lock. */
export function lockMusicEntry(db: DB, entryId: string) {
  if (db.prepare("SELECT 1 FROM music_documents WHERE kind='entry_lock' AND json_extract(payload_json,'$.entryId')=?").get(entryId)) return;
  const position = ((db.prepare("SELECT max(position) AS n FROM music_documents WHERE kind='entry_lock'").get() as {n:number|null}).n ?? -1) + 1;
  db.prepare("INSERT INTO music_documents VALUES('entry_lock',?,?)").run(position, JSON.stringify({entryId}));
}
export function removeMusicEntryLock(db: DB, entryId: string) {
  db.prepare("DELETE FROM music_documents WHERE kind='entry_lock' AND json_extract(payload_json,'$.entryId')=?").run(entryId);
}
const otherCreator = "d.created_by NOT IN ('','admin') AND d.created_by<>s.profile_id AND d.created_by<>COALESCE(l.legacy_key,'')";

/** Read current selections too, including imported data not yet materialized. */
export function lockedMusicEntries(db: DB): Set<string> {
  return new Set((db.prepare(`SELECT json_extract(payload_json,'$.entryId') AS id FROM music_documents WHERE kind='entry_lock'
    UNION SELECT s.entry_id AS id FROM music_selections s JOIN music_entry_details d ON d.entry_id=s.entry_id
    LEFT JOIN music_legacy_profiles l ON l.profile_id=s.profile_id WHERE ${otherCreator}`).all() as {id:string}[]).map(row=>row.id));
}

/** Called before replacing/removing selections and after a successful save,
 * inside its transaction, so withdrawal and failed saves cannot change history. */
export function retainMusicSelectionLocks(db: DB, profileId: string) {
  for (const row of db.prepare(`SELECT s.entry_id AS id FROM music_selections s
    JOIN music_entry_details d ON d.entry_id=s.entry_id
    LEFT JOIN music_legacy_profiles l ON l.profile_id=s.profile_id
    WHERE s.profile_id=? AND ${otherCreator}`).all(profileId) as {id:string}[]) lockMusicEntry(db,row.id);
}

/** Once at startup: include surviving native audit before/after snapshots.
 * Old JSON exports have no equivalent historical evidence; never guess it. */
export function backfillMusicEntryLocks(db: DB) {
  const entries = db.prepare(`WITH s AS (
    SELECT profile_id,entry_id FROM music_selections
    UNION SELECT a.profile_id,json_extract(j.value,'$.entryId') FROM music_profile_audit a,json_each(a.before_json,'$.selections') j
    UNION SELECT a.profile_id,json_extract(j.value,'$.entryId') FROM music_profile_audit a,json_each(a.after_json,'$.selections') j
  ) SELECT DISTINCT s.entry_id AS id FROM s JOIN music_entry_details d ON d.entry_id=s.entry_id
    LEFT JOIN music_legacy_profiles l ON l.profile_id=s.profile_id WHERE ${otherCreator}`).all() as {id:string}[];
  for (const row of entries) lockMusicEntry(db,row.id);
}
