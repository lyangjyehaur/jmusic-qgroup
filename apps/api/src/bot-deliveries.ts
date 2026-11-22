import { insertBotRetry } from './bot-delivery-command';
import { BotDeliveryEntityPath, BotDeliveryPath, RequestIdPath } from '@qgroup/contracts/http-paths';
import { withApiError } from './error-display';
import { z } from 'zod';
import type { FastifyInstance,FastifyRequest } from 'fastify';
import { BotDeliveriesQuery, EmptyHttpQuery, BotDeliveries, BotDelivery, BotDeliveryReview, BotDeliveryResult, RetryBotDelivery } from "@qgroup/contracts";
import { currentBotTarget,deploymentBotGroup,type DB } from '@qgroup/database';
import { DomainError } from '@qgroup/domain';
import { activityBotPolicy,type ActivityBotDefaults } from './activity-bot';
import { appendEventAudit,eventRow,eventScopes,legacyStamp } from './activity-arrangements';
import { requireActivityAccess } from './activity-access';
import { pollRow } from './time-poll-context';
import { deliveryRetryBlocker,outboxSkipReason,type DeliveryIntent } from './bot-delivery-rules';
import { prepareOutboxPayload } from './bot-delivery-plan';
import { hash,type Security } from './security';
import type { AdminSecurity } from './admin-security';
type Context={entity:'activity'|'poll';id:string};
type Row=DeliveryIntent & {id:string;status:'pending'|'sending'|'sent'|'failed'|'skipped';attempts:number;last_error:string;created_at:string;retry_at:string|null;sent_at:string|null;simulated_at:string|null;delivered_payload_json:string|null;claimed_at:string|null;claim_token:string;title:string};
const columns=`CAST(o.id AS TEXT) id,o.event_id,o.poll_id,o.kind,o.channel,o.target,o.payload_json,o.due_at,o.status,o.attempts,o.last_error,o.created_at,o.retry_at,o.sent_at,o.simulated_at,o.delivered_payload_json,o.claimed_at,o.claim_token,COALESCE(e.title,p.title,'') title`;
const tables='bot_outbox o LEFT JOIN events e ON e.id=o.event_id LEFT JOIN time_polls p ON p.id=o.poll_id';

