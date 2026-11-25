// Adapted from kimi/src/pages/MyMusicPage.tsx. The durable controller remains authoritative.
import { useId, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, ChevronDown, Plus, RotateCcw, Save, Search, X } from 'lucide-react';
import { createMusicSearch } from '@qgroup/domain';
import type { MusicSelection } from './music-selection';
import { Badge, Button, PageHeader, SearchInput, Select, Tabs } from './kimi-ui';
import { ActionLink } from './action-link';
import { categoryLabel } from './music-entries';
import { uiText } from './language';
import { useMusicSearchShortcut } from './music-search';
const levels = [[4,uiText('本命')],[3,uiText('常聽')],[2,uiText('聽過一些')],[1,uiText('只聽過幾首')]] as const;
export function KimiSelectionSummary({ selection: form, compact = false, entryId }: { selection: MusicSelection; compact?: boolean; entryId?:string }) {
  const location=useLocation();
  if(compact&&entryId){
    const entry=form.entries.find(item=>item.id===entryId),selected=form.selected.get(entryId);
    return <aside className="term-selection-controls" aria-label="我的選擇">{selected&&entry&&<>{entry.kind==='sub'?<div className="term-familiarity"><span>我的熟悉度</span><Select aria-label={entry.name+'喜歡程度'} value={selected} disabled={form.locked} onChange={event=>form.level(entryId,Number(event.target.value))}>{levels.map(([value,label])=><option key={value} value={value}>{label}</option>)}</Select></div>:<p>已選取此領域</p>}</>}<Button aria-label={formPendingLabel(form)} loading={form.sending} disabled={!form.dirty||form.unavailable} onClick={()=>void form.save()}><Save size={16}/>{form.draft.requestKey?'確認保存結果':form.dirty?'保存成分':'已保存'}</Button>{<div className="page-actions"><Button variant="text" disabled={form.locked||!form.dirty} onClick={()=>form.reset()}>還原未保存修改</Button><Button variant="text" disabled={form.locked||!form.dirty} onClick={()=>void form.rebase()}>核對最新版本，保留我的選擇</Button></div>}</aside>;
  }
  return <aside className="selection-summary" aria-label="我的選擇"><div className="summary-count"><strong>{form.selected.size}</strong><span>/ 20 項</span></div><div className="limit-bar"><i style={{width:`${form.selected.size/20*100}%`}}/></div>
    <dl><div><dt>領域</dt><dd>{form.mainCount} / 5</dd></div><div><dt>細分</dt><dd>{form.subCount} / 15</dd></div><div><dt>本命</dt><dd>{form.draft.selections.filter(s=>form.entries.find(e=>e.id===s.entryId)?.kind==='sub'&&s.level===4).length}</dd></div></dl>
    <div className="selection-preview-tags">{form.draft.selections.slice(0,6).map(s=><span key={s.entryId}>{form.entries.find(e=>e.id===s.entryId)?.name??uiText('已移除的詞條')}</span>)}{form.selected.size>6&&<small>另 {form.selected.size-6} 項</small>}</div>
    <div className={form.dirty ? "editor-actions" : "saved-actions"}><Button aria-label={formPendingLabel(form)} className="save" loading={form.sending} disabled={!form.dirty||form.unavailable} onClick={()=>void form.save()}><Save size={16}/>{form.draft.requestKey?'確認保存結果':form.dirty?'保存成分':'已保存'}</Button></div>
    {<Button variant="text" disabled={form.locked||!form.dirty} onClick={()=>form.reset()}><RotateCcw size={14}/>還原未保存修改</Button>}
    {<Button variant="text" disabled={form.locked||!form.dirty} onClick={()=>void form.rebase()}>核對最新版本，保留我的選擇</Button>}
    {<p>{form.dirty?'尚有未保存的修改。':form.saved?'所有選擇已保存。':'選擇後即可建立成分。'}</p>}
    <div className="page-actions"><Link to={(location.pathname==='/me/music'?'/music':'/me/music')+location.search}>{location.pathname==='/me/music'?'音樂詞庫':'編輯我的成分'}</Link><Link to={'/me/music/share'+location.search}>分享成分</Link></div>
    {compact&&<div className="selection-inline-choices"><KimiSelectedRows form={form}/></div>}
  </aside>;
}
export function KimiSelectedRows({ form }: { form: MusicSelection }) {
  const [collapsed,setCollapsed]=useState<Record<string,boolean>>({}),groupId=useId();
  const chosen=form.draft.selections.map(selection=>({selection,entry:form.entries.find(e=>e.id===selection.entryId)}));
  const groups=[{name:uiText('領域'),items:chosen.filter(row=>row.entry?.kind==='main')},...levels.map(([level,name])=>({name,items:chosen.filter(row=>row.entry?.kind!=='main'&&row.selection.level===level)}))];
  return <div className="selection-groups">{groups.map((group,index)=><section className="familiarity-group" key={group.name}><header><h3>{group.name}</h3><span>{group.items.length}</span><button type="button" className="selection-group-toggle" aria-label={(collapsed[group.name]?'展開':'收合')+group.name} aria-expanded={!collapsed[group.name]} aria-controls={groupId+'-'+index} onClick={()=>setCollapsed(previous=>({...previous,[group.name]:!previous[group.name]}))}><ChevronDown size={14} aria-hidden="true"/></button></header><div id={groupId+'-'+index} hidden={collapsed[group.name]}>{group.items.map(({entry,selection})=><div className={'selection-row'+(entry?.kind==='main'?' selection-row-domain':'')} key={selection.entryId}>
    <div className="selection-term"><Badge tone={entry?.kind==='main'?'green':'neutral'}>{entry?.kind==='main'?'領域':'細分'}</Badge>{entry?<Link to={'/music/entries/'+encodeURIComponent(entry.id)}>{entry.name}</Link>:<span>已移除的詞條</span>}{entry&&categoryLabel(entry.category)!==(entry.kind==='main'?uiText('領域'):uiText('細分'))&&<small>{categoryLabel(entry.category)}</small>}</div>
    {entry?.kind!=='main'&&<Select aria-label={(entry?.name??uiText('已移除的詞條'))+'喜歡程度'} disabled={form.locked} value={selection.level} onChange={event=>form.level(selection.entryId,Number(event.target.value))}>{levels.map(([value,label])=><option key={value} value={value}>{label}</option>)}</Select>}
    <button className="remove-selection" aria-label={'移除'+(entry?.name??uiText('已移除的詞條'))} disabled={form.locked} onClick={()=>form.remove(selection.entryId)}><X size={16}/></button></div>)}{!group.items.length&&<p className="empty-group">尚無詞條。</p>}</div></section>)}</div>;
}
export function KimiProfileEditor({ selection: form }: { selection: MusicSelection }) {
  const navigate=useNavigate(),location=useLocation(),[query,setQuery]=useState('');
  useMusicSearchShortcut('.quick-add input');
  const match=useMemo(()=>createMusicSearch(form.entries),[form.entries]);
  const results=query.trim()?form.entries.filter(e=>!form.selected.has(e.id)&&match(e.id,query)).slice(0,8):[];
  return <div className="kimi page my-music-page"><PageHeader title="我的成分" description="最多 5 個領域、15 個細分，合計 20 個" actions={<ActionLink to={'/music'+location.search} startIcon={<Search size={16}/>}>探索詞條</ActionLink>} back={<Link to={'/music'+location.search} className="back-link" aria-label="音樂詞庫"><ArrowLeft size={18}/><span>音樂詞庫</span></Link>}/>
    <Tabs label="我的成分功能" value="edit" onChange={value=>navigate(value==='profile'?'/me/music/details':value==='terms'?'/me/music/entries':value==='share'?'/me/music/share':value==='trends'?'/music/trends':'/me/music')} items={[{value:'edit',label:uiText('成分編輯')},{value:'profile',label:uiText('成分資料')},{value:'terms',label:uiText('我的詞條')},{value:'share',label:uiText('分享圖片')},{value:'trends',label:uiText('音樂趨勢')}]}/>
    <div className="main-only-links editor-return">{form.returnTo&&<Link to={form.returnTo}>{form.returnTo.startsWith('/activities')?'← 回到剛才的活動':form.returnTo.startsWith('/music/trends')?'回到音樂趨勢':form.returnTo.startsWith('/people/circles')?'回到同好圈子':form.returnTo.startsWith('/people/shouts')?'回到找搭子':'回到同好成分'}</Link>}</div>
    <div className="selection-layout"><section className="selection-workspace"><div className="selection-toolbar"><div><h2>已選詞條</h2><p>只有細分設定喜歡程度</p></div><div className="selection-limits"><span className={form.mainCount>=5?'at-limit':''}>領域 <strong>{form.mainCount}</strong>/5</span><span className={form.subCount>=15?'at-limit':''}>細分 <strong>{form.subCount}</strong>/15</span></div></div>
      <div className="quick-add"><SearchInput value={query} onChange={setQuery} label="尋找喜歡的音樂" placeholder="直接搜尋並加入詞條"/>{results.length>0&&<div className="quick-add-results">{results.map(entry=><button key={entry.id} disabled={form.locked} onClick={()=>{form.toggle(entry);setQuery('');}}><Plus size={14}/><span>{entry.name}</span><Badge>{entry.kind==='main'?'領域':'細分'}</Badge><small>{categoryLabel(entry.category)}</small></button>)}</div>}{query.trim()&&!results.length&&<p className="field-hint">沒有尚未選取的符合詞條。</p>}</div>
      <KimiSelectedRows form={form}/></section><KimiSelectionSummary selection={form}/></div>
    <details className="music-profile-tools"><summary>成分操作</summary><div className="main-only-links">{form.saved?<><Link to="/me/music/contact">聯絡 QQ</Link><Link to={'/people/'+form.saved.id}>查看我的成分卡</Link></>:<Link to="/me/music/recover">找回舊成分</Link>}</div></details>
  </div>;
}

function formPendingLabel(form:MusicSelection){return form.draft.requestKey?uiText('確認保存結果'):uiText('保存我的成分');}
