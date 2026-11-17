import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DB } from '@qgroup/database';
import { AcceptActivityManager, ActivityDelegationResult, InviteActivityManager, RevokeActivityManager } from '@qgroup/contracts';
import { DomainError } from '@qgroup/domain';
import { z } from 'zod';
import { hash, type Security } from './security';
import { requireActivityAccess } from './activity-access';
import { activityViewer } from './activity-roster';
import { appendEventAudit, eventRow, eventScopes, legacyStamp, requireEventRevision, type EventRow } from './activity-arrangements';
import { activityPeople } from './activity-publish';
import { createActivityBot, type ActivityBotDefaults } from './activity-bot';
type User={id:string;nickname:string};
type Invitation={id:string;event_id:string;token:string;kind:'cohost'|'transfer';target_name:string;recipient_id:string|null;permissions_json:string;status:string;initiator_id:string;accepted_by:string|null;created_at:string;expires_at:string;accepted_at:string|null};
type Role={id:string;event_id:string;user_id:string;permissions_json:string;created_at:string};
function getEvent(db:DB,id:string){const event=eventRow(db,id);if(!event||event.status==='deleted')throw new DomainError('NOT_FOUND','找不到活動或尚未公開',404);return event;}
function owner(db:DB,event:EventRow,userId:string){requireActivityAccess(db,event.id,userId);if(event.owner_id!==userId)throw new DomainError('ACTIVITY_PERMISSION','只有發起者可以邀請或撤銷活動管理者',403);}
function roles(db:DB,id:string){return (db.prepare('SELECT r.*,u.nickname FROM event_roles r JOIN users u ON u.id=r.user_id WHERE r.event_id=? ORDER BY r.created_at,r.id').all(id) as (Role&{nickname:string})[]).map(role=>({id:role.id,name:role.nickname,permissions:JSON.parse(role.permissions_json) as string[]}));}
function snapshot(db:DB,event:EventRow){return {owner_name:(db.prepare('SELECT nickname FROM users WHERE id=?').get(event.owner_id) as {nickname:string}).nickname,roles:roles(db,event.id)};}
function lookup(db:DB,event:EventRow,token:string,now:Date){
  const row=db.prepare("SELECT * FROM management_invitations WHERE event_id=? AND token=? AND status='pending' AND initiator_id=?").get(event.id,token,event.owner_id) as Invitation|undefined;
  if(!row||!(Date.parse(row.expires_at)>now.getTime()))throw new DomainError('MANAGEMENT_INVITATION_NOT_FOUND','交接邀請不存在、已過期、已接受或已撤銷',404);return row;
}
function recipient(invitation:Invitation,userId:string|null){if(invitation.recipient_id&&invitation.recipient_id!==userId)throw new DomainError('MANAGEMENT_RECIPIENT','這份交接邀請屬於另一位報名者，請使用受邀帳號',403);}
export function registerActivityDelegation(app:FastifyInstance,db:DB,security:Security,now:()=>Date,defaults:ActivityBotDefaults={}){
  const params=z.object({id:z.string().min(1).max(80)}),tokenParams=params.extend({token:z.string().regex(/^[A-Za-z0-9_-]{32}$/)}),itemParams=params.extend({itemId:z.string().min(1).max(80)}),bot=createActivityBot(db,now,defaults),routeOptions={config:{rateLimit:{max:30,timeWindow:'1 minute'}}};
  function optional(id:string,run:()=>unknown){try{db.transaction(run)();}catch{app.log.error({eventId:id},'Delegation bot hook failed; business write preserved');}}
  function append(event:EventRow,user:User,action:string,before:unknown,after:unknown,reason:string,stamp:string){if(appendEventAudit(db,event,user,action,before,after,reason,stamp))optional(event.id,()=>{bot.rosterUpdated(event.id,action,[],[]);if(action==='ownership_transferred')bot.broadcast(eventRow(db,event.id)!,'ownership_changed');});}
  function notify(event:EventRow,userId:string,kind:'ownership_transferred'|'cohost_accepted'|'cohost_removed',message:string,stamp:string){db.prepare('INSERT INTO notifications(user_id,event_id,kind,message,created_at) VALUES(?,?,?,?,?)').run(userId,event.id,kind,message,stamp);optional(event.id,()=>bot.personal(event.id,userId,kind));}
  function write(request:FastifyRequest,id:string,action:string,target:string,input:unknown,run:(event:EventRow,user:User,stamp:string)=>string){
    return db.transaction(()=>{
      const user=security.memberWrite(request),event=getEvent(db,id),key=z.string().uuid().parse(request.headers['idempotency-key']),signature='activity-delegation:'+encodeURIComponent(id)+':'+action+':'+hash(target)+':'+hash(JSON.stringify(input));
      if(action!=='accept')owner(db,event,user.id);
      const old=db.prepare('SELECT signature,response_json FROM request_results WHERE user_id=? AND request_key=?').get(user.id,key) as {signature:string;response_json:string}|undefined;
      if(old){
        if(old.signature!==signature)throw new DomainError('REQUEST_CONFLICT','這個操作編號已用於另一份內容',409);
        const result=ActivityDelegationResult.parse(JSON.parse(old.response_json));
        if(action==='accept'){
          const applied=db.prepare("SELECT 1 FROM management_invitations WHERE id=? AND event_id=? AND status='accepted' AND accepted_by=?").get(result.operationId,id,user.id);if(!applied)throw new DomainError('ACTIVITY_PERMISSION','此接受結果不屬於目前帳號',403);requireActivityAccess(db,id,user.id);
        }
        return result;
      }
      const operationId=run(event,user,legacyStamp(now())),result={id,revision:eventRow(db,id)!.revision,operationId};db.prepare('INSERT INTO request_results VALUES(?,?,?,?,?,?)').run(user.id,key,signature,JSON.stringify(result),200,legacyStamp(now()));return result;
    }).immediate();
  }
  app.get('/api/v2/activities/:id/delegation',async request=>db.transaction(()=>{
    const {id}=params.parse(request.params),user=security.scopedMember(request),event=getEvent(db,id);requireActivityAccess(db,id,user.id);const isOwner=event.owner_id===user.id;
    const invitations=isOwner?(db.prepare("SELECT * FROM management_invitations WHERE event_id=? AND status='pending' AND expires_at>? ORDER BY created_at").all(id,legacyStamp(now())) as Invitation[]).map(invitation=>({id:invitation.id,token:invitation.token,kind:invitation.kind,targetName:invitation.target_name,permissions:JSON.parse(invitation.permissions_json),expiresAt:invitation.expires_at})):[];
    return {id,title:event.title,revision:event.revision,ownerName:snapshot(db,event).owner_name,isOwner,blocker:event.archived_at?'請先取消歸檔再邀請管理者':'',myScopes:[...eventScopes(db,event,user.id)],roles:roles(db,id),targets:isOwner?activityPeople(db,id).filter(person=>person.user_id&&person.user_id!==user.id&&person.status!=='withdrawn').map(person=>({id:person.id,name:person.nickname})):[],invitations};
  })());
  app.get('/api/v2/activities/:id/delegation/preview/:token',routeOptions,async request=>db.transaction(()=>{
    const {id,token}=tokenParams.parse(request.params),event=getEvent(db,id),invitation=lookup(db,event,token,now()),viewer=activityViewer(security,request);recipient(invitation,viewer);
    return {id,title:event.title,ownerName:snapshot(db,event).owner_name,kind:invitation.kind,targetName:invitation.target_name,permissions:JSON.parse(invitation.permissions_json),expiresAt:invitation.expires_at,revision:event.revision,isOwner:event.owner_id===viewer};
  })());
  app.post('/api/v2/activities/:id/delegation/invitations',routeOptions,async request=>{
    const {id}=params.parse(request.params),input=InviteActivityManager.parse(request.body);
    return write(request,id,'invite','',input,(event,user,stamp)=>{
      requireEventRevision(event,input.revision);if(event.archived_at)throw new DomainError('ACTIVITY_ARCHIVED','請先取消歸檔再邀請管理者',409);
      let recipientId:string|null=null;
      if(input.attendeeId){const person=activityPeople(db,id).find(person=>person.id===input.attendeeId&&person.user_id&&person.status!=='withdrawn');if(!person)throw new DomainError('MANAGEMENT_RECIPIENT','對方尚未綁定本人報名，請使用專屬交接連結',400);recipientId=person.user_id as string;if(recipientId===user.id)throw new DomainError('MANAGEMENT_SELF','不能邀請自己接受交接',400);}
      const permissions=input.kind==='cohost'?[...new Set(input.permissions)].sort():[];
      if(input.kind==='transfer')db.prepare("UPDATE management_invitations SET status='revoked' WHERE event_id=? AND kind='transfer' AND status='pending'").run(id);
      const invitationId=randomBytes(8).toString('hex'),token=randomBytes(24).toString('base64url'),expiresAt=legacyStamp(new Date(now().getTime()+7*86400000));
      db.prepare('INSERT INTO management_invitations(id,event_id,token,kind,target_name,recipient_id,permissions_json,initiator_id,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(invitationId,id,token,input.kind,input.targetName,recipientId,JSON.stringify(permissions),user.id,stamp,expiresAt);
      append(event,user,'management_invited',{}, {invitation_id:invitationId,kind:input.kind,target_name:input.targetName,permissions,expires_at:expiresAt},input.reason,stamp);return invitationId;
    });
  });
  app.post('/api/v2/activities/:id/delegation/preview/:token/accept',routeOptions,async request=>{
    const {id,token}=tokenParams.parse(request.params),input=AcceptActivityManager.parse(request.body);
    return write(request,id,'accept',token,input,(event,user,stamp)=>{
      const invitation=lookup(db,event,token,now());recipient(invitation,user.id);requireEventRevision(event,input.revision);
      if(event.owner_id===user.id)throw new DomainError('MANAGEMENT_SELF','發起者不能接受自己的交接邀請',409);
      let before:Record<string,unknown>=snapshot(db,event);
      if(invitation.kind==='transfer'){
        db.prepare('UPDATE events SET owner_id=? WHERE id=?').run(user.id,id);db.prepare('DELETE FROM event_roles WHERE event_id=? AND user_id=?').run(id,user.id);db.prepare("UPDATE management_invitations SET status='revoked' WHERE event_id=? AND status='pending'").run(id);
        notify(event,event.owner_id,'ownership_transferred',event.title+' 已由 '+user.nickname+' 接任发起者；你仍可管理自己的报名',stamp);
      }else{
        const accepted=new Set<string>(JSON.parse(invitation.permissions_json));
        if(accepted.has('settlement')){
          const priorRoles=db.prepare('SELECT * FROM event_roles WHERE event_id=?').all(id) as Role[];
          for(const role of priorRoles){const prior=new Set<string>(JSON.parse(role.permissions_json));if(role.user_id!==user.id&&prior.delete('settlement')){if(prior.size)db.prepare('UPDATE event_roles SET permissions_json=? WHERE id=?').run(JSON.stringify([...prior].sort()),role.id);else db.prepare('DELETE FROM event_roles WHERE id=?').run(role.id);notify(event,role.user_id,'cohost_removed',event.title+' 已另行指定结算人，你的结算权限已撤销',stamp);}}
          const prior=priorRoles.find(role=>role.user_id===user.id);if(prior)for(const permission of JSON.parse(prior.permissions_json))accepted.add(permission);
        }
        db.prepare('INSERT INTO event_roles(id,event_id,user_id,permissions_json,created_at) VALUES(?,?,?,?,?) ON CONFLICT(event_id,user_id) DO UPDATE SET permissions_json=excluded.permissions_json').run(randomBytes(8).toString('hex'),id,user.id,JSON.stringify([...accepted].sort()),stamp);
        notify(event,event.owner_id,'cohost_accepted',user.nickname+' 已接受 '+event.title+' 的协办邀请',stamp);
      }
      db.prepare("UPDATE management_invitations SET status='accepted',accepted_by=?,accepted_at=? WHERE id=?").run(user.id,stamp,invitation.id);db.prepare('INSERT OR IGNORE INTO event_access VALUES(?,?,?)').run(id,user.id,stamp);
      let after:Record<string,unknown>=snapshot(db,eventRow(db,id)!);
      // Same display names must not erase a real ownership change from the audit.
      if(invitation.kind==='transfer'&&JSON.stringify(before)===JSON.stringify(after)){before={...before,owner_id:event.owner_id};after={...after,owner_id:user.id};}
      append(event,user,invitation.kind==='transfer'?'ownership_transferred':'cohost_joined',before,after,'本人接受管理邀请',stamp);return invitation.id;
    });
  });
  app.post('/api/v2/activities/:id/delegation/invitations/:itemId/revoke',routeOptions,async request=>{
    const {id,itemId}=itemParams.parse(request.params),input=RevokeActivityManager.parse(request.body);
    return write(request,id,'revoke-invitation',itemId,input,(event,user,stamp)=>{requireEventRevision(event,input.revision);const invitation=db.prepare("SELECT * FROM management_invitations WHERE event_id=? AND id=? AND status='pending'").get(id,itemId) as Invitation|undefined;if(!invitation)throw new DomainError('MANAGEMENT_INVITATION_NOT_FOUND','沒有這份待接受邀請',404);db.prepare("UPDATE management_invitations SET status='revoked' WHERE id=?").run(itemId);append(event,user,'management_invitation_revoked',{invitation_id:itemId,target_name:invitation.target_name,kind:invitation.kind},{},input.reason,stamp);return itemId;});
  });
  app.post('/api/v2/activities/:id/delegation/roles/:itemId/revoke',routeOptions,async request=>{
    const {id,itemId}=itemParams.parse(request.params),input=RevokeActivityManager.parse(request.body);
    return write(request,id,'revoke-role',itemId,input,(event,user,stamp)=>{requireEventRevision(event,input.revision);const role=db.prepare('SELECT r.*,u.nickname FROM event_roles r JOIN users u ON u.id=r.user_id WHERE r.event_id=? AND r.id=?').get(id,itemId) as (Role&{nickname:string})|undefined;if(!role)throw new DomainError('MANAGEMENT_ROLE_NOT_FOUND','沒有這位協辦',404);const before=roles(db,id);db.prepare('DELETE FROM event_roles WHERE id=?').run(itemId);append(event,user,'cohost_removed',{roles:before},{roles:roles(db,id)},input.reason,stamp);notify(event,role.user_id,'cohost_removed',event.title+' 的协办权限已撤销：'+input.reason,stamp);return itemId;});
  });
}
