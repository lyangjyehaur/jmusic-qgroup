import type { DB } from '@qgroup/database';
import type { z } from 'zod';
import type { SaveRoomPlan } from '@qgroup/contracts';
import { appendEventAudit, eventRow, legacyStamp, requireEventRevision, type EventRow } from './activity-arrangements';
import { canonicalSettlement } from './settlement-calculation';
import { journalRoomIds, normalizeRooms, roomPlan, settlementFail as fail, settlementRoster, settlementVersion } from './settlement-context';
import { musicRoomSource } from './music-room-source';

export const roomPlanBlocker = (db: DB, event: EventRow) =>
  event.archived_at || ['draft', 'cancelled'].includes(event.lifecycle) || settlementVersion(db, event.id)
    ? '目前不能修改預分包間；已發布帳單請在結算中更正實際包間' : '';
export function requireRoomOwner(event: EventRow, userId: string) {
  if (event.owner_id !== userId) fail('只有發起者可以分配包間及指定付款人', 403);
}
export function prepareRoomPlan(db: DB, event: EventRow, user: { id: string; nickname: string }, input: z.infer<typeof SaveRoomPlan>) {
  requireRoomOwner(event, user.id);
  requireEventRevision(event, input.revision);
  const blocker = roomPlanBlocker(db, event);
  if (blocker) fail(blocker, 409);
  if (input.music_source_version && musicRoomSource(db, user.id, event.id).source.sourceVersion !== input.music_source_version)
    fail('分房試算來源已變更；請重新試算，或明確轉為手動安排後核對保存', 409);
  const ctx = settlementRoster(db, event, user), before = roomPlan(db, event.id),
    rooms = normalizeRooms(input.rooms, new Map(ctx.people.filter(p => p.status !== 'withdrawn').map(p => [p.id, p])), new Map(ctx.payers.map(p => [p.id, p.name])))
      .map(r => ({ ...r, payer_label: ctx.payers.find(p => p.id === r.payer_id)!.label })),
    changed = canonicalSettlement(before.rooms) !== canonicalSettlement(rooms), next = before.version + (changed ? 1 : 0);
  if (changed && [...journalRoomIds(db, event.id)].some(id => !rooms.some(r => r.id === id)))
    fail('已有款項的包間須保留；先在帳本核對並沖正錯誤款項', 409);
  return { ctx, before, rooms, changed, next };
}
export function executeRoomPlan(db: DB, event: EventRow, user: { id: string; nickname: string }, input: z.infer<typeof SaveRoomPlan>, now: Date) {
  const plan = prepareRoomPlan(db, event, user, input), stamp = legacyStamp(now);
  if (plan.changed) {
    db.prepare('INSERT INTO event_room_plans VALUES(?,?,?,?)').run(event.id, plan.next, JSON.stringify(plan.rooms), stamp);
    appendEventAudit(db, event, user, 'rooms_updated', { rooms: plan.before.rooms }, { rooms: plan.rooms }, input.reason, stamp);
  }
  return { id: event.id, revision: eventRow(db, event.id)!.revision, version: plan.next, changed: plan.changed };
}
