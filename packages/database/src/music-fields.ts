import type { DB } from './index';

export interface StoredMusicFields { name: string; note: string; noteAt: number; gender: string; genderPublic: boolean }
/** Keep source values intact; limits and text normalization apply only to edits. */
export function legacyMusicFields(name: string, source: string): StoredMusicFields {
  const fields = JSON.parse(source) as Record<string, unknown>;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('Invalid legacy music fields');
  const text = (key: string) => { const value = fields[key]; if (value == null) return ''; if (typeof value !== 'string') throw new Error('Invalid legacy music field type'); return value; };
  const noteAt = fields.noteAt ?? 0; const genderPublic = fields.genderPublic ?? false;
  if (typeof noteAt !== 'number' || !Number.isFinite(noteAt) || noteAt < 0 || noteAt > 8640000000000 || typeof genderPublic !== 'boolean') throw new Error('Invalid legacy music field type');
  return { name, note: text('note'), noteAt, gender: text('gender'), genderPublic };
}
/** Called within migration/import transactions, never overwrites later field edits. */
export function seedMusicFields(db: DB) {
  const rows = db.prepare(`SELECT p.id AS profile_id,CASE WHEN l.profile_id IS NOT NULL THEN l.name ELSE COALESCE(u.nickname,'未命名成分') END AS name,COALESCE(l.fields_json,'{}') AS fields_json,p.updated_at
    FROM music_profiles p LEFT JOIN music_legacy_profiles l ON l.profile_id=p.id LEFT JOIN users u ON u.id=p.user_id
    WHERE p.erased_at IS NULL AND NOT EXISTS(SELECT 1 FROM music_profile_fields f WHERE f.profile_id=p.id)`).all() as { profile_id: string; name: string; fields_json: string; updated_at: string }[];
  const insert = db.prepare('INSERT INTO music_profile_fields VALUES(?,?,?,?,?,?,0,?)');
  for (const row of rows) { const fields = legacyMusicFields(row.name, row.fields_json); insert.run(row.profile_id, fields.name, fields.note, fields.noteAt, fields.gender, Number(fields.genderPublic), row.updated_at); }
}
