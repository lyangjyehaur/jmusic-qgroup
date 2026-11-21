import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DB } from '@qgroup/database';
import { MinVersionQuery, ArchivePaymentCode, CreatePaymentCode, PaymentCode, PaymentCodeId, PaymentKind, PaymentCodeSource, SettlementPaymentChoices, SettlementReceiptChoice } from '@qgroup/contracts';
import { DomainError } from '@qgroup/domain';
import { z } from 'zod';
import { legacyStamp } from './activity-arrangements';
import { requireActivityAccess } from './activity-access';
import { hash, type Security } from './security';
import { imageDigest, paymentImage, putPaymentImage, readPaymentImage, settlementReceipt } from './payment-media';

type Kind = z.infer<typeof PaymentKind>;
type CodeRow = { id: string; user_id: string; kind: Kind; name: string; digest: string; created_at: string; archived_at: string | null };
export type ResolvedPaymentCode = { meta: { kind: Kind; name: string; digest: string }; raw: Buffer };
const kinds: Kind[] = ['wechat', 'alipay', 'other'];
function fail(message: string, status = 400): never { throw new DomainError('PAYMENT_CODE', message, status); }
export function ownedPaymentCode(db: DB, userId: string, id: string, includeArchived = false) {
  const row = db.prepare('SELECT * FROM user_payment_codes WHERE id=? AND user_id=?').get(PaymentCodeId.parse(id), userId) as CodeRow | undefined;
  if (!row || (!includeArchived && row.archived_at)) fail('收款碼不存在或不屬於目前帳號', 404); return row;
}
const codeView = (row: CodeRow) => PaymentCode.parse({ id: row.id, kind: row.kind, name: row.name, created_at: row.created_at, url: '/api/v2/me/payment-codes/' + row.id + '/image' });
export function paymentCodeLibrary(db: DB, userId: string) {
  return { codes: (db.prepare('SELECT * FROM user_payment_codes WHERE user_id=? AND archived_at IS NULL ORDER BY created_at DESC,id DESC').all(userId) as CodeRow[]).map(codeView) };
}
export function settlementPublishedBy(db: DB, eventId: string, version: number, userId: string) {
  return !!db.prepare('SELECT 1 FROM settlement_history WHERE event_id=? AND version=? AND actor_id=?').get(eventId, version, userId);
}
export function frozenPaymentCodes(db: DB, eventId: string, version: number) {
  return (db.prepare('SELECT kind,name,digest FROM settlement_code_images WHERE event_id=? AND version=?').all(eventId, version) as ResolvedPaymentCode['meta'][]).sort((a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind));
}
export function existingPaymentCodes(db: DB, eventId: string, version: number): ResolvedPaymentCode[] {
  const rows = frozenPaymentCodes(db, eventId, version);
  if (rows.length) return rows.map(meta => ({ meta, raw: readPaymentImage(db, meta.digest) }));
  const old = db.prepare('SELECT qr_image FROM settlement_history WHERE event_id=? AND version=?').get(eventId, version) as { qr_image: Buffer | null } | undefined;
  return old?.qr_image ? [{ meta: { kind: 'other', name: '', digest: imageDigest(old.qr_image) }, raw: old.qr_image }] : [];
}
export function paymentCodeDescriptors(db: DB, eventId: string, version: number) {
  const base = '/api/v2/activities/' + encodeURIComponent(eventId) + '/settlement/history/' + version;
  const rows = frozenPaymentCodes(db, eventId, version);
  if (rows.length) return rows.map(row => ({ kind: row.kind, name: row.name, url: base + '/payment-codes/' + row.kind }));
  const old = db.prepare('SELECT length(qr_image) AS size FROM settlement_history WHERE event_id=? AND version=?').get(eventId, version) as { size: number | null } | undefined;
  return old?.size ? [{ kind: 'other' as const, name: '', url: base + '/payment-code' }] : [];
}
export function resolvePaymentCodes(db: DB, eventId: string, userId: string, currentVersion: number, values: z.infer<typeof SettlementPaymentChoices>): ResolvedPaymentCode[] {
  return SettlementPaymentChoices.parse(values).map(choice => {
    if ('code_id' in choice) {
      const row = ownedPaymentCode(db, userId, choice.code_id); if (row.kind !== choice.kind) fail('收款碼類別不一致，請重新選擇');
      return { meta: { kind: row.kind, name: row.name, digest: row.digest }, raw: readPaymentImage(db, row.digest) };
    }
    if ('image' in choice) { const raw = paymentImage(choice.image); return { meta: { kind: choice.kind, name: choice.name, digest: imageDigest(raw) }, raw }; }
    if (choice.version > currentVersion) fail('原版收款碼不存在，請重新選擇');
    if (!settlementPublishedBy(db, eventId, choice.version, userId)) fail('收款人已變更，請選擇目前帳號自己的收款碼', 403);
    const prior = existingPaymentCodes(db, eventId, choice.version).find(code => code.meta.kind === choice.kind);
    if (!prior) fail('原版收款碼不存在，請重新選擇'); return prior;
  }).sort((a, b) => kinds.indexOf(a.meta.kind) - kinds.indexOf(b.meta.kind));
}
export function resolveSettlementReceipt(db: DB, eventId: string, currentVersion: number, value: z.infer<typeof SettlementReceiptChoice>): Buffer | null {
  const choice = SettlementReceiptChoice.parse(value); if (choice === null) return null; if (typeof choice === 'string') return paymentImage(choice);
  if (choice.version > currentVersion) fail('消費憑證不存在，請重新選擇圖片');
  const raw = settlementReceipt(db, eventId, choice.version, choice.item_id); if (!raw) fail('消費憑證不存在，請重新選擇圖片'); return raw;
}
export function attachPaymentCodes(db: DB, eventId: string, version: number, codes: ResolvedPaymentCode[], now: Date) {
  for (const { meta, raw } of codes) db.prepare('INSERT INTO settlement_code_images VALUES(?,?,?,?,?)').run(eventId, version, meta.kind, meta.name, putPaymentImage(db, raw, now));
}
function sourceAuthority(db: DB, userId: string, source: z.infer<typeof PaymentCodeSource>) {
  const event = db.prepare("SELECT 1 FROM events WHERE id=? AND status!='deleted'").get(source.event_id);
  if (!event || !settlementPublishedBy(db, source.event_id, source.version, userId)) fail('只能保存自己發布結算時使用的收款碼', 403);
}
export function registerPaymentAssets(app: FastifyInstance, db: DB, security: Security, now: () => Date) {
  const libraryId = z.object({ codeId: PaymentCodeId }), version = z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
  const historyParams = z.object({ id: z.string().min(1).max(80), version });
  const limits = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };
  function eventAccess(request: FastifyRequest, legacy = false) {
    const { id } = z.object({ id: z.string().min(1).max(80) }).parse(request.params), device = security.read(request);
    if (request.headers['x-account-scope'] || (!legacy && device)) security.scoped(request);
    requireActivityAccess(db, id, device?.kind === 'member' ? device.id : null);
    return { id, userId: device?.kind === 'member' ? device.id : null };
  }
  app.get('/api/v2/me/payment-codes', async request => paymentCodeLibrary(db, security.scopedMember(request).id));
  app.post('/api/v2/me/payment-codes', { ...limits, bodyLimit: 3 * 1024 * 1024 }, async request => db.transaction(() => {
    const user = security.memberWrite(request), input = CreatePaymentCode.parse(request.body), key = z.string().uuid().parse(request.headers['idempotency-key']);
    if ('source' in input) sourceAuthority(db, user.id, input.source);
    const signature = 'payment-code:create:' + hash(JSON.stringify(input));
    const old = db.prepare('SELECT signature,response_json FROM request_results WHERE user_id=? AND request_key=?').get(user.id, key) as { signature: string; response_json: string } | undefined;
    if (old) { if (old.signature !== signature) fail('這個操作編號已用於另一份內容', 409); return PaymentCode.parse(JSON.parse(old.response_json)); }
    const raw = 'image' in input ? paymentImage(input.image) : existingPaymentCodes(db, input.source.event_id, input.source.version).find(code => code.meta.kind === input.source.kind)?.raw;
    if (!raw) fail('原版收款碼不存在，請重新選擇');
    const digest = imageDigest(raw);
    let row = db.prepare('SELECT * FROM user_payment_codes WHERE user_id=? AND kind=? AND digest=? AND name=? AND archived_at IS NULL').get(user.id, input.kind, digest, input.name) as CodeRow | undefined;
    const stamp = legacyStamp(now());
    if (!row) {
      if ((db.prepare('SELECT count(*) AS count FROM user_payment_codes WHERE user_id=? AND archived_at IS NULL').get(user.id) as { count: number }).count >= 30) fail('最多保存 30 張收款碼，請先移除不再使用的碼');
      putPaymentImage(db, raw, now()); const id = randomBytes(8).toString('hex');
      db.prepare('INSERT INTO user_payment_codes VALUES(?,?,?,?,?,?,NULL)').run(id, user.id, input.kind, input.name, digest, stamp); row = ownedPaymentCode(db, user.id, id);
    }
    const result = codeView(row); db.prepare('INSERT INTO request_results VALUES(?,?,?,?,?,?)').run(user.id, key, signature, JSON.stringify(result), 200, stamp); return result;
  }).immediate());
  app.delete('/api/v2/me/payment-codes/:codeId', limits, async request => db.transaction(() => {
    const user = security.memberWrite(request), { codeId } = libraryId.parse(request.params), input = ArchivePaymentCode.parse(request.body), key = z.string().uuid().parse(request.headers['idempotency-key']);
    const row = ownedPaymentCode(db, user.id, codeId, true), signature = 'payment-code:archive:' + codeId + ':' + hash(JSON.stringify(input));
    const old = db.prepare('SELECT signature,response_json FROM request_results WHERE user_id=? AND request_key=?').get(user.id, key) as { signature: string; response_json: string } | undefined;
    if (old) { if (old.signature !== signature) fail('這個操作編號已用於另一份內容', 409); return { ok: true }; }
    if (row.archived_at) fail('收款碼已移除', 404);
    const stamp = legacyStamp(now()); db.prepare('UPDATE user_payment_codes SET archived_at=? WHERE id=?').run(stamp, codeId);
    db.prepare('INSERT INTO request_results VALUES(?,?,?,?,?,?)').run(user.id, key, signature, '{"ok":true}', 200, stamp); return { ok: true };
  }).immediate());
  app.get('/api/v2/me/payment-codes/:codeId/image', async (request, reply) => {
    const user = security.scopedMember(request), { codeId } = libraryId.parse(request.params), row = ownedPaymentCode(db, user.id, codeId);
    return reply.header('Vary', 'Cookie, X-Account-Scope').header('Content-Disposition', 'inline; filename="payment-code.png"').type('image/png').send(readPaymentImage(db, row.digest));
  });
  app.get('/api/v2/activities/:id/settlement/history/:version/assets', async request => db.transaction(() => {
    const { id, userId } = eventAccess(request), { version } = historyParams.parse(request.params);
    if (!db.prepare('SELECT 1 FROM settlement_history WHERE event_id=? AND version=?').get(id, version)) fail('結算版本不存在', 404);
    const row = db.prepare('SELECT snapshot_json FROM settlement_details WHERE event_id=? AND version=?').get(id, version) as { snapshot_json: string } | undefined;
    const items = row ? z.object({ items: z.array(z.object({ id: z.string(), name: z.string().optional() })).optional() }).parse(JSON.parse(row.snapshot_json)).items ?? [] : [];
    const refs = db.prepare('SELECT item_id FROM settlement_receipt_images WHERE event_id=? AND version=? UNION SELECT item_id FROM settlement_receipts WHERE event_id=? AND version=? ORDER BY item_id').all(id, version, id, version) as { item_id: string }[];
    const receipts = refs.map(ref => ({ item_id: ref.item_id, name: items.find(item => item.id === ref.item_id)?.name ?? '消費憑證', url: '/api/v2/activities/' + encodeURIComponent(id) + '/settlement/history/' + version + '/receipts/' + ref.item_id }));
    return { codes: paymentCodeDescriptors(db, id, version), receipts, can_save: !!userId && settlementPublishedBy(db, id, version, userId) };
  })());
  app.get('/api/v2/activities/:id/settlement/asset-versions', async request => db.transaction(() => {
    const { id } = eventAccess(request), query = MinVersionQuery.parse(request.query);
    const rows = db.prepare('SELECT version,total_cents,headcount,actor_name,updated_at FROM settlement_history WHERE event_id=? AND version<? ORDER BY version DESC LIMIT 51').all(id, query.before ?? Number.MAX_SAFE_INTEGER) as { version: number; total_cents: number; headcount: number; actor_name: string; updated_at: string }[];
    return { versions: rows.slice(0, 50), next_before: rows.length > 50 ? rows[49]!.version : null };
  })());
  for (const legacy of [false, true]) {
    const prefix = legacy ? '/api/events/:id' : '/api/v2/activities/:id';
    app.get(prefix + '/settlement/history/:version/payment-codes/:kind', async (request, reply) => {
      const { id } = eventAccess(request, legacy), { version, kind } = historyParams.extend({ kind: PaymentKind }).parse(request.params);
      const code = frozenPaymentCodes(db, id, version).find(row => row.kind === kind); if (!code) fail('收款碼不存在', 404);
      return reply.type('image/png').header('Content-Disposition', 'inline; filename="payment-code.png"').send(readPaymentImage(db, code.digest));
    });
    app.get(prefix + '/settlement/history/:version/payment-code', async (request, reply) => {
      const { id } = eventAccess(request, legacy), { version } = historyParams.parse(request.params), code = existingPaymentCodes(db, id, version)[0];
      if (!code) fail('收款碼不存在', 404); return reply.type('image/png').header('Content-Disposition', 'inline; filename="payment-code.png"').send(code.raw);
    });
    app.get(prefix + '/settlement/history/:version/receipts/:itemId', async (request, reply) => {
      const { id } = eventAccess(request, legacy), { version, itemId } = historyParams.extend({ itemId: PaymentCodeId }).parse(request.params), raw = settlementReceipt(db, id, version, itemId);
      if (!raw) fail('消費憑證不存在', 404); return reply.type('image/png').header('Content-Disposition', 'inline; filename="receipt.png"').send(raw);
    });
    app.get(prefix + '/payment-code', async (request, reply) => {
      const { id } = eventAccess(request, legacy), row = db.prepare('SELECT COALESCE(MAX(version),0) AS version FROM settlement_history WHERE event_id=?').get(id) as { version: number }, code = existingPaymentCodes(db, id, row.version)[0];
      if (!code) fail('收款碼不存在', 404); return reply.type('image/png').header('Content-Disposition', 'inline; filename="payment-code.png"').send(code.raw);
    });
  }
}
