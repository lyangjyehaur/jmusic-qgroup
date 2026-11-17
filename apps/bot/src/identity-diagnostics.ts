import Database from 'better-sqlite3';
import { assertDatabaseUsable } from '@qgroup/database';
import { botStrip } from '@qgroup/domain';
import { object,reference } from './protocol';
import type { LogFields } from './observability';

/** Only these identity fields cross the worker boundary. Never pass an author,
 * message body, QQ account value or an arbitrary gateway payload to diagnostics. */
export interface MessageObservation {
  event_type:'GROUP_AT_MESSAGE_CREATE'|'GROUP_MESSAGE_CREATE';
  mentions_bot:boolean;
  mention_everyone:'missing'|'true'|'false'|'invalid';
  mention_count:number|null;
  mentions_everyone:boolean;
  group_ref:string|null;
  input_ref:string|null;
  unionOpenid:string;
  unionOpenidPresent:boolean;
  unionOpenidLength:number|null;
  unionUserAccountPresent:boolean;
  invalidUnion:boolean;
}
export function messageObservation(payload:Record<string,unknown>,type:MessageObservation['event_type'],addressed:boolean,everyone:boolean):MessageObservation {
  const author=object(payload.author)?payload.author:{},raw=author.union_openid;
  // Platform IDs are short. Reject an oversized value before hashing/cloning it;
  // this is diagnostics, never a reason to drop the command itself.
  const invalid=typeof raw==='string'&&raw.length>4096,value=typeof raw==='string'&&!invalid?botStrip(raw):'';
  const account=author.union_user_account;
  return {event_type:type,mentions_bot:addressed,
    mention_everyone:!Object.hasOwn(payload,'mention_everyone')?'missing':payload.mention_everyone===true?'true':payload.mention_everyone===false?'false':'invalid',
    mention_count:Array.isArray(payload.mentions)?payload.mentions.length:null,mentions_everyone:everyone,
    group_ref:typeof payload.group_openid==='string'&&payload.group_openid.length<=4096?reference(payload.group_openid):null,
    input_ref:typeof payload.id==='string'&&payload.id.length<=4096?reference(payload.id):null,
    unionOpenid:value,unionOpenidPresent:invalid||!!value,unionOpenidLength:invalid?null:Array.from(value).length,
    unionUserAccountPresent:typeof account==='string'&&!!botStrip(account),invalidUnion:invalid};
}
/** Read-only, bounded best-effort lookup. No user resolution or binding write. */
export function identityDiagnosticFields(database:string,input:MessageObservation):LogFields {
  const fields:LogFields={event_type:input.event_type,group_ref:input.group_ref,input_ref:input.input_ref,mentions_bot:input.mentions_bot,mention_everyone:input.mention_everyone,mention_count:input.mention_count,mentions_everyone:input.mentions_everyone,
    union_openid_present:input.unionOpenidPresent,union_openid_len:input.unionOpenidLength,union_user_account_present:input.unionUserAccountPresent};
  if(input.invalidUnion)return {...fields,unionid_lookup:'unavailable',unionid_lookup_error:'InvalidIdentifier'};
  if(!input.unionOpenid)return fields;
  fields.union_openid_ref=reference(input.unionOpenid);
  let db:Database.Database|undefined;
  try {
    db=new Database(database,{readonly:true,fileMustExist:true});db.pragma('busy_timeout = 100');db.pragma('query_only = ON');
    fields.unionid_matches_site=db.transaction(()=>{assertDatabaseUsable(db!);return !!db!.prepare('SELECT 1 FROM external_unionids WHERE union_id=? LIMIT 1').get(input.unionOpenid);})();
  }catch(error){
    fields.unionid_lookup='unavailable';
    // Same category as the retained sqlite3 observer; never include SQL/path or
    // the exception message, even when opening a missing/old/locked database.
    fields.unionid_lookup_error=error instanceof Error&&error.name==='SqliteError'?'OperationalError':'Error';
  }finally{try{db?.close();}catch{/* Read-only connection cleanup must not block a command. */}}
  return fields;
}
