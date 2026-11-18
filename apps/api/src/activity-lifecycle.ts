import { withApiError } from './error-display';
import type { FastifyInstance } from 'fastify';
import type { DB } from '@qgroup/database';
import { ActivityDraftResult, ActivityLifecycleAction, ChangeActivityLifecycle } from '@qgroup/contracts';
import { DomainError } from '@qgroup/domain';
import { botMoment } from '@qgroup/domain';
import { z } from 'zod';
import { hash, type Security } from './security';
import { requireActivityAccess } from './activity-access';
import { appendEventAudit, eventRow, eventScopes, eventSnapshot, legacyStamp, removalBlocker, requireEventRevision, type EventRow } from './activity-arrangements';
import { activityPeopleSnapshot, rebalanceActivity, rosterDelta } from './activity-publish';
import { createActivityBot, type ActivityBotDefaults } from './activity-bot';

type Action=z.infer<typeof ActivityLifecycleAction>;
const actions=ActivityLifecycleAction.options;
const ownerActions=new Set<Action>(['cancel','archive','unarchive','formation','remove']);
function authorize(db:DB,id:string,userId:string,action?:Action){
  const event=eventRow(db,id);
  // A removed activity is visible only to its owner for recovering the removal receipt.
  if(event?.status==='deleted'&&event.owner_id===userId&&(!action||action==='remove'))return event;
  requireActivityAccess(db,id,userId);
  if(action&&!eventScopes(db,event!,userId).has(ownerActions.has(action)?'owner':'schedule'))throw withApiError(new DomainError('ACTIVITY_PERMISSION','沒有這項活動管理權限',403));
  return event!;
}
function blocker(db:DB,event:EventRow,action:Action,now:Date){
  const terminal=['ended','cancelled'].includes(event.lifecycle),draft=event.lifecycle==='draft';
  if(event.status==='deleted')return '活動已移除';
  if(event.archived_at&&!['unarchive','remove'].includes(action))return '請先取消歸檔再修改活動';
  if(action==='remove')return removalBlocker(db,event);
  if(['archive','unarchive'].includes(action))return terminal?'':'只有實際結束或取消的活動可以歸檔';
  if(action==='cancel')return draft?'草稿尚未發布，請從活動草稿編輯':'';
  if(action==='formation'&&event.formation_state==='confirmed')return '';
  if(action==='finish')return draft||event.lifecycle==='cancelled'?'草稿或已取消活動不能標記為結束；取消活動可直接填寫結算':'';
  if(terminal||draft)return '這個活動不能執行這項狀態操作';
  if(['pause','resume'].includes(action)&&db.prepare('SELECT 1 FROM settlements WHERE event_id=?').get(event.id))return '已有結算，不能切換報名狀態';
  if(action==='resume'&&(botMoment(event.deadline,event.timezone)<=now.getTime()||botMoment(event.starts_at,event.timezone)<=now.getTime()))return '報名截止已過，請先調整安排或使用邀請補報名';
  return '';
}
function needsReason(db:DB,event:EventRow,action:Action){return action==='cancel'||(action==='formation'&&event.formation_state!=='confirmed'&&(db.prepare("SELECT count(*) AS n FROM attendees WHERE event_id=? AND status='confirmed'").get(event.id) as {n:number}).n<event.minimum_participants);}
export function activityLifecycle(db:DB,id:string,userId:string,now:Date){
  const event=authorize(db,id,userId),scopes=eventScopes(db,event,userId);
  return {id,title:event.title,revision:event.revision,lifecycle:event.lifecycle,registrationOpen:!!event.registration_open,formationState:event.formation_state,actualStartedAt:event.actual_started_at,actualEndedAt:event.actual_ended_at,archivedAt:event.archived_at,cancellationReason:event.cancellation_reason,removed:event.status==='deleted',actions:actions.filter(action=>scopes.has(ownerActions.has(action)?'owner':'schedule')).map(action=>({action,blockedReason:blocker(db,event,action,now),requiresReason:needsReason(db,event,action)}))};
}
export function registerActivityLifecycle(app:FastifyInstance,db:DB,security:Security,now:()=>Date,defaults:ActivityBotDefaults={}){
  const params=z.object({id:z.string().min(1).max(80)}),bot=createActivityBot(db,now,defaults);
  const hookError=(id:string)=>app.log.error({eventId:id},'Activity lifecycle bot hook failed; business write preserved');
  app.get('/api/v2/activities/:id/lifecycle',async request=>db.transaction(()=>activityLifecycle(db,params.parse(request.params).id,security.scopedMember(request).id,now()))());
  app.get('/api/v2/activities/lifecycle-results/:requestId',async request=>db.transaction(()=>{
    const user=security.scopedMember(request),key=z.string().uuid().parse((request.params as {requestId:string}).requestId);
    const row=db.prepare('SELECT signature,response_json FROM request_results WHERE user_id=? AND request_key=?').get(user.id,key) as {signature:string;response_json:string}|undefined;
    if(!row||!row.signature.startsWith('activity-lifecycle:'))return {state:'not_found' as const};
    const [,id,action]=row.signature.split(':'),result=ActivityDraftResult.parse(JSON.parse(row.response_json));
    if(decodeURIComponent(id!)!==result.id)throw Error('Invalid lifecycle receipt');
    authorize(db,result.id,user.id,ActivityLifecycleAction.parse(action));return {state:'completed' as const,result};
  })());
  app.post('/api/v2/activities/:id/lifecycle',{config:{rateLimit:{max:30,timeWindow:'1 minute'}}},async request=>{
    const id=params.parse(request.params).id,input=ChangeActivityLifecycle.parse(request.body);
    return db.transaction(()=>{
      const user=security.memberWrite(request),event=authorize(db,id,user.id,input.action),key=z.string().uuid().parse(request.headers['idempotency-key']);
      const signature='activity-lifecycle:'+encodeURIComponent(id)+':'+input.action+':'+hash(JSON.stringify(input));
      const old=db.prepare('SELECT signature,response_json FROM request_results WHERE user_id=? AND request_key=?').get(user.id,key) as {signature:string;response_json:string}|undefined;
      if(old){if(old.signature!==signature)throw withApiError(new DomainError('REQUEST_CONFLICT','這個操作編號已用於另一份內容',409));return ActivityDraftResult.parse(JSON.parse(old.response_json));}
      requireEventRevision(event,input.revision);
      const {action,reason}=input,blocked=blocker(db,event,action,now());
      if(blocked)throw new DomainError('LIFECYCLE_BLOCKED',blocked,409);
      if(needsReason(db,event,action)&&!reason)throw withApiError(new DomainError('LIFECYCLE_REASON',action==='cancel'?'請填寫取消原因；原名單和帳務將保留':'尚未達到最低人數，請填寫仍決定成團的原因',400));
      const stamp=legacyStamp(now()),before=eventSnapshot(event),peopleBefore=activityPeopleSnapshot(db,id);
      let notice: {kind:string;message:string}|undefined;
      const noOp=(action==='start'&&event.lifecycle==='ongoing'&&!!event.actual_started_at)||(action==='finish'&&event.lifecycle==='ended')||(action==='cancel'&&event.lifecycle==='cancelled'&&event.cancellation_reason===reason)||(action==='formation'&&event.formation_state==='confirmed');
      if(!noOp){
        if(action==='pause'||action==='resume')db.prepare('UPDATE events SET registration_open=?,status=? WHERE id=?').run(Number(action==='resume'),action==='resume'?'open':'closed',id);
        if(action==='start'){
          db.prepare("UPDATE events SET lifecycle='ongoing',actual_started_at=?,registration_open=0,status='closed' WHERE id=?").run(stamp,id);
          notice={kind:'event_started',message:event.title+' 已开始'};
        }
        if(action==='finish'){
          db.prepare("UPDATE events SET lifecycle='ended',actual_ended_at=?,registration_open=0,status='finished' WHERE id=?").run(stamp,id);
          notice={kind:'event_finished',message:event.title+' 已结束，请核对结算'};
        }
        if(action==='cancel'){
          db.prepare("UPDATE events SET lifecycle='cancelled',registration_open=0,status='cancelled',cancellation_reason=? WHERE id=?").run(reason,id);
          notice={kind:'event_cancelled',message:event.title+' 已取消：'+reason+'；费用与退款以公布的结算为准'};
        }
        if(action==='archive'||action==='unarchive')db.prepare('UPDATE events SET archived_at=? WHERE id=?').run(action==='archive'?stamp:null,id);
        if(action==='formation'){
          db.prepare("UPDATE events SET formation_state='confirmed' WHERE id=?").run(id);
          notice={kind:'formation_confirmed',message:event.title+' 已由发起者确认成团'};
        }
        if(action==='remove'){
          db.prepare("UPDATE events SET status='deleted',registration_open=0,bot_enabled=0 WHERE id=?").run(id);
          db.prepare("UPDATE bot_outbox SET status='skipped',last_error='活动已删除' WHERE event_id=? AND status IN ('pending','sending')").run(id);
        }
        if(notice){
          const targets=db.prepare("SELECT manager_id AS id FROM attendees WHERE event_id=? AND status!='withdrawn' UNION SELECT user_id AS id FROM event_roles WHERE event_id=? ORDER BY id").all(id,id) as {id:string}[];
          for(const target of targets)db.prepare('INSERT INTO notifications(user_id,event_id,kind,message,created_at) VALUES(?,?,?,?,?)').run(target.id,id,notice.kind,notice.message,stamp);
        }
        const promoted=rebalanceActivity(db,eventRow(db,id)!,now,defaults,hookError),delta=rosterDelta(peopleBefore,activityPeopleSnapshot(db,id));
        const changed=appendEventAudit(db,event,user,'event_'+action,{event:before,participants:delta.prior},{event:eventSnapshot(eventRow(db,id)!),participants:delta.current},reason,stamp);
        if(changed)try{db.transaction(()=>bot.lifecycleUpdated(id,action,promoted))();}catch{hookError(id);}
      }
      const result={id,revision:eventRow(db,id)!.revision,removed:action==='remove'};
      db.prepare('INSERT INTO request_results VALUES(?,?,?,?,?,?)').run(user.id,key,signature,JSON.stringify(result),200,stamp);return result;
    }).immediate();
  });
}
