import type { FastifyInstance } from 'fastify';
import type { DB } from '@qgroup/database';
import { AcceptPrivacy, PRIVACY_VERSION } from '@qgroup/contracts';
import { DomainError } from '@qgroup/domain';
import { z } from 'zod';
import { hash, type Security } from './security';

export function consentState(db: DB, userId: string) {
  const row = db.prepare('SELECT accepted_at FROM unified_privacy_consents WHERE user_id=? AND version=?').get(userId, PRIVACY_VERSION) as { accepted_at: string } | undefined;
  return { version: PRIVACY_VERSION, accepted: !!row, acceptedAt: row?.accepted_at ?? null };
}
/** Called only after an explicit consent-bearing operation has been validated. */
export function recordConsent(db: DB, userId: string, acceptedAt: string, source: 'explicit' | 'name' | 'qq') {
  db.prepare('INSERT OR IGNORE INTO unified_privacy_consents VALUES(?,?,?,?)').run(userId, PRIVACY_VERSION, acceptedAt, source);
}
function receipt(db: DB, userId: string, key: string) {
  const row = db.prepare(`SELECT r.version,c.accepted_at FROM unified_privacy_receipts r JOIN unified_privacy_consents c
    ON c.user_id=r.user_id AND c.version=r.version WHERE r.user_id=? AND r.request_key=?`).get(userId, key) as { version: string; accepted_at: string } | undefined;
  if (!row) throw new DomainError('CONSENT_RECEIPT_NOT_FOUND', '尚未找到這次同意的完成紀錄', 404);
  return { requestKey: key, version: row.version, acceptedAt: row.accepted_at };
}
export function registerPrivacyConsent(app: FastifyInstance, db: DB, security: Security, now: () => Date) {
  app.get('/api/v2/me/privacy/consent', async request => consentState(db, security.scopedMember(request).id));
  app.get('/api/v2/me/privacy/consent/receipts/:key', async request => {
    const member = security.scopedMember(request);
    const { key } = z.object({ key: z.string().uuid() }).strict().parse(request.params);
    return receipt(db, member.id, key);
  });
  app.post('/api/v2/me/privacy/consent', { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async request => db.transaction(() => {
    const member = security.memberWrite(request), input = AcceptPrivacy.parse(request.body);
    const key = z.string().uuid().parse(request.headers['idempotency-key']);
    const signature = hash('v2:privacy-consent:' + JSON.stringify(input));
    const previous = db.prepare('SELECT signature FROM unified_privacy_receipts WHERE user_id=? AND request_key=?').get(member.id, key) as { signature: string } | undefined;
    if (previous) {
      if (signature !== previous.signature) throw new DomainError('REQUEST_CONFLICT', '這個操作編號已用於另一份同意內容', 409);
      return receipt(db, member.id, key); // Historical receipts remain readable after a policy update.
    }
    if (input.privacyVersion !== PRIVACY_VERSION) throw new DomainError('PRIVACY_CHANGED', '隱私政策版本已變更，請閱讀目前版本後重新確認', 409);
    recordConsent(db, member.id, now().toISOString(), 'explicit');
    db.prepare('INSERT INTO unified_privacy_receipts VALUES(?,?,?,?)').run(member.id, key, PRIVACY_VERSION, signature);
    return receipt(db, member.id, key);
  }).immediate());
}
