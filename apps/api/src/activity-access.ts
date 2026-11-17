import type { DB } from '@qgroup/database';
import { DomainError } from '@qgroup/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AcceptActivityAccess, ActivityAccessResult } from '@qgroup/contracts';
import { hash, type Security } from './security';
import { eventRow, eventScopes, legacyStamp, requireEventRevision, storedArrangement } from './activity-arrangements';
/** Preserve the original event access policy; site administrator is not an invitation. */
export function requireActivityAccess(db: DB, id: string, viewerId: string | null) {
  const event = db.prepare('SELECT id,owner_id,visibility,lifecycle,status,revision FROM events WHERE id=?').get(id) as {id:string;owner_id:string;visibility:string;lifecycle:string;status:string;revision:number} | undefined;
  if (!event || event.status === 'deleted') throw new DomainError('NOT_FOUND', '找不到活動或尚未公開', 404);
  let allowed = event.visibility === 'public' || event.owner_id === viewerId;
  if (event.lifecycle === 'draft') {
    allowed = !!viewerId && eventScopes(db,event,viewerId).size > 0;
  } else if (!allowed && viewerId) allowed = !!db.prepare('SELECT 1 FROM event_access WHERE event_id=? AND user_id=?').get(id, viewerId);
  if (!allowed) throw new DomainError('NOT_FOUND', '找不到活動或尚未公開', 404);
  return event;
}

export function registerActivityAccess(app:FastifyInstance,db:DB,security:Security,now:()=>Date){
  const params=z.object({id:z.string().min(1).max(80)}),tokenParams=params.extend({token:z.string().regex(/^[A-Za-z0-9_-]{32}$/)});
  const limited={config:{rateLimit:{max:30,timeWindow:'1 minute'}}};
  function byToken(id:string,token:string){
    const event=eventRow(db,id),stored=db.prepare('SELECT invite_token FROM events WHERE id=?').get(id) as {invite_token:string|null}|undefined;
    if(!event||event.status==='deleted'||event.lifecycle==='draft'||!stored?.invite_token||token!==stored.invite_token)throw new DomainError('INVITATION_NOT_FOUND','邀請連結不存在或已失效',404);
    return event;
  }
  app.get('/api/v2/activities/:id/access/:token',limited,async request=>db.transaction(()=>{
    const {id,token}=tokenParams.parse(request.params),event=byToken(id,token);
    return {id,title:event.title,revision:event.revision};
  })());
  app.post('/api/v2/activities/:id/access/:token/accept',limited,async request=>db.transaction(()=>{
    const {id,token}=tokenParams.parse(request.params),input=AcceptActivityAccess.parse(request.body),user=security.memberWrite(request),event=byToken(id,token),key=z.string().uuid().parse(request.headers['idempotency-key']);
    const signature='activity-access:'+hash(JSON.stringify({id,token,input}));
    const old=db.prepare('SELECT signature,response_json FROM request_results WHERE user_id=? AND request_key=?').get(user.id,key) as {signature:string;response_json:string}|undefined;
    if(old){if(old.signature!==signature)throw new DomainError('REQUEST_CONFLICT','這個操作編號已用於另一份內容',409);requireActivityAccess(db,id,user.id);return ActivityAccessResult.parse(JSON.parse(old.response_json));}
    requireEventRevision(event,input.revision);
    const stamp=legacyStamp(now());db.prepare('INSERT OR IGNORE INTO event_access VALUES(?,?,?)').run(id,user.id,stamp);
    const result={id,granted:true};db.prepare('INSERT INTO request_results VALUES(?,?,?,?,?,?)').run(user.id,key,signature,JSON.stringify(result),200,stamp);return result;
  }).immediate());
  app.get('/api/v2/activities/:id/share',async request=>db.transaction(()=>{
    const {id}=params.parse(request.params),viewer=request.headers['x-account-scope']?security.scoped(request):null,userId=viewer?.kind==='member'?viewer.id:null,event=requireActivityAccess(db,id,userId);
    if(event.lifecycle==='draft')throw new DomainError('NOT_FOUND','草稿尚未公開',404);
    let path='/activities/'+encodeURIComponent(id);
    if(event.visibility==='invitation'){
      if(event.owner_id!==userId)throw new DomainError('SHARE_PERMISSION','只有發起者可以取得邀請可見連結',403);
      const {invite_token:token}=db.prepare('SELECT invite_token FROM events WHERE id=?').get(id) as {invite_token:string|null};
      if(!token||!/^[A-Za-z0-9_-]{32}$/.test(token))throw new DomainError('INVITATION_NOT_FOUND','活動尚無有效邀請連結',409);
      path+='/access/'+token;
    }
    return {id,path,invitation:event.visibility==='invitation'};
  })());
  app.get('/api/v2/activities/:id/copy-source',async request=>db.transaction(()=>{
    const {id}=params.parse(request.params),user=security.scopedMember(request);requireActivityAccess(db,id,user.id);
    const {startsAt,deadline,withdrawalDeadline,botEnabled,joinOwner,...values}=storedArrangement(eventRow(db,id)!);
    return {id,values};
  })());
}
