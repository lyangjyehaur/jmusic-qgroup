import { useEffect,useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery,useQueryClient } from '@tanstack/react-query';
import { Button,Surface,Text } from 'yahha-ui';

import { createWebHttpClient } from './http';
import { Failure,Notice,PageIntro } from './shared';
import { Field } from './settlement-controls';
import { useAppearance } from './appearance-preferences';
export const appearanceQuery={queryKey:['appearance'],queryFn:({signal}:{signal:AbortSignal})=>createWebHttpClient().requestContract('GET /api/v2/appearance',{signal}),refetchOnWindowFocus:'always' as const};
export function AppearancePage(){
  const prefs=useAppearance(),walls=useQuery(appearanceQuery);
  return <><PageIntro title="外觀"/><Link className="back" to="/me">我的</Link><Surface className="detail auth-panel">
    <Field label="主題"><select value={prefs.value.theme} onChange={event=>prefs.change({theme:event.target.value as 'system'|'light'|'dark'})}><option value="system">跟隨系統</option><option value="light">淺色</option><option value="dark">深色</option></select></Field>
    <label className="consent"><input type="checkbox" checked={prefs.value.wallpapers} onChange={event=>prefs.change({wallpapers:event.target.checked})}/><span>顯示壁紙</span></label><Text>偏好只保存在這個瀏覽器，套用至所有頁面。</Text>
    {prefs.error&&<div role="alert"><Text>{prefs.error}</Text><Button onClick={prefs.retry}>重試保存偏好</Button><Button variant="secondary" onClick={prefs.repair}>保全原偏好後保存</Button></div>}
    {walls.isPending?<Notice>正在讀取壁紙設定…</Notice>:walls.error?<Failure error={walls.error} retry={()=>void walls.refetch()}/>:<Text>{walls.data.items.length?'可用壁紙 '+walls.data.items.length+' 張 · 輪播間隔 '+walls.data.rotateSeconds+' 秒。':'目前沒有啟用的壁紙。'}系統要求減少動態效果時只顯示單張。</Text>}
  </Surface></>;
}
type Frame={id:string;objectURL:string;portrait:boolean};
export function WallpaperLayer(){
  const client=useQueryClient();
  useEffect(()=>{let channel:BroadcastChannel;try{channel=new BroadcastChannel('qgroup:appearance');channel.onmessage=()=>void client.invalidateQueries({queryKey:['appearance']});}catch{return;}return()=>channel.close();},[client]);
  const {value}=useAppearance(),manifest=useQuery({...appearanceQuery,enabled:value.wallpapers}),[frames,setFrames]=useState<Frame[]>([]),[portrait,setPortrait]=useState(()=>innerHeight>=innerWidth);
  useEffect(()=>{const resize=()=>setPortrait(innerHeight>=innerWidth);window.addEventListener('resize',resize);return()=>window.removeEventListener('resize',resize);},[]);
  useEffect(()=>{
    setFrames([]);if(!value.wallpapers||!manifest.data?.items.length)return;
    const items=manifest.data.items,seconds=manifest.data.rotateSeconds,reduce=matchMedia('(prefers-reduced-motion: reduce)'),controller=new AbortController(),urls=new Set<string>();
    let timer:ReturnType<typeof setTimeout>|undefined,index=Math.floor(Math.random()*items.length),busy=false,failed=new Set<number>();
    async function show(next:number){
      if(busy||controller.signal.aborted)return;busy=true;let objectURL='';
      try{
        const response=await createWebHttpClient().requestRaw('GET /api/v2/appearance/walls/:id/image',{params:{id:items[next]!.id},signal:controller.signal,cache:'no-store'});
        const blob=await response.blob();if(controller.signal.aborted)return;
        objectURL=URL.createObjectURL(blob);urls.add(objectURL);
        const image=new Image();image.src=objectURL;
        let decodeTimer:ReturnType<typeof setTimeout>|undefined;
        let abort:()=>void=()=>{};
        try{await Promise.race([image.decode(),new Promise<never>((_,reject)=>{
          decodeTimer=setTimeout(()=>reject(Error('Image decode timeout')),6000);
          abort=()=>reject(Error('Image decode aborted'));controller.signal.addEventListener('abort',abort,{once:true});
        })]);}finally{clearTimeout(decodeTimer);controller.signal.removeEventListener('abort',abort);}
        if(controller.signal.aborted)return;
        setFrames(previous=>{const keep=previous.slice(-1);for(const frame of previous.slice(0,-1)){URL.revokeObjectURL(frame.objectURL);urls.delete(frame.objectURL);}return[...keep,{id:items[next]!.id,objectURL,portrait:image.naturalHeight>image.naturalWidth}];});index=next;failed.clear();
      }catch{failed.add(next);if(objectURL){URL.revokeObjectURL(objectURL);urls.delete(objectURL);}}
      finally{busy=false;const fallback=items.findIndex((_,i)=>!failed.has(i));if(failed.size&&fallback>=0&&!controller.signal.aborted)void show(fallback);else schedule();}
    }
    function schedule(){if(timer)clearTimeout(timer);if(!controller.signal.aborted&&!reduce.matches&&!document.hidden&&items.length>1)timer=setTimeout(()=>{const next=(index+1+Math.floor(Math.random()*(items.length-1)))%items.length;void show(next);},seconds*1000);}
    const changed=()=>{if(timer)clearTimeout(timer);if(!document.hidden&&!reduce.matches)schedule();};document.addEventListener('visibilitychange',changed);reduce.addEventListener('change',changed);void show(index);
    return()=>{controller.abort();if(timer)clearTimeout(timer);document.removeEventListener('visibilitychange',changed);reduce.removeEventListener('change',changed);for(const url of urls)URL.revokeObjectURL(url);};
  },[value.wallpapers,manifest.data?.revision,manifest.data?.rotateSeconds]);
  if(!value.wallpapers||!frames.length)return null;
  return <div className="wallpaper-layer" aria-hidden="true">{frames.map((frame,index)=><div key={frame.objectURL} data-wallpaper-id={frame.id} className={'wallpaper-frame'+(index===frames.length-1?' current':'')+(frame.portrait!==portrait?' fit':'')} style={{backgroundImage:'url("'+frame.objectURL+'")'}}/>)}</div>;
}
