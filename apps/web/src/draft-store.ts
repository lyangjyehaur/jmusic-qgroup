import { musicRoomDraftTarget,musicRoomLegacyKey,musicRoomLegacyMatches } from './music-room-record';
import { MusicRecoveryRecord } from './music-recovery-record';
import { musicShoutDraftTarget } from './music-shout-record';
import { MusicPinResultRequest } from '@qgroup/contracts';
import { activityAccessDraftRoute } from './activity-access-record';
import { botDeliveryDraftRoute } from './bot-delivery-record';
// Only reviewed form payloads and scoped operation routes belong in this database; never login credentials.
const databaseName = 'qgroup-reviewed-drafts-v1';
const stores = ['drafts', 'versions', 'epochs'] as const;
type Row = { key: string; scope: string; revision: number; raw: string | null; at: number };
export type DraftVersion = { id: string; key: string; scope: string; raw: string; at: number; reason: string };
export type DraftHandle = { key: string; scope: string; revision: number; deviceEpoch: number; musicEpoch: number; adminEpoch: number };
export class DraftConflict extends Error {}
export class DraftExpired extends Error {}
let opening: Promise<IDBDatabase> | undefined;
function database() {
  return opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    let blocked = false;
    request.onupgradeneeded = () => {
      request.result.createObjectStore('drafts', { keyPath: 'key' });
      request.result.createObjectStore('versions', { keyPath: 'id' }).createIndex('key', 'key');
      request.result.createObjectStore('epochs');
    };
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) { db.close(); return; }
      db.onversionchange = () => { db.close(); opening = undefined; };
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => { blocked = true; reject(Error('請關閉其他舊頁面後重試。')); };
  }).catch(error => { opening = undefined; throw error; });
}
function request<T>(operation: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error);
  });
}
async function transaction<T>(mode: IDBTransactionMode, work: (tx: IDBTransaction) => Promise<T>) {
  const db = await database(), tx = db.transaction([...stores], mode, { durability: mode === 'readwrite' ? 'strict' : 'default' });
  const completion = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error ?? Error('瀏覽器儲存失敗'));
  });
  try { const value = await work(tx); await completion; return value; }
  catch (error) { try { tx.abort(); } catch { /* Already completed/aborted. */ } await completion.catch(() => {}); throw error; }
}
const isMusic = (key: string) => key.startsWith('qgroup:rebuild:music:');
const isAdmin = (key: string) => key.startsWith('qgroup:rebuild:admin-');
const expiredError = (key:string) => isAdmin(key) ? new DraftExpired('此管理原稿已因登出或權限變更失效，請重新載入頁面。') : new DraftExpired('此原稿已因登出或資料刪除失效，請重新載入頁面。');
function validate(key: string, scope: string) {
  // Explicit allowlist: never import PIN, OAuth, device or privacy receipt secrets.
  const prefix = 'qgroup:rebuild:';
  // Scoped invitation links restore only their original form; authority remains server-checked.
  const route = /^qgroup:rebuild:activity-draft:(invitations|claims|delegation):v1:([^:]+):[^:]{1,80}:(.+)$/.exec(key);
  const routeModes = { invitations: /^(?:issue|accept:[A-Za-z0-9_-]{32})$/, claims: /^(?:manage|request:[A-Za-z0-9_-]{32})$/, delegation: /^(?:manage|accept:[A-Za-z0-9_-]{32})$/ };
  const scopedRoute = !!route && route[2] === scope && routeModes[route[1] as keyof typeof routeModes].test(route[3]!);
  if (!/^[a-f0-9]{64}$/.test(scope) || !(
    key.startsWith(prefix + 'music:entries:v1:' + scope + ':') ||
    key === prefix + 'payment-codes:v1:' + scope ||
    key === prefix + 'account-profile:v1:' + scope ||
    key === prefix + 'notifications-read:v1:' + scope ||
    !!botDeliveryDraftRoute(key, scope) ||
    !!activityAccessDraftRoute(key, scope) ||
    !!musicShoutDraftTarget(key, scope) ||
    !!musicRoomDraftTarget(key, scope) ||
    new RegExp('^qgroup:rebuild:admin-(?:bot|catalog|appearance|shouts):v1:' + scope + ':[a-f0-9]{64}$').test(key) ||
    new RegExp('^qgroup:rebuild:admin-(?:user|privacy|music|music-pin):v1:' + scope + ':[a-f0-9]{64}:[^:]{1,128}$').test(key) ||
    key === prefix + 'music:v1:' + scope ||
    key === prefix + 'music:claim:v1:' + scope ||
    new RegExp('^qgroup:rebuild:music:(?:fields|contact):v1:' + scope + ':[0-9]+:[^:]{1,80}$').test(key) ||
    key.startsWith(prefix + 'activity-draft:v1:' + scope + ':') ||
    scopedRoute ||
    ['poll-create', 'poll-vote', 'poll-manage', 'settlement', 'rooms', 'arrangements', 'finance', 'lifecycle', 'consent', 'attendance', 'registration'].some(kind =>
      key.startsWith(prefix + 'activity-draft:' + kind + ':v1:' + scope + ':'))
  )) throw Error('不支援的原稿範圍');
}
async function epochs(tx: IDBTransaction, scope: string) {
  const store = tx.objectStore('epochs');
  const [device, music, admin] = await Promise.all([request(store.get('device')), request(store.get('music:' + scope)), request(store.get('admin:' + scope))]);
  return { deviceEpoch: (device ?? 0) as number, musicEpoch: (music ?? 0) as number, adminEpoch: (admin ?? 0) as number };
}
/** Read-only fence for delayed results that must not survive local logout cleanup. */
export function deviceDraftEpoch() {
  return transaction('readonly', async tx => {
    const epoch:unknown=await request(tx.objectStore('epochs').get('device'))??0;
    if(typeof epoch!=='number'||!Number.isSafeInteger(epoch)||epoch<0)throw Error('無法核對本機原稿世代；請重新載入頁面。');
    return epoch;
  });
}
function validateRaw(key: string, raw: string) {
  // PIN commands and reasons never enter the durable store, including legacy import or archives.
  if(key.startsWith('qgroup:rebuild:music:claim:'))MusicRecoveryRecord.nullable().parse(JSON.parse(raw));
  if (key.startsWith('qgroup:rebuild:admin-music-pin:')) MusicPinResultRequest.nullable().parse(JSON.parse(raw));
}
function archive(tx: IDBTransaction, key: string, scope: string, raw: string, reason: string) {
  validateRaw(key, raw);
  tx.objectStore('versions').put({ id: crypto.randomUUID(), key, scope, raw, reason, at: Date.now() } satisfies DraftVersion);
}
export async function openDraft(key: string, scope: string) {
  validate(key, scope);
  // Retain the session source until the IDB transaction has committed.
  const legacyKey=musicRoomLegacyKey(key,scope)??key,sourceLegacy=sessionStorage.getItem(legacyKey),roomTarget=musicRoomDraftTarget(key,scope);
  const legacy=sourceLegacy!==null&&roomTarget&&!musicRoomLegacyMatches(sourceLegacy,roomTarget.eventId)?null:sourceLegacy;
  let importableLegacy=true;
  try { if(legacy!==null)validateRaw(key,legacy); } catch { importableLegacy=false; }
  const result = await transaction('readwrite', async tx => {
    const currentEpochs = await epochs(tx, scope), store = tx.objectStore('drafts');
    let row = await request(store.get(key)) as Row | undefined;
    if (row && row.scope !== scope) throw Error('原稿帳號不符');
    if (legacy !== null && importableLegacy && currentEpochs.deviceEpoch === 0 && (!isMusic(key) || currentEpochs.musicEpoch === 0) && (!isAdmin(key) || currentEpochs.adminEpoch === 0)) {
      if (!row) {
        row = { key, scope, revision: 1, raw: legacy, at: Date.now() };
        store.put(row);
      } else if (row.raw !== legacy) archive(tx, key, scope, legacy, '分頁原稿');
    }
    return { handle: { key, scope, revision: row?.revision ?? 0, ...currentEpochs }, raw: row?.raw ?? null };
  });
  if (legacy !== null && importableLegacy && sessionStorage.getItem(legacyKey) === legacy) sessionStorage.removeItem(legacyKey);
  return result;
}
/** A committed CAS failure preserves the competing payload; it never overwrites another tab. */
export async function saveDraft(handle: DraftHandle, raw: string, preserve = false) {
  validate(handle.key, handle.scope); validateRaw(handle.key, raw);
  const result = await transaction('readwrite', async tx => {
    const now = await epochs(tx, handle.scope);
    if (now.deviceEpoch !== handle.deviceEpoch || isMusic(handle.key) && now.musicEpoch !== handle.musicEpoch || isAdmin(handle.key) && now.adminEpoch !== handle.adminEpoch)
      return { expired: true } as const;
    const store = tx.objectStore('drafts'), row = await request(store.get(handle.key)) as Row | undefined;
    if (row && row.scope !== handle.scope) throw Error('原稿帳號不符');
    if (!preserve && row?.raw === raw) return { handle: { ...handle, revision: row.revision } };
    if ((row?.revision ?? 0) !== handle.revision) {
      archive(tx, handle.key, handle.scope, raw, '分頁衝突');
      return { conflict: true } as const;
    }
    if (preserve && row?.raw !== null && row) archive(tx, handle.key, handle.scope, row.raw, '替換前原稿');
    const next = { key: handle.key, scope: handle.scope, revision: handle.revision + 1, raw, at: Date.now() };
    store.put(next);
    return { handle: { ...handle, revision: next.revision } };
  });
  if ('expired' in result) throw expiredError(handle.key);
  if ('conflict' in result) throw new DraftConflict('其他分頁已更新原稿。這個分頁的內容已保全，請先讀取已保存版本。');
  return result.handle;
}
export function draftVersions(key: string, scope: string) {
  validate(key, scope);
  return transaction('readonly', async tx => (await request(tx.objectStore('versions').index('key').getAll(key)) as DraftVersion[])
    .filter(row => row.scope === scope).sort((a, b) => b.at - a.at));
}
export function listDurableDrafts(scope: string) {
  return transaction('readonly', async tx => (await request(tx.objectStore('drafts').getAll()) as Row[]).filter((row): row is Row & { raw: string } => row.scope === scope && row.raw !== null));
}
export function listDurableVersions(scope: string) {
  return transaction('readonly', async tx => (await request(tx.objectStore('versions').getAll()) as DraftVersion[]).filter(row => row.scope === scope));
}
/** Epoch increment and deletion share one transaction, fencing delayed writes from all tabs. */
export function clearDurableDrafts(scope?: string) {
  return transaction('readwrite', async tx => {
    const epochKey = scope ? 'music:' + scope : 'device', store = tx.objectStore('epochs');
    const epoch = (await request(store.get(epochKey)) ?? 0) as number;
    store.put(epoch + 1, epochKey);
    for (const name of ['drafts', 'versions'] as const) {
      const entries = tx.objectStore(name);
      if (!scope) { entries.clear(); continue; }
      for (const row of await request(entries.getAll()) as (Row & DraftVersion)[])
        if (row.scope === scope && isMusic(row.key)) entries.delete(name === 'drafts' ? row.key : row.id);
    }
  });
}

