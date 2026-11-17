import { expect, type Page } from '@playwright/test';
export async function durableRows(page: Page, store: 'drafts' | 'versions' = 'drafts') {
  return page.evaluate(async name => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('qgroup-reviewed-drafts-v1', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
    try { return await new Promise<{key:string;raw:string;revision:number;id?:string;reason?:string}[]>((resolve, reject) => {
      const tx = db.transaction(name), r = tx.objectStore(name).getAll(); tx.oncomplete = () => resolve(r.result.filter(row => row.raw !== null)); tx.onabort = () => reject(tx.error);
    }); } finally { db.close(); }
  }, store);
}
export async function denyDraftWrites(page: Page, prefix: string) {
  await expect(page.getByText('正在保存本機原稿…', { exact: true })).toHaveCount(0);
  await page.evaluate(prefix => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, key) {
      const result = original.call(this, value, key);
      if (this.name === 'drafts' && String(value.key).includes(prefix)) {
        const tx = this.transaction;
        // A successful put request is NOT a durable commit.
        result.addEventListener('success', () => tx.abort());
      }
      return result;
    };
  }, prefix);
}
export async function damageDraft(page: Page, prefix: string, raw: string) {
  await expect(page.getByText('正在讀取本機原稿…', { exact: true })).toHaveCount(0);
  await page.evaluate(async ({prefix,raw}) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r=indexedDB.open('qgroup-reviewed-drafts-v1',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error); });
    try { await new Promise<void>((resolve,reject)=>{
      const tx=db.transaction('drafts','readwrite'),store=tx.objectStore('drafts'),r=store.getAll();
      r.onsuccess=()=>{const row=r.result.find(row=>row.raw!==null&&row.key.includes(prefix));if(!row){tx.abort();return;}store.put({...row,raw,revision:row.revision+1});};
      tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error??Error('draft missing'));
    }); } finally {db.close();}
  }, {prefix,raw});
}
