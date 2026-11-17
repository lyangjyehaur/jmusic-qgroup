import type { DB } from './index';

/** Promote an import once, inside its transaction. Invalid/ambiguous records abort the import. */
export function seedMusicShouts(db: DB) {
  const rows = db.prepare("SELECT kind,position,payload_json FROM music_documents WHERE kind IN ('shouts','shoutHistory') ORDER BY CASE kind WHEN 'shoutHistory' THEN 0 ELSE 1 END,position").all() as { kind: string; position: number; payload_json: string }[];
  let ordinal = 0;
  for (const row of rows) {
    const value: unknown = JSON.parse(row.payload_json);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid imported shout');
    const s = value as Record<string, unknown>;
    if (Object.keys(s).some(key => !['id','qq','name','text','createdAt','archivedAt'].includes(key)) || typeof s.id !== 'string' || !s.id || s.id.length > 128 || typeof s.qq !== 'string' || typeof s.text !== 'string' || s.name !== undefined && typeof s.name !== 'string') throw new Error('Invalid imported shout fields');
    const time = (value: unknown) => {
      if (value === undefined || value === null || value === '') return 0;
      if (!['number','string','boolean'].includes(typeof value)) throw new Error('Invalid imported shout timestamp');
      const parsed = Number(value); if (!Number.isFinite(parsed) || Math.abs(parsed) > Number.MAX_SAFE_INTEGER - 30 * 86400) throw new Error('Invalid imported shout timestamp');
      return parsed;
    };
    const profiles = db.prepare(`SELECT p.id,p.erased_at FROM music_profiles p LEFT JOIN music_legacy_profiles l ON l.profile_id=p.id WHERE l.legacy_key=? OR p.id=?`).all(s.qq,s.qq) as { id: string; erased_at: string | null }[];
    if(profiles.length>1)throw new Error('Ambiguous imported shout author');
    const profile=profiles[0];
    if (profile?.erased_at || db.prepare('SELECT 1 FROM music_legacy_erasures WHERE legacy_key=?').get(s.qq)) {
      db.prepare('DELETE FROM music_documents WHERE kind=? AND position=?').run(row.kind,row.position);
      db.prepare("UPDATE migration_map SET status='erased' WHERE source='music' AND entity_type=? AND source_id=?").run(row.kind,String(row.position));
      continue;
    }
    db.prepare('INSERT INTO music_shouts VALUES(?,?,?,?,?,?,?,?)').run(s.id,profile?.id ?? null,s.qq,s.name || '群友',s.text,time(s.createdAt),row.kind==='shoutHistory'?time(s.archivedAt):null,ordinal++);
  }
}

/** Drop the original migration copy too, so deletion/pruning cannot leave private content behind. */
export function removeMusicShout(db: DB, id: string, status: 'deleted' | 'pruned') {
  db.prepare(`UPDATE migration_map SET status=? WHERE source='music' AND EXISTS(SELECT 1 FROM music_documents d
    WHERE d.kind=migration_map.entity_type AND CAST(d.position AS TEXT)=migration_map.source_id
      AND d.kind IN ('shouts','shoutHistory') AND json_extract(d.payload_json,'$.id')=?)`).run(status,id);
  db.prepare("DELETE FROM music_documents WHERE kind IN ('shouts','shoutHistory') AND json_extract(payload_json,'$.id')=?").run(id);
  return db.prepare('DELETE FROM music_shouts WHERE id=?').run(id).changes;
}
