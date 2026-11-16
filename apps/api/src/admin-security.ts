import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from '@qgroup/database';
import { DomainError } from '@qgroup/domain';
import type { Security } from './security';
import { hash } from './security';

export function administratorRevision(db: DB, userId: string): number | undefined {
  return (db.prepare('SELECT revision FROM user_admin_roles WHERE user_id=? AND is_admin=1').get(userId) as { revision: number } | undefined)?.revision;
}
export function createAdminSecurity(db: DB, security: Security, origin: string, now: () => Date, configured: () => string = () => '') {
  const credential = () => { const value = configured(); return /^[a-f0-9]{64}$/.test(value) ? value : ''; };
  const cookieHash = (request: FastifyRequest) => { const token = request.cookies.kanban_admin; return token && token.length <= 512 ? hash(token) : ''; };
  function authority(request: FastifyRequest, write = false) {
    const device = write ? security.write(request) : security.scoped(request);
    const revision = device.kind === 'member' ? administratorRevision(db, device.id) : undefined;
    let method: 'account' | 'credential'; let digest: string; let userId: string | null;
    let adminCsrf: string;
    if (revision !== undefined && device.kind === 'member') {
      method = 'account'; userId = device.id; digest = 'account:' + device.tokenHash + ':' + device.id + ':' + revision;
      // Preserve the existing account-administrator settings CSRF contract.
      adminCsrf = hash('qgroup-v2-admin:' + security.csrf(device) + ':' + revision);
    } else {
      const tokenHash = cookieHash(request);
      const row = db.prepare('SELECT credential_hash,expires_at FROM admin_sessions WHERE token_hash=?').get(tokenHash) as { credential_hash: string; expires_at: string } | undefined;
      const current = credential();
      if (!row || !current || row.credential_hash !== current || !Number.isFinite(Date.parse(row.expires_at)) || Date.parse(row.expires_at) <= now().getTime()) throw new DomainError('ADMIN_REQUIRED', '需要管理員權限或救援憑證登入', device.kind === 'member' && !tokenHash ? 403 : 401);
      method = 'credential'; userId = null; digest = tokenHash;
      adminCsrf = hash('qgroup-v2-admin-credential:' + security.csrf(device) + ':' + digest + ':' + current);
    }
    if (write && request.headers['x-admin-csrf'] !== adminCsrf) throw new DomainError('ADMIN_CHANGED', '管理權限已變更，請重新讀取後確認', 403);
    const scope = hash('qgroup-v2-admin-scope:' + digest + ':' + device.scope);
    return { device, method, userId, adminCsrf, scope, receiptScope: hash('qgroup-v2-admin-receipt:' + scope), actorRef: userId ? 'account:' + userId : 'credential:' + digest };
  }
  function login(request: FastifyRequest, reply: FastifyReply, supplied: string) {
    security.write(request);
    const current = credential();
    if (!current || !timingSafeEqual(Buffer.from(hash(supplied), 'hex'), Buffer.from(current, 'hex'))) throw new DomainError('ADMIN_CREDENTIAL_INVALID', '管理憑證不正確或尚未配置', 401);
    const token = randomBytes(32).toString('base64url');
    db.prepare('DELETE FROM admin_sessions WHERE expires_at<=? OR token_hash=?').run(now().toISOString(), cookieHash(request));
    db.prepare('INSERT INTO admin_sessions VALUES(?,?,?,?)').run(hash(token), current, new Date(now().getTime() + 3600000).toISOString(), now().toISOString());
    reply.setCookie('kanban_admin', token, { httpOnly: true, secure: origin.startsWith('https:'), sameSite: 'lax', path: '/', maxAge: 3600 });
  }
  function logout(request: FastifyRequest, reply: FastifyReply) {
    const access = authority(request, true);
    db.prepare('DELETE FROM admin_sessions WHERE token_hash=?').run(cookieHash(request));
    db.prepare('DELETE FROM auth_requests WHERE token_hash=?').run(access.receiptScope);
    if (access.method === 'account') {
      for (const table of ['login_attempts', 'auth_requests', 'browser_accounts', 'browser_sessions', 'visitor_sessions']) db.prepare(`DELETE FROM ${table} WHERE token_hash=?`).run(access.device.tokenHash);
      // Issue one visitor session in the logout response so other tabs do not race
      // to create different anonymous cookies while refreshing the same device.
      security.ensure(request, reply);
    }
    reply.clearCookie('kanban_admin', { path: '/', httpOnly: true, sameSite: 'lax' });
    return { logoutAccount: access.method === 'account' };
  }
  return { authority, login, logout, enabled: () => !!credential() };
}
export type AdminSecurity = ReturnType<typeof createAdminSecurity>;
