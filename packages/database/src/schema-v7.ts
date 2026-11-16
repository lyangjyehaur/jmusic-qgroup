export const schemaV7 = `
CREATE TABLE music_pin_history(id INTEGER PRIMARY KEY AUTOINCREMENT,profile_id TEXT NOT NULL REFERENCES music_profiles(id),revision INTEGER NOT NULL,user_id TEXT REFERENCES users(id),actor_ref TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(profile_id,revision));
CREATE TRIGGER music_pin_no_update BEFORE UPDATE ON music_pin_history BEGIN SELECT RAISE(ABORT,'Music PIN history is append-only'); END;
CREATE TRIGGER music_pin_no_delete BEFORE DELETE ON music_pin_history WHEN NOT EXISTS(SELECT 1 FROM music_profiles WHERE id=OLD.profile_id AND erased_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'Music PIN history is append-only'); END;
UPDATE rebuild_schema SET version=7;
`;