/** Only this account's management drafts expire; member drafts and other account scopes stay intact. */
export function clearDurableAdminDrafts(scope: string) {
  if (!/^[a-f0-9]{64}$/.test(scope)) return Promise.reject(Error('原稿帳號不符'));
  return transaction('readwrite', async tx => {
    const store=tx.objectStore('epochs'),epochKey='admin:'+scope;
    const epoch=(await request(store.get(epochKey))??0) as number;store.put(epoch+1,epochKey);
    for(const name of ['drafts','versions'] as const){
      const entries=tx.objectStore(name);
      for(const row of await request(entries.getAll()) as (Row & DraftVersion)[])
        if(row.scope===scope&&isAdmin(row.key))entries.delete(name==='drafts'?row.key:row.id);
    }
  });
}

/** Retire a resolved source and optionally seed its server-assigned target in the same commit. */
export async function retireDraft(handle: DraftHandle, sourceRaw: string, target?: {key: string; raw: string}) {
  validate(handle.key, handle.scope); validateRaw(handle.key, sourceRaw); if (target) { validate(target.key, handle.scope); validateRaw(target.key, target.raw); if(target.key===handle.key)throw Error('來源與目標原稿不能相同'); }
  const result = await transaction('readwrite', async tx => {
    const now = await epochs(tx, handle.scope);
    if (now.deviceEpoch !== handle.deviceEpoch || isMusic(handle.key) && now.musicEpoch !== handle.musicEpoch || isAdmin(handle.key) && now.adminEpoch !== handle.adminEpoch) return {expired:true} as const;
    const store = tx.objectStore('drafts'), row = await request(store.get(handle.key)) as Row | undefined;
    if (row?.scope !== handle.scope || row.revision !== handle.revision) {
      archive(tx, handle.key, handle.scope, sourceRaw, '完成操作時的分頁衝突'); return {conflict:true} as const;
    }
    if (target) {
      const prior = await request(store.get(target.key)) as Row | undefined;
      if (prior && prior.scope !== handle.scope) throw Error('原稿帳號不符');
      // A target may already contain edits made after an uncertain creation. Keep those edits.
      if (!prior || prior.raw === null) store.put({key:target.key,scope:handle.scope,revision:(prior?.revision??0)+1,raw:target.raw,at:Date.now()} satisfies Row);
    }
    const revision = handle.revision + 1;
    store.put({...row,revision,raw:null,at:Date.now()});
    return {handle:{...handle,revision}};
  });
  if ('expired' in result) throw expiredError(handle.key);
  if ('conflict' in result) throw new DraftConflict('其他分頁已更新原稿。這個分頁的內容已保全，請先讀取已保存版本。');
  return result.handle;
}
