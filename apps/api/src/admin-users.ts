import { Identifier128Path } from '@qgroup/contracts/http-paths';
import { withApiError } from './error-display';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DB } from '@qgroup/database';
import { z } from 'zod';
import { AdminUsersQuery,PositiveCursorQuery, AdminLogin, Confirm, SaveAdminMetadata, SaveAdminRole } from '@qgroup/contracts';
import { DomainError } from '@qgroup/domain';
import { hash } from './security';
import type { AdminSecurity } from './admin-security';

type UserRow = { id: string; nickname: string; created_at: string; is_admin: number; revision: number; note: string; manual_qq: string; metadata_revision: number; metadata_updated_at: string | null };
const projection = `SELECT u.id,u.nickname,u.created_at,COALESCE(r.is_admin,0) AS is_admin,COALESCE(r.revision,0) AS revision,
  COALESCE(m.note,'') AS note,COALESCE(m.manual_qq,'') AS manual_qq,COALESCE(m.revision,0) AS metadata_revision,m.updated_at AS metadata_updated_at
  FROM users u LEFT JOIN user_admin_roles r ON r.user_id=u.id LEFT JOIN admin_user_metadata m ON m.user_id=u.id`;
const active = 'NOT EXISTS(SELECT 1 FROM privacy_requests p WHERE p.user_id=u.id)';
function serialize(db: DB, row: UserRow) {
  const identities = db.prepare(`SELECT e.provider,e.display_name AS displayName,EXISTS(SELECT 1 FROM external_unionids x
    WHERE x.provider=e.provider AND x.client_id=e.client_id AND x.subject=e.subject) AS unionidBound
    FROM external_identities e WHERE e.user_id=? ORDER BY e.provider,e.client_id,e.subject`).all(row.id) as { provider: string; displayName: string; unionidBound: number }[];
  return { id: row.id, nickname: row.nickname, createdAt: row.created_at, isAdmin: !!row.is_admin, revision: row.revision,
    note: row.note, manualQQ: row.manual_qq, metadataRevision: row.metadata_revision, metadataUpdatedAt: row.metadata_updated_at,
    identities: identities.map(identity => ({ ...identity, unionidBound: !!identity.unionidBound })) };
}
function user(db: DB, id: string) {
  const row = db.prepare(projection + ' WHERE u.id=? AND ' + active).get(id) as UserRow | undefined;
  if (!row) throw withApiError(new DomainError('USER_NOT_FOUND', '帳號不存在或已關閉', 404));
  return serialize(db, row);
}
export function registerAdminUsers(app: FastifyInstance, db: DB, admin: AdminSecurity, now: () => Date) {
  app.get('/api/v2/admin/session', async request => {
    const access = admin.authority(request);
    return { authenticated: true, authMethod: access.method, scope: access.scope, adminCsrf: access.adminCsrf, currentUserId: access.userId, rescueEnabled: admin.enabled() };
  });
  app.post('/api/v2/admin/login', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (request, reply) => {
    const input = AdminLogin.parse(request.body);
    db.transaction(() => admin.login(request, reply, input.key)).immediate();
    return { ok: true };
  });
  app.post('/api/v2/admin/logout', async (request, reply) => db.transaction(() => { Confirm.parse(request.body); return admin.logout(request, reply); }).immediate());
  app.get('/api/v2/admin/users', async request => {
    admin.authority(request);
    const query = AdminUsersQuery.parse(request.query);
    const hasQQ = "EXISTS(SELECT 1 FROM external_identities q WHERE q.user_id=u.id AND q.provider='qq')";
    const missing = `EXISTS(SELECT 1 FROM external_identities q WHERE q.user_id=u.id AND q.provider='qq' AND NOT EXISTS(
      SELECT 1 FROM external_unionids x WHERE x.provider=q.provider AND x.client_id=q.client_id AND x.subject=q.subject))`;
    const filters = { all: '1', bound: hasQQ + ' AND NOT ' + missing, missing, unbound: 'NOT ' + hasQQ };
    const where = active + ` AND (?='' OR instr(lower(u.id),lower(?))>0 OR instr(lower(u.nickname),lower(?))>0
      OR EXISTS(SELECT 1 FROM external_identities e WHERE e.user_id=u.id AND instr(lower(e.display_name),lower(?))>0)
      OR EXISTS(SELECT 1 FROM admin_user_metadata m WHERE m.user_id=u.id AND (instr(lower(m.note),lower(?))>0 OR instr(m.manual_qq,?)>0))) AND (` + filters[query.unionid] + ')';
    const params = Array(6).fill(query.search) as string[];
    const total = (db.prepare('SELECT count(*) n FROM users u WHERE ' + where).get(...params) as { n: number }).n;
    const rows = db.prepare(projection + ' WHERE ' + where + ' ORDER BY u.created_at DESC,u.id LIMIT 20 OFFSET ?').all(...params, query.offset) as UserRow[];
    return { users: rows.map(row => serialize(db, row)), total, offset: query.offset, limit: 20 };
  });
  app.get('/api/v2/admin/users/:id', async request => { admin.authority(request); return user(db, Identifier128Path.parse(request.params).id); });
  app.get('/api/v2/admin/users/:id/role-history', async request => {
    admin.authority(request); const id = Identifier128Path.parse(request.params).id; user(db, id);
    const { before } = PositiveCursorQuery.parse(request.query);
    const rows = db.prepare(`SELECT h.id,h.before_value,h.after_value,h.revision,h.created_at,h.actor_ref,u.nickname AS actor_name
      FROM admin_role_history h LEFT JOIN users u ON h.actor_ref='account:'||u.id WHERE h.user_id=? AND h.id<? ORDER BY h.id DESC LIMIT 51`).all(id, before) as { id: number; before_value: number; after_value: number; revision: number; created_at: string; actor_ref: string; actor_name: string | null }[];
    return { history: rows.slice(0, 50).map(row => ({ id: row.id, before: !!row.before_value, after: !!row.after_value, revision: row.revision, createdAt: row.created_at,
      actor: row.actor_ref === 'account_closure' ? '帳號關閉' : row.actor_ref.startsWith('account:') ? row.actor_name ?? '帳號管理員' : '救援憑證' })), nextCursor: rows.length > 50 ? rows[49]!.id : null };
  });
  function mutate(request: FastifyRequest, path: string, input: object, action: (access: ReturnType<AdminSecurity['authority']>, id: string) => void) {
    return db.transaction(() => {
      const access = admin.authority(request, true); const id = Identifier128Path.parse(request.params).id;
      const key = z.string().uuid().parse(request.headers['idempotency-key']); const signature = hash('v2:admin:' + path + ':' + id + ':' + JSON.stringify(input));
      const prior = db.prepare('SELECT signature FROM auth_requests WHERE token_hash=? AND request_key=?').get(access.receiptScope, key) as { signature: string } | undefined;
      if (prior) { if (prior.signature !== signature) throw withApiError(new DomainError('REQUEST_CONFLICT', '這個操作編號已用於其他內容', 409)); return { ok: true }; }
      user(db, id); admin.preserve(request); action(access, id);
      // Only a minimal acknowledgement is retained; private notes/identities are never copied to retry storage.
      db.prepare('INSERT INTO auth_requests VALUES(?,?,?,?,?)').run(access.receiptScope, key, signature, '{"ok":true}', now().toISOString());
      return { ok: true };
    }).immediate();
  }
  app.post('/api/v2/admin/users/:id/role', async request => {
    const input = SaveAdminRole.parse(request.body);
    return mutate(request, 'role', input, (access, id) => {
      const current = user(db, id);
      if (access.userId === id && !input.isAdmin) throw withApiError(new DomainError('SELF_REVOCATION', '不能撤銷目前登入帳號的管理權，請由其他管理員操作', 403));
      if (current.revision !== input.revision) throw withApiError(new DomainError('ROLE_CHANGED', '此帳號的權限已被修改，請核對目前版本', 409));
      if (current.isAdmin === input.isAdmin) return;
      const stamp = now().toISOString();
      db.prepare(`INSERT INTO user_admin_roles VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET is_admin=excluded.is_admin,revision=excluded.revision,updated_at=excluded.updated_at`).run(id, Number(input.isAdmin), input.revision + 1, stamp);
      db.prepare('INSERT INTO admin_role_history(user_id,actor_ref,before_value,after_value,revision,created_at) VALUES(?,?,?,?,?,?)').run(id, access.actorRef, Number(current.isAdmin), Number(input.isAdmin), input.revision + 1, stamp);
    });
  });
  app.post('/api/v2/admin/users/:id/metadata', async request => {
    const input = SaveAdminMetadata.parse(request.body);
    return mutate(request, 'metadata', input, (access, id) => {
      const current = user(db, id);
      if (current.metadataRevision !== input.revision) throw withApiError(new DomainError('METADATA_CHANGED', '備註或人工 QQ 已被修改，請核對目前版本', 409));
      if (input.manualQQ && db.prepare('SELECT 1 FROM admin_user_metadata WHERE manual_qq=? AND user_id!=?').get(input.manualQQ, id)) throw withApiError(new DomainError('MANUAL_QQ_CONFLICT', '此人工 QQ 已記錄於另一帳號，請先核對並解除原紀錄', 409));
      if (current.note === input.note && current.manualQQ === input.manualQQ) return;
      db.prepare(`INSERT INTO admin_user_metadata VALUES(?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET note=excluded.note,manual_qq=excluded.manual_qq,
        revision=excluded.revision,updated_at=excluded.updated_at,updated_by=excluded.updated_by`).run(id, input.note, input.manualQQ, input.revision + 1, now().toISOString(), access.actorRef);
    });
  });
}
