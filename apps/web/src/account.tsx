import { Link, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { EmptyState, Heading, Surface, Text } from 'yahha-ui';
import { Failure, Notice, PageIntro, sessionQuery } from './shared';
import { ProfileEditor } from './music-editor';
import { useMusicWorkspace } from './music-selection';
import { loginLink } from './auth';
export function MyPage() {
  const session = useQuery(sessionQuery);
  return <><PageIntro title="我的" />{session.error ? <Failure error={session.error} retry={() => void session.refetch()} /> : session.isPending ? <Notice>正在確認帳號…</Notice> : <Surface className="detail"><Heading level={2}>{session.data.authenticated ? session.data.nickname : '尚未登入'}</Heading>{!session.data.authenticated && !session.data.qqEnabled && !session.data.nameRegistrationEnabled && <Text>目前沒有可用的登入方式。</Text>}<div className="page-actions"><Link to="/me/music">我的成分</Link><Link to="/me/payment-codes">我的收款碼</Link><Link to="/inbox">收件匣</Link><Link to="/admin">管理後台</Link><Link to="/me/appearance">外觀</Link><Link to="/me/app">應用程式</Link>{session.data.authenticated ? <Link to="/me/accounts">帳號</Link> : <Link to={loginLink('/me')}>登入</Link>}</div></Surface>}</>;
}
export function MyMusic() {
  const location = useLocation();
  const workspace = useMusicWorkspace();
  const session = useQuery(sessionQuery);
  if (session.isPending) return <Notice>正在確認帳號…</Notice>;
  if (session.error) return <Failure error={session.error} retry={() => void session.refetch()} />;
  if (!session.data.authenticated) return <><PageIntro title="我的成分" /><Surface><EmptyState title="登入後才能保存成分" description={session.data.qqEnabled || session.data.nameRegistrationEnabled ? undefined : '目前沒有可用的登入方式。'} action={<Link to={loginLink(location.pathname + location.search + location.hash)}>登入</Link>} /><Link to="/me/music/recover">找回舊成分</Link></Surface></>;
  if (workspace.state === 'error') return <Failure error={workspace.error} retry={workspace.retry} />;
  if (workspace.state !== 'ready') return <Notice>正在讀取你的成分…</Notice>;
  return <ProfileEditor selection={workspace.selection} />;
}
