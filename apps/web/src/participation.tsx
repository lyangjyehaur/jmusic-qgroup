import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { ParticipationQuery, type ParticipationRecords } from '@qgroup/contracts';
import type { z } from 'zod';
import { PageHeader, Field, Select, Tabs, Button, IconButton, Badge, Modal } from './kimi-ui';
import { ActivityBrowseTabs } from './activity-browse-tabs';
import { OverviewStats } from './overview-stats';
import { Failure, Notice, useSession } from './shared';
import { scopedHttp } from './http';
import { activityCategoryLabel } from './activity-categories';
import { activityDisplayDate } from './activity-summary';
import { displayLocale, uiText } from './language';
import { QQAvatar } from './qq-profile';

function date(value: string | null, timezone: string | null) {
  if (!value) return '—';
  try { return new Intl.DateTimeFormat(displayLocale(), { year: 'numeric', month: 'numeric', day: 'numeric', timeZone: timezone ?? 'UTC' }).format(new Date(value)); }
  catch { return value; }
}
function periodLabel(value: string) {
  if (value === 'all') return uiText('全部期間');
  const [year, month] = value.split('-');
  return month ? year + uiText(' 年 ') + Number(month) + uiText(' 月') : year + uiText(' 年');
}
export function ParticipationPage({ mine = false }: { mine?: boolean }) {
  const session = useSession(), viewer = session.data, [params, setParams] = useSearchParams(), navigate = useNavigate();
  const parsed = ParticipationQuery.safeParse({ period: params.get('period') ?? 'all', category: params.get('category') ?? 'all', page: params.get('page') ?? '1' });
  const query = parsed.success ? parsed.data : null, member = mine ? '' : params.get('member') ?? '';
  const detailParsed = ParticipationQuery.safeParse({ period: query?.period, category: query?.category, page: params.get('recordPage') ?? '1' });
  const overview = useQuery({ queryKey: ['private', viewer?.scope, 'participation', query], enabled: !!viewer && !!query && !mine, refetchOnMount: 'always', refetchInterval: 30000,
    queryFn: () => scopedHttp(viewer!.scope).requestContract('GET /api/v2/activities/participation', { query: query! }) });
  const personal = useQuery({ queryKey: ['private', viewer?.scope, 'my-participation', query], enabled: !!viewer?.authenticated && !!query && mine, refetchOnMount: 'always', refetchInterval: 30000,
    queryFn: () => scopedHttp(viewer!.scope).requestContract('GET /api/v2/me/participation', { query: query! }) });
  const detail = useQuery({ queryKey: ['private', viewer?.scope, 'participation-records', member, detailParsed.success ? detailParsed.data : null], enabled: !!viewer && !!member && detailParsed.success && !!query, refetchOnMount: 'always', refetchInterval: 30000,
    queryFn: () => scopedHttp(viewer!.scope).requestContract('GET /api/v2/activities/participation/members/:id', { params: { id: member }, query: detailParsed.success ? detailParsed.data : {} }) });
  const data = mine ? personal.data : overview.data;
  const activeError = mine ? personal.error : overview.error;
  function change(patch: Record<string, string>) {
    const next = new URLSearchParams(params); next.delete('recordPage');
    if ('period' in patch || 'category' in patch) next.delete('page');
    for (const [key, value] of Object.entries(patch)) value ? next.set(key, value) : next.delete(key);
    setParams(next);
  }
  function scope(value: string) {
    const next = new URLSearchParams(params); next.delete('member'); next.delete('page'); next.delete('recordPage');
    navigate((value === 'mine' ? '/me/participation' : '/activities/participation') + (next.size ? '?' + next : ''));
  }
  const periodValues = [...new Set(['all', ...(query && query.period !== 'all' ? [query.period] : []), ...(data?.periods ?? [])])];
  const categories = [...new Set([...(data?.categories ?? []), ...(query && query.category !== 'all' ? [query.category] : [])])];
  return <div className="kimi page participation-page">
    <PageHeader title="參與統計" />
    <ActivityBrowseTabs value="stats" />
    <div className="participation-controls"><Tabs label="統計範圍" value={mine ? 'mine' : 'all'} onChange={scope} items={[{ value: 'all', label: uiText('整體') }, { value: 'mine', label: uiText('我的') }]} />
      <div className="participation-filters"><Field label="期間"><Select id="participation-period" value={query?.period ?? 'all'} onChange={event => change({ period: event.target.value })}>{periodValues.map(value => <option key={value} value={value}>{periodLabel(value)}</option>)}</Select></Field>
        <Field label="活動類型"><Select id="participation-category" value={query?.category ?? 'all'} onChange={event => change({ category: event.target.value })}><option value="all">全部類型</option>{categories.map(value => <option key={value} value={value}>{activityCategoryLabel(value)}</option>)}</Select></Field></div>
    </div>
    {data && activeError && <Failure error={activeError} retry={() => void (mine ? personal.refetch() : overview.refetch())} />}
    {!parsed.success ? <Notice>統計篩選條件無效，請重新選擇。</Notice> : session.error ? <Failure error={session.error} retry={() => void session.refetch()} /> : mine && viewer && !viewer.authenticated ? <Notice>請先<Link to="/login?returnTo=%2Fme%2Fparticipation">登入</Link>，再查看本人參加紀錄。</Notice> : !data ? (mine ? personal.error : overview.error) ? <Failure error={(mine ? personal.error : overview.error)!} retry={() => void (mine ? personal.refetch() : overview.refetch())} /> : <Notice>正在讀取參與統計…</Notice> : mine && personal.data ? <>
      <OverviewStats label="我的參與摘要" items={[{ label: uiText('參加次數'), value: personal.data.count }, { label: uiText('最近參加'), value: date(personal.data.lastParticipatedAt, personal.data.timezone) }]} />
      <ParticipationRecordList data={personal.data} title="我的參加紀錄" onPage={page => change({ page: String(page) })} />
    </> : overview.data && <>
      <OverviewStats label="整體參與摘要" items={[{ label: uiText('納入活動'), value: overview.data.activityCount }, { label: uiText('參加人次'), value: overview.data.participationCount }, { label: uiText('參加者'), value: overview.data.memberCount }]} />
      <section aria-label="參加者次數"><div className="section-title-row"><h2>參加者次數</h2></div>
        {overview.data.members.length ? <div className="table-scroll"><table className="data-table participation-table"><thead><tr><th className="participation-number">序號</th><th>參加者</th><th className="participation-count">參加次數</th><th className="participation-date-column">最近參加</th><th className="participation-action"><span className="sr-only">操作</span></th></tr></thead><tbody>{overview.data.members.map((person, index) => <tr key={person.id}><td className="participation-number">{(overview.data.page - 1) * 20 + index + 1}</td><td><div className="participation-person"><QQAvatar url={person.avatarUrl} nickname={person.name} /><div><span className="participation-name">{person.name || uiText('未設定稱呼')}</span><span className="participation-mobile-date">{uiText('最近參加：')}<time dateTime={person.lastParticipatedAt ?? undefined}>{date(person.lastParticipatedAt, person.timezone)}</time></span></div></div></td><td className="participation-count">{person.count}</td><td className="participation-date-column">{date(person.lastParticipatedAt, person.timezone)}</td><td className="participation-action"><IconButton className="participation-record-trigger" label={'查看' + person.name + '的參加紀錄'} aria-haspopup="dialog" onClick={() => change({ member: person.id })}><ChevronRight size={18} aria-hidden="true" /></IconButton></td></tr>)}</tbody></table></div> : <Notice>{overview.data.activityCount ? '這個期間沒有已認領的參加紀錄。' : '這個期間沒有符合條件的已結束活動。'}</Notice>}
        {overview.data.unclaimedCount > 0 && <p className="participation-rule">另有 {overview.data.unclaimedCount} 人次尚未認領，已列入總人次。</p>}
        <Pagination page={overview.data.page} hasMore={overview.data.hasMore} onPage={page => change({ page: String(page) })} />
      </section>
      {member && <Modal title="參加紀錄" closeLabel="關閉參加紀錄" onClose={() => change({ member: '' })}><div className="participation-selected">{!detailParsed.success ? <Notice>紀錄頁碼無效，請重新選擇。</Notice> : detail.isPending ? <Notice>正在讀取參加紀錄…</Notice> : detail.error ? <Failure error={detail.error} retry={() => void detail.refetch()} /> : <ParticipationRecordList data={detail.data} title={detail.data.name + '的參加紀錄'} onPage={page => { const next = new URLSearchParams(params); next.set('recordPage', String(page)); setParams(next); }} />}</div></Modal>}
    </>}
  </div>;
}
function Pagination({ page, hasMore, onPage }: { page: number; hasMore: boolean; onPage: (page: number) => void }) {
  return page > 1 || hasMore ? <div className="pagination"><Button variant="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>上一頁</Button><span>第 {page} 頁</span><Button variant="secondary" disabled={!hasMore} onClick={() => onPage(page + 1)}>下一頁</Button></div> : null;
}
function ParticipationRecordList({ data, title, onPage }: { data: z.infer<typeof ParticipationRecords>; title: string; onPage: (page: number) => void }) {
  const location = useLocation();
  const source = new URLSearchParams({ from: location.pathname + location.search });
  return <section aria-label={title}><div className="section-title-row"><h2>{title}</h2><span>{data.count} 次</span></div>{data.records.length ? <ul className="participation-record-list">{data.records.map(event => <li key={event.id}><div><Link className="participation-event-title" to={'/activities/' + encodeURIComponent(event.id) + '?' + source}>{event.title}</Link><span className="participation-event-date">{activityDisplayDate(event.startsAt, event.timezone)} · {activityCategoryLabel(event.category)}</span></div><div className="participation-record-status"><Badge>{event.estimatedOver ? '已過預定時間' : '已結束'}</Badge>{event.archived && <Badge>已歸檔</Badge>}{event.visibility === 'invitation' && <Badge>私人活動</Badge>}</div></li>)}</ul> : <Notice>這個期間沒有符合條件的參加紀錄。</Notice>}<Pagination page={data.page} hasMore={data.hasMore} onPage={onPage} /></section>;
}
