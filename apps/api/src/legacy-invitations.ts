import type { FastifyInstance } from 'fastify';
import type { DB } from '@qgroup/database';
import { LegacyRequestCheck,LegacyInvitationRetry,legacyInvitationPath,decodeLegacyInvitation } from '@qgroup/contracts';
import { DomainError } from '@qgroup/domain';
import { withApiError } from './error-display';
import { hash,type Security } from './security';
import { originalRequestSignature } from './legacy-local';
import { requireActivityAccess } from './activity-access';
import { arrangementSnapshot,eventRow,legacyStamp } from './activity-arrangements';
import { activityPeople } from './activity-publish';
import { activityBotPolicy,type ActivityBotDefaults } from './activity-bot';
import { activityInvitationCommands,invitationEvent,rosterInvitation,rosterInvitationPermission } from './activity-invitations';
import { activityDelegationCommands,delegationOwner,delegationInvitation,delegationRecipient } from './activity-delegation';
export function registerLegacyInvitations(app:FastifyInstance,db:DB,security:Security,now:()=>Date,defaults:ActivityBotDefaults={}){
 const limits={config:{rateLimit:{max:30,timeWindow:'1 minute'}}},hookError=(id:string)=>app.log.error({eventId:id},'Invitation bot hook failed; required business preserved');
 const roster=activityInvitationCommands(db,now,defaults,hookError),manager=activityDelegationCommands(db,now,defaults,hookError);
 const mismatch=()=>withApiError(new DomainError('LEGACY_INVITATION_RESULT_MISMATCH','原回執與邀請或目前帳號不一致；原請求保留',409));
 function inspect(request:Parameters<Security['memberWrite']>[0],input:ReturnType<typeof LegacyRequestCheck.parse>){
  const user=security.memberWrite(request);let path:ReturnType<typeof legacyInvitationPath>;
  try{path=legacyInvitationPath(input);}catch{throw withApiError(new DomainError('LEGACY_INVITATION_UNSUPPORTED','原邀請方法或路徑尚未支援；原請求保留',400));}
  const event=invitationEvent(db,path.id),signature=originalRequestSignature(input.method,input.path,input.data);
  if(path.kind==='roster-issue')rosterInvitationPermission(db,event,user.id);
  else if(!path.kind.endsWith('accept'))delegationOwner(db,event,user.id);
  const old=db.prepare('SELECT signature,response_json,response_status FROM request_results WHERE user_id=? AND request_key=?').get(user.id,input.requestKey) as {signature:string;response_json:string;response_status:number}|undefined;
  if(old){
   if(old.signature!==signature)throw withApiError(new DomainError('LEGACY_REQUEST_CONFLICT','原操作編號與內容不符；原請求保留',409));
   let result:unknown;try{result=JSON.parse(old.response_json);}catch{}
   if(old.response_status!==200||!result||typeof result!=='object'||!('id' in result)||result.id!==event.id||!('starts_at' in result)||typeof result.starts_at!=='string')throw mismatch();
   requireActivityAccess(db,event.id,user.id);
   if(path.kind==='roster-accept'){
    // Original serialization contains the exact accepted person's identity. A current signup alone proves nothing about this token.
    const person='my_registration' in result?result.my_registration:null;
    if(!person||typeof person!=='object'||!('id' in person)||typeof person.id!=='string'||!('is_me' in person)||person.is_me!==true||!('managed_by_me' in person)||person.managed_by_me!==true||!('is_guest' in person)||person.is_guest!==false||!db.prepare('SELECT 1 FROM attendees WHERE event_id=? AND id=? AND user_id=? AND manager_id=?').get(event.id,person.id,user.id,user.id))throw mismatch();
   }
   if(path.kind==='manager-accept'&&!db.prepare("SELECT 1 FROM management_invitations WHERE event_id=? AND token=? AND status='accepted' AND accepted_by=?").get(event.id,path.token,user.id))throw mismatch();
  }else if(path.kind==='roster-accept')rosterInvitation(db,event.id,path.token!);
  else if(path.kind==='manager-accept')delegationRecipient(delegationInvitation(db,event,path.token!,now()),user.id);
  return {user,event,path,signature,old};
 }
 function committed(s:ReturnType<typeof inspect>){return {state:'committed' as const,receipt:{committed:true,target:{kind:'activity' as const,id:s.event.id}},route:s.path.kind==='roster-accept'?'registration' as const:s.path.kind==='roster-issue'?'invitations' as const:'delegation' as const};}
 function prepare(s:ReturnType<typeof inspect>,input:ReturnType<typeof LegacyRequestCheck.parse>){
  const {event,user,path}=s;let command:ReturnType<typeof decodeLegacyInvitation>;
  try{command=decodeLegacyInvitation(input);}catch{throw withApiError(new DomainError('LEGACY_INVITATION_UNSUPPORTED','原邀請欄位或版本缺失／尚未支援；原請求保留',400));}
  if(!user.nickname)throw withApiError(new DomainError('NICKNAME_REQUIRED','請先設定稱呼再操作',400));
  const issue=command.kind==='roster-issue'?roster.prepareIssue(event,user,command):undefined;
  const accept=command.kind==='roster-accept'?roster.prepareAccept(event,user,path.token!,command,!!event.fee_policy||event.conditions_version>1):undefined;
  const invite=command.kind==='manager-issue'?manager.prepareInvite(event,user,{...command,kind:command.role}):undefined;
  const take=command.kind==='manager-accept'?manager.prepareAccept(event,user,path.token!,command):undefined;
  const revoke=command.kind==='invitation-revoke'?manager.prepareRevokeInvitation(event,user,path.itemId!,command):undefined;
  const role=command.kind==='role-revoke'?manager.prepareRevokeRole(event,user,path.itemId!,command):undefined;
  const roles=db.prepare('SELECT r.*,u.nickname FROM event_roles r JOIN users u ON u.id=r.user_id WHERE event_id=? ORDER BY r.created_at,r.id').all(event.id) as {id:string;nickname:string;permissions_json:string}[];
  const invitations=db.prepare('SELECT * FROM management_invitations WHERE event_id=? ORDER BY id').all(event.id);
  const ownerName=(db.prepare('SELECT nickname FROM users WHERE id=?').get(event.owner_id) as {nickname:string}).nickname;
  const value={command,title:event.title,currentRevision:event.revision,ownerName,targetName:accept?.person.nickname??take?.invitation.target_name??revoke?.invitation.target_name??role?.role.nickname??invite?.input.targetName??'',permissions:take?JSON.parse(take.invitation.permissions_json):invite?.permissions??[],priorRoles:roles.filter(r=>path.kind==='manager-accept'?db.prepare('SELECT 1 FROM event_roles WHERE id=? AND user_id=?').get(r.id,user.id):['manager-issue','role-revoke','invitation-revoke'].includes(path.kind)).map(r=>({name:r.nickname,permissions:JSON.parse(r.permissions_json)})),expiresAt:take?.invitation.expires_at??null,status:accept?.status??null,conditionsVersion:event.conditions_version,arrangement:arrangementSnapshot(event)};
  const recovery_token=hash(JSON.stringify({user,key:input.requestKey,signature:s.signature,event,people:activityPeople(db,event.id),roles,invitations,policy:activityBotPolicy(db,defaults),value}));
  return {issue,accept,invite,take,revoke,role,view:{state:'retryable' as const,...value,recovery_token}};
 }
 app.post('/api/v2/me/legacy-requests/invitations/inspect',limits,async request=>db.transaction(()=>{const input=LegacyRequestCheck.parse(request.body),s=inspect(request,input);return s.old?committed(s):prepare(s,input).view;})());
 app.post('/api/v2/me/legacy-requests/invitations/retry',limits,async request=>db.transaction(()=>{
  const {confirm,recovery_token,...input}=LegacyInvitationRetry.parse(request.body);void confirm;
  const s=inspect(request,input);if(s.old)return committed(s);const p=prepare(s,input);
  if(p.view.recovery_token!==recovery_token)throw withApiError(new DomainError('LEGACY_INVITATION_REVIEW_CHANGED','邀請、名冊、管理責任或通知政策已變更；請重新檢查',409));
  const time=now();let attendeeId:string|null=null;
  if(p.issue)roster.issue(p.issue,s.user,time);
  else if(p.accept)attendeeId=roster.accept(p.accept,s.user,time);
  else if(p.invite)manager.invite(p.invite,s.user,time);
  else if(p.take)manager.accept(p.take,s.user,time);
  else if(p.revoke)manager.revokeInvitation(p.revoke,s.user,time);
  else if(p.role)manager.revokeRole(p.role,s.user,time);
  const event=eventRow(db,s.event.id)!,result={id:event.id,starts_at:event.starts_at,...(attendeeId?{my_registration:{id:attendeeId,is_me:true,managed_by_me:true,is_guest:false}}:{})};
  db.prepare('INSERT INTO request_results VALUES(?,?,?,?,?,?)').run(s.user.id,input.requestKey,s.signature,JSON.stringify(result),200,legacyStamp(time));return committed(s);
 }).immediate());
}
