import { useEffect, useRef } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ThemeProvider } from 'yahha-ui';
import { Notice, sessionQuery } from './shared';
import { observeAccountChange } from './account-session';
import { QQReauthReminder } from './qq-profile';
export function Layout() {
  const session = useQuery(sessionQuery);
  const location = useLocation();
  const heading = useRef<HTMLElement>(null);
  const queryClient = useQueryClient();
  const previousScope = useRef<string | undefined>(undefined);
  const scope = session.data?.scope;
  useEffect(() => observeAccountChange(() => {
    void queryClient.fetchQuery({ ...sessionQuery, staleTime: 0 }).then(next => {
      queryClient.removeQueries({ queryKey: ['private'], predicate: query => query.queryKey[1] !== next.scope });
      return queryClient.invalidateQueries({ queryKey: ['private', next.scope] });
    }).catch(() => { /* The session query displays the read failure; no authorization is assumed. */ });
  }), [queryClient]);
  useEffect(() => {
    if (!scope) return;
    if (previousScope.current && previousScope.current !== scope) queryClient.removeQueries({ queryKey: ['private', previousScope.current] });
    previousScope.current = scope;
  }, [scope, queryClient]);
  useEffect(() => { heading.current?.focus(); }, [location.pathname]);
  return <ThemeProvider theme="blue"><a className="skip" href="#main">跳至主要內容</a>
    <header className="header"><Link to="/" className="brand" aria-label="群聚首頁">群聚</Link>
      <nav aria-label="主要導覽">{[['/activities', '活動'], ['/music', '音樂'], ['/people', '同好'], ['/me', '我的']].map(([to, label]) => <NavLink key={to} to={to!}>{label}</NavLink>)}</nav>
      <span className="viewer">{session.data?.authenticated ? session.data.nickname : '訪客'}</span>
    </header>
    <main id="main" ref={heading} tabIndex={-1} className="main"><div className="preview">開發預覽</div>{typeof location.state?.accountMessage === 'string' && <Notice>{location.state.accountMessage}</Notice>}{session.data?.authenticated && ['/', '/activities', '/me'].includes(location.pathname) && !location.search && !location.hash && <QQReauthReminder key={session.data.scope} viewer={session.data} returnTo={location.pathname} />}<Outlet /></main>
  </ThemeProvider>;
}
