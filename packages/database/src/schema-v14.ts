export const schemaV14 = `
CREATE TABLE rebuild_storage(id INTEGER PRIMARY KEY CHECK(id=1),recovery_required INTEGER NOT NULL DEFAULT 0 CHECK(recovery_required IN (0,1)),lineage_id TEXT NOT NULL UNIQUE CHECK(length(lineage_id)=32 AND lineage_id NOT GLOB '*[^a-f0-9]*'));
INSERT INTO rebuild_storage(id,lineage_id) VALUES(1,lower(hex(randomblob(16))));
CREATE TRIGGER rebuild_storage_no_insert BEFORE INSERT ON rebuild_storage WHEN EXISTS(SELECT 1 FROM rebuild_storage) BEGIN SELECT RAISE(ABORT,'Storage lineage is immutable'); END;
CREATE TRIGGER rebuild_storage_no_update BEFORE UPDATE ON rebuild_storage WHEN OLD.recovery_required=1 OR NEW.id!=OLD.id OR NEW.lineage_id!=OLD.lineage_id BEGIN SELECT RAISE(ABORT,'Storage lineage is immutable'); END;
CREATE TRIGGER rebuild_storage_no_delete BEFORE DELETE ON rebuild_storage BEGIN SELECT RAISE(ABORT,'Storage lineage is immutable'); END;
SELECT id,lineage_id,recovery_required FROM rebuild_storage LIMIT 0;
UPDATE rebuild_schema SET version=14;
`;
