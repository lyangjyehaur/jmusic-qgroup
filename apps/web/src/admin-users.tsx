import { errorText, uiText } from './language';
import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Heading, Surface, Text } from 'yahha-ui';
import { z } from 'zod';
import { AdminRoleHistory, AdminUser, AdminUsers, Ok, SaveAdminMetadata, SaveAdminRole, type Viewer } from '@qgroup/contracts';
import { AdminGate, adminHeaders, type Access } from './admin';
import { api, ApiError } from './api';
import { useDurableRecord } from './durable-record';
import { DraftFeedback } from './draft-feedback';
import { announceAccountChange } from './account-session';
import { Failure, Notice, PageIntro } from './shared';
type User = z.infer<typeof AdminUser>;
export function AdminDirectory() { return <><PageIntro title="使用者管理" /><Link className="back" to="/admin">管理後台</Link><AdminGate>{(viewer, access) => <Directory key={access.scope} viewer={viewer} access={access} />}</AdminGate></>; }
function Directory({ viewer, access }: { viewer: Viewer; access: Access }) {
  const [params, setParams] = useSearchParams(); const search = params.get('search') ?? ''; const unionid = params.get('unionid') ?? 'all'; const offset = Number(params.get('offset') ?? 0);
  const [input, setInput] = useState(search); useEffect(() => setInput(search), [search]);
  const query = new URLSearchParams({ search, unionid, offset: String(offset) });
  const users = useQuery({ queryKey: ['private', viewer.scope, 'admin-users', access.scope, query.toString()], queryFn: () => api('/admin/users?' + query, AdminUsers, { headers: { 'X-Account-Scope': viewer.scope } }) });
  function navigate(nextOffset = 0, nextSearch = input, nextFilter = unionid) { setParams({ search: nextSearch, unionid: nextFilter, offset: String(nextOffset) }); }
  return <><Surface className="detail"><form className="directory-search" onSubmit={event => { event.preventDefault(); navigate(); }}><label className="account-field">搜尋使用者<input type="search" value={input} onChange={event => setInput(event.target.value)} /></label><div className="account-field"><label htmlFor="admin-union-status">QQ／UnionID 狀態</label><select id="admin-union-status" value={unionid} onChange={event => navigate(0, search, event.target.value)}>{[['all', '全部'], ['bound', '已取得 UnionID'], ['missing', 'QQ 已綁定、缺少 UnionID'], ['unbound', '未綁定 QQ']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div><Button type="submit" disabled={Array.from(input.trim()).length > 100}>搜尋</Button></form></Surface>
    {users.isPending ? <Notice>正在讀取使用者…</Notice> : users.error ? <Failure error={users.error} retry={() => void users.refetch()} /> : <><Text role="status">共 {users.data.total} 個帳號</Text>{users.data.users.map(user => <Surface className="detail auth-panel" key={user.id}><Heading level={2}><Link to={'/admin/users/' + encodeURIComponent(user.id)}>{user.nickname || '未設定稱呼'}</Link></Heading><Text>帳號 ID：{user.id}</Text><Text>建立時間：{user.createdAt}</Text><Text>{user.isAdmin ? '管理員' : '一般會員'}</Text>{user.identities.map((identity, index) => <Text key={index}>{identity.provider}：{identity.displayName} · {identity.unionidBound ? '已取得 UnionID' : '缺少 UnionID'}</Text>)}{user.manualQQ && <Text>人工 QQ（未認證）：{user.manualQQ}</Text>}{user.note && <Text className="preserve-lines">內部備註：{user.note}</Text>}</Surface>)}{!users.data.users.length && <Notice>沒有符合條件的帳號。</Notice>}<div className="page-actions"><Button variant="secondary" disabled={offset <= 0} onClick={() => navigate(Math.max(0, offset - 20), search)}>上一頁</Button><Button variant="secondary" disabled={offset + 20 >= users.data.total} onClick={() => navigate(offset + 20, search)}>下一頁</Button></div></>}
  </>;
}
export function AdminUserPage() {
  const { id = '' } = useParams();
  return <><PageIntro title="帳號管理" /><Link to="/admin/music">核對成分關聯</Link><Link className="back" to="/admin/users">回到使用者管理</Link><AdminGate>{(viewer, access) => <UserLoader key={access.scope + ':' + id} id={id} viewer={viewer} access={access} />}</AdminGate></>;
}
function UserLoader({ id, viewer, access }: { id: string; viewer: Viewer; access: Access }) {
  const user = useQuery({ queryKey: ['private', viewer.scope, 'admin-user', access.scope, id], queryFn: () => api('/admin/users/' + encodeURIComponent(id), AdminUser, { headers: { 'X-Account-Scope': viewer.scope } }), refetchOnWindowFocus: false });
  return user.isPending ? <Notice>正在讀取帳號…</Notice> : user.error ? <Failure error={user.error} retry={() => void user.refetch()} /> : <UserEditor viewer={viewer} access={access} initial={user.data} />;
}
const Pending = z.discriminatedUnion('kind', [z.object({ kind: z.literal('role'), input: SaveAdminRole, key: z.string().uuid() }).strict(), z.object({ kind: z.literal('metadata'), input: SaveAdminMetadata, key: z.string().uuid() }).strict()]);
const Draft = z.object({ note: z.string(), manualQQ: z.string(), revision: z.number().int().min(0), pending: Pending.optional() }).strict();
function UserEditor({ viewer, access, initial }: { viewer: Viewer; access: Access; initial: User }) {
  const client = useQueryClient(); const path = '/admin/users/' + encodeURIComponent(initial.id);
  const storageKey = 'qgroup:rebuild:admin-user:v1:' + viewer.scope + ':' + access.scope + ':' + initial.id;
  const [user,setUser]=useState(initial),[confirmed,setConfirmed]=useState(false),[message,setMessage]=useState('');
  const record=useDurableRecord<z.infer<typeof Draft>>({key:storageKey,scope:viewer.scope,
    seed:()=>({note:user.note,manualQQ:user.manualQQ,revision:user.metadataRevision}),parse:raw=>Draft.parse(JSON.parse(raw)),
    dirty:value=>value.note!==user.note||value.manualQQ!==user.manualQQ||value.revision!==user.metadataRevision,pending:value=>!!value.pending});
  const {value:draft,replace:setDraft,busy,setBusy,active,dirty,locked,unavailable,begin,persist}=record;
  useEffect(()=>setConfirmed(false),[record.epoch]);
  const history = useInfiniteQuery({ queryKey: ['private', viewer.scope, 'admin-role-history', access.scope, initial.id], initialPageParam: null as number | null,
    queryFn: ({ pageParam }) => api(path + '/role-history' + (pageParam ? '?before=' + pageParam : ''), AdminRoleHistory, { headers: { 'X-Account-Scope': viewer.scope } }), getNextPageParam: page => page.nextCursor ?? undefined });
  async function save(kind:'role'|'metadata'){
    if(busy||unavailable)return;
    if(!draft.pending&&kind==='role'&&(!confirmed||access.currentUserId===user.id))return;
    const metadata=SaveAdminMetadata.safeParse({note:draft.note,manualQQ:draft.manualQQ,revision:draft.revision,confirm:true});
    if(!draft.pending&&kind==='metadata'&&!metadata.success)return;
    const operation=draft.pending??(kind==='role'?{kind,key:crypto.randomUUID(),input:{isAdmin:!user.isAdmin,revision:user.revision,confirm:true as const}}:{kind,key:crypto.randomUUID(),input:metadata.data!});
    const pending={...draft,pending:operation};
    if(!begin())return;if(!await persist(pending)||!active.current){if(active.current)setBusy(false);return;}
    setDraft(pending);setMessage('');let accepted=false;
    try{
      await api(path+'/'+operation.kind,Ok,{method:'POST',headers:{...adminHeaders(viewer,access),'Idempotency-Key':operation.key},body:JSON.stringify(operation.input)});accepted=true;
      const latest=await api(path,AdminUser,{headers:{'X-Account-Scope':viewer.scope}});
      const updated=operation.kind==='metadata'?{note:latest.note,manualQQ:latest.manualQQ,revision:latest.metadataRevision}:{...draft,pending:undefined};
      if(!active.current)return;if(!await persist(updated,false,uiText("操作已送出，但無法保存確認狀態；請保留原操作並核對結果。")))throw Error('storage');
      setDraft(updated);setUser(latest);setConfirmed(false);
      client.setQueryData(['private',viewer.scope,'admin-user',access.scope,initial.id],latest);
      void history.refetch();announceAccountChange();void client.invalidateQueries({queryKey:['private',viewer.scope,'admin-users']});
      setMessage(operation.kind==='role'?uiText("管理權限已保存，請核對目前狀態。"):uiText("備註已保存，請核對目前資料。"));
    }catch(error){
      if(!active.current)return;
      if(!accepted&&error instanceof ApiError&&error.status<500&&error.status!==429){const next={...pending,pending:undefined};if(await persist(next))setDraft(next);setConfirmed(false);setMessage(errorText(error));}
      else setMessage(uiText("尚未確認修改結果。原操作已保留，請按「確認修改結果」安全重試。"));
    }finally{if(active.current)setBusy(false);}
  }
  async function rebase(){
    if(locked||!begin())return;
    try{
      const latest=await api(path,AdminUser,{headers:{'X-Account-Scope':viewer.scope}}),next={...draft,revision:latest.metadataRevision};
      if(!active.current||!await persist(next))return;setUser(latest);setDraft(next);setConfirmed(false);setMessage(uiText("已取得目前資料，你的備註輸入仍保留；請核對後再保存。"));
    }catch(error){if(active.current)setMessage(error instanceof Error?errorText(error):uiText("讀取失敗"));}finally{if(active.current)setBusy(false);}
  }
  return <>
    <Surface className="detail auth-panel"><Heading level={2}>{user.nickname || '未設定稱呼'}</Heading><Text>帳號 ID：{user.id}</Text><Text>建立時間：{user.createdAt}</Text><Text role="status">管理權限：{user.isAdmin ? '管理員' : '一般會員'} · 版本 {user.revision}</Text>{user.identities.map((identity, index) => <Text key={index}>{identity.provider}：{identity.displayName} · {identity.unionidBound ? '已取得 UnionID' : '缺少 UnionID'}</Text>)}
    <label className="consent"><input type="checkbox" disabled={locked || access.currentUserId === user.id} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /><span>確認{user.isAdmin ? '撤銷' : '授予'}此帳號的管理權</span></label>{access.currentUserId === user.id && <Text>不能撤銷目前登入帳號的管理權，請由其他管理員操作。</Text>}<Button disabled={!confirmed || locked} loading={busy} onClick={() => void save('role')}>{user.isAdmin ? '撤銷管理權' : '授予管理權'}</Button></Surface>
    <Surface className="detail auth-panel"><Heading level={2}>內部備註與人工 QQ</Heading><Text>僅供後台核對；人工 QQ 未經認證，不能用於登入或成分認領。</Text><form onSubmit={event => { event.preventDefault(); void save('metadata'); }}><label className="account-field">人工 QQ<input value={draft.manualQQ} disabled={locked} onChange={event => record.change({ ...draft, manualQQ: event.target.value })} inputMode="numeric" /></label><div className="account-field"><label htmlFor="admin-user-note">內部備註</label><textarea id="admin-user-note" value={draft.note} disabled={locked} onChange={event => record.change({ ...draft, note: event.target.value })} rows={5} /></div><Text>備註最多 1000 字；QQ 可留空，或填 5–12 位數字。</Text><Button type="submit" loading={busy} disabled={locked || !dirty || !SaveAdminMetadata.safeParse({ note: draft.note, manualQQ: draft.manualQQ, revision: draft.revision, confirm: true }).success}>保存備註</Button></form></Surface>
    {message && <Notice>{message}</Notice>}{draft.pending ? <Button disabled={busy || unavailable} onClick={() => void save(draft.pending!.kind)}>確認修改結果</Button> : <Button variant="secondary" disabled={locked} onClick={() => void rebase()}>核對目前資料，保留輸入</Button>}
    <DraftFeedback form={record}/>
    <Surface className="detail auth-panel"><Heading level={2}>管理角色歷史</Heading>{history.isPending ? <Notice>正在讀取歷史…</Notice> : history.error ? <Failure error={history.error} retry={() => void history.refetch()} /> : history.data.pages[0]!.history.length ? <ol>{history.data.pages.flatMap(page => page.history).map(row => <li key={row.id}>{row.createdAt} · {row.actor} · {row.before ? '管理員' : '一般會員'} → {row.after ? '管理員' : '一般會員'} · 版本 {row.revision}</li>)}</ol> : <Text>尚無角色變更紀錄。</Text>}{history.hasNextPage && <Button variant="secondary" loading={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>較早角色紀錄</Button>}</Surface>
  </>;
}
