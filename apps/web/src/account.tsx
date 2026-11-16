import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { EmptyState, Heading, Surface, Text } from 'yahha-ui';
import { Catalog, Profile, type Viewer } from '@qgroup/contracts';
import { api } from './api';
import { Failure, Notice, PageIntro, sessionQuery } from './shared';
import { ProfileEditor } from './music-editor';
export function MyPage() {
  const session = useQuery(sessionQuery);
  return <><PageIntro eyebrow="MY QGROUP" title="我的群聚">一個帳號，連起參與的活動與喜歡的音樂。</PageIntro>{session.error ? <Failure error={session.error} retry={() => void session.refetch()} /> : session.isPending ? <Notice>正在確認帳號…</Notice> : <Surface className="detail"><Heading level={2}>{session.data.authenticated ? session.data.nickname : '歡迎來到群聚'}</Heading><Text>{session.data.authenticated ? '目前裝置已登入。' : '你可以先瀏覽公開活動與音樂詞庫。此開發批次尚未接入 QQ 登入。'}</Text><Link className="text-link" to="/me/music">我的音樂成分 →</Link></Surface>}</>;
}
export function MyMusic() {
  const session = useQuery(sessionQuery);
  if (session.isPending) return <Notice>正在確認帳號…</Notice>;
  if (session.error) return <Failure error={session.error} retry={() => void session.refetch()} />;
  if (!session.data.authenticated) return <><PageIntro eyebrow="MY MUSIC" title="我的音樂成分">用同一個帳號保存，讓每次相聚都能找到共鳴。</PageIntro><Surface><EmptyState title="先登入，再保存你的喜歡" description="QQ 登入正在重建中；此預覽不會替你建立臨時帳號。" action={<Link to="/music">先逛逛音樂詞庫 →</Link>} /></Surface></>;
  return <ProfileLoader key={session.data.scope} viewer={session.data} />;
}
function ProfileLoader({ viewer }: { viewer: Extract<Viewer, { authenticated: true }> }) {
  const profile = useQuery({ queryKey: ['private', viewer.scope, 'music'], queryFn: () => api('/me/music', Profile, { headers: { 'X-Account-Scope': viewer.scope } }) });
  const catalog = useQuery({ queryKey: ['catalog'], queryFn: () => api('/music/entries', Catalog) });
  if (profile.isPending || catalog.isPending) return <Notice>正在讀取你的成分…</Notice>;
  if (profile.error || catalog.error) return <Failure error={(profile.error ?? catalog.error)!} retry={() => { void profile.refetch(); void catalog.refetch(); }} />;
  return <ProfileEditor viewer={viewer} initial={profile.data} entries={catalog.data.entries} />;
}
