import { uiText } from './language';
import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Profile, type Viewer } from '@qgroup/contracts';
import { loginLink } from './auth';
import { api } from './api';
import { Failure, Notice, useSession } from './shared';
export type Member = Extract<Viewer, { authenticated: true }>;
export function MemberAccess({ children }: { children: (viewer: Member) => ReactNode }) {
  const session = useSession(); const location = useLocation();
  if (session.isPending) return <Notice>正在確認帳號…</Notice>;
  if (session.error) return <Failure error={session.error} retry={() => void session.refetch()} />;
  if (!session.data.authenticated) return <Notice>請先<Link to={loginLink(location.pathname + location.search)}>登入</Link>。</Notice>;
  return children(session.data);
}
export function MusicMemberAccess({ children, purpose = uiText('查看同好成分') }: { children: (viewer: Member) => ReactNode; purpose?: string }) {
  return <MemberAccess>{viewer => <MusicGate key={viewer.scope + ':' + viewer.musicEpoch} viewer={viewer} purpose={purpose}>{children}</MusicGate>}</MemberAccess>;
}
function MusicGate({ viewer, children, purpose }: { viewer: Member; children: (viewer: Member) => ReactNode; purpose: string }) {
  const profile = useQuery({ queryKey: ['private', viewer.scope, 'music', viewer.musicEpoch], queryFn: () => api('/me/music', Profile, { headers: { 'X-Account-Scope': viewer.scope } }) });
  if (profile.isPending) return <Notice>正在確認成分…</Notice>;
  if (profile.error) return <Failure error={profile.error} retry={() => void profile.refetch()} />;
  if (!profile.data) return <Notice>請先<Link to="/me/music">保存成分</Link>，再{purpose}。</Notice>;
  return children(viewer);
}
