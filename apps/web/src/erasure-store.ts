import { uiText } from './language';
import { parseErasure, erasureKey, type ErasureValue } from './erasure-record';
// Receipt capabilities live here only: never in generic drafts, versions or exports.
const database = 'qgroup-erasure-receipts-v1', channelName = 'qgroup:erasure-receipts';
export class ErasureConflict extends Error { constructor() { super('其他分頁已更新刪除紀錄，請重新讀取原操作。'); } }
async function open() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(database, 1); let blocked = false;
    request.onupgradeneeded = () => request.result.createObjectStore('operations');
    request.onsuccess = () => { if (blocked) { request.result.close(); return; } request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    request.onerror = () => reject(request.error);
    request.onblocked = () => { blocked = true; reject(Error('請關閉舊分頁後重試')); };
  });
}
function signal() {
  window.dispatchEvent(new Event(channelName));
  try { const channel = new BroadcastChannel(channelName); channel.postMessage('changed'); channel.close(); } catch { /* Focus and pre-request CAS still refresh. */ }
}
export function observeErasures(refresh: () => void) {
  window.addEventListener(channelName, refresh); window.addEventListener('focus', refresh);
  let channel: BroadcastChannel | undefined;
  try { channel = new BroadcastChannel(channelName); channel.onmessage = refresh; } catch { /* Optional. */ }
  return () => { window.removeEventListener(channelName, refresh); window.removeEventListener('focus', refresh); channel?.close(); };
}
export async function readErasure(key: string): Promise<string | null> {
  const db = await open();
  try { return await new Promise((resolve, reject) => {
    const tx = db.transaction('operations', 'readonly'), request = tx.objectStore('operations').get(key);
    tx.oncomplete = () => resolve(request.result ?? null); tx.onabort = () => reject(tx.error ?? Error('讀取刪除紀錄失敗'));
  }); } finally { db.close(); }
}
/** Compare the complete original bytes in one transaction; aborted writes never authorize HTTP. */
export async function writeErasure(key: string, expected: string | null, value: ErasureValue | null) {
  if (value && erasureKey(value) !== key) throw Error('刪除來源不符');
  const next = value === null ? null : JSON.stringify(parseErasure(key, JSON.stringify(value)));
  await replaceRaw(key, expected, next);
  return next;
}
export async function replaceRaw(key: string, expected: string | null, next: string | null) {
  const db = await open();
  try { await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('operations', 'readwrite', { durability: 'strict' }), store = tx.objectStore('operations'), request = store.get(key);
    let conflict = false;
    request.onsuccess = () => {
      if ((request.result ?? null) !== expected) { conflict = true; tx.abort(); return; }
      if (next === null) store.delete(key); else store.put(next, key);
    };
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(conflict ? new ErasureConflict() : tx.error ?? Error('無法保存刪除紀錄'));
  }); } finally { db.close(); }
  signal();
}
export async function migrateErasure(key: string, legacyKey: string, convert: (raw: string) => ErasureValue) {
  const source = sessionStorage.getItem(legacyKey);
  let raw = await readErasure(key);
  if (source === null) return raw;
  const value = convert(source), imported = JSON.stringify(value);
  if (raw === null) { await writeErasure(key, null, value); raw = imported; }
  else {
    const existing = parseErasure(key, raw);
    if (existing.kind !== value.kind || existing.scope !== value.scope || JSON.stringify(existing.input) !== JSON.stringify(value.input) || existing.kind === 'admin' && value.kind === 'admin' && existing.authority !== value.authority) throw new ErasureConflict();
  }
  // Removing the old source is strictly after the destination transaction commits.
  if (sessionStorage.getItem(legacyKey) === source) sessionStorage.removeItem(legacyKey);
  return raw;
}
export async function erasureInventory(scope: string) {
  const db = await open();
  try { return await new Promise<{ id: string; label: string; to: string; damaged: boolean }[]>((resolve, reject) => {
    const tx = db.transaction('operations', 'readonly'), rows: { id: string; label: string; to: string; damaged: boolean }[] = [];
    const request = tx.objectStore('operations').openCursor();
    request.onsuccess = () => { const cursor = request.result; if (!cursor) return;
      try { const value = parseErasure(String(cursor.key), cursor.value); if (value.scope === scope) rows.push({ id: 'erasure:' + cursor.key, label: uiText('資料刪除'), to: value.kind === 'member' ? '/me/privacy' : value.path, damaged: false }); } catch { /* No raw payload or secret enters inventory. */ }
      cursor.continue();
    };
    tx.oncomplete = () => resolve(rows); tx.onabort = () => reject(tx.error);
  }); } finally { db.close(); }
}
