import { errorText, uiText } from './language';
import { useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Text, TextField } from 'yahha-ui';
import { Button } from './kimi-ui';

import { authHttp } from './auth';
import { scopedHttp } from './http';
import { MusicMemberAccess, type Member } from './member-access';
import { Failure, Notice, PageIntro } from './shared';
import { ContactValue } from './music-contact-value';
import { CopyMusicValue } from './music-copy';
import { MusicRecommendations } from './music-matches';
import { peopleReturn, musicTrendReturn, musicCircleReturn, musicShoutReturn } from './music-return';
import { musicEntryPath, musicEntryReturn } from './music-entry';
import { Music2 } from 'lucide-react';
import { ActionLink } from './action-link';
import { Avatar, PageHeader, Tabs } from './kimi-ui';
import { useDiscoveryDetails } from './discovery-details';
export function People() {
  const [params,setParams]=useSearchParams(),navigate=useNavigate(),tab=params.get('tab')??'recommend';
  return <div className="kimi page people-page"><PageHeader title="同好" actions={<ActionLink to="/me/music" startIcon={<Music2 size={16}/>}>編輯我的成分</ActionLink>}/><Tabs label="同好功能" value={tab} onChange={value=>{if(value==='circles')navigate('/people/circles');else if(value==='partners')navigate('/people/shouts');else{const next=new URLSearchParams(params);if(value==='recommend')next.delete('tab');else next.set('tab',value);setParams(next);}}} items={[{value:'recommend',label:uiText('同好推薦')},{value:'search',label:uiText('查詢／比較')},{value:'circles',label:uiText('同好圈子')},{value:'partners',label:uiText('找搭子')}]}/><MusicMemberAccess>{viewer=>tab==='search'?<section className="people-search-panel"><Lookup key={viewer.scope} viewer={viewer}/></section>:<MusicRecommendations key={viewer.scope+':'+viewer.musicEpoch} viewer={viewer}/>}</MusicMemberAccess><div className="main-only-links"><Link to="/tools/room-lab">自由分房</Link><Link to="/people/circles">同好圈子</Link><Link to="/people/shouts">找搭子</Link><Link to="/people?tab=search">查詢／比較</Link></div></div>;
}
function Lookup({ viewer }: { viewer: Member }) {
  const [query, setQuery] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const navigate = useNavigate();
  async function find(compare = false) {
    setBusy(true); setError('');
    try {
      const id = compare ? (await authHttp(viewer).requestContract('POST /api/v2/music/compare', { body: { query } })).other.id
        : (await authHttp(viewer).requestContract('POST /api/v2/music/profiles/lookup', { body: { query } })).id;
      navigate('/people/' + id + (compare ? '/compare' : ''));
    }
    catch (failure) { setError(failure instanceof Error ? errorText(failure) : uiText("查詢失敗")); } finally { setBusy(false); }
  }
  return <section className="people-search-box people-lookup"><form onSubmit={event => { event.preventDefault(); void find(); }}><TextField label="固定成分 ID 或聯絡 QQ" value={query} maxLength={80} onChange={event => setQuery(event.target.value)} /><div className="people-lookup-actions"><Button type="submit" loading={busy} disabled={!query.trim()}>查詢成分</Button><Button type="button" variant="secondary" disabled={busy || !query.trim()} onClick={() => void find(true)}>比較成分</Button></div>{error && <Text role="alert">{error}</Text>}</form></section>;
}
export function PersonMusic() {
  const { id = '' } = useParams();
  const [search]=useSearchParams();const from=search.get('from');const activityReturn=from&&/^\/activities\/[^/?#]+#participants$/.test(from)?from:null;
  const entryReturn = musicEntryReturn(from);
  const recommendationReturn = peopleReturn(from);
  const trendReturn = musicTrendReturn(from);
  const circleReturn = musicCircleReturn(from);
  const shoutReturn = musicShoutReturn(from);
  return <><PageIntro title="同好成分" /><div className="page-actions">{shoutReturn && <Link to={shoutReturn}>回到找搭子</Link>}{circleReturn && <Link to={circleReturn}>回到同好圈子</Link>}{trendReturn && <Link to={trendReturn}>回到音樂趨勢</Link>}{recommendationReturn && <Link to={recommendationReturn}>回到同好推薦</Link>}{activityReturn&&<Link to={activityReturn}>回到活動名單</Link>}{entryReturn && <Link to={entryReturn}>回到詞條資料</Link>}<Link to="/people">回到同好查詢</Link></div><MusicMemberAccess>{viewer => <Person key={viewer.scope + ':' + viewer.musicEpoch + ':' + id} viewer={viewer} id={id} />}</MusicMemberAccess></>;
}
function Person({ viewer, id }: { viewer: Member; id: string }) {
  const location = useLocation();
  const profile = useQuery({ queryKey: ['private', viewer.scope, 'member-music', viewer.musicEpoch, id],
    queryFn: ({ signal }) => scopedHttp(viewer.scope).requestContract('GET /api/v2/music/profiles/:id', { signal, params: { id } }), refetchOnMount: 'always' });
  const fresh=profile.isFetchedAfterMount&&!profile.error?profile.data:undefined;
  useDiscoveryDetails(fresh?.name,fresh?'固定成分 ID・'+fresh.id:undefined);
  const comparison=useQuery({queryKey:['private',viewer.scope,'profile-card-comparison',viewer.musicEpoch,id],queryFn:({signal})=>scopedHttp(viewer.scope).requestContract('GET /api/v2/music/profiles/:id/comparison',{signal,params:{id}}),refetchOnMount:'always'});
  if (profile.isPending || !profile.isFetchedAfterMount) return <Notice>正在讀取成分…</Notice>;
  if (profile.error) return <Failure error={profile.error} retry={() => void profile.refetch()} />;
  const level=(value:number)=>({1:uiText('只聽過幾首'),2:uiText('聽過一些'),3:uiText('常聽'),4:uiText('本命')}[value]??'');
  return <section className="person-profile"><section className="profile-summary"><div className="profile-avatar-line"><Avatar user={{name:profile.data.name,avatar:profile.data.name.slice(0,1),color:"var(--moss)"}} size="xl"/><div><strong className="profile-person-name">{profile.data.name}</strong><span className="copy-value">{profile.data.id}<CopyMusicValue value={profile.data.id} label="成分 ID" compact/></span></div>{comparison.data&&<strong>{comparison.data.stats.matchPercent}%<small>匹配度</small></strong>}</div>
    {profile.data.note&&<blockquote className="match-note">留言：{profile.data.note}</blockquote>}
    <dl className="inline-definitions"><div><dt>稱呼</dt><dd className="copy-value">{profile.data.name}<CopyMusicValue key={profile.data.name} value={profile.data.name} label="名稱" compact/></dd></div>{profile.data.gender&&<div><dt>性別</dt><dd>{({female:uiText('女'),male:uiText('男')} as Record<string,string>)[profile.data.gender]??profile.data.gender}</dd></div>}<div><dt>聯絡 QQ</dt><dd><ContactValue key={profile.data.contactQQ} number={profile.data.contactQQ} source={profile.data.contactSource} compact/></dd></div></dl></section>
    <section className="profile-common">{comparison.isPending?<Notice>正在讀取共同喜好…</Notice>:comparison.error?<Failure error={comparison.error} retry={()=>void comparison.refetch()}/>:<><h3>共同喜好・{comparison.data.shared.length}</h3>{comparison.data.shared.map(pick=><div key={pick.id}><Link to={musicEntryPath(pick.id,new URLSearchParams({from:location.pathname+location.search}).toString())}>{pick.name}</Link>{pick.kind==='sub'&&<><span>{level(pick.myLevel)}</span><span>{level(pick.theirLevel)}</span></>}</div>)}</>}<details className="profile-all-picks"><summary>音樂成分・{profile.data.selections.length} 項</summary>{profile.data.selections.length?<ul>{profile.data.selections.map(selection=><li key={selection.entryId}><Link to={musicEntryPath(selection.entryId,new URLSearchParams({from:location.pathname+location.search}).toString())}>{selection.name}</Link>{selection.kind==='sub'?' · '+level(selection.level):''}</li>)}</ul>:<Text>尚未選擇詞條。</Text>}</details></section></section>;
}
