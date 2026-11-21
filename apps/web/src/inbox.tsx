import { errorText, uiText } from './language';
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Heading, Surface, Text } from 'yahha-ui';
import { z } from 'zod';
import { InboxTodos, MarkNotificationsRead, NotificationCount, Notifications, Ok, OperationReceipt } from '@qgroup/contracts';
import { ApiError } from './api';
import { createWebHttpClient } from './http';
import { authHttp } from './auth';
import { MemberAccess, type Member } from './member-access';
import { Failure, Notice, PageIntro } from './shared';
import { pendingOperations, type PendingOperation } from './pending-operations';
import { erasureInventory } from './erasure-store';
import { listDurableDrafts, listDurableVersions } from './draft-store';
import { useDurableValue } from './durable-record';
import { DraftFeedback } from './draft-feedback';
import { LegacyLocalLink } from './legacy-local';
const ReadOperation=z.object({key:z.string().uuid(),input:MarkNotificationsRead}).strict();
const scopedHttp=(viewer:Member)=>createWebHttpClient({context:()=>({scope:viewer.scope})});
const labels:Record<z.infer<typeof InboxTodos>['todos'][number]['kind'],string>={conditions:uiText("確認變更後的安排"),claims:uiText("核對報名認領"),withdrawal:uiText("處理退出申請"),formation:uiText("決定是否成團"),finish:uiText("確認活動結束／延長"),settlement:uiText("核對並發布結算"),reports:uiText("款項申報待核對"),payment:uiText("我的款項待補"),refund:uiText("我的退款／墊付待收回"),reconcile:uiText("核對收退款與結清")};
const destinations:Record<keyof typeof labels,string>={conditions:'conditions',claims:'claims',withdrawal:'registration',formation:'lifecycle',finish:'lifecycle',settlement:'?task=settlement',reports:'finance',payment:'finance',refund:'finance',reconcile:'finance'};
function TodoList({todos}:{todos:z.infer<typeof InboxTodos>['todos']}){
  const groups=new Map<string,typeof todos>();for(const todo of todos){const group=groups.get(todo.eventId);if(group)group.push(todo);else groups.set(todo.eventId,[todo]);}
  return <>{[...groups].map(([id,items])=><div key={id}><Heading level={3} className="inbox-event-title"><Link to={'/activities/'+encodeURIComponent(id)}>{items[0]!.title}</Link></Heading><ul className="inbox-list">{items.map(todo=>{const suffix=destinations[todo.kind],money=todo.amountCents===undefined?'':' · ¥'+(todo.amountCents/100).toFixed(2);return <li key={todo.kind}><Link to={'/activities/'+encodeURIComponent(id)+(suffix.startsWith('?')?'':'/')+suffix}>{todo.count?todo.count+' 筆':''}{labels[todo.kind]}{money}</Link></li>;})}</ul></div>)}</>;
}
export function InboxLink({viewer}:{viewer:Member}){
  const query=useQuery({queryKey:['private',viewer.scope,'notification-count'],queryFn:()=>scopedHttp(viewer).request('GET /api/v2/me/notifications/count',{},NotificationCount),refetchInterval:30000});
  return <Link to="/inbox">收件匣{query.error?'（讀取失敗）':query.data?.unreadCount?'（'+query.data.unreadCount+' 未讀）':''}</Link>;
}
export function InboxPage(){return <><PageIntro title="收件匣"/><LegacyLocalLink/><MemberAccess>{viewer=><Inbox key={viewer.scope} viewer={viewer}/>}</MemberAccess></>;}
function PendingOperations({viewer}:{viewer:Member}){
  const [inventory,setInventory]=useState<{rows:PendingOperation[];error:string}>({rows:[],error:''}),[results,setResults]=useState<Record<string,string>>({}),[busy,setBusy]=useState('');const active=useRef(true);
  async function read(){
    try {
      const [saved,versions,erasures]=await Promise.all([listDurableDrafts(viewer.scope),listDurableVersions(viewer.scope),erasureInventory(viewer.scope)]), values=new Map(saved.map(row=>[row.key,row.raw]));
      const keys=[...values.keys()], durable=pendingOperations({length:keys.length,key:i=>keys[i]??null,getItem:key=>values.get(key)??null},viewer.scope);
      for(const version of versions){
        const recovered=pendingOperations({length:1,key:()=>version.key,getItem:()=>version.raw},viewer.scope)[0];
        if(recovered&&!durable.some(row=>row.to===recovered.to&&row.requestKey&&row.requestKey===recovered.requestKey))
          durable.push({...recovered,id:version.id,label:recovered.label+uiText('（保全版本）')});
      }
      const session=pendingOperations(sessionStorage,viewer.scope).filter(row=>!values.has(row.id));
      if(active.current)setInventory({rows:[...session,...durable,...erasures],error:''});
    }catch{if(active.current)setInventory({rows:[],error:uiText('無法讀取本機保存的操作，請檢查瀏覽器儲存設定後重試。')});}
  }
  useEffect(()=>{active.current=true;const refresh=()=>{void read();};refresh();window.addEventListener('focus',refresh);return()=>{active.current=false;window.removeEventListener('focus',refresh);};},[viewer.scope]);
  async function check(row:PendingOperation){
    if(!row.requestKey||busy)return;setBusy(row.id);setResults(prior=>({...prior,[row.id]:''}));
    try{
      const receipt=await createWebHttpClient({context:()=>({scope:viewer.scope,adminScope:row.adminScope||undefined})}).request(row.adminScope?'GET /api/v2/admin/operations/:key':'GET /api/v2/me/operations/:key',{params:{key:row.requestKey}},OperationReceipt);
      if(active.current)setResults(prior=>({...prior,[row.id]:receipt.committed?uiText('此操作編號已有回執，請回原頁核對內容及目前權限。'):uiText('尚未查到此操作編號的回執，請回原頁確認原操作結果。')}));
    }catch(error){if(active.current)setResults(prior=>({...prior,[row.id]:error instanceof ApiError?errorText(error):uiText('無法讀取操作回執，請稍後重試。')}));}
    finally{if(active.current)setBusy('');}
  }
  if(!inventory.error&&!inventory.rows.length)return <div className="page-actions"><Button variant="secondary" onClick={()=>void read()}>重新檢查本機操作</Button></div>;
  return <Surface role="region" className="detail inbox-section" aria-label="未完成操作"><Heading level={2}>未完成操作</Heading>{inventory.error?<Notice>{inventory.error}</Notice>:inventory.rows.length?<><Notice>此清單包含目前帳號的本機操作及本分頁紀錄。回原頁核對結果後，才可重試。</Notice><ul className="inbox-list">{inventory.rows.map(row=><li key={row.id}><Link to={row.to}>{row.label}</Link>{row.damaged?<Text role="alert">原稿格式損壞，請回原頁保全原稿。</Text>:row.requestKey&&<Button variant="ghost" disabled={!!busy} onClick={()=>void check(row)}>核對結果</Button>}{results[row.id]&&<Text role="status">{results[row.id]}</Text>}</li>)}</ul></>:null}<Button variant="secondary" onClick={()=>void read()}>重新檢查本機操作</Button></Surface>;
}
function Inbox({viewer}:{viewer:Member}){
  const [search]=useSearchParams(),event=search.get('event'),client=useQueryClient(),storageKey='qgroup:rebuild:notifications-read:v1:'+viewer.scope;
  const record=useDurableValue<z.infer<typeof ReadOperation>|null>({
    key:storageKey,scope:viewer.scope,seed:()=>null,parse:raw=>ReadOperation.nullable().parse(JSON.parse(raw)),dirty:value=>!!value,pending:value=>!!value,
  });
  const {value:operation,replace:setOperation,busy,setBusy,active,locked,unavailable,begin,persist}=record;
  const [message,setMessage]=useState('');
  useEffect(()=>{setMessage('');},[record.epoch]);
  const notifications=useInfiniteQuery({queryKey:['private',viewer.scope,'notifications'],initialPageParam:null as string|null,queryFn:({pageParam})=>scopedHttp(viewer).request('GET /api/v2/me/notifications',{query:{before:pageParam||undefined}},Notifications),getNextPageParam:last=>last.nextBefore??undefined});
  const todos=useQuery({queryKey:['private',viewer.scope,'inbox-todos',event],queryFn:()=>scopedHttp(viewer).request('GET /api/v2/me/todos',{query:{event:event||undefined}},InboxTodos),refetchInterval:30000});
  const messages=notifications.data?.pages.flatMap(page=>page.notifications)??[];
  async function mark(ids:string[]){
    const pending=operation??{key:crypto.randomUUID(),input:MarkNotificationsRead.parse({ids})};if(!begin())return;
    setMessage('');let committed=false;
    try{
      if(!await persist(pending,false,uiText("無法保存已讀操作編號，尚未送出。"))||!active.current)return;
      setOperation(pending);
      await authHttp(viewer).request('POST /api/v2/me/notifications/read',{body:pending.input,requestId:pending.key,requestScope:viewer.scope},Ok);committed=true;
      if(!active.current||!await persist(null,false,uiText("已讀操作已送出，但無法保存本機確認狀態；請保留原操作並核對結果。")))return;
      setOperation(null);setMessage(uiText("通知已標為已讀；待辦仍按目前狀態計算。"));
      await client.invalidateQueries({queryKey:['private',viewer.scope,'notifications']});void client.invalidateQueries({queryKey:['private',viewer.scope,'notification-count']});
    }catch(error){
      if(!active.current)return;
      if(!committed&&error instanceof ApiError&&error.status<500&&error.status!==429){if(await persist(null,false,uiText("無法保存拒絕結果；原操作仍保留，請重新核對。")))setOperation(null);setMessage(errorText(error));}
      else setMessage(uiText("尚未確認已讀結果，原操作已保留，請確認原操作結果。"));
    }finally{if(active.current)setBusy(false);}
  }
  return <>{event&&<div className="page-actions"><Link to="/inbox">全部待辦</Link><Link to={'/activities/'+encodeURIComponent(event)}>回到活動</Link></div>}
    <PendingOperations viewer={viewer}/>
    <Surface role="region" className="detail inbox-section" aria-label="目前待辦"><Heading level={2}>目前待辦{todos.data?.eventTitle?' · '+todos.data.eventTitle:''}</Heading>{todos.isPending?<Notice>正在核對待辦…</Notice>:todos.error?<Failure error={todos.error} retry={()=>void todos.refetch()}/>:todos.data.todos.length?<TodoList todos={todos.data.todos}/>:<Text>目前沒有待辦事項。</Text>}<Button variant="secondary" disabled={todos.isFetching} onClick={()=>void todos.refetch()}>重新核對待辦</Button></Surface>
    <Surface role="region" className="detail inbox-section" aria-label="站內通知"><Heading level={2}>站內通知{notifications.data?' · '+notifications.data.pages[0]!.unreadCount+' 未讀':''}</Heading>
      <DraftFeedback form={record} navigation={false}/>
      {message&&<Text role="status">{message}</Text>}{operation&&<Notice>有一筆已讀操作的結果待確認。<Button disabled={busy||unavailable} onClick={()=>void mark([])}>確認原已讀操作結果</Button></Notice>}
      {notifications.isPending?<Notice>正在讀取通知…</Notice>:notifications.error&&!notifications.data?<Failure error={notifications.error} retry={()=>void notifications.refetch()}/>:<>{!messages.length?<Text>尚未收到站內通知。</Text>:<><Button variant="secondary" disabled={locked||!messages.some(n=>!n.readAt)} onClick={()=>void mark(messages.filter(n=>!n.readAt).slice(0,100).map(n=>n.id))}>將已載入的通知標為已讀（最多 100 筆）</Button><ul className="inbox-list">{messages.map(n=><li key={n.id}><Text className="preserve-lines">{n.message}</Text><Text tone="muted">{n.readAt?'已讀':'未讀'} · {n.createdAt.replace('T',' ')}</Text><Link to={'/activities/'+encodeURIComponent(n.eventId)}>查看活動</Link>{!n.readAt&&<Button variant="ghost" disabled={locked} onClick={()=>void mark([n.id])}>標為已讀</Button>}</li>)}</ul></>}{notifications.error&&<Failure error={notifications.error} retry={()=>void (notifications.isFetchNextPageError?notifications.fetchNextPage():notifications.refetch())}/>} {notifications.hasNextPage&&<Button variant="secondary" disabled={notifications.isFetching} onClick={()=>void notifications.fetchNextPage()}>載入更早通知</Button>}</>}
    </Surface></>;
}
