import Database from 'better-sqlite3';
import type {DB} from '@qgroup/database';
import type {RollbackMusic} from './rollback-music';
import {object,parseJson} from './music-codec';
import {identitySeconds,identityTables} from './rollback-identity-source';
import {forwardRows,forwardEqual,type ForwardRow} from './forward-board-storage';
import {musicEqual,assertForwardIdentity,type ForwardMusicSources} from './forward-music-sources';
import {validateForwardMusicRelations,validateForwardMusicGraph} from './forward-music-validation';
import type {ForwardBoardAccountAuthority} from './forward-board-account-source';

type Closure=ForwardBoardAccountAuthority['closed'];
/** Derive scope from the actual merged relation. Stale native payload ownership
 * is redacted without erasing another current owner's links or key proofs. */
function scope(s:ForwardMusicSources,board:DB,music:RollbackMusic,identity:DB,closures:Closure){
  const relation=validateForwardMusicRelations(s,music,identity);
  if(relation.closedOwners.some(id=>!closures.has(id)))throw Error('Merged closed owner lacks original authority');
  const keys=new Set<string>();for(const [key,value] of Object.entries(object(music.data.members,'account merged members')))if(closures.has(String(object(value,'account member').boardUserId)))keys.add(key);
  const tokens=new Set<string>();for(const original of [s.board.native,s.board.old])for(const row of original.prepare('SELECT token_hash,user_id FROM browser_sessions').all() as {token_hash:string;user_id:string}[]){
    if(!closures.has(row.user_id))continue;const current=board.prepare('SELECT user_id FROM browser_sessions WHERE token_hash=?').get(row.token_hash) as {user_id:string}|undefined;
    if(!current||closures.has(current.user_id))tokens.add(row.token_hash);
  }
  return {keys,tokens};
}
/** Only source cleanup, after the original three-way row oracle has passed. */
export function cleanupForwardAccountMusic(s:ForwardMusicSources,board:DB,raw:RollbackMusic,identity:DB,closures:Closure){
  const {keys,tokens}=scope(s,board,raw,identity,closures),music=structuredClone(raw),db=new Database(identity.serialize());
  try{
    for(const value of Object.values(object(music.data.members,'account members'))){const member=object(value,'account member');if(closures.has(String(member.boardUserId)))member.boardUserId='';}
    db.transaction(()=>{
      for(const table of ['links','prelinks'])for(const [id] of closures)db.prepare('DELETE FROM '+table+' WHERE user_id=?').run(id);
      for(const key of keys)for(const table of ['sessions','entry_intents'])db.prepare('DELETE FROM '+table+' WHERE qq=?').run(key);
      for(const token of tokens)for(const table of ['sessions','entry_intents'])db.prepare('DELETE FROM '+table+' WHERE source_session=?').run(token);
      for(const [id,closure] of closures){
        db.prepare('DELETE FROM entry_intents WHERE target_user_id=?').run(id);
        const revisions=db.prepare('SELECT revision FROM link_overrides WHERE user_id=?').safeIntegers(true).all(id) as {revision:bigint}[];
        if(revisions.some(row=>row.revision<0n||row.revision>=BigInt(Number.MAX_SAFE_INTEGER)))throw Error('Closed source override revision exceeds capacity');
        if(revisions.length)db.prepare("UPDATE link_overrides SET user_id='',revision=revision+1,updated=? WHERE user_id=?").run(identitySeconds(closure.createdAt),id);
        db.prepare("UPDATE native_profiles SET payload=json_set(payload,'$.boardUserId','') WHERE json_extract(payload,'$.boardUserId')=?").run(id);
      }
    }).immediate();assertForwardIdentity(db);validateForwardMusicGraph(s,music,db);
    return {music,identity:db};
  }catch(error){db.close();throw error;}
}
/** Independent full relation oracle; no cleanup writer or change report. */
export function verifyForwardAccountMusic(s:ForwardMusicSources,board:DB,raw:RollbackMusic,source:DB,closures:Closure,music:RollbackMusic,candidate:DB){
  const relation=validateForwardMusicRelations(s,raw,source);if(relation.closedOwners.some(id=>!closures.has(id)))throw Error('Expected owner lacks its original closure');
  const keys=new Set([...forwardRows(source,'links'),...forwardRows(source,'prelinks')].filter(row=>closures.has(String(row.user_id))).map(row=>String(row.qq)));
  const alive=new Map([...forwardRows(board,'browser_sessions')].map(row=>[String(row.token_hash),String(row.user_id)])),tokens=new Set<string>();
  for(const original of [s.board.native,s.board.old])for(const row of forwardRows(original,'browser_sessions'))if(closures.has(String(row.user_id))&&(!alive.has(String(row.token_hash))||closures.has(alive.get(String(row.token_hash))!)))tokens.add(String(row.token_hash));
  assertForwardIdentity(candidate);validateForwardMusicGraph(s,music,candidate);
  const wanted=structuredClone(raw);for(const value of Object.values(object(wanted.data.members,'expected account members'))){const member=object(value,'expected member');if(closures.has(String(member.boardUserId)))member.boardUserId='';}
  if(!musicEqual(wanted,music)||['entries','members'].some(kind=>Object.keys(object(raw.data[kind],'original account order')).join('\0')!==Object.keys(object(music.data[kind],'final account order')).join('\0')))throw Error('Account music content changed outside original closure');
  let removed=0,changed=0,retained=0;
  for(const table of identityTables){
    const columns=(source.prepare('PRAGMA table_xinfo("'+table+'")').all() as {name:string}[]).map(row=>row.name),actual=forwardRows(candidate,table);
    try{
      for(const row of forwardRows(source,table)){
        const closed=typeof row.user_id==='string'&&closures.has(row.user_id),deleted=['links','prelinks'].includes(table)&&closed||['sessions','entry_intents'].includes(table)&&(keys.has(String(row.qq))||tokens.has(String(row.source_session)))||table==='entry_intents'&&closures.has(String(row.target_user_id));
        if(deleted){removed++;continue;}
        const expected:ForwardRow={...row},set=(name:string,value:string|bigint|number)=>{expected[name]=value;expected['__forward_type_'+columns.indexOf(name)]=typeof value==='string'?'text':typeof value==='bigint'?'integer':'real';};
        if(table==='link_overrides'&&closed){const revision=row.revision as bigint;if(revision<0n||revision>=BigInt(Number.MAX_SAFE_INTEGER))throw Error('Expected source override revision exceeds capacity');set('user_id','');set('revision',revision+1n);set('updated',identitySeconds(closures.get(String(row.user_id))!.createdAt));}
        if(table==='native_profiles'){
          const value=object(parseJson(String(row.payload)),'expected native member');if(closures.has(String(value.boardUserId)))set('payload',(source.prepare("SELECT json_set(?,'$.boardUserId','') AS value").get(row.payload) as {value:string}).value);
        }
        const next=actual.next();if(next.done||!forwardEqual(next.value,expected))throw Error('Account identity source row differs');if(forwardEqual(expected,row))retained++;else changed++;
      }
      if(!actual.next().done)throw Error('Unexpected account identity source row');
    }finally{actual.return?.();}
  }
  if(!forwardEqual([...forwardRows(source,'sqlite_sequence')],[...forwardRows(candidate,'sqlite_sequence')]))throw Error('Account source audit high-water changed');
  return {removedRows:removed,changedRows:changed,retainedRows:retained,originalClosureScopes:closures.size,allRowsVerified:true as const,releaseEligible:false as const};
}
