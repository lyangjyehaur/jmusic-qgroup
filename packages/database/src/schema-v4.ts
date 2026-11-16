export const schemaV4 = `
CREATE TABLE music_profile_contacts(profile_id TEXT PRIMARY KEY REFERENCES music_profiles(id),contact_qq TEXT NOT NULL,source TEXT NOT NULL CHECK(source IN ('legacy','self_reported')),revision INTEGER NOT NULL CHECK(revision>=0),updated_at TEXT NOT NULL);
CREATE UNIQUE INDEX music_profile_contact_unique ON music_profile_contacts(contact_qq) WHERE contact_qq!='';
CREATE TABLE music_contact_history(id INTEGER PRIMARY KEY AUTOINCREMENT,profile_id TEXT NOT NULL REFERENCES music_profiles(id),revision INTEGER NOT NULL,actor_id TEXT NOT NULL REFERENCES users(id),before_json TEXT NOT NULL,after_json TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TRIGGER music_contact_history_no_update BEFORE UPDATE ON music_contact_history BEGIN SELECT RAISE(ABORT,'Music contact history is append-only'); END;
CREATE TRIGGER music_contact_history_no_delete BEFORE DELETE ON music_contact_history WHEN NOT EXISTS(SELECT 1 FROM music_profiles WHERE id=OLD.profile_id AND erased_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'Music contact history is append-only'); END;
INSERT INTO music_profile_contacts SELECT l.profile_id,l.contact_qq,CASE WHEN l.legacy_key NOT GLOB '*[^0-9]*' AND length(l.legacy_key) BETWEEN 4 AND 12 THEN 'legacy' ELSE 'self_reported' END,0,p.updated_at FROM music_legacy_profiles l JOIN music_profiles p ON p.id=l.profile_id WHERE p.erased_at IS NULL;
UPDATE rebuild_schema SET version=4;
`;
