import type { DB } from '@qgroup/database';
import { ActivityArrangementInput } from '@qgroup/contracts';
import { DomainError } from '@qgroup/domain';
import type { z } from 'zod';
import legacyTimezones from '../../../packages/domain/src/legacy-timezones.json';
const allowedTimezones=new Set(legacyTimezones);

export type EventRow = {
  id:string; owner_id:string; title:string; category:string; location:string; starts_at:string; deadline:string;
  capacity:number; description:string; duration_hours:number|null; status:string; revision:number; withdrawal_deadline:string|null;
  visibility:string; lifecycle:string; registration_open:number; actual_started_at:string|null; actual_ended_at:string|null;
  archived_at:string|null; timezone:string|null; minimum_participants:number; formation_state:string; fee_policy:string;
  conditions_version:number; change_summary:string; cancellation_reason:string; bot_enabled:number; draft_join_owner:number;
};
export function eventRow(db:DB,id:string) { return db.prepare('SELECT * FROM events WHERE id=?').get(id) as EventRow|undefined; }
export function eventScopes(db:DB,event:Pick<EventRow,'id'|'owner_id'>,userId:string):Set<string> {
  if(event.owner_id===userId)return new Set(['owner','schedule','roster','attendance','settlement']);
  const row=db.prepare('SELECT permissions_json FROM event_roles WHERE event_id=? AND user_id=?').get(event.id,userId) as {permissions_json:string}|undefined;
  const scopes:unknown=row?JSON.parse(row.permissions_json):[];
  if(!Array.isArray(scopes)||scopes.some(scope=>typeof scope!=='string'))throw Error('Invalid stored event scopes');
  return new Set(scopes as string[]);
}
export function legacyStamp(date:Date) { return date.toISOString().slice(0,19)+'+00:00'; }
/** Explicit-offset calendar timestamps only; Date.parse alone silently rolls February 30 forward. */
export function activityDate(value:string):string {
  const match=/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if(!match)throw new DomainError('INVALID_ACTIVITY_TIME','請填寫包含時區的有效活動時間',400);
  const [,year,month,day,hour,minute,second='00',fraction='',zone]=match;
  const y=Number(year),m=Number(month),d=Number(day);
  const days=new Date(Date.UTC(y===0?400:y,m,0)).getUTCDate();
  const offset=zone==='Z'?0:(Number(zone!.slice(1,3))*60+Number(zone!.slice(4,6)))*(zone![0]==='-'?-1:1);
  if(y<1||m<1||m>12||d<1||d>days||Number(hour)>23||Number(minute)>59||Number(second)>59||(zone!=='Z'&&(Number(zone!.slice(1,3))>23||Number(zone!.slice(4,6))>59)))throw new DomainError('INVALID_ACTIVITY_TIME','請填寫包含時區的有效活動時間',400);
  const date=new Date(0);date.setUTCFullYear(y,m-1,d);date.setUTCHours(Number(hour),Number(minute),Number(second),Number((fraction+'000').slice(0,3)));
  const utc=new Date(date.getTime()-offset*60000);
  if(utc.getUTCFullYear()<1||utc.getUTCFullYear()>9999)throw new DomainError('INVALID_ACTIVITY_TIME','活動時間超出範圍',400);
  return legacyStamp(utc);
}
export function arrangementValues(raw:z.infer<typeof ActivityArrangementInput>,now:Date,draft:boolean,existing?:EventRow) {
  const values=ActivityArrangementInput.parse(raw);
  values.startsAt=activityDate(values.startsAt);values.deadline=activityDate(values.deadline);
  if(!draft&&Date.parse(values.startsAt)<=now.getTime()&&(!existing||values.startsAt!==existing.starts_at))throw new DomainError('ACTIVITY_START_PASSED','新的活動開始時間需要晚於現在',400);
  if(values.deadline>values.startsAt)throw new DomainError('INVALID_ACTIVITY_DEADLINE','報名截止時間不能晚於活動開始時間',400);
  if(values.withdrawalDeadline!==null){values.withdrawalDeadline=activityDate(values.withdrawalDeadline);if(values.withdrawalDeadline>values.startsAt)throw new DomainError('INVALID_WITHDRAWAL_DEADLINE','退出期限不能晚於活動開始時間',400);}
  if(values.capacity&&values.minimumParticipants>values.capacity)throw new DomainError('INVALID_ACTIVITY_MINIMUM','最低成團人數不能超過人數上限',400);
  if(values.timezone!==null){
    // ICU also accepts offset zones in recent Node; the source contract is an IANA name.
    if(!allowedTimezones.has(values.timezone))throw new DomainError('INVALID_ACTIVITY_ZONE','請填寫有效的 IANA 時區',400);
    try{new Intl.DateTimeFormat('en',{timeZone:values.timezone});}catch{throw new DomainError('INVALID_ACTIVITY_ZONE','請填寫有效的 IANA 時區',400);}
  }
  if(values.visibility!=='public'&&values.botEnabled)throw new DomainError('INVITATION_BOT_SYNC','邀請可見活動不能同步到公開群，請先關閉群同步',400);
  return values;
}
const snapshotKeys=['title','category','location','starts_at','deadline','capacity','description','duration_hours','status','withdrawal_deadline','visibility','lifecycle','registration_open','actual_started_at','actual_ended_at','archived_at','timezone','minimum_participants','formation_state','fee_policy','conditions_version','cancellation_reason','bot_enabled'] as const;
export function eventSnapshot(event:EventRow){return Object.fromEntries(snapshotKeys.map(key=>[key,event[key]]));}
export function arrangementSnapshot(event:EventRow){return {category:event.category,starts_at:event.starts_at,duration_hours:event.duration_hours,location:event.location,description:event.description,withdrawal_deadline:event.withdrawal_deadline||event.deadline,timezone:event.timezone,fee_policy:event.fee_policy};}
export function removalBlocker(db:DB,event:EventRow):string {
  for(const table of ['settlements','settlement_history','finance_entries','finance_reports'])if(db.prepare('SELECT 1 FROM '+table+' WHERE event_id=? LIMIT 1').get(event.id))return '已有結算或款項記錄，請保留活動並使用歸檔';
  if(db.prepare('SELECT 1 FROM attendees WHERE event_id=? AND (user_id IS NULL OR user_id!=? OR manager_id!=?) LIMIT 1').get(event.id,event.owner_id,event.owner_id))return '已有其他人的報名記錄（含退出或代報名），請保留活動';
  if(db.prepare('SELECT 1 FROM event_roles WHERE event_id=? LIMIT 1').get(event.id))return '已有協辦參與管理，請保留活動';
  return '';
}
export function requireEventRevision(event:EventRow,revision:number){if(event.revision!==revision)throw new DomainError('ACTIVITY_CHANGED','活動或名單已有更新；輸入仍保留，請核對目前安排後再保存',409);}
export function appendEventAudit(db:DB,event:EventRow,user:{id:string;nickname:string},action:string,before:unknown,after:unknown,reason:string,stamp:string){
  if(JSON.stringify(before)===JSON.stringify(after))return false;
  db.prepare('UPDATE events SET revision=revision+1 WHERE id=?').run(event.id);
  const version=eventRow(db,event.id)!.revision;
  db.prepare('INSERT INTO event_audit(event_id,version,actor_id,actor_name,action,before_json,after_json,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(event.id,version,user.id,user.nickname,action,JSON.stringify(before),JSON.stringify(after),reason,stamp);
  return true;
}
