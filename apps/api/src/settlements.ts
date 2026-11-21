import { ActivityPath, ActivityVersionPath } from '@qgroup/contracts/http-paths';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DB } from '@qgroup/database';
import { PositiveVersionQuery,
  RoomPlanView,
  SaveRoomPlan,
  SaveSettlement,
  SettlementContext,
  SettlementHistory,
  SettlementInput,
  SettlementPreview,
  SettlementResult,
  SettlementView,
} from '@qgroup/contracts';
import { z } from 'zod';
import {
  eventRow,
  eventScopes,
  legacyStamp,
  requireEventRevision,
  type EventRow,
} from './activity-arrangements';
import { requireActivityAccess } from './activity-access';
import { createActivityBot, type ActivityBotDefaults } from './activity-bot';
import { hash, type Security } from './security';
import { financeEntries } from './finance-context';
import { projectJournal } from './finance-projection';
import { calculateSettlement, settlementToken } from './settlement-calculation';
import {
  requireSettlement,
  roomPlan,
  settlementBill,
  settlementFail as fail,
  settlementRoster,
} from './settlement-context';
import { settlementNotice } from './settlement-notice';
import { executeRoomPlan, requireRoomOwner, roomPlanBlocker } from './room-plan-command';
import { publishSettlement } from './settlement-command';
export function registerSettlements(
  app: FastifyInstance,
  db: DB,
  security: Security,
  now: () => Date,
  defaults: ActivityBotDefaults = {},
) {
  const bot = createActivityBot(db, now, defaults),limits = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } }, bodyLimit: 10 * 1024 * 1024 };
  function access(request: FastifyRequest) {
    const { id } = ActivityPath.parse(request.params),
      device = security.read(request);
    if (request.headers['x-account-scope'] || device) security.scoped(request);
    const viewer = device?.kind === 'member' ? device.id : null;
    requireActivityAccess(db, id, viewer);
    return { event: eventRow(db, id)!, viewer };
  }
  const canManage = (event: EventRow, id: string | null) => !!id && eventScopes(db, event, id).has('settlement');
  const planBlocker = (event: EventRow) => roomPlanBlocker(db, event);
  app.get('/api/v2/activities/:id/settlement', async (request) =>
    db.transaction(() => {
      const { event, viewer } = access(request);
      return SettlementView.parse({
        id: event.id,
        title: event.title,
        revision: event.revision,
        can_manage: canManage(event, viewer),
        bill: settlementBill(db, event.id),
      });
    })(),
  );
  app.get('/api/v2/activities/:id/settlement/context', async (request) =>
    db.transaction(() => {
      const user = security.scopedMember(request),
        { event } = access(request);
      requireSettlement(db, event, user.id);
      const ctx = settlementRoster(db, event, user),
        entries = financeEntries(db, event.id),
        state = projectJournal(entries),
        active = entries.filter((e) => state.expenses.has(e.id) || state.deposits.has(e.id));
      return SettlementContext.parse({
        ...ctx,
        id: event.id,
        title: event.title,
        revision: event.revision,
        lifecycle: event.lifecycle,
        is_owner: event.owner_id === user.id,
        can_manage: true,
        has_merchant_records: !!(state.expenses.size || state.deposits.size),
        rooms: roomPlan(db, event.id).rooms,
        room_record_ids: [...new Set(active.flatMap((e) => (e.payload.room_id ? [e.payload.room_id] : [])))].sort(),
        bill: settlementBill(db, event.id),
      });
    })(),
  );
  app.get('/api/v2/activities/:id/settlement/history', async (request) =>
    db.transaction(() => {
      const { event } = access(request),
        query = PositiveVersionQuery.parse(request.query),
        rows = db
          .prepare(
            'SELECT version FROM settlement_history WHERE event_id=? AND version<? ORDER BY version DESC LIMIT 51',
          )
          .all(event.id, query.before ?? Number.MAX_SAFE_INTEGER) as { version: number }[];
      return SettlementHistory.parse({
        revisions: rows.slice(0, 50).map((r) => settlementBill(db, event.id, r.version)),
        next_before: rows.length > 50 ? rows[49]!.version : null,
      });
    })(),
  );
  app.get('/api/v2/activities/:id/settlement/history/:version', async (request) =>
    db.transaction(() => {
      const { event } = access(request),
        input = ActivityVersionPath.parse(request.params),
        bill = settlementBill(db, event.id, input.version);
      if (!bill) fail('結算版本不存在', 404);
      return bill;
    })(),
  );
  app.post('/api/v2/activities/:id/settlement/preview', limits, async (request) =>
    db.transaction(() => {
      const user = security.memberWrite(request),
        { event } = access(request),
        input = SettlementInput.parse(request.body);
      requireEventRevision(event, input.revision);
      const { snapshot } = calculateSettlement(db, event, user, input, now());
      return SettlementPreview.parse({
        snapshot,
        group_preview: snapshot.group_notice ? settlementNotice(snapshot).join('\n') : '',
        preview_token: settlementToken(event, snapshot, input.base_version),
        base_revision: event.revision,
        base_version: input.base_version,
      });
    })(),
  );
  app.post('/api/v2/activities/:id/settlement', limits, async (request) =>
    db
      .transaction(() => {
        const user = security.memberWrite(request),
          { event } = access(request),
          input = SaveSettlement.parse(request.body),
          key = z.string().uuid().parse(request.headers['idempotency-key']),
          signature = 'settlement:' + encodeURIComponent(event.id) + ':' + hash(JSON.stringify(input));
        requireSettlement(db, event, user.id);
        const old = db
          .prepare('SELECT signature,response_json FROM request_results WHERE user_id=? AND request_key=?')
          .get(user.id, key) as { signature: string; response_json: string } | undefined;
        if (old) {
          if (old.signature !== signature) fail('這個操作編號已用於另一份內容', 409);
          return SettlementResult.parse(JSON.parse(old.response_json));
        }
        requireEventRevision(event, input.revision);
        const { preview_token, confirm, ...calculation } = input;
        void confirm;
        const { snapshot, images, codes } = calculateSettlement(db, event, user, calculation, now());
        if (preview_token !== settlementToken(event, snapshot, input.base_version))
          fail('費用、圖片、款項或名單已改變，請重新預覽再發布', 409);
        const time = now(), result = publishSettlement(db, event, user, input.base_version, { snapshot, images, codes }, () => time, bot,
          eventId => app.log.error({ eventId }, 'Settlement bot hook failed; business write preserved'));
        const stamp = legacyStamp(time);
        db.prepare('INSERT INTO request_results VALUES(?,?,?,?,?,?)').run(
          user.id,
          key,
          signature,
          JSON.stringify(result),
          200,
          stamp,
        );
        return result;
      })
      .immediate(),
  );
  app.get('/api/v2/activities/:id/rooms', async (request) =>
    db.transaction(() => {
      const user = security.scopedMember(request),
        { event } = access(request);
      requireSettlement(db, event, user.id);
      const plan = roomPlan(db, event.id);
      return RoomPlanView.parse({
        ...settlementRoster(db, event, user),
        people: settlementRoster(db, event, user).people.filter((p) => p.status !== 'withdrawn'),
        id: event.id,
        title: event.title,
        revision: event.revision,
        version: plan.version,
        can_manage: event.owner_id === user.id && !planBlocker(event),
        blocked_reason: event.owner_id !== user.id ? '只有發起者可以分配包間及指定付款人' : planBlocker(event),
        rooms: plan.rooms,
      });
    })(),
  );
  app.post('/api/v2/activities/:id/rooms', limits, async (request) =>
    db
      .transaction(() => {
        const user = security.memberWrite(request),
          { event } = access(request),
          input = SaveRoomPlan.parse(request.body),
          key = z.string().uuid().parse(request.headers['idempotency-key']),
          signature = 'rooms:' + encodeURIComponent(event.id) + ':' + hash(JSON.stringify(input));
        requireRoomOwner(event, user.id);
        const old = db
          .prepare('SELECT signature,response_json FROM request_results WHERE user_id=? AND request_key=?')
          .get(user.id, key) as { signature: string; response_json: string } | undefined;
        if (old) {
          if (old.signature !== signature) fail('這個操作編號已用於另一份內容', 409);
          return SettlementResult.parse(JSON.parse(old.response_json));
        }
        const time = now(), result = executeRoomPlan(db, event, user, input, time), stamp = legacyStamp(time);
        db.prepare('INSERT INTO request_results VALUES(?,?,?,?,?,?)').run(
          user.id,
          key,
          signature,
          JSON.stringify(result),
          200,
          stamp,
        );
        return result;
      })
      .immediate(),
  );
}
