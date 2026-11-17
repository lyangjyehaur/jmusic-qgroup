import type { FastifyInstance } from 'fastify';
import type { DB } from '@qgroup/database';
import { z } from 'zod';
import type { Security } from './security';
import { requireActivityAccess } from './activity-access';
import { activityViewer } from './activity-roster';
import { eventRow } from './activity-arrangements';
// Audit snapshots are public event data. Imported JSON is not an authorization boundary.
// Keep known business fields, never serialize an arbitrary stored object or credential.
const fields=new Set(`event title category location starts_at deadline capacity description duration_hours status withdrawal_deadline visibility lifecycle registration_open actual_started_at actual_ended_at archived_at timezone minimum_participants formation_state fee_policy conditions_version cancellation_reason bot_enabled participants people attendee id nickname name note payer_kind manager_name payer_name withdrawal_requested withdrawal_reason created_at updated_at party_id queue_mode accepted_conditions_version confirmation_state attendance attendance_note arrived_at left_at confirmation accepted_version owner_name roles permissions target_name target_permissions kind expires_at invitation_id claim_id attendee_id superseded requester_name payer_id version total_amount state operation command report_id entry_id bill_version original_id outbox_id transaction amount_cents funding funder_id custodian_id from_id to_id reference_id actual_party_id method occurred_at reason parties rooms person_ids payer_label amount merchant_mode paid_amount`.split(/\s+/));
type Json=z.infer<ReturnType<typeof z.json>>;
function clean(value:unknown,depth=0):Json {
  if(depth>25)throw Error('Audit snapshot is too deeply nested');
  if(value===null||typeof value==='string'||typeof value==='boolean')return value;
  if(typeof value==='number'&&Number.isFinite(value))return value;
  if(Array.isArray(value))return value.map(item=>clean(item,depth+1));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>fields.has(key)).map(([key,item])=>[key,clean(item,depth+1)]));
  throw Error('Invalid audit snapshot');
}
function snapshot(raw:string,privateFinance:boolean):Record<string,Json>{
  const result=clean(JSON.parse(raw));
  if(!result||Array.isArray(result)||typeof result!=='object')throw Error('Invalid audit snapshot');
  if(privateFinance&&result.operation&&typeof result.operation==='object'&&!Array.isArray(result.operation))result.operation=Object.fromEntries(Object.entries(result.operation).filter(([key])=>['command','id','report_id'].includes(key)));
  if(privateFinance)return Object.fromEntries(Object.entries(result).filter(([key])=>['state','operation'].includes(key)));
  return result;
}
export function registerActivityHistory(app:FastifyInstance,db:DB,security:Security){
  app.get('/api/v2/activities/:id/history',async request=>db.transaction(()=>{
    const {id}=z.object({id:z.string().min(1).max(80)}).parse(request.params),{before}=z.object({before:z.string().regex(/^[0-9]{1,18}$/).optional()}).strict().parse(request.query);
    requireActivityAccess(db,id,activityViewer(security,request));
    const rows=db.prepare('SELECT CAST(id AS TEXT) AS id,version,actor_name,action,before_json,after_json,reason,created_at FROM event_audit WHERE event_id=? AND id<? ORDER BY event_audit.id DESC LIMIT 51').all(id,before?BigInt(before):9223372036854775807n) as {id:string;version:number;actor_name:string;action:string;before_json:string;after_json:string;reason:string;created_at:string}[];
    return {id,title:eventRow(db,id)!.title,entries:rows.slice(0,50).map(row=>{const privateFinance=['finance_report','finance_reject','finance_withdraw'].includes(row.action);return {id:row.id,version:row.version,actorName:row.actor_name,action:row.action,before:snapshot(row.before_json,privateFinance),after:snapshot(row.after_json,privateFinance),reason:privateFinance?'':row.reason,createdAt:row.created_at};}),nextBefore:rows.length>50?rows[49]!.id:null};
  })());
}
