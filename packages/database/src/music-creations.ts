import type { DB } from './index';

/** Imported creation lists and editing ownership have always been different concepts. */
export function musicCreatedIds(db: DB, profileId: string): string[] {
  const legacy = db.prepare('SELECT created_entries_json FROM music_legacy_profiles WHERE profile_id=?').get(profileId) as { created_entries_json: string } | undefined;
  const original: unknown = legacy ? JSON.parse(legacy.created_entries_json) : [];
  if (!Array.isArray(original) || original.some(id => typeof id !== 'string')) throw new Error('Invalid creation list');
  const recorded = db.prepare('SELECT entry_id FROM music_entry_creations WHERE profile_id=? ORDER BY position').all(profileId) as {entry_id:string}[];
  const native = db.prepare('SELECT e.id FROM music_entries e JOIN music_entry_details d ON d.entry_id=e.id WHERE d.created_by=? ORDER BY e.rowid').all(profileId) as {id:string}[];
  return [...new Set([...original as string[], ...recorded.map(r=>r.entry_id), ...native.map(r=>r.id)])];
}
