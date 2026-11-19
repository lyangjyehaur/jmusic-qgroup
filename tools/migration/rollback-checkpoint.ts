import type { DB } from '@qgroup/database';
import { readVerifiedErasureJournal, type ErasureJournal } from '../../apps/api/src/erasure-journal';
import { assertRollbackSource } from './rollback-source';
import { verifyRollbackCheckpoint } from './rollback-checkpoint-reconciliation';

/** Captures the complete latest database and verified journal in one writer
 * transaction. Private bytes only; no file overwrite, migration or activation.
 * All domain projections must subsequently read this same immutable checkpoint. */
export function captureRollbackCheckpoint(source:DB,journal:ErasureJournal){
  if(source.inTransaction)throw Error('Rollback checkpoint requires a standalone source transaction');
  return source.transaction(()=>{
    assertRollbackSource(source);
    const intents=structuredClone(readVerifiedErasureJournal(source,journal));
    const image=source.serialize();
    // SQLite serialization includes WAL's read/write version bytes even though
    // all committed pages are in this image. Make the standalone copy readable
    // without a WAL sidecar; every row/type/schema is independently checked.
    image[18]=1;image[19]=1;
    const report=verifyRollbackCheckpoint(source,image,intents);
    return {image,journal:intents,report};
  }).immediate();
}
