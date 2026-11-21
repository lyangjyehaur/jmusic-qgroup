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
  appendEventAudit,
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
import { canonicalSettlement, calculateSettlement, settlementToken, storedSettlement } from './settlement-calculation';
import {
  journalRoomIds,
  money,
  normalizeRooms,
  requireSettlement,
  roomPlan,
  settlementBill,
  settlementDetail,
  settlementFail as fail,
  settlementRoster,
  settlementVersion,
} from './settlement-context';
import { settlementNotice } from './settlement-notice';
import { musicRoomSource } from './music-room-source';
import { attachPaymentCodes } from './payment-codes';
import { putPaymentImage } from './payment-media';
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
  const planBlocker = (event: EventRow) =>
    event.archived_at || ['draft', 'cancelled'].includes(event.lifecycle) || settlementVersion(db, event.id)
      ? '目前不能修改預分包間；已發布帳單請在結算中更正實際包間'
      : '';
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
        const previous = settlementDetail(db, event.id),
          comparable = ({ reason, changes, ...rest }: typeof snapshot) => {
            void reason;
            void changes;
            return rest;
          },
          changed =
            !previous || canonicalSettlement(comparable(previous)) !== canonicalSettlement(comparable(snapshot)),
          next = input.base_version + (changed ? 1 : 0),
          stamp = legacyStamp(now());
        if (changed) {
          const fields = (
              [
                'people',
                'items',
                'payers',
                'note',
                'qr_digest',
                'payment_codes',
                'collector',
                'merchant_payment',
                'merchant_payments',
                'rooms',
                'group_notice',
              ] as const
            ).filter((k) => !previous || canonicalSettlement(previous[k]) !== canonicalSettlement(snapshot[k])),
            row = db.prepare('SELECT total_cents FROM settlements WHERE event_id=?').get(event.id) as
              | { total_cents: number }
              | undefined;
          db.prepare(
            'INSERT INTO settlement_history(event_id,version,total_cents,headcount,note,qr_image,updated_at,actor_id,actor_name,kind,changed_fields) VALUES(?,?,?,?,?,NULL,?,?,?,?,?)',
          ).run(
            event.id,
            next,
            snapshot.total_cents,
            Math.max(1, snapshot.people.length),
            snapshot.note,
            stamp,
            user.id,
            user.nickname,
            previous ? 'detailed_edited' : row ? 'converted' : 'detailed_published',
            JSON.stringify(fields),
          );
          db.prepare('INSERT INTO settlement_details VALUES(?,?,?)').run(event.id, next, storedSettlement(snapshot));
          attachPaymentCodes(db, event.id, next, codes, now());
          for (const [id, raw] of images)
            db.prepare('INSERT INTO settlement_receipt_images VALUES(?,?,?,?)').run(
              event.id,
              next,
              id,
              putPaymentImage(db, raw, now()),
            );
          db.prepare(
            'INSERT INTO settlements(event_id,total_cents,headcount,qr_image,note,updated_at) VALUES(?,?,?,NULL,?,?) ON CONFLICT(event_id) DO UPDATE SET total_cents=excluded.total_cents,headcount=excluded.headcount,qr_image=NULL,note=excluded.note,updated_at=excluded.updated_at',
          ).run(event.id, snapshot.total_cents, Math.max(1, snapshot.people.length), snapshot.note, stamp);
          const txs = [
            ...(snapshot.merchant_payments ?? []).map((tx, i) => ({ tx, suffix: 'room:' + i })),
            ...(snapshot.merchant_payment ? [{ tx: snapshot.merchant_payment, suffix: 'expense' }] : []),
          ];
          for (const { tx, suffix } of txs) {
            const id = hash(event.id + ':settlement:' + next + ':' + suffix).slice(0, 16);
            db.prepare(
              'INSERT INTO finance_entries(id,event_id,kind,payload_json,occurred_at,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?)',
            ).run(id, event.id, 'expense', JSON.stringify(tx), tx.occurred_at!, user.id, user.nickname, stamp);
            appendEventAudit(
              db,
              event,
              user,
              'finance_record',
              {},
              { operation: { id, transaction: tx } },
              snapshot.reason,
              stamp,
            );
          }
          appendEventAudit(
            db,
            event,
            user,
            'settlement_saved',
            row ? { version: input.base_version, total_amount: money(row.total_cents) } : {},
            { version: next, total_amount: money(snapshot.total_cents), mode: 'detailed', changed_fields: fields },
            snapshot.reason,
            stamp,
          );
          for (const recipient of db
            .prepare("SELECT DISTINCT manager_id FROM attendees WHERE event_id=? AND status!='invited'")
            .all(event.id) as { manager_id: string }[])
            db.prepare(
              "INSERT INTO notifications(user_id,event_id,kind,message,created_at) VALUES(?,?,'settlement_updated',?,?)",
            ).run(
              recipient.manager_id,
              event.id,
              event.title + ' 已发布逐人结算第 ' + next + ' 版，请查看应付与付款归属',
              stamp,
            );
          try {
            db.transaction(() => bot.broadcast(eventRow(db, event.id)!, 'settlement_updated'))();
          } catch {
            app.log.error({ eventId: event.id }, 'Settlement bot hook failed; business write preserved');
          }
        }
        const result = SettlementResult.parse({
          id: event.id,
          revision: eventRow(db, event.id)!.revision,
          version: next,
          changed,
        });
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
        if (event.owner_id !== user.id) fail('只有發起者可以分配包間及指定付款人', 403);
        const old = db
          .prepare('SELECT signature,response_json FROM request_results WHERE user_id=? AND request_key=?')
          .get(user.id, key) as { signature: string; response_json: string } | undefined;
        if (old) {
          if (old.signature !== signature) fail('這個操作編號已用於另一份內容', 409);
          return SettlementResult.parse(JSON.parse(old.response_json));
        }
        requireEventRevision(event, input.revision);
        if (planBlocker(event)) fail(planBlocker(event), 409);
        if (
          input.music_source_version &&
          musicRoomSource(db, user.id, event.id).source.sourceVersion !== input.music_source_version
        )
          fail('分房試算來源已變更；請重新試算，或明確轉為手動安排後核對保存', 409);
        const ctx = settlementRoster(db, event, user),
          before = roomPlan(db, event.id),
          rooms = normalizeRooms(
            input.rooms,
            new Map(ctx.people.filter((p) => p.status !== 'withdrawn').map((p) => [p.id, p])),
            new Map(ctx.payers.map((p) => [p.id, p.name])),
          ).map((r) => ({ ...r, payer_label: ctx.payers.find((p) => p.id === r.payer_id)!.label })),
          changed = canonicalSettlement(before.rooms) !== canonicalSettlement(rooms),
          next = before.version + (changed ? 1 : 0),
          stamp = legacyStamp(now());
        if (changed) {
          if ([...journalRoomIds(db, event.id)].some((id) => !rooms.some((r) => r.id === id)))
            fail('已有款項的包間須保留；先在帳本核對並沖正錯誤款項', 409);
          db.prepare('INSERT INTO event_room_plans VALUES(?,?,?,?)').run(event.id, next, JSON.stringify(rooms), stamp);
          appendEventAudit(db, event, user, 'rooms_updated', { rooms: before.rooms }, { rooms }, input.reason, stamp);
        }
        const result = { id: event.id, revision: eventRow(db, event.id)!.revision, version: next, changed };
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
