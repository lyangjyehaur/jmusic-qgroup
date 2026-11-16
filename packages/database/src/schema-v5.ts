export const schemaV5 = `
CREATE TABLE music_claim_attempts(bucket TEXT NOT NULL CHECK(length(bucket)=67 AND substr(bucket,1,3) IN ('qq:','ip:') AND substr(bucket,4) NOT GLOB '*[^a-f0-9]*'),created REAL NOT NULL CHECK(typeof(created) IN ('real','integer') AND created>=0 AND created<=9007199254740991));
CREATE INDEX music_claim_attempt_bucket ON music_claim_attempts(bucket,created);
INSERT INTO music_claim_attempts SELECT json_extract(payload_json,'$.bucket'),json_extract(payload_json,'$.created') FROM music_legacy_identity WHERE table_name='login_attempts';
CREATE TABLE music_claim_intents(id TEXT PRIMARY KEY,current_token_hash TEXT NOT NULL,target_user_id TEXT REFERENCES users(id),profile_id TEXT NOT NULL REFERENCES music_profiles(id),profile_revision INTEGER NOT NULL,pin_proof TEXT NOT NULL,input_digest TEXT NOT NULL,music_epoch INTEGER,stage TEXT NOT NULL CHECK(stage IN ('pending','authorized','completed')),attempt_id TEXT,app_id TEXT NOT NULL DEFAULT '',subject TEXT NOT NULL DEFAULT '',expires_at TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX music_claim_device ON music_claim_intents(current_token_hash,created_at);
CREATE INDEX music_claim_profile ON music_claim_intents(profile_id);
CREATE UNIQUE INDEX music_claim_oauth_once ON music_claim_intents(attempt_id) WHERE attempt_id IS NOT NULL;
UPDATE rebuild_schema SET version=5;
`;
