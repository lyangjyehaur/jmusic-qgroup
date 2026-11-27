import { errorText, uiText } from './language';
import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Text } from 'yahha-ui';
import { Button, Disclosure } from './kimi-ui';

import { authHttp } from './auth';
import { scopedHttp } from './http';
import { MusicMemberAccess, type Member } from './member-access';
import { Failure, Notice, PageIntro } from './shared';
import { ContactValue } from './music-contact-value';
import { CopyMusicValue } from './music-copy';
import { MusicRecommendations } from './music-matches';
import { peopleReturn, musicTrendReturn, musicCircleReturn, musicShoutReturn } from './music-return';
import { musicEntryPath, musicEntryReturn } from './music-entry';
import { GitCompareArrows, Search } from 'lucide-react';
import { Avatar, Field } from './kimi-ui';
import { KimiPeopleFrame } from './kimi-page-frames';
import { useDiscoveryDetails } from './discovery-details';
import { FeedbackLayer } from './feedback-layer';
import { useMusicWorkspace } from './music-selection';
import { categoryLabel } from './music-category';
import { ComparedPicks } from './music-match-view';
export function People() {
  const [params]=useSearchParams(),tab=params.get('tab')==='search'?'search':'recommend';
  return <KimiPeopleFrame tab={tab}><MusicMemberAccess>{viewer=>tab==='search'?<section className="people-search-panel"><Lookup key={viewer.scope} viewer={viewer}/></section>:<MusicRecommendations key={viewer.scope+':'+viewer.musicEpoch} viewer={viewer}/>}</MusicMemberAccess></KimiPeopleFrame>;
}
function Lookup({ viewer }: { viewer: Member }) {
  const [query, setQuery] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const navigate = useNavigate(),location=useLocation();
  async function find(compare = false) {
    setBusy(true); setError('');
    try {
      const id = compare ? (await authHttp(viewer).requestContract('POST /api/v2/music/compare', { body: { query } })).other.id
        : (await authHttp(viewer).requestContract('POST /api/v2/music/profiles/lookup', { body: { query } })).id;
      navigate('/people/' + id + (compare ? '/compare' : '')+'?'+new URLSearchParams({from:location.pathname+location.search}));
    }
    catch (failure) { setError(failure instanceof Error ? errorText(failure) : uiText("查詢失敗")); } finally { setBusy(false); }
  }
  return <section className="people-search-box people-lookup">
    <form onSubmit={event => { event.preventDefault(); if(!busy&&query.trim())void find(); }}>
      <Field label="QQ" hint="輸入 QQ，查看成分或與自己比較。"><input value={query} maxLength={80} disabled={busy} autoComplete="off" onChange={event=>{setQuery(event.target.value);setError('');}}/></Field>
      <div className="people-lookup-actions"><Button type="submit" startIcon={<Search size={16}/>} loading={busy} disabled={!query.trim()}>查詢成分</Button><Button type="button" variant="secondary" startIcon={<GitCompareArrows size={16}/>} disabled={busy || !query.trim()} onClick={() => void find(true)}>比較成分</Button></div>
      {error&&<Text role="alert" className="people-lookup-error">{error}</Text>}
    </form>
  </section>;
}
export function PersonMusic() {
  const { id = '' } = useParams();
  const [search]=useSearchParams();const from=search.get('from');const activityReturn=from&&/^\/activities\/[^/?#]+#participants$/.test(from)?from:null;
  const entryReturn = musicEntryReturn(from);
  const recommendationReturn = peopleReturn(from);
  const trendReturn = musicTrendReturn(from);
  const circleReturn = musicCircleReturn(from);
  const shoutReturn = musicShoutReturn(from);
  return <><PageIntro title="同好成分" /><div className="page-actions">{shoutReturn && <Link to={shoutReturn}>回到找搭子</Link>}{circleReturn && <Link to={circleReturn}>回到同好圈子</Link>}{trendReturn && <Link to={trendReturn}>回到音樂趨勢</Link>}{recommendationReturn && <Link to={recommendationReturn}>{new URL(recommendationReturn,'https://local.invalid').searchParams.get('tab')==='search'?'回到查詢／比較':'回到同好推薦'}</Link>}{activityReturn&&<Link to={activityReturn}>回到活動名單</Link>}{entryReturn && <Link to={entryReturn}>回到詞條資料</Link>}{!shoutReturn&&!circleReturn&&!trendReturn&&!recommendationReturn&&!activityReturn&&!entryReturn&&<Link to="/people">回到同好查詢</Link>}</div><MusicMemberAccess>{viewer => <Person key={viewer.scope + ':' + viewer.musicEpoch + ':' + id} viewer={viewer} id={id} />}</MusicMemberAccess></>;
}
function Person({ viewer, id }: { viewer: Member; id: string }) {
  const location = useLocation();
  const [copyMessage,setCopyMessage]=useState('');
  const workspace=useMusicWorkspace();
  const catalog=new Map(workspace.state==='ready'?workspace.selection.entries.map(entry=>[entry.id,entry]):[]);
  useEffect(()=>{if(!copyMessage)return;const timer=setTimeout(()=>setCopyMessage(''),4000);return()=>clearTimeout(timer);},[copyMessage]);
  const profile = useQuery({ queryKey: ['private', viewer.scope, 'member-music', viewer.musicEpoch, id],
    queryFn: ({ signal }) => scopedHttp(viewer.scope).requestContract('GET /api/v2/music/profiles/:id', { signal, params: { id } }), refetchOnMount: 'always' });
  const fresh=profile.isFetchedAfterMount&&!profile.error?profile.data:undefined;
  useDiscoveryDetails(fresh?.name);
  const comparison=useQuery({queryKey:['private',viewer.scope,'profile-card-comparison',viewer.musicEpoch,id],queryFn:({signal})=>scopedHttp(viewer.scope).requestContract('GET /api/v2/music/profiles/:id/comparison',{signal,params:{id}}),refetchOnMount:'always'});
  if (profile.isPending || !profile.isFetchedAfterMount) return <Notice>正在讀取成分…</Notice>;
  if (profile.error) return <Failure error={profile.error} retry={() => void profile.refetch()} />;
  const level=(value:number)=>({1:uiText('只聽過幾首'),2:uiText('聽過一些'),3:uiText('常聽'),4:uiText('本命')}[value]??'');
  return <section className="person-profile"><section className="profile-summary"><div className="profile-avatar-line"><Avatar user={{name:profile.data.name,avatar:profile.data.name.slice(0,1),avatarUrl:profile.data.avatarUrl,color:"var(--moss)"}} size="xl"/><div><strong className="profile-person-name">{profile.data.name}</strong></div>{comparison.data&&<strong>{comparison.data.stats.matchPercent}%<small>匹配度</small></strong>}</div>
    {profile.data.note&&<blockquote className="match-note">留言：{profile.data.note}</blockquote>}
    <dl className="inline-definitions"><div><dt>稱呼</dt><dd className="copy-value">{profile.data.name}<CopyMusicValue key={profile.data.name} value={profile.data.name} label="名稱" compact/></dd></div>{profile.data.gender&&<div><dt>性別</dt><dd>{({female:uiText('女'),male:uiText('男')} as Record<string,string>)[profile.data.gender]??profile.data.gender}</dd></div>}<div><dt>QQ</dt><dd><ContactValue key={profile.data.contactQQ} number={profile.data.contactQQ} source={profile.data.contactSource} compact/></dd></div></dl></section>
    <section className="profile-common">{comparison.isPending?<Notice>正在讀取共同喜好…</Notice>:comparison.error?<Failure error={comparison.error} retry={()=>void comparison.refetch()}/>:<ComparedPicks title="共同喜好" picks={comparison.data.shared} shared/>}<Disclosure className="profile-all-picks"  title={<>音樂成分・{profile.data.selections.length} 項</>}>{profile.data.selections.length?<ul>{profile.data.selections.map(selection=><li key={selection.entryId}><span><Link to={musicEntryPath(selection.entryId,new URLSearchParams({from:location.pathname+location.search}).toString())}>{selection.name}</Link>{' · '+level(selection.level)}</span>{catalog.has(selection.entryId)&&<span className="profile-pick-meta">{selection.kind==='sub'&&<span>{categoryLabel(catalog.get(selection.entryId)!.category)}</span>}<span>{catalog.get(selection.entryId)!.count} 人</span></span>}<CopyMusicValue value={selection.name} label="詞條" compact onMessage={setCopyMessage}/></li>)}</ul>:<Text>尚未選擇詞條。</Text>}</Disclosure></section>{copyMessage&&<FeedbackLayer><p className="music-save-result" role="status">{copyMessage}</p></FeedbackLayer>}</section>;
}
