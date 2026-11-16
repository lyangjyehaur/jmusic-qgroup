export const schemaV3 = `
CREATE TABLE migration_runs(source_digest TEXT PRIMARY KEY,manifest_json TEXT NOT NULL,report_json TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE migration_map(source TEXT NOT NULL,entity_type TEXT NOT NULL,source_id TEXT NOT NULL,target_id TEXT NOT NULL,source_revision TEXT NOT NULL,payload_digest TEXT NOT NULL,status TEXT NOT NULL,PRIMARY KEY(source,entity_type,source_id));
CREATE TABLE music_legacy_profiles(profile_id TEXT PRIMARY KEY REFERENCES music_profiles(id),legacy_key TEXT NOT NULL UNIQUE,name TEXT NOT NULL,consent INTEGER NOT NULL,pin_hash TEXT NOT NULL,contact_qq TEXT NOT NULL,fields_json TEXT NOT NULL,created_entries_json TEXT NOT NULL,ownership_source TEXT NOT NULL);
CREATE UNIQUE INDEX music_contact_unique ON music_legacy_profiles(contact_qq) WHERE contact_qq!='';
CREATE TABLE music_entry_details(entry_id TEXT PRIMARY KEY REFERENCES music_entries(id),category TEXT NOT NULL,aliases_json TEXT NOT NULL,created_by TEXT NOT NULL,created_at_json TEXT NOT NULL,updated_at_json TEXT NOT NULL);
CREATE TABLE music_legacy_identity(table_name TEXT NOT NULL,row_number INTEGER NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(table_name,row_number));
CREATE TABLE music_documents(kind TEXT NOT NULL,position INTEGER NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(kind,position));
CREATE TABLE music_legacy_erasures(legacy_key TEXT PRIMARY KEY,erased_at_json TEXT NOT NULL);
UPDATE rebuild_schema SET version=3;
`;
