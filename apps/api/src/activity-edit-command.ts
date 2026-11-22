import type { DB } from '@qgroup/database';
import type { z } from 'zod';
import type { ActivityArrangementInput } from '@qgroup/contracts';
import { DomainError } from '@qgroup/domain';
import { withApiError } from './error-display';
import { appendEventAudit, arrangementSnapshot, validateArrangementValues, eventRow, eventScopes, eventSnapshot, legacyStamp, type EventRow } from './activity-arrangements';
import { activityPeopleSnapshot, rebalanceActivity, rosterDelta } from './activity-publish';
import { createActivityBot, type ActivityBotDefaults } from './activity-bot';
const fields=['category','starts_at','duration_hours','location','description','withdrawal_deadline','timezone','fee_policy'] as const;
const labels={category:'类型',starts_at:'时间',duration_hours:'时长',location:'地点',description:'注意事项',withdrawal_deadline:'退出期限',timezone:'时区',fee_policy:'费用规则'};
export function canAssistActivitySchedule(db:DB,event:EventRow,userId:string){return ['scheduled','ongoing'].includes(event.lifecycle)&&!event.archived_at&&!!db.prepare('SELECT 1 FROM user_admin_roles WHERE user_id=? AND is_admin=1 AND NOT EXISTS(SELECT 1 FROM privacy_requests WHERE user_id=?)').get(userId,userId);}
export function requireActivitySchedule(db:DB,event:EventRow,userId:string){
  if(!eventScopes(db,event,userId).has('schedule')&&!canAssistActivitySchedule(db,event,userId))throw withApiError(new DomainError('ACTIVITY_PERMISSION','沒有這項活動管理權限',403));
}

