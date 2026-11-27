import { PWAUpdateNotice } from './pwa';
import { useEffect, useRef } from 'react';
import { Link, NavLink, useLocation, useNavigate, useOutlet } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { WallpaperLayer, appearanceQuery } from './appearance';
import { Notice, sessionQuery } from './shared';
import { observeAccountChange } from './account-session';
import { InboxLink } from './inbox';
import { QQReauthReminder } from './qq-profile';
import { analyticsPage, startAnalytics } from './analytics';
import { uiText } from './language';
import { searchReturn } from './search-return';
import { PageTools } from './page-tools';
import { ChevronDown, Command, Search } from 'lucide-react';
import { KimiMePage } from './kimi-me';
import { KimiMusicFrame, KimiPeopleFrame } from './kimi-page-frames';
import { Avatar, PopupMenu } from './kimi-ui';
import { AppearanceControls } from './appearance-controls';
import { BrandMark, InterfaceIcon } from './interface-icons';
import { discoveryDialogKind, RetainedPage } from './discovery-dialog';
const navItems = [['/activities', uiText('活動'), 'activities'], ['/music', uiText('音樂'), 'music'], ['/people', uiText('同好'), 'people'], ['/me', uiText('我的'), 'me']] as const;
export function Layout() {
  const session = useQuery(sessionQuery);
  const appearance = useQuery(appearanceQuery);
  const siteTitle = appearance.data?.siteTitle ?? '群聚';
  useEffect(() => { document.title = siteTitle; }, [siteTitle]);
  const location = useLocation();
  const navigate = useNavigate();
  const shell = useRef<HTMLDivElement>(null);
  const searchURL = '/search';
  const searchState = { discoveryReturn: location.pathname + location.search + location.hash };
  const rawOutlet=useOutlet();
  const mePanel=/^\/me\/(?:accounts|devices|profile|payment-codes|appearance|privacy|app)(?:\/|$)/.test(location.pathname);
  const musicPanel=/^\/me\/music\/(?:details|contact|recover|entries)(?:\/|$)/.test(location.pathname);
  const peoplePanel=/^\/people\/(?:circles|shouts)(?:\/|$)/.test(location.pathname);
  const outlet=mePanel?<KimiMePage activeTab={location.pathname.startsWith('/me/appearance')?'privacy':location.pathname.startsWith('/me/privacy')?'danger':'account'} panel={rawOutlet}/>:musicPanel?<KimiMusicFrame tab={location.pathname.startsWith('/me/music/entries')?'terms':'profile'}>{rawOutlet}</KimiMusicFrame>:peoplePanel?<KimiPeopleFrame tab={location.pathname.startsWith('/people/circles')?'circles':'partners'}>{rawOutlet}</KimiPeopleFrame>:rawOutlet, overlay = !!discoveryDialogKind(location);
  const background = useRef<{ location: typeof location; content: ReactNode } | null>(null);
  const discoveryPage = location.pathname === '/music' || location.pathname === '/music/trends' || /^\/music\/entries\/[^/]+$/.test(location.pathname) || ['/people','/me/music','/me/music/share','/search'].includes(location.pathname) || /^\/people\/m_[a-f0-9]{24,40}(?:\/compare)?$/.test(location.pathname);
  const retainable = ['/', '/activities', '/me', '/me/activities', '/admin', '/time-polls'].includes(location.pathname) || /^\/activities\/(?!new$)[^/]+$/.test(location.pathname);
  if (!overlay) background.current = !discoveryPage && retainable ? { location, content: outlet } : null;
  const searchBack = searchReturn(new URLSearchParams(location.search).get('from'));
  useEffect(() => startAnalytics(), []);
  useEffect(() => { analyticsPage(location.pathname); }, [location.pathname]);
  const heading = useRef<HTMLElement>(null);
  const queryClient = useQueryClient();
  const previousScope = useRef<string | undefined>(undefined);
  const scope = session.data?.scope;
  useEffect(() => observeAccountChange(() => {
    void queryClient.invalidateQueries({ queryKey: ['music-catalog'] });
    void queryClient.invalidateQueries({ queryKey: ['music-trend'] });
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
  useEffect(() => { if (!overlay && !document.querySelector('[role="dialog"],dialog[open]')) heading.current?.focus(); }, [location.pathname, overlay]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const target = event.target as HTMLElement;
      if (target.closest('[role="dialog"]')) return;
      const commandSearch = (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k';
      if (!commandSearch && target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]')) return;
      if (commandSearch || event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault(); void navigate(searchURL, { state: searchState });
      }
    };
    window.addEventListener('keydown', shortcut); return () => window.removeEventListener('keydown', shortcut);
  }, [navigate, location.pathname, location.search, location.hash]);
  const nickname = session.data?.authenticated ? session.data.nickname : uiText('訪客');
  const navigation = navItems.map(([to, label, icon]) => <NavLink key={to} to={to} className={({ isActive }) => 'nav-item' + (isActive || to === '/activities' && (location.pathname === '/' || location.pathname.startsWith('/time-polls')) ? ' active' : '')}><InterfaceIcon name={icon}/><span>{label}</span></NavLink>);
  return <div className="app-shell kimi-shell" ref={shell}><WallpaperLayer/><a className="skip" href="#main">跳至主要內容</a>
    <aside className="sidebar"><Link to="/activities" className="brand" aria-label={siteTitle+uiText('首頁')} title={siteTitle}><BrandMark/><span>{siteTitle}</span></Link>
      <nav className="side-nav" aria-label="主要導覽">{navigation}</nav>
      <div className="sidebar-bottom"><Link className="sidebar-account" to="/me"><Avatar user={{name:nickname,avatar:nickname.slice(0,1),color:"var(--moss)",avatarUrl:session.data?.authenticated?session.data.qq.avatarUrl:undefined}} size="sm"/><span><strong>{nickname}</strong><small>{session.data?.authenticated ? '帳號與設定' : '登入或註冊'}</small></span></Link></div>
    </aside>
    <div className="main-column"><header className="topbar">
      <Link to="/activities" className="mobile-brand" aria-label={siteTitle+uiText('首頁')} title={siteTitle}><BrandMark/><span>{siteTitle}</span></Link>
      <Link className="global-search global-search-link" to={searchURL} state={searchState} aria-label="全站搜尋"><Search size={16} aria-hidden="true"/><span>搜尋活動、詞條或同好</span><kbd><Command size={11}/> K</kbd></Link>
      <div className="topbar-actions">
        <PopupMenu className="shell-menu appearance-menu" label="外觀設定" title={<><InterfaceIcon name="palette"/><span>外觀</span></>}><div className="shell-popover"><AppearanceControls quick/></div></PopupMenu>
        <InboxLink key={session.data?.scope??'guest'} viewer={session.data?.authenticated?session.data:undefined}/>
        <PopupMenu className="shell-menu account-menu" label="帳號選單" heading={nickname} title={<><Avatar user={{name:nickname,avatar:nickname.slice(0,1),color:"var(--moss)",avatarUrl:session.data?.authenticated?session.data.qq.avatarUrl:undefined}} size="sm"/><span className="viewer">{nickname}</span><ChevronDown size={14}/></>}><div className="shell-popover"><Link to="/me">帳號與設定</Link><Link to="/me/music">編輯我的成分</Link></div></PopupMenu>
      </div>
    </header>
    <main id="main" ref={heading} tabIndex={-1} className="main"><PWAUpdateNotice/>{typeof location.state?.accountMessage === 'string' && <Notice>{location.state.accountMessage}</Notice>}{session.data?.authenticated && ['/', '/activities', '/me'].includes(location.pathname) && !location.search && !location.hash && <QQReauthReminder key={session.data.scope} viewer={session.data} returnTo={location.pathname} />}{searchBack && !overlay && <Link className="back" to={searchBack}>← 回到搜尋</Link>}{!discoveryPage && !overlay ? <RetainedPage location={location}>{outlet}</RetainedPage> : overlay && background.current && <RetainedPage location={background.current.location} inactive>{background.current.content}</RetainedPage>}{discoveryPage && outlet}</main>
    </div><nav className="mobile-dock" aria-label="手機主要導覽">{navItems.map(([to,label,icon])=><NavLink key={to} to={to} className={({isActive})=>'dock-item'+(isActive||to==='/activities'&&location.pathname.startsWith('/time-polls')?' active':'')}><InterfaceIcon name={icon} size={21}/><span>{label}</span></NavLink>)}</nav><PageTools />
  </div>;
}
