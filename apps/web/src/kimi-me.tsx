// The prototype's profile, activity rows and settings now share a single navigation hierarchy.
import type { ReactNode } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Bell, ChevronRight, KeyRound, MapPin, Music2, Palette, QrCode, Smartphone, ShieldCheck, UserRound, Monitor } from 'lucide-react';
import { Avatar, PageHeader, Tabs, Badge } from './kimi-ui';
import { ActionLink } from './action-link';
import { EmbeddedPageContext, Failure, Notice, useSession } from './shared';
import { scopedHttp } from './http';
import { listedActivityStatus } from './kimi-activities';
import { activityDisplayDate, activityDisplayTimeParts } from './activity-summary';
import { uiText, displayLocale } from './language';
import { MusicQQPrompt } from './music-qq-prompt';
import { ParticipationSummary } from './participation-summary';
import './kimi/me.css';

const settingGroups = [
  { title: '帳號與資料', items: [
    { to: '/me/accounts', label: '帳號與 QQ 綁定', icon: KeyRound },
    { to: '/me/profile', label: '站內稱呼', icon: UserRound },
    { to: '/me/devices', label: '登入裝置', icon: Smartphone },
    { to: '/me/payment-codes', label: '我的收款碼', icon: QrCode },
  ] },
  { title: '偏好與隱私', items: [
    { to: '/me/appearance', label: '外觀', icon: Palette },
    { to: '/me/app', label: '應用程式', icon: Monitor },
    { to: '/me/privacy', label: '資料與隱私', icon: ShieldCheck },
  ] },
] as const;

function SettingsLinks({ compact = false }: { compact?: boolean }) {
  const { pathname } = useLocation();
  return <nav className={compact ? 'me-settings-nav' : 'me-settings-groups'} aria-label="我的設定">
    {settingGroups.map(group => <section className="me-section" key={group.title}>
      <h2>{group.title}</h2>
      <div className="me-link-list">{group.items.map(({ to, label, icon: Icon }) =>
        <Link key={to} to={to} aria-current={pathname === to || pathname.startsWith(to + '/') ? 'page' : undefined}>
          <Icon size={18} aria-hidden="true"/><span>{label}</span><ChevronRight size={16} aria-hidden="true"/>
        </Link>)}</div>
    </section>)}
  </nav>;
}

