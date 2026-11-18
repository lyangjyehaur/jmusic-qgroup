import { Navigate, Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button, EmptyState, Heading, Surface, Text } from 'yahha-ui';
import { Activity, ActivityList, type ActivityView } from '@qgroup/contracts';
import { api } from './api';
import { MemberAccess, type Member } from './member-access';
import { Failure, Notice, PageIntro, useSession } from './shared';
import { ActivityRoomOverviewSection } from './activity-room-overview';
import { ActivityParticipants } from './activity-roster';
import { ActivityManagementLink } from './activity-conditions';
import { ActivityLifecycleLink } from './activity-lifecycle';
import { ActivityLocation } from './activity-sharing';
import { activityDate, activityTimeRange } from './activity-summary';
const phaseLabel: Record<string, string> = { draft: '草稿', scheduled: '即將開始', ongoing: '進行中', ended: '已結束', cancelled: '已取消' };
function ActivityCard({ event, rooms=false }: { event: ActivityView;rooms?:boolean }) {
  const destination=event.lifecycle==='draft'?'/activities/'+encodeURIComponent(event.id)+'/edit':rooms?'/tools/room-lab?eventId='+encodeURIComponent(event.id):'/activities/'+encodeURIComponent(event.id);
  return <Surface className="event-card"><div className="event-meta"><span className="pill">{event.category}</span><span>{event.archived ? '已歸檔' : phaseLabel[event.phase] ?? event.phase}</span></div>
    <Heading level={2}><Link to={destination}>{event.title}</Link></Heading>
    <Text>{activityDate(event.startsAt,event.timezone)}</Text><Text tone="muted">{event.location}</Text>
    <div className="event-bottom"><span>{event.confirmed} / {event.capacity||'不限'} 人{event.waiting > 0 ? ` · ${event.waiting} 人候補` : ''}</span><Link to={destination}>{rooms?'分析活動成分':'查看活動'} <span aria-hidden="true">↗</span></Link></div>
  </Surface>;
}
export function Activities({mine=false}:{mine?:boolean}) {
  return mine?<MemberAccess>{viewer=><ActivityListing key={viewer.scope} viewer={viewer}/>}</MemberAccess>:<ActivityListing/>;
}
function ActivityListing({viewer}:{viewer?:Member}) {
  const [search, setSearch] = useSearchParams();
  const period = search.get('period') === 'history' ? 'history' : 'upcoming';
  const page = Math.max(1, Math.min(10000, Number(search.get('page')) || 1));
  const rooms=search.get('task')==='rooms',mine=!!viewer;
  const query = useQuery({ queryKey: mine?['private',viewer.scope,'my-activities',page]:['activities', period, page], queryFn: () => api(mine?`/me/activities?page=${page}`:`/activities?period=${period}&page=${page}`, ActivityList,viewer?{headers:{'X-Account-Scope':viewer.scope}}:undefined) });
  const change=(params:Record<string,string>)=>setSearch({...params,...(rooms?{task:'rooms'}:{})});
  return <><PageIntro title={mine?'我的活動':rooms?'選擇活動分析成分':'活動'} /><div className="page-actions"><Link to={mine?'/activities':'/me/activities'}>{mine?'所有活動':'我的活動'}</Link><Link to="/activities/new">新增活動草稿</Link><Link to="/time-polls">時間投票</Link><Link to="/me/activities/drafts">活動草稿</Link><Link to="/me/music">我的成分</Link></div>
    <section aria-label="活動列表">{!mine&&<div className="tabs" aria-label="活動篩選">{[['upcoming', '近期活動'], ['history', '往期與歸檔']].map(([key, label]) => <Button key={key} variant={period === key ? 'primary' : 'ghost'} aria-pressed={period === key} onClick={() => change({ period: key! })}>{label}</Button>)}</div>}
      {query.isPending ? <Notice>正在讀取活動…</Notice> : query.error ? <Failure error={query.error} retry={() => void query.refetch()} /> : query.data.events.length ? <div className="event-grid">{query.data.events.map(event => <ActivityCard key={event.id} event={event} rooms={rooms} />)}</div> : <Surface><EmptyState motif="paper" title={mine?'沒有與你相關的活動':'這裡還沒有公開活動'} description={mine?'包含發起、協辦、有效報名與仍有結算義務的活動。':'邀請限定的活動不會出現在公開列表。'} /></Surface>}
      {query.data && <div className="pagination">{page > 1 && <Button variant="secondary" onClick={() => change({ period, page: String(page - 1) })}>上一頁</Button>}{query.data.hasMore && <Button variant="secondary" onClick={() => change({ period, page: String(page + 1) })}>下一頁</Button>}</div>}
    </section></>;
}
export function ActivityDetail() {
  const { id = '' } = useParams();
  const [search]=useSearchParams();const task=search.get('task');
  const session = useSession(); const viewer = session.data;
  const query = useQuery({ queryKey: ['private', viewer?.scope, 'activity', id], queryFn: () => api('/activities/' + encodeURIComponent(id), Activity, {headers:{'X-Account-Scope':viewer!.scope}}), enabled:!!viewer });
  if(task==='settlement')return <Navigate replace to={'/activities/'+encodeURIComponent(id)+'/settlement'}/>;
  if(task==='finance')return <Navigate replace to={'/activities/'+encodeURIComponent(id)+'/finance'}/>;
  if (session.error) return <Failure error={session.error} retry={()=>void session.refetch()}/>;
  if (query.isPending) return <Notice>正在讀取活動…</Notice>;
  if (query.error) return <Failure error={query.error} retry={() => void query.refetch()} />;
  const event = query.data;
  return <><Link className="back" to="/activities">← 所有活動</Link><PageIntro title={event.title}>{event.category} · {phaseLabel[event.phase] ?? event.phase}{event.archived ? ' · 已歸檔' : ''}</PageIntro>
    <div className="page-actions"><Link to={'/activities/'+encodeURIComponent(id)+'/share'}>分享活動</Link><Link to={'/activities/new?copyFrom='+encodeURIComponent(id)}>再約一次</Link><Link to={'/activities/'+encodeURIComponent(id)+'/settlement'}>逐人結算</Link><Link to={'/activities/'+encodeURIComponent(id)+'/finance'}>收付款帳本</Link><Link to={'/activities/'+encodeURIComponent(id)+'/history'}>活動歷史</Link><Link to={'/activities/'+encodeURIComponent(id)+'/signup'}>本人／同行報名</Link><Link to={'/activities/'+encodeURIComponent(id)+'/registration'}>管理報名</Link><Link to={'/activities/'+encodeURIComponent(id)+'/invitations'}>補報名邀請</Link><Link to={'/activities/'+encodeURIComponent(id)+'/claims'}>代報認領</Link><Link to={'/activities/'+encodeURIComponent(id)+'/conditions'}>安排版本與確認</Link>{viewer?.authenticated&&<><Link to={'/activities/'+encodeURIComponent(id)+'/bot-deliveries'}>群通知紀錄</Link><Link to={'/activities/'+encodeURIComponent(id)+'/delegation'}>管理分工</Link><Link to={'/activities/'+encodeURIComponent(id)+'/attendance'}>現場出席</Link><ActivityManagementLink key={viewer.scope} eventId={id} viewer={viewer}/><ActivityLifecycleLink key={'state:'+viewer.scope} eventId={id} viewer={viewer}/></>}</div>
    <Surface className="detail"><Heading level={2}>活動安排</Heading><dl><dt>時間</dt><dd>{activityTimeRange(event)}</dd><dt>地點</dt><dd><ActivityLocation value={event.location}/></dd><dt>人數</dt><dd>{event.confirmed} / {event.capacity||'不限'} 人 · 最低 {event.minimumParticipants} 人</dd><dt>報名截止</dt><dd>{activityDate(event.deadline,event.timezone)}</dd><dt>退出期限</dt><dd>{activityDate(event.withdrawalDeadline||event.deadline,event.timezone)}</dd><dt>可見性</dt><dd>{event.visibility==='public'?'公開':'邀請可見'}</dd><dt>安排版本</dt><dd>{event.conditionsVersion}{event.changeSummary?' · '+event.changeSummary:''}</dd></dl>
      {event.feePolicy&&<><Heading level={2}>費用規則</Heading><Text className="description">{event.feePolicy}</Text></>}{event.estimatedOver && <Notice>預定時間已過，實際結束狀態尚未確認。</Notice>}{event.description&&<><Heading level={2}>活動說明</Heading><Text className="description">{event.description}</Text></>}
      {task&&<Notice>已開啟對應活動；此入口不會自動提交報名、確認或款項操作。</Notice>}
    <Link className="text-link" to={'/me/music?from=' + encodeURIComponent('/activities/' + id)}>編輯我的成分</Link></Surface>
    {viewer&&<><ActivityRoomOverviewSection key={'rooms:'+viewer.scope} eventId={id} viewer={viewer}/><ActivityParticipants key={viewer.scope} eventId={id} viewer={viewer}/></>}</>;
}
