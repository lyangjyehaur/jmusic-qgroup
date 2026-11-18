import { withApiError } from './error-display';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DB } from '@qgroup/database';
import { AddOnsite, AttendanceResult, ChangeAttendance } from '@qgroup/contracts';
import { activityState, DomainError } from '@qgroup/domain';
import { z } from 'zod';
import { hash, type Security } from './security';
import { requireActivityAccess } from './activity-access';
import { activityDate, appendEventAudit, arrangementSnapshot, eventRow, eventScopes, legacyStamp, requireEventRevision, type EventRow } from './activity-arrangements';
import { activityPeople, activityPeopleSnapshot, rosterDelta } from './activity-publish';
import { createActivityBot, type ActivityBotDefaults } from './activity-bot';
type User={id:string;nickname:string};
function observationBlocker(event:EventRow,now:Date){return !['ongoing','ended','cancelled'].includes(activityState(event,now).phase)||event.archived_at?'活動開始後才能核對出席；歸檔後請先取消歸檔':'';}
function onsiteBlocker(db:DB,event:EventRow,now:Date){if(!['ongoing','ended'].includes(activityState(event,now).phase)||event.archived_at)return '只有進行中或已結束待核對的活動可以現場補錄';return db.prepare('SELECT 1 FROM settlements WHERE event_id=?').get(event.id)?'已有結算，不能補錄正式名額；請先按結算流程核對':'';}
export function registerActivityAttendance(app:FastifyInstance,db:DB,security:Security,now:()=>Date,defaults:ActivityBotDefaults={}){
  const params=z.object({id:z.string().min(1).max(80)}),personParams=params.extend({personId:z.string().min(1).max(80)}),bot=createActivityBot(db,now,defaults),routeOptions={config:{rateLimit:{max:30,timeWindow:'1 minute'}}};
  function authorize(id:string,user:User,onsite=false){requireActivityAccess(db,id,user.id);const event=eventRow(db,id)!,scopes=eventScopes(db,event,user.id);if(!scopes.has('attendance')||(onsite&&!scopes.has('roster')))throw withApiError(new DomainError('ATTENDANCE_PERMISSION',onsite?'現場補錄需要名單及出席管理權限':'沒有出席管理權限',403));return event;}
  function record(event:EventRow,user:User,action:string,before:ReturnType<typeof activityPeopleSnapshot>,reason:string,stamp:string){const delta=rosterDelta(before,activityPeopleSnapshot(db,event.id));if(appendEventAudit(db,event,user,action,{participants:delta.prior},{participants:delta.current},reason,stamp))try{db.transaction(()=>bot.rosterUpdated(event.id,action,delta.prior as {id:string;status:string}[],delta.current as {id:string;status:string}[]))();}catch{app.log.error({eventId:event.id},'Attendance bot hook failed; business write preserved');}}
  function write(request:FastifyRequest,id:string,personId:string|null,input:unknown,run:(event:EventRow,user:User,stamp:string)=>void){
    return db.transaction(()=>{const user=security.memberWrite(request),event=authorize(id,user,!personId),key=z.string().uuid().parse(request.headers['idempotency-key']),signature='activity-attendance:'+encodeURIComponent(id)+':'+(personId?encodeURIComponent(personId):'onsite')+':'+hash(JSON.stringify(input));
      const old=db.prepare('SELECT signature,response_json FROM request_results WHERE user_id=? AND request_key=?').get(user.id,key) as {signature:string;response_json:string}|undefined;if(old){if(signature!==old.signature)throw withApiError(new DomainError('REQUEST_CONFLICT','這個操作編號已用於另一份內容',409));return AttendanceResult.parse(JSON.parse(old.response_json));}
      run(event,user,legacyStamp(now()));const result={id,revision:eventRow(db,id)!.revision};db.prepare('INSERT INTO request_results VALUES(?,?,?,?,?,?)').run(user.id,key,signature,JSON.stringify(result),200,legacyStamp(now()));return result;
    }).immediate();
  }
  app.get('/api/v2/activities/:id/attendance',async request=>db.transaction(()=>{
    const {id}=params.parse(request.params),user=security.scopedMember(request),event=authorize(id,user),people=activityPeople(db,id),scopes=eventScopes(db,event,user.id),observation=observationBlocker(event,now()),onsite=onsiteBlocker(db,event,now()),phase=activityState(event,now()).phase;
    return {id,title:event.title,revision:event.revision,conditionsVersion:event.conditions_version,arrangement:arrangementSnapshot(event),phase,serverTime:legacyStamp(now()),canObserve:!observation,canAdd:scopes.has('roster')&&!onsite,observationBlocker:observation,onsiteBlocker:!scopes.has('roster')?'現場補錄另需名單管理權限':onsite,reasonRequired:['ended','cancelled'].includes(phase),nickname:user.nickname,selfRegistered:people.some(person=>person.user_id===user.id&&person.status!=='withdrawn'),capacity:event.capacity,confirmed:people.filter(person=>person.status==='confirmed').length,waiting:people.filter(person=>person.status==='waiting').length,people:people.filter(person=>person.status==='confirmed'||person.attendance!=='unknown').map(person=>{const origin=db.prepare('SELECT payer_name FROM attendee_payment_origins WHERE attendee_id=?').get(person.id) as {payer_name:string}|undefined;return {id:person.id,name:person.nickname,status:person.status,isGuest:!person.user_id,payerKind:person.payer_kind,payerName:origin?.payer_name??(person.payer_kind==='self'?person.nickname:person.manager_name),attendance:person.attendance,note:person.attendance_note,arrivedAt:person.arrived_at,leftAt:person.left_at};})};
  })());
  app.post('/api/v2/activities/:id/attendance/:personId',routeOptions,async request=>{
    const {id,personId}=personParams.parse(request.params),input=ChangeAttendance.parse(request.body);
    return write(request,id,personId,input,(event,user,stamp)=>{
      requireEventRevision(event,input.revision);const blocker=observationBlocker(event,now());if(blocker)throw new DomainError('ATTENDANCE_LOCKED',blocker,409);
      const person=activityPeople(db,id).find(person=>person.id===personId);if(!person||(person.status!=='confirmed'&&person.attendance==='unknown'))throw withApiError(new DomainError('ATTENDANCE_PERSON','請先確認正式名額，臨時加入請使用現場補錄',409));
      if(['ended','cancelled'].includes(activityState(event,now()).phase)&&!input.reason)throw withApiError(new DomainError('ATTENDANCE_REASON','活動已結束或取消，更正出席時請填寫原因',400));
      const arrived=input.arrivedAt?activityDate(input.arrivedAt):null,left=input.leftAt?activityDate(input.leftAt):null;
      if((arrived&&Date.parse(arrived)>now().getTime())||(left&&Date.parse(left)>now().getTime())||(arrived&&left&&left<arrived))throw withApiError(new DomainError('ATTENDANCE_TIME','實際到離場時間不能在將來，離場不能早於到場',400));
      if(['unknown','absent'].includes(input.attendance)&&(arrived||left))throw withApiError(new DomainError('ATTENDANCE_TIME','未核對或缺席狀態不能填寫到離場時間',400));
      const before=activityPeopleSnapshot(db,id);if(input.attendance!==person.attendance||input.note!==person.attendance_note||arrived!==person.arrived_at||left!==person.left_at)db.prepare('UPDATE attendees SET attendance=?,attendance_note=?,arrived_at=?,left_at=?,updated_at=? WHERE id=?').run(input.attendance,input.note,arrived,left,stamp,personId);
      record(event,user,'attendance_updated',before,input.reason,stamp);
    });
  });
  app.post('/api/v2/activities/:id/onsite',routeOptions,async request=>{
    const {id}=params.parse(request.params),input=AddOnsite.parse(request.body);
    return write(request,id,null,input,(event,user,stamp)=>{
      requireEventRevision(event,input.revision);const blocker=onsiteBlocker(db,event,now());if(blocker)throw new DomainError('ONSITE_LOCKED',blocker,409);
      if(input.conditionsVersion!==event.conditions_version)throw withApiError(new DomainError('CONDITIONS_CHANGED','請載入最新安排並確認現場人員已接受目前費用規則',409));
      const existing=activityPeople(db,id),people=input.people.map(person=>{if(person.isSelf&&existing.some(row=>row.user_id===user.id&&row.status!=='withdrawn'))throw withApiError(new DomainError('ALREADY_REGISTERED','你已報名或待確認，請管理現有報名',409));if((!person.isSelf&&!person.name)||(person.isSelf&&person.payerKind!=='self'))throw withApiError(new DomainError('INVALID_REGISTRATION','請填寫現場參加者稱呼及正確的付款歸屬',400));return {...person,name:person.isSelf?user.nickname:person.name};});
      if(event.capacity&&existing.filter(row=>row.status==='confirmed').length+people.length>event.capacity&&!input.allowOverCapacity)throw withApiError(new DomainError('ONSITE_CAPACITY','補錄會超過人數上限，請明確確認超額名額',409));
      if(existing.some(row=>row.status==='waiting')&&!input.overrideWaitlist)throw withApiError(new DomainError('ONSITE_WAITLIST','仍有候補，請先協調並明確確認本次現場補錄不按原候補排隊',409));
      const before=activityPeopleSnapshot(db,id),party=randomBytes(8).toString('hex');db.prepare("INSERT INTO roster_parties(id,event_id,manager_id,queue_mode,created_at) VALUES(?,?,?,'individual',?)").run(party,id,user.id,stamp);
      for(const person of people){const personId=randomBytes(8).toString('hex');db.prepare("INSERT INTO attendees(id,event_id,manager_id,user_id,party_id,name,note,payer_kind,status,attendance,created_at,updated_at,accepted_conditions_version,confirmation_state) VALUES(?,?,?,?,?,?,?,?,'confirmed','present',?,?,?,'accepted')").run(personId,id,user.id,person.isSelf?user.id:null,party,person.name,person.note,person.payerKind,stamp,stamp,event.conditions_version);db.prepare("INSERT INTO attendee_consents(attendee_id,event_id,version,decision,actor_id,actor_name,reason,created_at) VALUES(?,?,?,'accepted',?,?,'报名时接受当前安排',?)").run(personId,id,event.conditions_version,user.id,user.nickname,stamp);}
      record(event,user,'onsite_added',before,input.reason,stamp);
    });
  });
}
