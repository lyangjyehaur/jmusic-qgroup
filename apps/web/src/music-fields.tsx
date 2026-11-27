import { MusicQQPrompt } from './music-qq-prompt';
import { errorText, uiText } from './language';
import { useEffect, useState } from 'react';
import { useDurableRecord } from './durable-record';
import { DraftFeedback } from './draft-feedback';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Surface, Text } from 'yahha-ui';
import { Button, Field, Select, Checkbox } from './kimi-ui';
import { z } from 'zod';
import { MusicFields, SaveMusicFields } from '@qgroup/contracts';
import { ApiError } from './api';
import { scopedHttp } from './http';
import { authHttp } from './auth';
import { announceAccountChange } from './account-session';
import { MusicMemberAccess, type Member } from './member-access';
import { Failure, Notice, PageIntro } from './shared';
type Fields = z.infer<typeof MusicFields>;
const GenderChoice = z.enum(['', 'female', 'male', 'custom']);
const Draft = z.object({ profileId: z.string(), musicEpoch: z.number().int().min(0), revision: z.number().int().min(0), name: z.string(), note: z.string(), genderChoice: GenderChoice, genderCustom: z.string(), genderPublic: z.boolean(), pending: z.object({ key: z.string().uuid(), input: SaveMusicFields }).strict().optional() }).strict();
type DraftValue = z.infer<typeof Draft>;
function draftFor(fields: Fields, epoch: number): DraftValue {
  const builtIn = ['', 'female', 'male'].includes(fields.gender);
  return { profileId: fields.profileId, musicEpoch: epoch, revision: fields.revision, name: fields.name, note: fields.note, genderChoice: builtIn ? GenderChoice.parse(fields.gender) : 'custom', genderCustom: builtIn ? '' : fields.gender, genderPublic: fields.genderPublic };
}
const valueOf = (draft: DraftValue) => ({ profileId: draft.profileId, musicEpoch: draft.musicEpoch, revision: draft.revision, name: draft.name, note: draft.note, gender: draft.genderChoice === 'custom' ? draft.genderCustom : draft.genderChoice, genderPublic: draft.genderPublic });
export function MusicFieldsPage() {
  return <><PageIntro title="成分資料" /><div className="page-actions"><Link to="/me/music">回到我的成分</Link></div><MusicMemberAccess purpose={uiText("編輯成分資料")}>{viewer => <Loader key={viewer.scope + ':' + viewer.musicEpoch} viewer={viewer} />}</MusicMemberAccess></>;
}
function Loader({ viewer }: { viewer: Member }) {
  const query = useQuery({ queryKey: ['private', viewer.scope, 'music-fields', viewer.musicEpoch], queryFn: () => scopedHttp(viewer.scope).requestContract('GET /api/v2/me/music/fields', {}), refetchOnWindowFocus: false });
  return query.isPending ? <Notice>正在讀取成分資料…</Notice> : query.error ? <Failure error={query.error} retry={() => void query.refetch()} /> : <Editor viewer={viewer} initial={query.data} />;
}
function Editor({ viewer, initial }: { viewer: Member; initial: Fields }) {
  const client = useQueryClient(); const storageKey = 'qgroup:rebuild:music:fields:v1:' + viewer.scope + ':' + viewer.musicEpoch + ':' + initial.profileId;
  const [saved, setSaved] = useState(initial), [message, setMessage] = useState(''), [comparison, setComparison] = useState(false);
  const record = useDurableRecord({key:storageKey,scope:viewer.scope,seed:()=>draftFor(saved,viewer.musicEpoch),parse:raw=>{
    const value=Draft.parse(JSON.parse(raw));if(value.profileId!==initial.profileId||value.musicEpoch!==viewer.musicEpoch||value.pending&&(value.pending.input.profileId!==value.profileId||value.pending.input.musicEpoch!==value.musicEpoch))throw Error('profile target');return value;
  },dirty:value=>JSON.stringify(valueOf(value))!==JSON.stringify(valueOf(draftFor(saved,viewer.musicEpoch))),pending:value=>!!value.pending});
  const {value:draft,replace:setDraft,busy,setBusy,active,dirty,locked,persist,begin,unavailable}=record;
  useEffect(()=>setComparison(false),[record.epoch]);
  function edit(patch: Partial<DraftValue>) { record.change({ ...draft, ...patch }); setMessage(''); }
  async function save() {
    if (busy || unavailable) return;
    const input = SaveMusicFields.safeParse(valueOf(draft)); if (!input.success) { setMessage(uiText("請檢查欄位內容。")); return; }
    if (!draft.pending && draft.genderChoice === 'custom' && !draft.genderCustom.trim()) { setMessage(uiText("請輸入自訂性別，或選擇不填。")); return; }
    const operation = draft.pending ?? { key: crypto.randomUUID(), input: input.data }; const pending = { ...draft, pending: operation };
    if(!begin())return;if(!await persist(pending)||!active.current){if(active.current)setBusy(false);return;}
    setDraft(pending);setMessage('');let accepted=false;
    try {
      const result = await authHttp(viewer).requestContract('PUT /api/v2/me/music/fields', { body: operation.input, requestId: operation.key, requestScope: viewer.scope }); accepted = true;
      const latest = await scopedHttp(viewer.scope).requestContract('GET /api/v2/me/music/fields', {});
      const next = draftFor(latest, viewer.musicEpoch);if(!active.current)return;if(!await persist(next,false,uiText("操作已送出，但無法保存確認狀態；請保留原操作並核對結果。")))throw Error('storage'); setDraft(next); setSaved(latest); setComparison(false);
      client.setQueryData(['private', viewer.scope, 'music-fields', viewer.musicEpoch], latest);
      void client.invalidateQueries({ queryKey: ['private', viewer.scope, 'music'] });
      void client.invalidateQueries({ queryKey: ['private', viewer.scope, 'member-music'] });
      void client.invalidateQueries({ queryKey: ['private', viewer.scope, 'music-matches'] });
      void client.invalidateQueries({ queryKey: ['private', viewer.scope, 'music-circles'] });
      void client.invalidateQueries({ queryKey: ['private', viewer.scope, 'music-comparison'] });
      void client.invalidateQueries({ queryKey: ['private', viewer.scope, 'music-share'] });
      void client.invalidateQueries({ queryKey: ['private', viewer.scope, 'music-trend-members'] });
      void client.invalidateQueries({ queryKey: ['private', viewer.scope, 'music-entry-members'] });
      void client.invalidateQueries({ queryKey: ['music-catalog'] }); announceAccountChange();
      setMessage(result.revision === latest.revision ? uiText("成分資料已保存。") : uiText("原操作已保存，資料已再次變更；請核對目前內容。"));
    } catch (error) {
      if(!active.current)return;
      if (!accepted && error instanceof ApiError && error.status < 500 && error.status !== 429) { const next={...pending,pending:undefined};if(await persist(next))setDraft(next); setMessage(errorText(error)); }
      else setMessage(uiText("尚未確認成分資料保存結果。原操作已保留，請按「確認成分資料結果」安全重試。"));
    } finally { if(active.current)setBusy(false); }
  }
  async function rebase() {
    if(locked||!begin())return;
    try {
      const latest = await scopedHttp(viewer.scope).requestContract('GET /api/v2/me/music/fields', {});
      if (latest.profileId !== draft.profileId) throw new Error('目前成分已改變，請保留原稿後重新開啟目前成分。');
      const next = { ...draft, revision: latest.revision }; if(!active.current||!await persist(next))return;setDraft(next); setSaved(latest); setComparison(true); setMessage(uiText("已取得目前資料；輸入仍保留，請核對後再保存。"));
    } catch (error) { if(active.current)setMessage(error instanceof Error ? errorText(error) : uiText("讀取失敗")); } finally { if(active.current)setBusy(false); }
  }
  return <>
    {comparison && <Surface aria-label="目前已保存的成分資料"><h2>目前已保存的成分資料</h2><dl><dt>成分稱呼</dt><dd>{saved.name}</dd><dt>性別</dt><dd>{saved.gender === 'female' ? '女' : saved.gender === 'male' ? '男' : saved.gender || '不填'} · {saved.genderPublic ? '公開' : '不公開'}</dd><dt>私人留言</dt><dd>{saved.note || '未填寫'}</dd></dl></Surface>}
    <div className="settings-grid music-profile-settings"><section className="form-section"><div className="section-heading"><div><h2>我的 QQ</h2></div></div><MusicQQPrompt viewer={viewer} showNumber/><div className="settings-navigation"><Link to="/me/music/contact">聯絡 QQ</Link></div></section><Surface className="form-section"><div className="section-heading"><span>資料</span><div><h2>資料與可見性</h2></div></div><form onSubmit={event => { event.preventDefault(); void save(); }}>
      <Field label="成分稱呼"><input value={draft.name} maxLength={Math.max(32, initial.name.length)} disabled={locked} onChange={event => edit({ name: event.target.value })} aria-describedby="music-name-help" /></Field><Text id="music-name-help">1–16 字。可與帳號稱呼不同；修改不影響活動名冊或帳務。</Text>
      <Field label="性別"><Select id="music-gender" value={draft.genderChoice} disabled={locked} onChange={event => { const choice = GenderChoice.parse(event.target.value); edit({ genderChoice: choice, genderPublic: choice ? draft.genderPublic : false }); }}><option value="">不填</option><option value="female">女</option><option value="male">男</option><option value="custom">自訂</option></Select></Field>
      {draft.genderChoice === 'custom' && <Field label="自訂性別"><input value={draft.genderCustom} maxLength={Math.max(24, initial.gender.length)} disabled={locked} onChange={event => edit({ genderCustom: event.target.value })} /></Field>}
      <Checkbox className="consent" checked={draft.genderPublic} disabled={locked || !draft.genderChoice} onChange={event => edit({ genderPublic: event.target.checked })} label={<><span>在成分卡公開性別</span></>} /><Text>未公開的性別不會提供給其他成分會員。</Text>
      <Field label="私人留言"><textarea id="music-private-note" rows={3} maxLength={Math.max(280, initial.note.length)} value={draft.note} disabled={locked} onChange={event => edit({ note: event.target.value })} aria-describedby="music-note-help" /></Field><Text id="music-note-help">最多 140 字，可清空。成分會員的所選排序推薦首位可顯示你的留言；成分卡與比較頁僅對預設排序將你列為首位的會員顯示。資料較少的推薦不顯示留言。</Text>
      <Button type="submit" loading={busy} disabled={!dirty || unavailable}>{draft.pending ? '確認成分資料結果' : '保存成分資料'}</Button>
    </form>{dirty && !draft.pending && <Button variant="secondary" disabled={locked} onClick={() => void rebase()}>核對目前成分資料，保留輸入</Button>}
      <DraftFeedback form={{...record,message:message||record.message}}/>
    </Surface></div></>;
}
