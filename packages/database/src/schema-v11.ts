export const schemaV11 = `
CREATE TABLE IF NOT EXISTS music_shouts(
  id TEXT PRIMARY KEY,profile_id TEXT REFERENCES music_profiles(id),legacy_key TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,body TEXT NOT NULL,created_at REAL NOT NULL,archived_at REAL,ordinal INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS music_shouts_time ON music_shouts(archived_at,created_at DESC,ordinal);
CREATE INDEX IF NOT EXISTS music_shouts_author ON music_shouts(profile_id,archived_at);
CREATE TABLE IF NOT EXISTS music_shout_authors(profile_id TEXT PRIMARY KEY REFERENCES music_profiles(id),last_post_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS music_shout_deletions(id INTEGER PRIMARY KEY,shout_id TEXT NOT NULL,actor_ref TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS music_shouts_erasure AFTER UPDATE OF erased_at ON music_profiles
  WHEN NEW.erased_at IS NOT NULL
  BEGIN
    UPDATE migration_map SET status='erased' WHERE source='music' AND EXISTS(
      SELECT 1 FROM music_documents d JOIN music_shouts s ON s.id=json_extract(d.payload_json,'$.id')
      WHERE d.kind IN ('shouts','shoutHistory') AND d.kind=migration_map.entity_type
        AND CAST(d.position AS TEXT)=migration_map.source_id AND s.profile_id=NEW.id);
    DELETE FROM music_documents WHERE kind IN ('shouts','shoutHistory')
      AND json_extract(payload_json,'$.id') IN (SELECT id FROM music_shouts WHERE profile_id=NEW.id);
    DELETE FROM music_shouts WHERE profile_id=NEW.id;
    DELETE FROM music_shout_authors WHERE profile_id=NEW.id;
  END;
UPDATE rebuild_schema SET version=11;
`;
