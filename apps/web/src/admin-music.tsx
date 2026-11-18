import { errorText, uiText } from './language';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Heading, Surface, Text } from 'yahha-ui';
import { z } from 'zod';
import { AdminMusicHistory, AdminMusicLinkPreview, AdminMusicProfile, AdminMusicProfiles, Ok, SaveMusicLink, type Viewer } from '@qgroup/contracts';
import { AdminGate, adminHeaders, type Access } from './admin';
import { api, ApiError } from './api';
import { announceAccountChange } from './account-session';
import { Failure, Notice, PageIntro } from './shared';
import { AdminMusicPin } from './admin-music-pin';
import { useDurableRecord } from './durable-record';
import { DraftFeedback } from './draft-feedback';
import { readAdminMusicProfile } from './admin-music-profile';
type Profile = z.infer<typeof AdminMusicProfile>;
function useAdminFailure(error: unknown, viewer: Viewer) {
  const client=useQueryClient();useEffect(()=>{if(error instanceof ApiError&&[401,403].includes(error.status))void client.invalidateQueries({queryKey:['private',viewer.scope,'admin-session']});},[error,client,viewer.scope]);
}
const statusLabels = { oauth: uiText("QQ 授權關聯"), prelinked: uiText("預先關聯"), unlinked: uiText("未關聯"), account: uiText("帳號成分") };
const ownerLabel = (owner: Profile['owner']) => owner ? `${owner.nickname}（${owner.id}）` : uiText('未關聯');
export function AdminMusicDirectory() {
  return <><PageIntro title="成分關聯" /><Link className="back" to="/admin">管理後台</Link><AdminGate>{(viewer, access) => <Directory key={access.scope} viewer={viewer} access={access} />}</AdminGate></>;
}
function Directory({ viewer, access }: { viewer: Viewer; access: Access }) {
  const [input, setInput] = useState(''); const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState({ search: '', status: 'all', offset: 0 });
  const query = useQuery({ queryKey: ['private', viewer.scope, 'admin-music', access.scope, search], queryFn: ({signal}) => api('/admin/music/search', AdminMusicProfiles, { signal, method: 'POST', headers: adminHeaders(viewer, access), body: JSON.stringify(search) }) });
  useAdminFailure(query.error,viewer);
  return <><Surface className="detail"><form className="directory-search" onSubmit={event => { event.preventDefault(); setSearch({ search: input, status: filter, offset: 0 }); }}>
    <label className="account-field">搜尋成分<input type="search" value={input} maxLength={100} onChange={event => setInput(event.target.value)} /></label>
    <label className="account-field">成分關聯狀態<select value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><Button type="submit">搜尋</Button>
  </form></Surface>{query.isPending ? <Notice>正在讀取成分…</Notice> : query.error ? <Failure error={query.error} retry={() => void query.refetch()} /> : <>
    <Text role="status">共 {query.data.total} 份成分</Text>{query.data.profiles.map(profile => <Surface className="detail auth-panel" key={profile.id}><Heading level={2}><Link to={'/admin/music/' + profile.id}>{profile.name}</Link></Heading><Text>成分 ID：{profile.id}</Text>{profile.legacyKey && <Text>舊成分查詢標識：{profile.legacyKey}</Text>}<Text>{profile.owner ? statusLabels[profile.status] + ' · ' + ownerLabel(profile.owner) : statusLabels[profile.status]}</Text><Text>原口令：{profile.hasPin ? '已設定' : '未設定'}</Text></Surface>)}
    {!query.data.total && <Notice>沒有符合條件的成分。</Notice>}<div className="page-actions"><Button variant="secondary" disabled={search.offset <= 0} onClick={() => setSearch({ ...search, offset: Math.max(0, search.offset - 20) })}>上一頁</Button><Button variant="secondary" disabled={search.offset + 20 >= query.data.total} onClick={() => setSearch({ ...search, offset: search.offset + 20 })}>下一頁</Button></div>
  </>}</>;
}
export function AdminMusicPage() {
  const { id = '' } = useParams();
  return <><PageIntro title="核對成分關聯" /><Link className="back" to="/admin/music">回到成分關聯</Link><AdminGate>{(viewer, access) => <Loader key={access.scope + ':' + id} id={id} viewer={viewer} access={access} />}</AdminGate></>;
}
function Loader({ id, viewer, access }: { id: string; viewer: Viewer; access: Access }) {
  const query = useQuery({ queryKey: ['private', viewer.scope, 'admin-music-profile', access.scope, id], queryFn: ({signal}) => readAdminMusicProfile('/admin/music/' + encodeURIComponent(id), viewer, signal), refetchOnWindowFocus: false });
  useAdminFailure(query.error,viewer);
  return query.isPending ? <Notice>正在讀取成分…</Notice> : query.error ? <Failure error={query.error} retry={() => void query.refetch()} /> : <Editor id={id} initial={query.data} viewer={viewer} access={access} />;
}
const Draft = z.object({ target: z.string(), reason: z.string(), pending: z.object({ key: z.string().uuid(), input: SaveMusicLink }).strict().optional() }).strict().refine(value=>!value.pending||(value.target.trim()||null)===value.pending.input.targetUserId&&value.reason.trim()===value.pending.input.reason);
function Editor({ id, initial, viewer, access }: { id: string; initial: Profile | null; viewer: Viewer; access: Access }) {
  const client = useQueryClient(); const path = '/admin/music/' + id;
  const storageKey = 'qgroup:rebuild:admin-music:v1:' + viewer.scope + ':' + access.scope + ':' + id;
  const [current, setCurrent] = useState(initial), [preview, setPreview] = useState<z.infer<typeof AdminMusicLinkPreview> | null>(null);
  const [confirmed, setConfirmed] = useState(false), [message, setMessage] = useState('');
  const [pinDirty, setPinDirty] = useState(!initial || /^[0-9]{4,12}$/.test(initial.legacyKey)), [pinBusy,setPinBusy] = useState(pinDirty);
  const fallback = () => ({ target: current?.owner?.id ?? '', reason: '' });
  const record=useDurableRecord<z.infer<typeof Draft>>({key:storageKey,scope:viewer.scope,seed:fallback,parse:raw=>Draft.parse(JSON.parse(raw)),dirty:value=>value.target!==(current?.owner?.id??'')||!!value.reason,pending:value=>!!value.pending,extraDirty:pinDirty});
  const {value:draft,replace:setDraft,busy,setBusy,active,locked,unavailable,begin,persist,blocker}=record;
  const ownershipDirty=record.dirty;
  useEffect(()=>{setPreview(null);setConfirmed(false);},[record.epoch]);
  useEffect(()=>{if(initial===null){setCurrent(null);setPreview(null);setConfirmed(false);}},[initial]);
  function failed(error:unknown){if(error instanceof ApiError&&[401,403].includes(error.status))void client.invalidateQueries({queryKey:['private',viewer.scope,'admin-session']});}
  async function loadPreview() {
    if (!current || locked || pinDirty || !begin()) return;
    setPreview(null); setConfirmed(false); setMessage('');
    try {
      if(!await persist(draft)||!active.current)return;
      const result = await api(path + '/link-preview', AdminMusicLinkPreview, { method: 'POST', headers: adminHeaders(viewer, access), body: JSON.stringify({ targetUserId: draft.target.trim() || null }) });
      if(active.current){setCurrent(result.profile);setPreview(result);}
    }catch(error){if(active.current){setMessage(error instanceof Error ? errorText(error) : uiText("無法取得預覽"));failed(error);}}finally{if(active.current)setBusy(false);}
  }
  async function save() {
    if (busy || pinDirty || unavailable) return;
    const parsed = SaveMusicLink.safeParse({ targetUserId: preview?.target?.id ?? null, revision: preview?.revision, reason: draft.reason, confirm: confirmed });
    if (!draft.pending && (!current || !preview || !parsed.success)) return;
    const operation = draft.pending ?? { key: crypto.randomUUID(), input: parsed.data! }, pending = { ...draft, pending: operation };
    if(!begin())return;if(!await persist(pending)||!active.current){if(active.current)setBusy(false);return;}
    setDraft(pending);setMessage('');let accepted=false;
    try {
      await api(path + '/link', Ok, { method: 'POST', headers: { ...adminHeaders(viewer, access), 'Idempotency-Key': operation.key }, body: JSON.stringify(operation.input) });accepted=true;
      if(!active.current)return;
      const latest = await readAdminMusicProfile(path, viewer);if(!active.current)return;
      const next = { target: latest?.owner?.id ?? '', reason: '' };if(!await persist(next,false,uiText("操作已送出，但無法保存確認狀態；請保留原操作並核對結果。")))return;
      setDraft(next);setCurrent(latest);setPreview(null);setConfirmed(false);
      client.setQueryData(['private', viewer.scope, 'admin-music-profile', access.scope, id], latest);
      void client.invalidateQueries({ queryKey: ['private', viewer.scope, 'admin-music'] });void client.invalidateQueries({ queryKey: ['private', viewer.scope, 'admin-music-history'] });
      void client.invalidateQueries({ queryKey: ['session'] });void client.invalidateQueries({ queryKey: ['private', viewer.scope, 'music'] });announceAccountChange();setMessage(latest ? uiText("關聯操作已完成，請核對目前成分與帳號。") : uiText("原關聯操作已完成；成分目前不存在或已刪除。"));
    }catch(error){if(!active.current)return;
      if(!accepted&&error instanceof ApiError&&error.status<500&&error.status!==429){const next={...pending,pending:undefined};if(await persist(next))setDraft(next);setPreview(null);setConfirmed(false);setMessage(errorText(error));}
      else setMessage(uiText("尚未確認關聯結果。原操作已保留，請按「確認關聯結果」安全重試。"));failed(error);
    }finally{if(active.current)setBusy(false);}
  }
  function edit(patch: Partial<z.infer<typeof Draft>>) { if(!current||locked||pinDirty)return;record.change({ ...draft, ...patch });setPreview(null);setConfirmed(false); }
  return <><DraftFeedback form={record} navigation={false}/>{blocker.state === 'blocked' && <Surface role="alert"><Text>{pinDirty ? '仍有未送出的口令或待確認操作；離開後口令不會保存。' : '仍有未保存的關聯草稿或待確認操作。'}</Text><Button onClick={() => blocker.reset()}>繼續編輯</Button><Button variant="secondary" disabled={busy||record.loading||pinBusy} onClick={() => void record.leave()}>{pinDirty ? '保留操作編號並離開' : '保留草稿並離開'}</Button></Surface>}
    <Surface className="detail auth-panel">{current ? <><Heading level={2}>{current.name}</Heading><Text>成分 ID：{current.id}</Text>{current.legacyKey && <Text>舊成分查詢標識：{current.legacyKey}</Text>}<Text>目前關聯：{ownerLabel(current.owner)}</Text>{current.owner && <Text>關聯狀態：{statusLabels[current.status]}</Text>}<Text>原口令：{current.hasPin ? '已設定' : '未設定'}</Text>
      <ul>{current.selections.map(selection => <li key={selection.entryId}>{selection.name}{selection.kind === 'sub' ? `${uiText(" · 程度 ")}${selection.level}` : ''}</li>)}</ul>
      <Link to={path+'/erase'}>刪除此成分</Link></> : <><Notice>成分不存在或已刪除。可核對原操作結果或保留本機原稿。</Notice><Text>成分 ID：{id}</Text></>}
      {current && <Link to="/admin/users" target="_blank" rel="noreferrer">查找目標帳號 ID</Link>}
      {(current || ownershipDirty) && <><label className="account-field">目標帳號 ID<input value={draft.target} maxLength={128} disabled={!current || locked || pinDirty} onChange={event => edit({ target: event.target.value })} /></label>{current && <Text>留空表示解除關聯。只修改這份成分的管理權，不合併帳號、報名或款項；已有成分的目標帳號不能覆蓋。</Text>}
      <div className="account-field"><label htmlFor="music-link-reason">核對原因</label><textarea id="music-link-reason" rows={3} value={draft.reason} maxLength={500} disabled={!current || locked || pinDirty} onChange={event => edit({ reason: event.target.value })} /></div>
      </>}{current && <Button variant="secondary" loading={busy} disabled={pinDirty || locked} onClick={() => void loadPreview()}>預覽關聯變更</Button>}
      {current && preview && <><Text>原帳號：{ownerLabel(preview.profile.owner)}</Text><Text>目標帳號：{ownerLabel(preview.target)}</Text><Text>原選擇、稱呼與聯絡資料保留。舊帳號的保存重試與找回授權將失效。</Text><label className="consent"><input type="checkbox" checked={confirmed} disabled={!current || locked || pinDirty} onChange={event => setConfirmed(event.target.checked)} /><span>確認已核對成分與目標帳號，執行此關聯變更</span></label><Button loading={busy} disabled={pinDirty || unavailable || busy || !confirmed || !draft.reason.trim()} onClick={() => void save()}>保存關聯變更</Button></>}
      {draft.pending && <Button loading={busy} disabled={pinDirty || unavailable || busy} onClick={() => void save()}>確認關聯結果</Button>}
      {ownershipDirty&&<Button variant="secondary" disabled={locked||pinDirty} onClick={()=>{record.change(fallback());setPreview(null);setConfirmed(false);}}>放棄關聯原稿</Button>}
      {message && <Text role="status">{message}</Text>}
    </Surface>{(!current || /^[0-9]{4,12}$/.test(current.legacyKey)) && <AdminMusicPin id={id} profile={current} viewer={viewer} access={access} disabled={ownershipDirty || busy || unavailable} onDirty={setPinDirty} onBusy={setPinBusy} onCurrent={profile => { setCurrent(profile); setPreview(null); setConfirmed(false); }} />}{current && <History id={id} viewer={viewer} access={access} />}
  </>;
}
function History({ id, viewer, access }: { id: string; viewer: Viewer; access: Access }) {
  const history = useInfiniteQuery({ queryKey: ['private', viewer.scope, 'admin-music-history', access.scope, id], initialPageParam: Number.MAX_SAFE_INTEGER,
    queryFn: ({ pageParam,signal }) => api('/admin/music/' + id + '/history?before=' + pageParam, AdminMusicHistory, { signal, headers: { 'X-Account-Scope': viewer.scope } }), getNextPageParam: page => page.nextCursor ?? undefined });
  useAdminFailure(history.error,viewer);
  return <Surface className="detail auth-panel"><Heading level={2}>關聯變更紀錄</Heading>{history.isPending ? <Notice>正在讀取紀錄…</Notice> : history.error ? <Failure error={history.error} retry={() => void history.refetch()} /> : <>
    {history.data.pages.flatMap(page => page.history).map(row => <div key={row.id}><Text>{row.createdAt} · {row.actor}</Text><Text>{row.beforeUserId ?? uiText('未關聯')} → {row.afterUserId ?? uiText('未關聯')}</Text><Text>{row.source === 'legacy' ? `${uiText("原關聯紀錄 #")}${row.legacyId}` : `${uiText("成分版本 ")}${row.revision}`}</Text>{row.reason && <Text className="preserve-lines">{row.reason}</Text>}</div>)}
    {!history.data.pages[0]?.history.length && <Notice>目前沒有關聯變更紀錄。</Notice>}{history.hasNextPage && <Button variant="secondary" loading={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>載入更多紀錄</Button>}
  </>}</Surface>;
}
