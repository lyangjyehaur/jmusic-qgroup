import Database from 'better-sqlite3';
import type {DB} from '@qgroup/database';
import {createHash} from 'node:crypto';
import {boardTables,schemaObjects} from './board-reconciliation';
import {assertRollbackSource} from './rollback-source';
import {copyForwardBoardInput,openForwardBoardSources,forwardRows,forwardRowReader,forwardEqual,forwardCanonical,forwardSequences,assertForwardImage,forwardHash,type ForwardBoardInput,type ForwardBoardSources,type ForwardRow} from './forward-board-storage';

const reject=():never=>{throw Error('Forward board reconciliation failed; retain every source');};
/** Independent row-wise oracle. It reads sources directly, never a merge report,
 * migration_map statuses, the projector or a caller-provided change list. */
export function reconcileForwardBoardSources(s:ForwardBoardSources,candidate:DB){
  if((candidate.pragma('foreign_key_check') as unknown[]).length)throw Error('Forward merge requires complete cross-domain reference reconciliation');
  candidate.transaction(()=>assertRollbackSource(candidate)).immediate();
  if(!forwardEqual(schemaObjects(candidate),schemaObjects(s.native)))reject();
  const counts:Record<string,{baseline:number;native:number;old:number;candidate:number;oldChanges:number}>={},hash=createHash('sha256');
  for(const table of boardTables){
    const ids=new Set<bigint>();const item={baseline:0,native:0,old:0,candidate:0,oldChanges:0};
    const reads=[s.baseline,s.native,s.old,candidate].map(db=>forwardRowReader(db,table));
    for(const [db,key] of [[s.baseline,'baseline'],[s.native,'native'],[s.old,'old'],[candidate,'candidate']] as const)for(const row of forwardRows(db,table)){ids.add(row.__forward_rowid__);item[key]++;}
    for(const id of [...ids].sort((a,b)=>a<b?-1:a>b?1:0)){
      const [base,current,old,actual]=reads.map(read=>read(id));
      let wanted:ForwardRow|undefined;
      if(forwardEqual(old,base))wanted=current;
      else{item.oldChanges++;if(!forwardEqual(current,base)&&!forwardEqual(current,old))reject();wanted=old;}
      if(!forwardEqual(actual,wanted))reject();hash.update(forwardCanonical([table,id,actual])+'\n');
    }
    counts[table]=item;
  }
  const others=(schemaObjects(s.native).filter(row=>row.type==='table'&&!boardTables.includes(row.name))).map(row=>row.name);
  let nativeOnlyRows=0;
  for(const table of others){
    const before=forwardRows(s.native,table),after=forwardRows(candidate,table);
    try{for(;;){const a=before.next(),b=after.next();if(a.done!==b.done)reject();if(a.done)break;
      const compared={...b.value};
      if(table==='rebuild_storage'){if(b.value.recovery_required!==1n)reject();compared.recovery_required=a.value.recovery_required;}
      if(!forwardEqual(a.value,compared))reject();hash.update(forwardCanonical([table,b.value])+'\n');nativeOnlyRows++;
    }}finally{before.return?.();after.return?.();}
  }
  const baseSeq=forwardSequences(s.baseline),nativeSeq=forwardSequences(s.native),oldSeq=forwardSequences(s.old),actualSeq=forwardSequences(candidate),wantedSeq=new Map(nativeSeq);
  for(const name of boardTables){const a=nativeSeq.get(name),b=oldSeq.get(name),minimum=baseSeq.get(name);if(minimum!==undefined&&((a??-1n)<minimum||(b??-1n)<minimum))reject();if(a!==undefined||b!==undefined)wantedSeq.set(name,a===undefined?b!:b===undefined?a:a>b?a:b);}
  if(!forwardEqual([...actualSeq].sort(([a],[b])=>a<b?-1:a>b?1:0),[...wantedSeq].sort(([a],[b])=>a<b?-1:a>b?1:0)))reject();
  for(const name of ['user_version','application_id']){
    const base=s.baseline.pragma(name,{simple:true}),old=s.old.pragma(name,{simple:true}),current=s.native.pragma(name,{simple:true});
    if(old!==base&&current!==base&&current!==old)reject();if(candidate.pragma(name,{simple:true})!==(old===base?current:old))reject();
  }
  if(s.old.pragma('encoding',{simple:true})!==s.baseline.pragma('encoding',{simple:true})||candidate.pragma('encoding',{simple:true})!==s.native.pragma('encoding',{simple:true}))reject();
  return {version:1 as const,tableCount:boardTables.length,tables:counts,nativeOnlyTables:others.length,nativeOnlyRows,rowsDigest:hash.digest('hex'),sequences:[...actualSeq].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([name,seq])=>({name,seq:seq.toString()})),recoveryRequired:true as const,releaseEligible:false as const};
}
export function verifyForwardBoardMerge(input:ForwardBoardInput,candidateImage:Buffer){
  const held=copyForwardBoardInput(input);assertForwardImage(candidateImage);const sources=openForwardBoardSources(held);let db:DB|undefined;
  try{db=new Database(Buffer.from(candidateImage));const report=reconcileForwardBoardSources(sources,db);return {...report,imageSha256:forwardHash(candidateImage)};}finally{db?.close();sources.close();}
}
