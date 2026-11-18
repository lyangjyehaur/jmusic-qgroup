import { withApiError } from './error-display';
import type { FastifyInstance } from 'fastify';
import type { DB } from '@qgroup/database';
import { z } from 'zod';
import { DomainError } from '@qgroup/domain';
import type { AdminSecurity } from './admin-security';

export function registerAdminOperations(app: FastifyInstance, db: DB, admin: AdminSecurity) {
  app.get('/api/v2/admin/operations/:key', async request => db.transaction(() => {
    const access = admin.authority(request);
    const { key } = z.object({ key: z.string().uuid() }).strict().parse(request.params);
    z.object({}).strict().parse(request.query);
    const scope = z.string().regex(/^[a-f0-9]{64}$/).parse(request.headers['x-admin-scope']);
    if (scope !== access.scope)
      throw withApiError(new DomainError('ADMIN_CHANGED', '原操作的管理授權已變更，請回原頁核對管理狀態。', 409));
    // Derive the receipt scope from current authority, never from a supplied token or target.
    return { committed: !!db.prepare('SELECT 1 FROM auth_requests WHERE token_hash=? AND request_key=?').get(access.receiptScope, key) };
  })());
}
