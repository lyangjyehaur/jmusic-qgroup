import { useEffect,useRef,useState } from 'react';
import { parseDeviceLink,type SavedDeviceLink } from './device-link-record';
import { checkDeviceLink,observeDeviceLinks,readDeviceLink,saveDeviceLink,type DeviceLinkHandle } from './device-link-store';
export function useDeviceLink(slot:string){
  const active=useRef(false),handle=useRef<DeviceLinkHandle|null>(null),busyRef=useRef(false),generation=useRef(0);
  const [value,setValue]=useState<SavedDeviceLink|null>(null),[ready,setReady]=useState(false),[error,setError]=useState(''),[damaged,setDamaged]=useState(false),[busy,setBusy]=useState(false),[expired,setExpired]=useState(false);
  async function refresh(){
    const run=++generation.current;
    try{const next=await readDeviceLink(slot);if(!active.current||run!==generation.current)return;handle.current=next;try{setValue(next.raw?parseDeviceLink(next.raw):null);setDamaged(false);setError('');}catch{setValue(null);setDamaged(true);setError('本機裝置連結無法辨識，請明確清除後重新開啟連結。');}}
    catch{if(active.current&&run===generation.current)setError('無法讀取本機裝置連結，請檢查儲存設定後重新讀取。');}
    finally{if(active.current&&run===generation.current)setReady(true);}
  }
  useEffect(()=>{active.current=true;void refresh();const stop=observeDeviceLinks(()=>{if(!busyRef.current)void refresh();});return()=>{active.current=false;generation.current++;stop();};},[slot]);
  useEffect(()=>{
    if(!value)return;const remaining=value.expiresAt-Date.now();if(remaining<=0){setExpired(true);void refresh();return;}
    const timer=setTimeout(()=>{setExpired(true);void refresh();},remaining);return()=>clearTimeout(timer);
  },[value]);
  function begin(){if(busyRef.current||!ready||!handle.current||error||damaged)return false;generation.current++;busyRef.current=true;setBusy(true);return true;}
  function end(){busyRef.current=false;if(active.current)setBusy(false);}
  async function save(next:SavedDeviceLink|null){generation.current++;if(!handle.current)throw Error('尚未讀取裝置連結');handle.current=await saveDeviceLink(handle.current,next);if(active.current){setValue(next);setError('');setDamaged(false);setExpired(false);}}
  async function check(){if(!handle.current)throw Error('尚未讀取裝置連結');await checkDeviceLink(handle.current);}
  return{value,ready,error,damaged,busy,active,begin,end,save,check,refresh,expired};
}
