import { useEffect, useRef } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ThemeProvider } from 'yahha-ui';
import { sessionQuery } from './shared';
export function Layout() {
  const session = useQuery(sessionQuery);
  const location = useLocation();
  const heading = useRef<HTMLElement>(null);
  const queryClient = useQueryClient();
  const previousScope = useRef<string | undefined>(undefined);
  const scope = session.data?.authenticated ? session.data.scope : 'guest';
  useEffect(() => {
    if (previousScope.current && previousScope.current !== scope) queryClient.removeQueries({ queryKey: ['private'] });
    previousScope.current = scope;
  }, [scope, queryClient]);
  useEffect(() => { heading.current?.focus(); }, [location.pathname]);
  return <ThemeProvider theme="blue"><a className="skip" href="#main">跳至主要內容</a>
    <header className="header"><Link to="/" className="brand" aria-label="群聚首頁"><span className="brand-mark" aria-hidden="true">聚</span><span>群聚<small>一起聽，一起見面</small></span></Link>
      <nav aria-label="主要導覽">{[['/activities', '活動'], ['/music', '音樂'], ['/people', '同好'], ['/me', '我的']].map(([to, label]) => <NavLink key={to} to={to!}>{label}</NavLink>)}</nav>
      <span className="viewer">{session.data?.authenticated ? session.data.nickname : '訪客'}</span>
    </header>
    <main id="main" ref={heading} tabIndex={-1} className="main"><div className="preview">重構開發預覽 · 功能逐步建置中</div><Outlet /></main>
    <footer>群聚 <span>讓共同的喜歡，變成下一次相聚。</span></footer>
  </ThemeProvider>;
}
