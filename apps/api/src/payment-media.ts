import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DB } from '@qgroup/database';
import { DomainError } from '@qgroup/domain';
import { legacyStamp } from './activity-arrangements';

function fail(message: string, status = 400): never { throw new DomainError('PAYMENT_IMAGE', message, status); }
export const imageDigest = (raw: Buffer) => createHash('sha256').update(raw).digest('hex');
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes: Buffer) { let value = 0xffffffff; for (const byte of bytes) value = crcTable[(value ^ byte) & 255]! ^ (value >>> 8); return (value ^ 0xffffffff) >>> 0; }
/** Match the retained Python validator: bounded PNG, dimensions, chunks, CRCs and exact EOF. */
export function paymentImage(value: string): Buffer {
  if (value.length > 2800000) fail('圖片過大，請裁剪後重試');
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) fail('圖片格式不正確，請重新選擇');
  const raw = Buffer.from(value, 'base64');
  if (raw.length > 2 * 1024 * 1024 || !raw.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) fail('圖片格式不正確，請重新選擇');
  let offset = 8, chunks = 0, hasData = false, finished = false;
  while (offset < raw.length) {
    if (offset + 12 > raw.length) fail('圖片格式不正確，請重新選擇');
    const length = raw.readUInt32BE(offset), stop = offset + length + 12, kind = raw.toString('ascii', offset + 4, offset + 8);
    if (length > 2 * 1024 * 1024 || stop > raw.length || crc32(raw.subarray(offset + 4, offset + 8 + length)) !== raw.readUInt32BE(offset + 8 + length)) fail('圖片格式不正確，請重新選擇');
    if (!chunks) {
      if (kind !== 'IHDR' || length !== 13) fail('圖片格式不正確，請重新選擇');
      const width = raw.readUInt32BE(offset + 8), height = raw.readUInt32BE(offset + 12);
      if (width < 1 || width > 1600 || height < 1 || height > 1600) fail('圖片長寬須為 1–1600 像素');
    } else if (kind === 'IHDR') fail('圖片格式不正確，請重新選擇');
    hasData ||= kind === 'IDAT';
    if (kind === 'IEND') { if (length || stop !== raw.length) fail('圖片格式不正確，請重新選擇'); finished = true; }
    offset = stop; chunks++;
  }
  if (!finished || !hasData) fail('圖片格式不正確，請重新選擇');
  return raw;
}
function folder(db: DB) {
  if (!db.name || db.name === ':memory:') throw new Error('Image storage requires a file-backed database');
  return join(dirname(db.name), 'images');
}
function directory(path: string) { mkdirSync(path, { recursive: true, mode: 0o700 }); if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new Error('Refusing symbolic image directory'); }
function syncDirectory(path: string) { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function imagePath(db: DB, digest: string) { if (!/^[a-f0-9]{64}$/.test(digest)) fail('圖片引用不正確'); return join(folder(db), digest.slice(0, 2), digest + '.png'); }
/** Call while holding the SQLite immediate writer lock, also used by image pruning. */
export function putPaymentImage(db: DB, raw: Buffer, now: Date) {
  const digest = imageDigest(raw), target = imagePath(db, digest), root = folder(db);
  directory(root); directory(dirname(target));
  if (existsSync(target)) {
    if (!lstatSync(target).isFile() || lstatSync(target).isSymbolicLink() || !readFileSync(target).equals(raw)) throw new Error('Image storage integrity failure');
  } else {
    const temp = join(dirname(target), '.upload-' + randomBytes(16).toString('hex'));
    try {
      const fd = openSync(temp, 'wx', 0o600);
      try { writeFileSync(fd, raw); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, target); syncDirectory(dirname(target)); syncDirectory(root); syncDirectory(dirname(root));
    }
    finally { if (existsSync(temp)) unlinkSync(temp); }
  }
  db.prepare("INSERT OR IGNORE INTO image_assets VALUES(?,?,'image/png',?)").run(digest, raw.length, legacyStamp(now));
  return digest;
}
export function readPaymentImage(db: DB, digest: string): Buffer {
  if (!db.prepare('SELECT 1 FROM image_assets WHERE digest=?').get(digest)) fail('圖片不存在', 404);
  const target = imagePath(db, digest), root = folder(db);
  try {
    for (const path of [root, dirname(target), target]) if (lstatSync(path).isSymbolicLink()) throw new Error('Symbolic image path');
    const raw = readFileSync(target); if (imageDigest(raw) !== digest) throw new Error('Image digest mismatch'); return raw;
  } catch { return fail('圖片暫時無法讀取，請稍後重試', 503); }
}
export function settlementReceipt(db: DB, eventId: string, version: number, itemId: string): Buffer | null {
  const row = db.prepare('SELECT digest FROM settlement_receipt_images WHERE event_id=? AND version=? AND item_id=?').get(eventId, version, itemId) as { digest: string } | undefined;
  if (row) return readPaymentImage(db, row.digest);
  const old = db.prepare('SELECT image FROM settlement_receipts WHERE event_id=? AND version=? AND item_id=?').get(eventId, version, itemId) as { image: Buffer } | undefined;
  return old?.image ?? null;
}
