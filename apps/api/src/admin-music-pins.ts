import { withApiError } from './error-display';
import type { FastifyInstance } from 'fastify';
import type { DB } from '@qgroup/database';
import { MusicPinResultRequest, ResetMusicPin } from '@qgroup/contracts';
import { z } from 'zod';
import { DomainError } from '@qgroup/domain';
import type { AdminSecurity } from './admin-security';
import { adminMusicProfile, musicAdminProfileId } from './admin-music';
import { invalidateMusicClaimProofs } from './music-ownership';
import { hash } from './security';

export function registerAdminMusicPins(app: FastifyInstance, db: DB, admin: AdminSecurity, now: () => Date) {
  app.post('/api/v2/admin/music/:id/pin', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async request => db.transaction(() => {
    const access = admin.authority(request, true); const id = musicAdminProfileId(request.params); const input = ResetMusicPin.parse(request.body);
    const key = z.string().uuid().parse(request.headers['idempotency-key']);
    const signature = hash('v2:POST:/admin/music/' + id + '/pin:' + JSON.stringify(input));
    const prior = db.prepare('SELECT signature FROM auth_requests WHERE token_hash=? AND request_key=?').get(access.receiptScope, key) as { signature: string } | undefined;
    if (prior) {
      if (prior.signature !== signature) throw withApiError(new DomainError('REQUEST_CONFLICT', '這個操作編號已用於其他內容', 409));
      return { ok: true };
    }
    const before = adminMusicProfile(db, id);
    if (!/^[0-9]{4,12}$/.test(before.legacyKey)) throw withApiError(new DomainError('PIN_NOT_SUPPORTED', '只有原數字 QQ 成分使用找回口令；此成分請用帳號登入或核對關聯', 409));
    if (before.revision !== input.revision) throw withApiError(new DomainError('MUSIC_PIN_CHANGED', '成分、口令或關聯已有變更，請核對目前資料後再重設', 409));
    admin.preserve(request);
    const stamp = now().toISOString();
    db.prepare('UPDATE music_legacy_profiles SET pin_hash=? WHERE profile_id=?').run(hash('jpm-pin|' + input.pin), id);
    db.prepare('UPDATE music_profiles SET revision=revision+1,updated_at=? WHERE id=?').run(stamp, id);
    invalidateMusicClaimProofs(db, id);
    db.prepare('INSERT INTO music_pin_history(profile_id,revision,user_id,actor_ref,reason,created_at) VALUES(?,?,?,?,?,?)')
      .run(id, before.revision + 1, before.owner?.id ?? null, access.actorRef, input.reason, stamp);
    // Keep a queryable acknowledgement, never a copy of the PIN or its digest.
    db.prepare('INSERT INTO auth_requests VALUES(?,?,?,?,?)').run(access.receiptScope, key, signature, JSON.stringify({ ok: true, operation: 'music_pin_reset', profileId: id }), stamp);
    return { ok: true };
  }).immediate());
  app.post('/api/v2/admin/music/:id/pin-result', async request => {
    const access = admin.authority(request, true); const id = musicAdminProfileId(request.params); const input = MusicPinResultRequest.parse(request.body);
    const prior = db.prepare('SELECT response_json FROM auth_requests WHERE token_hash=? AND request_key=?').get(access.receiptScope, input.requestId) as { response_json: string } | undefined;
    if (!prior) return { status: 'not_found' };
    const result = JSON.parse(prior.response_json) as { operation?: string; profileId?: string };
    if (result.operation !== 'music_pin_reset' || result.profileId !== id) throw withApiError(new DomainError('REQUEST_CONFLICT', '這個操作編號已用於其他內容', 409));
    return { status: 'completed' };
  });
  app.get('/api/v2/admin/music/:id/pin-history', async request => {
    admin.authority(request); const id = musicAdminProfileId(request.params); adminMusicProfile(db, id);
    const { before } = z.object({ before: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(Number.MAX_SAFE_INTEGER) }).strict().parse(request.query);
    const rows = db.prepare(`SELECT h.id,h.revision,h.reason,h.created_at AS createdAt,
      CASE WHEN h.actor_ref LIKE 'account:%' THEN COALESCE(u.nickname,'帳號管理員') ELSE '救援憑證' END AS actor
      FROM music_pin_history h LEFT JOIN users u ON h.actor_ref='account:'||u.id
      WHERE h.profile_id=? AND h.id<? ORDER BY h.id DESC LIMIT 51`).all(id, before) as { id: number }[];
    return { history: rows.slice(0,50), nextCursor: rows.length > 50 ? rows[49]!.id : null };
  });
}
