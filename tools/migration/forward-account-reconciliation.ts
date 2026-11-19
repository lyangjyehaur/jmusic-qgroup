import type {DB} from '@qgroup/database';
import {ErasureResult} from '@qgroup/contracts';
import {readVerifiedErasureJournal,type ErasureJournal} from '../../apps/api/src/erasure-journal';
import {schemaObjects} from './board-reconciliation';
import {assertRollbackSource,assertRollbackSourceStructure} from './rollback-source';
import {forwardRows,forwardEqual,forwardHash,forwardSequences} from './forward-board-storage';

const reject=():never=>{throw Error('Account erasure reconciliation failed; retain original images');};
/** Independently derive every surviving row/column/storage class from the
 * pre-repair image and original journal. No writer, repair report or mutation
 * list is consulted; shared history, schema and sequence rows remain exact. */
export function reconcileAppliedAccountRepair(source:DB,candidate:DB,journal:ErasureJournal){
  source.transaction(()=>assertRollbackSourceStructure(source)).immediate();
  if(candidate.inTransaction)assertRollbackSource(candidate);else candidate.transaction(()=>assertRollbackSource(candidate)).immediate();
  if(!forwardEqual(schemaObjects(source),schemaObjects(candidate)))reject();
  for(const name of ['user_version','application_id','encoding'])if(!forwardEqual(source.pragma(name,{simple:true}),candidate.pragma(name,{simple:true})))reject();
  const intents=readVerifiedErasureJournal(source,journal),closures=new Map<string,string>();
  for(const row of source.prepare('SELECT id,user_id,created_at FROM privacy_requests').all() as {id:string;user_id:string;created_at:string}[]){
    if(!intents.some(entry=>'user_id' in entry?entry.user_id===row.user_id&&entry.request_id===row.id&&entry.created_at===row.created_at:entry.version===1&&entry.kind!=='music'&&entry.userId===row.user_id&&entry.requestId===row.id&&entry.createdAt===row.created_at))continue;
    closures.set(row.user_id,row.id);
  }
  for(const entry of intents)if('user_id' in entry||entry.version===1&&entry.kind!=='music'){
    const id='user_id' in entry?entry.user_id:entry.userId;if(source.prepare('SELECT 1 FROM users WHERE id=?').get(id)&&!closures.has(id))reject();
    if('version' in entry){const result=ErasureResult.parse(JSON.parse((source.prepare('SELECT result_json FROM privacy_receipts WHERE request_id=?').get(entry.requestId) as {result_json:string}).result_json));if(result.requestId!==entry.requestId||result.target!==entry.kind)reject();}
  }
  // Only the unpublished, independently checked board merge can contain these
  // retained children. A missing parent is not itself evidence of an erasure.
  const parentKeys=source.prepare('PRAGMA foreign_key_list(music_profile_receipts)').all() as {id:number;table:string}[];
  const resultFk=parentKeys.find(row=>row.table==='request_results')?.id;
  for(const fk of source.prepare('PRAGMA foreign_key_check').safeIntegers(true).all() as {table:string;rowid:bigint;parent:string;fkid:bigint}[]){
    if(fk.table!=='music_profile_receipts'||fk.parent!=='request_results'||fk.fkid!==BigInt(resultFk??-1))reject();
    const receipt=source.prepare('SELECT user_id,request_key FROM music_profile_receipts WHERE rowid=?').get(fk.rowid) as {user_id:string;request_key:string}|undefined;
    if(!receipt||!closures.has(receipt.user_id)||source.prepare('SELECT 1 FROM request_results WHERE user_id=? AND request_key=?').get(receipt.user_id,receipt.request_key))reject();
  }
  const closed=(id:unknown)=>typeof id==='string'&&closures.has(id);
  const tokens=new Set((source.prepare('SELECT token_hash,user_id FROM browser_sessions').all() as {token_hash:string;user_id:string}[]).filter(row=>closed(row.user_id)).map(row=>row.token_hash));
  const claims=source.prepare('SELECT current_token_hash,target_user_id,attempt_id FROM music_claim_intents').all() as {current_token_hash:string;target_user_id:string|null;attempt_id:string|null}[];
  const attempts=new Set(claims.filter(row=>closed(row.target_user_id)&&row.attempt_id).map(row=>row.attempt_id!));
  const identities=source.prepare('SELECT provider,client_id,subject,user_id FROM external_identities').all() as {provider:string;client_id:string;subject:string;user_id:string}[];
  const erasedTuples=new Set(identities.filter(row=>closed(row.user_id)).map(row=>JSON.stringify([row.provider,row.client_id,row.subject])));
  const musicIdentity=source.prepare('SELECT table_name,row_number,payload_json FROM music_legacy_identity').safeIntegers(true).all() as {table_name:string;row_number:bigint;payload_json:string}[];
  const parsed=new Map(musicIdentity.map(row=>[row.table_name+':'+row.row_number,JSON.parse(row.payload_json) as Record<string,unknown>]));
  const keys=new Set(musicIdentity.filter(row=>['links','prelinks'].includes(row.table_name)&&closed(parsed.get(row.table_name+':'+row.row_number)!.user_id)).map(row=>String(parsed.get(row.table_name+':'+row.row_number)!.qq)));
  const identityDeleted=(table:unknown,value:Record<string,unknown>)=>['links','prelinks','sessions','entry_intents'].includes(String(table))&&keys.has(String(value.qq))||['sessions','entry_intents'].includes(String(table))&&tokens.has(String(value.source_session))||table==='entry_intents'&&closed(value.target_user_id);
  const nativeOwnerClosed=(table:unknown,value:Record<string,unknown>)=>table==='native_profiles'&&typeof value.payload==='string'&&closed((JSON.parse(value.payload) as {boardUserId?:unknown}).boardUserId);
  const profiles=new Set((source.prepare('SELECT id,user_id FROM music_profiles').all() as {id:string;user_id:string|null}[]).filter(row=>closed(row.user_id)).map(row=>row.id));
  const documents=source.prepare("SELECT payload_json FROM music_documents WHERE kind='profile_source'").all() as {payload_json:string}[];
  const documentKeys=new Set(documents.map(row=>JSON.parse(row.payload_json) as {legacyKey?:string;member?:{boardUserId?:string}}).filter(row=>closed(row.member?.boardUserId)).map(row=>row.legacyKey));
  const codeRows=source.prepare('SELECT user_id,digest FROM user_payment_codes').all() as {user_id:string;digest:string}[];
  const digests=new Set(codeRows.filter(row=>closed(row.user_id)).map(row=>row.digest));
  const pollChanges=new Map<string,number>();for(const row of source.prepare('SELECT poll_id,user_id FROM time_poll_ballots').all() as {poll_id:string;user_id:string}[])if(closed(row.user_id))pollChanges.set(row.poll_id,(pollChanges.get(row.poll_id)??0)+1);
  const privateTables=new Set(['external_profiles','external_identities','qq_accounts','qq_attempts','privacy_consents','user_payment_codes','notifications','request_results','device_links','admin_user_metadata','event_access','time_poll_votes','time_poll_ballots','unified_privacy_receipts','unified_privacy_consents','music_profile_receipts']);
  let removedRows=0,changedRows=0,retainedRows=0;
  for(const table of schemaObjects(source).filter(row=>row.type==='table'&&row.name!=='sqlite_sequence').map(row=>row.name)){
    const columns=(source.prepare(`PRAGMA table_xinfo("${table}")`).all() as {name:string}[]).map(row=>row.name),actual=forwardRows(candidate,table);
    try{
      for(const row of forwardRows(source,table)){
        let deleted=false;const wanted={...row};
        const set=(column:string,value:unknown)=>{wanted[column]=value;wanted['__forward_type_'+columns.indexOf(column)]=typeof value==='bigint'?'integer':value===null?'null':typeof value==='string'?'text':'real';};
        if(privateTables.has(table)&&closed(row.user_id))deleted=true;
        if(table==='browser_accounts'&&(closed(row.user_id)||tokens.has(String(row.token_hash)))||['browser_sessions','auth_requests','visitor_sessions'].includes(table)&&tokens.has(String(row.token_hash)))deleted=true;
        if(table==='external_unionids'&&erasedTuples.has(JSON.stringify([row.provider,row.client_id,row.subject])))deleted=true;
        if(table==='login_attempts'){
          if(closed(row.user_id)||tokens.has(String(row.token_hash))||row.provider==='qq'&&erasedTuples.has(JSON.stringify(['qq',row.app_id,row.openid])))deleted=true;
          else if(attempts.has(String(row.id))&&['pending','exchanging','verified'].includes(String(row.status))){set('status','failed');set('union_id','');}
        }
        if(table==='music_claim_intents'&&(closed(row.target_user_id)||tokens.has(String(row.current_token_hash))))deleted=true;
        if(table==='users'&&closed(row.id)){set('nickname','已注销用户');set('token_hash','erased-account-v1:'+forwardHash(JSON.stringify([row.id,closures.get(String(row.id))])));}
        if(table==='user_admin_roles'&&closed(row.user_id))set('is_admin',0n);
        if(table==='time_polls'&&['open','closed'].includes(String(row.status))&&pollChanges.has(String(row.id))){const revision=row.vote_revision,delta=BigInt(pollChanges.get(String(row.id))!);if(typeof revision!=='bigint')return reject();if(revision<0n||revision+delta>9223372036854775807n)reject();set('vote_revision',revision+delta);}
        if(table==='music_profiles'&&closed(row.user_id))set('user_id',null);
        if(table==='music_legacy_profiles'&&(profiles.has(String(row.profile_id))||keys.has(String(row.legacy_key))))set('ownership_source','closed_account');
        if(table==='music_documents'&&row.kind==='profile_source'){
          const value=JSON.parse(String(row.payload_json)) as {member?:{boardUserId?:string}};
          if(closed(value.member?.boardUserId))set('payload_json',(source.prepare("SELECT json_set(?,'$.member.boardUserId','') AS value").get(row.payload_json) as {value:string}).value);
        }
        if(table==='music_legacy_identity'){
          const value=parsed.get(String(row.table_name)+':'+String(row.row_number))!;
          if(identityDeleted(row.table_name,value))deleted=true;
          else if(nativeOwnerClosed(row.table_name,value))set('payload_json',(source.prepare("SELECT json_set(?,'$.payload',json_set(json_extract(?,'$.payload'),'$.boardUserId','')||'') AS value").get(row.payload_json,row.payload_json) as {value:string}).value);
        }
        if(table==='migration_map'){
          if(row.source==='music-identity'){
            const value=parsed.get(String(row.entity_type)+':'+String(row.source_id));
            if(value&&identityDeleted(row.entity_type,value))set('status','erased');
            else if(value&&nativeOwnerClosed(row.entity_type,value))set('status','erasure_redacted');
          }else if(row.source==='music'&&row.entity_type==='profile'&&row.status!=='erased'&&(keys.has(String(row.source_id))||documentKeys.has(String(row.source_id))))set('status','erasure_redacted');
        }
        if(table==='image_assets'&&digests.has(String(row.digest))&&!codeRows.some(code=>code.digest===row.digest&&!closed(code.user_id))&&!source.prepare('SELECT 1 FROM settlement_code_images WHERE digest=? UNION ALL SELECT 1 FROM settlement_receipt_images WHERE digest=?').get(row.digest,row.digest))deleted=true;
        if(deleted){removedRows++;continue;}
        const next=actual.next();if(next.done||!forwardEqual(wanted,next.value))reject();if(forwardEqual(wanted,row))retainedRows++;else changedRows++;
      }
      if(!actual.next().done)reject();
    }finally{actual.return?.();}
  }
  forwardSequences(source);forwardSequences(candidate);
  if(!forwardEqual([...forwardRows(source,'sqlite_sequence')], [...forwardRows(candidate,'sqlite_sequence')]))reject();
  readVerifiedErasureJournal(candidate,journal);
  return {accountClosures:closures.size,removedRows,changedRows,retainedRows,allRowsVerified:true as const};
}
