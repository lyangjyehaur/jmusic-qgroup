/** Keep legacy consent versions intact. Migration never infers new consent. */
export const schemaV15 = `
CREATE TABLE unified_privacy_consents(user_id TEXT NOT NULL REFERENCES users(id),version TEXT NOT NULL,accepted_at TEXT NOT NULL,source TEXT NOT NULL CHECK(source IN ('explicit','name','qq')),PRIMARY KEY(user_id,version));
CREATE TABLE unified_privacy_receipts(user_id TEXT NOT NULL,request_key TEXT NOT NULL,version TEXT NOT NULL,signature TEXT NOT NULL,PRIMARY KEY(user_id,request_key),FOREIGN KEY(user_id,version) REFERENCES unified_privacy_consents(user_id,version) ON DELETE CASCADE);
CREATE TRIGGER unified_privacy_consents_no_update BEFORE UPDATE ON unified_privacy_consents BEGIN SELECT RAISE(ABORT,'Consent records are immutable'); END;
CREATE TRIGGER unified_privacy_receipts_no_update BEFORE UPDATE ON unified_privacy_receipts BEGIN SELECT RAISE(ABORT,'Consent receipts are immutable'); END;
CREATE TRIGGER unified_privacy_consents_no_replace BEFORE INSERT ON unified_privacy_consents WHEN EXISTS(SELECT 1 FROM unified_privacy_consents WHERE user_id=NEW.user_id AND version=NEW.version) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER unified_privacy_receipts_no_replace BEFORE INSERT ON unified_privacy_receipts WHEN EXISTS(SELECT 1 FROM unified_privacy_receipts WHERE user_id=NEW.user_id AND request_key=NEW.request_key) BEGIN SELECT RAISE(ABORT,'Consent receipt already exists'); END;
CREATE TRIGGER unified_privacy_consents_no_closed_account BEFORE INSERT ON unified_privacy_consents WHEN EXISTS(SELECT 1 FROM privacy_requests WHERE user_id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'Account is closed'); END;
CREATE TRIGGER unified_privacy_erasure AFTER INSERT ON privacy_requests BEGIN
  DELETE FROM unified_privacy_receipts WHERE user_id=NEW.user_id;
  DELETE FROM unified_privacy_consents WHERE user_id=NEW.user_id;
END;
UPDATE rebuild_schema SET version=15;
`;
