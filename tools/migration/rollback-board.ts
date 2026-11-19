import Database from 'better-sqlite3';
import type { DB } from '@qgroup/database';
import { legacySchema } from '../../packages/database/src/legacy-schema';
import { boardRows, boardTables, quoted, schemaObjects } from './board-reconciliation';
import { verifyRollbackBoard } from './rollback-board-reconciliation';
import { assertRollbackSource } from './rollback-source';
/** A component of the future offline rollback package, not an activation tool.
 * Copies the latest 59 board tables, not a pre-cutover backup. Every other
 * domain still requires export/reconciliation and a fixed runtime rehearsal. */
export function projectRollbackBoard(source:DB) {
  // better-sqlite3 nests transactions with a savepoint; an inner immediate()
  // cannot upgrade an existing deferred reader into a writer lock.
  if(source.inTransaction)throw Error('Rollback board projection requires a standalone source transaction');
  const reference=new Database(':memory:'),copy=new Database(':memory:');
  try {
    copy.pragma('foreign_keys=OFF');
    reference.exec(legacySchema);
    const schema=schemaObjects(reference);
    const report=source.transaction(()=>{
      assertRollbackSource(source);
      const encoding=source.pragma('encoding',{simple:true});if(!['UTF-8','UTF-16le','UTF-16be'].includes(String(encoding)))throw Error('Unsupported rollback encoding');
      copy.pragma("encoding='"+encoding+"'");
      for(const name of ['user_version','application_id']){const value=source.pragma(name,{simple:true});if(typeof value!=='number'||!Number.isSafeInteger(value))throw Error('Invalid rollback database metadata');copy.pragma(name+'='+value);}
      copy.transaction(()=>{
        // Load without triggers or FK ordering effects, then recreate the exact
        // original indexes/triggers. No history, idempotency or bot side effects.
        for(const entry of schema.filter(entry=>entry.type==='table'))copy.exec(entry.sql!);
        for(const table of boardTables){
          const columns=(reference.prepare(`PRAGMA table_xinfo(${quoted(table)})`).all() as {name:string;hidden:number}[]);
          if(columns.some(column=>column.hidden))throw Error('Unsupported rollback generated column');
          const statement=copy.prepare(`INSERT INTO ${quoted(table)}(rowid,${columns.map(column=>quoted(column.name)).join(',')}) VALUES(${Array(columns.length+1).fill('?').join(',')})`);
          for(const row of boardRows(source,table))statement.run(row.__source_rowid__,...columns.map(column=>row[column.name]));
        }
        const names=new Set(boardTables);
        const sequences=source.prepare('SELECT name,seq FROM sqlite_sequence ORDER BY name').safeIntegers(true).all() as {name:string;seq:bigint}[];
        copy.exec('DELETE FROM sqlite_sequence');
        for(const sequence of sequences.filter(row=>names.has(row.name)))copy.prepare('INSERT INTO sqlite_sequence VALUES(?,?)').run(sequence.name,sequence.seq);
        for(const entry of schema.filter(entry=>entry.type==='index'||entry.type==='trigger'))copy.exec(entry.sql!);
      })();
      copy.pragma('foreign_keys=ON');
      return verifyRollbackBoard(source,copy);
    }).immediate();
    return {db:copy,report};
  }catch(error){copy.close();throw error;}finally{reference.close();}
}
