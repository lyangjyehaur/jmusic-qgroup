import type { Page } from '@playwright/test';
export async function rows(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('qgroup-erasure-receipts-v1', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    try { return await new Promise<{ key: string; raw: string }[]>((resolve, reject) => {
      const tx = db.transaction('operations', 'readonly'), r = tx.objectStore('operations').openCursor(), values: { key: string; raw: string }[] = [];
      r.onsuccess = () => { if (r.result) { values.push({ key: String(r.result.key), raw: r.result.value }); r.result.continue(); } }; tx.oncomplete = () => resolve(values); tx.onabort = () => reject(tx.error);
    }); } finally { db.close(); }
  });
}
export async function denyWrite(page: Page, mode: 'intent' | 'result' | 'cleaned' | 'delete' = 'intent', once = true) {
  await page.evaluate(({ mode, once }) => {
    const put = IDBObjectStore.prototype.put, remove = IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.put = function (value, key) {
      const r = put.call(this, value, key);
      if (this.name === 'operations') {
        const data = typeof value === 'string' ? JSON.parse(value) : null;
        const hit = mode === 'intent' || mode === 'result' && data?.result && !data.cleaned || mode === 'cleaned' && data?.cleaned;
        if (hit) { const tx = this.transaction; r.addEventListener('success', () => { if (once) IDBObjectStore.prototype.put = put; tx.abort(); }); }
      }
      return r;
    };
    IDBObjectStore.prototype.delete = function (key) {
      const r = remove.call(this, key);
      if (this.name === 'operations' && mode === 'delete') { const tx = this.transaction; r.addEventListener('success', () => { if (once) IDBObjectStore.prototype.delete = remove; tx.abort(); }); }
      return r;
    };
  }, { mode, once });
}
