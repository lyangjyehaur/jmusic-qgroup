import { parseDeviceLink,type SavedDeviceLink } from './device-link-record';
const name='qgroup-device-links-v1',channelName='qgroup:device-links';
export type DeviceLinkHandle={slot:string;epoch:number;raw:string|null};
export class DeviceLinkExpired extends Error{constructor(){super('此裝置連結已過期、清除或由其他分頁更新，請重新讀取。');}}
async function database(){return new Promise<IDBDatabase>((resolve,reject)=>{
  let blocked=false;const r=indexedDB.open(name,1);r.onupgradeneeded=()=>{r.result.createObjectStore('links');r.result.createObjectStore('state');};
  r.onsuccess=()=>{if(blocked){r.result.close();return;}r.result.onversionchange=()=>r.result.close();resolve(r.result);};r.onerror=()=>reject(r.error);r.onblocked=()=>{blocked=true;reject(Error('請關閉舊分頁後重新讀取裝置連結'));};
});}
function request<T>(r:IDBRequest<T>){return new Promise<T>((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
async function transaction<T>(work:(tx:IDBTransaction)=>Promise<T>){
  const db=await database(),tx=db.transaction(['links','state'],'readwrite',{durability:'strict'});
  const completed=new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error??Error('無法保存裝置連結'));});
  try{const result=await work(tx);await completed;return result;}catch(error){try{tx.abort();}catch{/* Completed. */}await completed.catch(()=>{});throw error;}finally{db.close();}
}
function validateSlot(slot:string){if(slot!=='received'&&!/^issued:[a-f0-9]{64}$/.test(slot))throw Error('裝置連結來源不符');}
function signal(){window.dispatchEvent(new Event(channelName));try{const channel=new BroadcastChannel(channelName);channel.postMessage('changed');channel.close();}catch{/* Pre-command checks remain authoritative. */}}
export function observeDeviceLinks(refresh:()=>void){window.addEventListener(channelName,refresh);window.addEventListener('focus',refresh);let channel:BroadcastChannel|undefined;try{channel=new BroadcastChannel(channelName);channel.onmessage=refresh;}catch{/* Optional. */}return()=>{window.removeEventListener(channelName,refresh);window.removeEventListener('focus',refresh);channel?.close();};}
export async function readDeviceLink(slot:string):Promise<DeviceLinkHandle>{
  validateSlot(slot);
  return transaction(async tx=>{
    const store=tx.objectStore('links'),epoch=await request(tx.objectStore('state').get('epoch'))??0;
    // Purge known expired credentials; damaged originals stay in their own slot for explicit clearing.
    const rows=await request(store.getAllKeys());
    for(const key of rows){const raw=await request(store.get(key));try{if(parseDeviceLink(raw).expiresAt<=Date.now())store.delete(key);}catch{/* Never archive or silently consume damaged proofs. */}}
    const raw=await request(store.get(slot))??null;return{slot,epoch,raw};
  });
}
export async function saveDeviceLink(handle:DeviceLinkHandle,value:SavedDeviceLink|null){
  validateSlot(handle.slot);const raw=value?JSON.stringify(parseDeviceLink(JSON.stringify(value))):null;
  if(value&&value.expiresAt<=Date.now())throw new DeviceLinkExpired();
  const result=await transaction(async tx=>{
    const epoch=await request(tx.objectStore('state').get('epoch'))??0,store=tx.objectStore('links'),current=await request(store.get(handle.slot))??null;
    if(epoch!==handle.epoch||current!==handle.raw)throw new DeviceLinkExpired();
    if(raw===null)store.delete(handle.slot);else store.put(raw,handle.slot);
    return{...handle,raw};
  });signal();return result;
}
export async function checkDeviceLink(handle:DeviceLinkHandle){
  await transaction(async tx=>{
    const epoch=await request(tx.objectStore('state').get('epoch'))??0,raw=await request(tx.objectStore('links').get(handle.slot))??null;
    if(epoch!==handle.epoch||raw!==handle.raw||raw&&parseDeviceLink(raw).expiresAt<=Date.now())throw new DeviceLinkExpired();
  });
}
export async function clearDeviceLinks(){
  await transaction(async tx=>{const state=tx.objectStore('state'),epoch=await request(state.get('epoch'))??0;state.put(epoch+1,'epoch');tx.objectStore('links').clear();});signal();
}
