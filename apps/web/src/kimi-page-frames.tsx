import type { ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, Music2, Search } from 'lucide-react';
import { ActionLink } from './action-link';
import { PageHeader, Tabs } from './kimi-ui';
import { EmbeddedPageContext } from './shared';
import { uiText } from './language';
export function KimiMusicFrame({tab,children}:{tab:string;children:ReactNode}){
 const navigate=useNavigate(),location=useLocation();
 return <div className="kimi page my-music-page"><PageHeader title="我的成分" description="最多 5 個領域、15 個細分，合計 20 個" back={<Link className="back-link" aria-label="音樂詞庫" to={'/music'+location.search}><ArrowLeft size={18}/><span>音樂詞庫</span></Link>} actions={<ActionLink to="/music" startIcon={<Search size={16}/>}>探索詞條</ActionLink>}/><Tabs label="我的成分功能" value={tab} onChange={value=>navigate(value==='profile'?'/me/music/details':value==='terms'?'/me/music/entries':value==='share'?'/me/music/share':value==='trends'?'/music/trends':'/me/music')} items={[{value:'edit',label:uiText('成分編輯')},{value:'profile',label:uiText('成分資料')},{value:'terms',label:uiText('我的詞條')},{value:'share',label:uiText('分享圖片')},{value:'trends',label:uiText('音樂趨勢')}]}/><EmbeddedPageContext.Provider value><section className="music-settings-panel">{children}</section></EmbeddedPageContext.Provider></div>;
}
export function KimiPeopleFrame({tab,children}:{tab:string;children:ReactNode}){
 const navigate=useNavigate();
 return <div className="kimi page people-page"><PageHeader title="同好" actions={<ActionLink to="/me/music" startIcon={<Music2 size={16}/>}>編輯我的成分</ActionLink>}/><Tabs label="同好功能" value={tab} onChange={value=>navigate(value==='circles'?'/people/circles':value==='partners'?'/people/shouts':value==='search'?'/people?tab=search':'/people')} items={[{value:'recommend',label:uiText('同好推薦')},{value:'search',label:uiText('查詢／比較')},{value:'circles',label:uiText('同好圈子')},{value:'partners',label:uiText('找搭子')}]}/><EmbeddedPageContext.Provider value><section className="people-settings-panel">{children}</section></EmbeddedPageContext.Provider></div>;
}
