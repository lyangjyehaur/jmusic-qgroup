import { uiText } from './language';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Heading, Surface, Text } from 'yahha-ui';
import { ActivityRoster, AttendeeMusic, type Viewer } from '@qgroup/contracts';
import { scopedHttp } from './http';
import { loginLink } from './auth';
import { Failure, Notice } from './shared';
import { QQAvatar } from './qq-profile';
const statusLabels = {confirmed:uiText("正式"),waiting:uiText("候補"),tentative:uiText("待確認")};
const levels:Record<number,string> = {1:uiText("只聽過幾首"),2:uiText("聽過一些"),3:uiText("常聽"),4:uiText("本命")};
export function ActivityParticipants({ eventId, viewer }: {eventId:string;viewer:Viewer}) {
  const client=useQueryClient();const [selected,setSelected]=useState<{id:string;name:string}|null>(null);
  const query=useQuery({queryKey:['private',viewer.scope,'activity-roster',eventId],queryFn:()=>scopedHttp(viewer.scope).request('GET /api/v2/activities/:id/roster',{params:{id:eventId}},ActivityRoster)});
  const returnTo='/activities/'+encodeURIComponent(eventId)+'#participants';
  return <Surface className="detail" id="participants"><div className="roster-title"><Heading level={2}>活動名單</Heading><Button variant="secondary" loading={query.isFetching} onClick={()=>{void query.refetch();void client.invalidateQueries({queryKey:['private',viewer.scope,'attendee-music',eventId]});}}>更新名單</Button></div>
    {query.isPending?<Notice>正在讀取活動名單…</Notice>:query.error?<Failure error={query.error} retry={()=>void query.refetch()}/>:query.data.participants.length?<ul className="activity-roster">{query.data.participants.map(person=><li key={person.id}>
      <QQAvatar url={person.avatarUrl} nickname={person.name}/><div className="roster-person"><Text><strong>{person.name}</strong>{person.isMe?' · 我':person.isGuest?' · 未認領同行':''}</Text><Text>{statusLabels[person.status]}{person.waitingPosition!==null?' '+person.waitingPosition:''}{person.withdrawalRequested?' · 退出申請中':''}{person.confirmationState==='pending'?' · 安排待確認':''}</Text>
      {person.note&&<Text className="description">{person.note}</Text>}<Text tone="muted">付款：{person.payerName}</Text>
      {person.managedByMe&&<><Link to={'/activities/'+encodeURIComponent(eventId)+'/registration?'+new URLSearchParams({person:person.id})}>管理此人的報名</Link><Link to={'/activities/'+encodeURIComponent(eventId)+'/conditions?'+new URLSearchParams({person:person.id})}>核對此人的安排</Link>{person.isGuest&&<Link to={'/activities/'+encodeURIComponent(eventId)+'/claims?'+new URLSearchParams({person:person.id})}>邀請本人認領</Link>}</>}
      {viewer.authenticated?<Button variant="ghost" onClick={()=>setSelected({id:person.id,name:person.name})}>查看 {person.name} 的成分</Button>:<Link to={loginLink(returnTo)}>登入查看成分</Link>}</div>
    </li>)}</ul>:<Text>目前沒有正式、候補或待確認的報名。</Text>}
    {selected&&viewer.authenticated&&<AttendeeMusicDialog key={viewer.scope+':'+viewer.musicEpoch+':'+selected.id} eventId={eventId} person={selected} viewer={viewer} close={()=>setSelected(null)}/>}
  </Surface>;
}
function AttendeeMusicDialog({eventId,person,viewer,close}:{eventId:string;person:{id:string;name:string};viewer:Extract<Viewer,{authenticated:true}>;close:()=>void}) {
  const dialog=useRef<HTMLDialogElement>(null);
  useEffect(()=>{const element=dialog.current!;element.showModal();return()=>element.close();},[]);
  const query=useQuery({queryKey:['private',viewer.scope,'attendee-music',eventId,person.id,viewer.musicEpoch],queryFn:()=>scopedHttp(viewer.scope).request('GET /api/v2/activities/:id/attendees/:attendeeId/music',{params:{id:eventId,attendeeId:person.id}},AttendeeMusic),refetchOnMount:'always'});
  const from='/activities/'+encodeURIComponent(eventId)+'#participants';
  return <dialog className="attendee-music-dialog" ref={dialog} aria-labelledby="attendee-music-title" onClose={close}><div className="roster-title"><Heading level={2} id="attendee-music-title">{person.name} 的成分</Heading><Button variant="secondary" onClick={()=>dialog.current?.close()}>關閉成分</Button></div>
    {query.isPending?<Notice>正在讀取成分…</Notice>:query.error?<Failure error={query.error} retry={()=>void query.refetch()}/>:query.data.state==='unlinked'?<Notice>這位報名者尚未關聯成分。</Notice>:query.data.state==='viewer_unlinked'?<Notice>請先<Link to={'/me/music?from='+encodeURIComponent(from)}>保存成分</Link>，再查看共同喜好。</Notice>:<><Text>成分稱呼：{query.data.name}</Text>{query.data.picks.length?<ul className="attendee-music-picks">{query.data.picks.map(pick=><li key={pick.entryId}>{pick.name}{pick.kind==='sub'?' · '+levels[pick.level]:''}{pick.shared?' · 共同喜好':''}</li>)}</ul>:<Text>尚未選擇詞條。</Text>}<Link to={'/people/'+query.data.profileId+'?from='+encodeURIComponent(from)}>查看完整成分</Link></>}
  </dialog>;
}
