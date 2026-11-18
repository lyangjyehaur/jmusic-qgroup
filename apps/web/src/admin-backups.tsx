import { errorText, uiText } from './language';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Heading, Surface, Text } from 'yahha-ui';
import { AdminSession, ApiFailure, MusicBackups, type Viewer } from '@qgroup/contracts';
import { AdminGate, type Access } from './admin';
import { api, ApiError, apiFailureError } from './api';
import { Failure, Notice, PageIntro } from './shared';

export function AdminBackupsPage() {
  return <><PageIntro title="成分匯出與歷史備份" /><Link className="back" to="/admin">管理後台</Link><AdminGate>{(viewer, access) => <Downloads key={viewer.scope + ':' + access.scope} viewer={viewer} access={access} />}</AdminGate></>;
}
function Downloads({ viewer, access }: { viewer: Viewer; access: Access }) {
  const client = useQueryClient(), active = useRef(true), controller = useRef<AbortController | undefined>(undefined);
  const urls = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [confirmed, setConfirmed] = useState(false);
  const headers = { 'X-Account-Scope': viewer.scope };
  const list = useQuery({ queryKey: ['private', viewer.scope, 'admin-backups', access.scope], queryFn: ({ signal }) => api('/admin/backups', MusicBackups, { signal, headers }), refetchOnMount: 'always', refetchOnWindowFocus: 'always' });
  useEffect(() => { active.current = true; return () => { active.current = false; controller.current?.abort(); for (const [url, timer] of urls.current) { clearTimeout(timer); URL.revokeObjectURL(url); } urls.current.clear(); }; }, []);
  function denied(error: unknown) {
    if (!(error instanceof ApiError)) return;
    if (error.code === 'ACCOUNT_CHANGED') void client.invalidateQueries({ queryKey: ['session'] });
    if ([401, 403].includes(error.status)) void client.invalidateQueries({ queryKey: ['private', viewer.scope, 'admin-session'] });
  }
  useEffect(() => { denied(list.error); }, [list.error]);
  async function download(id?: string) {
    if (busy || !confirmed) return;
    setBusy(true); setMessage(''); const request = new AbortController(); controller.current = request;
    try {
      const response = await fetch('/api/v2/admin/music-export' + (id ? '?backup=' + encodeURIComponent(id) : ''), { credentials: 'same-origin', headers, signal: request.signal });
      if (!response.ok) { const failure = ApiFailure.safeParse(await response.json()); if (failure.success) throw apiFailureError(response.status, failure.data); throw new ApiError(response.status, 'DOWNLOAD_FAILED', '下載失敗，請重試'); }
      if (!response.headers.get('content-type')?.startsWith('application/json')) throw new Error('下載格式不符，請稍後重試。');
      const blob = await response.blob();
      // A late download must not survive an account switch or revoked authority.
      const fresh = await api('/admin/session', AdminSession, { headers, signal: request.signal });
      if (!active.current || request.signal.aborted) return;
      if (fresh.scope !== access.scope) { void client.invalidateQueries({ queryKey: ['private', viewer.scope, 'admin-session'] }); throw new Error('管理授權已變更，請重新確認後下載。'); }
      const url = URL.createObjectURL(blob), anchor = document.createElement('a');
      anchor.href = url; anchor.download = 'music-data-' + (id ?? new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')) + '.json';
      document.body.append(anchor); anchor.click(); anchor.remove();
      urls.current.set(url, setTimeout(() => { URL.revokeObjectURL(url); urls.current.delete(url); }, 1000));
      setMessage(uiText("已開始下載成分 JSON。"));
    } catch (error) { if (!active.current || request.signal.aborted) return; setMessage(error instanceof Error ? errorText(error) : uiText("下載失敗，請重試")); denied(error); }
    finally { if (active.current) { setBusy(false); controller.current = undefined; } }
  }
  return <><Surface className="detail auth-panel"><Text>JSON 含私人留言、聯絡號與成分口令雜湊，請妥善保存。歷史下載套用最新刪除、關聯與聯絡號；這份 JSON 不能完整恢復系統。</Text>
    <label className="consent"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} /><span>確認下載並保管私人資料</span></label>
    <Button disabled={!confirmed || busy} onClick={() => void download()}>下載目前成分 JSON</Button>{message && <Text role="status">{message}</Text>}
  </Surface><Surface className="detail auth-panel"><Heading level={2}>歷史備份</Heading><Button variant="secondary" disabled={busy || list.isFetching} onClick={() => void list.refetch()}>更新備份清單</Button>
    {list.isPending || !list.isFetchedAfterMount ? <Notice>正在讀取備份…</Notice> : list.error ? <Failure error={list.error} retry={() => void list.refetch()} /> : !list.data.available ? <Text>目前未啟用持久配對備份。</Text> : !list.data.backups.length ? <Text>尚無歷史備份；系統啟動、每小時及管理寫入前會建立配對備份。</Text> : <><Text>保留最近 30 份、最多 14 天。此處下載成分 JSON；完整配對備份由維運人員保管。</Text><ul className="history-list">{list.data.backups.map(item => <li key={item.id}><Text>{new Date(item.createdAt).toLocaleString('zh-TW')} · {(item.size / 1024).toFixed(1)} KiB</Text><Button variant="secondary" disabled={!confirmed || busy} onClick={() => void download(item.id)}>下載 {new Date(item.createdAt).toLocaleString('zh-TW')}</Button></li>)}</ul></>}
  </Surface></>;
}
