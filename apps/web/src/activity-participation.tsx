import { useQuery } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';
import { Text } from 'yahha-ui';
import type { ActivityView, Viewer } from '@qgroup/contracts';
import { ActionLink } from './action-link';
import { loginLink } from './auth';
import { scopedHttp } from './http';
import { Failure, Notice } from './shared';
import { uiText } from './language';
import { ActivitySelfRegistration } from './activity-registration';
import { ActivityFinishLink } from './activity-lifecycle';

const statusLabels: Record<string, string> = {
  confirmed: uiText('已報名'), waiting: uiText('候補'), tentative: uiText('待確認參加'),
  invited: uiText('受邀待接受'), withdrawn: uiText('已退出'),
};
export function ActivityParticipation({ event, viewer }: { event: ActivityView; viewer: Viewer }) {
  const base = '/activities/' + encodeURIComponent(event.id);
  const query = useQuery({ queryKey: ['private', viewer.scope, 'activity-registration', event.id],
    queryFn: () => scopedHttp(viewer.scope).requestContract('GET /api/v2/activities/:id/registration', { params: { id: event.id } }),
    enabled: viewer.authenticated });
  const data = query.data, own = data?.people.find(person => person.isMe);
  const location=useLocation();
  const roster=useQuery({queryKey:['private',viewer.scope,'activity-roster',event.id],queryFn:()=>scopedHttp(viewer.scope).requestContract('GET /api/v2/activities/:id/roster',{params:{id:event.id}}),enabled:viewer.authenticated&&own?.status==='waiting'});
  const waitingPosition=roster.data?.participants.find(person=>person.isMe)?.waitingPosition;
  const companions = data?.people.filter(person => person.managedByMe && !person.isMe) ?? [];
  const closed = ['draft', 'ended', 'cancelled'].includes(event.phase) || event.archived;
  const autoCancelled = event.phase==='cancelled'&&event.formationState==='unformed';
  return <section className="next-step-panel" aria-label="我的報名"><div className="next-step-copy"><h2>{autoCancelled?'活動已取消':own?(own.status==='waiting'&&waitingPosition?'候補第 '+waitingPosition+' 位':statusLabels[own.status]??own.status):'我的報名'}</h2>
    {autoCancelled&&<p>{event.cancellationReason||'開始時未達成團人數，活動已取消。'}</p>}
    {!autoCancelled&&!viewer.authenticated&&closed&&<Text>{event.phase==='draft'?'草稿尚未開放報名。':'活動已結束或關閉報名。'}</Text>}
    {viewer.authenticated&&(query.isPending?<Notice>正在讀取本人與同行報名…</Notice>:query.error?<Failure error={query.error} retry={()=>void query.refetch()}/>:<>{own?.withdrawalRequested&&<p>退出申請已提交，等待名單管理者處理。</p>}{!autoCancelled&&!data?.selfRegistered&&data?.signupBlocker&&<p>{data.signupBlocker}</p>}{!data?.selfRegistered&&!data?.signupBlocker&&closed&&<p>活動已結束或關閉報名。</p>}</>)}
    </div><div className="next-step-actions">
      {!viewer.authenticated&&!closed&&<ActionLink variant="primary" to={loginLink(base)}>登入報名</ActionLink>}
      {viewer.authenticated&&data&&<>
        {own&&(own.canChange||own.canWithdraw||own.canDecide)&&<ActionLink variant="primary" to={base+'/registration?'+new URLSearchParams({person:own.id})}>管理本人報名</ActionLink>}
        {location.pathname===base&&<ActivitySelfRegistration key={viewer.scope+':'+event.id} viewer={viewer} initial={data} waiting={event.waiting>0||!!event.capacity&&event.confirmed>=event.capacity}/>}
        {location.pathname!==base&&!data.selfRegistered&&!data.signupBlocker&&!closed&&<ActionLink variant="primary" to={base+'/signup'}>本人報名</ActionLink>}
        {!data.signupBlocker&&!closed&&<ActionLink to={base+'/signup?preset=party'}>同行／代報名</ActionLink>}
        {companions.length>0&&<ActionLink to={base+'/registration'+(companions.length===1?'?'+new URLSearchParams({person:companions[0]!.id}):'')}>管理我的同行（{companions.length} 人）</ActionLink>}
        {data.selfRegistered&&!own&&<ActionLink to={base+'/registration'}>查看我的報名</ActionLink>}
        <ActivityFinishLink eventId={event.id} viewer={viewer}/>
      </>}
    </div></section>;
}
