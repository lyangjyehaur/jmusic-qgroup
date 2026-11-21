import { Identifier128Path } from '@qgroup/contracts/http-paths';
import { withApiError } from './error-display';
import type { FastifyInstance } from 'fastify';
import type { DB } from '@qgroup/database';
import { z } from 'zod';
import { OffsetQuery, SavePrivacyReview } from '@qgroup/contracts';
import { DomainError } from '@qgroup/domain';
import type { AdminSecurity } from './admin-security';
import { sharedRecords } from './privacy';
import { hash } from './security';

type Row = { id: string; user_id: string; status: string; created_at: string; updated_at: string; note: string };

function entry(db: DB, id: string) {
  const row = db.prepare('SELECT * FROM privacy_requests WHERE id=?').get(id) as Row | undefined;
  if (!row) throw withApiError(new DomainError('PRIVACY_REQUEST_NOT_FOUND', '刪除申請不存在', 404));
  return project(db, row);
}
function project(db: DB, row: Row) {
  const shared = sharedRecords(db, row.user_id);
  return { id: row.id, userId: row.user_id, status: Object.keys(shared).length ? 'shared_review' : row.status,
    createdAt: row.created_at, updatedAt: row.updated_at, note: row.note, sharedRecords: shared,
    // Includes live shared-record counts, so a review cannot confirm an obsolete assessment.
    revision: hash('v2:privacy-review:' + JSON.stringify([row, shared])) };
}
export function registerAdminPrivacy(app: FastifyInstance, db: DB, admin: AdminSecurity, now: () => Date) {
  app.get('/api/v2/admin/privacy', async request => {
    admin.authority(request);
    const { offset } = OffsetQuery.parse(request.query);
    const total = (db.prepare('SELECT count(*) n FROM privacy_requests').get() as { n: number }).n;
    const rows = db.prepare('SELECT * FROM privacy_requests ORDER BY created_at DESC,id LIMIT 20 OFFSET ?').all(offset) as Row[];
    return { requests: rows.map(row => project(db, row)), total, offset, limit: 20 };
  });
  app.get('/api/v2/admin/privacy/:id', async request => { admin.authority(request); return entry(db, Identifier128Path.parse(request.params).id); });
  app.post('/api/v2/admin/privacy/:id/review', async request => {
    const input = SavePrivacyReview.parse(request.body);
    return db.transaction(() => {
      const access = admin.authority(request, true); const id = Identifier128Path.parse(request.params).id;
      const key = z.string().uuid().parse(request.headers['idempotency-key']);
      const signature = hash('v2:privacy-review:' + id + ':' + JSON.stringify(input));
      const receipt = db.prepare('SELECT signature FROM auth_requests WHERE token_hash=? AND request_key=?').get(access.receiptScope, key) as { signature: string } | undefined;
      if (receipt) {
        if (receipt.signature !== signature) throw withApiError(new DomainError('REQUEST_CONFLICT', '這個操作編號已用於其他內容', 409));
        return { ok: true };
      }
      const current = entry(db, id);
      if (current.revision !== input.revision) throw withApiError(new DomainError('PRIVACY_REVIEW_CHANGED', '申請或共享紀錄已變更，請核對目前資料', 409));
      admin.preserve(request);
      // No client-supplied status or completion checkbox can override real retained data.
      const status = Object.keys(current.sharedRecords).length ? 'shared_review' : 'completed';
      db.prepare('UPDATE privacy_requests SET note=?,status=?,updated_at=? WHERE id=?').run(input.note, status, now().toISOString(), id);
      db.prepare('INSERT INTO auth_requests VALUES(?,?,?,?,?)').run(access.receiptScope, key, signature, '{"ok":true}', now().toISOString());
      return { ok: true };
    }).immediate();
  });
}
