import { MusicTranslation } from './music-name-display';
// Adapted from kimi/src/pages/MusicPage.tsx. Catalog/selection controllers are retained.
import { useContext, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, BookOpen, Check, Grid3x3, ListMusic, Plus, UsersRound } from 'lucide-react';
import { rankMusic, musicRankLimit } from '@qgroup/domain';
import { createWebHttpClient } from './http';
import { Failure, Notice } from './shared';
import { useMusicSearch, useMusicSearchShortcut } from './music-search';
import { MusicWorkspaceFeedback, useMusicWorkspace } from './music-selection';
import { MusicEntryDetails, musicEntryPath } from './music-entry';
import { MusicLibraryGroup } from './music-ranking';
import { KimiSelectionSummary } from './kimi-music-editor';
import { Badge, Button, Modal, PageHeader, SearchInput, Select } from './kimi-ui';
import { ActionLink } from './action-link';
import { categoryLabel } from './music-category';
import { DialogPageContext, InactivePageContext } from './discovery-dialog';
import { uiText } from './language';
import { MusicSaveDock } from './music-save-dock';
import { OverviewStats } from './overview-stats';
import { MusicBrowseTabs } from './music-browse-tabs';
import { MusicLevelPicker, musicLevelLabel } from './music-level-picker';
export function KimiMusicPage() {
  const query=useQuery({queryKey:['music-catalog'],queryFn:({signal})=>createWebHttpClient().requestContract('GET /api/v2/music/catalog',{signal}),refetchInterval:10000});
  const filters=useMusicSearch(query.data?.entries??[]), {params,update}=filters;
  const workspace=useMusicWorkspace(),selection=workspace.state==='ready'?workspace.selection:null,inactive=useContext(InactivePageContext);
  const selected=query.data?.entries.find(e=>e.id===params.get('entry'));
  const editorParams=new URLSearchParams(params);editorParams.delete('entry');
  const editorPath='/me/music'+(editorParams.size?'?'+editorParams:'');
  const requestedView=params.get('explorer');
  const legacyBubbles=requestedView==='bubbles';
  const view=requestedView==='all'||requestedView==='domains'||legacyBubbles||(!requestedView&&(params.get('library')==='all'||params.has('mainView')||params.has('subView')))?'all':'popular';
  useEffect(()=>{
    if(view==='all'&&(requestedView!=='all'||params.get('library')!=='all'))filters.updateMany({explorer:'all',library:'all',...(legacyBubbles?{mainView:params.get('mainView')??'bubbles',subView:params.get('subView')??'bubbles'}:{})});
  },[params,view]);
  const [search,setSearch]=useState(filters.search);useEffect(()=>setSearch(filters.search),[filters.search]);
  useMusicSearchShortcut('.music-search-area input');
  const entries=useMemo(()=>filters.search?filters.filtered:rankMusic(filters.filtered),[filters.filtered]);
  const groups=useMemo(()=>({main:entries.filter(e=>e.kind==='main'),sub:entries.filter(e=>e.kind==='sub')}),[entries]);
  const complete=view==='all'||!!(filters.search||filters.kind||filters.category);
  const title=complete?uiText('音樂詞庫'):uiText('熱門排行');
  const [scrollToKind,setScrollToKind]=useState<'main'|'sub'|null>(null);
  useEffect(()=>{if(view==='all'&&scrollToKind){document.getElementById('music-library-'+scrollToKind)?.scrollIntoView({block:'start'});setScrollToKind(null);}},[view,scrollToKind]);
  function chooseView(value:string){filters.updateMany({explorer:value,library:value==='all'?'all':''});}
  function completeLibrary(kind:'main'|'sub'){setScrollToKind(kind);chooseView('all');}
  return <div className="kimi page music-page"><PageHeader title="音樂" actions={<><ActionLink to="/me/music/entries/new" startIcon={<Plus size={14}/>}>建立詞條</ActionLink><ActionLink variant="primary" to={editorPath} startIcon={<ListMusic size={17}/>}>我的成分{selection&&<Badge tone="green">{selection.selected.size}</Badge>}</ActionLink></>}/>
    {query.data&&<OverviewStats label="音樂統計" items={[
      {label:uiText('成分'),value:query.data.stats.members},
      {label:uiText('詞條'),value:query.data.stats.entries},
      {label:uiText('24 小時新增成分'),value:query.data.stats.recentMembers24h},
      {label:uiText('24 小時新增詞條'),value:query.data.stats.recentEntries24h},
    ]}/>}
    <div className="music-explorer"><div className="music-search-area"><SearchInput value={search} onChange={value=>{setSearch(value);update('q',value);}} label="搜尋音樂詞條" placeholder="搜尋原名、譯名、別名或羅馬字"/><div className={'music-filters'+(filters.kind==='main'?' music-filters-domain':'')}><Select value={filters.kind} onChange={event=>update('kind',event.target.value)} aria-label="詞庫類型"><option value="">全部類型</option><option value="main">領域</option><option value="sub">細分</option></Select>{filters.kind!=='main'&&<Select value={filters.category} onChange={event=>update('category',event.target.value)} aria-label="細分類別"><option value="">全部分類</option>{filters.categories.map(category=><option key={category} value={category}>{categoryLabel(category)}</option>)}</Select>}</div></div>
      <div className="music-catalog-nav"><MusicBrowseTabs value={view} onChange={chooseView}/><span className="music-result-count" aria-live="polite" aria-atomic="true">{query.data&&entries.length+uiText(" 個結果")}</span></div>
      {query.isPending?<Notice>正在讀取詞條…</Notice>:query.error&&!query.data?<Failure error={query.error} retry={()=>void query.refetch()}/>:query.data&&<>
        {query.error&&!selected&&<Failure error={query.error} retry={()=>void query.refetch()}/>}
        <section className="term-list domain-browser music-rank-grid" aria-label={title}>{(['main','sub'] as const).map(kind=>{
          const group=groups[kind],expanded=params.get(kind+'Expanded')==='1',limit=musicRankLimit(kind,expanded,complete);
          if(!group.length)return null;
          const listing=<><ol role="list">{group.slice(0,limit).map((entry,index)=><li className={'term-row'+(selection?.selected.has(entry.id)?' is-selected':'')} key={entry.id}><span className="term-rank">{view==='popular'?String(index+1).padStart(2,'0'):entry.kind==='main'?<Grid3x3 size={16}/>:<BookOpen size={16}/>}</span><div className="term-name"><Link to={'/music?'+new URLSearchParams({...Object.fromEntries(params),entry:entry.id})}>{entry.name}</Link><MusicTranslation entry={entry}/><div className="term-meta"><span className="term-users"><UsersRound size={12}/><strong>{entry.count}</strong><span className="sr-only">人選用</span></span>{entry.kind==='sub'&&<span className="term-category">{categoryLabel(entry.category)}</span>}</div></div>{selection?<Button variant={selection.selected.has(entry.id)?'secondary':'ghost'} size="sm" aria-label={(selection.selected.has(entry.id)?'調整喜歡程度：':'選取')+entry.name} title={selection.selected.has(entry.id)?musicLevelLabel(selection.selected.get(entry.id)!):undefined} aria-pressed={selection.selected.has(entry.id)} disabled={selection.locked} onClick={()=>selection.toggle(entry)}>{selection.selected.has(entry.id)?<Check size={15}/>:<Plus size={15}/>} {selection.selected.has(entry.id)?musicLevelLabel(selection.selected.get(entry.id)!):'選取'}</Button>:<ActionLink to={editorPath}>選取</ActionLink>}<Link className="row-arrow" to={musicEntryPath(entry.id,params.toString())} aria-label={'查看 '+entry.name}><ArrowUpRight size={17}/></Link></li>)}</ol>{!complete&&group.length>10&&<div className="main-only-links"><Button variant="secondary" onClick={()=>update(kind+'Expanded',expanded?'':'1')}>{expanded?'收合'+(kind==='main'?'領域':'細分')+'排行':kind==='main'?'展開全部領域':'展開細分前 20 名'}</Button>{kind==='sub'&&group.length>20&&<Button variant="secondary" onClick={()=>completeLibrary('sub')}>查看完整細分詞庫</Button>}</div>}</>;
          return view==='all'?<MusicLibraryGroup key={kind} entries={group} kind={kind} params={params} update={update} selected={selection?.selected??null}>{listing}</MusicLibraryGroup>:<section key={kind} id={'music-library-'+kind} aria-label={kind==='main'?'領域排行':'細分排行'} className="music-rank-group"><div className="music-rank-header"><h3 className="term-group-title">{kind==='main'?'領域':'細分'} · {group.length} 項</h3></div>{listing}</section>;
        })}{!entries.length&&<Notice>沒有符合目前搜尋與篩選的詞條。</Notice>}</section>
        {params.get('entry')&&!selected&&<Notice>這個詞條不存在或已刪除。</Notice>}
      </>}
    </div>
    {selected&&!inactive&&<Modal title={selected.name} wide footer={<>{selection&&<MusicSaveDock selection={selection}/>}<Button variant="secondary" onClick={()=>update('entry','')}>返回詞庫</Button><ActionLink variant="primary" to={editorPath}>編輯我的成分</ActionLink></>} onClose={()=>update('entry','')}><DialogPageContext.Provider value><MusicWorkspaceFeedback/>{query.error&&<Failure error={query.error} retry={()=>void query.refetch()}/>}<MusicEntryDetails entry={selected}/>{selection&&<div className="term-selection"><KimiSelectionSummary selection={selection} compact entryId={selected.id}/></div>}</DialogPageContext.Provider>{selection&&<MusicLevelPicker selection={selection}/>}</Modal>}
  </div>;
}
