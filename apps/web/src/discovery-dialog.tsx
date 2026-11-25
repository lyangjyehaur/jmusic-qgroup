import { uiText } from './language';
import { KimiMusicFrame } from './kimi-page-frames';
import { createContext, useContext, useRef, useState, type ReactNode } from 'react';
import { UNSAFE_LocationContext, useLocation, useNavigate, useOutlet, type Location } from 'react-router-dom';
import { Dialog } from 'yahha-ui';
import { Link } from 'react-router-dom';
import { searchReturn } from './search-return';
import { DiscoveryDetailsContext, type DiscoveryDetails } from './discovery-details';
import { Button } from './kimi-ui';
import { ActionLink } from './action-link';
import { GitCompareArrows, ListMusic } from 'lucide-react';

export const DialogPageContext = createContext(false);
export const InactivePageContext = createContext(false);
export function discoveryDialogKind(location: Pick<Location, 'pathname'>) {
  if (location.pathname === '/search') return uiText('全站搜尋');
  if (/^\/music\/entries\/[^/]+$/.test(location.pathname)) return uiText('詞條資料');
  if (/^\/people\/m_[a-f0-9]{24,40}$/.test(location.pathname)) return uiText('同好成分');
  return null;
}
export function localDiscoveryReturn(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\/(?!\/)/.test(value) || /[\\\u0000-\u001f]/.test(value)) return null;
  const url = new URL(value, 'https://local.invalid');
  return url.origin === 'https://local.invalid' && url.pathname + url.search + url.hash === value ? value : null;
}
export function RetainedPage({ location, children, inactive = false }: { location: Location; children: ReactNode; inactive?: boolean }) {
  const context = useContext(UNSAFE_LocationContext);
  const ownsPage=['/activities','/time-polls','/music','/me','/me/music','/me/music/share','/me/activities','/people','/admin','/inbox'].includes(location.pathname)||/^\/time-polls\/[^/]+(?:\/manage)?$/.test(location.pathname)||location.pathname.startsWith('/activities/')||location.pathname.startsWith('/me/music/')||location.pathname==='/music/trends'||/^\/people\/(?:circles|shouts)(?:\/|$)/.test(location.pathname)||/^\/me\/(?:accounts|devices|profile|payment-codes|appearance|privacy|app)(?:\/|$)/.test(location.pathname);
  return <UNSAFE_LocationContext.Provider value={{ ...context, location }}><InactivePageContext.Provider value={inactive}><div className="retained-page" inert={inactive || undefined} aria-hidden={inactive || undefined}>{ownsPage?children:<div className="kimi page retained-business">{children}</div>}</div></InactivePageContext.Provider></UNSAFE_LocationContext.Provider>;
}

/** Share one selection controller between the retained page and its route dialogs. */
export function DiscoveryLayer({ feedback, selectionActions }: { feedback?: ReactNode; selectionActions?: ReactNode } = {}) {
  const location = useLocation(), outlet = useOutlet(), navigate = useNavigate();
  const [details,setDetails]=useState<DiscoveryDetails|null>(null);
  const detailsKey=location.key+':'+location.pathname;
  const background = useRef<{ location: Location; content: ReactNode } | null>(null);
  const searchSource = useRef<string | null>(null);
  const title = discoveryDialogKind(location), open = !!title;
  const musicTab=location.pathname==='/me/music/share'?'share':location.pathname==='/music/trends'?'trends':null;
  const content=musicTab?<KimiMusicFrame tab={musicTab}>{outlet}</KimiMusicFrame>:outlet;
  const searchBack = searchReturn(new URLSearchParams(location.search).get('from'));
  const editorParams = new URLSearchParams(location.search); editorParams.delete('entry');
  const editorPath = '/me/music' + (editorParams.size ? '?' + editorParams : '');
  if (!open) { background.current = { location, content }; searchSource.current = null; }
  const from = localDiscoveryReturn(location.state?.discoveryReturn) ?? localDiscoveryReturn(new URLSearchParams(location.search).get('from'));
  if (location.pathname === '/search' && from && !from.startsWith('/search')) searchSource.current = from;
  const back = from && from !== location.pathname + location.search + location.hash ? from : background.current ? background.current.location.pathname + background.current.location.search + background.current.location.hash : null;
  function close() {
    const destination = location.pathname === '/search' ? searchSource.current ?? back : back;
    void navigate(destination ?? (location.pathname.startsWith('/people/') ? '/people' : location.pathname === '/search' ? '/activities' : '/music'), { replace: true });
  }
  return <>
    {!open && feedback}
    {background.current && <RetainedPage location={background.current.location} inactive={open}>{background.current.content}</RetainedPage>}
    {!open && selectionActions}
    <Dialog open={open} title={details?.path===detailsKey?details.title:title??'詳細資料'} description={details?.path===detailsKey?details.description:undefined} closeLabel="返回原頁" className="discovery-dialog kimi yj-dialog yj-dialog-wide" disablePointerDismissal onOpenChange={next => { if (!next) close(); }} footer={open&&(selectionActions||location.pathname!=='/search')?<>{selectionActions}{location.pathname!=='/search'&&<><Button variant="secondary" onClick={close}>{location.pathname.startsWith('/people/')?'返回':'返回詞庫'}</Button>{location.pathname.startsWith('/people/')?<ActionLink variant="primary" to={location.pathname+'/compare'+(back?'?'+new URLSearchParams({from:back}):'')} startIcon={<GitCompareArrows size={16}/>}>比較成分</ActionLink>:<ActionLink variant="primary" to={editorPath} startIcon={<ListMusic size={16}/>}>編輯我的成分</ActionLink>}</>}</>:undefined}>
      <DiscoveryDetailsContext.Provider value={{path:detailsKey,set:setDetails}}><DialogPageContext.Provider value={true}>{open && <>{feedback}{searchBack && <Link className="back" to={searchBack}>← 回到搜尋</Link>}{outlet}</>}</DialogPageContext.Provider></DiscoveryDetailsContext.Provider>
    </Dialog>
  </>;
}
