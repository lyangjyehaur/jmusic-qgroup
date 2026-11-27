import { uiText } from './language';
import { createContext,useContext,useEffect,useState,type ReactNode } from 'react';
import { ThemeProvider } from 'yahha-ui';
import { z } from 'zod';
const schema=z.object({theme:z.enum(['system','light','dark']),wallpapers:z.boolean(),preset:z.enum(['gunju','pink','blue','yellow']).default('pink'),density:z.enum(['comfortable','compact']).default('comfortable')}).strict();
type Preferences=z.infer<typeof schema>;
const key='qgroup:appearance:v1',defaults:Preferences={theme:'system',wallpapers:true,preset:'pink',density:'comfortable'};
export const presetLabels={gunju:uiText('苔綠'),pink:uiText('粉色'),blue:uiText('淺藍'),yellow:uiText('淺黃')};
function read(){try{const raw=localStorage.getItem(key);if(raw)return{value:schema.parse(JSON.parse(raw)),error:''};
  const legacyTheme=localStorage.getItem('jpm.theme'),legacyWall=localStorage.getItem('jpm.wall');
  return{value:{...defaults,theme:legacyTheme==='dark'||legacyTheme==='light'?legacyTheme:'system',wallpapers:legacyWall!=='off'} as Preferences,error:''};
}catch{return{value:defaults,error:uiText('無法讀取外觀偏好；原始內容保留，請先保全後再保存。')};}}
const initial=read();
const effective=(theme:Preferences['theme'])=>theme==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):theme;
export function bootstrapAppearance(){document.documentElement.dataset.theme=effective(initial.value.theme);document.documentElement.dataset.preset=initial.value.preset;document.documentElement.dataset.density=initial.value.density;}
const Context=createContext<{value:Preferences;effective:'light'|'dark';error:string;change:(patch:Partial<Preferences>)=>void;retry:()=>void;repair:()=>void}|null>(null);
export function useAppearance(){const value=useContext(Context);if(!value)throw Error('Appearance context unavailable');return value;}
const paletteTokens={ink:'var(--app-ink)',muted:'var(--app-muted)',accent:'var(--app-button)',accentHover:'var(--app-button-hover)',accentSoft:'var(--app-soft)',line:'var(--app-contour)',focus:'var(--app-focus)',surface:'var(--app-surface)',fieldBackground:'var(--app-field)',error:'var(--app-error)'};
export function AppearanceProvider({children}:{children:ReactNode}){
  const [value,setValue]=useState(initial.value),[error,setError]=useState(initial.error),[readError,setReadError]=useState(!!initial.error),[system,setSystem]=useState(()=>effective('system'));
  const resolved=value.theme==='system'?system:value.theme;
  const tokens=paletteTokens;
  useEffect(()=>{const media=matchMedia('(prefers-color-scheme: dark)'),change=()=>setSystem(media.matches?'dark':'light');media.addEventListener('change',change);return()=>media.removeEventListener('change',change);},[]);
  useEffect(()=>{document.documentElement.dataset.theme=resolved;document.documentElement.dataset.preset=value.preset;document.documentElement.dataset.density=value.density;document.querySelector('meta[name="theme-color"]')?.setAttribute('content',getComputedStyle(document.documentElement).getPropertyValue('--app-bg').trim());},[resolved,value.preset,value.density]);
  useEffect(()=>{const changed=(event:StorageEvent)=>{if(event.key!==null&&![key,'jpm.theme','jpm.wall'].includes(event.key))return;const next=read();if(next.error){setReadError(true);setError(next.error);}else{setValue(next.value);setReadError(false);setError('');}};window.addEventListener('storage',changed);return()=>window.removeEventListener('storage',changed);},[]);
  function save(next:Preferences){if(readError)return;try{localStorage.setItem(key,JSON.stringify(next));setError('');}catch{setError(uiText("無法保存外觀偏好；本次變更仍有效，重新開啟時可能還原。"));}}
  function repair(){try{const raw=localStorage.getItem(key);if(raw!==null)localStorage.setItem(key+':recovery:'+Date.now(),raw);localStorage.setItem(key,JSON.stringify(value));setReadError(false);setError('');}catch{setError(uiText("仍無法保全外觀偏好，請檢查瀏覽器儲存設定。"));}}
  return <Context.Provider value={{value,effective:resolved,error,change:patch=>{const next={...value,...patch};setValue(next);save(next);},retry:()=>save(value),repair}}><ThemeProvider theme={value.preset==='gunju'?'yellow':value.preset} tokens={tokens} className="app-theme kimi-theme">{children}</ThemeProvider></Context.Provider>;
}
