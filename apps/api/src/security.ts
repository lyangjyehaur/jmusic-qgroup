import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from '@qgroup/database';
import { DomainError } from '@qgroup/domain';

export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const accountScope = (id: string) => hash('kanban-drafts-v1:' + id);
export type Device = { tokenHash: string; scope: string } & ({ kind: 'member'; id: string; nickname: string } | { kind: 'visitor' });
export function createSecurity(db: DB, origin: string, now: () => Date, secret = randomBytes(32).toString('hex')) {
  function read(request: FastifyRequest): Device | null {
    const token = request.cookies.kanban_session;
    if (!token || token.length > 512) return null;
    const tokenHash = hash(token);
    const row = db.prepare(`SELECT u.id,u.nickname FROM browser_sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=? AND NOT EXISTS(SELECT 1 FROM privacy_requests p WHERE p.user_id=u.id)`).get(tokenHash) as { id: string; nickname: string } | undefined;
    if (row) return { ...row, kind: 'member', tokenHash, scope: accountScope(row.id) };
    if (db.prepare('SELECT 1 FROM visitor_sessions WHERE token_hash=? AND expires_at>?').get(tokenHash, now().toISOString())) return { kind: 'visitor', tokenHash, scope: hash('kanban-visitor-v1:' + tokenHash) };
    return null;
  }
  function setCookie(reply: FastifyReply, token: string, visitor = false) {
    reply.setCookie('kanban_session', token, { path: '/', httpOnly: true, sameSite: 'lax', secure: origin.startsWith('https:'), maxAge: visitor ? 86400 : 31536000 });
  }
  function ensure(request: FastifyRequest, reply: FastifyReply): Device {
    const existing = read(request);
    if (existing) return existing;
    const token = randomBytes(32).toString('base64url');
    const tokenHash = hash(token);
    db.transaction(() => {
      db.prepare('DELETE FROM visitor_sessions WHERE expires_at<=?').run(now().toISOString());
      db.prepare('INSERT INTO visitor_sessions VALUES(?,?,?)').run(tokenHash, new Date(now().getTime() + 86400000).toISOString(), now().toISOString());
    }).immediate();
    setCookie(reply, token, true);
    return { kind: 'visitor', tokenHash, scope: hash('kanban-visitor-v1:' + tokenHash) };
  }
  function requireDevice(request: FastifyRequest): Device {
    const device = read(request);
    if (!device) throw new DomainError('SESSION_EXPIRED', '工作階段已失效，請重新整理', 401);
    return device;
  }
  function member(request: FastifyRequest): Extract<Device, { kind: 'member' }> {
    const device = read(request);
    if (device?.kind !== 'member') throw new DomainError('LOGIN_REQUIRED', '請先登入', 401);
    return device;
  }
  function scoped(request: FastifyRequest): Device {
    const device = requireDevice(request);
    if (request.headers['x-account-scope'] !== device.scope) throw new DomainError('ACCOUNT_CHANGED', '目前帳號已變更；請重新整理並確認帳號', 409);
    return device;
  }
  const csrf = (device: Device) => createHmac('sha256', secret).update(device.tokenHash + ':' + device.scope).digest('hex');
  function write(request: FastifyRequest): Device {
    const device = scoped(request);
    if (request.headers.origin !== origin) throw new DomainError('ORIGIN_REJECTED', '請從本站重新開啟操作', 403);
    const token = request.headers['x-csrf-token'];
    if (typeof token !== 'string' || token.length !== 64 || !/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(Buffer.from(token), Buffer.from(csrf(device)))) throw new DomainError('CSRF_REJECTED', '操作驗證已失效，請重新整理', 403);
    return device;
  }
  function memberWrite(request: FastifyRequest) { member(request); return write(request) as Extract<Device, { kind: 'member' }>; }
  function scopedMember(request: FastifyRequest) { member(request); return scoped(request) as Extract<Device, { kind: 'member' }>; }
  return { read, ensure, member, scoped, write, memberWrite, scopedMember, csrf, setCookie };
}
export type Security = ReturnType<typeof createSecurity>;
