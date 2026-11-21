import { RequestKeyPath } from '@qgroup/contracts/http-paths';
import { withApiError } from './error-display';
import type { FastifyInstance } from 'fastify';
import type { DB } from '@qgroup/database';
import { z } from 'zod';
import { NotificationsQuery,TodosQuery, MarkNotificationsRead, type InboxTodos } from '@qgroup/contracts';
import { activityState, DomainError } from '@qgroup/domain';
import { hash, type Security } from './security';
import { requireActivityAccess } from './activity-access';
import { eventRow, eventScopes, legacyStamp, type EventRow } from './activity-arrangements';
import { financeTodoSummary } from './finance-projection';
export function registerInbox(app:FastifyInstance,db:DB,security:Security,now:()=>Date){
  const unread=(userId:string)=>(db.prepare("SELECT COUNT(*) AS count FROM notifications n JOIN events e ON e.id=n.event_id WHERE n.user_id=? AND n.read_at IS NULL AND e.status!='deleted'").get(userId) as {count:number}).count;
  app.get('/api/v2/me/operations/:key',async request=>{const user=security.scopedMember(request),{key}=RequestKeyPath.parse(request.params);return {committed:!!db.prepare('SELECT 1 FROM request_results WHERE user_id=? AND request_key=?').get(user.id,key)};});
  app.get('/api/v2/me/notifications/count',async request=>({unreadCount:unread(security.scopedMember(request).id)}));
  app.get('/api/v2/me/notifications',async request=>db.transaction(()=>{
    const user=security.scopedMember(request),{before}=NotificationsQuery.parse(request.query);
    const rows=db.prepare("SELECT CAST(n.id AS TEXT) AS id,n.event_id,n.kind,n.message,n.created_at,n.read_at FROM notifications n JOIN events e ON e.id=n.event_id WHERE n.user_id=? AND e.status!='deleted' AND n.id<? ORDER BY n.id DESC LIMIT 101").all(user.id,before?BigInt(before):9223372036854775807n) as {id:string;event_id:string;kind:string;message:string;created_at:string;read_at:string|null}[];
    return {notifications:rows.slice(0,100).map(row=>({id:row.id,eventId:row.event_id,kind:row.kind,message:row.message,createdAt:row.created_at,readAt:row.read_at})),unreadCount:unread(user.id),nextBefore:rows.length>100?rows[99]!.id:null};
  })());
  app.post('/api/v2/me/notifications/read',{config:{rateLimit:{max:30,timeWindow:'1 minute'}}},async request=>{
    const input=MarkNotificationsRead.parse(request.body);
    return db.transaction(()=>{
      const user=security.memberWrite(request),key=z.string().uuid().parse(request.headers['idempotency-key']),signature='notifications-read:'+hash(JSON.stringify(input));
      const old=db.prepare('SELECT signature FROM request_results WHERE user_id=? AND request_key=?').get(user.id,key) as {signature:string}|undefined;
      if(old){if(old.signature!==signature)throw withApiError(new DomainError('REQUEST_CONFLICT','這個操作編號已用於另一份內容',409));return {ok:true};}
      const stamp=legacyStamp(now());for(const id of input.ids)db.prepare('UPDATE notifications SET read_at=COALESCE(read_at,?) WHERE id=? AND user_id=?').run(stamp,BigInt(id),user.id);
      db.prepare('INSERT INTO request_results VALUES(?,?,?,?,?,?)').run(user.id,key,signature,'{"ok":true}',200,stamp);return {ok:true};
    }).immediate();
  });
  app.get('/api/v2/me/todos',async request=>db.transaction(()=>{
    const user=security.scopedMember(request),{event:filter}=TodosQuery.parse(request.query),time=now(),todos:z.infer<typeof InboxTodos>['todos']=[];
    if(filter)requireActivityAccess(db,filter,user.id);
    const events=filter?[eventRow(db,filter)!]:db.prepare("SELECT * FROM events WHERE status!='deleted' ORDER BY starts_at,id").all() as EventRow[];
    for(const event of events){
      try{requireActivityAccess(db,event.id,user.id);}catch(error){if(error instanceof DomainError&&error.code==='NOT_FOUND')continue;throw error;}
      const scopes=eventScopes(db,event,user.id),active=!['ended','cancelled','draft'].includes(event.lifecycle)&&!event.archived_at,terminal=['ended','cancelled'].includes(event.lifecycle),settled=!!db.prepare('SELECT 1 FROM settlements WHERE event_id=?').get(event.id);
      const people=db.prepare("SELECT manager_id,status,withdrawal_requested,confirmation_state FROM attendees WHERE event_id=? AND status IN ('confirmed','waiting','tentative')").all(event.id) as {manager_id:string;status:string;withdrawal_requested:number;confirmation_state:string}[];
      const add=(kind:z.infer<typeof InboxTodos>['todos'][number]['kind'],extra:{count?:number;amountCents?:number}={})=>todos.push({eventId:event.id,title:event.title,kind,...extra});
      if(active&&people.some(p=>p.manager_id===user.id&&p.confirmation_state!=='accepted'))add('conditions');
      if(db.prepare("SELECT 1 FROM attendee_claims c JOIN attendees a ON a.id=c.attendee_id WHERE c.event_id=? AND c.status='requested' AND c.expires_at>? AND (a.manager_id=? OR ?) LIMIT 1").get(event.id,legacyStamp(time),user.id,scopes.has('roster')?1:0))add('claims');
      if(active&&!settled&&scopes.has('roster')&&people.some(p=>p.withdrawal_requested))add('withdrawal');
      if(active&&event.owner_id===user.id&&event.minimum_participants&&event.formation_state!=='confirmed'&&(people.filter(p=>p.status==='confirmed').length>=event.minimum_participants||Date.parse(event.deadline)<=time.getTime()))add('formation');
      if(active&&scopes.has('schedule')&&activityState(event,time).estimatedOver)add('finish');
      if(terminal&&scopes.has('settlement')&&!settled&&!event.archived_at)add('settlement');
      const finance=financeTodoSummary(db,event.id,user.id,scopes.has('settlement'));
      if(scopes.has('settlement')&&finance.pendingCount)add('reports',{count:finance.pendingCount});
      if(finance.myOutstandingCents&&finance.myOutstandingCents>0)add('payment',{amountCents:finance.myOutstandingCents});
      if(finance.myRefundDueCents&&finance.myRefundDueCents>0)add('refund',{amountCents:finance.myRefundDueCents});
      if(scopes.has('settlement')&&finance.detailed&&finance.state!=='closed')add('reconcile');
    }
    return {todos,eventTitle:filter?events[0]!.title:null,serverTime:legacyStamp(time)};
  })());
}
