import { errorText, uiText } from './language';
import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Heading, Surface, Text } from 'yahha-ui';
import { z } from 'zod';
import { AdminPrivacyQueue, AdminPrivacyRequest, Ok, SavePrivacyReview, type Viewer } from '@qgroup/contracts';
import { AdminGate, adminHeaders, type Access } from './admin';
import { api, ApiError } from './api';
import { useDurableRecord } from './durable-record';
import { DraftFeedback } from './draft-feedback';
import { Failure, Notice, PageIntro } from './shared';
import { announceAccountChange } from './account-session';
type Request = z.infer<typeof AdminPrivacyRequest>;
const status = (request: Request) => request.status === 'completed' ? '已完成' : '共享紀錄待審';
export function AdminPrivacy() {
  return <><PageIntro title="刪除申請" /><Link className="back" to="/admin">管理後台</Link><AdminGate>{(viewer, access) => <Queue key={access.scope} viewer={viewer} access={access} />}</AdminGate></>;
}
function Queue({ viewer, access }: { viewer: Viewer; access: Access }) {
  const [params, setParams] = useSearchParams(); const offset = Number(params.get('offset') ?? 0);
  const queue = useQuery({ queryKey: ['private', viewer.scope, 'admin-privacy-queue', access.scope, offset], queryFn: () => api('/admin/privacy?offset=' + offset, AdminPrivacyQueue, { headers: { 'X-Account-Scope': viewer.scope } }) });
  return queue.isPending ? <Notice>正在讀取申請…</Notice> : queue.error ? <Failure error={queue.error} retry={() => void queue.refetch()} /> : <><Text role="status">共 {queue.data.total} 筆申請</Text>{queue.data.requests.map(request => <Surface className="detail auth-panel" key={request.id}><Heading level={2}><Link to={'/admin/privacy/' + encodeURIComponent(request.id)}>{request.id}</Link></Heading><Text>帳號 ID：{request.userId}</Text><Text>申請時間：{request.createdAt}</Text><Text>{status(request)}</Text>{request.note && <Text className="preserve-lines">處理說明：{request.note}</Text>}</Surface>)}{!queue.data.total && <Notice>目前沒有刪除申請。</Notice>}<div className="page-actions"><Button variant="secondary" disabled={offset <= 0} onClick={() => setParams({ offset: String(Math.max(0, offset - 20)) })}>上一頁</Button><Button variant="secondary" disabled={offset + 20 >= queue.data.total} onClick={() => setParams({ offset: String(offset + 20) })}>下一頁</Button></div></>;
}
export function AdminPrivacyReview() {
  const { id = '' } = useParams();
  return <><PageIntro title="處理刪除申請" /><Link className="back" to="/admin/privacy">回到刪除申請</Link><AdminGate>{(viewer, access) => <ReviewLoader key={access.scope + ':' + id} id={id} viewer={viewer} access={access} />}</AdminGate></>;
}
function ReviewLoader({ id, viewer, access }: { id: string; viewer: Viewer; access: Access }) {
  const request = useQuery({ queryKey: ['private', viewer.scope, 'admin-privacy-request', access.scope, id], queryFn: () => api('/admin/privacy/' + encodeURIComponent(id), AdminPrivacyRequest, { headers: { 'X-Account-Scope': viewer.scope } }), refetchOnWindowFocus: false });
  return request.isPending ? <Notice>正在讀取申請…</Notice> : request.error ? <Failure error={request.error} retry={() => void request.refetch()} /> : <ReviewForm initial={request.data} viewer={viewer} access={access} />;
}
const Draft = z.object({ note: z.string(), revision: z.string(), pending: z.object({ key: z.string().uuid(), input: SavePrivacyReview }).strict().optional() }).strict();
const labels: Record<string, string> = { events: uiText("活動"), registrations: uiText("舊報名"), roster_parties: uiText("同行組"), attendees: uiText("名冊"), event_audit: uiText("活動歷史"), attendee_consents: uiText("條件確認"), event_roles: uiText("活動權限"), management_invitations: uiText("管理邀請"), settlement_history: uiText("結算歷史"), finance_reports: uiText("帳務回報"), finance_report_actions: uiText("回報處理"), finance_entries: uiText("帳務明細"), attendee_claims: uiText("名冊認領"), attendee_payment_origins: uiText("付款責任"), time_polls: uiText("時間投票"), time_poll_history: uiText("投票歷史"), account_audit: uiText("帳號歷史"), admin_role_history: uiText("角色歷史"), music_profile_audit: uiText("成分歷史"), music_contact_history: uiText("聯絡 QQ 歷史"), bot_outbox: uiText("bot 私人通知紀錄"), music_ownership_history: uiText("成分關聯歷史"), music_pin_history: uiText("口令重設歷史"), music_field_history: uiText("成分資料歷史") };
function ReviewForm({ initial, viewer, access }: { initial: Request; viewer: Viewer; access: Access }) {
  const client = useQueryClient(); const path = '/admin/privacy/' + encodeURIComponent(initial.id);
  const storageKey = 'qgroup:rebuild:admin-privacy:v1:' + viewer.scope + ':' + access.scope + ':' + initial.id;
  const [request,setRequest]=useState(initial),[confirmed,setConfirmed]=useState(false),[message,setMessage]=useState('');
  const record=useDurableRecord<z.infer<typeof Draft>>({key:storageKey,scope:viewer.scope,
    seed:()=>({note:request.note,revision:request.revision}),parse:raw=>Draft.parse(JSON.parse(raw)),
    dirty:value=>value.note!==request.note||value.revision!==request.revision,pending:value=>!!value.pending});
  const {value:draft,replace:setDraft,busy,setBusy,active,locked,unavailable,begin,persist}=record;
  useEffect(()=>setConfirmed(false),[record.epoch]);
  async function save(){
    if(busy||unavailable)return;
    const input=SavePrivacyReview.safeParse({note:draft.note,revision:draft.revision,confirm:confirmed});
    if(!draft.pending&&!input.success)return;
    const operation=draft.pending??{key:crypto.randomUUID(),input:input.data!},pending={...draft,pending:operation};
    if(!begin())return;if(!await persist(pending)||!active.current){if(active.current)setBusy(false);return;}
    setDraft(pending);setMessage('');let accepted=false;
    try{
      await api(path+'/review',Ok,{method:'POST',headers:{...adminHeaders(viewer,access),'Idempotency-Key':operation.key},body:JSON.stringify(operation.input)});accepted=true;
      const latest=await api(path,AdminPrivacyRequest,{headers:{'X-Account-Scope':viewer.scope}}),next={note:latest.note,revision:latest.revision};
      if(!active.current)return;if(!await persist(next,false,uiText("操作已送出，但無法保存確認狀態；請保留原操作並核對結果。")))throw Error('storage');
      setDraft(next);setRequest(latest);setConfirmed(false);
      client.setQueryData(['private',viewer.scope,'admin-privacy-request',access.scope,initial.id],latest);announceAccountChange();
      void client.invalidateQueries({queryKey:['private',viewer.scope,'admin-privacy-queue']});setMessage(uiText("處理說明已保存，請核對目前狀態。"));
    }catch(error){
      if(!active.current)return;
      if(!accepted&&error instanceof ApiError&&error.status<500&&error.status!==429){const next={...pending,pending:undefined};if(await persist(next))setDraft(next);setConfirmed(false);setMessage(errorText(error));}
      else setMessage(uiText("尚未確認審核結果。原操作已保留，請按「確認審核結果」安全重試。"));
    }finally{if(active.current)setBusy(false);}
  }
  async function rebase(){
    if(locked||!begin())return;
    try{
      const latest=await api(path,AdminPrivacyRequest,{headers:{'X-Account-Scope':viewer.scope}}),next={...draft,revision:latest.revision};
      if(!active.current||!await persist(next))return;setRequest(latest);setDraft(next);setConfirmed(false);setMessage(uiText("已取得目前資料，處理說明仍保留；請核對後再保存。"));
    }catch(error){if(active.current)setMessage(error instanceof Error?errorText(error):uiText("讀取失敗"));}finally{if(active.current)setBusy(false);}
  }
  return <>
    <Surface className="detail auth-panel"><Heading level={2}>{request.id}</Heading><Text>帳號 ID：{request.userId}</Text><Text>申請時間：{request.createdAt}</Text><Text>更新時間：{request.updatedAt}</Text><Text role="status">申請狀態：{status(request)}</Text>
      {Object.keys(request.sharedRecords).length ? <><Text>以下共享紀錄仍保留。保存說明不會刪除這些紀錄，也不能將申請標為全部完成。</Text><ul>{Object.entries(request.sharedRecords).map(([table, count]) => <li key={table}>{labels[table] ?? table}：{count}</li>)}</ul></> : <Text>目前未檢出仍關聯此帳號的共享紀錄；保存處理說明後可完成申請。</Text>}
      <form onSubmit={event => { event.preventDefault(); void save(); }}><div className="account-field"><label htmlFor="privacy-review-note">處理說明</label><textarea id="privacy-review-note" rows={5} value={draft.note} disabled={locked} onChange={event => record.change({ ...draft, note: event.target.value })} /></div><Text>1–1000 字，僅管理員可見。請勿加入新的個人資料。</Text><label className="consent"><input type="checkbox" checked={confirmed} disabled={locked} onChange={event => setConfirmed(event.target.checked)} /><span>確認已核對目前保留範圍與處理說明</span></label><Button type="submit" loading={busy} disabled={locked || !SavePrivacyReview.safeParse({ note: draft.note, revision: draft.revision, confirm: confirmed }).success}>保存處理說明</Button></form>
    </Surface>{message && <Notice>{message}</Notice>}
    {draft.pending ? <Button disabled={busy || unavailable} onClick={() => void save()}>確認審核結果</Button> : <Button variant="secondary" disabled={locked} onClick={() => void rebase()}>核對目前範圍，保留說明</Button>}
    <DraftFeedback form={record}/>
  </>;
}
