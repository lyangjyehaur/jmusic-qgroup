import { uiText } from './language';
import { useContext, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Heading, Text } from 'yahha-ui';
import { Badge, Button, Modal } from './kimi-ui';
import { type Viewer } from '@qgroup/contracts';
import { scopedHttp } from './http';
import { loginLink } from './auth';
import { Failure, Notice } from './shared';
import { QQAvatar } from './qq-profile';
import { InactivePageContext } from './discovery-dialog';
const statusLabels = {confirmed:uiText("正式"),waiting:uiText("候補"),tentative:uiText("待確認")};
const attendanceLabels:Record<string,string>={present:uiText('到場'),absent:uiText('缺席'),late:uiText('遲到'),left:uiText('早退')};
const levels:Record<number,string> = {1:uiText("只聽過幾首"),2:uiText("聽過一些"),3:uiText("常聽"),4:uiText("本命")};
export function ActivityParticipants({ eventId, viewer }: {eventId:string;viewer:Viewer}) {
  const inactive = useContext(InactivePageContext);
  const client=useQueryClient();const [selected,setSelected]=useState<{id:string;name:string}|null>(null);
  const query=useQuery({queryKey:['private',viewer.scope,'activity-roster',eventId],queryFn:()=>scopedHttp(viewer.scope).requestContract('GET /api/v2/activities/:id/roster',{params:{id:eventId}})});
  const registration=useQuery({queryKey:['private',viewer.scope,'activity-registration',eventId],queryFn:()=>scopedHttp(viewer.scope).requestContract('GET /api/v2/activities/:id/registration',{params:{id:eventId}}),enabled:viewer.authenticated});
  const returnTo='/activities/'+encodeURIComponent(eventId)+'#participants';
  return <section className="plain-section" id="participants"><div className="roster-title"><Heading level={2}>活動名單{query.data&&<span aria-hidden="true">（{query.data.participants.length}）</span>}</Heading><Button variant="secondary" aria-label="重新整理活動名單" title="重新讀取名單、報名權限與成分資料" loading={query.isFetching} onClick={()=>{void query.refetch();for(const key of ['activity-registration','activity','activity-lifecycle','attendee-music'])void client.invalidateQueries({queryKey:['private',viewer.scope,key,eventId]});}}>重新整理</Button></div>
    {query.isPending?<Notice>正在讀取活動名單…</Notice>:query.error?<Failure error={query.error} retry={()=>void query.refetch()}/>:query.data.participants.length?<ul className="activity-roster participant-list">{query.data.participants.map(person=><li className="participant-row" key={person.id}>
      <div className="participant-heading">{viewer.authenticated?<Button variant="ghost" className="participant-identity" aria-label={'查看 '+person.name+' 的成分'} onClick={()=>setSelected({id:person.id,name:person.name})}><QQAvatar url={person.avatarUrl} nickname={person.name}/><strong>{person.name}</strong></Button>:<Link className="participant-identity" aria-label={'登入查看 '+person.name+' 的成分'} to={loginLink(returnTo)}><QQAvatar url={person.avatarUrl} nickname={person.name}/><strong>{person.name}</strong></Link>}<span className="participant-state"><Badge tone={person.status==='confirmed'?'green':'amber'}>{person.status==='waiting'?'候補 '+person.waitingPosition:statusLabels[person.status]}</Badge>{person.isMe&&<span className="participant-me">我</span>}</span></div>
      <div className="roster-person participant-body">{person.isGuest&&<Text tone="muted">未認領同行 · {person.managerName} 代報</Text>}
      {person.note&&<Text className="participant-note">報名備註：{person.note}</Text>}
      {(person.withdrawalRequested||person.confirmationState==='pending'||person.confirmationState==='declined'||attendanceLabels[person.attendance])&&<Text className="participant-flags">{[person.withdrawalRequested&&uiText('退出申請中'),person.confirmationState==='pending'&&uiText('安排待確認'),person.confirmationState==='declined'&&uiText('暫不同意新安排'),attendanceLabels[person.attendance]].filter(Boolean).join(' · ')}</Text>}
      <div className="page-actions roster-actions participant-actions">{(() => {
        const allowed=registration.data?.people.find(item=>item.id===person.id);
        const route=(preset:string)=>'/activities/'+encodeURIComponent(eventId)+'/registration?'+new URLSearchParams({person:person.id,preset});
        return <>
          {(person.managedByMe||allowed?.canChange||allowed?.canWithdraw||allowed?.canDecide)&&<Link to={route('edit')}>管理此人的報名</Link>}
          {allowed?.canChange&&person.status==='tentative'&&<Link to={route('confirm')}>確認參加</Link>}
          {allowed?.canWithdraw&&<Link className="withdraw-link" to={route('withdraw')}>{allowed.needsWithdrawalRequest?'申請退出':'退出報名'}</Link>}
          {allowed?.canDecide&&person.withdrawalRequested&&<><Link to={route('approve')}>同意退出申請</Link><Link to={route('reject')}>拒絕退出申請</Link></>}
          {person.managedByMe&&<><Link to={'/activities/'+encodeURIComponent(eventId)+'/conditions?'+new URLSearchParams({person:person.id})}>{person.confirmationState==='pending'?'確認變更後的安排':'核對此人的安排'}</Link>{person.isGuest&&<Link to={'/activities/'+encodeURIComponent(eventId)+'/claims?'+new URLSearchParams({person:person.id})}>邀請本人認領</Link>}</>}
        </>;
      })()}
      </div></div>
    </li>)}</ul>:<Text>目前沒有正式、候補或待確認的報名。</Text>}
    {selected&&!inactive&&viewer.authenticated&&<AttendeeMusicDialog key={viewer.scope+':'+viewer.musicEpoch+':'+selected.id} eventId={eventId} person={selected} viewer={viewer} close={()=>setSelected(null)}/>}
  </section>;
}
function AttendeeMusicDialog({eventId,person,viewer,close}:{eventId:string;person:{id:string;name:string};viewer:Extract<Viewer,{authenticated:true}>;close:()=>void}) {
  const query=useQuery({queryKey:['private',viewer.scope,'attendee-music',eventId,person.id,viewer.musicEpoch],queryFn:()=>scopedHttp(viewer.scope).requestContract('GET /api/v2/activities/:id/attendees/:attendeeId/music',{params:{id:eventId,attendeeId:person.id}}),refetchOnMount:'always'});
  const from='/activities/'+encodeURIComponent(eventId)+'#participants';
  return <Modal title={person.name+uiText(" 的成分")} closeLabel="關閉成分" onClose={close}>
    {query.isPending?<Notice>正在讀取成分…</Notice>:query.error?<Failure error={query.error} retry={()=>void query.refetch()}/>:query.data.state==='unlinked'?<Notice>這位報名者尚未關聯成分。</Notice>:query.data.state==='viewer_unlinked'?<Notice>請先<Link onClick={close} to={'/me/music?from='+encodeURIComponent(from)}>保存成分</Link>，再查看共同喜好。</Notice>:<><Text>成分稱呼：{query.data.name}</Text>{query.data.picks.length?<ul className="attendee-music-picks">{query.data.picks.map(pick=><li key={pick.entryId}>{pick.name}{pick.kind==='sub'?' · '+levels[pick.level]:''}{pick.shared?' · 共同喜好':''}</li>)}</ul>:<Text>尚未選擇詞條。</Text>}<Link onClick={close} to={'/people/'+query.data.profileId+'?from='+encodeURIComponent(from)}>查看完整成分</Link></>}
  </Modal>;
}
