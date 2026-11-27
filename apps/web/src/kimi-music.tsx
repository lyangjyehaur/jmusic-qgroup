// Adapted from kimi/src/pages/MusicPage.tsx. Catalog/selection controllers are retained.
import { useContext, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, BookOpen, Check, Grid3x3, ListMusic, Plus, UsersRound } from 'lucide-react';
import { rankMusic, musicRankLimit } from '@qgroup/domain';
import { createWebHttpClient } from './http';
import { Failure, Notice } from './shared';
import { useMusicSearch, useMusicSearchShortcut } from './music-search';
import { MusicWorkspaceFeedback, useMusicWorkspace } from './music-selection';
import { MusicEntryDetails, musicEntryPath } from './music-entry';
import { MusicRanking } from './music-ranking';
import { KimiSelectionSummary } from './kimi-music-editor';
import { Badge, Button, Modal, PageHeader, SearchInput, Select } from './kimi-ui';
import { ActionLink } from './action-link';
import { categoryLabel } from './music-entries';
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
  const view=params.get('explorer')??(params.get('library')==='all'?'all':params.get('subView')==='bubbles'||params.get('mainView')==='bubbles'?'domains':'popular');
  const [search,setSearch]=useState(filters.search);useEffect(()=>setSearch(filters.search),[filters.search]);
  useMusicSearchShortcut('.music-search-area input');
  const entries=useMemo(()=>rankMusic(filters.filtered),[filters.filtered]);
  const complete=view==='all'||!!(filters.search||filters.kind||filters.category);
  const title=complete?uiText('音樂詞庫'):uiText('熱門排行');
  function chooseView(value:string){const next=new URLSearchParams(params);next.set('explorer',value);if(value==='all')next.set('library','all');else next.delete('library');if(value==='bubbles'){next.set('mainView','bubbles');next.set('subView','bubbles');}else{next.delete('mainView');next.delete('subView');}update('explorer',value);for(const key of ['library','mainView','subView'])update(key,next.get(key)??'');}
  return <div className="kimi page music-page"><PageHeader title="音樂" actions={<ActionLink variant="primary" to={editorPath} startIcon={<ListMusic size={17}/>}>我的成分{selection&&<Badge tone="green">{selection.selected.size}</Badge>}</ActionLink>}/>
    {query.data&&<OverviewStats label="音樂統計" items={[
      {label:uiText('成分'),value:query.data.stats.members},
      {label:uiText('詞條'),value:query.data.stats.entries},
      {label:uiText('24 小時新增成分'),value:query.data.stats.recentMembers24h},
      {label:uiText('24 小時新增詞條'),value:query.data.stats.recentEntries24h},
    ]}/>}
    <div className="music-explorer"><div className="music-search-area"><SearchInput value={search} onChange={value=>{setSearch(value);update('q',value);}} label="搜尋音樂詞條" placeholder="搜尋名稱、別名、拼音或首字母"/><div className="music-filters"><Select value={filters.kind} onChange={event=>update('kind',event.target.value)} aria-label="詞庫類型"><option value="">全部類型</option><option value="main">領域</option><option value="sub">細分</option></Select><Select value={filters.category} onChange={event=>update('category',event.target.value)} aria-label="詞庫分類"><option value="">全部分類</option>{query.data?.categories.map(category=><option key={category} value={category}>{categoryLabel(category)}</option>)}</Select><span>{entries.length} 個結果</span><ActionLink to="/me/music/entries/new" startIcon={<Plus size={14}/>}>建立詞條</ActionLink></div></div>
      <MusicBrowseTabs value={view} onChange={chooseView}/>
      {query.isPending?<Notice>正在讀取詞條…</Notice>:query.error&&!query.data?<Failure error={query.error} retry={()=>void query.refetch()}/>:query.data&&<>
        {query.error&&!selected&&<Failure error={query.error} retry={()=>void query.refetch()}/>}
        {view==='bubbles'?<section className="bubble-view"><div className="bubble-legend"><span><i className="bubble-domain"/>領域</span><span><i/>細分</span><small>大小代表選用人數</small></div><div className="bubble-canvas">{entries.map(entry=><Link key={entry.id} className={'term-bubble'+(entry.kind==='main'?' domain':'')} style={{'--bubble-size':Math.max(66,Math.min(132,48+entry.count*2))+'px'} as CSSProperties} aria-label={entry.name+'，'+entry.count+' 人'} title={entry.name} to={musicEntryPath(entry.id,params.toString())}><span>{entry.name}</span><small>{entry.count}</small></Link>)}</div></section>:view==='domains'?<div className="domain-browser">{(['main','sub'] as const).map(kind=><MusicRanking key={kind} entries={entries.filter(e=>e.kind===kind)} kind={kind} complete={complete} params={params} update={update} selected={selection?.selected??null}/>)}</div>:<section className="term-list" aria-label={title}>{(['main','sub'] as const).map(kind=>{
          const group=entries.filter(e=>e.kind===kind),expanded=params.get(kind+'Expanded')==='1',limit=musicRankLimit(kind,expanded,complete);
          if(!group.length)return null;
          return <section key={kind} aria-label={kind==='main'?'領域排行':'細分排行'}><h3 className="term-group-title">{kind==='main'?'領域':'細分'} · {group.length} 項</h3><ol role="list">{group.slice(0,limit).map((entry,index)=><li className={'term-row'+(selection?.selected.has(entry.id)?' is-selected':'')} key={entry.id}><span className="term-rank">{view==='popular'?String(index+1).padStart(2,'0'):entry.kind==='main'?<Grid3x3 size={16}/>:<BookOpen size={16}/>}</span><div className="term-name"><Link to={'/music?'+new URLSearchParams({...Object.fromEntries(params),entry:entry.id})}>{entry.name}</Link><span>{entry.aliases.slice(0,2).join('・')}</span></div><div className="term-category"><Badge tone={entry.kind==='main'?'green':'neutral'}>{entry.kind==='main'?'領域':'細分'}</Badge><span>{categoryLabel(entry.category)}</span></div><div className="term-users"><UsersRound size={14}/><strong>{entry.count}</strong><span className="sr-only">人</span></div>{selection?<Button variant={selection.selected.has(entry.id)?'secondary':'ghost'} size="sm" aria-label={(selection.selected.has(entry.id)?entry.kind==='sub'?'調整喜歡程度：':'取消選取':'選取')+entry.name} aria-pressed={selection.selected.has(entry.id)} disabled={selection.locked} onClick={()=>selection.toggle(entry)}>{selection.selected.has(entry.id)?<Check size={15}/>:<Plus size={15}/>} {selection.selected.has(entry.id)?entry.kind==='sub'?musicLevelLabel(selection.selected.get(entry.id)!):'已選':'選取'}</Button>:<ActionLink to={editorPath}>選取</ActionLink>}<Link className="row-arrow" to={musicEntryPath(entry.id,params.toString())} aria-label={'查看 '+entry.name}><ArrowUpRight size={17}/></Link></li>)}</ol>{!complete&&group.length>10&&<div className="main-only-links"><Button variant="secondary" onClick={()=>update(kind+'Expanded',expanded?'':'1')}>{expanded?'收合'+(kind==='main'?'領域':'細分')+'排行':kind==='main'?'展開全部領域':'展開細分前 20 名'}</Button>{kind==='sub'&&group.length>20&&<Button variant="secondary" onClick={()=>chooseView('all')}>查看完整細分詞庫</Button>}</div>}</section>;
        })}{!entries.length&&<Notice>沒有符合目前搜尋與篩選的詞條。</Notice>}</section>}
        {params.get('entry')&&!selected&&<Notice>這個詞條不存在或已刪除。</Notice>}
      </>}
    </div><div className="main-only-links"><Link to="/me/music/entries">我的詞條</Link><Link to={editorPath}>編輯我的成分</Link></div>
    {selected&&!inactive&&<Modal title={selected.name} wide footer={<>{selection&&<MusicSaveDock selection={selection}/>}<Button variant="secondary" onClick={()=>update('entry','')}>返回詞庫</Button><ActionLink variant="primary" to={editorPath}>編輯我的成分</ActionLink></>} onClose={()=>update('entry','')}><DialogPageContext.Provider value><MusicWorkspaceFeedback/>{query.error&&<Failure error={query.error} retry={()=>void query.refetch()}/>}<MusicEntryDetails entry={selected}/>{selection&&<div className="term-selection"><KimiSelectionSummary selection={selection} compact entryId={selected.id}/></div>}</DialogPageContext.Provider>{selection&&<MusicLevelPicker selection={selection}/>}</Modal>}
  </div>;
}
