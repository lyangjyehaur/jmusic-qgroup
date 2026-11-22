import { ActivityClaimPath, ActivityPath, ActivityTokenPath } from '@qgroup/contracts/http-paths';
import { withApiError } from './error-display';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DB } from '@qgroup/database';
import { AttendeeClaimResult, DecideAttendeeClaim, IssueAttendeeClaim, RequestAttendeeClaim } from '@qgroup/contracts';
import { DomainError } from '@qgroup/domain';
import { z } from 'zod';
import { hash, type Security } from './security';
import { requireActivityAccess } from './activity-access';
import { activityViewer } from './activity-roster';
import { appendEventAudit, eventRow, eventScopes, legacyStamp, requireEventRevision, type EventRow } from './activity-arrangements';
import { activityPeople, activityPeopleSnapshot, rosterDelta } from './activity-publish';
import { createActivityBot, type ActivityBotDefaults } from './activity-bot';
type Person=ReturnType<typeof activityPeople>[number];
type Claim={id:string;event_id:string;attendee_id:string;token:string;issuer_id:string;requester_id:string|null;status:string;expires_at:string;created_at:string;decided_at:string|null};
function getEvent(db:DB,id:string){const event=eventRow(db,id);if(!event||event.status==='deleted')throw withApiError(new DomainError('NOT_FOUND','找不到活動或尚未公開',404));return event;}
export function claimPerson(db:DB,event:EventRow,id:string){const person=activityPeople(db,event.id).find(person=>person.id===id&&person.status!=='withdrawn');if(!person)throw withApiError(new DomainError('ATTENDEE_NOT_FOUND','這條報名不存在或已退出',404));return person;}
function mayIssue(db:DB,event:EventRow,person:Person,userId:string|null){return !!userId&&(person.manager_id===userId||eventScopes(db,event,userId).has('roster'));}
export function claimBlocker(event:EventRow,person:Person){
  if(person.user_id||!['confirmed','waiting','tentative'].includes(person.status))return '只能認領尚未綁定帳號的有效代報名';
  if(event.archived_at)return '請先取消歸檔再核對認領';
  if(person.queue_mode==='together'&&person.status!=='confirmed')return '整組候補／待確認須先由管理人協調排隊，正式後再認領';return '';
}
function eligible(event:EventRow,person:Person){const message=claimBlocker(event,person);if(message)throw new DomainError('CLAIM_INELIGIBLE',message,409);}
export function claimManagement(db:DB,event:EventRow,person:Person,userId:string){requireActivityAccess(db,event.id,userId);if(!mayIssue(db,event,person,userId))throw withApiError(new DomainError('CLAIM_PERMISSION','只有原管理人或名單協辦可以核對認領',403));}
export function claimById(db:DB,event:EventRow,id:string){const claim=db.prepare('SELECT * FROM attendee_claims WHERE event_id=? AND id=?').get(event.id,id) as Claim|undefined;if(!claim)throw withApiError(new DomainError('CLAIM_NOT_FOUND','認領申請不存在',404));return claim;}
function active(claim:Claim,now:Date){return ['invited','requested'].includes(claim.status)&&Date.parse(claim.expires_at)>now.getTime();}
export function claimTokenLookup(db:DB,event:EventRow,token:string,now:Date){
  const claim=db.prepare('SELECT * FROM attendee_claims WHERE event_id=? AND token=?').get(event.id,token) as Claim|undefined;
  if(!claim||!active(claim,now))throw withApiError(new DomainError('CLAIM_NOT_FOUND','認領連結不存在、已使用、撤銷或過期',404));
  const person=claimPerson(db,event,claim.attendee_id);eligible(event,person);
  if(!mayIssue(db,event,person,claim.issuer_id))throw withApiError(new DomainError('CLAIM_ISSUER_CHANGED','原邀請人已失去管理權限，請重新邀請',409));return {claim,person};
}
function duplicate(db:DB,id:string,userId:string|null){return !!userId&&!!db.prepare("SELECT 1 FROM attendees WHERE event_id=? AND user_id=? AND status!='withdrawn'").get(id,userId);}

