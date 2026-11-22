import { randomUUID } from 'node:crypto';
import type { DB } from '@qgroup/database';
import { DomainError } from '@qgroup/domain';
import { botShareable,activityBotPolicy,createActivityBot,type ActivityBotDefaults } from './activity-bot';
import { legacyStamp,type EventRow } from './activity-arrangements';
import { settlementVersion } from './settlement-context';
export type RetryNotice={id:string;event_id:string|null;poll_id:string|null;kind:string;target:string;payload_json:string;due_at:string|null;status:string;last_error:string};
/** Original recovery retains the original delivery intent; newer native review is separate. */
export function prepareOriginalActivityRetry(db:DB,event:EventRow,id:number,time:Date,defaults:ActivityBotDefaults){
 const config=activityBotPolicy(db,defaults).config;
 if(!config.enabled||!botShareable(event))throw new DomainError('BOT_RETRY_BLOCKED','目前活動未開啟公開群同步，無法重送',409);
 const row=db.prepare("SELECT CAST(id AS TEXT) id,event_id,poll_id,kind,target,payload_json,due_at,status,last_error FROM bot_outbox WHERE id=? AND event_id=? AND channel='group'").get(id,event.id) as RetryNotice|undefined;
 if(!row||!(row.status==='failed'||row.last_error==='dry-run'))throw new DomainError('BOT_RETRY_BLOCKED','只能重送失敗或模擬的通知',409);
 const payload:Record<string,unknown>=JSON.parse(row.payload_json);
 if(!payload||typeof payload!=='object'||Array.isArray(payload))throw new DomainError('BOT_RETRY_BLOCKED','原通知內容無法驗證；請保全並核對原紀錄',409);
 if(payload._settlement_version&&payload._settlement_version!==settlementVersion(db,event.id))throw new DomainError('BOT_RETRY_BLOCKED','結算已更新，請使用新版通知，不能重送舊收款碼',409);
 if(db.prepare("SELECT 1 FROM bot_outbox WHERE event_id=? AND kind=? AND payload_json=? AND status IN ('pending','sending')").get(event.id,row.kind,row.payload_json))throw new DomainError('BOT_RETRY_BLOCKED','這條通知已有待送工作，請等待投遞結果',409);
 if(row.kind==='deadline_reminder'||row.kind==='estimated_over_reminder'){
  const plan=createActivityBot(db,()=>time,defaults).reminderPlan(event,row.kind,config);
  if(!plan||payload._schedule_key!==plan.key)throw new DomainError('BOT_RETRY_BLOCKED','活動安排已變更，請使用新版提醒，不能重送舊提醒',409);
 }
 return row;
}
/** Caller completes audit and receipt inside its required business transaction. */
export function insertBotRetry(db:DB,row:Pick<RetryNotice,'event_id'|'poll_id'|'kind'|'target'|'payload_json'|'due_at'>,time:Date){
 return (db.prepare("INSERT INTO bot_outbox(event_id,poll_id,kind,dedupe_key,channel,target,payload_json,due_at,status,created_at) VALUES(?,?,?,?,'group',?,?,?,'pending',?) RETURNING CAST(id AS TEXT) id").get(row.event_id,row.poll_id,row.kind,'retry:'+randomUUID().replaceAll('-',''),row.target,row.payload_json,row.due_at,legacyStamp(time)) as {id:string}).id;
}
