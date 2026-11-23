import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { createApp } from './app';
import { fixture } from '../testsupport/fixture';
import { paymentFixture, pngChunk, testPNG } from '../testsupport/payment-fixture';
import { attachPaymentCodes, existingPaymentCodes, paymentCodeDescriptors, resolvePaymentCodes, resolveSettlementReceipt } from './payment-codes';
import { imageDigest, paymentImage, putPaymentImage, readPaymentImage } from './payment-media';
import { prunePrivateImages } from './privacy-assets';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const origin = 'https://rebuild.example', now = new Date('2026-11-17T08:00:00Z');
async function setup(frozen = false) {
  const root = mkdtempSync(join(tmpdir(), 'qgroup-payment-')), db = openDatabase(join(root, 'state.db')); fixture(db); if (frozen) paymentFixture(db);
  const app = createApp({ db, origin, now: () => now }); await app.ready(); cleanup.push(async () => { await app.close(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const headers = async (user = 'alice') => { const cookie = 'kanban_session=fixture-' + user, viewer = (await app.inject({ url: '/api/v2/session', headers: { cookie } })).json(); return { cookie, origin, 'x-account-scope': viewer.scope, 'x-csrf-token': viewer.csrf, 'idempotency-key': randomUUID() }; };
  const auth = await headers(), payload = { kind: 'wechat', name: '原文後臺', image: testPNG().toString('base64'), confirm: true };
  const save = (input: object = payload, extra: Record<string, string> = {}) => app.inject({ method: 'POST', url: '/api/v2/me/payment-codes', headers: { ...auth, ...extra }, payload: input });
  const get = (url = '/api/v2/me/payment-codes', extra: Record<string, string> = {}) => app.inject({ url, headers: { ...auth, ...extra } });
  const archive = (id: string, extra: Record<string, string> = {}) => app.inject({ method: 'DELETE', url: '/api/v2/me/payment-codes/' + id, headers: { ...auth, 'idempotency-key': randomUUID(), ...extra }, payload: { confirm: true } });
  return { root, db, app, headers, auth, payload, save, get, archive };
}
describe('private payment library and immutable invoice assets', () => {
  it('matches original whitespace in code names without dropping BOM or changing an exact retry', async () => {
    const s=await setup(),names=['\u0085原碼\u0085','\u001c原碼\u001c','\ufeff原碼\ufeff','第一行\n第二行','原\u0000碼'],
      expected=JSON.parse(execFileSync('python3',['-c',"import json,sys\nfrom qgroup_core.common import string\nprint(json.dumps([string({'name':n},'name',40,False) for n in json.loads(sys.argv[1])]))",JSON.stringify(names)],{encoding:'utf8',timeout:15000}));
    for (const [i,name] of names.entries()) {
      const key=randomUUID(),input={...s.payload,name},saved=await s.save(input,{'idempotency-key':key});
      expect(saved.statusCode,saved.body).toBe(200);expect(saved.json().name).toBe(expected[i]);
      expect((await s.save(input,{'idempotency-key':key})).body).toBe(saved.body);
      expect((await s.get(saved.json().url)).rawPayload).toEqual(testPNG());
    }
    expect((await s.get()).json().codes).toHaveLength(4);
  });
  it('validates PNG dimensions, CRCs, chunks, exact EOF, format and size against retained Python', () => {
    const valid = testPNG(), badCrc = Buffer.from(valid); badCrc[35] = badCrc[35]! ^ 1;
    const candidates = [valid, testPNG([0, 20, 10], 1600, 1600), testPNG([0, 0, 0], 1601), testPNG([0, 0, 0], 0), badCrc, valid.subarray(0, -1), Buffer.concat([valid, Buffer.from('x')]), Buffer.from('JPEG'), Buffer.concat([valid.subarray(0, 33), pngChunk('IEND', Buffer.alloc(0))]), Buffer.concat([valid.subarray(0, 33), valid.subarray(8)]), Buffer.concat([valid.subarray(0, 33), pngChunk('tEXt', Buffer.alloc(2 * 1024 * 1024)), valid.subarray(33)])].map(raw => raw.toString('base64'));
    candidates.push('invalid', valid.toString('base64') + '\n');
    // A file avoids blocking a multi-megabyte stdin pipe when other suites spawn children.
    const root = mkdtempSync(join(tmpdir(), 'qgroup-png-diff-')), input = join(root, 'images.json'); let expected: boolean[];
    try {
      writeFileSync(input, JSON.stringify(candidates));
      expected = JSON.parse(execFileSync('python3', ['-c', 'import json,sys\nfrom qgroup_core.billing import qr_image\nresult=[]\nfor value in json.load(open(sys.argv[1])):\n try: qr_image(value);result.append(True)\n except Exception: result.append(False)\nprint(json.dumps(result))', input], { encoding: 'utf8', timeout: 15000 }));
    } finally { rmSync(root, { recursive: true, force: true }); }
    expect(candidates.map(value => { try { paymentImage(value); return true; } catch { return false; } })).toEqual(expected);
    expect(() => paymentImage('A'.repeat(2800004))).toThrow('過大'); expect(paymentImage(valid.toString('base64'))).toEqual(valid);
  });
  it('stores durable private images once, deduplicates content and retries exact receipts without retaining the upload in request results', async () => {
    const s = await setup(), result = await s.save(); expect(result.statusCode).toBe(200); const code = result.json();
    expect(code).toMatchObject({ kind: 'wechat', name: s.payload.name }); expect(Object.keys(code).sort()).toEqual(['created_at', 'id', 'kind', 'name', 'url']);
    expect((await s.save()).json()).toEqual(code); expect((await s.save(s.payload, { 'idempotency-key': randomUUID() })).json()).toEqual(code);
    expect((await s.save({ ...s.payload, name: '衝突' })).statusCode).toBe(409);
    const image = await s.get(code.url); expect(image.rawPayload).toEqual(testPNG()); expect(image.headers['cache-control']).toBe('no-store'); expect(image.headers['x-content-type-options']).toBe('nosniff');
    expect((await s.get()).json().codes).toEqual([code]); expect(s.db.prepare('SELECT * FROM image_assets').all()).toHaveLength(1);
    const resultRows = JSON.stringify(s.db.prepare('SELECT * FROM request_results').all()); expect(resultRows).not.toContain(s.payload.image); expect(resultRows).not.toContain(imageDigest(testPNG()));
    expect(readFileSync(join(s.root, 'images', imageDigest(testPNG()).slice(0, 2), imageDigest(testPNG()) + '.png'))).toEqual(testPNG());
    expect((await s.app.inject({ url: '/images/' + imageDigest(testPNG()) + '.png' })).statusCode).toBe(404);
  });
  it('accepts a valid exact 2 MB PNG through the bounded JSON route and refuses larger images without storing references', async () => {
    const s = await setup(), base = testPNG(), padding = 2 * 1024 * 1024 - base.length - 12;
    const raw = Buffer.concat([base.subarray(0, -12), pngChunk('tEXt', Buffer.alloc(padding, 65)), base.subarray(-12)]);
    expect(raw.length).toBe(2 * 1024 * 1024); const result = await s.save({ ...s.payload, image: raw.toString('base64') }); expect(result.statusCode).toBe(200); expect((await s.get(result.json().url)).rawPayload).toEqual(raw);
    const oversized = Buffer.concat([base.subarray(0, -12), pngChunk('tEXt', Buffer.alloc(padding + 1, 65)), base.subarray(-12)]);
    expect((await s.save({ ...s.payload, image: oversized.toString('base64') }, { 'idempotency-key': randomUUID() })).statusCode).toBe(400);
    expect(s.db.prepare('SELECT * FROM image_assets').all()).toHaveLength(1); expect(s.db.prepare('SELECT * FROM user_payment_codes').all()).toHaveLength(1);
    expect((await s.save({ ...s.payload, image: 'A'.repeat(3 * 1024 * 1024) }, { 'idempotency-key': randomUUID() })).statusCode).toBe(413);
  });
  it('enforces scope, membership, same origin, CSRF and strict input before mutations or replay', async () => {
    const s = await setup(); expect((await s.save()).statusCode).toBe(200);
    const rejectedHeaders: Record<string, string>[] = [{ 'x-account-scope': '' }, { 'x-account-scope': 'wrong' }, { 'x-csrf-token': '' }, { origin: 'https://foreign.example' }, { cookie: '' }];
    for (const extra of rejectedHeaders) expect((await s.save(s.payload, extra)).statusCode).toBeGreaterThanOrEqual(400);
    for (const input of [{ ...s.payload, kind: 'cash' }, { ...s.payload, name: 'x'.repeat(41) }, { ...s.payload, confirm: false }, { ...s.payload, source: { event_id: 'past', version: 1, kind: 'wechat' } }, { ...s.payload, image: 'not-png' }]) expect((await s.save(input, { 'idempotency-key': randomUUID() })).statusCode).toBe(400);
    expect((await s.get('/api/v2/me/payment-codes', { 'x-account-scope': '' })).statusCode).toBe(409);
    expect((await s.get('/api/v2/me/payment-codes', { cookie: '' })).statusCode).toBe(401);
    s.db.prepare('DELETE FROM browser_sessions').run(); expect((await s.save()).statusCode).toBe(401);
  });
  it('isolates users and archives only the selected code while old invoice references and exact retry remain valid', async () => {
    const s = await setup(), code = (await s.save()).json(), bob = await s.headers('bob');
    expect((await s.get(undefined, bob)).json()).toEqual({ codes: [] }); expect((await s.get(code.url, bob)).statusCode).toBe(404); expect((await s.archive(code.id, bob)).statusCode).toBe(404);
    s.db.prepare("INSERT INTO settlement_history(event_id,version,total_cents,headcount,note,qr_image,updated_at,actor_id,actor_name,kind,changed_fields) VALUES('past',1,100,1,'',NULL,'stamp','alice','小青','detailed_published','[]')").run();
    const choices = resolvePaymentCodes(s.db, 'past', 'alice', 0, [{ kind: 'wechat', code_id: code.id }]); s.db.transaction(() => attachPaymentCodes(s.db, 'past', 1, choices, now)).immediate();
    const key = randomUUID(); expect((await s.archive(code.id, { 'idempotency-key': key })).json()).toEqual({ ok: true }); expect((await s.archive(code.id, { 'idempotency-key': key })).json()).toEqual({ ok: true });
    expect((await s.archive(code.id)).statusCode).toBe(404); expect((await s.get()).json()).toEqual({ codes: [] }); expect((await s.get(code.url)).statusCode).toBe(404);
    const frozen = paymentCodeDescriptors(s.db, 'past', 1)[0]!; expect((await s.app.inject({ url: frozen.url })).rawPayload).toEqual(testPNG());
    expect(() => resolvePaymentCodes(s.db, 'past', 'alice', 1, [{ kind: 'wechat', code_id: code.id }])).toThrow('不存在');
    expect(resolvePaymentCodes(s.db, 'past', 'alice', 1, [{ kind: 'wechat', version: 1 }])[0]!.raw).toEqual(testPNG());
    expect(() => resolvePaymentCodes(s.db, 'past', 'bob', 1, [{ kind: 'wechat', version: 1 }])).toThrow('收款人已變更');
    expect((await s.save()).json()).toEqual(code); // Cached create is a receipt, never an unarchive.
    expect((await s.get()).json()).toEqual({ codes: [] });
  });
  it('caps active library at 30 but permits exact duplicate, archived replacement, every kind and 40 Unicode characters', async () => {
    const s = await setup(), code = (await s.save()).json(), digest = imageDigest(testPNG());
    for (let i = 1; i < 30; i++) s.db.prepare("INSERT INTO user_payment_codes VALUES(?,'alice','other',?,?,'stamp',NULL)").run(i.toString(16).padStart(16, '0'), String(i), digest);
    expect((await s.save(s.payload, { 'idempotency-key': randomUUID() })).json()).toEqual(code);
    expect((await s.save({ ...s.payload, name: '新碼' }, { 'idempotency-key': randomUUID() })).json().message).toContain('30');
    await s.archive(code.id); const next = await s.save({ ...s.payload, kind: 'alipay', name: '🎼'.repeat(40) }, { 'idempotency-key': randomUUID() }); expect(next.statusCode).toBe(200);
    expect((await s.get()).json().codes).toHaveLength(30); expect(s.db.prepare('SELECT count(*) AS count FROM image_assets').get()).toEqual({ count: 1 });
  });
  it('resolves one of each kind in fixed order and same-event receipt references, rejecting duplicates, foreign codes and future versions', async () => {
    const s = await setup(true), code = (await s.save()).json();
    const choices = resolvePaymentCodes(s.db, 'past', 'alice', 2, [{ kind: 'other', image: s.payload.image, name: '' }, { kind: 'wechat', code_id: code.id }, { kind: 'alipay', image: s.payload.image, name: 'Ali' }]);
    expect(choices.map(choice => choice.meta.kind)).toEqual(['wechat', 'alipay', 'other']);
    for (const choices of [[{ kind: 'wechat', code_id: code.id }, { kind: 'wechat', version: 1 }], [{ kind: 'wechat', version: 3 }], [{ kind: 'alipay', code_id: code.id }]] as const) expect(() => resolvePaymentCodes(s.db, 'past', 'alice', 2, [...choices])).toThrow();
    expect(() => resolvePaymentCodes(s.db, 'past', 'bob', 2, [{ kind: 'wechat', code_id: code.id }])).toThrow();
    expect(resolveSettlementReceipt(s.db, 'past', 2, { version: 1, item_id: '1234567890abcdef' })).toEqual(testPNG());
    expect(resolveSettlementReceipt(s.db, 'past', 2, null)).toBeNull(); expect(resolveSettlementReceipt(s.db, 'past', 2, s.payload.image)).toEqual(testPNG());
    for (const [id, version] of [['listen', 1], ['past', 3]] as const) expect(() => resolveSettlementReceipt(s.db, id, 2, { version, item_id: '1234567890abcdef' })).toThrow('不存在');
  });
  it('imports only the publisher’s own frozen source, including old versions after a collector change, and rechecks authority on replay', async () => {
    const s = await setup(true), source = { kind: 'other', name: '另存', source: { event_id: 'past', version: 1, kind: 'wechat' }, confirm: true };
    const saved = await s.save(source); expect(saved.statusCode).toBe(200); expect((await s.get(saved.json().url)).rawPayload).toEqual(testPNG());
    expect((await s.save(source, await s.headers('bob'))).statusCode).toBe(403);
    expect((await s.save({ ...source, source: { ...source.source, version: 2 } }, { 'idempotency-key': randomUUID() })).statusCode).toBe(403);
    expect((await s.save({ ...source, source: { ...source.source, kind: 'alipay' } }, { 'idempotency-key': randomUUID() })).statusCode).toBe(400);
    s.db.prepare("UPDATE events SET status='deleted' WHERE id='past'").run(); expect((await s.save(source)).statusCode).toBe(403);
  });
  it('keeps frozen images and receipts under current event access, without site-admin or stale-scope bypass', async () => {
    const s = await setup(true), publicAsset = '/api/v2/activities/past/settlement/history/1/assets';
    expect((await s.app.inject({ url: publicAsset })).json()).toMatchObject({ can_save: false, codes: [{ kind: 'wechat', name: '本版原碼' }] });
    expect((await s.get(publicAsset)).json().can_save).toBe(true); expect((await s.get(publicAsset, await s.headers('bob'))).json().can_save).toBe(false);
    const paths = ['/settlement/history/1/assets', '/settlement/history/1/payment-codes/wechat', '/settlement/history/1/receipts/1234567890abcdef', '/settlement/history/1/payment-code', '/settlement/asset-versions'];
    const bob = await s.headers('bob'); s.db.prepare("INSERT INTO user_admin_roles VALUES('bob',1,1,'stamp')").run();
    for (const path of paths) {
      const url = '/api/v2/activities/invite' + path; expect((await s.app.inject({ url })).statusCode).toBe(404); expect((await s.get(url, bob)).statusCode).toBe(404); expect((await s.get(url, { 'x-account-scope': 'stale' })).statusCode).toBe(409);
    }
    s.db.prepare("INSERT INTO event_access VALUES('invite','bob','stamp')").run();
    for (const path of paths) expect((await s.get('/api/v2/activities/invite' + path, bob)).statusCode).toBe(200);
    s.db.prepare("DELETE FROM event_access WHERE user_id='bob'").run(); expect((await s.get('/api/v2/activities/invite' + paths[1], bob)).statusCode).toBe(404);
    expect((await s.get('/api/v2/activities/past/settlement/history/99/assets')).statusCode).toBe(404);
    expect((await s.get('/api/v2/activities/past/settlement/history/1.1/assets')).statusCode).toBe(400);
    expect((await s.get('/api/v2/activities/past/payment-code')).statusCode).toBe(404); // New version intentionally removed its code.
  });
  it('reads legacy BLOB originals and legacy image links without modifying historical bytes', async () => {
    const s = await setup(), raw = testPNG([3, 2, 1]);
    s.db.prepare("INSERT INTO settlement_history(event_id,version,total_cents,headcount,note,qr_image,updated_at,actor_id,actor_name,kind,changed_fields) VALUES('past',1,100,3,'',?,'stamp','alice','小青','published','[]')").run(raw);
    s.db.prepare("INSERT INTO settlement_details VALUES('past',1,'{}')").run();
    s.db.prepare("INSERT INTO settlement_receipts VALUES('past',1,'1234567890abcdef',?)").run(raw);
    const descriptor = paymentCodeDescriptors(s.db, 'past', 1)[0]!; expect(descriptor.kind).toBe('other'); expect((await s.get(descriptor.url)).rawPayload).toEqual(raw);
    for (const suffix of ['/payment-code', '/settlement/history/1/payment-code', '/settlement/history/1/receipts/1234567890abcdef']) expect((await s.app.inject({ url: '/api/events/past' + suffix, headers: { cookie: s.auth.cookie } })).rawPayload).toEqual(raw);
    const source = { kind: 'other', name: '', source: { event_id: 'past', version: 1, kind: 'other' }, confirm: true };
    expect((await s.save(source)).statusCode).toBe(200); expect((s.db.prepare("SELECT qr_image FROM settlement_history WHERE event_id='past'").get() as { qr_image: Buffer }).qr_image).toEqual(raw);
  });
  it('returns recoverable errors on missing or corrupt files and retries successfully after restoration', async () => {
    const s = await setup(), code = (await s.save()).json(), digest = imageDigest(testPNG()), path = join(s.root, 'images', digest.slice(0, 2), digest + '.png');
    unlinkSync(path); expect((await s.get(code.url)).statusCode).toBe(503);
    writeFileSync(path, 'corrupt'); expect((await s.get(code.url)).statusCode).toBe(503);
    writeFileSync(path, testPNG()); expect((await s.get(code.url)).rawPayload).toEqual(testPNG());
    expect((await s.get('/api/v2/activities/past/settlement/history/1/receipts/1234567890abcdef')).statusCode).toBe(404);
  });
  it('rolls back references and receipts on required persistence failure, leaving any durable orphan unreachable until prune', async () => {
    const s = await setup(); s.db.exec("CREATE TRIGGER fail_payment_receipt BEFORE INSERT ON request_results BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END");
    expect((await s.save()).statusCode).toBe(500); expect((await s.get()).json()).toEqual({ codes: [] });
    for (const table of ['image_assets', 'user_payment_codes', 'request_results']) expect(s.db.prepare('SELECT * FROM ' + table).all()).toEqual([]);
    const digest = imageDigest(testPNG()), path = join(s.root, 'images', digest.slice(0, 2), digest + '.png'); expect(existsSync(path)).toBe(true); expect(() => readPaymentImage(s.db, digest)).toThrow('不存在');
    prunePrivateImages(s.db); expect(existsSync(path)).toBe(false); s.db.exec('DROP TRIGGER fail_payment_receipt'); expect((await s.save()).statusCode).toBe(200);
  });
  it('refuses symbolic image directories and file substitution, without overwriting existing data', async () => {
    const s = await setup(), external = join(s.root, 'outside'); mkdirSync(external); symlinkSync(external, join(s.root, 'images'));
    expect((await s.save()).statusCode).toBe(500); unlinkSync(join(s.root, 'images'));
    expect((await s.save()).statusCode).toBe(200); const digest = imageDigest(testPNG()), path = join(s.root, 'images', digest.slice(0, 2), digest + '.png'), secret = join(external, 'secret');
    writeFileSync(secret, 'private'); unlinkSync(path); symlinkSync(secret, path); const url = (await s.get()).json().codes[0].url;
    expect((await s.get(url)).statusCode).toBe(503); expect(() => s.db.transaction(() => putPaymentImage(s.db, testPNG(), now)).immediate()).toThrow('integrity'); expect(readFileSync(secret, 'utf8')).toBe('private');
  });
  it('handles simultaneous exact requests once and never changes bot, finance, roster or bill state for library operations', async () => {
    const s = await setup(true), tables = ['events', 'attendees', 'settlement_history', 'settlement_code_images', 'settlement_receipt_images', 'finance_entries', 'bot_outbox', 'notifications', 'event_audit'], before = tables.map(table => s.db.prepare('SELECT * FROM ' + table).all());
    const responses = await Promise.all([s.save(), s.save()]); expect(responses[0]!.json()).toEqual(responses[1]!.json()); expect(s.db.prepare('SELECT * FROM user_payment_codes').all()).toHaveLength(1);
    await s.archive(responses[0]!.json().id); expect(tables.map(table => s.db.prepare('SELECT * FROM ' + table).all())).toEqual(before); expect(s.db.pragma('foreign_key_check')).toEqual([]);
  });
  it('shares native image metadata, files, frozen codes and receipts with retained Python in both directions', async () => {
    const s = await setup(true), saved = (await s.save()).json();
    const result = JSON.parse(execFileSync('python3', ['-c', `import json,sys,sqlite3,hashlib,base64
from qgroup_core import payment_codes,media
db=sqlite3.connect(sys.argv[1]);db.row_factory=sqlite3.Row
row=payment_codes.owned(db,'alice',sys.argv[2])
old=payment_codes.existing(db,'past',1)
receipt=media.receipt(db,'past',1,'1234567890abcdef')
new=payment_codes.create(db,{'id':'bob'},{'kind':'alipay','name':'Python 原碼','image':sys.argv[3]});db.commit()
print(json.dumps({'digest':hashlib.sha256(media.read(db,row['digest'])).hexdigest(),'frozen':old[0][0],'receipt':hashlib.sha256(receipt).hexdigest(),'new':new}))`, s.db.name, saved.id, testPNG([1, 2, 3]).toString('base64')], { encoding: 'utf8', timeout: 15000 }));
    expect(result.digest).toBe(imageDigest(testPNG())); expect(result.receipt).toBe(result.digest); expect(result.frozen).toEqual(existingPaymentCodes(s.db, 'past', 1)[0]!.meta);
    const bob = await s.headers('bob'), code = (await s.get(undefined, bob)).json().codes[0]; expect(code.name).toBe('Python 原碼'); expect((await s.get(code.url, bob)).rawPayload).toEqual(testPNG([1, 2, 3]));
  });
  it('paginates frozen image versions independently of current finance and exposes only referenced receipt descriptors', async () => {
    const s = await setup(true);
    for (let version = 3; version <= 103; version++) s.db.prepare("INSERT INTO settlement_history(event_id,version,total_cents,headcount,note,updated_at,actor_id,actor_name,kind,changed_fields) VALUES('past',?,100,1,'','stamp','alice','小青','detailed_edited','[]')").run(version);
    const first = (await s.get('/api/v2/activities/past/settlement/asset-versions')).json(); expect(first.versions).toHaveLength(50); expect(first.next_before).toBe(54); expect(first.versions[0].version).toBe(103);
    const second = (await s.get('/api/v2/activities/past/settlement/asset-versions?before=54')).json(); expect(second.versions).toHaveLength(50); expect(second.next_before).toBe(4);
    const third = (await s.get('/api/v2/activities/past/settlement/asset-versions?before=4')).json(); expect(third.versions.map((row: { version: number }) => row.version)).toEqual([3, 2, 1]); expect(third.next_before).toBeNull();
    const assets = (await s.get('/api/v2/activities/past/settlement/history/1/assets')).json(); expect(assets.receipts).toEqual([{ item_id: '1234567890abcdef', name: '店家單據', url: '/api/v2/activities/past/settlement/history/1/receipts/1234567890abcdef' }]);
    expect(JSON.stringify(assets)).not.toContain(imageDigest(testPNG())); expect((await s.get('/api/v2/activities/past/settlement/history/2/assets')).json()).toMatchObject({ codes: [], receipts: [], can_save: false });
  });
});
