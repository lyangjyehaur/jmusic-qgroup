// Adapted from kimi/src/pages/ActivitiesPage.tsx; data and routes are server-backed.
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, CalendarPlus, Clock3, MapPin, UsersRound } from 'lucide-react';
import type { z } from 'zod';
import { ListedActivity, ActivitiesQuery } from '@qgroup/contracts';
import { Badge, EmptyState, PageHeader, SearchInput, Select, Button } from './kimi-ui';
import { Failure, Notice, useSession } from './shared';
import { scopedHttp } from './http';
import { ActivityBrowseTabs } from './activity-browse-tabs';
import { activityDisplayDate } from './activity-summary';
import { uiText } from './language';
const statuses = [['all',uiText('全部狀態')],['draft',uiText('草稿')],['open',uiText('報名中')],['full',uiText('已額滿')],['paused',uiText('未開放報名')],['ongoing',uiText('進行中')],['ended',uiText('已結束')],['cancelled',uiText('已取消')],['archived',uiText('已歸檔')]] as const;
export function listedActivityStatus(event: z.infer<typeof ListedActivity>) {
  return event.archived?'archived':event.estimatedOver?'ended':['draft','ongoing','ended','cancelled'].includes(event.phase)?event.phase:!event.registrationOpen?'paused':event.capacity>0&&event.confirmed>=event.capacity?'full':'open';
}
export function KimiActivityRow({ event, rooms = false }: { event: z.infer<typeof ListedActivity>; rooms?: boolean }) {
  const to=event.lifecycle==='draft'?'/activities/'+encodeURIComponent(event.id)+'/edit':rooms?'/tools/room-lab?eventId='+encodeURIComponent(event.id):'/activities/'+encodeURIComponent(event.id);
  let day='—', month='';
  try { if(event.timezone){const d=new Date(event.startsAt);day=new Intl.DateTimeFormat('zh-TW',{day:'numeric',timeZone:event.timezone}).formatToParts(d).find(p=>p.type==='day')?.value??'—';month=new Intl.DateTimeFormat('zh-TW',{month:'short',timeZone:event.timezone}).format(d);} } catch { /* Preserve original time below. */ }
  const status=listedActivityStatus(event), label=event.estimatedOver&&!event.archived?uiText('已過預定時間'):statuses.find(([value])=>value===status)?.[1]??event.phase;
  const mine=event.myRegistration;
  return <article className="activity-row"><div className="activity-date" aria-hidden="true"><strong>{day}</strong><span>{month}</span></div>
    <div className="activity-main"><div className="activity-title-line"><h2><Link to={to}>{event.title}</Link></h2><Badge>{event.category}</Badge></div>
      <div className="activity-meta"><span><Clock3 size={14}/>{activityDisplayDate(event.startsAt,event.timezone)}</span><span><MapPin size={14}/>{event.location}</span></div>
      {mine&&<div className="my-registration">我的報名 <Badge tone={mine==='confirmed'?'green':'amber'} dot>{mine==='confirmed'?'正式':mine==='waiting'?'候補':'待確認'}</Badge>{mine==='tentative'&&<Link to={'/activities/'+event.id+'/conditions'}>前往確認</Link>}</div>}
    </div><div className="activity-capacity"><span><UsersRound size={15}/><strong>{event.confirmed}</strong> / {event.capacity||'不限'}</span>{event.waiting>0&&<small>候補 {event.waiting} 人</small>}</div>
    <div className="activity-status"><Badge tone={status==='open'?'green':status==='ongoing'?'blue':status==='cancelled'?'red':'neutral'} dot>{label}</Badge>{event.visibility!=='public'&&<small>僅邀請可見</small>}</div>
    <Link className="row-arrow" to={to} aria-label={(rooms?'分析活動成分：':'查看活動：')+event.title}><ArrowUpRight size={18}/></Link></article>;
}
export function KimiActivitiesPage({ mine = false }: { mine?: boolean }) {
  const navigate=useNavigate();
  const session=useSession(),viewer=session.data,[params,setParams]=useSearchParams();
  const period=params.get('period')==='history'?'history':'upcoming',rooms=params.get('task')==='rooms';
  const parsed=ActivitiesQuery.safeParse({page:params.get('page')??'1',period,q:params.get('q')??'',status:params.get('status')??'all'});
  const queryValue=parsed.success?parsed.data:null;
  const [input,setInput]=useState(params.get('q')??'');useEffect(()=>setInput(params.get('q')??''),[params.get('q')]);
  const list=useQuery({queryKey:['private',viewer?.scope,'kimi-activities',mine,queryValue],refetchOnMount:'always',refetchInterval:30000,enabled:!!viewer&&!!queryValue&&(!mine||viewer.authenticated),queryFn:()=>{
    const http=scopedHttp(viewer!.scope),q=queryValue!;
    return mine?http.requestContract('GET /api/v2/me/activities',{query:{page:q.page,q:q.q,status:q.status}}):http.requestContract('GET /api/v2/activities',{query:q});
  }});
  const todos=useQuery({queryKey:['private',viewer?.scope,'inbox-todos',null],enabled:!!viewer?.authenticated,queryFn:()=>scopedHttp(viewer!.scope).requestContract('GET /api/v2/me/todos',{})});
  const change=(patch:Record<string,string>)=>{const next=new URLSearchParams(params);next.delete('page');for(const [key,value] of Object.entries(patch))value?next.set(key,value):next.delete(key);setParams(next);};
  const path=(target:string)=>target+(params.size?'?'+params:'');
  return <div className="kimi page activities-page"><PageHeader title={mine?'我的活動':rooms?'選擇活動分析成分':'活動'} actions={<Button onClick={()=>navigate('/activities/new')}><CalendarPlus size={17}/>新增活動</Button>}/>
    {list.data?.summary&&<div className="activity-overview" aria-label="活動摘要"><div><strong>{list.data.summary.upcoming}</strong><span>近期活動</span></div><i/><div>{list.data.summary.mine===null?<Link to="/me">登入查看</Link>:<strong>{list.data.summary.mine}</strong>}<span>與我有關</span></div><i/><div>{viewer?.authenticated?<strong>{todos.data?todos.data.todos.length:todos.error?'—':'…'}</strong>:<Link to="/me">登入查看</Link>}<span>我的待辦</span></div><Link to="/inbox">查看待辦<ArrowUpRight size={14}/></Link></div>}
    <div className="list-toolbar"><ActivityBrowseTabs value={mine?'mine':period==='history'?'past':'all'} onChange={value=>{if(value==='polls'){navigate('/time-polls');return;}const next=new URLSearchParams(params);next.delete('page');if(value==='past')next.set('period','history');else next.delete('period');if(value==='mine')next.delete('period');const target=value==='mine'?'/me/activities':'/activities';navigateTab(target,next);}}/>
      <form className="filter-row" role="search" onSubmit={event=>{event.preventDefault();change({q:input.trim()});}}><SearchInput value={input} onChange={value=>{setInput(value);if(!value)change({q:''});}} placeholder="搜尋活動或地點"/><button className="sr-only" type="submit">搜尋活動</button><Select value={queryValue?.status??'all'} onChange={event=>change({status:event.target.value})} aria-label="篩選活動狀態">{statuses.map(([value,label])=><option key={value} value={value}>{label}</option>)}</Select></form>
    </div>
    {!parsed.success?<Notice>活動篩選條件無效，請重新選擇。</Notice>:session.error?<Failure error={session.error} retry={()=>void session.refetch()}/>:mine&&!viewer?.authenticated?<Notice>請先<Link to="/login?returnTo=%2Fme%2Factivities">登入</Link>，再查看我的活動。</Notice>:list.isPending?<Notice>正在讀取活動…</Notice>:list.error?<Failure error={list.error} retry={()=>void list.refetch()}/>:<><div className="activity-list-header" aria-hidden="true"><span>活動安排</span><span>人數</span><span>狀態</span><span/></div><section className="activity-list" aria-label="活動列表">{list.data.events.map(event=><KimiActivityRow key={event.id} event={event} rooms={rooms}/>)}{!list.data.events.length&&<EmptyState title="沒有符合的活動" description="可清除搜尋或切換狀態篩選。"/>}</section><div className="pagination">{list.data.page>1&&<Button variant="secondary" onClick={()=>change({page:String(list.data.page-1)})}>上一頁</Button>}{list.data.hasMore&&<Button variant="secondary" onClick={()=>change({page:String(list.data.page+1)})}>下一頁</Button>}</div></>}
    {todos.error&&<Failure error={todos.error} retry={()=>void todos.refetch()}/>}<div className="main-only-links"><Link to="/me/activities/drafts">活動草稿</Link><Link to="/me/music">我的成分</Link>{mine&&<Link to={path('/activities')}>所有活動</Link>}</div>
  </div>;
  function navigateTab(target:string,next:URLSearchParams){navigate(target+(next.size?'?'+next:''));}
}