export function prepareActivityEdit(db:DB,event:EventRow,user:{id:string;nickname:string},values:z.infer<typeof ActivityArrangementInput>,reason:string,time:Date,assistedOverride?:boolean){
  const id=event.id;requireActivitySchedule(db,event,user.id);
  if(['ended','cancelled'].includes(event.lifecycle)||event.archived_at||db.prepare('SELECT 1 FROM settlements WHERE event_id=?').get(id))throw withApiError(new DomainError('ACTIVITY_LOCKED','活動已結束、取消、歸檔或已有結算，不能重寫安排',409));
  const assisted=assistedOverride??(event.owner_id!==user.id&&canAssistActivitySchedule(db,event,user.id));
  if(assisted&&!reason)throw withApiError(new DomainError('ADMIN_REASON_REQUIRED','管理員協助修改活動請填寫原因',400));
  const v=validateArrangementValues({...values},time,event.lifecycle==='draft',event),priorWithdrawal=event.withdrawal_deadline||event.deadline;
  const linkedWithdrawal=assisted&&priorWithdrawal===event.deadline&&(v.withdrawalDeadline||v.deadline)===v.deadline;
  if(event.owner_id!==user.id&&(v.botEnabled!==!!event.bot_enabled||v.feePolicy!==event.fee_policy||v.visibility!==event.visibility||((v.withdrawalDeadline||v.deadline)!==priorWithdrawal&&!linkedWithdrawal)))throw withApiError(new DomainError('OWNER_SETTINGS','群同步、費用規則、退出期限及可見性需由發起者修改',403));
  const confirmed=(db.prepare("SELECT count(*) AS n FROM attendees WHERE event_id=? AND status='confirmed'").get(id) as {n:number}).n;
  if(v.capacity&&v.capacity<confirmed)throw withApiError(new DomainError('CAPACITY_BELOW_ROSTER','人數上限低於正式報名人數，請先處理超額人員',409));
  
  const proposed={...event,category:v.category,starts_at:v.startsAt,duration_hours:v.durationHours,location:v.location,description:v.description,withdrawal_deadline:v.withdrawalDeadline,deadline:v.deadline,timezone:v.timezone,fee_policy:v.feePolicy};
  const prior=arrangementSnapshot(event),next=arrangementSnapshot(proposed),changed=fields.filter(field=>prior[field]!==next[field]);
  if(changed.length&&!reason&&db.prepare("SELECT 1 FROM attendees WHERE event_id=? AND status IN ('confirmed','waiting','tentative')").get(id))throw withApiError(new DomainError('ARRANGEMENT_REASON_REQUIRED','重要安排變更請填寫原因，參加者需要重新確認',400));

  return {event,v,assisted,changed,reason};
}
export function executeActivityEdit(db:DB,plan:ReturnType<typeof prepareActivityEdit>,user:{id:string;nickname:string},time:Date,defaults:ActivityBotDefaults,hookError:(id:string)=>void,nativeDraftAudit=false,originalAction:string|null=null){
  const {event,v,assisted,changed,reason}=plan,id=event.id,stamp=legacyStamp(time),before=eventSnapshot(event),peopleBefore=activityPeopleSnapshot(db,id),bot=createActivityBot(db,()=>time,defaults);
  const hook=(work:()=>unknown)=>{try{db.transaction(work)();}catch{hookError(id);}};
  db.prepare('UPDATE events SET title=?,category=?,location=?,starts_at=?,deadline=?,capacity=?,description=?,duration_hours=?,withdrawal_deadline=?,visibility=?,timezone=?,minimum_participants=?,fee_policy=?,draft_join_owner=?,bot_enabled=? WHERE id=?').run(v.title,v.category,v.location,v.startsAt,v.deadline,v.capacity,v.description,v.durationHours,v.withdrawalDeadline,v.visibility,v.timezone,v.minimumParticipants,v.feePolicy,Number(v.joinOwner),Number(v.botEnabled),id);
  if(changed.length&&event.lifecycle!=='draft'){
    const summary=changed.map(field=>labels[field]).join('、')+'已变更',version=event.conditions_version+1;
    db.prepare('UPDATE events SET conditions_version=?,change_summary=? WHERE id=?').run(version,summary,id);
    db.prepare('INSERT INTO event_conditions(event_id,version,snapshot_json,summary,actor_name,created_at) VALUES(?,?,?,?,?,?)').run(id,version,JSON.stringify(arrangementSnapshot(eventRow(db,id)!)),summary+(reason?'：'+reason:''),user.nickname,stamp);
    const managers=db.prepare("SELECT DISTINCT manager_id FROM attendees WHERE event_id=? AND status IN ('confirmed','waiting','tentative')").all(id) as {manager_id:string}[];
    db.prepare("UPDATE attendees SET confirmation_state='pending' WHERE event_id=? AND status IN ('confirmed','waiting','tentative')").run(id);
    for(const manager of managers){
      db.prepare("INSERT INTO notifications(user_id,event_id,kind,message,created_at) VALUES(?,?,'conditions_changed',?,?)").run(manager.manager_id,id,v.title+'：'+summary+'，请确认本人及代报名单的安排',stamp);
      hook(()=>bot.broadcast(eventRow(db,id)!,'conditions_changed'));
    }
  }
  const promoted=rebalanceActivity(db,eventRow(db,id)!,()=>time,defaults,hookError),delta=rosterDelta(peopleBefore,activityPeopleSnapshot(db,id));
  const updated=eventRow(db,id)!;
  const audited=appendEventAudit(db,event,user,assisted?'event_admin_updated':'event_'+(originalAction||'updated'),{event:before,participants:delta.prior,...(nativeDraftAudit&&event.lifecycle==='draft'?{draft_join_owner:event.draft_join_owner}:{})},{event:eventSnapshot(updated),participants:delta.current,...(nativeDraftAudit&&event.lifecycle==='draft'?{draft_join_owner:updated.draft_join_owner}:{})},reason,stamp);
  if(audited)hook(()=>bot.arrangementsUpdated(event,promoted));
  if(assisted&&JSON.stringify(before)!==JSON.stringify(eventSnapshot(updated)))db.prepare("INSERT INTO notifications(user_id,event_id,kind,message,created_at) VALUES(?,?,'admin_event_updated',?,?)").run(event.owner_id,id,user.nickname+' 以管理员身份协助修改了「'+updated.title+'」：'+reason+'；请查看活动记录核对',stamp);

  return {id,revision:eventRow(db,id)!.revision,removed:false};
}
