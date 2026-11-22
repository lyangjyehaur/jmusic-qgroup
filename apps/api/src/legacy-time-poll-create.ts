import type { FastifyInstance } from 'fastify';
import type { DB } from '@qgroup/database';
import { LegacyRequestCheck, LegacyPollCreationRetry, decodeLegacyPollCreation, originalPollCreateKey } from '@qgroup/contracts';
import { DomainError } from '@qgroup/domain';
import { hash, type Security } from './security';
import { withApiError } from './error-display';
import { originalRequestSignature } from './legacy-local';
import { legacyStamp } from './activity-arrangements';
import { activityBotPolicy, type ActivityBotDefaults } from './activity-bot';
import { preparePollCreation, executePollCreation, requirePollOwner } from './time-poll-command';
import { composeTimePollBotMessage } from './time-poll-bot';
import { pollRow } from './time-poll-context';
import { viewPollCreationKey } from './create-intents';
export function registerLegacyPollCreation(app:FastifyInstance,db:DB,security:Security,now:()=>Date,defaults:ActivityBotDefaults={}) {
 const limits={config:{rateLimit:{max:30,timeWindow:'1 minute'}}};
 const committed=(id:string)=>({state:'committed' as const,receipt:{committed:true,target:{kind:'poll' as const,id}}});
 const existing=(id:string)=>({state:'existing' as const,target:{kind:'poll' as const,id}});
 function inspect(request:Parameters<Security['memberWrite']>[0],input:ReturnType<typeof LegacyRequestCheck.parse>) {
  const user=security.memberWrite(request);
  if(input.method!=='POST'||input.path!=='/api/time-polls')throw withApiError(new DomainError('LEGACY_POLL_CREATE_UNSUPPORTED','原建立投票方法或路徑尚未支援；原請求保留',400));
  const signature=originalRequestSignature(input.method,input.path,input.data),old=db.prepare('SELECT signature,response_json FROM request_results WHERE user_id=? AND request_key=?').get(user.id,input.requestKey) as {signature:string;response_json:string}|undefined;
  if(old?.signature===signature){
   let result:unknown;try{result=JSON.parse(old.response_json);}catch{throw withApiError(new DomainError('LEGACY_REQUEST_RESULT_MISMATCH','原回執無法解析；原請求保留',409));}
   if(!result||typeof result!=='object'||!('id' in result)||typeof result.id!=='string'||!('time_poll' in result)||result.time_poll!==true)throw withApiError(new DomainError('LEGACY_REQUEST_RESULT_MISMATCH','原回執不是建立投票結果；原請求保留',409));
   const poll=pollRow(db,result.id,true);requirePollOwner(poll,user.id);
   return {user,signature,outcome:committed(poll.id),alias:undefined};
  }
  let alias:string|undefined;try{alias=originalPollCreateKey(input,hash);}catch{throw withApiError(new DomainError('LEGACY_POLL_CREATE_UNSUPPORTED','原建立識別尚未支援；原請求保留',400));}
  if(old&&input.requestKey!==alias)throw withApiError(new DomainError('LEGACY_REQUEST_CONFLICT','原操作編號與內容不符；原請求保留',409));
  const target=alias?viewPollCreationKey(db,user.id,alias):undefined;
  return {user,signature,alias,outcome:target?existing(target.id):undefined};
 }
 function prepare(s:ReturnType<typeof inspect>,input:ReturnType<typeof LegacyRequestCheck.parse>,time:Date){
  let command:ReturnType<typeof decodeLegacyPollCreation>;try{command=decodeLegacyPollCreation(input);}catch{throw withApiError(new DomainError('LEGACY_POLL_CREATE_UNSUPPORTED','原建立投票欄位尚未支援或缺失；原請求保留，不能重試',400));}
  const plan=preparePollCreation(command,time),policy=activityBotPolicy(db,defaults).config;
  const target=policy.enabled&&command.bot_enabled&&policy.broadcast_kinds.includes('time_poll_published')?(policy.groups===null?'':policy.groups.find(g=>g.broadcast)?.id):undefined;
  let group_preview='';
  // Planned candidates have no persistent ID. Show an explicit future-link placeholder.
  if(target!==undefined)try{group_preview=composeTimePollBotMessage({...command,duration_hours:command.time_mode==='date'?0:command.duration_hours,id:'',deadline:plan.deadline},plan.starts.map(starts_at=>({starts_at})),policy,defaults,'（建立後的投票連結）').text;}catch{/* Original creation hook is optional. */}
  const value={command,starts:plan.starts,deadline:plan.deadline,owner_name:s.user.nickname,group_target:target??null,group_preview};
  const recovery_token=hash(JSON.stringify({user:s.user.id,key:input.requestKey,signature:s.signature,alias:s.alias,value,policy,defaults}));
  return {plan,view:{state:'retryable' as const,...value,recovery_token}};
 }
 app.post('/api/v2/me/legacy-requests/time-poll-create/inspect',limits,async request=>db.transaction(()=>{const input=LegacyRequestCheck.parse(request.body),s=inspect(request,input);return s.outcome??prepare(s,input,now()).view;})());
 app.post('/api/v2/me/legacy-requests/time-poll-create/retry',limits,async request=>db.transaction(()=>{
  const {confirm,recovery_token,...input}=LegacyPollCreationRetry.parse(request.body);void confirm;
  const s=inspect(request,input);if(s.outcome)return s.outcome;
  const time=now(),p=prepare(s,input,time);if(p.view.recovery_token!==recovery_token)throw withApiError(new DomainError('LEGACY_POLL_CREATE_REVIEW_CHANGED','建立投票核對資料已變更；請重新檢查後確認',409));
  const hook=(work:()=>unknown)=>{try{db.transaction(work)();}catch{app.log.error('Poll creation bot hook failed; required business preserved');}};
  const id=executePollCreation(db,p.plan,s.user,time,defaults,hook),result=JSON.stringify({id,time_poll:true}),stamp=legacyStamp(time);
  // Preserve original receipt; a separate durable alias prevents later native draft duplication.
  for(const key of new Set([input.requestKey,...(s.alias?[s.alias]:[])]))db.prepare('INSERT INTO request_results VALUES(?,?,?,?,?,?)').run(s.user.id,key,s.signature,result,201,stamp);
  return committed(id);
 }).immediate());
}
