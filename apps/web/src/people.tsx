import { errorText, uiText } from './language';
import { useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button, Heading, Surface, Text, TextField } from 'yahha-ui';
import { MusicComparison, MemberMusicProfile } from '@qgroup/contracts';
import { authHttp } from './auth';
import { scopedHttp } from './http';
import { MusicMemberAccess, type Member } from './member-access';
import { Failure, Notice, PageIntro } from './shared';
import { ContactValue } from './music-contact-value';
import { CopyMusicValue } from './music-copy';
import { MusicRecommendations } from './music-matches';
import { peopleReturn, musicTrendReturn, musicCircleReturn, musicShoutReturn } from './music-return';
import { musicEntryPath, musicEntryReturn } from './music-entry';
export function People() { return <><PageIntro title="同好" /><div className="page-actions"><Link to="/tools/room-lab">自由分房</Link><Link to="/people/circles">同好圈子</Link><Link to="/people/shouts">找搭子</Link></div><MusicMemberAccess>{viewer => <><Lookup key={viewer.scope} viewer={viewer} /><MusicRecommendations key={viewer.scope + ':' + viewer.musicEpoch} viewer={viewer} /></>}</MusicMemberAccess></>; }
function Lookup({ viewer }: { viewer: Member }) {
  const [query, setQuery] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const navigate = useNavigate();
  async function find(compare = false) {
    setBusy(true); setError('');
    try {
      const id = compare ? (await authHttp(viewer).request('POST /api/v2/music/compare', { body: { query } }, MusicComparison)).other.id
        : (await authHttp(viewer).request('POST /api/v2/music/profiles/lookup', { body: { query } }, MemberMusicProfile)).id;
      navigate('/people/' + id + (compare ? '/compare' : ''));
    }
    catch (failure) { setError(failure instanceof Error ? errorText(failure) : uiText("查詢失敗")); } finally { setBusy(false); }
  }
  return <Surface className="detail auth-panel"><form onSubmit={event => { event.preventDefault(); void find(); }}><TextField label="固定成分 ID 或聯絡 QQ" value={query} maxLength={80} onChange={event => setQuery(event.target.value)} /><Button type="submit" loading={busy} disabled={!query.trim()}>查詢成分</Button><Button type="button" variant="secondary" disabled={busy || !query.trim()} onClick={() => void find(true)}>比較成分</Button>{error && <Text role="alert">{error}</Text>}</form><Link to="/me/music">我的成分</Link></Surface>;
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
  const location = useLocation(), [params] = useSearchParams(), back = peopleReturn(params.get('from')) ?? musicTrendReturn(params.get('from')) ?? musicCircleReturn(params.get('from')) ?? musicShoutReturn(params.get('from'));
  const profile = useQuery({ queryKey: ['private', viewer.scope, 'member-music', viewer.musicEpoch, id],
    queryFn: ({ signal }) => scopedHttp(viewer.scope).request('GET /api/v2/music/profiles/:id', { signal, params: { id } }, MemberMusicProfile), refetchOnMount: 'always' });
  if (profile.isPending || !profile.isFetchedAfterMount) return <Notice>正在讀取成分…</Notice>;
  if (profile.error) return <Failure error={profile.error} retry={() => void profile.refetch()} />;
  return <Surface className="detail auth-panel"><Heading level={2}>{profile.data.name}</Heading><Text>固定成分 ID：{profile.data.id}</Text>
    <div className="page-actions"><Link to={'/people/' + profile.data.id + '/compare' + (back ? '?' + new URLSearchParams({ from: back }) : '')}>比較成分</Link><CopyMusicValue key={profile.data.name} value={profile.data.name} label="名稱" /><CopyMusicValue value={profile.data.id} label="成分 ID" /></div>
    {profile.data.note && <Text className="match-note">留言：{profile.data.note}</Text>}
    {profile.data.gender && <Text>性別：{({ female: uiText('女'), male: uiText('男') } as Record<string,string>)[profile.data.gender] ?? profile.data.gender}</Text>}<ContactValue key={profile.data.contactQQ} number={profile.data.contactQQ} source={profile.data.contactSource} /><Heading level={3}>音樂成分</Heading>{profile.data.selections.length ? <ul>{profile.data.selections.map(selection => <li key={selection.entryId}><Link to={musicEntryPath(selection.entryId, new URLSearchParams({ from: location.pathname + location.search }).toString())}>{selection.name}</Link>{selection.kind === 'sub' ? ' · ' + ({ 1: uiText('只聽過幾首'), 2: uiText('聽過一些'), 3: uiText('常聽'), 4: uiText('本命') }[selection.level]) : ''}</li>)}</ul> : <Text>尚未選擇詞條。</Text>}</Surface>;
}
