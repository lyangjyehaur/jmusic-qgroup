import { withApiError } from './error-display';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DB } from '@qgroup/database';
import { ActivityDraftResult, ChangeRegistration, PreviewRegistration, SubmitRegistration } from '@qgroup/contracts';
import { activityState, botMoment, DomainError } from '@qgroup/domain';
import { z } from 'zod';
import { hash, type Security } from './security';
import { requireActivityAccess } from './activity-access';
import { appendEventAudit, arrangementSnapshot, eventRow, eventScopes, legacyStamp, requireEventRevision, type EventRow } from './activity-arrangements';
import { activityPeople, activityPeopleSnapshot, allocateActivity, rebalanceActivity, rosterDelta } from './activity-publish';
import { createActivityBot, type ActivityBotDefaults } from './activity-bot';
type User={id:string;nickname:string};
type Person=ReturnType<typeof activityPeople>[number];
export function mutableBlocker(db:DB,event:EventRow){
  if(db.prepare('SELECT 1 FROM settlements WHERE event_id=?').get(event.id))return '活動已有結算，不能改動報名名單';
  return ['draft','ended','cancelled'].includes(event.lifecycle)||event.archived_at||event.status==='deleted'?'這個活動已結束、取消、歸檔或尚未發布':'';
}
export function ensureMutable(db:DB,event:EventRow){const message=mutableBlocker(db,event);if(message)throw new DomainError('ROSTER_LOCKED',message,409);}
function lookup(db:DB,event:EventRow,id:string){const person=activityPeople(db,event.id).find(row=>row.id===id);if(!person)throw withApiError(new DomainError('ATTENDEE_NOT_FOUND','這條報名不存在或已退出',404));return person;}
function canManage(db:DB,event:EventRow,person:Person,userId:string){return person.manager_id===userId||eventScopes(db,event,userId).has('roster');}
function authorize(db:DB,id:string,userId:string,personId?:string){
  requireActivityAccess(db,id,userId);const event=eventRow(db,id)!;
  if(personId&&!canManage(db,event,lookup(db,event,personId),userId))throw withApiError(new DomainError('ROSTER_PERMISSION','只能管理本人或由你代報的人員',403));
  return event;
}
/** Match the old preview digest's sorted, non-ASCII-escaped Python JSON. */
function pythonJSON(value:unknown):string{
  if(Array.isArray(value))return '['+value.map(pythonJSON).join(', ')+']';
  if(typeof value==='object'&&value!==null)return '{'+Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,v])=>JSON.stringify(key)+': '+pythonJSON(v)).join(', ')+'}';
  return JSON.stringify(value);
}
export function prepareRegistration(db:DB,event:EventRow,user:User,input:z.infer<typeof PreviewRegistration>,now:Date){
  if(!activityState(event,now).registrationOpen)throw withApiError(new DomainError('SIGNUP_CLOSED','這個活動已停止報名',409));
  const people=input.people.map(person=>{
    if(person.isSelf&&db.prepare("SELECT 1 FROM attendees WHERE event_id=? AND user_id=? AND status!='withdrawn'").get(event.id,user.id))throw withApiError(new DomainError('ALREADY_REGISTERED','你已報名或待確認，請管理現有報名',409));
    if((!person.isSelf&&!person.name)||(person.isSelf&&person.payerKind!=='self'))throw withApiError(new DomainError('INVALID_REGISTRATION','請填寫同行稱呼及正確的付款歸屬',400));
    return {is_self:person.isSelf,name:person.isSelf?user.nickname:person.name,note:person.note,payer_kind:person.payerKind};
  });
  const ids=people.map((_,index)=>String(index)),assignment=allocateActivity(activityPeople(db,event.id),event.capacity,ids,input.queueMode);
  const statuses=ids.map(id=>input.intent==='tentative'?'tentative' as const:assignment.get(id)!);
  const token=hash(pythonJSON([event.id,event.revision,people,input.queueMode,input.intent,statuses]));
  return {people,statuses,preview:{revision:event.revision,conditionsVersion:event.conditions_version,token,allocation:people.map((person,index)=>({name:person.name,status:statuses[index]!}))}};
}
export function registrationContext(db:DB,id:string,user:User,now:Date){
  const event=authorize(db,id,user.id),rosterScope=eventScopes(db,event,user.id).has('roster'),blocked=mutableBlocker(db,event),open=activityState(event,now).registrationOpen;
  return {id,title:event.title,revision:event.revision,nickname:user.nickname,conditionsVersion:event.conditions_version,arrangement:arrangementSnapshot(event),signupBlocker:blocked||(!open?'這個活動已停止報名':''),selfRegistered:!!db.prepare("SELECT 1 FROM attendees WHERE event_id=? AND user_id=? AND status!='withdrawn'").get(id,user.id),people:activityPeople(db,id).filter(person=>person.status!=='withdrawn'&&canManage(db,event,person,user.id)).map(person=>{
    const origin=db.prepare('SELECT payer_name FROM attendee_payment_origins WHERE attendee_id=?').get(person.id) as {payer_name:string}|undefined;
    const other=person.manager_id!==user.id;
    return {id:person.id,name:person.nickname,isGuest:!person.user_id,isMe:person.user_id===user.id,managedByMe:!other,note:person.note,payerKind:person.payer_kind,payerName:origin?.payer_name??(person.payer_kind==='self'?person.nickname:person.manager_name),paymentLocked:!!origin,status:person.status,queueMode:person.queue_mode,withdrawalRequested:!!person.withdrawal_requested,withdrawalReason:person.withdrawal_reason,needsWithdrawalRequest:person.status==='confirmed'&&!(rosterScope&&other)&&botMoment(event.withdrawal_deadline||event.deadline,event.timezone)<=now.getTime(),canChange:!blocked&&open,canWithdraw:!blocked,canDecide:!blocked&&rosterScope&&!!person.withdrawal_requested,requiresReason:other};
  })};
}
export function registerActivityRegistration(app:FastifyInstance,db:DB,security:Security,now:()=>Date,defaults:ActivityBotDefaults={}){
  const params=z.object({id:z.string().min(1).max(80)}),personParams=params.extend({personId:z.string().min(1).max(80)}),bot=createActivityBot(db,now,defaults);
  const hookError=(eventId:string)=>app.log.error({eventId},'Registration bot hook failed; business write preserved');
  function optional(id:string,run:()=>unknown){try{db.transaction(run)();}catch{hookError(id);}}
  function notify(id:string,userId:string,kind:'withdrawal_request'|'withdrawal_decision'|'removed',message:string,stamp:string){db.prepare('INSERT INTO notifications(user_id,event_id,kind,message,created_at) VALUES(?,?,?,?,?)').run(userId,id,kind,message,stamp);optional(id,()=>bot.personal(id,userId,kind));}
  function record(event:EventRow,user:User,action:string,before:ReturnType<typeof activityPeopleSnapshot>,reason:string,stamp:string){
    const delta=rosterDelta(before,activityPeopleSnapshot(db,event.id));
    const changed=appendEventAudit(db,event,user,action,{participants:delta.prior},{participants:delta.current},reason,stamp);
    if(changed)optional(event.id,()=>bot.rosterUpdated(event.id,action,delta.prior as {id:string;status:string}[],delta.current as {id:string;status:string}[]));
  }
  function write(request:FastifyRequest,id:string,action:string,input:unknown,run:(event:EventRow,user:User,stamp:string)=>void,personId?:string){
    return db.transaction(()=>{
      const user=security.memberWrite(request),event=authorize(db,id,user.id,personId),key=z.string().uuid().parse(request.headers['idempotency-key']);
      const signature='activity-registration:'+encodeURIComponent(id)+':'+(personId?encodeURIComponent(personId):'')+':'+action+':'+hash(JSON.stringify(input));
      if((action==='approve'||action==='reject')&&!eventScopes(db,event,user.id).has('roster'))throw withApiError(new DomainError('ROSTER_PERMISSION','沒有退出審核權限',403));
      const old=db.prepare('SELECT signature,response_json FROM request_results WHERE user_id=? AND request_key=?').get(user.id,key) as {signature:string;response_json:string}|undefined;
      if(old){if(old.signature!==signature)throw withApiError(new DomainError('REQUEST_CONFLICT','這個操作編號已用於另一份內容',409));return ActivityDraftResult.parse(JSON.parse(old.response_json));}
      run(event,user,legacyStamp(now()));const result={id,revision:eventRow(db,id)!.revision,removed:false};
      db.prepare('INSERT INTO request_results VALUES(?,?,?,?,?,?)').run(user.id,key,signature,JSON.stringify(result),200,legacyStamp(now()));return result;
    }).immediate();
  }
  app.get('/api/v2/activities/:id/registration',async request=>db.transaction(()=>registrationContext(db,params.parse(request.params).id,security.scopedMember(request),now()))());
  app.get('/api/v2/activities/registration-results/:requestId',async request=>db.transaction(()=>{
    const user=security.scopedMember(request),key=z.string().uuid().parse((request.params as {requestId:string}).requestId),row=db.prepare('SELECT signature,response_json FROM request_results WHERE user_id=? AND request_key=?').get(user.id,key) as {signature:string;response_json:string}|undefined;
    if(!row||!row.signature.startsWith('activity-registration:'))return {state:'not_found' as const};
    const [,id,personId,action]=row.signature.split(':'),result=ActivityDraftResult.parse(JSON.parse(row.response_json));if(decodeURIComponent(id!)!==result.id)throw Error('Invalid registration receipt');
    const event=authorize(db,result.id,user.id,personId?decodeURIComponent(personId):undefined);
    if((action==='approve'||action==='reject')&&!eventScopes(db,event,user.id).has('roster'))throw withApiError(new DomainError('ROSTER_PERMISSION','沒有退出審核權限',403));
    return {state:'completed' as const,result};
  })());
  const routeOptions={config:{rateLimit:{max:30,timeWindow:'1 minute'}}};
  app.post('/api/v2/activities/:id/registration/preview',routeOptions,async request=>db.transaction(()=>{
    const user=security.memberWrite(request),id=params.parse(request.params).id,event=authorize(db,id,user.id),input=PreviewRegistration.parse(request.body);requireEventRevision(event,input.revision);return prepareRegistration(db,event,user,input,now()).preview;
  })());
  app.post('/api/v2/activities/:id/registration',routeOptions,async request=>{
    const id=params.parse(request.params).id,input=SubmitRegistration.parse(request.body);
    return write(request,id,'signup',input,(event,user,stamp)=>{
      requireEventRevision(event,input.revision);ensureMutable(db,event);
      if(input.conditionsVersion!==event.conditions_version)throw withApiError(new DomainError('CONDITIONS_CHANGED','安排已有變更，請重新預覽並確認',409));
      const {people,statuses,preview}=prepareRegistration(db,event,user,input,now());
      if(input.previewToken!==preview.token)throw withApiError(new DomainError('PREVIEW_CHANGED','報名預覽已有變化，請重新預覽並確認',409));
      if(statuses.includes('confirmed')&&statuses.includes('waiting')&&!input.acceptPartial)throw withApiError(new DomainError('PARTIAL_CONFIRM','部分人需要候補，請明確接受部分候補或改為整組排隊',409));
      const before=activityPeopleSnapshot(db,id),party=randomBytes(8).toString('hex');
      db.prepare('INSERT INTO roster_parties(id,event_id,manager_id,queue_mode,created_at) VALUES(?,?,?,?,?)').run(party,id,user.id,input.queueMode,stamp);
      people.forEach((person,index)=>{
        const personId=randomBytes(8).toString('hex');db.prepare('INSERT INTO attendees(id,event_id,manager_id,user_id,party_id,name,note,payer_kind,status,created_at,updated_at,accepted_conditions_version,confirmation_state) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(personId,id,user.id,person.is_self?user.id:null,party,person.name,person.note,person.payer_kind,statuses[index],stamp,stamp,event.conditions_version,'accepted');
        db.prepare("INSERT INTO attendee_consents(attendee_id,event_id,version,decision,actor_id,actor_name,reason,created_at) VALUES(?,?,?,'accepted',?,?,'报名时接受当前安排',?)").run(personId,id,event.conditions_version,user.id,user.nickname,stamp);
      });
      db.prepare('INSERT OR IGNORE INTO event_access VALUES(?,?,?)').run(id,user.id,stamp);rebalanceActivity(db,event,now,defaults,hookError);record(event,user,'signup',before,'',stamp);
    });
  });
  app.post('/api/v2/activities/:id/attendees/:personId/registration',routeOptions,async request=>{
    const {id,personId}=personParams.parse(request.params),input=ChangeRegistration.parse(request.body);
    // Decision scope must precede receipt replay as well as the actual write.
    return write(request,id,input.action,input,(event,user,stamp)=>{
      requireEventRevision(event,input.revision);ensureMutable(db,event);const person=lookup(db,event,personId);if(person.status==='withdrawn')throw withApiError(new DomainError('ATTENDEE_NOT_FOUND','這條報名不存在或已退出',404));
      const before=activityPeopleSnapshot(db,id),rosterScope=eventScopes(db,event,user.id).has('roster'),{action,reason}=input;
      if(['edit','confirm','split'].includes(action)){
        if(!activityState(event,now()).registrationOpen)throw withApiError(new DomainError('SIGNUP_CLOSED','報名已截止；如需退出，請提交退出申請',409));
        if(person.manager_id!==user.id&&!reason)throw withApiError(new DomainError('ROSTER_REASON','管理其他人的報名時請填寫原因',400));
        if(action==='confirm'){
          if(person.status!=='tentative')throw withApiError(new DomainError('NOT_TENTATIVE','只有待確認人員可以確認參加',409));
          const party=randomBytes(8).toString('hex');db.prepare('INSERT INTO roster_parties(id,event_id,manager_id,queue_mode,created_at) VALUES(?,?,?,?,?)').run(party,id,person.manager_id,person.queue_mode||'individual',stamp);
          if(person.queue_mode==='together')db.prepare("UPDATE attendees SET status='waiting',party_id=?,updated_at=? WHERE party_id=? AND status='tentative'").run(party,stamp,person.party_id);
          else db.prepare("UPDATE attendees SET status='waiting',party_id=?,updated_at=? WHERE id=?").run(party,stamp,personId);
          rebalanceActivity(db,event,now,defaults,hookError);
        }else if(action==='split'){
          if(person.status!=='waiting'||person.queue_mode!=='together')throw withApiError(new DomainError('NOT_TOGETHER_WAITING','只有整組候補可以改為分開排隊',409));
          db.prepare("UPDATE roster_parties SET queue_mode='individual' WHERE id=?").run(person.party_id);rebalanceActivity(db,event,now,defaults,hookError);
        }else{
          const origin=!!db.prepare('SELECT 1 FROM attendee_payment_origins WHERE attendee_id=?').get(personId),name=person.user_id?person.name:input.name;
          if(!name||(person.user_id&&input.payerKind!=='self'&&!origin))throw withApiError(new DomainError('INVALID_PAYER','請填寫同行稱呼及正確的付款歸屬',400));
          if(origin&&input.payerKind!==person.payer_kind)throw withApiError(new DomainError('PAYMENT_LOCKED','認領保留原付款責任；更改請在結算中核對並留版本',409));
          if(name!==person.name||input.note!==person.note||input.payerKind!==person.payer_kind)db.prepare('UPDATE attendees SET name=?,note=?,payer_kind=?,updated_at=? WHERE id=?').run(name,input.note,input.payerKind,stamp,personId);
        }
        record(event,user,'attendee_'+action,before,reason,stamp);return;
      }
      if(action==='approve'||action==='reject'){
        if(!rosterScope||!person.withdrawal_requested)throw withApiError(new DomainError('NO_WITHDRAWAL_REQUEST','只有名單管理者可以處理待審核的退出申請',403));
        if(!reason)throw withApiError(new DomainError('ROSTER_REASON','請填寫退出審核原因',400));
        if(action==='reject')db.prepare('UPDATE attendees SET withdrawal_requested=0,withdrawal_reason=?,updated_at=? WHERE id=?').run(reason,stamp,personId);
        else{db.prepare("UPDATE attendees SET status='withdrawn',withdrawal_requested=0,updated_at=? WHERE id=?").run(stamp,personId);rebalanceActivity(db,event,now,defaults,hookError);}
        notify(id,person.manager_id,'withdrawal_decision',person.nickname+' 的退出申请已'+(action==='approve'?'同意':'拒绝')+'：'+reason,stamp);record(event,user,'withdrawal_'+action,before,reason,stamp);return;
      }
      if(rosterScope&&person.manager_id!==user.id){
        if(!reason)throw withApiError(new DomainError('ROSTER_REASON','撤銷他人報名時請填寫原因',400));
        notify(id,person.manager_id,'removed',person.nickname+' 的报名已由发起者撤销：'+reason,stamp);
      }else if(person.status==='confirmed'&&botMoment(event.withdrawal_deadline||event.deadline,event.timezone)<=now().getTime()){
        if(!reason)throw withApiError(new DomainError('ROSTER_REASON','已過退出期限，請填寫退出原因，交由名單管理者處理',400));
        if(person.withdrawal_requested)throw withApiError(new DomainError('WITHDRAWAL_PENDING','退出申請已提交，請等待處理',409));
        db.prepare('UPDATE attendees SET withdrawal_requested=1,withdrawal_reason=?,updated_at=? WHERE id=?').run(reason,stamp,personId);
        notify(id,event.owner_id,'withdrawal_request',person.nickname+' 申请退出：'+reason,stamp);record(event,user,'withdrawal_request',before,reason,stamp);return;
      }
      db.prepare("UPDATE attendees SET status='withdrawn',withdrawal_requested=0,invitation_token=NULL,updated_at=? WHERE id=?").run(stamp,personId);rebalanceActivity(db,event,now,defaults,hookError);record(event,user,'withdraw',before,reason,stamp);
    },personId);
  });
}
