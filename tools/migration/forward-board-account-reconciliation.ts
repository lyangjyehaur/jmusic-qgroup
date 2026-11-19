import Database from 'better-sqlite3';
import type {DB} from '@qgroup/database';
import {boardTables,quoted,schemaObjects} from './board-reconciliation';
import {copyForwardBoardInput,openForwardBoardSources,forwardRows,forwardEqual,forwardRowReader,forwardSequences,forwardHash,assertForwardImage,type ForwardBoardSources} from './forward-board-storage';
import {reconcileForwardBoardRows} from './forward-board-reconciliation';
import {openForwardBoardAccountAuthority,assertForwardBoardAccountReferences,markForwardBoardAccountClosures,guardForwardBoardAccountInput,type ForwardBoardAccountInput} from './forward-board-account-source';
import {reconcileAppliedAccountRepair} from './forward-account-reconciliation';

/** Independently derive the pre-repair relation from every original source row.
 * No row writer, cleanup routine, report or intermediate image is consulted. */
function deriveBeforeRepair(s:ForwardBoardSources,native:Buffer){
  const db=new Database(native);db.pragma('foreign_keys=OFF');
  try{
    db.transaction(()=>{
      const triggers=schemaObjects(db).filter(row=>row.type==='trigger');for(const row of triggers)db.exec('DROP TRIGGER '+quoted(row.name));
      for(const table of boardTables){
        const rows=[s.baseline,s.native,s.old].map(source=>new Map([...forwardRows(source,table)].map(row=>[row.__forward_rowid__,row])));
        const ids=new Set(rows.flatMap(map=>[...map.keys()])),columns=(db.prepare('PRAGMA table_xinfo('+quoted(table)+')').all() as {name:string}[]).map(row=>row.name);
        db.exec('DELETE FROM '+quoted(table));
        const add=db.prepare('INSERT INTO '+quoted(table)+'(rowid,'+columns.map(quoted).join(',')+') VALUES('+Array(columns.length+1).fill('?').join(',')+')');
        for(const id of [...ids].sort((a,b)=>a<b?-1:a>b?1:0)){
          const [base,current,old]=rows.map(map=>map.get(id));
          if(!forwardEqual(old,base)&&!forwardEqual(current,base)&&!forwardEqual(current,old))throw Error('Independent board account row conflict');
          const wanted=forwardEqual(old,base)?current:old;if(wanted)add.run(id,...columns.map(column=>wanted[column]));
        }
      }
      const expected=forwardSequences(s.native),old=forwardSequences(s.old);
      for(const table of boardTables){const a=expected.get(table),b=old.get(table);if(a===undefined&&b===undefined)continue;expected.set(table,a===undefined?b!:b===undefined?a:a>b?a:b);}
      // sqlite_sequence rowids and ordering are part of the board oracle. Keep
      // native rows and add old-only sequence names in the ordinary table order.
      db.exec('DELETE FROM sqlite_sequence');
      for(const row of forwardRows(s.native,'sqlite_sequence'))db.prepare('INSERT INTO sqlite_sequence(rowid,name,seq) VALUES(?,?,?)').run(row.__forward_rowid__,row.name,expected.get(String(row.name))!);
      for(const table of boardTables)if(!s.native.prepare('SELECT 1 FROM sqlite_sequence WHERE name=?').get(table)&&expected.has(table))db.prepare('INSERT INTO sqlite_sequence VALUES(?,?)').run(table,expected.get(table)!);
      for(const name of ['user_version','application_id']){
        const base=s.baseline.pragma(name,{simple:true}),current=s.native.pragma(name,{simple:true}),old=s.old.pragma(name,{simple:true});
        if(old!==base&&current!==base&&current!==old)throw Error('Independent board account metadata conflict');
        db.pragma(name+'='+String(old===base?current:old));
      }
      db.prepare('UPDATE rebuild_storage SET recovery_required=1 WHERE id=1').run();for(const row of triggers)db.exec(row.sql!);
    }).immediate();db.pragma('foreign_keys=ON');return db;
  }catch(error){db.close();throw error;}
}
/** Re-pinning a corrupted final candidate cannot authorize different rows. */
export function verifyForwardBoardAccountClosures(input:ForwardBoardAccountInput,candidateImage:Buffer){
  const held=copyForwardBoardInput(input.sources),root=input.authorityRoot,pin=input.manifestSha256,s=openForwardBoardSources(held);let source:DB|undefined,candidate:DB|undefined;
  try{
    const a=openForwardBoardAccountAuthority(input,held,s);guardForwardBoardAccountInput(input,held,a,root,pin);assertForwardImage(candidateImage);
    source=deriveBeforeRepair(s,held.nativeImage.bytes);const board=reconcileForwardBoardRows(s,source),references=assertForwardBoardAccountReferences(s,source,a);
    // Check original closures against the independently selected complete row,
    // including rowid, review status, notes and SQLite storage classes.
    const read=forwardRowReader(source,'privacy_requests');for(const row of forwardRows(s.old,'privacy_requests'))if(a.closed.has(String(row.user_id))&&!forwardEqual(row,read(row.__forward_rowid__)))throw Error('Original closure review changed during account merge');
    markForwardBoardAccountClosures(source,a);candidate=new Database(Buffer.from(candidateImage));candidate.pragma('foreign_keys=ON');
    const account=reconcileAppliedAccountRepair(source,candidate,a.journalReader);guardForwardBoardAccountInput(input,held,a,root,pin);
    return {version:1 as const,board,references,account,nativeImageSha256:forwardHash(candidateImage),nativeJournalSha256:forwardHash(a.journal),allRowsVerified:true as const,recoveryRequired:true as const,releaseEligible:false as const};
  }finally{candidate?.close();source?.close();s.close();}
}
