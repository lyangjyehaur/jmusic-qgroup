import { Link, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { EmptyState, Surface } from 'yahha-ui';
import { Failure, Notice, PageIntro, sessionQuery } from './shared';
import { KimiProfileEditor as ProfileEditor } from './kimi-music-editor';
import { useMusicWorkspace } from './music-selection';
import { loginLink } from './auth';
export { KimiMePage as MyPage } from './kimi-me';
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
