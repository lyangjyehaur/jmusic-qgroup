import { useState } from 'react';
import { useDurableRecord } from './durable-record';
import { DraftFeedback } from './draft-feedback';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Surface, Text } from 'yahha-ui';
import { z } from 'zod';
import { AccountProfile, SaveNickname, type Viewer } from '@qgroup/contracts';
import { api, ApiError } from './api';
import { authHeaders, loginLink } from './auth';
import { announceAccountChange } from './account-session';
import { Failure, Notice, PageIntro, sessionQuery } from './shared';

const Draft = z.object({ nickname: z.string().max(200), revision: z.number().int().min(0), requestKey: z.string().uuid().optional() }).strict();
type Value = z.infer<typeof AccountProfile>;
export function AccountProfilePage() {
  const session = useQuery(sessionQuery);
  return <><PageIntro title="站內稱呼" /><Link className="back" to="/me/accounts">回到帳號</Link>{session.isPending ? <Notice>正在確認帳號…</Notice> : session.error ? <Failure error={session.error} retry={() => void session.refetch()} /> : !session.data.authenticated ? <Link to={loginLink('/me/profile')}>登入</Link> : <ProfileLoader key={session.data.scope} viewer={session.data} />}</>;
}
function ProfileLoader({ viewer }: { viewer: Viewer }) {
  const profile = useQuery({ queryKey: ['private', viewer.scope, 'account-profile'], queryFn: () => api('/me/profile', AccountProfile, { headers: { 'X-Account-Scope': viewer.scope } }) });
  return profile.isPending ? <Notice>正在讀取稱呼…</Notice> : profile.error ? <Failure error={profile.error} retry={() => void profile.refetch()} /> : <NicknameEditor viewer={viewer} initial={profile.data} />;
}
function NicknameEditor({ viewer, initial }: { viewer: Viewer; initial: Value }) {
  const queryClient = useQueryClient();
  const storageKey = 'qgroup:rebuild:account-profile:v1:' + viewer.scope;
  const [saved, setSaved] = useState(initial), [message, setMessage] = useState('');
  const record = useDurableRecord<z.infer<typeof Draft>>({key:storageKey,scope:viewer.scope,seed:()=>saved,
    parse:raw=>Draft.parse(JSON.parse(raw)),dirty:value=>value.nickname!==saved.nickname||value.revision!==saved.revision,pending:value=>!!value.requestKey});
  const {value:draft,replace:setDraft,busy:sending,setBusy:setSending,active,dirty,locked,persist,begin,unavailable}=record;
  async function save() {
    if (sending || unavailable) return;
    const parsed = SaveNickname.safeParse({ nickname: draft.nickname, revision: draft.revision });
    if (!parsed.success) { setMessage('稱呼須為 1–24 字，不能包含控制字元。'); return; }
    const pending = { ...parsed.data, requestKey: draft.requestKey ?? crypto.randomUUID() };
    if(!begin())return;if(!await persist(pending)||!active.current){if(active.current)setSending(false);return;}
    setDraft(pending); setMessage('');let accepted=false;
    try {
      const result = await api('/me/profile', AccountProfile, { method: 'PUT', headers: { ...authHeaders(viewer), 'Idempotency-Key': pending.requestKey }, body: JSON.stringify(parsed.data) });accepted=true;
      const latest = await api('/me/profile', AccountProfile, { headers: { 'X-Account-Scope': viewer.scope } });
      if(!active.current)return;if(!await persist(latest,false,'操作已送出，但無法保存確認狀態；請保留原操作並核對結果。'))throw Error('storage');
      setSaved(latest); setDraft(latest);
      queryClient.setQueryData(['private', viewer.scope, 'account-profile'], latest);
      announceAccountChange();
      void queryClient.invalidateQueries({ queryKey: ['session'] });
      void queryClient.invalidateQueries({ queryKey: ['private', viewer.scope, 'music-trend-members'] });
      void queryClient.invalidateQueries({ queryKey: ['private', viewer.scope, 'music-circles'] });
      void queryClient.invalidateQueries({ queryKey: ['private', viewer.scope, 'accounts'] });
      setMessage(latest.revision === result.revision ? '已保存稱呼。' : '原操作已保存，目前稱呼已再次變更；請核對目前資料。');
    } catch (failure) {
      if(!active.current)return;
      if (!accepted && failure instanceof ApiError && failure.status < 500 && failure.status !== 429) {
        const next={ nickname: pending.nickname, revision: pending.revision };if(await persist(next))setDraft(next);
        setMessage(failure.message);
      } else setMessage('尚未確認修改結果。操作編號已保留，請按「確認修改結果」安全重試。');
    } finally { if(active.current)setSending(false); }
  }
  async function rebase() {
    if(locked||!begin())return;
    try {
      const latest = await api('/me/profile', AccountProfile, { headers: { 'X-Account-Scope': viewer.scope } });
      const next = { nickname: draft.nickname, revision: latest.revision };
      if(!active.current||!await persist(next))return;
      setSaved(latest); setDraft(next); setMessage('已取得目前稱呼；你的輸入仍保留，請核對後再保存。');
    } catch (failure) { if(active.current)setMessage(failure instanceof Error ? failure.message : '讀取失敗'); }
    finally { if(active.current)setSending(false); }
  }
  return <>
    <Surface className="detail auth-panel"><form onSubmit={event => { event.preventDefault(); void save(); }}>
      <Text>目前稱呼：{saved.nickname}</Text><label className="account-field">站內稱呼<input value={draft.nickname} maxLength={48} autoComplete="nickname" disabled={locked} onChange={event => { record.change({ ...draft, nickname: event.target.value }); setMessage(''); }} aria-describedby="nickname-help" /></label>
      <Text id="nickname-help">1–24 字。修改會更新名冊顯示，不更換帳號，也不修改 QQ 暱稱、付款歸屬或既有帳單。</Text>
      <Button type="submit" loading={sending} disabled={!dirty || unavailable || !SaveNickname.safeParse({ nickname: draft.nickname, revision: draft.revision }).success}>{draft.requestKey ? '確認修改結果' : '保存稱呼'}</Button>
      {message && <Text role="status">{message}</Text>}
    </form>{dirty && !draft.requestKey && <Button variant="secondary" disabled={locked} onClick={() => void rebase()}>核對目前稱呼，保留輸入</Button>}
    <DraftFeedback form={record}/></Surface>
  </>;
}
