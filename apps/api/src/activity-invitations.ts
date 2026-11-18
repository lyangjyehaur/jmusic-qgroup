import { withApiError } from './error-display';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DB } from '@qgroup/database';
import { AcceptActivityInvitation, ActivityInvitationResult, IssueActivityInvitations } from '@qgroup/contracts';
import { activityState, DomainError } from '@qgroup/domain';
import { z } from 'zod';
import { hash, type Security } from './security';
import { requireActivityAccess } from './activity-access';
import { appendEventAudit, arrangementSnapshot, eventRow, eventScopes, legacyStamp, requireEventRevision, type EventRow } from './activity-arrangements';
import { activityPeople, activityPeopleSnapshot, allocateActivity, rosterDelta } from './activity-publish';
import { ensureMutable, mutableBlocker } from './activity-registration';
import { createActivityBot, type ActivityBotDefaults } from './activity-bot';

function eventByToken(db:DB,id:string){
  const event=eventRow(db,id);if(!event||event.status==='deleted')throw withApiError(new DomainError('NOT_FOUND','找不到活動或尚未公開',404));return event;
}
function invitation(db:DB,id:string,token:string){
  const person=activityPeople(db,id).find(person=>person.status==='invited'&&person.invitation_token===token);
  if(!person)throw withApiError(new DomainError('INVITATION_NOT_FOUND','邀請不存在、已使用或已撤銷',404));return person;
}
function rosterPermission(db:DB,event:EventRow,userId:string){
  requireActivityAccess(db,event.id,userId);
  if(!eventScopes(db,event,userId).has('roster'))throw withApiError(new DomainError('ROSTER_PERMISSION','只有名單管理者可以建立補報名邀請',403));
}
function allocation(db:DB,event:EventRow,now:Date){
  const people=activityPeople(db,event.id);
  // Closed registration deliberately fills available places without promoting the old queue.
  return activityState(event,now).registrationOpen?allocateActivity(people,event.capacity,['new']).get('new')!:!event.capacity||people.filter(person=>person.status==='confirmed').length<event.capacity?'confirmed' as const:'waiting' as const;
}
export function registerActivityInvitations(app:FastifyInstance,db:DB,security:Security,now:()=>Date,defaults:ActivityBotDefaults={}){
  const params=z.object({id:z.string().min(1).max(80)}),tokenParams=params.extend({token:z.string().regex(/^[A-Za-z0-9_-]{32}$/)}),bot=createActivityBot(db,now,defaults);
  const routeOptions={config:{rateLimit:{max:30,timeWindow:'1 minute'}}};
  function record(event:EventRow,user:{id:string;nickname:string},action:string,before:ReturnType<typeof activityPeopleSnapshot>,reason:string,stamp:string){
    const delta=rosterDelta(before,activityPeopleSnapshot(db,event.id));
    if(appendEventAudit(db,event,user,action,{participants:delta.prior},{participants:delta.current},reason,stamp)){
      try{db.transaction(()=>bot.rosterUpdated(event.id,action,delta.prior as {id:string;status:string}[],delta.current as {id:string;status:string}[]))();}
      catch{app.log.error({eventId:event.id},'Invitation bot hook failed; business write preserved');}
    }
  }
  function write(request:FastifyRequest,id:string,action:'issue'|'accept',token:string,input:unknown,run:(event:EventRow,user:{id:string;nickname:string},stamp:string)=>string|null){
    return db.transaction(()=>{
      const user=security.memberWrite(request),event=eventByToken(db,id),key=z.string().uuid().parse(request.headers['idempotency-key']);
      if(action==='issue')rosterPermission(db,event,user.id);
      const signature='activity-invitation:'+encodeURIComponent(id)+':'+action+':'+hash(token)+':'+hash(JSON.stringify(input));
      const old=db.prepare('SELECT signature,response_json FROM request_results WHERE user_id=? AND request_key=?').get(user.id,key) as {signature:string;response_json:string}|undefined;
      if(old){
        if(old.signature!==signature)throw withApiError(new DomainError('REQUEST_CONFLICT','這個操作編號已用於另一份內容',409));
        const result=ActivityInvitationResult.parse(JSON.parse(old.response_json));
        if(action==='accept'){
          requireActivityAccess(db,id,user.id);
          if(!db.prepare('SELECT 1 FROM attendees WHERE event_id=? AND id=? AND user_id=? AND manager_id=?').get(id,result.attendeeId,user.id,user.id))throw withApiError(new DomainError('ROSTER_PERMISSION','原報名已不屬於此帳號',403));
        }
        return result;
      }
      const attendeeId=run(event,user,legacyStamp(now())),result={id,revision:eventRow(db,id)!.revision,attendeeId};
      db.prepare('INSERT INTO request_results VALUES(?,?,?,?,?,?)').run(user.id,key,signature,JSON.stringify(result),200,legacyStamp(now()));return result;
    }).immediate();
  }
  app.get('/api/v2/activities/:id/invitations',async request=>db.transaction(()=>{
    const {id}=params.parse(request.params),user=security.scopedMember(request),event=eventByToken(db,id);requireActivityAccess(db,id,user.id);const canIssue=eventScopes(db,event,user.id).has('roster');
    return {id,title:event.title,revision:event.revision,blocker:mutableBlocker(db,event),canIssue,people:activityPeople(db,id).filter(person=>person.status==='invited'&&(canIssue||person.manager_id===user.id)).map(person=>({id:person.id,name:person.nickname,note:person.note,token:person.invitation_token}))};
  })());
  app.get('/api/v2/activities/:id/invitations/:token',routeOptions,async request=>db.transaction(()=>{
    const {id,token}=tokenParams.parse(request.params),event=eventByToken(db,id),person=invitation(db,id,token);
    return {id,title:event.title,name:person.nickname,revision:event.revision,conditionsVersion:event.conditions_version,arrangement:arrangementSnapshot(event),status:allocation(db,event,now()),blocker:mutableBlocker(db,event)};
  })());
  app.post('/api/v2/activities/:id/invitations',routeOptions,async request=>{
    const {id}=params.parse(request.params),input=IssueActivityInvitations.parse(request.body);
    return write(request,id,'issue','',input,(event,user,stamp)=>{
      requireEventRevision(event,input.revision);ensureMutable(db,event);const before=activityPeopleSnapshot(db,id);
      for(const person of input.people)db.prepare("INSERT INTO attendees(id,event_id,manager_id,name,note,payer_kind,status,invitation_token,created_at,updated_at) VALUES(?,?,?,?,?,'self','invited',?,?,?)").run(randomBytes(8).toString('hex'),id,user.id,person.name,person.note,randomBytes(24).toString('base64url'),stamp,stamp);
      record(event,user,'invite',before,input.reason,stamp);return null;
    });
  });
  app.post('/api/v2/activities/:id/invitations/:token/accept',routeOptions,async request=>{
    const {id,token}=tokenParams.parse(request.params),input=AcceptActivityInvitation.parse(request.body);
    return write(request,id,'accept',token,input,(event,user,stamp)=>{
      requireEventRevision(event,input.revision);ensureMutable(db,event);const person=invitation(db,id,token);
      if(input.conditionsVersion!==event.conditions_version)throw withApiError(new DomainError('CONDITIONS_CHANGED','安排已有變更，請重新核對後確認',409));
      if(db.prepare("SELECT 1 FROM attendees WHERE event_id=? AND user_id=? AND status!='withdrawn'").get(id,user.id))throw withApiError(new DomainError('ALREADY_REGISTERED','你已有本人報名，請讓名單管理者核對',409));
      const status=allocation(db,event,now());if(status==='waiting'&&!input.acceptWaiting)throw withApiError(new DomainError('WAITING_CONFIRM','目前需要候補，請明確接受候補後重試',409));
      const before=activityPeopleSnapshot(db,id),party=randomBytes(8).toString('hex');
      db.prepare("INSERT INTO roster_parties(id,event_id,manager_id,queue_mode,created_at) VALUES(?,?,?,'individual',?)").run(party,id,user.id,stamp);
      db.prepare("UPDATE attendees SET manager_id=?,user_id=?,name=?,party_id=?,status=?,invitation_token=NULL,updated_at=?,accepted_conditions_version=?,confirmation_state='accepted' WHERE id=?").run(user.id,user.id,user.nickname,party,status,stamp,event.conditions_version,person.id);
      db.prepare('INSERT OR IGNORE INTO event_access VALUES(?,?,?)').run(id,user.id,stamp);
      db.prepare("INSERT INTO attendee_consents(attendee_id,event_id,version,decision,actor_id,actor_name,reason,created_at) VALUES(?,?,?,'accepted',?,?,'报名时接受当前安排',?)").run(person.id,id,event.conditions_version,user.id,user.nickname,stamp);
      record(event,user,'invitation_accepted',before,'',stamp);return person.id;
    });
  });
}
