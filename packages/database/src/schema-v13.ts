export const schemaV13 = `
CREATE TABLE IF NOT EXISTS wallpaper_assets(digest TEXT PRIMARY KEY,mime TEXT NOT NULL,data BLOB NOT NULL,size INTEGER NOT NULL,CHECK(size=length(data)));
CREATE TABLE IF NOT EXISTS wallpaper_items(id TEXT PRIMARY KEY,source TEXT NOT NULL UNIQUE,name TEXT NOT NULL,enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),position INTEGER NOT NULL UNIQUE,digest TEXT REFERENCES wallpaper_assets(digest));
CREATE TABLE IF NOT EXISTS wallpaper_config(id INTEGER PRIMARY KEY CHECK(id=1),rotate_seconds INTEGER NOT NULL CHECK(rotate_seconds BETWEEN 8 AND 600),revision INTEGER NOT NULL,initialized INTEGER NOT NULL,legacy_manifest_json TEXT);
INSERT OR IGNORE INTO wallpaper_config VALUES(1,24,0,0,NULL);
CREATE TABLE IF NOT EXISTS appearance_actions(id INTEGER PRIMARY KEY,actor_id TEXT REFERENCES users(id),actor_ref TEXT NOT NULL,command TEXT NOT NULL,item_id TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS appearance_actions_no_update BEFORE UPDATE ON appearance_actions BEGIN SELECT RAISE(ABORT,'Appearance history is append-only'); END;
CREATE TRIGGER IF NOT EXISTS appearance_actions_no_delete BEFORE DELETE ON appearance_actions BEGIN SELECT RAISE(ABORT,'Appearance history is append-only'); END;
SELECT digest,mime,data,size FROM wallpaper_assets LIMIT 0;
SELECT id,source,name,enabled,position,digest FROM wallpaper_items LIMIT 0;
SELECT id,rotate_seconds,revision,initialized,legacy_manifest_json FROM wallpaper_config LIMIT 0;
SELECT id,actor_id,actor_ref,command,item_id,created_at FROM appearance_actions LIMIT 0;
UPDATE rebuild_schema SET version=13;
`;
