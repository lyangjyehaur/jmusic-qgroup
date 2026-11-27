import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { fixture } from '../testsupport/fixture';
import { adminCatalogFixture, catalogProfiles } from '../testsupport/admin-catalog-fixture';
import { backfillMusicEntryLocks, lockedMusicEntries, retainMusicSelectionLocks } from './music-entry-locks';
const cleanup: (()=>void)[] = [];
afterEach(()=>cleanup.splice(0).reverse().forEach(fn=>fn()));
function setup() {
  const db=openDatabase(':memory:');cleanup.push(()=>db.close());fixture(db);adminCatalogFixture(db);
  db.prepare("INSERT INTO music_entry_details VALUES('sub-2','歌手','[]','10002',0,'null')").run();
  return db;
}
it('legacy creator keys identify self selections; other and unlinked profiles trigger persistent locks',()=>{
  const db=setup();
  db.prepare('INSERT INTO music_selections VALUES(?,?,2,2)').run(catalogProfiles.bob,'sub-2');
  retainMusicSelectionLocks(db,catalogProfiles.bob);
  expect(lockedMusicEntries(db).has('sub-2')).toBe(false);
  db.prepare('INSERT INTO music_selections VALUES(?,?,2,2)').run(catalogProfiles.orphan,'sub-2');
  retainMusicSelectionLocks(db,catalogProfiles.orphan);
  db.prepare("DELETE FROM music_selections WHERE entry_id='sub-2'").run();
  expect(lockedMusicEntries(db).has('sub-2')).toBe(true);
});
it('backfills cancelled native selections from both audit snapshots without locking legacy self history',()=>{
  const db=setup(),insert=db.prepare('INSERT INTO music_profile_audit(profile_id,revision,actor_id,before_json,after_json,created_at) VALUES(?,?,?,?,?,?)');
  insert.run(catalogProfiles.bob,1,'bob',JSON.stringify({selections:[{entryId:'sub-2',level:4}]}),'null','synthetic');
  backfillMusicEntryLocks(db);expect(lockedMusicEntries(db).has('sub-2')).toBe(false);
  insert.run(catalogProfiles.alice,1,'alice','null',JSON.stringify({selections:[{entryId:'sub-2',level:4}]}),'synthetic');
  backfillMusicEntryLocks(db);expect(lockedMusicEntries(db).has('sub-2')).toBe(true);
  const rows=db.prepare("SELECT * FROM music_documents WHERE kind='entry_lock'").all();backfillMusicEntryLocks(db);
  expect(db.prepare("SELECT * FROM music_documents WHERE kind='entry_lock'").all()).toEqual(rows);
  const restored=new Database(db.serialize());cleanup.push(()=>restored.close());
  expect(lockedMusicEntries(restored).has('sub-2')).toBe(true);
});
