import { describeLegacy,legacyRaw,legacyScope } from './legacy-local-record';
import { decodeLegacyDraft } from './legacy-local-import';
const name='qgroup-legacy-local-v1';
const draftPrefix=(scope:string)=>'draft:'+scope+':';
const discardedDraftsKey=(scope:string)=>'discarded-drafts:'+scope;
const draftCleanupKey=(scope:string)=>'draft-cleanup-pending:'+scope;
export const isLegacyDraftSnapshot=(row:LegacySnapshot,scope:string)=>row.scope===scope&&row.sourceKey.startsWith(draftPrefix(scope));
export type LegacySnapshot={id:string;scope:string;sourceKey:string;raw:string;source:unknown;savedAt:number;importedEpoch?:number};
export type LegacyMapping={id:string;scope:string;sourceId:string;targetKey:string;path:string;deviceEpoch:number;at:number;kind?:'request'|'request-existing'};
export type LegacyInventory={epoch:number;disabled:boolean;rows:LegacySnapshot[];mappings:LegacyMapping[];draftCleanupPending?:boolean};
function request<T>(r:IDBRequest<T>){return new Promise<T>((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
async function database(){return new Promise<IDBDatabase>((resolve,reject)=>{
  let blocked=false;const r=indexedDB.open(name,2);r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains('snapshots'))r.result.createObjectStore('snapshots',{keyPath:'id'});if(!r.result.objectStoreNames.contains('state'))r.result.createObjectStore('state');if(!r.result.objectStoreNames.contains('mappings'))r.result.createObjectStore('mappings',{keyPath:'id'});};
  r.onsuccess=()=>{if(blocked){r.result.close();return;}r.result.onversionchange=()=>r.result.close();resolve(r.result);};r.onerror=()=>reject(r.error);r.onblocked=()=>{blocked=true;reject(Error('請關閉舊分頁後重新讀取本機紀錄。'));};
});}
async function transaction<T>(work:(tx:IDBTransaction)=>Promise<T>){
  const db=await database(),tx=db.transaction(['snapshots','state','mappings'],'readwrite',{durability:'strict'}),completed=new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error??Error('無法保全舊紀錄'));});
  try{const result=await work(tx);await completed;return result;}catch(error){try{tx.abort();}catch{/* Already ended. */}await completed.catch(()=>{});throw error;}finally{db.close();}
}
/** Opening an absent source aborts creation; existing source schema/version is never changed. */
async function sourceDatabase(){return new Promise<IDBDatabase|null>((resolve,reject)=>{
  let absent=false,blocked=false;const r=indexedDB.open('kanban-local-v1');
  r.onupgradeneeded=()=>{absent=true;r.transaction!.abort();};
  r.onerror=()=>absent?resolve(null):reject(r.error);
  r.onblocked=()=>{blocked=true;reject(Error('舊儲存被其他分頁占用，請關閉後重試。'));};
  r.onsuccess=()=>{const db=r.result;db.onversionchange=()=>db.close();if(blocked){db.close();return;}if(db.version!==1||!db.objectStoreNames.contains('entries')||db.transaction('entries').objectStore('entries').keyPath!=='key'){db.close();reject(Error('舊儲存版本無法辨識；原資料保留，請先停止轉換。'));return;}resolve(db);};
});}
async function originals(scope:string){
  const db=await sourceDatabase();if(!db)return [];
  try{return await new Promise<unknown[]>((resolve,reject)=>{
    const tx=db.transaction('entries'),store=tx.objectStore('entries'),rows:unknown[]=[];
    for(const prefix of ['draft:'+scope+':','request:'+scope+':']){const r=store.getAll(IDBKeyRange.bound(prefix,prefix+'\uffff'));r.onsuccess=()=>rows.push(...r.result);}
    tx.oncomplete=()=>resolve(rows);tx.onabort=()=>reject(tx.error??Error('無法讀取舊紀錄'));
  });}finally{db.close();}
}
export async function legacyInventory(scope:string):Promise<LegacyInventory>{
  legacyScope(scope);return transaction(async tx=>({epoch:await request(tx.objectStore('state').get('epoch'))??0,disabled:!!await request(tx.objectStore('state').get('disabled')),draftCleanupPending:!!await request(tx.objectStore('state').get(draftCleanupKey(scope))),rows:(await request(tx.objectStore('snapshots').getAll()) as LegacySnapshot[]).filter(row=>row.scope===scope),mappings:(await request(tx.objectStore('mappings').getAll()) as LegacyMapping[]).filter(row=>row.scope===scope)}));
}
export async function preserveLegacy(scope:string):Promise<LegacyInventory>{
  legacyScope(scope);const before=await legacyInventory(scope);if(before.disabled)return before;
  const values=await originals(scope),rows=await Promise.all(values.map(async source=>{
    const raw=legacyRaw(source),digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw)),id=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
    const sourceKey=(source as {key:string}).key;
    return {id,scope,sourceKey,raw,source:structuredClone(source),savedAt:Date.now()} satisfies LegacySnapshot;
  }));
  return transaction(async tx=>{
    const epoch=await request(tx.objectStore('state').get('epoch'))??0,disabled=!!await request(tx.objectStore('state').get('disabled'));
    if(disabled||epoch!==before.epoch)throw Error('本機紀錄已因登出清除，不能從舊分頁寫回。');
    const discardedDrafts=!!await request(tx.objectStore('state').get(discardedDraftsKey(scope)));
    const store=tx.objectStore('snapshots');for(const row of rows)if(!(discardedDrafts&&isLegacyDraftSnapshot(row,scope))&&!await request(store.get(row.id)))store.put(row);
    return {epoch,disabled,draftCleanupPending:!!await request(tx.objectStore('state').get(draftCleanupKey(scope))),rows:(await request(store.getAll()) as LegacySnapshot[]).filter(row=>row.scope===scope),mappings:(await request(tx.objectStore('mappings').getAll()) as LegacyMapping[]).filter(row=>row.scope===scope)};
  });
}
export async function checkLegacySnapshot(scope:string,epoch:number,row:LegacySnapshot){
  const current=await preserveLegacy(scope);
  if(current.epoch!==epoch||!current.rows.some(r=>r.id===row.id&&r.raw===row.raw&&(!current.disabled||r.importedEpoch===epoch)))throw Error('原紀錄已清除，請重新讀取。');
  const latest=await originals(scope),matching=latest.find(source=>(source as {key:string}).key===row.sourceKey);
  if(matching&&legacyRaw(matching)!==row.raw)throw Error('舊分頁已更新原紀錄；新版保留兩份，請重新讀取後核對。');
  await transaction(async tx=>{const state=tx.objectStore('state'),currentEpoch=await request(state.get('epoch'))??0,disabled=await request(state.get('disabled')),saved=await request(tx.objectStore('snapshots').get(row.id)) as LegacySnapshot|undefined;if(currentEpoch!==epoch||saved?.scope!==scope||saved.raw!==row.raw||disabled&&saved.importedEpoch!==epoch)throw Error('原紀錄已清除，請重新讀取。');});
  return describeLegacy(row.source,scope);
}
/** Explicitly chosen drafts may be restored after logout. The automatic source
 * import fence stays set, and no destination draft or mapping is restored. */
