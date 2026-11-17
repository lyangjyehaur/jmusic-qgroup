import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button, Heading, Surface, Text, TextField } from 'yahha-ui';
import { MemberMusicProfile } from '@qgroup/contracts';
import { api } from './api';
import { MusicMemberAccess, type Member } from './member-access';
import { Failure, Notice, PageIntro } from './shared';
import { CopyMusicValue } from './music-copy';
import { musicEntryPath, musicEntryReturn } from './music-entry';
export function ContactValue({ number, source }: { number: string; source: 'legacy' | 'self_reported' | '' }) {
  const [message, setMessage] = useState('');
  async function copy() {
    try { await navigator.clipboard.writeText(number); setMessage('已複製聯絡 QQ。'); }
    catch { setMessage('無法自動複製，請選取號碼手動複製。'); }
  }
  return number ? <div className="contact-value"><Text>{number} · {source === 'legacy' ? '舊成分查詢號碼' : '自填號碼'}，未經騰訊驗證</Text><Button variant="secondary" onClick={() => void copy()}>複製聯絡 QQ</Button>{message && <Text role="status">{message}</Text>}</div> : <Text>尚未填寫聯絡 QQ。</Text>;
}
export function People() { return <><PageIntro title="同好" /><MusicMemberAccess>{viewer => <Lookup key={viewer.scope} viewer={viewer} />}</MusicMemberAccess></>; }
function Lookup({ viewer }: { viewer: Member }) {
  const [query, setQuery] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const navigate = useNavigate();
  async function find() {
    setBusy(true); setError('');
    try { const profile = await api('/music/profiles/lookup', MemberMusicProfile, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Account-Scope': viewer.scope, 'X-CSRF-Token': viewer.csrf }, body: JSON.stringify({ query }) }); navigate('/people/' + profile.id); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '查詢失敗'); } finally { setBusy(false); }
  }
  return <Surface className="detail auth-panel"><form onSubmit={event => { event.preventDefault(); void find(); }}><TextField label="固定成分 ID 或聯絡 QQ" value={query} maxLength={80} onChange={event => setQuery(event.target.value)} /><Button type="submit" loading={busy} disabled={!query.trim()}>查詢成分</Button>{error && <Text role="alert">{error}</Text>}</form><Link to="/me/music">我的成分</Link></Surface>;
}
export function PersonMusic() {
  const { id = '' } = useParams();
  const [search]=useSearchParams();const from=search.get('from');const activityReturn=from&&/^\/activities\/[^/?#]+#participants$/.test(from)?from:null;
  const entryReturn = musicEntryReturn(from);
  return <><PageIntro title="同好成分" /><div className="page-actions">{activityReturn&&<Link to={activityReturn}>回到活動名單</Link>}{entryReturn && <Link to={entryReturn}>回到詞條資料</Link>}<Link to="/people">回到同好查詢</Link></div><MusicMemberAccess>{viewer => <Person key={viewer.scope + ':' + viewer.musicEpoch + ':' + id} viewer={viewer} id={id} />}</MusicMemberAccess></>;
}
function Person({ viewer, id }: { viewer: Member; id: string }) {
  const profile = useQuery({ queryKey: ['private', viewer.scope, 'member-music', viewer.musicEpoch, id],
    queryFn: ({ signal }) => api('/music/profiles/' + encodeURIComponent(id), MemberMusicProfile, { signal, headers: { 'X-Account-Scope': viewer.scope } }), refetchOnMount: 'always' });
  if (profile.isPending || !profile.isFetchedAfterMount) return <Notice>正在讀取成分…</Notice>;
  if (profile.error) return <Failure error={profile.error} retry={() => void profile.refetch()} />;
  return <Surface className="detail auth-panel"><Heading level={2}>{profile.data.name}</Heading><Text>固定成分 ID：{profile.data.id}</Text>
    <div className="page-actions"><CopyMusicValue key={profile.data.name} value={profile.data.name} label="名稱" /><CopyMusicValue value={profile.data.id} label="成分 ID" /></div>
    {profile.data.gender && <Text>性別：{({ female: '女', male: '男' } as Record<string,string>)[profile.data.gender] ?? profile.data.gender}</Text>}<ContactValue key={profile.data.contactQQ} number={profile.data.contactQQ} source={profile.data.contactSource} /><Heading level={3}>音樂成分</Heading>{profile.data.selections.length ? <ul>{profile.data.selections.map(selection => <li key={selection.entryId}><Link to={musicEntryPath(selection.entryId)}>{selection.name}</Link>{selection.kind === 'sub' ? ' · ' + ({ 1: '只聽過幾首', 2: '聽過一些', 3: '常聽', 4: '本命' }[selection.level]) : ''}</li>)}</ul> : <Text>尚未選擇詞條。</Text>}</Surface>;
}
