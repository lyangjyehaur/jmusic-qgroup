import { withApiError } from './error-display';
import { eventRow } from './activity-arrangements';
import { financeSummary } from './finance-context';
import { randomUUID } from 'node:crypto';
import type { DB } from '@qgroup/database';
import {musicProfileActiveSQL} from '@qgroup/database';
import type { ActivityView, MusicEntry, MusicProfile, SaveProfileInput } from '@qgroup/contracts';
import { activityState, DomainError, validateSelections } from '@qgroup/domain';
import { requireActivityAccess } from './activity-access';

interface EventRow {
  id: string; title: string; category: string; location: string; starts_at: string; deadline: string;
  duration_hours: number | null; timezone: string | null; description: string; capacity: number;
  minimum_participants: number; lifecycle: string; archived_at: string | null; status: string;
  registration_open: number; confirmed: number; waiting: number; tentative: number;
  fee_policy:string;withdrawal_deadline:string|null;conditions_version:number;change_summary:string;visibility:string;
}
const eventProjection = `SELECT e.*,
 (SELECT COUNT(*) FROM attendees a WHERE a.event_id=e.id AND a.status='confirmed') AS confirmed,
 (SELECT COUNT(*) FROM attendees a WHERE a.event_id=e.id AND a.status='waiting') AS waiting,
 (SELECT COUNT(*) FROM attendees a WHERE a.event_id=e.id AND a.status='tentative') AS tentative
 FROM events e`;