export async function importLegacyDraft(scope:string,epoch:number,raw:string,validate:()=>Promise<void>,active:()=>boolean){
  const source=decodeLegacyDraft(raw,scope),digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw)),id=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
  await validate();
  return transaction(async tx=>{
    const state=tx.objectStore('state');if(!active()||(await request(state.get('epoch'))??0)!==epoch)throw Error('帳號、頁面或本機紀錄已變更，請重新選擇保全檔。');
    const store=tx.objectStore('snapshots'),old=await request(store.get(id)) as LegacySnapshot|undefined;
    if(!active())throw Error('匯入頁面已關閉，原檔保留。');
    if(old){if(old.scope!==scope||old.raw!==raw)throw Error('保全檔與現有紀錄不符，請保留原檔。');return {id,added:false};}
    store.put({id,scope,sourceKey:source.key,raw,source,savedAt:Date.now(),importedEpoch:epoch} satisfies LegacySnapshot);
    return {id,added:true};
  });
}
export function legacyInventoryUsable(inventory:LegacyInventory,epoch:number){
  return inventory.epoch===epoch&&(!inventory.disabled||inventory.rows.length>0&&inventory.rows.every(row=>row.importedEpoch===epoch));
}
/** Explicitly discard this account's obsolete BoardStore drafts. New unified drafts
 * live in another database. Original requests remain available, even when done.
 * Fence automatic re-import before deleting sources so late old tabs stay retired. */
