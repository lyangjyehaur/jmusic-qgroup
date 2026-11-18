// Frozen source schema from music_site/identity_store.py. Changes require explicit migration review.
export const identitySchema = `
                CREATE TABLE IF NOT EXISTS sessions(
                    token_hash TEXT PRIMARY KEY, qq TEXT NOT NULL, expires REAL NOT NULL,
                    source_session TEXT NOT NULL DEFAULT '', pending_until REAL NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS links(
                    qq TEXT PRIMARY KEY, app_id TEXT NOT NULL, openid TEXT NOT NULL,
                    user_id TEXT NOT NULL UNIQUE, created REAL NOT NULL,
                    source TEXT NOT NULL DEFAULT 'legacy_pin_and_qq_oauth',
                    UNIQUE(app_id,openid));
                CREATE TABLE IF NOT EXISTS used_oauth(attempt TEXT PRIMARY KEY, created REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS prelinks(
                    qq TEXT PRIMARY KEY,user_id TEXT NOT NULL UNIQUE,created REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS login_attempts(bucket TEXT NOT NULL, created REAL NOT NULL);
                CREATE INDEX IF NOT EXISTS attempt_bucket ON login_attempts(bucket,created);
                CREATE TABLE IF NOT EXISTS link_overrides(
                    qq TEXT PRIMARY KEY,user_id TEXT NOT NULL,revision INTEGER NOT NULL,updated REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS link_audit(
                    id INTEGER PRIMARY KEY AUTOINCREMENT,qq TEXT NOT NULL,actor TEXT NOT NULL,
                    before_user_id TEXT NOT NULL,after_user_id TEXT NOT NULL,created REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS native_profiles(qq TEXT PRIMARY KEY,payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS profile_contacts(qq TEXT PRIMARY KEY,number TEXT NOT NULL,updated REAL NOT NULL);
                CREATE UNIQUE INDEX IF NOT EXISTS contact_number ON profile_contacts(number) WHERE number!='';
                CREATE TABLE IF NOT EXISTS entry_intents(
                    token_hash TEXT PRIMARY KEY,qq TEXT NOT NULL,source_session TEXT NOT NULL,
                    target_user_id TEXT NOT NULL,payload TEXT NOT NULL,expires REAL NOT NULL);
            `;
