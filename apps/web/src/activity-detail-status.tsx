import { Disclosure } from './kimi-ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Text } from 'yahha-ui';
import type { ActivityView } from '@qgroup/contracts';
import type { Member } from './member-access';
import { scopedHttp } from './http';
import { Failure } from './shared';
import { activityDisplayDate } from './activity-summary';

/** Reuse the existing scoped reads; viewing status never performs a management action. */
export function ActivityDetailStatus({event,viewer}:{event:ActivityView;viewer:Member}) {
  const base='/activities/'+encodeURIComponent(event.id);
  const lifecycle=useQuery({queryKey:['private',viewer.scope,'activity-lifecycle',event.id],queryFn:()=>scopedHttp(viewer.scope).requestContract('GET /api/v2/activities/:id/lifecycle',{params:{id:event.id}})});
  const delegation=useQuery({queryKey:['private',viewer.scope,'activity-delegation',event.id],queryFn:()=>scopedHttp(viewer.scope).requestContract('GET /api/v2/activities/:id/delegation',{params:{id:event.id}})});
  const roster=useQuery({queryKey:['private',viewer.scope,'activity-roster',event.id],queryFn:()=>scopedHttp(viewer.scope).requestContract('GET /api/v2/activities/:id/roster',{params:{id:event.id}})});
  const pending=roster.data?.participants.filter(person=>person.confirmationState==='pending').length??0;
  const declined=roster.data?.participants.filter(person=>person.confirmationState==='declined').length??0;
  const settler=delegation.data?.roles.find(role=>role.permissions.includes('settlement'));
  return <div className="activity-detail-status">
    {delegation.error?<Failure error={delegation.error} retry={()=>void delegation.refetch()}/>:delegation.data&&<Text>發起者：{delegation.data.ownerName}{settler?' · 結算人：'+settler.name:''}</Text>}
    {lifecycle.error?<Failure error={lifecycle.error} retry={()=>void lifecycle.refetch()}/>:lifecycle.data&&<>
      {lifecycle.data.cancellationReason&&event.formationState!=='unformed'&&<Text className="activity-notes">取消原因：{lifecycle.data.cancellationReason}</Text>}
      {event.minimumParticipants>0&&!['ended','cancelled'].includes(event.lifecycle)&&<Text>成團 {event.confirmed}/{event.minimumParticipants} 人 · {lifecycle.data.formationState==='confirmed'?'發起者已確認成團':lifecycle.data.formationState==='formed'||lifecycle.data.actualStartedAt?'已成團':event.confirmed>=event.minimumParticipants?'已達最低人數，待發起者確認':'尚未達最低人數'}</Text>}
      {(lifecycle.data.actualStartedAt||lifecycle.data.actualEndedAt)&&<Disclosure   title={<>實際開始／結束</>}>{lifecycle.data.actualStartedAt&&<Text>實際開始：{activityDisplayDate(lifecycle.data.actualStartedAt,event.timezone)}</Text>}{lifecycle.data.actualEndedAt&&<Text>實際結束：{activityDisplayDate(lifecycle.data.actualEndedAt,event.timezone)}</Text>}</Disclosure>}
    </>}
    {(pending>0||declined>0)&&<Text>安排已變更{pending?' · '+pending+' 人待確認':''}{declined?' · '+declined+' 人暫不同意':''} <Link to={base+'/conditions'}>核對安排</Link></Text>}
    {delegation.data&&delegation.data.roles.length>0&&<Disclosure   title={<>協辦</>}><Text>{delegation.data.roles.map(role=>role.name).join('、')}</Text></Disclosure>}
  </div>;
}
