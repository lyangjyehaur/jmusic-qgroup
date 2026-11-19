import {createHash} from 'node:crypto';
import type {DB} from '@qgroup/database';
import {z} from 'zod';
import {erasureRequestId, decodeErasureJournal,readVerifiedErasureJournal,type StoredIntent} from '../../apps/api/src/erasure-journal';
import type {RollbackMusic} from './rollback-music';
import type {RollbackErasures,LegacyBoardErasure,LegacyMusicErasure} from './rollback-erasures';
import {verifyRollbackMusic} from './rollback-music-reconciliation';
import {parseJson,object,keys} from './music-codec';
function reject():never{throw Error('Rollback erasure reconciliation failed; retain the complete latest source');}
function canonical(value:unknown):string{return JSON.stringify(value,(_key,item:unknown)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item);}
const same=(a:unknown,b:unknown)=>{if(canonical(a)!==canonical(b))reject();};
function lines(source:string){if(typeof source!=='string'||source&&!source.endsWith('\n'))reject();return source===''?[]:source.slice(0,-1).split('\n').map(line=>object(parseJson(line),'rollback erasure'));}
/** Derives deletion sets and intent scopes directly from current source rows;
 * never calls the erasure projector or replays deletion against the source. */
export function verifyRollbackErasures(db:DB,result:RollbackErasures,music:RollbackMusic,intents:StoredIntent[]){
  if(!db.inTransaction)throw Error('Rollback erasure verification requires a held source transaction');
  readVerifiedErasureJournal(db,{read:()=>intents,append(){throw Error('Read-only reconciliation');}});
  verifyRollbackMusic(db,music,intents);
  same(Object.keys(result).filter(key=>key!=='report').sort(),['boardJournal','musicJournal','unifiedJournal','scopes'].sort());
  lines(result.unifiedJournal);const unified=decodeErasureJournal(result.unifiedJournal);same(unified,intents);
  const board=lines(result.boardJournal) as unknown as LegacyBoardErasure[],erased=lines(result.musicJournal) as unknown as LegacyMusicErasure[];
  for(const entry of board){keys(entry as unknown as ReturnType<typeof object>,['user_id','request_id','created_at'],'board erasure');if(Object.keys(entry).length!==3||[entry.user_id,entry.request_id].some(value=>typeof value!=='string'||!value||value.length>128)||typeof entry.created_at!=='string'||!entry.created_at||entry.created_at.length>80)reject();}
  for(const entry of erased){keys(entry as unknown as ReturnType<typeof object>,['qq','erased_at'],'music erasure');if(Object.keys(entry).length!==2||typeof entry.qq!=='string'||!/^(?:\d{4,12}|m_[a-f0-9]{24})$/.test(entry.qq))reject();}
  const expectedBoard:LegacyBoardErasure[]=[],requests=new Set<string>();
  for(const entry of intents){
    const closure='user_id' in entry?{user_id:entry.user_id,request_id:entry.request_id,created_at:entry.created_at}:entry.version===1&&entry.kind!=='music'?{user_id:entry.userId,request_id:entry.requestId,created_at:entry.createdAt}:null;
    if(closure&&!requests.has(closure.request_id)){requests.add(closure.request_id);expectedBoard.push(closure);}
  }
  for(const row of db.prepare('SELECT user_id,id,created_at FROM privacy_requests ORDER BY rowid').all() as {user_id:string;id:string;created_at:string}[]){
    const previous=expectedBoard.find(entry=>entry.request_id===row.id);
    if(previous){if(previous.user_id!==row.user_id||previous.created_at!==row.created_at)reject();}
    else{if(intents.some(entry=>(erasureRequestId(entry))===row.id))reject();requests.add(row.id);expectedBoard.push({user_id:row.user_id,request_id:row.id,created_at:row.created_at});}
  }
  same(board,expectedBoard);if(new Set(board.map(row=>row.request_id)).size!==board.length)reject();
  // Old recover() skips a closed account only when its current marker exists.
  // An applied journal marker alone must not authorize a second account erase.
  for(const entry of board)if(db.prepare('SELECT 1 FROM users WHERE id=?').get(entry.user_id)&&!db.prepare('SELECT 1 FROM privacy_requests WHERE user_id=?').get(entry.user_id))reject();
  const tombstones=new Map<string,unknown>();
  for(const row of db.prepare('SELECT legacy_key,erased_at_json FROM music_legacy_erasures ORDER BY rowid').all() as {legacy_key:string;erased_at_json:string}[])tombstones.set(row.legacy_key,parseJson(row.erased_at_json));
  for(const row of db.prepare('SELECT id,erased_at FROM music_profiles WHERE erased_at IS NOT NULL ORDER BY rowid').all() as {id:string;erased_at:string}[]){
    if(!z.iso.datetime().safeParse(row.erased_at).success)reject();
    const map=music.keys.find(key=>key.profileId===row.id);if(!map?.erased)reject();if(!tombstones.has(map.legacyKey))tombstones.set(map.legacyKey,row.erased_at);
  }
  same(erased,[...tombstones].map(([qq,erased_at])=>({qq,erased_at})));if(new Set(erased.map(row=>row.qq)).size!==erased.length)reject();
  const scopes:RollbackErasures['scopes']=[],unique=new Set<string>();
  for(const row of intents){const requestId=erasureRequestId(row);if(unique.has(requestId))continue;unique.add(requestId);
    const profileIds='user_id' in row||row.kind==='account'?[]:row.version===2?row.profiles.map(profile=>profile.id):[row.profileId!];
    const profileKeys=profileIds.map(id=>{const key=music.keys.find(item=>item.profileId===id);if(!key?.erased||!tombstones.has(key.legacyKey))return reject();return key.legacyKey;});
    scopes.push({requestId,kind:'user_id' in row?'account':row.version===2?row.command:row.kind,profileKeys,entries:'version' in row&&row.version===2?row.entries:[],alreadyApplied:true});
  }
  same(result.scopes,scopes);
  for(const key of tombstones.keys())if(Object.hasOwn(music.data.members as object,String(key)))reject();
  return {version:1 as const,boardClosures:board.length,musicKeys:erased.length,unifiedEntries:unified.length,scopes:scopes.length,
    digests:{...Object.fromEntries(['boardJournal','musicJournal','unifiedJournal'].map(key=>[key,createHash('sha256').update(result[key as 'boardJournal']).digest('hex')])),scopes:createHash('sha256').update(canonical(result.scopes)).digest('hex')},
    rollbackEligible:false as const,scopePolicy:'latest_projected_data_only' as const,remaining:['media_history','browser_requests','package_manifest','fixed_old_web_music_bot_rehearsal','forward_restore_mapping']};
}
