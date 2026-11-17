import { deflateSync } from 'node:zlib';
import type { DB } from '@qgroup/database';
import { attachPaymentCodes } from '../src/payment-codes';
import { imageDigest, putPaymentImage } from '../src/payment-media';
// Synthetic PNG builder, independent of the production validator.
export function pngChunk(kind: string, payload: Buffer) {
  const data = Buffer.concat([Buffer.from(kind), payload]); let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; }
  const length = Buffer.alloc(4), sum = Buffer.alloc(4); length.writeUInt32BE(payload.length); sum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, data, sum]);
}
export function testPNG(rgb: number[] = [255, 255, 255], width = 1, height = 1) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(Buffer.from([0, ...rgb]))), pngChunk('IEND', Buffer.alloc(0))]);
}
/** Frozen examples only; never used by runtime startup. */
export function paymentFixture(db: DB) {
  const raw = testPNG(), stamp = '2026-11-17T08:00:00+00:00';
  db.transaction(() => {
    for (const id of ['past', 'invite']) {
      db.prepare("INSERT INTO settlement_history(event_id,version,total_cents,headcount,note,qr_image,updated_at,actor_id,actor_name,kind,changed_fields) VALUES(?,1,100,1,'',NULL,?,'alice','小青','detailed_published','[]')").run(id, stamp);
      db.prepare("INSERT INTO settlement_history(event_id,version,total_cents,headcount,note,qr_image,updated_at,actor_id,actor_name,kind,changed_fields) VALUES(?,2,200,1,'新版',NULL,?,'bob','小白','detailed_edited','[]')").run(id, stamp);
      for (const version of [1, 2]) db.prepare('INSERT INTO settlement_details VALUES(?,?,?)').run(id, version, JSON.stringify({ total_cents: version * 100, payers: [], people: [], items: [{ id: '1234567890abcdef', name: '店家單據', amount_cents: version * 100, breakdown: [] }] }));
      attachPaymentCodes(db, id, 1, [{ meta: { kind: 'wechat', name: '本版原碼', digest: imageDigest(raw) }, raw }], new Date(stamp));
      const digest = putPaymentImage(db, raw, new Date(stamp));
      db.prepare('INSERT INTO settlement_receipt_images VALUES(?,1,?,?)').run(id, '1234567890abcdef', digest);
    }
  }).immediate();
}
