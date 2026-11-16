export const schemaV6 = `
CREATE TABLE music_ownership_history(id INTEGER PRIMARY KEY AUTOINCREMENT,profile_id TEXT NOT NULL REFERENCES music_profiles(id),revision INTEGER NOT NULL,actor_ref TEXT NOT NULL,before_user_id TEXT,after_user_id TEXT,reason TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(profile_id,revision));
CREATE TRIGGER music_ownership_no_update BEFORE UPDATE ON music_ownership_history BEGIN SELECT RAISE(ABORT,'Music ownership history is append-only'); END;
CREATE TRIGGER music_ownership_no_delete BEFORE DELETE ON music_ownership_history WHEN NOT EXISTS(SELECT 1 FROM music_profiles WHERE id=OLD.profile_id AND erased_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'Music ownership history is append-only'); END;
UPDATE rebuild_schema SET version=6;
`;
