import { ActivityPath, ActivityVersionPath } from '@qgroup/contracts/http-paths';
import { withApiError } from './error-display';
import type { FastifyInstance } from 'fastify';
import type { DB } from '@qgroup/database';
import { PositiveVersionQuery, ActivityRoomOverview, RoomPlanHistory, SettlementRoom } from '@qgroup/contracts';
import { z } from 'zod';
import { DomainError } from '@qgroup/domain';
import { activityRoster, activityViewer } from './activity-roster';
import { requireActivityAccess } from './activity-access';
import { eventRow } from './activity-arrangements';
import { roomPlan, settlementDetail, settlementVersion } from './settlement-context';
import type { Security } from './security';
type Room = z.infer<typeof SettlementRoom>;
export function activityRoomOverview(db: DB, id: string, viewer: string | null, historical?: number) {
  const access = requireActivityAccess(db, id, viewer),
    event = eventRow(db, id)!,
    live = activityRoster(db, id, viewer).participants;
  const invoice = historical === undefined ? settlementDetail(db, id) : null;
  let rooms: Room[], kind: 'none' | 'plan' | 'actual', version: number, created: string | null;
  if (historical !== undefined) {
    const row = db
      .prepare('SELECT snapshot_json,created_at FROM event_room_plans WHERE event_id=? AND version=?')
      .get(id, historical) as { snapshot_json: string; created_at: string } | undefined;
    if (!row) throw withApiError(new DomainError('ROOM_PLAN_NOT_FOUND', '找不到這版預分安排', 404));
    rooms = z.array(SettlementRoom).parse(JSON.parse(row.snapshot_json));
    kind = 'plan';
    version = historical;
    created = row.created_at;
  } else if (invoice?.rooms) {
    rooms = invoice.rooms;
    kind = 'actual';
    version = settlementVersion(db, id);
    created = (
      db
        .prepare('SELECT updated_at FROM settlement_history WHERE event_id=? AND version=?')
        .get(id, version) as { updated_at: string }
    ).updated_at;
  } else {
    const plan = roomPlan(db, id);
    rooms = plan.rooms;
    version = plan.version;
    kind = plan.version ? 'plan' : 'none';
    const row = db
      .prepare('SELECT created_at FROM event_room_plans WHERE event_id=? AND version=?')
      .get(id, version) as { created_at: string } | undefined;
    created = row?.created_at ?? null;
  }
  const people =
    kind === 'actual' && invoice
      ? invoice.people.map((p) => ({
          id: p.id,
          name: p.label,
          status: p.status,
        }))
      : live.map((p) => ({
          id: p.id,
          name: p.name + (live.filter((q) => q.name === p.name).length > 1 ? ' · ' + p.position : ''),
          status: p.status,
        }));
  const member = (personId: string) => {
    const person = people.find((p) => p.id === personId),
      current = live.find((p) => p.id === personId);
    return {
      id: personId,
      name: person?.name ?? '名單已變更',
      status: person?.status ?? '',
      is_me: !!current?.isMe,
      managed_guest: !!current?.isGuest && current.managedByMe,
      missing: !person,
    };
  };
  const mine = live.find((p) => p.isMe),
    assigned = new Set(rooms.flatMap((r) => r.person_ids));
  return ActivityRoomOverview.parse({
    id,
    title: event.title,
    revision: access.revision,
    kind,
    version,
    created_at: created,
    historical: historical !== undefined,
    can_manage:
      historical === undefined &&
      viewer === event.owner_id &&
      !event.archived_at &&
      !['draft', 'cancelled'].includes(event.lifecycle) &&
      !settlementVersion(db, id),
    my_room_id: mine ? (rooms.find((r) => r.person_ids.includes(mine.id))?.id ?? null) : null,
    has_self: !!mine,
    self_waiting: mine?.status === 'waiting',
    rooms: rooms.map((r) => ({
      id: r.id,
      name: r.name,
      payer_name: r.payer_label || r.payer_name,
      people: r.person_ids.map(member),
    })),
    unassigned: people
      .filter((p) => !assigned.has(p.id) && ['confirmed', 'waiting', 'tentative'].includes(p.status))
      .map((p) => member(p.id)),
  });
}
export function registerActivityRooms(app: FastifyInstance, db: DB, security: Security) {

  app.get('/api/v2/activities/:id/rooms/overview', async (request) =>
    db.transaction(() =>
      activityRoomOverview(db, ActivityPath.parse(request.params).id, activityViewer(security, request)),
    )(),
  );
  app.get('/api/v2/activities/:id/rooms/history/:version', async (request) =>
    db.transaction(() => {
      const input = ActivityVersionPath.parse(request.params);
      return activityRoomOverview(db, input.id, activityViewer(security, request), input.version);
    })(),
  );
  app.get('/api/v2/activities/:id/rooms/history', async (request) =>
    db.transaction(() => {
      const { id } = ActivityPath.parse(request.params),
        { before } = PositiveVersionQuery.parse(request.query);
      requireActivityAccess(db, id, activityViewer(security, request));
      const rows = db
        .prepare(
          'SELECT version,created_at,snapshot_json FROM event_room_plans WHERE event_id=? AND version<=? ORDER BY version DESC LIMIT 51',
        )
        .all(id, before === undefined ? Number.MAX_SAFE_INTEGER : before - 1) as {
        version: number;
        created_at: string;
        snapshot_json: string;
      }[];
      return RoomPlanHistory.parse({
        id,
        title: eventRow(db, id)!.title,
        revisions: rows.slice(0, 50).map((r) => ({
          version: r.version,
          created_at: r.created_at,
          room_count: z.array(SettlementRoom).parse(JSON.parse(r.snapshot_json)).length,
        })),
        next_before: rows.length > 50 ? rows[49]!.version : null,
      });
    })(),
  );
}