export async function discardLegacyDrafts(scope:string,active:()=>boolean=()=>true){
  legacyScope(scope);
  await transaction(async tx=>{
    if(!active())throw Error('帳號或頁面已變更，尚未清除舊版草稿。');
    const state=tx.objectStore('state'),epoch=await request(state.get('epoch'))??0;
    if(!active())throw Error('帳號或頁面已變更，尚未清除舊版草稿。');
    state.put(epoch+1,'epoch');state.put(true,discardedDraftsKey(scope));state.put(true,draftCleanupKey(scope));
    const snapshots=tx.objectStore('snapshots'),mappings=tx.objectStore('mappings');
    for(const row of await request(snapshots.getAll()) as LegacySnapshot[]){
      if(isLegacyDraftSnapshot(row,scope)){snapshots.delete(row.id);mappings.delete(row.id);}
    }
  });
  const db=await sourceDatabase();
  if(db)try{await new Promise<void>((resolve,reject)=>{
    const tx=db.transaction('entries','readwrite',{durability:'strict'}),prefix=draftPrefix(scope);
    const r=tx.objectStore('entries').openCursor(IDBKeyRange.bound(prefix,prefix+'\uffff'));
    r.onsuccess=()=>{const cursor=r.result;if(cursor){cursor.delete();cursor.continue();}};
    tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error??Error('舊版草稿清除未完成，請重試。'));
  });}finally{db.close();}
  await transaction(async tx=>{tx.objectStore('state').delete(draftCleanupKey(scope));});
}
export async function clearLegacyLocal(){
  // Fence archive and delayed imports first. A surviving obsolete page may never auto-import again.
  await transaction(async tx=>{const state=tx.objectStore('state'),epoch=await request(state.get('epoch'))??0;state.put(epoch+1,'epoch');state.put(true,'disabled');tx.objectStore('snapshots').clear();tx.objectStore('mappings').clear();});
  const db=await sourceDatabase();if(!db)return;
  try{await new Promise<void>((resolve,reject)=>{const tx=db.transaction('entries','readwrite',{durability:'strict'}),r=tx.objectStore('entries').openCursor();r.onsuccess=()=>{const cursor=r.result;if(!cursor)return;if(/^(draft|request):[a-f0-9]{64}:/.test(String(cursor.key)))cursor.delete();cursor.continue();};tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error??Error('舊本機紀錄清除失敗'));});}finally{db.close();}
}
/** Only a committed target may be mapped. Source snapshots remain available for inspection/export. */
export async function mapLegacySources(scope:string,epoch:number,rows:LegacySnapshot[],target:{sourceId:string;key:string;path:string;deviceEpoch:number;kind?:'request'|'request-existing'}){
  legacyScope(scope);return transaction(async tx=>{
    const state=tx.objectStore('state'),disabled=await request(state.get('disabled'));if((await request(state.get('epoch'))??0)!==epoch)throw Error('原紀錄已因登出清除，不能完成轉換。');
    const maps=tx.objectStore('mappings');
    for(const row of rows){const saved=await request(tx.objectStore('snapshots').get(row.id)) as LegacySnapshot|undefined;if(saved?.scope!==scope||saved.raw!==row.raw||disabled&&saved.importedEpoch!==epoch)throw Error('來源快照已改變，不能確認轉換。');const old=await request(maps.get(row.id)) as LegacyMapping|undefined;if(old&&(old.targetKey!==target.key||old.sourceId!==target.sourceId))throw Error('此原稿已有不同轉換目的，請先核對。');maps.put({id:row.id,scope,sourceId:target.sourceId,targetKey:target.key,path:target.path,deviceEpoch:target.deviceEpoch,at:Date.now(),...(target.kind?{kind:target.kind}:{})} satisfies LegacyMapping);}
  });
}
