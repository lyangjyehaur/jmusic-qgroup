import { randomUUID } from 'node:crypto';
import type { DB } from '@qgroup/database';
import type { ActivityView, MusicEntry, MusicProfile, SaveProfileInput } from '@qgroup/contracts';
import { activityState, DomainError, validateSelections } from '@qgroup/domain';
import { requireActivityAccess } from './activity-access';

interface EventRow {
  id: string; title: string; category: string; location: string; starts_at: string; deadline: string;
  duration_hours: number | null; timezone: string | null; description: string; capacity: number;
  minimum_participants: number; lifecycle: string; archived_at: string | null; status: string;
  registration_open: number; confirmed: number; waiting: number; tentative: number;
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
    confirmed: row.confirmed, waiting: row.waiting, tentative: row.tentative };
}
export function listActivities(db: DB, page: number, period: 'upcoming' | 'history', now: Date) {
  // Estimated end never changes a scheduled event into historical actual completion.
  const condition = period === 'history' ? "(e.archived_at IS NOT NULL OR e.lifecycle IN ('ended','cancelled'))" : "(e.archived_at IS NULL AND e.lifecycle NOT IN ('ended','cancelled'))";
  const rows = db.prepare(publicEvents + ' AND ' + condition + ` ORDER BY e.starts_at ${period === 'history' ? 'DESC' : 'ASC'},e.id LIMIT 21 OFFSET ?`).all((page - 1) * 20) as EventRow[];
  return { events: rows.slice(0, 20).map(r => serializeEvent(r, now)), page, hasMore: rows.length > 20 };
}
export function getActivity(db: DB, id: string, now: Date, viewerId: string | null = null) {
  requireActivityAccess(db,id,viewerId);
  const row = db.prepare(eventProjection + ' WHERE e.id=?').get(id) as EventRow | undefined;
  if (!row) throw new DomainError('NOT_FOUND', '找不到活動或尚未公開', 404);
  return serializeEvent(row, now);
}
export function catalog(db: DB): MusicEntry[] {
  return db.prepare('SELECT id,name,kind FROM music_entries ORDER BY kind,name,id').all() as MusicEntry[];
}
export function getProfile(db: DB, userId: string): MusicProfile {
  const row = db.prepare('SELECT id,revision,updated_at FROM music_profiles WHERE user_id=? AND erased_at IS NULL').get(userId) as { id: string; revision: number; updated_at: string } | undefined;
  if (!row) return null;
  const selections = db.prepare('SELECT entry_id AS entryId,level FROM music_selections WHERE profile_id=? ORDER BY position').all(row.id) as NonNullable<MusicProfile>['selections'];
  return { id: row.id, revision: row.revision, updatedAt: row.updated_at, selections };
}
/** Called inside the same IMMEDIATE transaction as the request result. */
export function saveProfile(db: DB, userId: string, input: SaveProfileInput, now: Date): NonNullable<MusicProfile> {
  const before = getProfile(db, userId);
  if ((before?.id ?? null) !== input.profileId || (before?.revision ?? 0) !== input.revision) throw new DomainError('REVISION_CONFLICT', '成分已有更新；你的選擇仍保留，請核對最新版本', 409);
  const epoch = (db.prepare('SELECT epoch FROM music_account_epochs WHERE user_id=?').get(userId) as { epoch: number } | undefined)?.epoch ?? 0;
  if (input.musicEpoch !== epoch) throw new DomainError('PROFILE_ERASED', '成分已刪除或重建，請核對目前狀態後再明確保存', 409);
  if (!before && db.prepare("SELECT 1 FROM music_claim_intents WHERE target_user_id=? AND stage!='completed' AND expires_at>?").get(userId, now.toISOString())) throw new DomainError('MUSIC_CLAIM_PENDING', '正在找回舊成分；請先完成或取消找回，再建立新成分', 409);
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
