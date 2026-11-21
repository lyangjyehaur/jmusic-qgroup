import type { FastifyInstance } from 'fastify';
import type { DB } from '@qgroup/database';
import { decodeLegacyRooms, LegacyRequestCheck, LegacyRoomsRetry, RoomPlanView } from '@qgroup/contracts';
import { DomainError } from '@qgroup/domain';
import { withApiError } from './error-display';
import { hash, type Security } from './security';
import { originalRequestSignature } from './legacy-local';
import { requireActivityAccess } from './activity-access';
import { eventRow, legacyStamp } from './activity-arrangements';
import { executeRoomPlan, prepareRoomPlan, requireRoomOwner } from './room-plan-command';

export function registerLegacyRooms(app: FastifyInstance, db: DB, security: Security, now: () => Date) {
  const limits = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };
  function inspect(request: Parameters<Security['memberWrite']>[0], input: ReturnType<typeof LegacyRequestCheck.parse>) {
    const user = security.memberWrite(request);
    let decoded: ReturnType<typeof decodeLegacyRooms>;
    try { decoded = decodeLegacyRooms(input); } catch {
      throw withApiError(new DomainError('LEGACY_ROOMS_UNSUPPORTED', '原包間欄位尚未支援或缺失；原請求保留，不能重試', 400));
    }
    requireActivityAccess(db, decoded.eventId, user.id);
    const event = eventRow(db, decoded.eventId)!;
    requireRoomOwner(event, user.id);
    const signature = originalRequestSignature(input.method, input.path, input.data), old = db.prepare('SELECT signature,response_json FROM request_results WHERE user_id=? AND request_key=?').get(user.id, input.requestKey) as { signature: string; response_json: string } | undefined;
    if (old && old.signature !== signature) throw withApiError(new DomainError('LEGACY_REQUEST_CONFLICT', '原操作編號與內容不符，請保留原紀錄；不能重試不同內容', 409));
    if (old) {
      let result: unknown;
      try { result = JSON.parse(old.response_json); } catch { throw withApiError(new DomainError('LEGACY_REQUEST_RESULT_MISMATCH', '原回執無法解析，請保留並核對原紀錄', 409)); }
      if (!result || typeof result !== 'object' || !('id' in result) || result.id !== event.id)
        throw withApiError(new DomainError('LEGACY_REQUEST_RESULT_MISMATCH', '原回執活動與原請求不一致，請保留並核對原紀錄', 409));
    }
    return { user, event, decoded, signature, old, requestKey: input.requestKey };
  }
  const receipt = (id: string) => ({ committed: true, target: { kind: 'activity' as const, id } });
  function preview(s: ReturnType<typeof inspect>) {
    const plan = prepareRoomPlan(db, s.event, s.user, s.decoded.input), current = RoomPlanView.parse({ ...plan.ctx, people: plan.ctx.people.filter(p => p.status !== 'withdrawn'), id: s.event.id, title: s.event.title, revision: s.event.revision, version: plan.before.version, can_manage: true, blocked_reason: '', rooms: plan.before.rooms });
    const value = { current, rooms: plan.rooms, changed: plan.changed };
    // This fences the current recovery review; it is not an original preview proof.
    return { ...value, recovery_token: hash(JSON.stringify({ user: s.user.id, requestKey: s.requestKey, signature: s.signature, ...value })) };
  }
  app.post('/api/v2/me/legacy-requests/rooms/inspect', limits, async request => db.transaction(() => {
    const input = LegacyRequestCheck.parse(request.body), s = inspect(request, input);
    return s.old ? { state: 'committed', receipt: receipt(s.event.id) } : { state: 'retryable', ...preview(s) };
  })());
  app.post('/api/v2/me/legacy-requests/rooms/retry', limits, async request => db.transaction(() => {
    const { confirm, recovery_token, ...input } = LegacyRoomsRetry.parse(request.body); void confirm;
    const s = inspect(request, input);
    if (s.old) return receipt(s.event.id);
    if (preview(s).recovery_token !== recovery_token)
      throw withApiError(new DomainError('LEGACY_ROOMS_REVIEW_CHANGED', '包間核對資料已變更；原請求保留，請重新檢查後確認', 409));
    const time = now();
    executeRoomPlan(db, s.event, s.user, s.decoded.input, time);
    // Original readers refresh this marker under current access, never replay a private snapshot.
    db.prepare('INSERT INTO request_results VALUES(?,?,?,?,?,?)').run(s.user.id, input.requestKey, s.signature, JSON.stringify({ id: s.event.id, starts_at: s.event.starts_at }), 200, legacyStamp(time));
    return receipt(s.event.id);
  }).immediate());
}
