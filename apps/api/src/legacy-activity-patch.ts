import type { FastifyInstance } from 'fastify';
import type { DB } from '@qgroup/database';
import { LegacyRequestCheck,LegacyActivityPatchRetry,decodeLegacyActivityPatch,legacyActivityPatchId,LegacyActivityCreationValues } from '@qgroup/contracts';
import { DomainError } from '@qgroup/domain';
import { withApiError } from './error-display';
import { hash,type Security } from './security';
import { originalRequestSignature } from './legacy-local';
import { requireActivityAccess } from './activity-access';
import { eventRow,eventScopes,eventSnapshot,storedArrangement,appendEventAudit,legacyStamp,requireEventRevision } from './activity-arrangements';
import { canAssistActivitySchedule,prepareActivityEdit,executeActivityEdit } from './activity-edit-command';
import { prepareActivityLifecycle,executeActivityLifecycle } from './activity-lifecycle';
import { activityPeopleSnapshot,rebalanceActivity,rosterDelta,prepareActivityPublication,publishActivityDraft } from './activity-publish';
import { activityBotPolicy,createActivityBot,type ActivityBotDefaults } from './activity-bot';
import { prepareOriginalActivityRetry,insertBotRetry } from './bot-delivery-command';
const ownerActions=new Set(['cancel','archive','unarchive','publish','formation','remove','bot_sync','bot_retry']);
export function registerLegacyActivityPatch(app:FastifyInstance,db:DB,security:Security,now:()=>Date,defaults:ActivityBotDefaults={}){
 const limits={config:{rateLimit:{max:30,timeWindow:'1 minute'}}};
 function inspect(request:Parameters<Security['memberWrite']>[0],input:ReturnType<typeof LegacyRequestCheck.parse>){
  const user=security.memberWrite(request);let id:string;
  try{id=legacyActivityPatchId(input);}catch{throw withApiError(new DomainError('LEGACY_ACTIVITY_PATCH_UNSUPPORTED','原活動方法或路徑尚未支援；原請求保留',400));}
  const event=eventRow(db,id);if(!event)throw withApiError(new DomainError('NOT_FOUND','找不到原活動',404));
  const edit=Object.hasOwn(input.data,'title'),action=input.data.action??(!edit?({finished:'finish',cancelled:'cancel',open:'resume',closed:'pause',deleted:'remove'} as Record<string,string>)[String(input.data.status)]:undefined);
  const assisted=edit&&input.data.action==null&&event.owner_id!==user.id&&canAssistActivitySchedule(db,event,user.id),scopes=eventScopes(db,event,user.id);
  if(event.status==='deleted'){if(event.owner_id!==user.id||action!=='remove'||edit)throw withApiError(new DomainError('NOT_FOUND','活動已移除',404));}else requireActivityAccess(db,id,user.id);
  const settlementRetry=action==='bot_retry'&&Number.isSafeInteger(input.data.outbox_id)&&!!db.prepare("SELECT 1 FROM bot_outbox WHERE id=? AND event_id=? AND kind='settlement_updated'").get(input.data.outbox_id,id);
  if(!assisted&&!scopes.has(settlementRetry?'settlement':ownerActions.has(String(action))?'owner':'schedule'))throw withApiError(new DomainError('ACTIVITY_PERMISSION','沒有這項活動管理權限',403));
  const signature=originalRequestSignature(input.method,input.path,input.data),old=db.prepare('SELECT signature,response_json FROM request_results WHERE user_id=? AND request_key=?').get(user.id,input.requestKey) as {signature:string;response_json:string}|undefined;
  if(old&&old.signature!==signature)throw withApiError(new DomainError('LEGACY_REQUEST_CONFLICT','原操作編號與內容不符；原請求保留',409));
  if(old){
   let result:unknown;try{result=JSON.parse(old.response_json);}catch{throw withApiError(new DomainError('LEGACY_REQUEST_RESULT_MISMATCH','原回執無法解析；原請求保留',409));}
   if(!result||typeof result!=='object'||!('id' in result)||result.id!==id||!('starts_at' in result&&typeof result.starts_at==='string'||'status' in result&&result.status==='deleted'))throw withApiError(new DomainError('LEGACY_REQUEST_RESULT_MISMATCH','原回執與活動不一致；原請求保留',409));
  }
  return {user,event,signature,old,edit,action,assisted};
 }
 function result(s:ReturnType<typeof inspect>){
  const e=eventRow(db,s.event.id)!,route=e.status==='deleted'?'lifecycle' as const:e.lifecycle==='draft'?'draft' as const:s.edit?'arrangements' as const:s.action==='bot_retry'||s.action==='bot_sync'?'bot-deliveries' as const:'lifecycle' as const;
  return {state:'committed' as const,receipt:{committed:true,target:{kind:'activity' as const,id:e.id}},route};
 }
 function prepare(s:ReturnType<typeof inspect>,input:ReturnType<typeof LegacyRequestCheck.parse>,time:Date){
  const {event,user}=s;if(event.status==='deleted')throw withApiError(new DomainError('NOT_FOUND','活動已移除',404));
  let command:ReturnType<typeof decodeLegacyActivityPatch>;
  try{command=decodeLegacyActivityPatch(input,event);}catch{throw withApiError(new DomainError('LEGACY_ACTIVITY_PATCH_UNSUPPORTED','原活動欄位尚未支援或缺失；原請求保留',400));}
  if(!user.nickname)throw withApiError(new DomainError('NICKNAME_REQUIRED','請先設定稱呼再操作',400));
  if(command.kind==='lifecycle'&&command.action==='remove'&&command.revision===undefined)throw withApiError(new DomainError('ACTIVITY_CHANGED','原移除請求缺少活動版本；原請求保留',409));
  if(command.revision!==undefined)requireEventRevision(event,command.revision);
  if(event.archived_at&&!['unarchive','remove'].includes(String(s.action)))throw new DomainError('ACTIVITY_LOCKED','請先取消歸檔再修改活動；结算更正仍可從結算入口操作',409);
  const current=LegacyActivityCreationValues.parse(storedArrangement(event));
  const edit=command.kind==='edit'?prepareActivityEdit(db,event,user,command.values,command.reason,time,s.assisted):undefined;
  const lifecycle=command.kind==='lifecycle'?prepareActivityLifecycle(db,event,user.id,command.action,command.reason,time):undefined;
  const publication=command.kind==='publish'?prepareActivityPublication(db,event,user,()=>time,current):undefined;
  const retryNotice=command.kind==='bot_retry'?prepareOriginalActivityRetry(db,event,command.outboxId,time,defaults):undefined;
  if(command.kind==='bot_sync'&&command.botEnabled&&event.visibility!=='public')throw new DomainError('INVITATION_BOT_SYNC','邀請可見活動不能同步到公開群',400);
  const policy=activityBotPolicy(db,defaults),noticeTarget=retryNotice?retryNotice.target:policy.config.enabled&&event.visibility==='public'&&(command.kind==='publish'||event.lifecycle!=='draft')&&(command.kind==='bot_sync'?command.botEnabled:!!event.bot_enabled)&&!(command.kind==='lifecycle'&&['remove','archive','unarchive'].includes(command.action))?policy.config.groups===null?'':policy.config.groups.find(g=>g.broadcast)?.id??null:null;
  let noticeText='';if(retryNotice){const payload:unknown=JSON.parse(retryNotice.payload_json);if(payload&&typeof payload==='object'&&'text' in payload&&typeof payload.text==='string')noticeText=Array.from(payload.text).slice(0,20000).join('');}
  const value={command:edit?{...command,values:edit.v}:command,current,title:event.title,lifecycle:event.lifecycle,registrationOpen:!!event.registration_open,archived:!!event.archived_at,currentRevision:event.revision,ownerName:(db.prepare('SELECT nickname FROM users WHERE id=?').get(event.owner_id) as {nickname:string}).nickname,requiresOwnerSignup:!!publication,noticeTarget,noticeText};
  const recovery_token=hash(JSON.stringify({user,key:input.requestKey,signature:s.signature,event,people:[...activityPeopleSnapshot(db,event.id)],policy,retryNotice,value}));
  return {command,edit,lifecycle,publication,retryNotice,view:{state:'retryable' as const,...value,recovery_token}};
 }
 app.post('/api/v2/me/legacy-requests/activity/inspect',limits,async request=>db.transaction(()=>{const input=LegacyRequestCheck.parse(request.body),s=inspect(request,input);return s.old?result(s):prepare(s,input,now()).view;})());
 app.post('/api/v2/me/legacy-requests/activity/retry',limits,async request=>db.transaction(()=>{
  const {confirm,recovery_token,...input}=LegacyActivityPatchRetry.parse(request.body);void confirm;
  const s=inspect(request,input);if(s.old)return result(s);
  const time=now(),p=prepare(s,input,time);if(p.view.recovery_token!==recovery_token)throw withApiError(new DomainError('LEGACY_ACTIVITY_REVIEW_CHANGED','活動、名單或通知核對資料已變更；請重新檢查',409));
  const hookError=(id:string)=>app.log.error({eventId:id},'Activity bot hook failed; required business preserved'),hook=(work:()=>unknown)=>{try{db.transaction(work)();}catch{hookError(s.event.id);}};
  if(p.edit)executeActivityEdit(db,p.edit,s.user,time,defaults,hookError,false,p.command.kind==='edit'?p.command.action:null);
  else if(p.lifecycle)executeActivityLifecycle(db,p.lifecycle,s.user,time,defaults,hookError);
  else if(p.publication)publishActivityDraft(db,s.event,s.user,()=>time,p.publication,defaults,hookError);
  else if(p.retryNotice){
   const id=insertBotRetry(db,p.retryNotice,time),numeric=Number(id);if(!Number.isSafeInteger(numeric))throw new DomainError('BOT_RETRY_ID_RANGE','原通知編號超出可安全表示的範圍；原請求保留',409);
   appendEventAudit(db,s.event,s.user,'bot_delivery_retry',{}, {original_id:Number(p.retryNotice.id),outbox_id:numeric},p.command.reason,legacyStamp(time));
  }else if(p.command.kind==='bot_sync'){
   const before=eventSnapshot(s.event),people=activityPeopleSnapshot(db,s.event.id);
   db.prepare('UPDATE events SET bot_enabled=? WHERE id=?').run(Number(p.command.botEnabled),s.event.id);
   const promoted=rebalanceActivity(db,eventRow(db,s.event.id)!,()=>time,defaults,hookError),delta=rosterDelta(people,activityPeopleSnapshot(db,s.event.id));
   if(appendEventAudit(db,s.event,s.user,'event_bot_sync',{event:before,participants:delta.prior},{event:eventSnapshot(eventRow(db,s.event.id)!),participants:delta.current},p.command.reason,legacyStamp(time)))hook(()=>createActivityBot(db,()=>time,defaults).arrangementsUpdated(s.event,promoted));
  }
  const e=eventRow(db,s.event.id)!,marker=e.status==='deleted'?{id:e.id,status:'deleted'}:{id:e.id,starts_at:e.starts_at};
  db.prepare('INSERT INTO request_results VALUES(?,?,?,?,?,?)').run(s.user.id,input.requestKey,s.signature,JSON.stringify(marker),200,legacyStamp(time));return result(s);
 }).immediate());
}
