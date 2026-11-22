import type { FastifyInstance } from 'fastify';
import type { DB } from '@qgroup/database';
import { LegacyRequestCheck, LegacyActivityCreationRetry, decodeLegacyActivityCreation } from '@qgroup/contracts';
import { originalCreationKey } from '../../../packages/contracts/src/legacy-values';
import { DomainError } from '@qgroup/domain';
import { hash, type Security } from './security';
import { withApiError } from './error-display';
import { originalRequestSignature } from './legacy-local';
import { requireActivityAccess } from './activity-access';
import { eventRow, eventScopes, legacyStamp, type EventRow } from './activity-arrangements';
import { prepareActivityCreation, executeActivityCreation } from './activity-create-command';
import { viewActivityCreationKey } from './create-intents';
import { activityBotPolicy, buildActivityBotMessage, type ActivityBotDefaults } from './activity-bot';
export function registerLegacyActivityCreation(app:FastifyInstance,db:DB,security:Security,now:()=>Date,defaults:ActivityBotDefaults={}){
 const limits={config:{rateLimit:{max:30,timeWindow:'1 minute'}}};
 function destination(id:string,userId:string){
  requireActivityAccess(db,id,userId);const event=eventRow(db,id)!,scopes=eventScopes(db,event,userId);
  return {id,route:event.lifecycle==='draft'&&scopes.has('schedule')?'draft' as const:scopes.has('schedule')?'arrangements' as const:'view' as const};
 }
 const committed=(id:string,userId:string)=>{const d=destination(id,userId);return {state:'committed' as const,receipt:{committed:true,target:{kind:'activity' as const,id}},route:d.route};};
 function inspect(request:Parameters<Security['memberWrite']>[0],input:ReturnType<typeof LegacyRequestCheck.parse>){
  const user=security.memberWrite(request);
  if(input.method!=='POST'||input.path!=='/api/events')throw withApiError(new DomainError('LEGACY_ACTIVITY_CREATE_UNSUPPORTED','原建立活動方法或路徑尚未支援；原請求保留',400));
  const signature=originalRequestSignature(input.method,input.path,input.data),old=db.prepare('SELECT signature,response_json FROM request_results WHERE user_id=? AND request_key=?').get(user.id,input.requestKey) as {signature:string;response_json:string}|undefined;
  if(old?.signature===signature){
   let result:unknown;try{result=JSON.parse(old.response_json);}catch{throw withApiError(new DomainError('LEGACY_REQUEST_RESULT_MISMATCH','原回執無法解析；原請求保留',409));}
   if(!result||typeof result!=='object'||!('id' in result)||typeof result.id!=='string'||!('starts_at' in result)||typeof result.starts_at!=='string')throw withApiError(new DomainError('LEGACY_REQUEST_RESULT_MISMATCH','原回執不是建立活動結果；原請求保留',409));
   return {user,signature,alias:undefined,outcome:committed(result.id,user.id)};
  }
  let alias:string|undefined;try{alias=originalCreationKey(input.data.client_intent,'activity',hash);}catch{throw withApiError(new DomainError('LEGACY_ACTIVITY_CREATE_UNSUPPORTED','原建立識別尚未支援；原請求保留',400));}
  if(old&&input.requestKey!==alias)throw withApiError(new DomainError('LEGACY_REQUEST_CONFLICT','原操作編號與內容不符；原請求保留',409));
  const target=alias?viewActivityCreationKey(db,user.id,alias):undefined;
  const outcome=target?{state:'existing' as const,target:{kind:'activity' as const,id:target.id},route:destination(target.id,user.id).route}:undefined;
  return {user,signature,alias,outcome};
 }
 function prepare(s:ReturnType<typeof inspect>,input:ReturnType<typeof LegacyRequestCheck.parse>,time:Date){
  let command:ReturnType<typeof decodeLegacyActivityCreation>;try{command=decodeLegacyActivityCreation(input);}catch{throw withApiError(new DomainError('LEGACY_ACTIVITY_CREATE_UNSUPPORTED','原建立活動欄位尚未支援或缺失；原請求保留，不能重試',400));}
  if(!s.user.nickname)throw withApiError(new DomainError('LEGACY_ACTIVITY_CREATE_NAME_REQUIRED','請先設定稱呼，再核對建立活動',400));
  const plan=prepareActivityCreation(command.values,time,command.lifecycle,true),v=plan.values,policy=activityBotPolicy(db,defaults).config;
  const publicBot=command.lifecycle==='scheduled'&&v.visibility==='public'&&v.botEnabled&&policy.enabled;
  const target=publicBot&&policy.broadcast_kinds.includes('activity_published')?(policy.groups===null?'':policy.groups.find(g=>g.broadcast)?.id):undefined;
  let group_preview='';
  if(target!==undefined)try{
   // Explicit planned facts; no persistent ID, roster query, conditions query or trial write.
   const event:EventRow={id:'',owner_id:s.user.id,title:v.title,category:v.category,location:v.location,description:v.description,starts_at:v.startsAt,deadline:v.deadline,capacity:v.capacity,duration_hours:v.durationHours,created_at:legacyStamp(time),withdrawal_deadline:v.withdrawalDeadline,visibility:v.visibility,lifecycle:'scheduled',status:'open',revision:v.joinOwner?2:1,registration_open:1,timezone:v.timezone,minimum_participants:v.minimumParticipants,fee_policy:v.feePolicy,draft_join_owner:Number(v.joinOwner),bot_enabled:1,conditions_version:1,change_summary:'',cancellation_reason:'',formation_state:'pending',actual_started_at:null,actual_ended_at:null,archived_at:null};
   group_preview=buildActivityBotMessage(db,event,'activity_published',policy,time,defaults,undefined,{joinOwner:v.joinOwner,ownerName:s.user.nickname,url:'（建立後的活動連結）'})?.text??'';
  }catch{/* Optional original bot hook must not become mandatory. */}
  const value={command:{lifecycle:command.lifecycle,values:v},owner_name:s.user.nickname,group_target:target??null,group_preview,reminders:!!publicBot&&policy.schedule_enabled&&policy.broadcast_kinds.some(k=>k==='deadline_reminder'||k==='estimated_over_reminder')};
  const recovery_token=hash(JSON.stringify({user:s.user.id,key:input.requestKey,signature:s.signature,alias:s.alias,value,policy,defaults}));
  return {plan,view:{state:'retryable' as const,...value,recovery_token}};
 }
 app.post('/api/v2/me/legacy-requests/activity-create/inspect',limits,async request=>db.transaction(()=>{const input=LegacyRequestCheck.parse(request.body),s=inspect(request,input);return s.outcome??prepare(s,input,now()).view;})());
 app.post('/api/v2/me/legacy-requests/activity-create/retry',limits,async request=>db.transaction(()=>{
  const {confirm,recovery_token,...input}=LegacyActivityCreationRetry.parse(request.body);void confirm;
  const s=inspect(request,input);if(s.outcome)return s.outcome;
  const time=now(),p=prepare(s,input,time);if(p.view.recovery_token!==recovery_token)throw withApiError(new DomainError('LEGACY_ACTIVITY_CREATE_REVIEW_CHANGED','建立活動核對資料已變更；請重新檢查後確認',409));
  const hook=(work:()=>unknown)=>{try{db.transaction(work)();}catch{app.log.error('Activity creation bot hook failed; required business preserved');}};
  const id=executeActivityCreation(db,p.plan,s.user,time,defaults,hook),result=JSON.stringify({id,starts_at:p.plan.values.startsAt}),stamp=legacyStamp(time);
  for(const key of new Set([input.requestKey,...(s.alias?[s.alias]:[])]))db.prepare('INSERT INTO request_results VALUES(?,?,?,?,?,?)').run(s.user.id,key,s.signature,result,201,stamp);
  return committed(id,s.user.id);
 }).immediate());
}
