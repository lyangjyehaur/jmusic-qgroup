// Frozen first rebuild schema; upgrade through explicit migrations.
export const schemaV1 = `
CREATE TABLE rebuild_schema(version INTEGER PRIMARY KEY, baseline TEXT NOT NULL);
INSERT INTO rebuild_schema VALUES(1,'8da877857f163853c449474e168534e2e493121b');
CREATE TABLE music_entries(id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('main','sub')));
CREATE TABLE music_profiles(id TEXT PRIMARY KEY,user_id TEXT NOT NULL UNIQUE REFERENCES users(id),revision INTEGER NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE music_selections(profile_id TEXT NOT NULL REFERENCES music_profiles(id),entry_id TEXT NOT NULL REFERENCES music_entries(id),level INTEGER NOT NULL CHECK(level BETWEEN 1 AND 4),position INTEGER NOT NULL,PRIMARY KEY(profile_id,entry_id),UNIQUE(profile_id,position));
CREATE TABLE music_profile_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,profile_id TEXT NOT NULL REFERENCES music_profiles(id),revision INTEGER NOT NULL,actor_id TEXT NOT NULL REFERENCES users(id),before_json TEXT NOT NULL,after_json TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(profile_id,revision));
CREATE TRIGGER music_audit_no_update BEFORE UPDATE ON music_profile_audit BEGIN SELECT RAISE(ABORT,'Music history is append-only'); END;
CREATE TRIGGER music_audit_no_delete BEFORE DELETE ON music_profile_audit BEGIN SELECT RAISE(ABORT,'Music history is append-only'); END;
`;

