import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { DB } from '@qgroup/database';
import { AccountList, Confirm, PRIVACY_VERSION, QQFinish, QQStart, RegisterName, SwitchAccount, type Viewer } from '@qgroup/contracts';
import { DomainError } from '@qgroup/domain';
import { accountScope, hash, type Device, type Security } from './security';
import { QQIdentity, safeAvatar, safeUnionId, type QQProvider } from './qq-provider';
import { administratorRevision, nameRegistration } from './registration-settings';

interface Attempt { id: string; token_hash: string; user_id: string | null; app_id: string; mode: 'bind' | 'login'; status: string; expires_at: string; openid: string; nickname: string; return_path: string; privacy_version: string; avatar_url: string; union_id: string }
interface External { user_id: string; subject: string; nickname: string }
export function safeReturnTo(value: string): string {
  if (!value.startsWith('/') || value.startsWith('//') || /[\\\x00-\x20\x7f]/.test(value) || value.length > 4096) throw new DomainError('INVALID_RETURN', '返回地址不正確');
  let decoded: string;
  try { decoded = decodeURIComponent(value); } catch { throw new DomainError('INVALID_RETURN', '返回地址不正確'); }
  if (decoded.startsWith('//') || /[\\\x00-\x20\x7f]/.test(decoded)) throw new DomainError('INVALID_RETURN', '返回地址不正確');
  const url = new URL(value, 'https://local.invalid');
  const decodedUrl = new URL(decoded, 'https://local.invalid');
  // Reject encoded auth loops and nested path escapes before a router can decode them again.
  if (url.origin !== 'https://local.invalid' || decodedUrl.origin !== url.origin || /%[a-f0-9]{2}/i.test(decodedUrl.pathname) || /^\/(?:api|auth|login)(?:\/|$)/i.test(decodedUrl.pathname)) throw new DomainError('INVALID_RETURN', '返回地址不正確');
  return url.pathname + url.search + url.hash;
}
export function registerAuth(app: FastifyInstance, db: DB, security: Security, now: () => Date, provider?: QQProvider) {
  const stamp = () => now().toISOString();
  const uid = (device: Device) => device.kind === 'member' ? device.id : null;
  function requiredProvider() { if (!provider) throw new DomainError('QQ_NOT_CONFIGURED', 'QQ 登入尚未配置', 503); return provider; }
  function accepted(device: Device) { return device.kind === 'member' && !!db.prepare('SELECT 1 FROM privacy_consents WHERE user_id=? AND version=?').get(device.id, PRIVACY_VERSION); }
  function audit(userId: string, action: string, details: object) {
    db.prepare('INSERT INTO account_audit(user_id,action,details_json,created_at) VALUES(?,?,?,?)').run(userId, action, JSON.stringify(details), stamp());
  }
  function latest(device: Device): Attempt | undefined {
    return db.prepare("SELECT * FROM login_attempts WHERE token_hash=? AND user_id IS ? AND provider='qq' AND app_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(device.tokenHash, uid(device), requiredProvider().clientId) as Attempt | undefined;
  }
  function target(attempt: Attempt): External | undefined {
    return db.prepare("SELECT e.user_id,e.subject,u.nickname FROM external_identities e JOIN users u ON u.id=e.user_id WHERE e.provider='qq' AND e.client_id=? AND e.subject=?").get(attempt.app_id, attempt.openid) as External | undefined;
  }
  function invalidate(tokenHash: string) { db.prepare("UPDATE login_attempts SET status='failed',union_id='' WHERE token_hash=? AND status IN ('pending','exchanging','verified')").run(tokenHash); }
  function rotate(device: Device, userId: string) {
    const token = randomBytes(32).toString('base64url'); const newHash = hash(token);
    db.prepare('INSERT INTO browser_sessions VALUES(?,?,?)').run(newHash, userId, stamp());
    db.prepare(`INSERT INTO browser_accounts SELECT ?,b.user_id,b.created_at FROM browser_accounts b
      WHERE b.token_hash=? AND NOT EXISTS(SELECT 1 FROM privacy_requests p WHERE p.user_id=b.user_id)`).run(newHash, device.tokenHash);
    for (const granted of new Set([userId, ...(device.kind === 'member' ? [device.id] : [])])) db.prepare('INSERT OR IGNORE INTO browser_accounts VALUES(?,?,?)').run(newHash, granted, stamp());
    invalidate(device.tokenHash);
    db.prepare('DELETE FROM browser_sessions WHERE token_hash=?').run(device.tokenHash);
    db.prepare('DELETE FROM visitor_sessions WHERE token_hash=?').run(device.tokenHash);
    return token;
  }
  app.get('/api/v2/session', async (request, reply): Promise<Viewer> => {
    const device = security.ensure(request, reply);
    const base = { scope: device.scope, csrf: security.csrf(device), qqEnabled: !!provider, privacyVersion: PRIVACY_VERSION, privacyAccepted: accepted(device), nameRegistrationEnabled: nameRegistration(db).enabled };
    if (device.kind === 'visitor') return { authenticated: false, ...base };
    const bound = provider ? db.prepare(`SELECT e.display_name,EXISTS(SELECT 1 FROM external_unionids x WHERE x.provider=e.provider AND x.client_id=e.client_id AND x.subject=e.subject) AS unionid_bound
      FROM external_identities e WHERE e.provider='qq' AND e.client_id=? AND e.user_id=?`).get(provider.clientId, device.id) as { display_name: string; unionid_bound: number } | undefined : undefined;
    return { authenticated: true, nickname: device.nickname, administrator: administratorRevision(db, device.id) !== undefined, ...base, qq: { bound: !!bound, nickname: bound?.display_name ?? '', unionidBound: !!bound?.unionid_bound, needsReauth: !!bound && !bound.unionid_bound } };
  });
  app.post('/api/v2/auth/register-name', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (request, reply) => {
    const result = db.transaction(() => {
      const device = security.write(request);
      if (device.kind !== 'visitor') throw new DomainError('ALREADY_LOGGED_IN', '目前已登入；名稱註冊不會建立另一份帳號或合併資料', 409);
      if (!nameRegistration(db).enabled) throw new DomainError('REGISTRATION_CLOSED', '名稱註冊尚未開放，請使用 QQ 登入', 403);
      const data = RegisterName.parse(request.body);
      const returnTo = safeReturnTo(data.returnTo);
      const userId = randomBytes(16).toString('hex');
      db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(userId, randomBytes(32).toString('hex'), data.nickname, stamp());
      db.prepare('INSERT INTO privacy_consents VALUES(?,?,?)').run(userId, PRIVACY_VERSION, stamp());
      const token = rotate(device, userId);
      audit(userId, 'name_registered', {});
      return { token, response: { returnTo, switched: true, newAccount: true } };
    }).immediate();
    security.setCookie(reply, result.token);
    return result.response;
  });
  app.post('/api/v2/auth/qq/start', { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async request => db.transaction(() => {
    const device = security.write(request); const qq = requiredProvider(); const data = QQStart.parse(request.body);
    if (data.mode === 'bind' && device.kind !== 'member') throw new DomainError('LOGIN_REQUIRED', '請先登入後再綁定 QQ', 401);
    if (!accepted(device) && (!data.acceptPrivacy || data.privacyVersion !== PRIVACY_VERSION)) throw new DomainError('PRIVACY_REQUIRED', '請閱讀並同意隱私政策');
    const returnTo = safeReturnTo(data.returnTo); const state = randomBytes(32).toString('base64url');
    db.prepare('DELETE FROM login_attempts WHERE expires_at<=?').run(stamp());
    invalidate(device.tokenHash);
    db.prepare(`INSERT INTO login_attempts(id,token_hash,user_id,provider,app_id,mode,status,expires_at,created_at,return_path,privacy_version)
      VALUES(?,?,?,'qq',?,?,'pending',?,?,?,?)`).run(hash(state), device.tokenHash, uid(device), qq.clientId, data.mode, new Date(now().getTime() + 600000).toISOString(), stamp(), returnTo, PRIVACY_VERSION);
    return { authorizeUrl: qq.authorize(state) };
  }).immediate());
  app.get('/auth/qq/callback', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    const query = request.query as Record<string, unknown>;
    const device = security.read(request);
    const state = query.state;
    if (!provider || !device || typeof state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(state)) return reply.redirect('/auth/confirm?status=invalid', 303);
    const attempt = db.transaction(() => {
      const row = db.prepare(`SELECT * FROM login_attempts WHERE id=? AND token_hash=? AND user_id IS ? AND provider='qq' AND app_id=? AND status='pending' AND expires_at>?`).get(hash(state), device.tokenHash, uid(device), provider.clientId, stamp()) as Attempt | undefined;
      if (row) db.prepare("UPDATE login_attempts SET status='exchanging' WHERE id=?").run(row.id);
      return row;
    }).immediate();
    if (!attempt) return reply.redirect('/auth/confirm?status=invalid', 303);
    try {
      if ('error' in query || typeof query.code !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(query.code) || query.code.trim() !== query.code) throw new Error();
      const profile = QQIdentity.parse(await provider.exchange(query.code));
      db.transaction(() => {
        const current = security.read(request);
        if (!current || current.scope !== device.scope || current.tokenHash !== device.tokenHash) { invalidate(device.tokenHash); return; }
        db.prepare("UPDATE login_attempts SET status='verified',openid=?,nickname=?,avatar_url=?,union_id=? WHERE id=? AND status='exchanging' AND expires_at>?")
          .run(profile.subject, profile.nickname, safeAvatar(profile.avatarUrl), safeUnionId(profile.unionId), attempt.id, stamp());
      }).immediate();
    } catch {
      db.prepare("UPDATE login_attempts SET status='failed',union_id='' WHERE id=? AND status='exchanging'").run(attempt.id);
    }
    return reply.redirect('/auth/confirm', 303);
  });
  app.get('/api/v2/auth/qq/status', async request => {
    const device = security.scoped(request); const row = latest(device);
    if (!row || row.expires_at <= stamp()) return { status: 'expired', returnTo: row?.return_path ?? '/' };
    if (row.status !== 'verified') return { status: row.status, returnTo: row.return_path };
    const linked = target(row);
    const currentBinding = device.kind === 'member' ? db.prepare("SELECT subject FROM external_identities WHERE provider='qq' AND client_id=? AND user_id=?").get(row.app_id, device.id) as { subject: string } | undefined : undefined;
    const conflict = row.mode === 'bind' && ((!!linked && linked.user_id !== uid(device)) || (!!currentBinding && currentBinding.subject !== row.openid));
    return { status: 'verified', attemptId: row.id, mode: row.mode, qqNickname: row.nickname, currentNickname: device.kind === 'member' ? device.nickname : '', targetNickname: linked?.nickname ?? '', existingAccount: !!linked, conflict, returnTo: row.return_path };
  });
  app.post('/api/v2/auth/qq/finish', async (request, reply) => {
    const result = db.transaction(() => {
      const device = security.write(request); const qq = requiredProvider(); const data = QQFinish.parse(request.body);
      const row = db.prepare("SELECT * FROM login_attempts WHERE id=? AND token_hash=? AND user_id IS ? AND provider='qq' AND app_id=? AND status='verified' AND expires_at>?").get(data.attemptId, device.tokenHash, uid(device), qq.clientId, stamp()) as Attempt | undefined;
      if (!row || row.privacy_version !== PRIVACY_VERSION) throw new DomainError('AUTH_EXPIRED', 'QQ 授權結果已失效或使用，請重新登入', 409);
      const linked = target(row); let userId = linked?.user_id;
      if (userId && db.prepare('SELECT 1 FROM privacy_requests WHERE user_id=?').get(userId)) throw new DomainError('ACCOUNT_CLOSED', '此帳號已註銷，請聯絡管理員', 409);
      if (row.mode === 'bind') {
        if (device.kind !== 'member') throw new DomainError('LOGIN_REQUIRED', '請先登入', 401);
        if (userId && userId !== device.id) throw new DomainError('QQ_CONFLICT', '這個 QQ 已綁定其他帳號，請使用 QQ 登入；報名與款項不會合併', 409);
        const bound = db.prepare("SELECT subject FROM external_identities WHERE provider='qq' AND client_id=? AND user_id=?").get(row.app_id, device.id) as { subject: string } | undefined;
        if (bound && bound.subject !== row.openid) throw new DomainError('QQ_CONFLICT', '目前帳號已綁定另一個 QQ，不能直接替換', 409);
        userId = device.id;
      } else if (!userId) {
        userId = randomBytes(16).toString('hex');
        db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(userId, randomBytes(32).toString('hex'), Array.from(row.nickname).slice(0, 24).join(''), stamp());
      }
      if (!userId) throw new Error('Missing authenticated user');
      if (!linked) db.prepare("INSERT INTO external_identities VALUES('qq',?,?,?,?,?)").run(row.app_id, row.openid, userId, row.nickname, stamp());
      else db.prepare("UPDATE external_identities SET display_name=? WHERE provider='qq' AND client_id=? AND subject=?").run(row.nickname, row.app_id, row.openid);
      db.prepare("INSERT OR REPLACE INTO external_profiles VALUES('qq',?,?,?)").run(row.app_id, userId, safeAvatar(row.avatar_url));
      const unionId = safeUnionId(row.union_id);
      if (unionId) db.prepare("INSERT OR IGNORE INTO external_unionids VALUES('qq',?,?,?,?)").run(row.app_id, row.openid, unionId, stamp());
      db.prepare('INSERT OR REPLACE INTO privacy_consents VALUES(?,?,?)').run(userId, PRIVACY_VERSION, stamp());
      const token = rotate(device, userId);
      db.prepare("UPDATE login_attempts SET status='used',union_id='' WHERE id=?").run(row.id);
      audit(userId, row.mode === 'bind' ? 'qq_bound' : 'qq_login', { previous_scope: device.kind === 'member' ? device.scope : null });
      return { token, response: { switched: userId !== uid(device), newAccount: !linked && row.mode === 'login', returnTo: row.return_path } };
    }).immediate();
    security.setCookie(reply, result.token);
    return result.response;
  });
  app.post('/api/v2/auth/qq/cancel', async request => db.transaction(() => {
    const device = security.write(request); Confirm.parse(request.body); const row = latest(device);
    invalidate(device.tokenHash);
    return { returnTo: row?.return_path ?? '/' };
  }).immediate());
  app.get('/api/v2/me/accounts', async request => {
    const device = security.scopedMember(request);
    const rows = db.prepare(`SELECT u.id,u.nickname FROM users u WHERE (u.id=? OR u.id IN(SELECT user_id FROM browser_accounts WHERE token_hash=?))
      AND NOT EXISTS(SELECT 1 FROM privacy_requests p WHERE p.user_id=u.id) ORDER BY u.id`).all(device.id, device.tokenHash) as { id: string; nickname: string }[];
    return AccountList.parse({ accounts: rows.map(row => ({ scope: accountScope(row.id), nickname: row.nickname, current: row.id === device.id })) });
  });
  app.post('/api/v2/me/accounts/switch', async request => db.transaction(() => {
    const device = security.memberWrite(request); const data = SwitchAccount.parse(request.body);
    const rows = db.prepare(`SELECT u.id FROM users u WHERE (u.id=? OR u.id IN(SELECT user_id FROM browser_accounts WHERE token_hash=?))
      AND NOT EXISTS(SELECT 1 FROM privacy_requests p WHERE p.user_id=u.id)`).all(device.id, device.tokenHash) as { id: string }[];
    const selected = rows.find(row => accountScope(row.id) === data.scope);
    if (!selected) throw new DomainError('ACCESS_DENIED', '此裝置沒有該帳號的授權', 403);
    db.prepare('INSERT OR IGNORE INTO browser_accounts VALUES(?,?,?)').run(device.tokenHash, device.id, stamp());
    db.prepare('UPDATE browser_sessions SET user_id=? WHERE token_hash=?').run(selected.id, device.tokenHash);
    invalidate(device.tokenHash); audit(device.id, 'account_switched', { target_scope: data.scope });
    return { ok: true };
  }).immediate());
  app.post('/api/v2/auth/logout', async (request, reply) => {
    db.transaction(() => {
      const device = security.write(request); Confirm.parse(request.body);
      for (const table of ['login_attempts', 'auth_requests', 'browser_accounts', 'browser_sessions', 'visitor_sessions']) db.prepare('DELETE FROM ' + table + ' WHERE token_hash=?').run(device.tokenHash);
    }).immediate();
    reply.clearCookie('kanban_session', { path: '/', httpOnly: true, sameSite: 'lax' });
    return { ok: true };
  });
}
