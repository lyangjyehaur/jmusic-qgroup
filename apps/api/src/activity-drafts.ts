import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DB } from '@qgroup/database';
import { CreateActivityDraft, SaveActivityDraft, RemoveActivityDraft, PublishActivityDraft } from '@qgroup/contracts';
import { DomainError } from '@qgroup/domain';
import { z } from 'zod';
import { hash, type Security } from './security';
import { requireActivityAccess } from './activity-access';
import { appendEventAudit, arrangementSnapshot, arrangementValues, eventRow, eventScopes, eventSnapshot, legacyStamp, removalBlocker, requireEventRevision, storedArrangement } from './activity-arrangements';
import { publishActivityDraft } from './activity-publish';
import { activityBotPolicy, type ActivityBotDefaults } from './activity-bot';

const params=z.object({id:z.string().min(1).max(80)});
function authorize(db:DB,id:string,userId:string,scope?:'schedule'|'owner',allowDeleted=false,allowPublished=false){
  const event=eventRow(db,id);
  if(!event||(!allowDeleted&&event.status==='deleted'))throw new DomainError('NOT_FOUND','找不到活動草稿',404);
  const scopes=eventScopes(db,event,userId);
  if(!scopes.size)throw new DomainError('NOT_FOUND','找不到活動草稿',404);
  if(!allowPublished&&event.lifecycle!=='draft')throw new DomainError('NOT_A_DRAFT','活動已發布；草稿輸入仍保留，請回到活動核對',409);
  if(scope&&!scopes.has(scope))throw new DomainError('ACTIVITY_PERMISSION','沒有這項活動管理權限',403);
  return event;
}
export function activityDraft(db:DB,id:string,userId:string){
  requireActivityAccess(db,id,userId);
  const event=authorize(db,id,userId);const scopes=eventScopes(db,event,userId);
  const owner=db.prepare('SELECT nickname FROM users WHERE id=?').get(event.owner_id) as {nickname:string};
  const blocker=removalBlocker(db,event);
  return {id,revision:event.revision,ownerName:owner.nickname,isOwner:scopes.has('owner'),canEdit:scopes.has('schedule'),canRemove:scopes.has('owner')&&!blocker,removalBlocker:blocker,values:storedArrangement(event)};
}
export function registerActivityDrafts(app:FastifyInstance,db:DB,security:Security,now:()=>Date,botDefaults:ActivityBotDefaults={}){
  function reconcileDraftBot(request:FastifyRequest,id:string){
    // The original event hook cancels obsolete work even for a draft. It never
    // queues broadcasts / reminders or alters immutable payloads in this state.
    try{db.transaction(()=>{
      if(!activityBotPolicy(db,botDefaults).config.enabled)return;
      db.prepare("UPDATE bot_outbox SET status='skipped',last_error='活动已关闭公开群同步' WHERE event_id=? AND channel='group' AND status IN ('pending','sending')").run(id);
      db.prepare("UPDATE bot_outbox SET status='skipped',last_error='安排或群同步设置已变更，旧提醒作废' WHERE event_id=? AND kind IN ('deadline_reminder','estimated_over_reminder') AND status IN ('pending','sending')").run(id);
    })();}catch{request.log.error({eventId:id},'Draft bot reconciliation failed; business write preserved');}
  }
  app.get('/api/v2/me/activity-drafts',async request=>db.transaction(()=>{
    const user=security.scopedMember(request);
    const {page}=z.object({page:z.coerce.number().int().min(1).max(10000).default(1)}).strict().parse(request.query);
    const rows=db.prepare(`SELECT e.id,e.title,e.starts_at,e.owner_id,e.revision,u.nickname AS owner_name,r.permissions_json
      FROM events e JOIN users u ON u.id=e.owner_id LEFT JOIN event_roles r ON r.event_id=e.id AND r.user_id=?
      WHERE e.lifecycle='draft' AND e.status!='deleted' AND (e.owner_id=? OR json_array_length(r.permissions_json)>0)
      ORDER BY e.created_at DESC,e.id DESC LIMIT 21 OFFSET ?`).all(user.id,user.id,(page-1)*20) as {id:string;title:string;starts_at:string;owner_id:string;revision:number;owner_name:string;permissions_json:string|null}[];
    return {page,hasMore:rows.length>20,drafts:rows.slice(0,20).map(row=>{const scopes=eventScopes(db,eventRow(db,row.id)!,user.id);return {id:row.id,title:row.title,startsAt:row.starts_at,ownerName:row.owner_name,isOwner:row.owner_id===user.id,canEdit:scopes.has('schedule'),revision:row.revision};})};
  })());
  app.get('/api/v2/activities/:id/draft',async request=>db.transaction(()=>activityDraft(db,params.parse(request.params).id,security.scopedMember(request).id))());
  app.get('/api/v2/activities/draft-results/:requestId',async request=>db.transaction(()=>{
    const user=security.scopedMember(request);const {requestId}=z.object({requestId:z.string().uuid()}).parse(request.params);
    const row=db.prepare('SELECT signature,response_json FROM request_results WHERE user_id=? AND request_key=?').get(user.id,requestId) as {signature:string;response_json:string}|undefined;
    if(!row||!row.signature.startsWith('activity-draft:'))return {state:'not_found' as const};
    // A global receipt can also belong to another domain. Only expose the minimal draft result.
    const parsed=z.object({id:z.string(),revision:z.number().int(),removed:z.boolean()}).strict().safeParse(JSON.parse(row.response_json));
    if(!parsed.success)return {state:'not_found' as const};
    const event=eventRow(db,parsed.data.id);if(!event||!eventScopes(db,event,user.id).size)throw new DomainError('NOT_FOUND','找不到這個操作結果',404);
    return {state:'completed' as const,result:parsed.data};
  })());

  const routeOptions={config:{rateLimit:{max:20,timeWindow:'1 minute'}}};
  function write<T>(request:FastifyRequest,path:string,input:unknown,run:(user:ReturnType<Security['memberWrite']>,stamp:string)=>T,existing?:{id:string;scope:'schedule'|'owner'}){
    return db.transaction(()=>{
      const user=security.memberWrite(request);const key=z.string().uuid().parse(request.headers['idempotency-key']);
      const signature='activity-draft:'+hash('v2:'+request.method+':'+path+':'+JSON.stringify(input));
      // Re-authorize before a receipt, including a completed removal. No stale role replay.
      if(existing)authorize(db,existing.id,user.id,existing.scope,true,true);
      const previous=db.prepare('SELECT signature,response_json FROM request_results WHERE user_id=? AND request_key=?').get(user.id,key) as {signature:string;response_json:string}|undefined;
      if(previous){
        if(previous.signature!==signature)throw new DomainError('REQUEST_CONFLICT','這個操作編號已用於另一份內容',409);
        const result=JSON.parse(previous.response_json) as T;
        if(!existing&&typeof result==='object'&&result&&'id' in result&&typeof result.id==='string')authorize(db,result.id,user.id,undefined,true,true);
        return result;
      }
      const stamp=legacyStamp(now());const result=run(user,stamp);
      db.prepare('INSERT INTO request_results VALUES(?,?,?,?,?,?)').run(user.id,key,signature,JSON.stringify(result),200,stamp);
      return result;
    }).immediate();
  }
  app.post('/api/v2/activities/drafts',routeOptions,async request=>{
    const input=CreateActivityDraft.parse(request.body);
    return write(request,'/api/v2/activities/drafts',input,(user,stamp)=>{
      const v=arrangementValues(input.values,now(),true);const id=randomBytes(8).toString('hex');
      db.prepare(`INSERT INTO events(id,owner_id,title,category,location,starts_at,deadline,capacity,description,duration_hours,created_at,withdrawal_deadline,visibility,invite_token,lifecycle,registration_open,status,timezone,minimum_participants,fee_policy,draft_join_owner,bot_enabled)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',0,'closed',?,?,?,?,?)`).run(id,user.id,v.title,v.category,v.location,v.startsAt,v.deadline,v.capacity,v.description,v.durationHours,stamp,v.withdrawalDeadline,v.visibility,randomBytes(24).toString('base64url'),v.timezone,v.minimumParticipants,v.feePolicy,Number(v.joinOwner),Number(v.botEnabled));
      db.prepare('INSERT INTO event_access(event_id,user_id,created_at) VALUES(?,?,?)').run(id,user.id,stamp);
      const event=eventRow(db,id)!;
      appendEventAudit(db,event,user,'event_created',{},eventSnapshot(event),'',stamp);
      // Drafts never publish conditions, register attendees, or enqueue bot messages.
      return {id,revision:eventRow(db,id)!.revision,removed:false};
    });
  });
  app.put('/api/v2/activities/:id/draft',routeOptions,async request=>{
    const {id}=params.parse(request.params);const input=SaveActivityDraft.parse(request.body);
    return write(request,'/api/v2/activities/'+id+'/draft',input,(user,stamp)=>{
      const event=authorize(db,id,user.id,'schedule');requireEventRevision(event,input.revision);
      if(event.archived_at||db.prepare('SELECT 1 FROM settlements WHERE event_id=?').get(id))throw new DomainError('ACTIVITY_LOCKED','活動已有歸檔或結算記錄，不能重寫安排',409);
      const v=arrangementValues(input.values,now(),true,event);const owner=event.owner_id===user.id;
      if(!owner&&(v.botEnabled!==!!event.bot_enabled||v.feePolicy!==event.fee_policy||v.visibility!==event.visibility||(v.withdrawalDeadline||v.deadline)!==(event.withdrawal_deadline||event.deadline)))throw new DomainError('OWNER_SETTINGS','群同步、費用規則、退出期限及可見性需由發起者修改',403);
      const count=(db.prepare("SELECT count(*) AS n FROM attendees WHERE event_id=? AND status='confirmed'").get(id) as {n:number}).n;
      if(v.capacity&&v.capacity<count)throw new DomainError('CAPACITY_BELOW_ROSTER','人數上限低於正式報名人數，請先處理超額人員',409);
      const proposed={...event,category:v.category,starts_at:v.startsAt,duration_hours:v.durationHours,location:v.location,description:v.description,withdrawal_deadline:v.withdrawalDeadline,deadline:v.deadline,timezone:v.timezone,fee_policy:v.feePolicy};
      if(JSON.stringify(arrangementSnapshot(event))!==JSON.stringify(arrangementSnapshot(proposed))&&!input.reason&&db.prepare("SELECT 1 FROM attendees WHERE event_id=? AND status IN ('confirmed','waiting','tentative') LIMIT 1").get(id))throw new DomainError('ARRANGEMENT_REASON_REQUIRED','重要安排變更請填寫原因，參加者需要重新確認',400);
      db.prepare(`UPDATE events SET title=?,category=?,location=?,starts_at=?,deadline=?,capacity=?,description=?,duration_hours=?,withdrawal_deadline=?,visibility=?,timezone=?,minimum_participants=?,fee_policy=?,draft_join_owner=?,bot_enabled=? WHERE id=?`).run(v.title,v.category,v.location,v.startsAt,v.deadline,v.capacity,v.description,v.durationHours,v.withdrawalDeadline,v.visibility,v.timezone,v.minimumParticipants,v.feePolicy,Number(v.joinOwner),Number(v.botEnabled),id);
      const updated=eventRow(db,id)!;
      const changed=appendEventAudit(db,event,user,'event_updated',{event:eventSnapshot(event),participants:[],draft_join_owner:event.draft_join_owner},{event:eventSnapshot(updated),participants:[],draft_join_owner:updated.draft_join_owner},input.reason,stamp);
      if(changed)reconcileDraftBot(request,id);
      return {id,revision:eventRow(db,id)!.revision,removed:false};
    },{id,scope:'schedule'});
  });
  app.post('/api/v2/activities/:id/draft/remove',routeOptions,async request=>{
    const {id}=params.parse(request.params);const input=RemoveActivityDraft.parse(request.body);
    return write(request,'/api/v2/activities/'+id+'/draft/remove',input,(user,stamp)=>{
      const event=authorize(db,id,user.id,'owner');requireEventRevision(event,input.revision);
      const blocked=removalBlocker(db,event);if(blocked)throw new DomainError('ACTIVITY_HAS_RECORDS',blocked,409);
      db.prepare("UPDATE events SET status='deleted',registration_open=0,bot_enabled=0 WHERE id=?").run(id);
      db.prepare("UPDATE bot_outbox SET status='skipped',last_error='活动已删除' WHERE event_id=? AND status IN ('pending','sending')").run(id);
      appendEventAudit(db,event,user,'event_remove',{event:eventSnapshot(event),participants:[]},{event:eventSnapshot(eventRow(db,id)!),participants:[]},'',stamp);
      return {id,revision:eventRow(db,id)!.revision,removed:true};
    },{id,scope:'owner'});
  });
  app.post('/api/v2/activities/:id/draft/publish',routeOptions,async request=>{
    const {id}=params.parse(request.params);const input=PublishActivityDraft.parse(request.body);
    return write(request,'/api/v2/activities/'+id+'/draft/publish',input,user=>{
      const event=authorize(db,id,user.id,'owner');requireEventRevision(event,input.revision);
      const arrangement=arrangementValues(storedArrangement(event) as z.infer<typeof CreateActivityDraft>['values'],now(),true,event);
      return publishActivityDraft(db,event,user,now,arrangement,botDefaults,eventId=>request.log.error({eventId},'Publication bot hook failed; business write preserved'));
    },{id,scope:'owner'});
  });
}
