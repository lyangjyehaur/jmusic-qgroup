import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Surface, Text } from 'yahha-ui';
import { z } from 'zod';
import { PrivacyConsent, PrivacyConsentReceipt } from '@qgroup/contracts';
import { api, ApiError } from './api';
import { authHeaders } from './auth';
import { announceAccountChange } from './account-session';
import { MemberAccess, type Member } from './member-access';
import { Failure, Notice, PageIntro, sessionQuery } from './shared';
import { useDurableRecord } from './durable-record';
import { DraftFeedback } from './draft-feedback';
import { errorText, uiText } from './language';
import { PendingPrivacyConsent as Pending, parsePrivacyConsent } from './privacy-consent-record';

type Intent = z.infer<typeof Pending>;
export function PrivacyConsentPage() {
  return <><PageIntro title="政策同意紀錄" /><div className="page-actions"><Link to="/me/accounts">回到帳號</Link><Link to="/me/privacy">隱私與資料刪除</Link></div>
    <MemberAccess>{viewer => <ConsentForm key={viewer.scope} viewer={viewer} />}</MemberAccess></>;
}
function ConsentForm({ viewer }: { viewer: Member }) {
  const client = useQueryClient(), [checkedVersion, setCheckedVersion] = useState<string | null>(null), [missing, setMissing] = useState(false);
  const status = useQuery({ queryKey: ['private', viewer.scope, 'privacy-consent'], queryFn: () => api('/me/privacy/consent', PrivacyConsent, { headers: { 'X-Account-Scope': viewer.scope } }) });
  const record = useDurableRecord<Intent | null>({ key: 'qgroup:rebuild:privacy-consent:v1:' + viewer.scope, scope: viewer.scope, seed: () => null,
    parse: raw => parsePrivacyConsent(raw, viewer.scope), dirty: value => !!value, pending: value => !!value });
  const pending = record.value;
  const checked = !!status.data && checkedVersion === status.data.version;
  async function originalAccount(intent: Intent) {
    const current = await client.fetchQuery({ ...sessionQuery, staleTime: 0 });
    if (!current.authenticated || current.scope !== intent.scope) throw Error('請先登入原帳號；不會替目前帳號提交或查詢原同意。');
    return current;
  }
  async function finish(done: z.infer<typeof PrivacyConsentReceipt>, intent: Intent) {
    if (done.requestKey !== intent.key || done.version !== intent.input.privacyVersion) throw Error('同意回執與原操作不一致，請保留原紀錄後重新查詢。');
    if (!record.active.current) return;
    if (!await record.persist(null, false, uiText('同意已完成，但無法保存本機確認狀態；請保留原操作並查詢結果。'))) return;
    record.replace(null); setCheckedVersion(null); setMissing(false);
    announceAccountChange();
    await status.refetch();
    void client.invalidateQueries({ queryKey: ['session'] });
    record.setMessage(uiText('原版本的同意已完成。請核對目前版本與同意時間。'));
  }
  async function submit(retry = false) {
    if (retry ? !pending || !missing : !!pending || !checked || !status.data || status.data.accepted) return;
    if (!record.begin()) return;
    const intent = pending ?? Pending.parse({ scope: viewer.scope, key: crypto.randomUUID(), input: { acceptPrivacy: true, privacyVersion: status.data!.version } });
    record.setMessage(''); let sent = false;
    try {
      if (!await record.persist(intent) || !record.active.current) return;
      record.replace(intent); setCheckedVersion(null); setMissing(false);
      const current = await originalAccount(intent);
      if (!record.active.current) return;
      if (current.privacyVersion !== intent.input.privacyVersion) throw Error('隱私政策版本已變更；請先查詢原同意結果，再閱讀目前版本並重新確認。');
      sent = true;
      const done = await api('/me/privacy/consent', PrivacyConsentReceipt, { method: 'POST', headers: { ...authHeaders(current), 'Idempotency-Key': intent.key }, body: JSON.stringify(intent.input) });
      await finish(done, intent);
    } catch (failure) {
      if (record.active.current) record.setMessage(sent ? uiText('尚未確認同意結果。原操作已保留，請先查詢結果。') + (failure instanceof ApiError && failure.status < 500 ? ' ' + errorText(failure) : '') : failure instanceof Error ? errorText(failure) : uiText('尚未送出同意，請核對原紀錄。'));
    } finally { if (record.active.current) record.setBusy(false); }
  }
  async function check() {
    if (!pending || !record.begin()) return;
    setMissing(false); record.setMessage('');
    try {
      if (!await record.persist(pending) || !record.active.current) return;
      const current = await originalAccount(pending);
      if (!record.active.current) return;
      const done = await api('/me/privacy/consent/receipts/' + pending.key, PrivacyConsentReceipt, { headers: { 'X-Account-Scope': current.scope } });
      await finish(done, pending);
    } catch (failure) {
      if (!record.active.current) return;
      if (failure instanceof ApiError && failure.status === 404) { setMissing(true); record.setMessage(uiText('尚未找到原同意的完成紀錄。可再查詢，或登入原帳號重新提交原同意。')); }
      else record.setMessage(failure instanceof Error ? errorText(failure) : uiText('無法確認同意結果，原操作仍保留。'));
    } finally { if (record.active.current) record.setBusy(false); }
  }
  async function reset() {
    if (!pending || !missing || !record.begin()) return;
    try {
      // Archive the exact old version/key; a new checkbox is always unchecked.
      if (!await record.persist(null, true) || !record.active.current) return;
      record.replace(null); setMissing(false); setCheckedVersion(null); await record.refreshVersions(); await status.refetch();
      record.setMessage(uiText('原操作已保全。請閱讀目前版本後重新勾選確認。'));
    } finally { if (record.active.current) record.setBusy(false); }
  }
  return <Surface className="detail auth-panel"><Text>{viewer.nickname}</Text>
    <Link to="/privacy" target="_blank" rel="noreferrer">閱讀統一隱私政策</Link>
    {status.isPending ? <Notice>正在讀取同意紀錄…</Notice> : status.error ? <Failure error={status.error} retry={() => void status.refetch()} /> : <>
      <dl><dt>目前版本</dt><dd>{status.data.version}</dd><dt>同意狀態</dt><dd>{status.data.accepted ? '已同意' : '尚未同意'}</dd>{status.data.acceptedAt && <><dt>同意時間</dt><dd>{status.data.acceptedAt}</dd></>}</dl>
      {!pending && !status.data.accepted && <form onSubmit={event => { event.preventDefault(); void submit(); }}>
        <label className="consent"><input type="checkbox" checked={checked} disabled={record.locked} onChange={event => setCheckedVersion(event.target.checked ? status.data.version : null)} />我已閱讀並同意目前版本的統一隱私政策</label>
        <Button type="submit" loading={record.busy} disabled={!checked || record.unavailable}>確認同意</Button>
      </form>}
    </>}
    {pending && <><Text>待確認版本：{pending.input.privacyVersion}</Text><Text>本機保留原同意操作；載入頁面不會自動重新提交。</Text>
      <Button disabled={record.unavailable} loading={record.busy} onClick={() => void check()}>查詢原同意結果</Button>
      {missing && <><Button variant="secondary" disabled={record.busy || record.unavailable} onClick={() => void submit(true)}>重新提交原同意</Button>
        <Button variant="secondary" disabled={record.busy || record.unavailable} onClick={() => void reset()}>保全原操作並重新確認</Button></>}
    </>}
    <DraftFeedback form={record} />
  </Surface>;
}
