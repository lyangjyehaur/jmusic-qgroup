import type { FastifyInstance } from 'fastify';
import type { DB } from '@qgroup/database';
import { LegacyRequestCheck,LegacyParticipantRetry,legacyParticipantPath,decodeLegacyParticipant } from '@qgroup/contracts';
import { activityState,DomainError } from '@qgroup/domain';
import { withApiError } from './error-display';
import { hash,type Security } from './security';
import { originalRequestSignature } from './legacy-local';
import { requireActivityAccess } from './activity-access';
import { arrangementSnapshot,eventRow,legacyStamp } from './activity-arrangements';
import { activityPeople } from './activity-publish';
import { activityBotPolicy,type ActivityBotDefaults } from './activity-bot';
import { invitationEvent } from './activity-invitations';
import { activityClaimCommands,claimById,claimPerson,claimManagement,claimTokenLookup } from './activity-claims';
import { activityAttendanceCommands,attendancePermission } from './activity-attendance';
export function registerLegacyParticipants(app:FastifyInstance,db:DB,security:Security,now:()=>Date,defaults:ActivityBotDefaults={}){
 const limits={config:{rateLimit:{max:30,timeWindow:'1 minute'}}},hookError=(id:string)=>app.log.error({eventId:id},'Participant bot hook failed; required business preserved');
 const claims=activityClaimCommands(db,now,defaults,hookError),attendance=activityAttendanceCommands(db,now,defaults,hookError);
 function inspect(request:Parameters<Security['memberWrite']>[0],input:ReturnType<typeof LegacyRequestCheck.parse>){
  const user=security.memberWrite(request);let path:ReturnType<typeof legacyParticipantPath>,command:ReturnType<typeof decodeLegacyParticipant>;
  try{path=legacyParticipantPath(input);command=decodeLegacyParticipant(input);}catch{throw withApiError(new DomainError('LEGACY_PARTICIPANT_UNSUPPORTED','原認領／出席方法、欄位或版本缺失／尚未支援；原請求保留',400));}
  const event=invitationEvent(db,path.id),signature=originalRequestSignature(input.method,input.path,input.data),old=db.prepare('SELECT signature,response_json,response_status FROM request_results WHERE user_id=? AND request_key=?').get(user.id,input.requestKey) as {signature:string;response_json:string;response_status:number}|undefined;
  if(old){
   if(old.signature!==signature)throw withApiError(new DomainError('LEGACY_REQUEST_CONFLICT','原操作編號與內容不符；原請求保留',409));
   let result:unknown;try{result=JSON.parse(old.response_json);}catch{}
   if(old.response_status!==200||!result||typeof result!=='object'||!('id' in result)||result.id!==event.id||!('starts_at' in result)||typeof result.starts_at!=='string')throw withApiError(new DomainError('LEGACY_PARTICIPANT_RESULT_MISMATCH','原回執與活動不一致；原請求保留',409));
  }
  if(command.kind==='claim-issue')claimManagement(db,event,claimPerson(db,event,command.attendeeId),user.id);
  else if(command.kind==='attendance'||command.kind==='onsite')attendancePermission(db,event.id,user,command.kind==='onsite');
  else if(command.kind==='claim-decision'){
   const claim=claimById(db,event,path.claimId!);
   // Approval moves management to the claimant. Its exact, actor-scoped receipt confirms only the completed decision.
   if(old&&command.decision==='approve'&&claim.status==='approved')requireActivityAccess(db,event.id,user.id);
   else claimManagement(db,event,claimPerson(db,event,claim.attendee_id),user.id);
  }else if(old){
   const claim=db.prepare('SELECT requester_id FROM attendee_claims WHERE event_id=? AND token=?').get(event.id,path.token) as {requester_id:string|null}|undefined;
   if(claim?.requester_id!==user.id)throw withApiError(new DomainError('CLAIM_PERMISSION','此原認領申請不屬於目前帳號；原請求保留',403));
  }else claimTokenLookup(db,event,path.token!,now());
  return {user,event,path,command,signature,old,requestKey:input.requestKey};
 }
 function committed(s:ReturnType<typeof inspect>){
  const claim=s.command.kind==='claim-request'?db.prepare('SELECT status,expires_at FROM attendee_claims WHERE event_id=? AND token=? AND requester_id=?').get(s.event.id,s.path.token,s.user.id) as {status:string;expires_at:string}:null;
  const requestStatus=claim?['invited','requested'].includes(claim.status)&&Date.parse(claim.expires_at)<=now().getTime()?'expired':claim.status:null;
  return {state:'committed' as const,receipt:{committed:true,target:{kind:'activity' as const,id:s.event.id}},route:s.path.kind==='attendance'||s.path.kind==='onsite'?'attendance' as const:'claims' as const,requestStatus};
 }
 function prepare(s:ReturnType<typeof inspect>){
  const {event,user,path,command}=s;
  if(!user.nickname)throw withApiError(new DomainError('NICKNAME_REQUIRED','請先設定稱呼再操作',400));
  const issue=command.kind==='claim-issue'?claims.prepareIssue(event,user,command):undefined;
  const request=command.kind==='claim-request'?claims.prepareRequest(event,user,path.token!,command):undefined;
  const decision=command.kind==='claim-decision'?claims.prepareDecision(event,user,path.claimId!,command):undefined;
  const observation=command.kind==='attendance'?attendance.prepareChange(event,user,path.personId!,command):undefined;
  const onsite=command.kind==='onsite'?attendance.prepareOnsite(event,user,command):undefined;
  const people=activityPeople(db,event.id),person=issue?.person??request?.person??decision?.person??observation?.person,claim=request?.claim??decision?.claim;
  const origins=db.prepare('SELECT * FROM attendee_payment_origins WHERE attendee_id IN (SELECT id FROM attendees WHERE event_id=?) ORDER BY attendee_id').all(event.id) as {attendee_id:string;payer_name:string}[];
  const origin=person?origins.find(r=>r.attendee_id===person.id):undefined;
  const value={command,title:event.title,currentRevision:event.revision,phase:activityState(event,now()).phase,currentPerson:person?{name:person.nickname,status:person.status,payerName:origin?.payer_name??(person.payer_kind==='manager'?person.manager_name:person.nickname),payerKind:person.payer_kind,paymentLocked:!!origin,attendance:person.attendance,note:person.attendance_note,arrivedAt:person.arrived_at,leftAt:person.left_at}:null,claim:claim?{status:claim.status,requesterName:claim.requester_id?(db.prepare('SELECT nickname FROM users WHERE id=?').get(claim.requester_id) as {nickname:string}).nickname:null,expiresAt:claim.expires_at}:null,capacity:event.capacity,confirmed:people.filter(p=>p.status==='confirmed').length,waiting:people.filter(p=>p.status==='waiting').length,onsiteNames:onsite?.people.map(p=>p.name)??[],conditionsVersion:event.conditions_version,arrangement:arrangementSnapshot(event)};
  const allClaims=db.prepare('SELECT * FROM attendee_claims WHERE event_id=? ORDER BY id').all(event.id);
  const recovery_token=hash(JSON.stringify({user,key:s.requestKey,signature:s.signature,event,people,origins,claims:allClaims,policy:activityBotPolicy(db,defaults),value}));
  return {issue,request,decision,observation,onsite,view:{state:'retryable' as const,...value,recovery_token}};
 }
 app.post('/api/v2/me/legacy-requests/participants/inspect',limits,async request=>db.transaction(()=>{const input=LegacyRequestCheck.parse(request.body),s=inspect(request,input);return s.old?committed(s):prepare(s).view;})());
 app.post('/api/v2/me/legacy-requests/participants/retry',limits,async request=>db.transaction(()=>{
  const {confirm,recovery_token,...input}=LegacyParticipantRetry.parse(request.body);void confirm;const s=inspect(request,input);if(s.old)return committed(s);const p=prepare(s);
  if(p.view.recovery_token!==recovery_token)throw withApiError(new DomainError('LEGACY_PARTICIPANT_REVIEW_CHANGED','認領、出席、付款責任或通知政策已變更；請重新檢查',409));
  const time=now();
  if(p.issue)claims.issue(p.issue,s.user,time);else if(p.request)claims.request(p.request,s.user,time);else if(p.decision)claims.decide(p.decision,s.user,time);else if(p.observation)attendance.change(p.observation,s.user,time);else if(p.onsite)attendance.onsite(p.onsite,s.user,time);
  const event=eventRow(db,s.event.id)!;db.prepare('INSERT INTO request_results VALUES(?,?,?,?,?,?)').run(s.user.id,input.requestKey,s.signature,JSON.stringify({id:event.id,starts_at:event.starts_at}),200,legacyStamp(time));return committed(s);
 }).immediate());
}
