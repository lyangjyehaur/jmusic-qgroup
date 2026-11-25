import { useEffect,useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery,useQueryClient } from '@tanstack/react-query';

import { createWebHttpClient } from './http';
import { Failure,Notice } from './shared';
import { useAppearance } from './appearance-preferences';
import { AppearanceControls } from './appearance-controls';
export const appearanceQuery={queryKey:['appearance'],queryFn:({signal}:{signal:AbortSignal})=>createWebHttpClient().requestContract('GET /api/v2/appearance',{signal}),refetchOnWindowFocus:'always' as const};
export function AppearancePage(){
  const walls=useQuery(appearanceQuery);
  return <><div className="settings-grid appearance-settings"><section className="form-section"><div className="section-heading"><span>外觀</span><div><h2>外觀設定</h2></div></div>
    <AppearanceControls/><p className="settings-help">偏好只保存在這個瀏覽器，套用至所有頁面。</p>
    {walls.isPending?<Notice>正在讀取壁紙設定…</Notice>:walls.error?<Failure error={walls.error} retry={()=>void walls.refetch()}/>:<p className="settings-help">{walls.data.items.length?'可用壁紙 '+walls.data.items.length+' 張 · 輪播間隔 '+walls.data.rotateSeconds+' 秒。':'目前沒有啟用的壁紙。'}系統要求減少動態效果時只顯示單張。</p>}
    </section><section className="form-section"><div className="section-heading"><span>隱私</span><div><h2>資料可見與同意</h2></div></div><div className="settings-navigation"><Link to="/me/music/details">成分資料與公開性別</Link><Link to="/me/music/contact">公開聯絡 QQ</Link><Link to="/me/privacy/consent">政策同意紀錄</Link><Link to="/me/privacy">隱私與資料刪除</Link></div></section></div><Link className="back" to="/me">回到我的</Link></>;

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
