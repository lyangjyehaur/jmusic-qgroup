import { errorText, uiText } from './language';
import { useState } from 'react';
import { useDurableRecord } from './durable-record';
import { DraftFeedback } from './draft-feedback';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Heading, Surface, Text } from 'yahha-ui';
import { Button, Field } from './kimi-ui';
import { z } from 'zod';
import { MusicContact, SaveMusicContact } from '@qgroup/contracts';
import { ApiError } from './api';
import { scopedHttp } from './http';
import { authHttp } from './auth';
import { MemberAccess, type Member } from './member-access';
import { Failure, Notice, PageIntro } from './shared';
import { announceAccountChange } from './account-session';
import { ContactValue } from './music-contact-value';
type Value = z.infer<typeof MusicContact>;
const Draft = SaveMusicContact.extend({ contactQQ: z.string().max(24), requestKey: z.string().uuid().optional() });
export function MusicContactPage() {
  return <><PageIntro title="聯絡 QQ" /><Link className="back" to="/me/music">回到我的成分</Link><MemberAccess>{viewer => <Loader key={viewer.scope + ':' + viewer.musicEpoch} viewer={viewer} />}</MemberAccess></>;
}
function Loader({ viewer }: { viewer: Member }) {
  const contact = useQuery({ queryKey: ['private', viewer.scope, 'music-contact', viewer.musicEpoch], queryFn: () => scopedHttp(viewer.scope).requestContract('GET /api/v2/me/music/contact', {}) });
  return contact.isPending ? <Notice>正在讀取聯絡 QQ…</Notice> : contact.error ? <Failure error={contact.error} retry={() => void contact.refetch()} /> : <Editor viewer={viewer} initial={contact.data} />;
}
function Editor({ viewer, initial }: { viewer: Member; initial: Value }) {
  const client = useQueryClient(); const storageKey = `qgroup:rebuild:music:contact:v1:${viewer.scope}:${viewer.musicEpoch}:${initial.profileId}`;
  const fallback = { profileId: initial.profileId, musicEpoch: viewer.musicEpoch, revision: initial.revision, contactQQ: initial.contactQQ };
  const [saved, setSaved] = useState(initial), [message, setMessage] = useState('');
  const record = useDurableRecord<z.infer<typeof Draft>>({key:storageKey,scope:viewer.scope,seed:()=>({...fallback,revision:saved.revision,contactQQ:saved.contactQQ}),parse:raw=>{
    const value=Draft.parse(JSON.parse(raw));if(value.profileId!==initial.profileId||value.musicEpoch!==viewer.musicEpoch)throw Error('profile target');return value;
  },dirty:value=>value.contactQQ!==saved.contactQQ||value.revision!==saved.revision,pending:value=>!!value.requestKey});
  const {value:draft,replace:setDraft,busy,setBusy,active,dirty,locked,persist,begin,unavailable}=record;
  async function save() {
    if (busy || unavailable || saved.source === 'legacy') return;
    const input = SaveMusicContact.safeParse({ profileId: draft.profileId, musicEpoch: draft.musicEpoch, revision: draft.revision, contactQQ: draft.contactQQ });
    if (!input.success) { setMessage(uiText("QQ 號須為 4–12 位數字，或留空清除。")); return; }
    const pending = { ...input.data, requestKey: draft.requestKey ?? crypto.randomUUID() };
    if(!begin())return;if(!await persist(pending)||!active.current){if(active.current)setBusy(false);return;}
    setDraft(pending);setMessage('');let accepted=false;
    try {
      const result = await authHttp(viewer).requestContract('PUT /api/v2/me/music/contact', { body: input.data, requestId: pending.requestKey, requestScope: viewer.scope });accepted=true;
      const latest = await scopedHttp(viewer.scope).requestContract('GET /api/v2/me/music/contact', {});
      const next = { ...latest, musicEpoch: viewer.musicEpoch }; const nextDraft = SaveMusicContact.parse({ profileId: next.profileId, musicEpoch: next.musicEpoch, revision: next.revision, contactQQ: next.contactQQ });
      if(!active.current)return;if(!await persist(nextDraft,false,uiText("操作已送出，但無法保存確認狀態；請保留原操作並核對結果。")))throw Error('storage');setDraft(nextDraft); setSaved(latest);
      client.setQueryData(['private', viewer.scope, 'music-contact', viewer.musicEpoch], latest);
      void client.invalidateQueries({ queryKey: ['private', viewer.scope, 'music'] });
      void client.invalidateQueries({ queryKey: ['private', viewer.scope, 'member-music'] });
      void client.invalidateQueries({ queryKey: ['private', viewer.scope, 'music-matches'] });
      void client.invalidateQueries({ queryKey: ['private', viewer.scope, 'music-comparison'] });
      void client.invalidateQueries({ queryKey: ['private', viewer.scope, 'music-share'] });
      void client.invalidateQueries({ queryKey: ['private', viewer.scope, 'music-entry-members'] }); announceAccountChange();
      setMessage(latest.revision === result.revision ? uiText("已保存聯絡 QQ。") : uiText("原操作已保存，聯絡 QQ 已再次變更；請核對目前資料。"));
    } catch (error) {
      if(!active.current)return;
      if (!accepted && error instanceof ApiError && error.status < 500 && error.status !== 429) { const next={...pending,requestKey:undefined};if(await persist(next))setDraft(next); setMessage(errorText(error)); }
      else setMessage(uiText("尚未確認保存結果。操作編號已保留，請按「確認聯絡 QQ 結果」安全重試。"));
    } finally { if(active.current)setBusy(false); }
  }
  async function rebase() {
    if(locked||!begin())return;
    try {
      const latest = await scopedHttp(viewer.scope).requestContract('GET /api/v2/me/music/contact', {});
      if(latest.profileId!==draft.profileId)throw Error('目前成分已改變，請保全原稿後重新開啟目前成分。');
      const next={...draft,revision:latest.revision};if(!active.current||!await persist(next))return;setSaved(latest);setDraft(next);
      setMessage(uiText("已取得目前聯絡 QQ；輸入仍保留，請核對後再保存。"));
    } catch (error) { if(active.current)setMessage(error instanceof Error ? errorText(error) : uiText("讀取失敗")); } finally { if(active.current)setBusy(false); }
  }
  return <>
    <Surface className="detail auth-panel"><Heading level={2}>目前聯絡 QQ</Heading><ContactValue key={saved.contactQQ} number={saved.contactQQ} source={saved.contactQQ ? saved.source : ''} />
      <Link to={'/people/' + saved.profileId}>查看我的成分卡</Link>
      {saved.source === 'legacy' ? <Text>此 QQ 僅由管理員更正。</Text> : <form onSubmit={event => { event.preventDefault(); void save(); }}>
        <Field className="account-field" label={<>聯絡 QQ</>}><input inputMode="numeric" autoComplete="off" value={draft.contactQQ} maxLength={24} disabled={locked} onChange={event => { record.change({ ...draft, contactQQ: event.target.value }); setMessage(''); }} aria-describedby="music-contact-help" /></Field>
        <Text id="music-contact-help">4–12 位數字，選填，可清空。填寫後同好可用 QQ 查詢和比較你的成分。</Text>
        <Button type="submit" loading={busy} disabled={!dirty || unavailable}>{draft.requestKey ? '確認聯絡 QQ 結果' : '保存聯絡 QQ'}</Button>
      </form>}
      {dirty && !draft.requestKey && saved.source !== 'legacy' && <Button variant="secondary" disabled={locked} onClick={() => void rebase()}>核對目前聯絡 QQ，保留輸入</Button>}
      <DraftFeedback form={{...record,message:message||record.message}}/>
    </Surface></>;
}
