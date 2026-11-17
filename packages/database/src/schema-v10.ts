// Creation provenance is independent of mutable profile/field/contact revisions.
// Pre-v10 native profiles without an initial creation audit remain unknown.
export const schemaV10 = `
CREATE TABLE IF NOT EXISTS music_profile_creation(
  profile_id TEXT PRIMARY KEY REFERENCES music_profiles(id),created_at TEXT
);
INSERT OR IGNORE INTO music_profile_creation(profile_id,created_at)
  SELECT p.id,(SELECT min(a.created_at) FROM music_profile_audit a
    WHERE a.profile_id=p.id AND a.revision=1 AND a.before_json='null')
  FROM music_profiles p WHERE p.erased_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM music_legacy_profiles l WHERE l.profile_id=p.id);
CREATE TRIGGER IF NOT EXISTS music_creation_insert AFTER INSERT ON music_profiles
  WHEN NEW.erased_at IS NULL
  BEGIN INSERT INTO music_profile_creation VALUES(NEW.id,NEW.updated_at); END;
CREATE TRIGGER IF NOT EXISTS music_creation_legacy AFTER INSERT ON music_legacy_profiles
  BEGIN DELETE FROM music_profile_creation WHERE profile_id=NEW.profile_id; END;
CREATE TRIGGER IF NOT EXISTS music_creation_erasure AFTER UPDATE OF erased_at ON music_profiles
  WHEN NEW.erased_at IS NOT NULL
  BEGIN DELETE FROM music_profile_creation WHERE profile_id=NEW.id; END;
UPDATE rebuild_schema SET version=10;
`;
