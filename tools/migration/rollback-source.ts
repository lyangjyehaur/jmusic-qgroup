import { openDatabase, REBUILD_SCHEMA_VERSION, type DB } from '@qgroup/database';
import { schemaObjects } from './board-reconciliation';
const schema=(()=>{const db=openDatabase(':memory:');try{return schemaObjects(db);}finally{db.close();}})();
/** Call while holding the source's standalone IMMEDIATE transaction. */
export function assertRollbackSource(db:DB){
  if(!db.inTransaction)throw Error('Rollback source requires a held transaction');
  const version=db.prepare('SELECT version FROM rebuild_schema').all() as {version:number}[];
  if(version.length!==1||version[0]?.version!==REBUILD_SCHEMA_VERSION||JSON.stringify(schemaObjects(db))!==JSON.stringify(schema))throw Error('Unsupported rollback source schema');
  if(db.pragma('integrity_check',{simple:true})!=='ok'||(db.pragma('foreign_key_check') as unknown[]).length)throw Error('Invalid rollback source integrity');
}
