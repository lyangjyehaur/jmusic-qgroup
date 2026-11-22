import type { FastifyInstance } from 'fastify';
import type { DB } from '@qgroup/database';
import { LegacyRequestCheck,LegacyRegistrationRetry,legacyRegistrationPath,decodeLegacyRegistration } from '@qgroup/contracts';
import { botMoment,DomainError } from '@qgroup/domain';
import { withApiError } from './error-display';
import { hash,type Security } from './security';
import { originalRequestSignature } from './legacy-local';
import { requireActivityAccess } from './activity-access';
import { arrangementSnapshot,eventRow,eventScopes,legacyStamp,requireEventRevision } from './activity-arrangements';
import { activityPeople } from './activity-publish';
import { activityBotPolicy,type ActivityBotDefaults } from './activity-bot';
import { authorizeRegistration,registrationPerson,prepareRegistrationSignup,executeRegistrationSignup,prepareRegistrationChange,executeRegistrationChange } from './activity-registration';
import { prepareActivityConsent,executeActivityConsent } from './activity-management';
export function registerLegacyRegistration(app:FastifyInstance,db:DB,security:Security,now:()=>Date,defaults:ActivityBotDefaults={}){
 const limits={config:{rateLimit:{max:30,timeWindow:'1 minute'}}};
 function inspect(request:Parameters<Security['memberWrite']>[0],input:ReturnType<typeof LegacyRequestCheck.parse>){
  const user=security.memberWrite(request);let path:ReturnType<typeof legacyRegistrationPath>;
  try{path=legacyRegistrationPath(input);}catch{throw withApiError(new DomainError('LEGACY_REGISTRATION_UNSUPPORTED','原名冊方法或路徑尚未支援；原請求保留',400));}
  requireActivityAccess(db,path.id,user.id);const event=eventRow(db,path.id)!;
  const person=path.personId?registrationPerson(db,event,path.personId):path.kind==='self'?activityPeople(db,event.id).find(p=>p.user_id===user.id&&p.status!=='withdrawn'):undefined;
  if(path.personId){
   authorizeRegistration(db,event.id,user.id,path.personId);
   if(path.kind==='conditions'&&person!.manager_id!==user.id)throw withApiError(new DomainError('CONSENT_PERMISSION','只能確認本人或自己代報人員的安排',403));
   if(path.kind==='decision'&&!eventScopes(db,event,user.id).has('roster'))throw withApiError(new DomainError('ROSTER_PERMISSION','沒有退出審核權限',403));
  }
  const signature=originalRequestSignature(input.method,input.path,input.data),old=db.prepare('SELECT signature,response_json,response_status FROM request_results WHERE user_id=? AND request_key=?').get(user.id,input.requestKey) as {signature:string;response_json:string;response_status:number}|undefined;
  if(old){
   if(old.signature!==signature)throw withApiError(new DomainError('LEGACY_REQUEST_CONFLICT','原操作編號與內容不符；原請求保留',409));
   let result:unknown;try{result=JSON.parse(old.response_json);}catch{}
   if(old.response_status!==200||!result||typeof result!=='object'||!('id' in result)||result.id!==event.id||!('starts_at' in result)||typeof result.starts_at!=='string')throw withApiError(new DomainError('LEGACY_REQUEST_RESULT_MISMATCH','原回執與活動不一致；原請求保留',409));
  }
  return {user,event,path,person,signature,old};
 }
 function committed(s:ReturnType<typeof inspect>){return {state:'committed' as const,receipt:{committed:true,target:{kind:'activity' as const,id:s.event.id}},route:s.path.kind==='conditions'?'conditions' as const:'registration' as const};}
 function prepare(s:ReturnType<typeof inspect>,input:ReturnType<typeof LegacyRequestCheck.parse>,time:Date){
  const {event,user,person,path}=s;let command:ReturnType<typeof decodeLegacyRegistration>;
  try{command=decodeLegacyRegistration(input,person?{id:person.id,name:String(person.name),payer_kind:String(person.payer_kind),user_id:typeof person.user_id==='string'?person.user_id:null}:undefined);}catch{throw withApiError(new DomainError('LEGACY_REGISTRATION_UNSUPPORTED','原名冊欄位尚未支援或缺失；原請求保留',400));}
  if(!user.nickname)throw withApiError(new DomainError('NICKNAME_REQUIRED','請先設定稱呼再操作',400));
  if(path.kind!=='self'&&command.revision===undefined)throw withApiError(new DomainError('ACTIVITY_CHANGED','原名冊請求缺少活動版本；原請求保留',409));
  if(command.revision!==undefined)requireEventRevision(event,command.revision);
  const signup=command.kind==='signup'?prepareRegistrationSignup(db,event,user,command,time,command.originalPreviewRequired,!command.originalPreviewRequired&&(!!event.fee_policy||event.conditions_version>1)):undefined;
  const change=command.kind==='person'?prepareRegistrationChange(db,event,user,command.personId,command,time):undefined;
  const consent=command.kind==='conditions'?prepareActivityConsent(db,event,user,command.personId,command):undefined;
  const origin=person?db.prepare('SELECT payer_name FROM attendee_payment_origins WHERE attendee_id=?').get(person.id) as {payer_name:string}|undefined:undefined;
  const withdrawalRequest=change?.input.action==='withdraw'&&!(change.rosterScope&&change.person.manager_id!==user.id)&&change.person.status==='confirmed'&&botMoment(event.withdrawal_deadline||event.deadline,event.timezone)<=time.getTime();
  const value={command,title:event.title,currentRevision:event.revision,conditionsVersion:event.conditions_version,arrangement:arrangementSnapshot(event),allocation:signup?.preview.allocation??[],currentPerson:person?{name:person.nickname,isGuest:!person.user_id,status:person.status,payerKind:person.payer_kind,payerName:origin?.payer_name??(person.payer_kind==='self'?person.nickname:person.manager_name),paymentLocked:!!origin,acceptedVersion:person.accepted_conditions_version,confirmation:person.confirmation_state,withdrawalRequested:!!person.withdrawal_requested}:null,effect:command.kind==='person'?withdrawalRequest?'withdrawal_request' as const:command.action:command.kind==='conditions'?command.decision:command.kind};
  const recovery_token=hash(JSON.stringify({user,key:input.requestKey,signature:s.signature,event,people:activityPeople(db,event.id),origin,policy:activityBotPolicy(db,defaults),value}));
  return {signup,change,consent,view:{state:'retryable' as const,...value,recovery_token}};
 }
 app.post('/api/v2/me/legacy-requests/registration/inspect',limits,async request=>db.transaction(()=>{const input=LegacyRequestCheck.parse(request.body),s=inspect(request,input);return s.old?committed(s):prepare(s,input,now()).view;})());
 app.post('/api/v2/me/legacy-requests/registration/retry',limits,async request=>db.transaction(()=>{
  const {confirm,recovery_token,...input}=LegacyRegistrationRetry.parse(request.body);void confirm;
  const s=inspect(request,input);if(s.old)return committed(s);
  const time=now(),p=prepare(s,input,time);if(p.view.recovery_token!==recovery_token)throw withApiError(new DomainError('LEGACY_REGISTRATION_REVIEW_CHANGED','名冊、安排或通知政策已變更；請重新檢查',409));
  const hookError=(id:string)=>app.log.error({eventId:id},'Registration bot hook failed; required business preserved');
  if(p.signup)executeRegistrationSignup(db,p.signup,s.user,time,defaults,hookError);
  else if(p.change)executeRegistrationChange(db,p.change,s.user,time,defaults,hookError);
  else if(p.consent)executeActivityConsent(db,p.consent,s.user,time,defaults,hookError);
  const event=eventRow(db,s.event.id)!;
  db.prepare('INSERT INTO request_results VALUES(?,?,?,?,?,?)').run(s.user.id,input.requestKey,s.signature,JSON.stringify({id:event.id,starts_at:event.starts_at}),200,legacyStamp(time));return committed(s);
 }).immediate());
}
