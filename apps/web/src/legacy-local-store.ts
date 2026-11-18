import { describeLegacy,legacyRaw,legacyScope } from './legacy-local-record';
const name='qgroup-legacy-local-v1';
export type LegacySnapshot={id:string;scope:string;sourceKey:string;raw:string;source:unknown;savedAt:number};
export type LegacyMapping={id:string;scope:string;sourceId:string;targetKey:string;path:string;deviceEpoch:number;at:number;kind?:'request'};
export type LegacyInventory={epoch:number;disabled:boolean;rows:LegacySnapshot[];mappings:LegacyMapping[]};
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
  legacyScope(scope);return transaction(async tx=>({epoch:await request(tx.objectStore('state').get('epoch'))??0,disabled:!!await request(tx.objectStore('state').get('disabled')),rows:(await request(tx.objectStore('snapshots').getAll()) as LegacySnapshot[]).filter(row=>row.scope===scope),mappings:(await request(tx.objectStore('mappings').getAll()) as LegacyMapping[]).filter(row=>row.scope===scope)}));
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
    const store=tx.objectStore('snapshots');for(const row of rows)if(!await request(store.get(row.id)))store.put(row);
    return {epoch,disabled,rows:(await request(store.getAll()) as LegacySnapshot[]).filter(row=>row.scope===scope),mappings:(await request(tx.objectStore('mappings').getAll()) as LegacyMapping[]).filter(row=>row.scope===scope)};
  });
}
export async function checkLegacySnapshot(scope:string,epoch:number,row:LegacySnapshot){
  const current=await preserveLegacy(scope);
  if(current.disabled||current.epoch!==epoch||!current.rows.some(r=>r.id===row.id&&r.raw===row.raw))throw Error('原紀錄已清除，請重新讀取。');
  const latest=await originals(scope),matching=latest.find(source=>(source as {key:string}).key===row.sourceKey);
  if(matching&&legacyRaw(matching)!==row.raw)throw Error('舊分頁已更新原紀錄；新版保留兩份，請重新讀取後核對。');
  await transaction(async tx=>{const state=tx.objectStore('state'),currentEpoch=await request(state.get('epoch'))??0,disabled=await request(state.get('disabled')),saved=await request(tx.objectStore('snapshots').get(row.id)) as LegacySnapshot|undefined;if(disabled||currentEpoch!==epoch||saved?.scope!==scope||saved.raw!==row.raw)throw Error('原紀錄已清除，請重新讀取。');});
  return describeLegacy(row.source,scope);
}
export async function clearLegacyLocal(){
  // Fence archive and delayed imports first. A surviving obsolete page may never auto-import again.
  await transaction(async tx=>{const state=tx.objectStore('state'),epoch=await request(state.get('epoch'))??0;state.put(epoch+1,'epoch');state.put(true,'disabled');tx.objectStore('snapshots').clear();tx.objectStore('mappings').clear();});
  const db=await sourceDatabase();if(!db)return;
  try{await new Promise<void>((resolve,reject)=>{const tx=db.transaction('entries','readwrite',{durability:'strict'}),r=tx.objectStore('entries').openCursor();r.onsuccess=()=>{const cursor=r.result;if(!cursor)return;if(/^(draft|request):[a-f0-9]{64}:/.test(String(cursor.key)))cursor.delete();cursor.continue();};tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error??Error('舊本機紀錄清除失敗'));});}finally{db.close();}
}
/** Only a committed target may be mapped. Source snapshots remain available for inspection/export. */
export async function mapLegacySources(scope:string,epoch:number,rows:LegacySnapshot[],target:{sourceId:string;key:string;path:string;deviceEpoch:number;kind?:'request'}){
  legacyScope(scope);return transaction(async tx=>{
    const state=tx.objectStore('state');if(await request(state.get('disabled'))||(await request(state.get('epoch'))??0)!==epoch)throw Error('原紀錄已因登出清除，不能完成轉換。');
    const maps=tx.objectStore('mappings');
    for(const row of rows){const saved=await request(tx.objectStore('snapshots').get(row.id)) as LegacySnapshot|undefined;if(saved?.scope!==scope||saved.raw!==row.raw)throw Error('來源快照已改變，不能確認轉換。');const old=await request(maps.get(row.id)) as LegacyMapping|undefined;if(old&&(old.targetKey!==target.key||old.sourceId!==target.sourceId))throw Error('此原稿已有不同轉換目的，請先核對。');maps.put({id:row.id,scope,sourceId:target.sourceId,targetKey:target.key,path:target.path,deviceEpoch:target.deviceEpoch,at:Date.now(),...(target.kind?{kind:target.kind}:{})} satisfies LegacyMapping);}
  });
}
