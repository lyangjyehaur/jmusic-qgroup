import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { DB } from '@qgroup/database';
import { SaveNickname } from '@qgroup/contracts';
import { DomainError } from '@qgroup/domain';
import { hash, type Security } from './security';

const rosterFields = ['id', 'nickname', 'note', 'status', 'payer_kind', 'manager_name', 'withdrawal_requested', 'withdrawal_reason', 'created_at', 'updated_at', 'party_id', 'queue_mode', 'accepted_conditions_version', 'confirmation_state', 'attendance', 'attendance_note', 'arrived_at', 'left_at'] as const;
function rosterSnapshot(db: DB, eventId: string) {
  const rows = db.prepare(`SELECT a.*,COALESCE(u.nickname,a.name) AS nickname,m.nickname AS manager_name,p.queue_mode
    FROM attendees a JOIN users m ON m.id=a.manager_id LEFT JOIN users u ON u.id=a.user_id
    LEFT JOIN roster_parties p ON p.id=a.party_id WHERE a.event_id=? ORDER BY p.seq,a.seq`).all(eventId) as Record<string, string | number | null>[];
  return new Map(rows.map(row => [String(row.id), Object.fromEntries(rosterFields.map(field => [field, row[field]]))]));
}
export function accountProfile(db: DB, userId: string) {
  return db.prepare(`SELECT u.nickname,COALESCE((SELECT MAX(a.id) FROM account_audit a WHERE a.user_id=u.id AND a.action='nickname_changed'),0) AS revision
    FROM users u WHERE u.id=?`).get(userId) as { nickname: string; revision: number };
}

// A nickname changes no roster status, so the legacy append hook emits no broadcast.
// It still invalidates queued public work when sharing has already been disabled.
function nicknameBotHook(db: DB, eventId: string, enabledDefault: boolean) {
  const row = db.prepare('SELECT config_json FROM bot_settings WHERE id=1').get() as { config_json: string } | undefined;
  if (!row) return;
  const policy = z.object({ enabled: z.boolean().optional() }).parse(JSON.parse(row.config_json));
  if (!(policy.enabled ?? enabledDefault)) return;
  const event = db.prepare('SELECT visibility,lifecycle,status,bot_enabled FROM events WHERE id=?').get(eventId) as { visibility: string; lifecycle: string; status: string; bot_enabled: number };
  if (event.visibility !== 'public' || event.lifecycle === 'draft' || event.status === 'deleted' || !event.bot_enabled) {
    db.prepare("UPDATE bot_outbox SET status='skipped',last_error='活动已关闭公开群同步' WHERE event_id=? AND channel='group' AND status IN ('pending','sending')").run(eventId);
  }
}
export function registerAccountProfile(app: FastifyInstance, db: DB, security: Security, now: () => Date, botEnabledDefault = false) {
  app.get('/api/v2/me/profile', async request => accountProfile(db, security.scopedMember(request).id));
  app.put('/api/v2/me/profile', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async request => db.transaction(() => {
    const device = security.memberWrite(request);
    const input = SaveNickname.parse(request.body);
    const requestKey = z.string().uuid().parse(request.headers['idempotency-key']);
    const signature = hash('v2:PUT:/api/v2/me/profile:' + JSON.stringify(input));
    const previous = db.prepare('SELECT signature,response_json FROM request_results WHERE user_id=? AND request_key=?').get(device.id, requestKey) as { signature: string; response_json: string } | undefined;
    if (previous) {
      if (previous.signature !== signature) throw new DomainError('REQUEST_CONFLICT', '這個操作編號已用於另一份內容', 409);
      return JSON.parse(previous.response_json) as ReturnType<typeof accountProfile>;
    }
    const before = accountProfile(db, device.id);
    if (input.revision !== before.revision) throw new DomainError('PROFILE_CHANGED', '稱呼已被修改；請核對目前稱呼後再保存', 409);
    const stamp = now().toISOString();
    if (input.nickname !== before.nickname) {
      const affected = db.prepare("SELECT DISTINCT event_id FROM attendees WHERE user_id=? AND status!='withdrawn' ORDER BY event_id").all(device.id) as { event_id: string }[];
      const snapshots = affected.map(row => ({ id: row.event_id, before: rosterSnapshot(db, row.event_id) }));
      db.prepare('UPDATE users SET nickname=? WHERE id=?').run(input.nickname, device.id);
      for (const event of snapshots) {
        const after = rosterSnapshot(db, event.id);
        const changed = [...new Set([...event.before.keys(), ...after.keys()])].sort().filter(id => JSON.stringify(event.before.get(id)) !== JSON.stringify(after.get(id)));
        if (!changed.length) continue;
        const prior = { participants: changed.filter(id => event.before.has(id)).map(id => event.before.get(id)) };
        const current = { participants: changed.filter(id => after.has(id)).map(id => after.get(id)) };
        db.prepare('UPDATE events SET revision=revision+1 WHERE id=?').run(event.id);
        const version = (db.prepare('SELECT revision FROM events WHERE id=?').get(event.id) as { revision: number }).revision;
        db.prepare(`INSERT INTO event_audit(event_id,version,actor_id,actor_name,action,before_json,after_json,reason,created_at)
          VALUES(?,?,?,?,'nickname_changed',?,?,'',?)`).run(event.id, version, device.id, before.nickname, JSON.stringify(prior), JSON.stringify(current), stamp);
        // A failed optional bot hook cannot undo the account or immutable roster audit.
        try { db.transaction(() => nicknameBotHook(db, event.id, botEnabledDefault))(); }
        catch { request.log.error({ eventId: event.id }, 'Nickname bot hook failed; account write preserved'); }
      }
      db.prepare("INSERT INTO account_audit(user_id,action,details_json,created_at) VALUES(?,'nickname_changed',?,?)").run(device.id, JSON.stringify({ before: before.nickname, after: input.nickname }), stamp);
    }
    const result = accountProfile(db, device.id);
    db.prepare('INSERT INTO request_results VALUES(?,?,?,?,?,?)').run(device.id, requestKey, signature, JSON.stringify(result), 200, stamp);
    return result;
  }).immediate());
}
