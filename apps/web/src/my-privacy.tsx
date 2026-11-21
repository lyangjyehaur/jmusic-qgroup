import { errorText, uiText } from './language';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Heading, Surface, Text } from 'yahha-ui';
import { z } from 'zod';
import { EraseData, ErasureResult, type Viewer } from '@qgroup/contracts';
import { ApiError } from './api';
import { authHttp, loginLink } from './auth';
import { createWebHttpClient, scopedHttp } from './http';
import { announceAccountChange, announceMusicErasure, clearDeviceDrafts } from './account-session';
import { Failure, Notice, PageIntro, sessionQuery } from './shared';
import { MemberErasure, type MemberErasureValue } from './erasure-record';
import { ErasureConflict } from './erasure-store';
import { ErasureStorageFeedback, useErasureLocal } from './erasure-local';
const Pending = z.object({ scope: z.string().regex(/^[a-f0-9]{64}$/), input: EraseData }).strict();
type PendingValue = z.infer<typeof Pending>;
type Result = z.infer<typeof ErasureResult>;
export function MyPrivacy() {
  const viewer = useQuery(sessionQuery), client = useQueryClient();
  const record = useErasureLocal<MemberErasureValue>('member', 'qgroup:rebuild:privacy-pending:v1', raw => MemberErasure.parse({ ...Pending.parse(JSON.parse(raw)), kind: 'member', result: null, cleaned: false }));
  const [error, setError] = useState(''), [notFound, setNotFound] = useState(false), [observed, setObserved] = useState<MemberErasureValue | null>(null);
  const operation = observed ?? record.value, result = operation?.result, busy = record.busy;
  const prior = useRef(record.value?.input.requestId);
  useEffect(() => { if (prior.current !== record.value?.input.requestId) { setObserved(null); setNotFound(false); prior.current = record.value?.input.requestId; } }, [record.value?.input.requestId]);
  useEffect(() => {
    if (!operation || result) return;
    const leave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', leave); return () => window.removeEventListener('beforeunload', leave);
  }, [operation, result]);
  async function finished(done: Result, original: MemberErasureValue) {
    if (!record.active.current) return;
    let completed = MemberErasure.parse({ ...original, result: done, cleaned: false }), saved = false;
    try { await record.save(completed); saved = true; } catch (failure) { if (failure instanceof ErasureConflict) { setError(errorText(failure)); return; } /* Still clear erased local data; retain original proof for receipt recovery. */ }
    if (!record.active.current) return;
    setObserved(completed); setNotFound(false); setError('');
    try {
      if (done.target === 'music') await announceMusicErasure(original.scope);
      else { try { await clearDeviceDrafts(); } finally { announceAccountChange(true); } }
      completed = { ...completed, cleaned: true }; setObserved(completed);
      if (saved) { try { await record.save(completed); } catch { saved = false; } }
      if (!saved) setError(uiText("伺服器刪除已完成，但無法保存本機確認狀態。請重新讀取原操作並查詢回執。"));
    } catch { setError(uiText("伺服器刪除已完成，但本機原稿清除失敗。請重試清除。")); }
    client.removeQueries({ queryKey: ['private'] });
    for (const key of ['music-catalog', 'music-trend', 'session']) void client.invalidateQueries({ queryKey: [key] });
  }
  async function submit(input: PendingValue, replay = false) {
    if (replay ? !record.value || !!record.value.result || !notFound : !!record.value) return;
    if (!record.begin()) return;
    setError(''); let sent = false;
    const original = replay ? record.value! : MemberErasure.parse({ ...input, kind: 'member', result: null, cleaned: false });
    try {
      await record.save(original);
      const current = await client.fetchQuery({ ...sessionQuery, staleTime: 0 });
      if (!record.active.current) return;
      if (!current.authenticated || current.scope !== original.scope) throw Error('請先登入原帳號；不會使用目前帳號提交刪除。');
      await record.assertCurrent();
      if (!record.active.current) return;
      sent = true;
      const done = await authHttp(current).requestContract('POST /api/v2/me/privacy/erase', { body: original.input });
      await finished(done, original);
    } catch (failure) {
      if (!record.active.current) return;
      if (sent && failure instanceof ApiError && failure.status < 500 && ![401, 403, 429].includes(failure.status)) {
        try { await record.save(null); setObserved(null); } catch { /* Keep original proof. */ }
        void client.invalidateQueries({ queryKey: ['private', original.scope, 'privacy'] }); setError(errorText(failure));
      } else setError(sent ? uiText("尚未確認刪除結果。請以原操作查詢回執。") : uiText("無法保存或核對原刪除紀錄，尚未提交刪除。") + (failure instanceof Error ? ' ' + errorText(failure) : ''));
    } finally { record.end(); }
  }
  async function check() {
    if (!record.value || !record.begin()) return;
    const original = record.value; setError(''); setNotFound(false);
    try {
      await record.assertCurrent();
      if (!record.active.current) return;
      const done = await createWebHttpClient().requestContract('POST /api/v2/privacy/receipt', { body: { requestId: original.input.requestId, secret: original.input.secret } });
      await finished(done, original);
    } catch (failure) {
      if (!record.active.current) return;
      if (failure instanceof ApiError && failure.status === 404) { setNotFound(true); setError(uiText("尚未找到完成紀錄。可稍後再查，或登入原帳號重新提交原刪除；不會使用目前帳號提交刪除。")); }
      else setError(uiText("尚未確認刪除結果。請重新讀取原操作後查詢。"));
    } finally { record.end(); }
  }
  async function dismiss() {
    if (!record.begin()) return;
    try { await record.save(null); setObserved(null); setError(''); setNotFound(false); }
    catch { setError(uiText("無法清除操作紀錄，原回執仍保留。請重新讀取後重試。")); }
    finally { record.end(); }
  }
  const acknowledged = !!result && !!operation?.cleaned && record.value?.result?.requestId === result.requestId && record.value.cleaned;
  return <><PageIntro title="隱私與資料刪除" /><div className="page-actions"><Link to="/me/accounts">回到帳號</Link><Link to="/privacy">隱私政策</Link><Link to="/me/privacy/consent">政策同意紀錄</Link></div>
    <ErasureStorageFeedback record={record} />
    {!record.ready ? <Notice>正在讀取刪除紀錄…</Notice> : record.error ? null : result ? <Surface className="detail auth-panel"><Heading level={2}>{result.target === 'music' ? '成分已刪除' : '帳號已關閉'}</Heading><Text>{result.status === 'shared_review' ? '身份與登入授權已移除；共享活動、帳務或歷史紀錄仍待人工審核，尚未全部刪除。' : result.target === 'music' ? '原成分 ID 已停用；重新建立會使用全新 ID。' : result.target === 'both' ? '帳號私人資料與成分已移除。' : '帳號私人資料已移除。'}</Text>{result.target === 'account' && <Text>原成分及其歷史仍保留，已解除帳號關聯。</Text>}<Button variant="secondary" disabled={!acknowledged || busy} onClick={() => void dismiss()}>完成</Button>{!acknowledged && <Button loading={busy} onClick={() => { if (record.begin()) void finished(result, operation!).finally(record.end); }}>重試清除本機原稿</Button>}</Surface> : record.value ? <Surface className="detail auth-panel"><Text>此裝置有待確認的刪除操作。查詢使用原操作編號；不會自動重新提交刪除。</Text><Button loading={busy} onClick={() => void check()}>確認刪除結果</Button>{notFound && <Button variant="secondary" disabled={busy} onClick={() => void submit(record.value!, true)}>重新提交原刪除</Button>}</Surface> : viewer.isPending ? <Notice>正在確認帳號…</Notice> : viewer.error ? <Failure error={viewer.error} retry={() => void viewer.refetch()} /> : !viewer.data.authenticated ? <Link to={loginLink('/me/privacy')}>登入</Link> : <PrivacyOptions key={viewer.data.scope} viewer={viewer.data} busy={busy} submit={input => void submit(input)} />}
    {error && <><Text role="alert">{error}</Text><Button variant="secondary" disabled={busy} onClick={() => { setObserved(null); void record.refresh(); }}>重新讀取原操作</Button></>}
  </>;
}
function PrivacyOptions({ viewer, busy, submit }: { viewer: Extract<Viewer, { authenticated: true }>; busy: boolean; submit: (value: PendingValue) => void }) {
  const summary = useQuery({ queryKey: ['private', viewer.scope, 'privacy'], queryFn: () => scopedHttp(viewer.scope).requestContract('GET /api/v2/me/privacy', {}) });
  const [target, setTarget] = useState<'music' | 'account' | 'both'>('music');
  const [confirmed, setConfirmed] = useState(false);
  if (summary.isPending) return <Notice>正在確認資料範圍…</Notice>;
  if (summary.error) return <Failure error={summary.error} retry={() => void summary.refetch()} />;
  const blocked = target !== 'music' && (summary.data.activeEvents > 0 || summary.data.activePolls > 0);
  const noProfile = target !== 'account' && !summary.data.profile;
  return <Surface className="detail auth-panel"><Heading level={2}>{viewer.nickname}</Heading><fieldset disabled={busy}><legend>刪除範圍</legend>{([['music', uiText('只刪除成分')], ['account', uiText('只關閉帳號')], ['both', uiText('關閉帳號並刪除成分')]] as const).map(([value, label]) => <label className="consent" key={value}><input type="radio" name="erase-target" checked={target === value} onChange={() => { setTarget(value); setConfirmed(false); }} />{label}</label>)}</fieldset>
    <Text>{target === 'music' ? '移除目前成分選擇與成分修改歷史，並清除此瀏覽器的成分草稿；保留帳號、活動與帳務。' : target === 'account' ? '撤銷所有裝置登入、QQ 綁定與管理權，清除此裝置的本機原稿。原成分及其歷史保留並解除關聯；共享活動、帳務或歷史紀錄另行審核。' : '刪除目前成分並撤銷所有裝置登入、QQ 綁定與管理權，清除此裝置的本機原稿；共享活動、帳務或歷史紀錄另行審核。'}</Text>
    {blocked && <Text role="alert">仍由你管理的活動 {summary.data.activeEvents} 個、時間投票 {summary.data.activePolls} 個；請先轉交、結束或取消，再關閉帳號。</Text>}
    {noProfile && <Text>目前沒有可刪除的成分。</Text>}
    <label className="consent"><input type="checkbox" checked={confirmed} disabled={busy || !!blocked || noProfile} onChange={event => setConfirmed(event.target.checked)} /><span>我已確認範圍，了解此操作無法復原</span></label>
    <Button disabled={!confirmed || !!blocked || noProfile} loading={busy} onClick={() => {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      submit({ scope: viewer.scope, input: { target, confirm: true, requestId: crypto.randomUUID(), secret: Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(''), profileId: summary.data.profile?.id ?? null, profileRevision: summary.data.profile?.revision ?? 0 } });
    }}>{target === 'music' ? '確認刪除成分' : target === 'account' ? '確認關閉帳號' : '確認關閉並刪除'}</Button>
  </Surface>;
}