export function KimiMePage({ activeTab, panel }: { activeTab?: string; panel?: ReactNode } = {}) {
  const session = useSession(), viewer = session.data, [params, setParams] = useSearchParams(), navigate = useNavigate();
  const requestedTab = activeTab ?? params.get('tab') ?? 'overview';
  // Keep old query URLs usable while presenting one settings destination.
  const tab = ['settings', 'account', 'privacy', 'danger'].includes(requestedTab) ? 'settings' : requestedTab === 'drafts' ? 'drafts' : 'overview';
  const overview = !panel && tab === 'overview', authenticated = !!viewer?.authenticated;
  const activities = useQuery({ queryKey: ['private', viewer?.scope, 'my-activities', 1], refetchOnMount: 'always', refetchInterval: 30000, enabled: authenticated && overview,
    queryFn: ({ signal }) => scopedHttp(viewer!.scope).requestContract('GET /api/v2/me/activities', { signal }) });
  const profile = useQuery({ queryKey: ['private', viewer?.scope, 'music', viewer?.authenticated ? viewer.musicEpoch : undefined], enabled: authenticated && overview,
    queryFn: ({ signal }) => scopedHttp(viewer!.scope).requestContract('GET /api/v2/me/music', { signal }) });
  const contact = useQuery({ queryKey: ['private', viewer?.scope, 'music-contact', viewer?.authenticated ? viewer.musicEpoch : undefined], enabled: authenticated && overview && !!profile.data,
    queryFn: ({ signal }) => scopedHttp(viewer!.scope).requestContract('GET /api/v2/me/music/contact', { signal }), refetchOnMount: 'always' });
  const drafts = useQuery({ queryKey: ['private', viewer?.scope, 'activity-drafts', 1], refetchOnMount: 'always', enabled: authenticated && !panel && tab !== 'settings',
    queryFn: ({ signal }) => scopedHttp(viewer!.scope).requestContract('GET /api/v2/me/activity-drafts', { signal }) });
  const nickname = authenticated ? viewer!.nickname : uiText('尚未登入');
  const currentActivities = activities.data?.events.filter(event => event.lifecycle !== 'draft' && !['archived', 'ended', 'unformed', 'cancelled'].includes(listedActivityStatus(event))) ?? [];
  const draftCount = drafts.data ? (drafts.data.hasMore ? '20+' : drafts.data.drafts.length) : '—';
  const musicCount = profile.isSuccess ? profile.data?.selections.length ?? 0 : '—';
  const switchTab = (value: string) => {
    if (panel) navigate(value === 'overview' ? '/me' : '/me?tab=' + value);
    else setParams(value === 'overview' ? {} : { tab: value });
  };

  return <div className={'kimi page me-page' + (panel ? ' me-detail-page' : '')}>
    <PageHeader title="我的" actions={overview && authenticated ? <ActionLink variant="primary" to="/me/music" startIcon={<Music2 size={16}/>}>編輯我的成分</ActionLink> : undefined}/>
    {session.isPending ? <Notice>正在確認帳號…</Notice> : session.error ? <Failure error={session.error} retry={() => void session.refetch()}/> : <>
      {overview && <section className="profile-banner me-profile" aria-label="我的資料">
        <div className="me-identity"><Avatar user={{ name: nickname, avatar: nickname.slice(0, 1), color: 'var(--moss)', avatarUrl: authenticated ? viewer!.qq.avatarUrl : undefined }} size="xl"/>
          <div className="me-identity-copy"><h2>{nickname}</h2>{authenticated && contact.data?.contactQQ && <span>QQ {contact.data.contactQQ}</span>}{!authenticated && <p>登入後可管理成分、活動與帳號。</p>}</div>
          {authenticated ? <Link className="me-profile-edit" to="/me/profile">修改稱呼<ChevronRight size={14} aria-hidden="true"/></Link> : <ActionLink variant="primary" to="/login?returnTo=%2Fme">登入</ActionLink>}
        </div>
        {authenticated && <><div className="profile-numbers" aria-label="我的資料概覽">
          <Link to="/me/music"><strong>{musicCount}</strong><span>音樂成分</span></Link>
          <Link to="/me/activities"><strong>{activities.data?.total ?? '—'}</strong><span>我的活動</span></Link>
          <Link to="/me?tab=drafts"><strong>{draftCount}</strong><span>活動草稿</span></Link>
        </div>{profile.error && <Failure error={profile.error} retry={() => void profile.refetch()}/>}<MusicQQPrompt viewer={viewer!}/></>}
      </section>}
      <div className="me-tabs"><Tabs label="我的功能" value={tab} onChange={switchTab} items={[
        { value: 'overview', label: uiText('總覽') }, { value: 'drafts', label: uiText('活動草稿') }, { value: 'settings', label: uiText('設定') },
      ]}/></div>
      {panel ? <div className="me-settings-layout"><SettingsLinks compact/><div className="me-settings-content">
        <Link className="me-settings-back" to="/me?tab=settings"><ArrowLeft size={16} aria-hidden="true"/>全部設定</Link>
        <EmbeddedPageContext.Provider value><section className="me-settings-panel">{panel}</section></EmbeddedPageContext.Provider>
      </div></div> : tab === 'settings' ? <SettingsLinks/> : tab === 'drafts' ? <section className="me-section me-drafts" aria-label="活動草稿">
        <div className="section-title-row"><h2>活動草稿</h2><ActionLink to="/activities/new">新增活動</ActionLink></div>
        {!authenticated ? <Notice>請先登入，再查看活動草稿。</Notice> : drafts.isPending ? <Notice>正在讀取活動草稿…</Notice> : drafts.error ? <Failure error={drafts.error} retry={() => void drafts.refetch()}/> : drafts.data!.drafts.length ? <>
          <div className="me-draft-list">{drafts.data!.drafts.map(draft => <article className="draft-row" key={draft.id}>
            <div><Badge>草稿</Badge><h3>{draft.title}</h3><p>{activityDisplayDate(draft.startsAt, Intl.DateTimeFormat().resolvedOptions().timeZone)}</p></div>
            {draft.canEdit ? <ActionLink size="sm" to={'/activities/' + draft.id + '/edit'}>繼續編輯</ActionLink> : <Link className="text-link" to={'/activities/' + draft.id}>查看活動</Link>}
          </article>)}</div>{drafts.data!.hasMore && <Link className="me-all-drafts" to="/me/activities/drafts">查看全部草稿<ChevronRight size={16} aria-hidden="true"/></Link>}
        </> : <Notice>目前沒有活動草稿。</Notice>}
      </section> : <div className="me-overview-grid">
        {authenticated && <section className="me-section me-main" aria-label="我的近期活動"><div className="section-title-row"><h2>我的近期活動</h2><Link className="text-link" to="/me/activities">全部活動<ChevronRight size={14} aria-hidden="true"/></Link></div>
          {activities.isPending ? <Notice>正在讀取活動…</Notice> : activities.error ? <Failure error={activities.error} retry={() => void activities.refetch()}/> : currentActivities.length ? <div className="me-activity-list">
            {currentActivities.slice(0, 4).map(event => {
              const time = activityDisplayTimeParts(event, 'compact');
              return <Link to={'/activities/' + event.id} key={event.id}>
                <span className="me-activity-date">{shortDate(event.startsAt, event.timezone)}</span>
                <span className="me-activity-copy"><strong>{event.title}</strong><small>{time.startClock ? time.startClock + '–' + time.endText : time.date}</small>{event.location && <small className="me-activity-location"><MapPin size={12} aria-hidden="true"/>{event.location}</small>}</span>
                <Badge tone={event.myRegistration === 'confirmed' ? 'green' : 'neutral'}>{event.myRegistration ? ({ confirmed: uiText('正式'), waiting: uiText('候補'), tentative: uiText('待確認') }[event.myRegistration]) : ({ open: uiText('報名中'), full: uiText('已額滿'), paused: uiText('未開放報名'), ongoing: uiText('進行中') }[listedActivityStatus(event)] ?? event.phase)}</Badge>
                <ChevronRight size={16} aria-hidden="true"/>
              </Link>;
            })}
          </div> : <Notice>目前沒有與你相關的近期活動。</Notice>}
        </section>}
        <div className="me-overview-side">{authenticated && <ParticipationSummary scope={viewer!.scope}/>}
          <section className="me-section me-shortcuts"><div className="section-title-row"><h2>常用功能</h2><Link className="text-link" to="/me?tab=settings">全部設定<ChevronRight size={14} aria-hidden="true"/></Link></div>
            <div className="me-link-list"><Link to="/me/payment-codes"><QrCode size={18} aria-hidden="true"/><span>我的收款碼</span><ChevronRight size={16} aria-hidden="true"/></Link><Link aria-label="帳號" to="/me/accounts"><KeyRound size={18} aria-hidden="true"/><span>帳號與 QQ 綁定</span><ChevronRight size={16} aria-hidden="true"/></Link><Link to="/inbox"><Bell size={18} aria-hidden="true"/><span>收件匣</span><ChevronRight size={16} aria-hidden="true"/></Link></div>
          </section>
        </div>
      </div>}
    </>}
  </div>;
}

function shortDate(value: string, timezone: string | null) {
  try { return new Intl.DateTimeFormat(displayLocale(), { month: 'numeric', day: 'numeric', timeZone: timezone ?? 'UTC' }).format(new Date(value)); }
  catch { return '—'; }
}
