import type {DB} from '@qgroup/database';
import {erasureRequestId, readVerifiedErasureJournal,type ErasureJournal} from '../../apps/api/src/erasure-journal';
import {assertRollbackSource} from './rollback-source';
import {verifyRollbackMusic} from './rollback-music-reconciliation';
import type {RollbackMusic} from './rollback-music';
import {parseJson,type Json} from './music-codec';
import {verifyRollbackErasures} from './rollback-erasures-reconciliation';

export type LegacyBoardErasure={user_id:string;request_id:string;created_at:string};
export type LegacyMusicErasure={qq:string;erased_at:Json};
export type RollbackErasures={boardJournal:string;musicJournal:string;unifiedJournal:string;scopes:{requestId:string;kind:string;profileKeys:string[];entries:string[];alreadyApplied:true}[]};
export const journalText=(rows:unknown[])=>rows.map(row=>JSON.stringify(row)+'\n').join('');
/** Latest deletion ledgers accompanying already-projected data, never an
 * authorization to replay a reset against arbitrary old backups. The complete
 * journal and receipts remain in the private full source checkpoint. */
export function projectRollbackErasures(db:DB,journal:ErasureJournal,music:RollbackMusic){
  if(db.inTransaction)throw Error('Rollback erasures require a standalone source transaction');
  return db.transaction(()=>{
    assertRollbackSource(db);const intents=readVerifiedErasureJournal(db,journal);verifyRollbackMusic(db,music,intents);
    const board:LegacyBoardErasure[]=[],seen=new Map<string,LegacyBoardErasure>(),map=new Map(music.keys.map(row=>[row.profileId,row]));
    for(const row of intents){
      const entry:LegacyBoardErasure|undefined='user_id' in row?{...row}:row.version===1&&row.kind!=='music'?{user_id:row.userId,request_id:row.requestId,created_at:row.createdAt}:undefined;
      if(entry&&!seen.has(entry.request_id)){seen.set(entry.request_id,entry);board.push(entry);}
    }
    // Imported closures can precede the supplied durable journal. Keep their
    // original request ID/time rather than minting a synthetic deletion intent.
    for(const row of db.prepare('SELECT user_id,id,created_at FROM privacy_requests ORDER BY rowid').all() as {user_id:string;id:string;created_at:string}[]){
      const previous=seen.get(row.id);
      if(previous){
        if(previous.user_id!==row.user_id||previous.created_at!==row.created_at)throw Error('Ambiguous rollback account erasure marker');
      }else{
        if(intents.some(entry=>(erasureRequestId(entry))===row.id))throw Error('Ambiguous rollback account erasure ID');
        const entry={user_id:row.user_id,request_id:row.id,created_at:row.created_at};seen.set(row.id,entry);board.push(entry);
      }
    }
    const erased=new Map<string,Json>();
    for(const row of db.prepare('SELECT legacy_key,erased_at_json FROM music_legacy_erasures ORDER BY rowid').all() as {legacy_key:string;erased_at_json:string}[])erased.set(row.legacy_key,parseJson(row.erased_at_json));
    for(const row of db.prepare('SELECT id,erased_at FROM music_profiles WHERE erased_at IS NOT NULL ORDER BY rowid').all() as {id:string;erased_at:string}[]){
      const key=map.get(row.id);if(!key?.erased)throw Error('Missing rollback erased profile mapping');if(!erased.has(key.legacyKey))erased.set(key.legacyKey,row.erased_at);
    }
    const scopes:RollbackErasures['scopes']=[];const unique=new Set<string>();
    for(const row of intents){const requestId=erasureRequestId(row);if(unique.has(requestId))continue;unique.add(requestId);
      const ids='user_id' in row||row.kind==='account'?[]:row.version===2?row.profiles.map(profile=>profile.id):[row.profileId!];
      const profileKeys=ids.map(id=>{const key=map.get(id);if(!key?.erased)throw Error('Rollback erasure scope lacks current tombstone');return key.legacyKey;});
      scopes.push({requestId,kind:'user_id' in row?'account':row.version===2?row.command:row.kind,profileKeys,entries:'version' in row&&row.version===2?[...row.entries]:[],alreadyApplied:true});
    }
    const result:RollbackErasures={boardJournal:journalText(board),musicJournal:journalText([...erased].map(([qq,erased_at])=>({qq,erased_at}))),unifiedJournal:journalText(intents),scopes};
    return {...result,report:verifyRollbackErasures(db,result,music,intents)};
  }).immediate();
}
