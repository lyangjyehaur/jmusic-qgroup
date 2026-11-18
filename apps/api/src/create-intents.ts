import type { FastifyInstance } from 'fastify';
import type { DB } from '@qgroup/database';
import { ActivityDraftResult,TimePollResult,CreateIntent,ViewCreateIntent,type CreateIntentResult } from '@qgroup/contracts';
import { DomainError } from '@qgroup/domain';
import { z } from 'zod';
import { hash,type Security } from './security';
import { requireActivityAccess } from './activity-access';
import { eventRow,eventScopes } from './activity-arrangements';
import { pollRow } from './time-poll-context';
type Kind='activity'|'poll';
const prefix=(kind:Kind)=>kind==='activity'?'activity-create-intent:':'poll-create-intent:';
export const createIntentKey=(kind:Kind,intent:string)=>hash((kind==='activity'?'create ':'create time-poll ')+CreateIntent.parse(intent));
function receipt(db:DB,userId:string,kind:Kind,intent:string){return db.prepare('SELECT signature,response_json FROM request_results WHERE user_id=? AND request_key=?').get(userId,createIntentKey(kind,intent)) as {signature:string;response_json:string}|undefined;}
function target(db:DB,userId:string,kind:Kind,row:{signature:string;response_json:string}){
  let result:unknown;
  try{result=JSON.parse(row.response_json);}catch{throw new DomainError('CREATE_INTENT_CONFLICT','原建立識別的結果無法辨識，請保留原稿',409);}
  const source=z.object({id:z.string().min(1).max(80)}).passthrough().safeParse(result);
  if(!source.success)throw new DomainError('CREATE_INTENT_CONFLICT','原建立識別的結果無法辨識，請保留原稿',409);
  if(row.signature.startsWith(prefix(kind))&&!(kind==='activity'?ActivityDraftResult:TimePollResult).safeParse(result).success)throw new DomainError('CREATE_INTENT_CONFLICT','原建立識別的結果無法辨識，請保留原稿',409);
  const id=source.data.id;
  if(kind==='activity'){
    if(!row.signature.startsWith(prefix(kind))&&!('starts_at' in source.data))throw new DomainError('CREATE_INTENT_CONFLICT','原建立識別屬於其他操作，請保留原稿',409);
    requireActivityAccess(db,id,userId);const event=eventRow(db,id)!,scopes=eventScopes(db,event,userId);
    if(!scopes.size)throw new DomainError('CREATE_INTENT_PERMISSION','原活動已建立，但目前無權編輯；不能重建',403);
    return {state:'existing' as const,kind,id,revision:event.revision,route:event.lifecycle==='draft'?'draft' as const:'arrangements' as const,canEdit:scopes.has('schedule')};
  }
  if(!row.signature.startsWith(prefix(kind))&&!source.data.time_poll)throw new DomainError('CREATE_INTENT_CONFLICT','原建立識別屬於其他操作，請保留原稿',409);
  const poll=pollRow(db,id);if(poll.owner_id!==userId)throw new DomainError('CREATE_INTENT_PERMISSION','原投票已建立，但目前無權管理；不能重建',403);
  return {state:'existing' as const,kind,id,revision:poll.revision,route:'poll' as const,canEdit:false};
}
export function viewCreateIntent(db:DB,userId:string,kind:Kind,intent:string):z.infer<typeof CreateIntentResult>{const row=receipt(db,userId,kind,intent);return row?target(db,userId,kind,row):{state:'missing'};}
/** Existing original protocol keys act as durable aliases. Never alter an imported receipt. */
export function priorCreateIntent<T>(db:DB,userId:string,kind:Kind,intent:string|undefined,input:unknown):T|undefined{
  if(!intent)return undefined;const row=receipt(db,userId,kind,intent);if(!row)return undefined;
  target(db,userId,kind,row); // Deleted or withdrawn authority also blocks another creation.
  const signature=prefix(kind)+hash(JSON.stringify(input));
  if(row.signature!==signature)throw new DomainError('CREATE_INTENT_RESOLVED','這份原稿已建立。請核對原結果並保留後續編輯，不能另建一筆',409);
  return JSON.parse(row.response_json) as T;
}
export function recordCreateIntent(db:DB,userId:string,kind:Kind,intent:string|undefined,input:unknown,result:unknown,stamp:string){
  if(!intent)return;db.prepare('INSERT INTO request_results VALUES(?,?,?,?,?,?)').run(userId,createIntentKey(kind,intent),prefix(kind)+hash(JSON.stringify(input)),JSON.stringify(result),200,stamp);
}
export function registerCreateIntents(app:FastifyInstance,db:DB,security:Security){
  app.post('/api/v2/me/create-intents/view',{config:{rateLimit:{max:40,timeWindow:'1 minute'}}},async request=>db.transaction(()=>{const user=security.memberWrite(request),input=ViewCreateIntent.parse(request.body);return viewCreateIntent(db,user.id,input.kind,input.intent);})());
}
