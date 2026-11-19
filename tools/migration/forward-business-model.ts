import {openDatabase,type DB} from '@qgroup/database';
import {importMusic,readIdentity,object,profileId} from './music-codec';
import type {RollbackMusic} from './rollback-music';
import {quoted} from './board-reconciliation';
import {forwardRows} from './forward-board-storage';

/** Disposable normalization only. Original native IDs are restored before any
 * rows are compared; neither this model nor its synthetic metadata is output. */
export function normalizeForwardBusinessMusic(board:DB,music:RollbackMusic,identity:DB){
  const db=openDatabase(':memory:');
  try{
    db.pragma('foreign_keys=OFF');
    for(const table of ['users','external_identities','privacy_requests']){
      const columns=(db.prepare(`PRAGMA table_xinfo(${quoted(table)})`).all() as {name:string}[]).map(row=>row.name),insert=db.prepare(`INSERT INTO ${quoted(table)}(rowid,${columns.map(quoted).join(',')}) VALUES(${Array(columns.length+1).fill('?').join(',')})`);
      for(const row of forwardRows(board,table))insert.run(row.__forward_rowid__,...columns.map(column=>row[column]));
    }
    importMusic(db,music.data,readIdentity(identity),new Map(),'2000-01-01T00:00:00.000Z');
    const triggers=db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as {name:string}[];for(const row of triggers)db.exec(`DROP TRIGGER ${quoted(row.name)}`);
    const refs=['music_selections','music_legacy_profiles','music_profile_contacts','music_profile_fields','music_profile_creation','music_shouts'];
    const mappings=music.keys.filter(row=>Object.hasOwn(object(music.data.members,'normalized members'),row.legacyKey)).map((row,index)=>({before:profileId(row.legacyKey),temporary:'forward-temporary-'+index,after:row.profileId}));
    for(const phase of ['temporary','after'] as const)for(const row of mappings){const before=phase==='temporary'?row.before:row.temporary,next=row[phase];db.prepare('UPDATE music_profiles SET id=? WHERE id=?').run(next,before);for(const table of refs)db.prepare(`UPDATE ${quoted(table)} SET profile_id=? WHERE profile_id=?`).run(next,before);}
    for(const row of music.keys)db.prepare('UPDATE music_entry_details SET created_by=? WHERE created_by=?').run(row.profileId,row.legacyKey);
    return db;
  }catch(error){db.close();throw error;}
}
export const forwardBusinessTables=Object.freeze(['music_entries','music_entry_details','music_profiles','music_selections','music_legacy_profiles','music_profile_fields','music_profile_contacts','music_entry_creations','music_shouts','music_shout_authors','music_claim_attempts','music_account_epochs','music_documents','migration_map','migration_runs','rebuild_storage']);
export function businessRow(db:DB,table:string,keyColumns:string[],values:unknown[]){return db.prepare(`SELECT rowid AS __rowid__,* FROM ${quoted(table)} WHERE ${keyColumns.map(column=>quoted(column)+'=?').join(' AND ')}`).safeIntegers(true).get(...values) as Record<string,unknown>|undefined;}
