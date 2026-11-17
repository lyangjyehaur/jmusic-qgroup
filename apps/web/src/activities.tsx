import { Navigate, Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button, EmptyState, Heading, Surface, Text } from 'yahha-ui';
import { Activity, ActivityList, type ActivityView } from '@qgroup/contracts';
import { api } from './api';
import { Failure, Notice, PageIntro, useSession } from './shared';
import { ActivityParticipants } from './activity-roster';
import { ActivityManagementLink } from './activity-conditions';
import { ActivityLifecycleLink } from './activity-lifecycle';
const dateLabel = (value: string) => new Intl.DateTimeFormat('zh-TW', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Taipei' }).format(new Date(value));
const phaseLabel: Record<string, string> = { draft: '草稿', scheduled: '即將開始', ongoing: '進行中', ended: '已結束', cancelled: '已取消' };
function ActivityCard({ event }: { event: ActivityView }) {
  return <Surface className="event-card"><div className="event-meta"><span className="pill">{event.category}</span><span>{event.archived ? '已歸檔' : phaseLabel[event.phase] ?? event.phase}</span></div>
    <Heading level={2}><Link to={'/activities/' + encodeURIComponent(event.id)}>{event.title}</Link></Heading>
    <Text>{dateLabel(event.startsAt)} <span className="muted">台北時間</span></Text><Text tone="muted">{event.location}</Text>
    <div className="event-bottom"><span>{event.confirmed} / {event.capacity||'不限'} 人{event.waiting > 0 ? ` · ${event.waiting} 人候補` : ''}</span><Link to={'/activities/' + encodeURIComponent(event.id)}>查看活動 <span aria-hidden="true">↗</span></Link></div>
  </Surface>;
}
export function Activities() {
  const [search, setSearch] = useSearchParams();
  const period = search.get('period') === 'history' ? 'history' : 'upcoming';
  const page = Math.max(1, Math.min(10000, Number(search.get('page')) || 1));
  const query = useQuery({ queryKey: ['activities', period, page], queryFn: () => api(`/activities?period=${period}&page=${page}`, ActivityList) });
  return <><PageIntro title="活動" /><div className="page-actions"><Link to="/activities/new">新增活動草稿</Link><Link to="/me/activities/drafts">活動草稿</Link><Link to="/me/music">我的成分</Link></div>
    <section aria-label="活動列表"><div className="tabs" aria-label="活動篩選">{[['upcoming', '近期活動'], ['history', '往期與歸檔']].map(([key, label]) => <Button key={key} variant={period === key ? 'primary' : 'ghost'} aria-pressed={period === key} onClick={() => setSearch({ period: key! })}>{label}</Button>)}</div>
      {query.isPending ? <Notice>正在讀取活動…</Notice> : query.error ? <Failure error={query.error} retry={() => void query.refetch()} /> : query.data.events.length ? <div className="event-grid">{query.data.events.map(event => <ActivityCard key={event.id} event={event} />)}</div> : <Surface><EmptyState motif="paper" title="這裡還沒有公開活動" description="邀請限定的活動不會出現在公開列表。" /></Surface>}
      {query.data && <div className="pagination">{page > 1 && <Button variant="secondary" onClick={() => setSearch({ period, page: String(page - 1) })}>上一頁</Button>}{query.data.hasMore && <Button variant="secondary" onClick={() => setSearch({ period, page: String(page + 1) })}>下一頁</Button>}</div>}
    </section></>;
}
export function ActivityDetail() {
  const { id = '' } = useParams();
  const [search]=useSearchParams();const task=search.get('task');
  const session = useSession(); const viewer = session.data;
  const query = useQuery({ queryKey: ['private', viewer?.scope, 'activity', id], queryFn: () => api('/activities/' + encodeURIComponent(id), Activity, {headers:{'X-Account-Scope':viewer!.scope}}), enabled:!!viewer });
  if(task==='finance')return <Navigate replace to={'/activities/'+encodeURIComponent(id)+'/finance'}/>;
  if (session.error) return <Failure error={session.error} retry={()=>void session.refetch()}/>;
  if (query.isPending) return <Notice>正在讀取活動…</Notice>;
  if (query.error) return <Failure error={query.error} retry={() => void query.refetch()} />;
  const event = query.data;
  return <><Link className="back" to="/activities">← 所有活動</Link><PageIntro title={event.title}>{event.category} · {phaseLabel[event.phase] ?? event.phase}{event.archived ? ' · 已歸檔' : ''}</PageIntro>
    <div className="page-actions"><Link to={'/activities/'+encodeURIComponent(id)+'/finance'}>收付款帳本</Link><Link to={'/activities/'+encodeURIComponent(id)+'/history'}>活動歷史</Link><Link to={'/activities/'+encodeURIComponent(id)+'/signup'}>本人／同行報名</Link><Link to={'/activities/'+encodeURIComponent(id)+'/registration'}>管理報名</Link><Link to={'/activities/'+encodeURIComponent(id)+'/invitations'}>補報名邀請</Link><Link to={'/activities/'+encodeURIComponent(id)+'/claims'}>代報認領</Link><Link to={'/activities/'+encodeURIComponent(id)+'/conditions'}>安排版本與確認</Link>{viewer?.authenticated&&<><Link to={'/activities/'+encodeURIComponent(id)+'/delegation'}>管理分工</Link><Link to={'/activities/'+encodeURIComponent(id)+'/attendance'}>現場出席</Link><ActivityManagementLink key={viewer.scope} eventId={id} viewer={viewer}/><ActivityLifecycleLink key={'state:'+viewer.scope} eventId={id} viewer={viewer}/></>}</div>
    <Surface className="detail"><Heading level={2}>活動安排</Heading><dl><dt>時間</dt><dd>{dateLabel(event.startsAt)}（台北時間）{event.durationHours !== null ? ` · 預計 ${event.durationHours} 小時` : ' · 時長未定'}</dd><dt>地點</dt><dd>{event.location}</dd><dt>人數</dt><dd>{event.confirmed} / {event.capacity||'不限'} 人 · 最低 {event.minimumParticipants} 人</dd><dt>報名截止</dt><dd>{dateLabel(event.deadline)}（台北時間）</dd><dt>退出期限</dt><dd>{dateLabel(event.withdrawalDeadline||event.deadline)}（台北時間）</dd><dt>可見性</dt><dd>{event.visibility==='public'?'公開':'邀請可見'}</dd><dt>安排版本</dt><dd>{event.conditionsVersion}{event.changeSummary?' · '+event.changeSummary:''}</dd></dl>
      {event.feePolicy&&<><Heading level={2}>費用規則</Heading><Text className="description">{event.feePolicy}</Text></>}{event.estimatedOver && <Notice>預定時間已過，實際結束狀態尚未確認。</Notice>}{event.description&&<><Heading level={2}>活動說明</Heading><Text className="description">{event.description}</Text></>}
      {task&&<Notice>已開啟對應活動；此入口不會自動提交報名、確認或款項操作。</Notice>}
      <Notice>尚未提供分房與結算。</Notice>
    <Link className="text-link" to={'/me/music?from=' + encodeURIComponent('/activities/' + id)}>編輯我的成分</Link></Surface>
    {viewer&&<ActivityParticipants key={viewer.scope} eventId={id} viewer={viewer}/>}</>;
}
