import { activityCategoryLabel } from './activity-categories';
import { uiText } from './language';
import type { ReactNode } from 'react';
import { Navigate, Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Heading, Surface, Text } from 'yahha-ui';
import { scopedHttp } from './http';
import { Failure, Notice, useSession } from './shared';
import { ActivityRoomOverviewSection } from './activity-room-overview';
import { ActivityParticipants } from './activity-roster';
import { ActivityManagementLink } from './activity-conditions';
import { ActivityLifecycleLink } from './activity-lifecycle';
import { ActivityLocation } from './activity-sharing';
import { activityDisplayDate, activityTimeRange } from './activity-summary';
import { ActionLink } from './action-link';
import { ActivityParticipation } from './activity-participation';
import { InterfaceIcon } from './interface-icons';
import { Badge, PageHeader, Tabs } from './kimi-ui';
const phaseLabel: Record<string, string> = { draft: uiText("草稿"), scheduled: uiText("即將開始"), ongoing: uiText("進行中"), ended: uiText("已結束"), cancelled: uiText("已取消") };
export { KimiActivitiesPage as Activities } from './kimi-activities';
export function ActivityDetail({ panel, activeTab }: { panel?: ReactNode; activeTab?: string } = {}) {
  const location=useLocation(),navigate=useNavigate();
  const { id = '' } = useParams();
  const [search]=useSearchParams();const task=search.get('task');
  const session = useSession(); const viewer = session.data;
  const query = useQuery({ queryKey: ['private', viewer?.scope, 'activity', id], queryFn: () => scopedHttp(viewer!.scope).requestContract('GET /api/v2/activities/:id', { params: { id } }), enabled:!!viewer });
  if(task==='settlement')return <Navigate replace to={'/activities/'+encodeURIComponent(id)+'/settlement'}/>;
  if(task==='finance')return <Navigate replace to={'/activities/'+encodeURIComponent(id)+'/finance'}/>;
  if (session.error) return <Failure error={session.error} retry={()=>void session.refetch()}/>;
  if (query.isPending) return <Notice>正在讀取活動…</Notice>;
  if (query.error) return <Failure error={query.error} retry={() => void query.refetch()} />;
  const event = query.data;
  const base='/activities/'+encodeURIComponent(id);
  const tab=activeTab??(location.hash==='#participants'?'members':['members','rooms','manage'].includes(search.get('view')??'')?search.get('view')!:'overview');
  const tabURL=(value:string)=>{const params=new URLSearchParams(search);params.delete('view');params.delete('task');if(value!=='overview')params.set('view',value);return base+(params.size?'?'+params:'')+(value==='members'?'#participants':'');};
  return <div className="kimi page activity-detail-page"><div className="detail-back-row"><Link className="back" to="/activities">← 所有活動</Link><span>活動 ID · {id}</span></div>
    <PageHeader title={event.title} actions={<div className="page-actions"><ActionLink to={base+'/share'}>分享活動</ActionLink><details className="activity-more"><summary>更多活動操作</summary><div className="activity-menu"><Link to={'/activities/new?copyFrom='+encodeURIComponent(id)}>再約一次</Link><Link to={base+'/conditions'}>安排版本與確認</Link><Link to={base+'/history'}>活動歷史</Link>{viewer?.authenticated&&<><ActivityManagementLink key={viewer.scope} eventId={id} viewer={viewer}/><ActivityLifecycleLink key={'state:'+viewer.scope} eventId={id} viewer={viewer}/><Link to={base+'/delegation'}>管理分工</Link><Link to={base+'/bot-deliveries'}>群通知紀錄</Link></>}</div></details></div>}/>
    <div className="status-strip"><Badge tone={event.phase==='ongoing'&&!event.estimatedOver?'blue':'neutral'}>{event.archived?'已歸檔':event.estimatedOver?'已過預定時間':phaseLabel[event.phase]??event.phase}</Badge><Badge>{activityCategoryLabel(event.category)}</Badge><span><InterfaceIcon name="people" size={15}/>{event.confirmed} / {event.capacity||'不限'} 人{event.waiting>0?' · 候補 '+event.waiting+' 人':''}</span></div>
    {typeof location.state?.activityNotice==='string'&&<Notice>{location.state.activityNotice}</Notice>}
    <div className="activity-overview-mount detail-layout"><div className="detail-primary"><section className="event-facts" aria-label="活動安排"><div><InterfaceIcon name="clock"/><span><small>日期與時間</small><strong>{activityDisplayDate(event.startsAt,event.timezone)}</strong><p>{event.durationHours===null?'時長未定':event.durationHours+' 小時'}</p><details><summary>完整時間範圍</summary><p>{activityTimeRange(event)}</p></details></span></div><div><InterfaceIcon name="location"/><span><small>集合地點</small><strong><ActivityLocation value={event.location}/></strong></span></div><div><InterfaceIcon name="wallet"/><span><small>費用規則</small><p className="description">{event.feePolicy||'尚未填寫費用規則'}</p><Link to={base+'/settlement'}>逐人結算</Link></span></div></section>
    {viewer&&<ActivityParticipation key={viewer.scope+':'+id} event={event} viewer={viewer}/>}
    {event.estimatedOver && <Notice>預定時間已過，實際結束狀態尚未確認。</Notice>}
    <Tabs label="活動內容" value={tab} onChange={value=>navigate(value==='settlement'?base+'/settlement':tabURL(value))} items={[{value:'overview',label:uiText('總覽')},{value:'members',label:uiText('成員')},{value:'rooms',label:uiText('分房')},{value:'settlement',label:uiText('結算')},{value:'manage',label:uiText('管理')}]}/>

    {panel ? <section className="activity-tab-content">{panel}</section> : <>
      {tab==='overview'&&event.description&&<section className="plain-section overview-description"><Heading level={2}>活動說明</Heading><Text className="description">{event.description}</Text></section>}
      {task&&<Notice>已開啟對應活動；此入口不會自動提交報名、確認或款項操作。</Notice>}
    {(tab==='overview'||tab==='members')&&viewer&&<ActivityParticipants key={viewer.scope} eventId={id} viewer={viewer} compact={tab==='overview'}/>}
    {(tab==='overview'||tab==='rooms')&&viewer&&<ActivityRoomOverviewSection key={'rooms:'+viewer.scope} eventId={id} viewer={viewer}/>}
    {tab==='rooms'&&<div className="page-actions"><ActionLink variant="primary" to={base+'/rooms'}>分配包間</ActionLink><ActionLink to={'/tools/room-lab?eventId='+encodeURIComponent(id)}>自由分房試算</ActionLink><Link to={base+'/rooms/history'}>預分安排歷史</Link></div>}
    {tab==='manage'&&<Surface className="activity-tool-group"><div className="activity-tools" aria-label="活動操作"><section><Heading level={2}>報名與出席</Heading><div className="activity-tool-links">
        <Link to={base+'/registration'}>管理報名</Link><Link to={base+'/invitations'}>補報名邀請</Link><Link to={base+'/claims'}>代報認領</Link>{viewer?.authenticated&&<Link to={base+'/attendance'}>現場出席</Link>}
      </div></section><section><Heading level={2}>安排與管理</Heading><div className="activity-tool-links">
        <Link to={base+'/conditions'}>安排版本與確認</Link><Link to={base+'/history'}>活動歷史</Link>{viewer?.authenticated&&<><ActivityManagementLink key={viewer.scope} eventId={id} viewer={viewer}/><ActivityLifecycleLink key={'state:'+viewer.scope} eventId={id} viewer={viewer}/><Link to={base+'/bot-deliveries'}>群通知紀錄</Link><Link to={base+'/delegation'}>管理分工</Link></>}
      </div></section><section><Heading level={2}>費用與結算</Heading><div className="activity-tool-links"><Link to={base+'/settlement'}>逐人結算</Link><Link to={base+'/finance'}>收付款帳本</Link></div></section></div></Surface>}
    </>}</div><aside className="detail-aside"><section><Heading level={2}>報名期限</Heading><dl className="side-definitions"><div><dt>報名截止</dt><dd>{activityDisplayDate(event.deadline,event.timezone)}</dd></div><div><dt>退出期限</dt><dd>{activityDisplayDate(event.withdrawalDeadline||event.deadline,event.timezone)}</dd></div><div><dt>最低成團</dt><dd>{event.minimumParticipants||'未設定'}{event.minimumParticipants?' 人':''}</dd></div></dl></section><section><Heading level={2}>安排與確認</Heading><dl className="side-definitions"><div><dt>可見性</dt><dd>{event.visibility==='public'?'公開':'邀請可見'}</dd></div><div><dt>安排版本</dt><dd>{event.conditionsVersion}</dd></div></dl>{event.changeSummary&&<Text>{event.changeSummary}</Text>}<Link to={base+'/conditions'}>安排版本與確認</Link></section><section><Heading level={2}>相關操作</Heading><Link to={'/me/music?from='+encodeURIComponent(base)}>編輯我的成分</Link><Link to={base+'/finance'}>收付款帳本</Link><Link to={base+'/history'}>活動歷史</Link></section></aside></div></div>;
}
