// Creation-list membership is independent of the term's current editing owner.
export const schemaV12 = `
CREATE TABLE IF NOT EXISTS music_entry_creations(
  profile_id TEXT NOT NULL REFERENCES music_profiles(id),
  entry_id TEXT NOT NULL REFERENCES music_entries(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,PRIMARY KEY(profile_id,entry_id),UNIQUE(profile_id,position)
);
CREATE TRIGGER IF NOT EXISTS music_entry_creations_erasure AFTER UPDATE OF erased_at ON music_profiles
  WHEN NEW.erased_at IS NOT NULL
  BEGIN DELETE FROM music_entry_creations WHERE profile_id=NEW.id; END;
CREATE TABLE IF NOT EXISTS music_catalog_actions(
  id INTEGER PRIMARY KEY,actor_id TEXT REFERENCES users(id),actor_ref TEXT NOT NULL,
  command TEXT NOT NULL,entry_id TEXT NOT NULL,target_id TEXT NOT NULL,
  affected_profiles INTEGER NOT NULL,created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS music_catalog_actions_no_update BEFORE UPDATE ON music_catalog_actions
  BEGIN SELECT RAISE(ABORT,'Music catalog history is append-only'); END;
CREATE TRIGGER IF NOT EXISTS music_catalog_actions_no_delete BEFORE DELETE ON music_catalog_actions
  BEGIN SELECT RAISE(ABORT,'Music catalog history is append-only'); END;
SELECT profile_id,entry_id,position FROM music_entry_creations LIMIT 0;
SELECT id,actor_id,actor_ref,command,entry_id,target_id,affected_profiles,created_at FROM music_catalog_actions LIMIT 0;
UPDATE rebuild_schema SET version=12;
`;
