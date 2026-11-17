import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Heading, Surface, Text } from 'yahha-ui';
import { z } from 'zod';
import { EraseData, ErasureResult, PrivacySummary, type Viewer } from '@qgroup/contracts';
import { api, ApiError } from './api';
import { authHeaders, loginLink } from './auth';
import { announceAccountChange, announceMusicErasure, clearDeviceDrafts } from './account-session';
import { Failure, Notice, PageIntro, sessionQuery } from './shared';

const storageKey = 'qgroup:rebuild:privacy-pending:v1';
const Pending = z.object({ scope: z.string().regex(/^[a-f0-9]{64}$/), input: EraseData }).strict();
type PendingValue = z.infer<typeof Pending>;
type Result = z.infer<typeof ErasureResult>;
export function MyPrivacy() {
  const viewer = useQuery(sessionQuery);
  const client = useQueryClient();
  const [loaded] = useState(() => {
    try { const raw = sessionStorage.getItem(storageKey); return { value: raw ? Pending.parse(JSON.parse(raw)) : null, error: '' }; }
    catch { return { value: null, error: '此分頁的刪除操作紀錄無法讀取；原始內容已保留，請先保全紀錄。' }; }
  });
  const [pending, setPending] = useState<PendingValue | null>(loaded.value);
  const [readError, setReadError] = useState(loaded.error);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  useEffect(() => {
    if (!pending || result) return;
    const leave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', leave); return () => window.removeEventListener('beforeunload', leave);
  }, [pending, result]);
  async function finished(done: Result, operation: PendingValue) {
    setResult(done); setError('');
    if (done.target === 'music') announceMusicErasure(operation.scope);
    else { clearDeviceDrafts(); announceAccountChange(true); }
    client.removeQueries({ queryKey: ['private'] });
    await client.invalidateQueries({ queryKey: ['music-catalog'] });
    await client.invalidateQueries({ queryKey: ['music-trend'] });
    await client.invalidateQueries({ queryKey: ['session'] });
  }
  async function submit(operation: PendingValue, recovering = false) {
    if (busy) return;
    setBusy(true); setError('');
    try {
      // Persistence must succeed before the first destructive request.
      sessionStorage.setItem(storageKey, JSON.stringify(operation)); setPending(operation);
      if (recovering) {
        try {
          const done = await api('/privacy/receipt', ErasureResult, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: operation.input.requestId, secret: operation.input.secret }) });
          await finished(done, operation); return;
        } catch (failure) { if (!(failure instanceof ApiError) || failure.status !== 404) throw failure; }
      }
      const current = await client.fetchQuery({ ...sessionQuery, staleTime: 0 });
      if (!current.authenticated || current.scope !== operation.scope) throw new Error('尚未找到結果。請先登入原帳號，再回此頁確認；不會使用目前帳號提交刪除。');
      const done = await api('/me/privacy/erase', ErasureResult, { method: 'POST', headers: authHeaders(current), body: JSON.stringify(operation.input) });
      await finished(done, operation);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status < 500 && failure.status !== 429) {
        try { sessionStorage.removeItem(storageKey); setPending(null); } catch { /* Keep the original operation recoverable. */ }
        void client.invalidateQueries({ queryKey: ['private', operation.scope, 'privacy'] });
        setError(failure.message);
      } else setError(failure instanceof DOMException ? '瀏覽器無法保存操作紀錄，尚未提交刪除。請允許本站儲存後重試。' : '尚未確認刪除結果。請保留此分頁，按「確認刪除結果」查詢或安全重試。' + (failure instanceof Error && recovering ? ' ' + failure.message : ''));
    } finally { setBusy(false); }
  }
  function dismiss() {
    try { sessionStorage.removeItem(storageKey); setPending(null); setResult(null); setError(''); }
    catch { setError('無法清除此分頁的操作紀錄，請檢查瀏覽器儲存設定。'); }
  }
  return <><PageIntro title="隱私與資料刪除" /><div className="page-actions"><Link to="/me/accounts">回到帳號</Link><Link to="/privacy">隱私政策</Link></div>
    {readError ? <Surface role="alert"><Text>{readError}</Text><Button onClick={() => {
      try { const raw = sessionStorage.getItem(storageKey); if (raw !== null) sessionStorage.setItem(storageKey + ':recovery:' + Date.now(), raw); sessionStorage.removeItem(storageKey); setReadError(''); }
      catch { setError('仍無法保全紀錄，請檢查瀏覽器儲存設定。'); }
    }}>保全原紀錄後繼續</Button></Surface> : result ? <Surface className="detail auth-panel"><Heading level={2}>{result.target === 'music' ? '成分已刪除' : '帳號已關閉'}</Heading><Text>{result.status === 'shared_review' ? '身份與登入授權已移除；共享活動、帳務或歷史紀錄仍待人工審核，尚未全部刪除。' : result.target === 'music' ? '原成分 ID 已停用；重新建立會使用全新 ID。' : result.target === 'both' ? '帳號私人資料與成分已移除。' : '帳號私人資料已移除。'}</Text>{result.target === 'account' && <Text>原成分及其歷史仍保留，已解除帳號關聯。</Text>}<Button variant="secondary" onClick={dismiss}>完成</Button></Surface> : pending ? <Surface className="detail auth-panel"><Text>此分頁有待確認的刪除操作。確認結果會使用原操作編號；不會刪除目前其他帳號的資料。</Text><Button loading={busy} onClick={() => void submit(pending, true)}>確認刪除結果</Button></Surface> : viewer.isPending ? <Notice>正在確認帳號…</Notice> : viewer.error ? <Failure error={viewer.error} retry={() => void viewer.refetch()} /> : !viewer.data.authenticated ? <Link to={loginLink('/me/privacy')}>登入</Link> : <PrivacyOptions key={viewer.data.scope} viewer={viewer.data} busy={busy} submit={operation => void submit(operation)} />}
    {error && <Text role="alert">{error}</Text>}
  </>;
}
function PrivacyOptions({ viewer, busy, submit }: { viewer: Extract<Viewer, { authenticated: true }>; busy: boolean; submit: (value: PendingValue) => void }) {
  const summary = useQuery({ queryKey: ['private', viewer.scope, 'privacy'], queryFn: () => api('/me/privacy', PrivacySummary, { headers: { 'X-Account-Scope': viewer.scope } }) });
  const [target, setTarget] = useState<'music' | 'account' | 'both'>('music');
  const [confirmed, setConfirmed] = useState(false);
  if (summary.isPending) return <Notice>正在確認資料範圍…</Notice>;
  if (summary.error) return <Failure error={summary.error} retry={() => void summary.refetch()} />;
  const blocked = target !== 'music' && (summary.data.activeEvents > 0 || summary.data.activePolls > 0);
  const noProfile = target !== 'account' && !summary.data.profile;
  return <Surface className="detail auth-panel"><Heading level={2}>{viewer.nickname}</Heading><fieldset disabled={busy}><legend>刪除範圍</legend>{([['music', '只刪除成分'], ['account', '只關閉帳號'], ['both', '關閉帳號並刪除成分']] as const).map(([value, label]) => <label className="consent" key={value}><input type="radio" name="erase-target" checked={target === value} onChange={() => { setTarget(value); setConfirmed(false); }} />{label}</label>)}</fieldset>
    <Text>{target === 'music' ? '移除目前成分選擇與成分修改歷史，並清除此瀏覽器的成分草稿；保留帳號、活動與帳務。' : target === 'account' ? '撤銷所有裝置登入、QQ 綁定與管理權，清除此裝置的分頁草稿。原成分及其歷史保留並解除關聯；共享活動、帳務或歷史紀錄另行審核。' : '刪除目前成分並撤銷所有裝置登入、QQ 綁定與管理權，清除此裝置的分頁草稿；共享活動、帳務或歷史紀錄另行審核。'}</Text>
    {blocked && <Text role="alert">仍由你管理的活動 {summary.data.activeEvents} 個、時間投票 {summary.data.activePolls} 個；請先轉交、結束或取消，再關閉帳號。</Text>}
    {noProfile && <Text>目前沒有可刪除的成分。</Text>}
    <label className="consent"><input type="checkbox" checked={confirmed} disabled={busy || !!blocked || noProfile} onChange={event => setConfirmed(event.target.checked)} /><span>我已確認範圍，了解此操作無法復原</span></label>
    <Button disabled={!confirmed || !!blocked || noProfile} loading={busy} onClick={() => {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      submit({ scope: viewer.scope, input: { target, confirm: true, requestId: crypto.randomUUID(), secret: Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(''), profileId: summary.data.profile?.id ?? null, profileRevision: summary.data.profile?.revision ?? 0 } });
    }}>{target === 'music' ? '確認刪除成分' : target === 'account' ? '確認關閉帳號' : '確認關閉並刪除'}</Button>
  </Surface>;
}
