import { withApiError } from './error-display';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DB } from '@qgroup/database';
import { PageQuery, ActivityDraftResult, RespondActivityConditions, SaveActivityDraft } from '@qgroup/contracts';
import { DomainError } from '@qgroup/domain';
import { z } from 'zod';
import { hash, type Security } from './security';
import { requireActivityAccess } from './activity-access';
import { activityViewer } from './activity-roster';
import { appendEventAudit, arrangementSnapshot, arrangementValues, eventRow, eventScopes, eventSnapshot, legacyStamp, requireEventRevision, storedArrangement, type EventRow } from './activity-arrangements';
import { activityPeopleSnapshot, rebalanceActivity, rosterDelta } from './activity-publish';
import { createActivityBot, type ActivityBotDefaults } from './activity-bot';

const params=z.object({id:z.string().min(1).max(80)});
const fields=['category','starts_at','duration_hours','location','description','withdrawal_deadline','timezone','fee_policy'] as const;
const labels={category:'类型',starts_at:'时间',duration_hours:'时长',location:'地点',description:'注意事项',withdrawal_deadline:'退出期限',timezone:'时区',fee_policy:'费用规则'};
function canAssist(db:DB,event:EventRow,userId:string){return ['scheduled','ongoing'].includes(event.lifecycle)&&!event.archived_at&&!!db.prepare('SELECT 1 FROM user_admin_roles WHERE user_id=? AND is_admin=1 AND NOT EXISTS(SELECT 1 FROM privacy_requests WHERE user_id=?)').get(userId,userId);}
function requireSchedule(db:DB,event:EventRow,userId:string){
  if(!eventScopes(db,event,userId).has('schedule')&&!canAssist(db,event,userId))throw withApiError(new DomainError('ACTIVITY_PERMISSION','沒有這項活動管理權限',403));
}
function activePerson(db:DB,eventId:string,personId:string,userId:string){
  const person=db.prepare("SELECT a.*,COALESCE(u.nickname,a.name) AS current_name FROM attendees a LEFT JOIN users u ON u.id=a.user_id WHERE a.id=? AND a.event_id=? AND status IN ('confirmed','waiting','tentative')").get(personId,eventId) as {id:string;manager_id:string;current_name:string;confirmation_state:string;accepted_conditions_version:number|null}|undefined;
  if(!person)throw withApiError(new DomainError('ATTENDEE_NOT_FOUND','這位參加者不在有效名單中',404));
  if(person.manager_id!==userId)throw withApiError(new DomainError('CONSENT_PERMISSION','只能確認本人或自己代報人員的安排',403));
  return person;
}
export function activityArrangements(db:DB,id:string,userId:string){
  requireActivityAccess(db,id,userId);const event=eventRow(db,id)!;
  if(event.lifecycle==='draft')throw withApiError(new DomainError('IS_DRAFT','活動尚未發布，請從活動草稿編輯',409));
  const owner=event.owner_id===userId,assisted=!owner&&canAssist(db,event,userId);
  const settled=!!db.prepare('SELECT 1 FROM settlements WHERE event_id=?').get(id);
  const canEdit=(eventScopes(db,event,userId).has('schedule')||assisted)&&!['ended','cancelled'].includes(event.lifecycle)&&!event.archived_at&&!settled;
  return {id,revision:event.revision,ownerName:(db.prepare('SELECT nickname FROM users WHERE id=?').get(event.owner_id) as {nickname:string}).nickname,isOwner:owner,assisted,canEdit,canRemove:false,removalBlocker:'',values:storedArrangement(event)};
}
function conditionVersion(row:{version:number;snapshot_json:string;summary:string;created_at:string;actor_name:string}){return {version:row.version,arrangement:JSON.parse(row.snapshot_json),summary:row.summary,createdAt:row.created_at,actorName:row.actor_name};}
export function activityConditions(db:DB,id:string,userId:string|null,page:number){
  requireActivityAccess(db,id,userId);const event=eventRow(db,id)!;
  const current=db.prepare('SELECT * FROM event_conditions WHERE event_id=? AND version=?').get(id,event.conditions_version) as Parameters<typeof conditionVersion>[0]|undefined;
  const rows=db.prepare('SELECT * FROM event_conditions WHERE event_id=? ORDER BY version DESC LIMIT 21 OFFSET ?').all(id,(page-1)*20) as Parameters<typeof conditionVersion>[0][];
  const people=userId?db.prepare("SELECT a.id,COALESCE(u.nickname,a.name) AS name,a.status,a.confirmation_state AS confirmationState,a.accepted_conditions_version AS acceptedVersion FROM attendees a LEFT JOIN users u ON u.id=a.user_id LEFT JOIN roster_parties p ON p.id=a.party_id WHERE a.event_id=? AND a.manager_id=? AND a.status IN ('confirmed','waiting','tentative') ORDER BY p.seq,a.seq").all(id,userId):[];
  return {id,revision:event.revision,current:current?conditionVersion(current):{version:event.conditions_version,arrangement:arrangementSnapshot(event),summary:'尚未发布的安排',createdAt:event.created_at,actorName:''},history:rows.slice(0,20).map(conditionVersion),page,hasMore:rows.length>20,canRespond:['scheduled','ongoing'].includes(event.lifecycle)&&!event.archived_at,people};
}
export function registerActivityManagement(app:FastifyInstance,db:DB,security:Security,now:()=>Date,defaults:ActivityBotDefaults={}){
  const bot=createActivityBot(db,now,defaults);
  function optional(request:FastifyRequest,id:string,run:()=>unknown){try{db.transaction(run)();}catch{request.log.error({eventId:id},'Activity bot hook failed; business write preserved');}}
  const hookError=(id:string)=>app.log.error({eventId:id},'Activity promotion bot hook failed; business write preserved');
  function authorize(id:string,userId:string,kind:'arrangement'|'consent',personId?:string){
    requireActivityAccess(db,id,userId);const event=eventRow(db,id)!;
    if(kind==='arrangement')requireSchedule(db,event,userId);else activePerson(db,id,personId!,userId);
    return event;
  }
  function write(request:FastifyRequest,id:string,kind:'arrangement'|'consent',input:unknown,run:(event:EventRow,user:ReturnType<Security['memberWrite']>,stamp:string)=>z.infer<typeof ActivityDraftResult>,personId?:string){
    return db.transaction(()=>{
      const user=security.memberWrite(request),event=authorize(id,user.id,kind,personId),key=z.string().uuid().parse(request.headers['idempotency-key']);
      const signature='activity-management:'+kind+':'+encodeURIComponent(id)+':'+(personId?encodeURIComponent(personId)+':':'')+hash(JSON.stringify(input));
      const old=db.prepare('SELECT signature,response_json FROM request_results WHERE user_id=? AND request_key=?').get(user.id,key) as {signature:string;response_json:string}|undefined;
      if(old){if(old.signature!==signature)throw withApiError(new DomainError('REQUEST_CONFLICT','這個操作編號已用於另一份內容',409));return ActivityDraftResult.parse(JSON.parse(old.response_json));}
      const result=run(event,user,legacyStamp(now()));db.prepare('INSERT INTO request_results VALUES(?,?,?,?,?,?)').run(user.id,key,signature,JSON.stringify(result),200,legacyStamp(now()));return result;
    }).immediate();
  }
  app.get('/api/v2/activities/:id/arrangements',async request=>db.transaction(()=>activityArrangements(db,params.parse(request.params).id,security.scopedMember(request).id))());
  app.get('/api/v2/activities/:id/conditions',async request=>db.transaction(()=>{
    const {page}=PageQuery.parse(request.query);
    return activityConditions(db,params.parse(request.params).id,activityViewer(security,request),page);
  })());
  app.get('/api/v2/activities/management-results/:requestId',async request=>db.transaction(()=>{
    const user=security.scopedMember(request),key=z.string().uuid().parse((request.params as {requestId:string}).requestId);
    const row=db.prepare('SELECT signature,response_json FROM request_results WHERE user_id=? AND request_key=?').get(user.id,key) as {signature:string;response_json:string}|undefined;
    if(!row||!row.signature.startsWith('activity-management:'))return {state:'not_found' as const};
    const [,kind,id,personId]=row.signature.split(':');if(kind!=='arrangement'&&kind!=='consent')return {state:'not_found' as const};
    const result=ActivityDraftResult.parse(JSON.parse(row.response_json));if(decodeURIComponent(id!)!==result.id)throw Error('Invalid activity receipt');
    authorize(result.id,user.id,kind,kind==='consent'?decodeURIComponent(personId!):undefined);return {state:'completed' as const,result};
  })());
  const routeOptions={config:{rateLimit:{max:30,timeWindow:'1 minute'}}};
  app.put('/api/v2/activities/:id/arrangements',routeOptions,async request=>{
    const id=params.parse(request.params).id,input=SaveActivityDraft.parse(request.body);
    return write(request,id,'arrangement',input,(event,user,stamp)=>{
      requireEventRevision(event,input.revision);
      if(!activityArrangements(db,id,user.id).canEdit)throw withApiError(new DomainError('ACTIVITY_LOCKED','活動已結束、取消、歸檔或已有結算，不能重寫安排',409));
      const assisted=event.owner_id!==user.id&&canAssist(db,event,user.id);
      if(assisted&&!input.reason)throw withApiError(new DomainError('ADMIN_REASON_REQUIRED','管理員協助修改活動請填寫原因',400));
      const v=arrangementValues(input.values,now(),false,event),priorWithdrawal=event.withdrawal_deadline||event.deadline;
      const linkedWithdrawal=assisted&&priorWithdrawal===event.deadline&&(v.withdrawalDeadline||v.deadline)===v.deadline;
      if(event.owner_id!==user.id&&(v.botEnabled!==!!event.bot_enabled||v.feePolicy!==event.fee_policy||v.visibility!==event.visibility||((v.withdrawalDeadline||v.deadline)!==priorWithdrawal&&!linkedWithdrawal)))throw withApiError(new DomainError('OWNER_SETTINGS','群同步、費用規則、退出期限及可見性需由發起者修改',403));
      const confirmed=(db.prepare("SELECT count(*) AS n FROM attendees WHERE event_id=? AND status='confirmed'").get(id) as {n:number}).n;
      if(v.capacity&&v.capacity<confirmed)throw withApiError(new DomainError('CAPACITY_BELOW_ROSTER','人數上限低於正式報名人數，請先處理超額人員',409));
      const before=eventSnapshot(event),peopleBefore=activityPeopleSnapshot(db,id);
      const proposed={...event,category:v.category,starts_at:v.startsAt,duration_hours:v.durationHours,location:v.location,description:v.description,withdrawal_deadline:v.withdrawalDeadline,deadline:v.deadline,timezone:v.timezone,fee_policy:v.feePolicy};
      const prior=arrangementSnapshot(event),next=arrangementSnapshot(proposed),changed=fields.filter(field=>prior[field]!==next[field]);
      if(changed.length&&!input.reason&&db.prepare("SELECT 1 FROM attendees WHERE event_id=? AND status IN ('confirmed','waiting','tentative')").get(id))throw withApiError(new DomainError('ARRANGEMENT_REASON_REQUIRED','重要安排變更請填寫原因，參加者需要重新確認',400));
      db.prepare('UPDATE events SET title=?,category=?,location=?,starts_at=?,deadline=?,capacity=?,description=?,duration_hours=?,withdrawal_deadline=?,visibility=?,timezone=?,minimum_participants=?,fee_policy=?,draft_join_owner=?,bot_enabled=? WHERE id=?').run(v.title,v.category,v.location,v.startsAt,v.deadline,v.capacity,v.description,v.durationHours,v.withdrawalDeadline,v.visibility,v.timezone,v.minimumParticipants,v.feePolicy,Number(v.joinOwner),Number(v.botEnabled),id);
      if(changed.length){
        const summary=changed.map(field=>labels[field]).join('、')+'已变更',version=event.conditions_version+1;
        db.prepare('UPDATE events SET conditions_version=?,change_summary=? WHERE id=?').run(version,summary,id);
        db.prepare('INSERT INTO event_conditions(event_id,version,snapshot_json,summary,actor_name,created_at) VALUES(?,?,?,?,?,?)').run(id,version,JSON.stringify(arrangementSnapshot(eventRow(db,id)!)),summary+(input.reason?'：'+input.reason:''),user.nickname,stamp);
        const managers=db.prepare("SELECT DISTINCT manager_id FROM attendees WHERE event_id=? AND status IN ('confirmed','waiting','tentative')").all(id) as {manager_id:string}[];
        db.prepare("UPDATE attendees SET confirmation_state='pending' WHERE event_id=? AND status IN ('confirmed','waiting','tentative')").run(id);
        for(const manager of managers){
          db.prepare("INSERT INTO notifications(user_id,event_id,kind,message,created_at) VALUES(?,?,'conditions_changed',?,?)").run(manager.manager_id,id,v.title+'：'+summary+'，请确认本人及代报名单的安排',stamp);
          optional(request,id,()=>bot.broadcast(eventRow(db,id)!,'conditions_changed'));
        }
      }
      const promoted=rebalanceActivity(db,eventRow(db,id)!,now,defaults,hookError),delta=rosterDelta(peopleBefore,activityPeopleSnapshot(db,id));
      const updated=eventRow(db,id)!;
      const audited=appendEventAudit(db,event,user,assisted?'event_admin_updated':'event_updated',{event:before,participants:delta.prior},{event:eventSnapshot(updated),participants:delta.current},input.reason,stamp);
      if(audited)optional(request,id,()=>bot.arrangementsUpdated(event,promoted));
      if(assisted&&JSON.stringify(before)!==JSON.stringify(eventSnapshot(updated)))db.prepare("INSERT INTO notifications(user_id,event_id,kind,message,created_at) VALUES(?,?,'admin_event_updated',?,?)").run(event.owner_id,id,user.nickname+' 以管理员身份协助修改了「'+updated.title+'」：'+input.reason+'；请查看活动记录核对',stamp);
      return {id,revision:eventRow(db,id)!.revision,removed:false};
    });
  });
  app.post('/api/v2/activities/:id/attendees/:personId/conditions',routeOptions,async request=>{
    const {id,personId}=params.extend({personId:z.string().min(1).max(80)}).parse(request.params),input=RespondActivityConditions.parse(request.body);
    return write(request,id,'consent',input,(event,user,stamp)=>{
      requireEventRevision(event,input.revision);
      if(!['scheduled','ongoing'].includes(event.lifecycle)||event.archived_at)throw withApiError(new DomainError('CONDITIONS_CLOSED','活動已結束、取消或歸檔，不能再確認新安排',409));
      if(input.conditionsVersion!==event.conditions_version)throw withApiError(new DomainError('CONDITIONS_CHANGED','安排又有變更，請載入最新安排再確認',409));
      const person=activePerson(db,id,personId,user.id),decision=input.decision;
      if(person.confirmation_state===decision&&(decision!=='accepted'||person.accepted_conditions_version===event.conditions_version))return {id,revision:event.revision,removed:false};
      const before={person_id:personId,nickname:person.current_name,confirmation:person.confirmation_state,accepted_version:person.accepted_conditions_version};
      const accepted=decision==='accepted'?event.conditions_version:person.accepted_conditions_version;
      db.prepare('UPDATE attendees SET confirmation_state=?,accepted_conditions_version=?,updated_at=? WHERE id=?').run(decision,accepted,stamp,personId);
      db.prepare('INSERT INTO attendee_consents(attendee_id,event_id,version,decision,actor_id,actor_name,reason,created_at) VALUES(?,?,?,?,?,?,?,?)').run(personId,id,event.conditions_version,decision,user.id,user.nickname,input.reason,stamp);
      appendEventAudit(db,event,user,'conditions_response',before,{person_id:personId,nickname:person.current_name,confirmation:decision,accepted_version:accepted},input.reason,stamp);
      if(decision==='declined'){
        db.prepare("INSERT INTO notifications(user_id,event_id,kind,message,created_at) VALUES(?,?,'conditions_declined',?,?)").run(event.owner_id,id,person.current_name+' 暂不同意新安排：'+input.reason+'；原报名及原约定保留，请协调处理',stamp);
        optional(request,id,()=>bot.personal(id,event.owner_id,'conditions_declined'));
      }
      return {id,revision:eventRow(db,id)!.revision,removed:false};
    },personId);
  });
}
