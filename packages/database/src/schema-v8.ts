export const schemaV8 = `
CREATE TABLE music_profile_fields(profile_id TEXT PRIMARY KEY REFERENCES music_profiles(id),name TEXT NOT NULL,note TEXT NOT NULL,note_at REAL NOT NULL CHECK(typeof(note_at) IN ('integer','real') AND note_at>=0 AND note_at<=8640000000000),gender TEXT NOT NULL,gender_public INTEGER NOT NULL CHECK(gender_public IN (0,1)),revision INTEGER NOT NULL CHECK(revision>=0),updated_at TEXT NOT NULL);
CREATE TABLE music_field_history(id INTEGER PRIMARY KEY AUTOINCREMENT,profile_id TEXT NOT NULL REFERENCES music_profiles(id),revision INTEGER NOT NULL,actor_id TEXT NOT NULL REFERENCES users(id),before_json TEXT NOT NULL,after_json TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(profile_id,revision));
CREATE TRIGGER music_fields_no_update BEFORE UPDATE ON music_field_history BEGIN SELECT RAISE(ABORT,'Music field history is append-only'); END;
CREATE TRIGGER music_fields_no_delete BEFORE DELETE ON music_field_history WHEN NOT EXISTS(SELECT 1 FROM music_profiles WHERE id=OLD.profile_id AND erased_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'Music field history is append-only'); END;
UPDATE rebuild_schema SET version=8;
`;