const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const json=(value:string|null)=>{try{const data:unknown=JSON.parse(value??'null');return object(data)?data:null;}catch{return null;}};
const text=(value:unknown)=>typeof value==='string'&&Array.from(value).length<=20000?value:null;
// Imported error fields may contain transport URLs or credentials; never return
// arbitrary payload objects, passive IDs, claim tokens or private recipients.
const errorText=(value:string)=>Array.from(value.replace(/https?:\/\/\S+/gi,'[網址]').replace(/(?:Bearer|QQBot)\s+\S+/gi,'[憑證]').replace(/((?:access_token|clientSecret|app_secret|password|authorization|invite_token|preview_token|account_link)["']?\s*[=:]\s*["']?)[^\s,;"']+/gi,'$1[已隱藏]')).slice(0,300).join('');
const contextOf=(row:Row):Context=>({entity:row.poll_id?'poll':'activity',id:(row.poll_id??row.event_id)!});
function summary(row:Row){return BotDelivery.parse({id:row.id,entity:contextOf(row).entity,entityId:contextOf(row).id,title:row.title,kind:row.kind,status:row.status,attempts:row.attempts,target:row.target,lastError:errorText(row.last_error),createdAt:row.created_at,dueAt:row.due_at,retryAt:row.retry_at,sentAt:row.sent_at,simulatedAt:row.simulated_at});}
export function registerBotDeliveries(app:FastifyInstance,db:DB,security:Security,admin:AdminSecurity,now:()=>Date,defaults:ActivityBotDefaults={}){
  function load(id:string){
    const row=db.prepare(`SELECT ${columns} FROM ${tables} WHERE o.id=? AND o.channel='group'`).get(BigInt(id)) as Row|undefined;
    if(!row)throw withApiError(new DomainError('BOT_DELIVERY_NOT_FOUND','找不到群通知紀錄',404));return row;
  }
  function authorize(context:Context,userId:string,row?:Row){
    if(row&&(contextOf(row).entity!==context.entity||contextOf(row).id!==context.id))throw withApiError(new DomainError('BOT_DELIVERY_NOT_FOUND','找不到這場的群通知紀錄',404));
    if(context.entity==='poll'){
      if(pollRow(db,context.id,true).owner_id!==userId)throw withApiError(new DomainError('POLL_PERMISSION','只有發起者可以核對投票通知',403));
      return false;
    }
    requireActivityAccess(db,context.id,userId);
    const scopes=eventScopes(db,eventRow(db,context.id)!,userId),settlementOnly=!scopes.has('owner');
    if(settlementOnly&&(!scopes.has('settlement')||(row&&row.kind!=='settlement_updated')))throw withApiError(new DomainError('BOT_DELIVERY_PERMISSION','只有發起者或本場結算人可以核對對應通知',403));
    return settlementOnly;
  }
  function review(row:Row,readOnly=false){
    const context=contextOf(row),settings=activityBotPolicy(db,defaults),target=currentBotTarget(db,settings.config),payload=json(row.payload_json),delivered=json(row.delivered_payload_json);
    let blocker:string|null=null,prepared:Record<string,unknown>|null=null;
    if(readOnly)blocker='請從活動或投票的授權入口核對重送';
    else blocker=deliveryRetryBlocker(row);
    if(!blocker&&!payload)blocker='原通知內容無法驗證，請保全紀錄並核對原始資料';
    if(!blocker&&context.entity==='activity'&&eventRow(db,context.id)!.archived_at)blocker='請先取消歸檔，再核對通知';
    if(!blocker&&typeof delivered?._group_ref==='string'&&delivered._group_ref!==hash(target).slice(0,20))blocker='通知目標群已變更，不能把舊通知轉發給新群';
    if(!blocker){try{blocker=outboxSkipReason(db,row,settings.config,deploymentBotGroup(db),now());}catch{blocker='原通知內容無法驗證，請保全紀錄並核對原始資料';}}
    if(!blocker&&db.prepare(`SELECT 1 FROM bot_outbox WHERE channel='group' AND status IN ('pending','sending') AND ${row.poll_id?'poll_id=?':'event_id=? AND kind=? AND payload_json=?'} LIMIT 1`).get(...(row.poll_id?[row.poll_id]:[row.event_id,row.kind,row.payload_json])))blocker='這條通知已有待送工作，請等待投遞結果';
    if(!blocker){try{prepared=prepareOutboxPayload(db,row,settings.config,now(),defaults);if(!prepared)blocker='通知目前已不適用，請使用最新安排';}catch{blocker='原通知內容無法驗證，請保全紀錄並核對原始資料';}}
    const entity=context.entity==='activity'?eventRow(db,context.id):pollRow(db,context.id,true);
    const token=blocker?null:hash(JSON.stringify({row,policy:settings,target,entity,prepared}));
    return {view:BotDeliveryReview.parse({delivery:summary(row),target,mode:settings.config.dry_run===null?'inherit':settings.config.dry_run?'simulate':'live',originalText:text(payload?.text),preparedText:text(prepared?.text),deliveredText:text(delivered?.content??(object(delivered?.markdown)?delivered.markdown.content:null)),imageName:object(payload?._settlement_image)?text(payload._settlement_image.name):null,blocker,reviewToken:token}),prepared,target};
  }
  function list(request:FastifyRequest,context?:Context){
    const onlySettlement=context?authorize(context,security.scopedMember(request).id):false;
    if(!context)admin.authority(request);
    const input=BotDeliveriesQuery.parse(request.query),where=["o.channel='group'","o.id<?"],args:(string|bigint)[]=[input.before?BigInt(input.before):9223372036854775807n];
    if(!input.before)where[1]='o.id<=?';
    if(context){where.push(context.entity==='activity'?'o.event_id=?':'o.poll_id=?');args.push(context.id);}
    if(onlySettlement)where.push("o.kind='settlement_updated'");
    if(input.status){where.push('o.status=?');args.push(input.status);}
    if(input.kind){where.push('o.kind=?');args.push(input.kind);}
    const rows=db.prepare(`SELECT ${columns} FROM ${tables} WHERE ${where.join(' AND ')} ORDER BY o.id DESC LIMIT 51`).all(...args) as Row[];
    const mode=activityBotPolicy(db,defaults).config.dry_run;
    return BotDeliveries.parse({entries:rows.slice(0,50).map(summary),nextBefore:rows.length>50?rows[49]!.id:null,mode:mode===null?'inherit':mode?'simulate':'live'});
  }
  app.get('/api/v2/admin/bot/deliveries',async request=>db.transaction(()=>list(request))());
  app.get('/api/v2/admin/bot/deliveries/:deliveryId',async request=>db.transaction(()=>{admin.authority(request);EmptyHttpQuery.parse(request.query);return review(load(BotDeliveryPath.parse(request.params).deliveryId),true).view;})());
  for(const [segment,entity] of [['activities','activity'],['time-polls','poll']] as const){

    const context=(request:FastifyRequest):Context=>({entity,id:BotDeliveryEntityPath.parse(request.params).id});
    app.get(`/api/v2/${segment}/:id/bot-deliveries`,async request=>db.transaction(()=>list(request,context(request)))());
    app.get(`/api/v2/${segment}/:id/bot-deliveries/:deliveryId`,async request=>db.transaction(()=>{
      const row=load(BotDeliveryEntityPath.parse(request.params).deliveryId!);authorize(context(request),security.scopedMember(request).id,row);EmptyHttpQuery.parse(request.query);return review(row).view;
    })());
    app.post(`/api/v2/${segment}/:id/bot-deliveries/:deliveryId/retry`,{config:{rateLimit:{max:20,timeWindow:'1 minute'}}},async request=>db.transaction(()=>{
      const user=security.memberWrite(request),scope=context(request),row=load(BotDeliveryEntityPath.parse(request.params).deliveryId!);authorize(scope,user.id,row);
      const input=RetryBotDelivery.parse(request.body),key=z.string().uuid().parse(request.headers['idempotency-key']),signature='bot-delivery:'+hash(JSON.stringify({scope,id:row.id,input}));
      const previous=db.prepare('SELECT signature,response_json FROM request_results WHERE user_id=? AND request_key=?').get(user.id,key) as {signature:string;response_json:string}|undefined;
      if(previous){if(previous.signature!==signature)throw withApiError(new DomainError('REQUEST_CONFLICT','這個操作編號已用於其他內容',409));return BotDeliveryResult.parse(JSON.parse(previous.response_json));}
      const checked=review(row);
      if(checked.view.blocker)throw new DomainError('BOT_DELIVERY_BLOCKED',checked.view.blocker,409);
      if(checked.view.reviewToken!==input.reviewToken)throw withApiError(new DomainError('BOT_DELIVERY_CHANGED','通知、設定或權限已有變更，請重新核對',409));
      const stamp=legacyStamp(now()),inserted={id:insertBotRetry(db,{...row,target:checked.target,payload_json:row.poll_id?JSON.stringify(checked.prepared):row.payload_json,due_at:row.poll_id?null:row.due_at},now())};
      if(scope.entity==='activity')appendEventAudit(db,eventRow(db,scope.id)!,user,'bot_delivery_retry',{}, {original_id:row.id,outbox_id:inserted.id},'',stamp);
      else{db.prepare('UPDATE time_polls SET revision=revision+1 WHERE id=?').run(scope.id);db.prepare("INSERT INTO time_poll_history(poll_id,actor_id,action,details_json,created_at) VALUES(?,?,'bot_retry',?,?)").run(scope.id,user.id,JSON.stringify({original_id:row.id,outbox_id:inserted.id}),stamp);}
      const result=BotDeliveryResult.parse({originalId:row.id,queuedId:inserted.id,entity,entityId:scope.id});
      db.prepare('INSERT INTO request_results VALUES(?,?,?,?,?,?)').run(user.id,key,signature,JSON.stringify(result),200,stamp);return result;
    }).immediate());
  }
  app.get('/api/v2/bot-delivery-results/:requestId',async request=>db.transaction(()=>{
    EmptyHttpQuery.parse(request.query);const user=security.scopedMember(request),key=RequestIdPath.parse(request.params).requestId;
    const previous=db.prepare('SELECT signature,response_json FROM request_results WHERE user_id=? AND request_key=?').get(user.id,key) as {signature:string;response_json:string}|undefined;
    if(!previous?.signature.startsWith('bot-delivery:'))return {state:'not_found' as const};
    const result=BotDeliveryResult.parse(JSON.parse(previous.response_json));authorize({entity:result.entity,id:result.entityId},user.id,load(result.originalId));return {state:'completed' as const,result};
  })());
}
