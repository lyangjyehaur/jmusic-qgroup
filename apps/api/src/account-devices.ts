import { withApiError } from './error-display';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '@qgroup/database';
import { AcceptDeviceLink, IssueDeviceLink, ReadDeviceLink, RevokeDevice } from '@qgroup/contracts';
import { DomainError } from '@qgroup/domain';
import { hash, type Security } from './security';
import { clearMusicClaims } from './music-claim-state';

interface Access { token_hash: string; created_at: string }
interface DeviceLink { id: string; user_id: string; nickname: string; status: string; used_by: string | null; expires_at: string }
/** Keep the existing opaque device IDs; never expose raw session hashes or audit details. */
const deviceId = (userId: string, tokenHash: string) => hash(userId + tokenHash);
export function registerAccountDevices(app: FastifyInstance, db: DB, security: Security, now: () => Date) {
  const stamp = () => now().toISOString();
  function audit(userId: string, action: string, details: object) {
    db.prepare('INSERT INTO account_audit(user_id,action,details_json,created_at) VALUES(?,?,?,?)').run(userId, action, JSON.stringify(details), stamp());
  }
  function access(userId: string): Access[] {
    return db.prepare(`SELECT token_hash,MIN(created_at) AS created_at FROM (
      SELECT token_hash,created_at FROM browser_sessions WHERE user_id=? UNION ALL
      SELECT b.token_hash,b.created_at FROM browser_accounts b JOIN browser_sessions s ON s.token_hash=b.token_hash WHERE b.user_id=?
    ) GROUP BY token_hash ORDER BY created_at,token_hash`).all(userId, userId) as Access[];
  }
  function granted(tokenHash: string, userId: string) {
    return !!db.prepare(`SELECT 1 FROM browser_sessions s WHERE s.token_hash=? AND
      (s.user_id=? OR EXISTS(SELECT 1 FROM browser_accounts b WHERE b.token_hash=s.token_hash AND b.user_id=?))`).get(tokenHash, userId, userId);
  }
  function lookup(token: string): DeviceLink {
    // New links store a digest; unexpired legacy links retain their original semantics.
    const row = db.prepare(`SELECT l.id,l.user_id,l.status,l.used_by,l.expires_at,u.nickname FROM device_links l JOIN users u ON u.id=l.user_id
      WHERE l.token IN (?,?) AND NOT EXISTS(SELECT 1 FROM privacy_requests p WHERE p.user_id=l.user_id)`).get('sha256:' + hash(token), token) as DeviceLink | undefined;
    if (!row || Date.parse(row.expires_at) <= now().getTime() || !Number.isFinite(Date.parse(row.expires_at))) throw withApiError(new DomainError('LINK_UNAVAILABLE', '連結已過期、使用或撤銷，請重新產生', 404));
    return row;
  }
  app.get('/api/v2/me/devices', async request => {
    const viewer = security.scopedMember(request);
    return { devices: access(viewer.id).map(row => ({ id: deviceId(viewer.id, row.token_hash), current: row.token_hash === viewer.tokenHash, createdAt: row.created_at }))
      .sort((a, b) => Number(b.current) - Number(a.current) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)) };
  });
  app.get('/api/v2/me/account-history', async request => {
    const viewer = security.scopedMember(request);
    const query = z.object({ before: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional() }).strict().parse(request.query);
    const rows = db.prepare(`SELECT id,action,created_at FROM account_audit WHERE user_id=? AND id<? ORDER BY id DESC LIMIT 26`)
      .all(viewer.id, query.before ?? Number.MAX_SAFE_INTEGER) as { id: number; action: string; created_at: string }[];
    const page = rows.slice(0, 25);
    return { history: page.map(row => ({ id: row.id, action: row.action, createdAt: row.created_at })), nextCursor: rows.length > 25 ? page.at(-1)!.id : null };
  });
  app.post('/api/v2/me/devices/link', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async request => db.transaction(() => {
    const viewer = security.memberWrite(request); IssueDeviceLink.parse(request.body);
    const token = randomBytes(24).toString('base64url'); const id = randomBytes(8).toString('hex');
    const expiresAt = new Date(now().getTime() + 600000).toISOString();
    db.prepare("UPDATE device_links SET status='revoked' WHERE user_id=? AND status='pending'").run(viewer.id);
    db.prepare("INSERT INTO device_links VALUES(?,?,?,'pending',?,?,NULL)").run(id, 'sha256:' + hash(token), viewer.id, expiresAt, stamp());
    audit(viewer.id, 'device_link_issued', { link_id: id });
    return { token, expiresAt };
  }).immediate());
  // Token in a POST body, never a URL path/query. Reading never consumes a grant.
  app.post('/api/v2/device-links/view', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async request => {
    const viewer = security.write(request); const { token } = ReadDeviceLink.parse(request.body); const row = lookup(token);
    const allowed = viewer.kind === 'member' && granted(viewer.tokenHash, row.user_id);
    if (row.status !== 'pending' && !(row.status === 'used' && row.used_by === viewer.tokenHash && allowed)) throw withApiError(new DomainError('LINK_UNAVAILABLE', '連結已過期、使用或撤銷，請重新產生', 404));
    return { status: row.status === 'used' ? 'accepted' : 'pending', nickname: row.nickname, expiresAt: row.expires_at, alreadyAuthorized: allowed };
  });
  app.post('/api/v2/device-links/accept', { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async request => db.transaction(() => {
    const viewer = security.memberWrite(request); const { token } = AcceptDeviceLink.parse(request.body); const row = lookup(token);
    if (row.status !== 'pending') throw withApiError(new DomainError('LINK_UNAVAILABLE', '連結已過期、使用或撤銷，請重新產生', 404));
    if (granted(viewer.tokenHash, row.user_id)) throw withApiError(new DomainError('ALREADY_AUTHORIZED', '此裝置已授權該帳號，請到帳號頁切換', 409));
    db.prepare('INSERT OR IGNORE INTO browser_accounts VALUES(?,?,?)').run(viewer.tokenHash, viewer.id, stamp());
    db.prepare('INSERT INTO browser_accounts VALUES(?,?,?)').run(viewer.tokenHash, row.user_id, stamp());
    db.prepare("UPDATE device_links SET status='used',used_by=? WHERE id=? AND status='pending'").run(viewer.tokenHash, row.id);
    audit(row.user_id, 'device_link_accepted', { link_id: row.id, device: deviceId(row.user_id, viewer.tokenHash) });
    return { ok: true };
  }).immediate());
  app.post('/api/v2/me/devices/revoke-link', async request => db.transaction(() => {
    const viewer = security.memberWrite(request); z.object({ confirm: z.literal(true) }).strict().parse(request.body);
    db.prepare("UPDATE device_links SET status='revoked' WHERE user_id=? AND status='pending'").run(viewer.id);
    audit(viewer.id, 'device_links_revoked', {}); return { ok: true };
  }).immediate());
  app.post('/api/v2/me/devices/revoke', async request => db.transaction(() => {
    const viewer = security.memberWrite(request); const { deviceId: selected } = RevokeDevice.parse(request.body);
    const target = access(viewer.id).find(row => deviceId(viewer.id, row.token_hash) === selected);
    if (!target) throw withApiError(new DomainError('DEVICE_NOT_FOUND', '裝置授權不存在或已撤銷，請重新讀取', 404));
    if (target.token_hash === viewer.tokenHash) throw withApiError(new DomainError('CURRENT_DEVICE', '不能在這裡撤銷目前裝置，請使用登出', 400));
    clearMusicClaims(db, target.token_hash);
    db.prepare('DELETE FROM browser_accounts WHERE token_hash=? AND user_id=?').run(target.token_hash, viewer.id);
    const current = db.prepare('SELECT user_id FROM browser_sessions WHERE token_hash=?').get(target.token_hash) as { user_id: string } | undefined;
    if (current?.user_id === viewer.id) {
      const alternate = db.prepare(`SELECT b.user_id FROM browser_accounts b JOIN users u ON u.id=b.user_id WHERE b.token_hash=?
        AND NOT EXISTS(SELECT 1 FROM privacy_requests p WHERE p.user_id=b.user_id) ORDER BY b.created_at,b.user_id LIMIT 1`).get(target.token_hash) as { user_id: string } | undefined;
      if (alternate) db.prepare('UPDATE browser_sessions SET user_id=? WHERE token_hash=?').run(alternate.user_id, target.token_hash);
      else db.prepare('DELETE FROM browser_sessions WHERE token_hash=?').run(target.token_hash);
      db.prepare('DELETE FROM auth_requests WHERE token_hash=?').run(target.token_hash);
      db.prepare("UPDATE login_attempts SET status='failed',union_id='' WHERE token_hash=? AND status IN ('pending','exchanging','verified')").run(target.token_hash);
    } else {
      db.prepare("UPDATE login_attempts SET status='failed',union_id='' WHERE token_hash=? AND user_id=? AND status IN ('pending','exchanging','verified')").run(target.token_hash, viewer.id);
    }
    db.prepare("UPDATE device_links SET status='revoked' WHERE user_id=? AND status='pending'").run(viewer.id);
    audit(viewer.id, 'device_revoked', { device: selected }); return { ok: true };
  }).immediate());
}