type ClaimUser={id:string;nickname:string};
export function activityClaimCommands(db:DB,now:()=>Date,defaults:ActivityBotDefaults={},hookError:(id:string)=>void=()=>{}){
 const bot=createActivityBot(db,now,defaults);
  function append(event:EventRow,user:{id:string;nickname:string},action:string,before:unknown,after:unknown,reason:string,stamp:string){
    if(appendEventAudit(db,event,user,action,before,after,reason,stamp))try{db.transaction(()=>bot.rosterUpdated(event.id,action,[],[]))();}catch{hookError(event.id);}
  }
  function notify(event:EventRow,userId:string,kind:'claim_requested'|'claim_decided',message:string,stamp:string){db.prepare('INSERT INTO notifications(user_id,event_id,kind,message,created_at) VALUES(?,?,?,?,?)').run(userId,event.id,kind,message,stamp);try{db.transaction(()=>bot.personal(event.id,userId,kind))();}catch{hookError(event.id);}}

 function prepareIssue(event:EventRow,user:ClaimUser,input:{revision:number;attendeeId:string;reason:string}){
  claimManagement(db,event,claimPerson(db,event,input.attendeeId),user.id);
      requireEventRevision(event,input.revision);const person=claimPerson(db,event,input.attendeeId);eligible(event,person);

  return {event,input,person};
 }
 function issue(prepared:ReturnType<typeof prepareIssue>,user:ClaimUser,time:Date){
  const {event,input,person}=prepared,id=event.id,stamp=legacyStamp(time);
      const superseded=(db.prepare("SELECT id FROM attendee_claims WHERE attendee_id=? AND status IN ('invited','requested')").all(person.id) as {id:string}[]).map(row=>row.id);
      db.prepare("UPDATE attendee_claims SET status='revoked' WHERE attendee_id=? AND status IN ('invited','requested')").run(person.id);
      const claimId=randomBytes(8).toString('hex'),token=randomBytes(24).toString('base64url'),expiresAt=legacyStamp(new Date(time.getTime()+7*86400000));
      db.prepare("INSERT INTO attendee_claims VALUES(?,?,?,?,?,NULL,'invited',?,?,NULL)").run(claimId,id,person.id,token,user.id,expiresAt,stamp);
      append(event,user,'claim_invited',{}, {claim_id:claimId,attendee_id:person.id,name:person.nickname,superseded},input.reason,stamp);return claimId;
 }
 function prepareRequest(event:EventRow,user:ClaimUser,token:string,input:{revision:number;confirmIdentity:true;keepPayment:true}){
  if(input.confirmIdentity!==true||input.keepPayment!==true)throw withApiError(new DomainError('CLAIM_CONFIRM','請確認本人身份以及保留原付款責任',400));
      requireEventRevision(event,input.revision);const {claim,person}=claimTokenLookup(db,event,token,now());
      if(claim.status!=='invited')throw withApiError(new DomainError('CLAIM_PENDING','已有認領申請，請等待管理人核對',409));
      if(!user.nickname)throw withApiError(new DomainError('NICKNAME_REQUIRED','請先設定自己的稱呼',409));
      if(user.id===person.manager_id)throw withApiError(new DomainError('CLAIM_OWN_MANAGER','請由被代報者自己的帳號申請認領',409));
      if(duplicate(db,event.id,user.id))throw withApiError(new DomainError('ALREADY_REGISTERED','你已有本人報名；請先與管理人核對重複項，不能自動合併名額或款項',409));

  return {event,claim,person};
 }
 function request(prepared:ReturnType<typeof prepareRequest>,user:ClaimUser,time:Date){
  const {event,claim,person}=prepared,stamp=legacyStamp(time);
      db.prepare("UPDATE attendee_claims SET status='requested',requester_id=? WHERE id=?").run(user.id,claim.id);
      append(event,user,'claim_requested',{}, {claim_id:claim.id,name:person.nickname,requester_name:user.nickname},'',stamp);
      const recipients=new Set([person.manager_id,event.owner_id]);for(const recipient of recipients)notify(event,recipient,'claim_requested',person.nickname+' 的报名认领申请待核对',stamp);return claim.id;
 }
 function prepareDecision(event:EventRow,user:ClaimUser,claimId:string,input:{revision:number;decision:'approve'|'reject'|'revoke';reason:string;confirmPerson:boolean}){
  const target=claimById(db,event,claimId);claimManagement(db,event,claimPerson(db,event,target.attendee_id),user.id);
  if(input.decision==='approve'&&input.confirmPerson!==true)throw withApiError(new DomainError('CLAIM_CONFIRM','請確認核對了申請人就是這位參加者',400));
      requireEventRevision(event,input.revision);const claim=claimById(db,event,claimId),person=claimPerson(db,event,claim.attendee_id);
      if(!active(claim,now()))throw withApiError(new DomainError('CLAIM_INACTIVE','認領邀請已失效',409));
      if(input.decision==='approve'){
        if(claim.status!=='requested'||!claim.requester_id)throw withApiError(new DomainError('CLAIM_NOT_REQUESTED','對方尚未申請認領',409));eligible(event,person);
        if(duplicate(db,event.id,claim.requester_id))throw withApiError(new DomainError('ALREADY_REGISTERED','申請人新增了本人報名，請先處理重複項後重新核對',409));
      }

  return {event,input,claim,person,claimId};
 }
 function decide(prepared:ReturnType<typeof prepareDecision>,user:ClaimUser,time:Date){
  const {event,input,claim,person,claimId}=prepared,id=event.id,stamp=legacyStamp(time);
      if(input.decision==='approve'){
        const payerId=person.payer_kind==='manager'?'account:'+hash(id+':'+person.manager_id).slice(0,16):'person:'+person.id;
        db.prepare('INSERT INTO attendee_payment_origins VALUES(?,?,?,?,?)').run(person.id,payerId,person.payer_kind==='manager'?person.manager_name:person.nickname,person.payer_kind==='self'?1:0,person.payer_kind==='manager'?person.manager_id:null);
        const before=activityPeopleSnapshot(db,id);db.prepare('UPDATE attendees SET user_id=?,manager_id=?,updated_at=? WHERE id=?').run(claim.requester_id,claim.requester_id,stamp,person.id);db.prepare('INSERT OR IGNORE INTO event_access VALUES(?,?,?)').run(id,claim.requester_id,stamp);
        const delta=rosterDelta(before,activityPeopleSnapshot(db,id));append(event,user,'claim_approved',{participants:delta.prior},{participants:delta.current,claim_id:claimId,attendee_id:person.id,payer_id:payerId},input.reason,stamp);
      }else append(event,user,'claim_'+input.decision,{claim_id:claimId,status:claim.status},{status:input.decision},input.reason,stamp);
      db.prepare('UPDATE attendee_claims SET status=?,decided_at=? WHERE id=?').run(input.decision==='approve'?'approved':input.decision==='reject'?'rejected':'revoked',stamp,claimId);
      if(claim.requester_id)notify(event,claim.requester_id,'claim_decided','报名认领已'+(input.decision==='approve'?'通过，原名额及款项保留':'结束，请联系管理人'),stamp);return claimId;
 }
 return {prepareIssue,issue,prepareRequest,request,prepareDecision,decide};
}
export function registerActivityClaims(app:FastifyInstance,db:DB,security:Security,now:()=>Date,defaults:ActivityBotDefaults={}){
  const commands=activityClaimCommands(db,now,defaults,id=>app.log.error({eventId:id},'Claim bot hook failed; business write preserved')),routeOptions={config:{rateLimit:{max:30,timeWindow:'1 minute'}}};
  function write(request:FastifyRequest,id:string,action:'issue'|'request'|'approve'|'reject'|'revoke',target:string,input:unknown,authorize:(event:EventRow,userId:string)=>void,run:(event:EventRow,user:{id:string;nickname:string},stamp:string)=>string){
    return db.transaction(()=>{
      const user=security.memberWrite(request),event=getEvent(db,id),key=z.string().uuid().parse(request.headers['idempotency-key']),signature='attendee-claim:'+encodeURIComponent(id)+':'+action+':'+hash(target)+':'+hash(JSON.stringify(input));
      const old=db.prepare('SELECT signature,response_json FROM request_results WHERE user_id=? AND request_key=?').get(user.id,key) as {signature:string;response_json:string}|undefined;
      if(old){
        if(old.signature!==signature)throw withApiError(new DomainError('REQUEST_CONFLICT','這個操作編號已用於另一份內容',409));
        const result=AttendeeClaimResult.parse(JSON.parse(old.response_json)),claim=claimById(db,event,result.claimId);
        // Approval transfers management away from the actor. Its immutable receipt may
        // confirm that completed operation, never authorize a fresh decision or return a token.
        if(action==='approve'&&claim.status==='approved')requireActivityAccess(db,id,user.id);
        else if(action==='request'){
          if(claim.requester_id!==user.id)throw withApiError(new DomainError('CLAIM_PERMISSION','此申請不屬於目前帳號',403));
        }else authorize(event,user.id);
        return result;
      }
      authorize(event,user.id);const claimId=run(event,user,legacyStamp(now())),result={id,revision:eventRow(db,id)!.revision,claimId};
      db.prepare('INSERT INTO request_results VALUES(?,?,?,?,?,?)').run(user.id,key,signature,JSON.stringify(result),200,legacyStamp(now()));return result;
    }).immediate();
  }
  app.get('/api/v2/activities/:id/claims',async request=>db.transaction(()=>{
    const {id}=ActivityPath.parse(request.params),user=security.scopedMember(request),event=getEvent(db,id);requireActivityAccess(db,id,user.id);const people=activityPeople(db,id),claims=db.prepare('SELECT c.*,u.nickname AS requester_name FROM attendee_claims c LEFT JOIN users u ON u.id=c.requester_id WHERE c.event_id=? ORDER BY c.created_at DESC').all(id) as (Claim&{requester_name:string|null})[];
    return {id,title:event.title,revision:event.revision,people:people.filter(person=>!person.user_id&&['confirmed','waiting','tentative'].includes(person.status)&&mayIssue(db,event,person,user.id)).map(person=>({id:person.id,name:person.nickname,status:person.status,payerName:person.payer_kind==='manager'?person.manager_name:person.nickname,blocker:claimBlocker(event,person)})),claims:claims.flatMap(claim=>{
      const person=people.find(person=>person.id===claim.attendee_id),manager=!!person&&mayIssue(db,event,person,user.id);if(!manager&&claim.requester_id!==user.id)return [];
      const usable=active(claim,now());return [{id:claim.id,attendeeId:claim.attendee_id,name:person?.nickname??'',status:!usable&&['invited','requested'].includes(claim.status)?'expired':claim.status,requesterName:claim.requester_name,expiresAt:claim.expires_at,token:manager&&usable&&claim.status==='invited'?claim.token:null,canDecide:manager&&usable&&claim.status==='requested'&&person?.status!=='withdrawn',canRevoke:manager&&usable&&person?.status!=='withdrawn'}];
    })};
  })());
  app.get('/api/v2/activities/:id/claims/preview/:token',routeOptions,async request=>db.transaction(()=>{
    const {id,token}=ActivityTokenPath.parse(request.params),event=getEvent(db,id),viewer=activityViewer(security,request);
    const completed=db.prepare("SELECT attendee_id FROM attendee_claims WHERE event_id=? AND token=? AND status='approved' AND requester_id=?").get(id,token,viewer??'') as {attendee_id:string}|undefined;
    if(completed){const person=claimPerson(db,event,completed.attendee_id);return {state:'claimed' as const,id,title:event.title,name:person.nickname};}
    const {claim,person}=claimTokenLookup(db,event,token,now());return {state:'open' as const,id,title:event.title,name:person.nickname,status:person.status,payerName:person.payer_kind==='manager'?person.manager_name:person.nickname,payerKind:person.payer_kind,revision:event.revision,expiresAt:claim.expires_at,claimStatus:claim.status,requestedByMe:!!viewer&&claim.requester_id===viewer,duplicate:duplicate(db,id,viewer),isManager:person.manager_id===viewer};
  })());
  app.post('/api/v2/activities/:id/claims',routeOptions,async request=>{
    const {id}=ActivityPath.parse(request.params),input=IssueAttendeeClaim.parse(request.body);
    return write(request,id,'issue',input.attendeeId,input,(event,userId)=>claimManagement(db,event,claimPerson(db,event,input.attendeeId),userId),(event,user,stamp)=>{
      return commands.issue(commands.prepareIssue(event,user,input),user,new Date(stamp));
    });
  });
  app.post('/api/v2/activities/:id/claims/preview/:token/request',routeOptions,async request=>{
    const {id,token}=ActivityTokenPath.parse(request.params),input=RequestAttendeeClaim.parse(request.body);
    return write(request,id,'request',token,input,(event)=>{claimTokenLookup(db,event,token,now());},(event,user,stamp)=>{
      return commands.request(commands.prepareRequest(event,user,token,input),user,new Date(stamp));
    });
  });
  app.post('/api/v2/activities/:id/claims/:claimId',routeOptions,async request=>{
    const {id,claimId}=ActivityClaimPath.parse(request.params),input=DecideAttendeeClaim.parse(request.body);
    return write(request,id,input.decision,claimId,input,(event,userId)=>{const claim=claimById(db,event,claimId);claimManagement(db,event,claimPerson(db,event,claim.attendee_id),userId);},(event,user,stamp)=>{
      return commands.decide(commands.prepareDecision(event,user,claimId,input),user,new Date(stamp));
    });
  });
}
