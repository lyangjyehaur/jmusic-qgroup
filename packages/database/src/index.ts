import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { legacySchema } from './legacy-schema';
import { schemaV1 } from './schema-v1';
import { schemaV3 } from './schema-v3';
import { schemaV4 } from './schema-v4';
import { schemaV5 } from './schema-v5';
import { schemaV6 } from './schema-v6';
import { schemaV7 } from './schema-v7';
import { schemaV8 } from './schema-v8';
import { schemaV9 } from './schema-v9';
import { schemaV10 } from './schema-v10';
import { schemaV11 } from './schema-v11';
import { seedMusicShouts } from './music-shouts';
import { seedMusicFields } from './music-fields';

export type DB = Database.Database;
export const REBUILD_SCHEMA_VERSION = 11;
function migratePrivacy(db: DB) {
  // Rebuild only our own table. Child foreign keys retain the stable table name.
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`CREATE TABLE music_profiles_next(id TEXT PRIMARY KEY,user_id TEXT UNIQUE REFERENCES users(id),revision INTEGER NOT NULL,updated_at TEXT NOT NULL,erased_at TEXT,
        CHECK(erased_at IS NULL OR user_id IS NULL));
        INSERT INTO music_profiles_next SELECT id,user_id,revision,updated_at,NULL FROM music_profiles;
        DROP TABLE music_profiles;
        ALTER TABLE music_profiles_next RENAME TO music_profiles;
        CREATE TABLE music_profile_receipts(user_id TEXT NOT NULL,request_key TEXT NOT NULL,profile_id TEXT NOT NULL REFERENCES music_profiles(id),
          PRIMARY KEY(user_id,request_key),FOREIGN KEY(user_id,request_key) REFERENCES request_results(user_id,request_key) ON DELETE CASCADE);
        INSERT INTO music_profile_receipts SELECT r.user_id,r.request_key,p.id FROM request_results r JOIN music_profiles p
          ON p.id=json_extract(CASE WHEN json_valid(r.response_json) THEN r.response_json ELSE '{}' END,'$.id');
        CREATE TABLE privacy_receipts(request_id TEXT PRIMARY KEY,secret_hash TEXT NOT NULL,signature TEXT NOT NULL,result_json TEXT NOT NULL);
        CREATE TABLE erasure_applied(request_id TEXT PRIMARY KEY);
        CREATE TABLE music_account_epochs(user_id TEXT PRIMARY KEY REFERENCES users(id),epoch INTEGER NOT NULL);
        DROP TRIGGER music_audit_no_delete;
        CREATE TRIGGER music_audit_no_delete BEFORE DELETE ON music_profile_audit
          WHEN NOT EXISTS(SELECT 1 FROM music_profiles WHERE id=OLD.profile_id AND erased_at IS NOT NULL)
          BEGIN SELECT RAISE(ABORT,'Music history is append-only'); END;
        UPDATE rebuild_schema SET version=2;`);
      if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('Privacy migration foreign key check failed');
    }).immediate();
  } finally { db.pragma('foreign_keys = ON'); }
}
export function openDatabase(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
    // Never run replacement migrations on an arbitrary legacy/production DB.
    if (tables.length && !tables.some(t => t.name === 'rebuild_schema')) throw new Error('Refusing legacy database: use an explicit isolated migration copy');
    if (tables.length) {
      const versions = db.prepare('SELECT version,baseline FROM rebuild_schema').all() as { version: number; baseline: string }[];
      if (versions.length !== 1 || ![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, REBUILD_SCHEMA_VERSION].includes(versions[0]?.version ?? 0) || versions[0]?.baseline !== '8da877857f163853c449474e168534e2e493121b') throw new Error('Unsupported rebuild schema');
    }
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.pragma('journal_mode = WAL');
    if (!tables.length) db.transaction(() => { db.exec(legacySchema); db.exec(schemaV1); }).immediate();
    if ((db.prepare('SELECT version FROM rebuild_schema').get() as { version: number }).version === 1) migratePrivacy(db);
    if ((db.prepare('SELECT version FROM rebuild_schema').get() as { version: number }).version === 2) db.transaction(() => { db.exec(schemaV3); if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('Import migration foreign key check failed'); }).immediate();
    if ((db.prepare('SELECT version FROM rebuild_schema').get() as { version: number }).version === 3) db.transaction(() => { db.exec(schemaV4); if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('Contact migration foreign key check failed'); }).immediate();
    if ((db.prepare('SELECT version FROM rebuild_schema').get() as { version: number }).version === 4) db.transaction(() => { db.exec(schemaV5); if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('Claim migration foreign key check failed'); }).immediate();
    if ((db.prepare('SELECT version FROM rebuild_schema').get() as { version: number }).version === 5) db.transaction(() => { db.exec(schemaV6); if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('Ownership migration foreign key check failed'); }).immediate();
    if ((db.prepare('SELECT version FROM rebuild_schema').get() as { version: number }).version === 6) db.transaction(() => { db.exec(schemaV7); if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('PIN migration foreign key check failed'); }).immediate();
    if ((db.prepare('SELECT version FROM rebuild_schema').get() as { version: number }).version === 7) db.transaction(() => { db.exec(schemaV8); seedMusicFields(db); if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('Music field migration foreign key check failed'); }).immediate();
    if ((db.prepare('SELECT version FROM rebuild_schema').get() as { version: number }).version === 8) db.transaction(() => { db.exec(schemaV9); if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('Bot baseline migration foreign key check failed'); }).immediate();
    if ((db.prepare('SELECT version FROM rebuild_schema').get() as { version: number }).version === 9) db.transaction(() => { db.exec(schemaV10); if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('Music creation migration foreign key check failed'); }).immediate();
    if ((db.prepare('SELECT version FROM rebuild_schema').get() as { version: number }).version === 10) db.transaction(() => { db.exec(schemaV11); seedMusicShouts(db); if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('Shout migration foreign key check failed'); }).immediate();
    // The frozen export contains structure only; supply the legacy secure default.
    db.prepare('INSERT OR IGNORE INTO site_settings(id) VALUES(1)').run();
    return db;
  } catch (error) { db.close(); throw error; }
}

export { eraseLegacyProfile, detachLegacyAccount, retireLegacyProfileProofs } from './legacy-erasure';
export { legacyMusicFields, seedMusicFields, type StoredMusicFields } from './music-fields';
export { seedMusicShouts, removeMusicShout } from './music-shouts';
