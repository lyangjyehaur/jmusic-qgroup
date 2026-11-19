import type {DB} from '@qgroup/database';
import {boardTables,quoted,schemaObjects} from './board-reconciliation';
import {forwardRows,forwardEqual,forwardSequences,forwardHash,forwardCanonical,type ForwardRow,type ForwardBoardSources} from './forward-board-storage';

function* triples(base:IterableIterator<ForwardRow>,native:IterableIterator<ForwardRow>,old:IterableIterator<ForwardRow>){
  const reads=[base,native,old],heads=reads.map(read=>read.next());
  try{while(heads.some(head=>!head.done)){
    const id=heads.filter(head=>!head.done).map(head=>head.value.__forward_rowid__ as bigint).reduce((a,b)=>a<b?a:b);
    const rows=heads.map((head,index)=>{if(head.done||head.value.__forward_rowid__!==id)return undefined;const row=head.value as ForwardRow;heads[index]=reads[index]!.next();return row;});
    yield {id,base:rows[0],native:rows[1],old:rows[2]};
  }}finally{for(const read of reads)read.return?.();}
}
/** Internal disposable row writer. This is not a valid-image export: the caller
 * must independently reconcile rows, references and all erasures before serializing. */
export function applyForwardBoardRows(sources:ForwardBoardSources,candidate:DB){
  if(candidate.inTransaction||candidate.pragma('foreign_keys',{simple:true})!==0)throw Error('Forward row writer requires a disposable standalone candidate');
  const decisions:Record<string,{inserted:number;updated:number;deleted:number;coalesced:number;changeSha256:string}>={};
  candidate.transaction(()=>{
      // Bypass side effects only on this disposable candidate. Restore every
      // original trigger before checking the full schema and returning bytes.
      const triggers=schemaObjects(candidate).filter(row=>row.type==='trigger');for(const trigger of triggers)candidate.exec(`DROP TRIGGER ${quoted(trigger.name)}`);
      for(const table of boardTables){
        const columns=(candidate.prepare(`PRAGMA table_xinfo(${quoted(table)})`).all() as {name:string}[]).map(row=>row.name);
        const remove=candidate.prepare(`DELETE FROM ${quoted(table)} WHERE rowid=?`),add=candidate.prepare(`INSERT INTO ${quoted(table)}(rowid,${columns.map(quoted).join(',')}) VALUES(${Array(columns.length+1).fill('?').join(',')})`);
        const item={inserted:0,updated:0,deleted:0,coalesced:0,changeSha256:''},changes:string[]=[],insertions:ForwardRow[]=[];
        for(const row of triples(forwardRows(sources.baseline,table),forwardRows(sources.native,table),forwardRows(sources.old,table))){
          if(forwardEqual(row.old,row.base))continue;
          if(!forwardEqual(row.native,row.base)&&!forwardEqual(row.native,row.old))throw Error(`Forward board row conflict in ${table}; explicit reconciliation required`);
          changes.push(forwardCanonical({rowid:row.id,before:row.base?forwardHash(forwardCanonical(row.base)):null,native:row.native?forwardHash(forwardCanonical(row.native)):null,old:row.old?forwardHash(forwardCanonical(row.old)):null}));
          if(forwardEqual(row.native,row.old)){item.coalesced++;continue;}
          if(!row.base)item.inserted++;else if(!row.old)item.deleted++;else item.updated++;
          remove.run(row.id);if(row.old)insertions.push(row.old);
        }
        // Remove the whole changed set before insertion: a valid old snapshot
        // can exchange two UNIQUE values through an intermediate service write.
        for(const row of insertions)add.run(row.__forward_rowid__,...columns.map(column=>row[column]));
        item.changeSha256=forwardHash(changes.join('\n'));decisions[table]=item;
      }
      const native=forwardSequences(sources.native),old=forwardSequences(sources.old);
      for(const table of boardTables){const a=native.get(table),b=old.get(table);if(a===undefined&&b===undefined)continue;const seq=a===undefined?b!:b===undefined?a:a>b?a:b;const exists=candidate.prepare('SELECT 1 FROM sqlite_sequence WHERE name=?').get(table);if(exists)candidate.prepare('UPDATE sqlite_sequence SET seq=? WHERE name=?').run(seq,table);else candidate.prepare('INSERT INTO sqlite_sequence VALUES(?,?)').run(table,seq);}
      for(const name of ['user_version','application_id']){const base=sources.baseline.pragma(name,{simple:true}),old=sources.old.pragma(name,{simple:true}),current=sources.native.pragma(name,{simple:true});if(old!==base&&current!==base&&current!==old)throw Error('Forward board metadata conflict');const value=old===base?current:old;if(typeof value!=='number'||!Number.isSafeInteger(value))throw Error('Invalid forward metadata');candidate.pragma(name+'='+value);}
      candidate.prepare('UPDATE rebuild_storage SET recovery_required=1 WHERE id=1 AND recovery_required<>1').run();
      for(const trigger of triggers)candidate.exec(trigger.sql!);
    }).immediate();
  return decisions;
}