const publicEvents = eventProjection + " WHERE e.visibility='public' AND e.lifecycle!='draft' AND e.status!='deleted'";
function serializeEvent(row: EventRow, now: Date): ActivityView {
  return { id: row.id, title: row.title, category: row.category, location: row.location, startsAt: row.starts_at,
    deadline: row.deadline, durationHours: row.duration_hours, timezone: row.timezone,
    description: row.description, capacity: row.capacity, minimumParticipants: row.minimum_participants,
    lifecycle: row.lifecycle, ...activityState(row, now), archived: !!row.archived_at,
    confirmed: row.confirmed, waiting: row.waiting, tentative: row.tentative,
    feePolicy:row.fee_policy,withdrawalDeadline:row.withdrawal_deadline,conditionsVersion:row.conditions_version,changeSummary:row.change_summary,visibility:row.visibility };
}
type ListFilters = { q?: string; status?: string };
function listStatus(event: ActivityView) {
  if (event.archived) return 'archived';
  if (event.estimatedOver) return 'ended';
  if (['draft','ongoing','ended','cancelled'].includes(event.phase)) return event.phase;
  if (!event.registrationOpen) return 'paused';
  return event.capacity > 0 && event.confirmed >= event.capacity ? 'full' : 'open';
}
function matchesListFilters(event: ActivityView, filters: ListFilters) {
  const q = (filters.q ?? '').trim().toLocaleLowerCase();
  return (!q || (event.title + ' ' + event.location + ' ' + event.category).toLocaleLowerCase().includes(q)) &&
    (!filters.status || filters.status === 'all' || listStatus(event) === filters.status);
}
function ownRegistration(db: DB, eventId: string, userId: string | null) {
  if (!userId) return null;
  return (db.prepare("SELECT status FROM attendees WHERE event_id=? AND user_id=? AND status IN ('confirmed','waiting','tentative') ORDER BY created_at,id LIMIT 1").get(eventId,userId) as {status:'confirmed'|'waiting'|'tentative'}|undefined)?.status ?? null;
}
/** Same participation rule as the existing personal list; an access grant alone is not participation. */
function myActivityRows(db: DB, userId: string) {
  const rows=db.prepare(eventProjection+" WHERE e.status!='deleted' AND ((e.lifecycle='draft' AND (e.owner_id=? OR EXISTS(SELECT 1 FROM event_roles r WHERE r.event_id=e.id AND r.user_id=?))) OR (e.lifecycle!='draft' AND (e.visibility='public' OR e.owner_id=? OR EXISTS(SELECT 1 FROM event_access x WHERE x.event_id=e.id AND x.user_id=?)))) ORDER BY e.starts_at DESC,e.id").all(userId,userId,userId,userId) as (EventRow&{owner_id:string})[];
  return rows.filter(event=>event.owner_id===userId||!!db.prepare('SELECT 1 FROM event_roles WHERE event_id=? AND user_id=?').get(event.id,userId)||!!db.prepare("SELECT 1 FROM attendees WHERE event_id=? AND status NOT IN ('withdrawn','invited') AND (user_id=? OR manager_id=?)").get(event.id,userId,userId)||financeSummary(db,eventRow(db,event.id)!,userId).my_balance_cents!==null);
}
function isHistoricalActivity(event: ActivityView) {
  return event.archived || event.estimatedOver || ['ended','cancelled'].includes(event.phase);
}
function listSummary(db: DB, userId: string | null, now: Date) {
  const upcoming=(db.prepare(publicEvents).all() as EventRow[]).filter(row=>!isHistoricalActivity(serializeEvent(row,now))).length;
  return { upcoming, mine:userId ? myActivityRows(db,userId).length : null };
}
export function listActivities(db: DB, page: number, period: 'upcoming' | 'history', now: Date, filters: ListFilters = {}, userId: string | null = null) {
  // Search/status are applied to the complete authorized collection before pagination.
  // Browse by planned end without changing actual lifecycle or settlement records.
  const rows = db.prepare(publicEvents + ` ORDER BY e.starts_at ${period === 'history' ? 'DESC' : 'ASC'},e.id`).all() as EventRow[];
  const events=rows.map(row=>serializeEvent(row,now)).filter(event=>isHistoricalActivity(event)===(period==='history')&&matchesListFilters(event,filters)),start=(page-1)*20;
  return { events:events.slice(start,start+20).map(event=>({...event,myRegistration:ownRegistration(db,event.id,userId)})), page, hasMore:events.length>start+20,total:events.length,summary:listSummary(db,userId,now) };
}
export function listMyActivities(db:DB,userId:string,page:number,now:Date,filters:ListFilters={}){
  const events=myActivityRows(db,userId).map(row=>serializeEvent(row,now)).filter(event=>matchesListFilters(event,filters)),start=(page-1)*20;
  return {events:events.slice(start,start+20).map(event=>({...event,myRegistration:ownRegistration(db,event.id,userId)})),page,hasMore:events.length>start+20,total:events.length,summary:listSummary(db,userId,now)};
}
export function getActivity(db: DB, id: string, now: Date, viewerId: string | null = null) {
  requireActivityAccess(db,id,viewerId);
  const row = db.prepare(eventProjection + ' WHERE e.id=?').get(id) as EventRow | undefined;
  if (!row) throw withApiError(new DomainError('NOT_FOUND', '找不到活動或尚未公開', 404));
  return serializeEvent(row, now);
}
export function catalog(db: DB): MusicEntry[] {
  return db.prepare('SELECT id,name,kind FROM music_entries ORDER BY kind,name,id').all() as MusicEntry[];
}
export function getProfile(db: DB, userId: string): MusicProfile {
  const row = db.prepare(`SELECT id,revision,updated_at FROM music_profiles WHERE user_id=? AND ${musicProfileActiveSQL('music_profiles')}`).get(userId) as { id: string; revision: number; updated_at: string } | undefined;
  if (!row) return null;
  const selections = db.prepare('SELECT entry_id AS entryId,level FROM music_selections WHERE profile_id=? ORDER BY position').all(row.id) as NonNullable<MusicProfile>['selections'];
  return { id: row.id, revision: row.revision, updatedAt: row.updated_at, selections };
}
/** Called inside the same IMMEDIATE transaction as the request result. */
export function saveProfile(db: DB, userId: string, input: SaveProfileInput, now: Date): NonNullable<MusicProfile> {
  const before = getProfile(db, userId);
  if ((before?.id ?? null) !== input.profileId || (before?.revision ?? 0) !== input.revision) throw withApiError(new DomainError('REVISION_CONFLICT', '成分已有更新；你的選擇仍保留，請核對最新版本', 409));
  const epoch = (db.prepare('SELECT epoch FROM music_account_epochs WHERE user_id=?').get(userId) as { epoch: number } | undefined)?.epoch ?? 0;
  if (input.musicEpoch !== epoch) throw withApiError(new DomainError('PROFILE_ERASED', '成分已刪除或重建，請核對目前狀態後再明確保存', 409));
  if (!before && db.prepare(`SELECT 1 FROM music_claim_intents i JOIN music_profiles p ON p.id=i.profile_id WHERE i.target_user_id=? AND i.stage!='completed' AND i.expires_at>? AND ${musicProfileActiveSQL('p')}`).get(userId, now.toISOString())) throw withApiError(new DomainError('MUSIC_CLAIM_PENDING', '正在找回舊成分；請先完成或取消找回，再建立新成分', 409));
  validateSelections(input.selections, catalog(db));
  const id = before?.id ?? 'm_' + randomUUID().replaceAll('-', '');
  const updatedAt = now.toISOString();
  const revision = input.revision + 1;
  if (before) db.prepare('UPDATE music_profiles SET revision=?,updated_at=? WHERE id=?').run(revision, updatedAt, id);
  else {
    db.prepare('INSERT INTO music_profiles(id,user_id,revision,updated_at) VALUES(?,?,?,?)').run(id, userId, revision, updatedAt);
    const account = db.prepare('SELECT nickname FROM users WHERE id=?').get(userId) as { nickname: string };
    db.prepare("INSERT INTO music_profile_fields VALUES(?,?,'',0,'',0,0,?)").run(id, account.nickname, updatedAt);
  }
  db.prepare('DELETE FROM music_selections WHERE profile_id=?').run(id);
  const insert = db.prepare('INSERT INTO music_selections VALUES(?,?,?,?)');
  input.selections.forEach((s, position) => insert.run(id, s.entryId, s.level, position));
  const after = { id, revision, selections: input.selections, updatedAt };
  db.prepare('INSERT INTO music_profile_audit(profile_id,revision,actor_id,before_json,after_json,created_at) VALUES(?,?,?,?,?,?)')
    .run(id, revision, userId, JSON.stringify(before), JSON.stringify(after), updatedAt);
  return after;
}
