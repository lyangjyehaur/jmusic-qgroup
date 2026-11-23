import { errorText, uiText } from './language';
import { useDurableRecord } from './durable-record';
import { DraftFeedback } from './draft-feedback';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Heading, Surface, Text } from 'yahha-ui';
import { z } from 'zod';
import { ArchivePaymentCode, CreatePaymentCode, PaymentCode, PaymentCodeId, PaymentCodeLibrary, PaymentCodeName, PaymentCodeSource, PaymentKind, type Viewer } from '@qgroup/contracts';
import { ApiError } from './api';
import { scopedHttp } from './http';
import { authHttp, loginLink } from './auth';
import { Failure, Notice, PageIntro, sessionQuery } from './shared';
import { PaymentAssetImage, preparePaymentImage } from './payment-image';

export const paymentKindLabels = { wechat: uiText("微信"), alipay: uiText("支付寶"), other: uiText("其他") };
const Form = z.object({ kind: PaymentKind, name: z.string().max(160), image: z.string().max(2800000), source: PaymentCodeSource.optional() }).strict();
const Operation = z.discriminatedUnion('command', [
  z.object({ command: z.literal('create'), data: CreatePaymentCode }).strict(),
  z.object({ command: z.literal('archive'), id: PaymentCodeId, data: ArchivePaymentCode }).strict(),
]);
const Draft = z.object({ form: Form, pending: z.object({ key: z.string().uuid(), input: Operation }).strict().optional() }).strict().transform(value => value.pending?.input.command === 'create' && 'image' in value.pending.input.data && !value.form.image ? { ...value, form: { ...value.form, image: value.pending.input.data.image } } : value).refine(value => {
  if (value.form.source && value.form.image) return false;
  if (!value.pending || value.pending.input.command !== 'create') return true;
  const input = value.pending.input.data;
  const name = PaymentCodeName.safeParse(value.form.name);
  return name.success && input.kind === value.form.kind && input.name === name.data && ('image' in input ? input.image === value.form.image && !value.form.source : JSON.stringify(input.source) === JSON.stringify(value.form.source) && !value.form.image);
});
type DraftValue = z.infer<typeof Draft>;
const blank = (): DraftValue => ({ form: { kind: 'wechat', name: '', image: '' } });
// Store one image copy so a valid 2 MB PNG does not require twice the browser quota.
const serialize = (value: DraftValue) => JSON.stringify(value.pending?.input.command === 'create' ? { ...value, form: { ...value.form, image: '' } } : value);
export function PaymentCodesPage() {
  const session = useQuery(sessionQuery);
  return <><PageIntro title="我的收款碼" /><Link className="back" to="/me/accounts">回到帳號</Link>{session.isPending ? <Notice>正在確認帳號…</Notice> : session.error ? <Failure error={session.error} retry={() => void session.refetch()} /> : !session.data.authenticated ? <Link to={loginLink('/me/payment-codes')}>登入</Link> : <Library key={session.data.scope} viewer={session.data} />}</>;
}
function Library({ viewer }: { viewer: Viewer }) {
  const [search] = useSearchParams();
  const source = PaymentCodeSource.safeParse({ event_id: search.get('event'), version: Number(search.get('version')), kind: search.get('kind') });
  const queryClient = useQueryClient(), key = 'qgroup:rebuild:payment-codes:v1:' + viewer.scope, queryKey = ['private', viewer.scope, 'payment-codes'];
  const library = useQuery({ queryKey, queryFn: () => scopedHttp(viewer.scope).requestContract('GET /api/v2/me/payment-codes', {  }) });
  const record = useDurableRecord({ key, scope:viewer.scope, seed:blank, parse:raw=>Draft.parse(JSON.parse(raw)), serialize,
    dirty:value=>!!value.form.image||!!value.form.name||!!value.form.source, pending:value=>!!value.pending });
  const {value:draft,replace:setDraft,busy,setBusy,active,dirty,blocker} = record;
  const [error,setError]=useState(''),[message,setMessage]=useState(''),[remove,setRemove]=useState<z.infer<typeof PaymentCode>>();
  const blocked=record.locked;
  const requestedSource = source.success ? source.data : undefined;
  const importQuery = useQuery({ queryKey: ['private', viewer.scope, 'payment-code-import', requestedSource], queryFn: () => scopedHttp(viewer.scope).requestContract('GET /api/v2/activities/:id/settlement/history/:version/assets', { params: { id: requestedSource!.event_id, version: String(requestedSource!.version) } }), enabled: !!requestedSource });
  function change(form: DraftValue['form']) { record.change({ form }); setError(''); setMessage(''); }
  async function upload(file: File) {
    if (blocked) return; setBusy(true); setError('');
    try { const image = await preparePaymentImage(file); if (active.current) { setBusy(false); change({ ...draft.form, image, source: undefined }); } }
    catch (failure) { if (active.current) setError(failure instanceof Error ? errorText(failure) : uiText("圖片無法讀取")); }
    finally { if (active.current) setBusy(false); }
  }
  async function send(operation?: z.infer<typeof Operation>) {
    if (busy || record.unavailable) return;
    const parsed = Operation.safeParse(operation ?? draft.pending?.input); if (!parsed.success) { setError(uiText("請選擇圖片，名稱最多 40 字。")); return; }
    const pending = draft.pending ?? { key: crypto.randomUUID(), input: parsed.data }, next = { ...draft, pending };
    if (!record.begin()) return;
    if (!await record.persist(next) || !active.current) { if (active.current) setBusy(false); return; }
    setDraft(next); setBusy(true); setError(''); setMessage(''); setRemove(undefined);
    let accepted=false;
    try {
      const input = pending.input;
      const result = input.command === 'create' ? await authHttp(viewer).requestContract('POST /api/v2/me/payment-codes', { body: input.data, requestId: pending.key, requestScope: viewer.scope }) : await authHttp(viewer).requestContract('DELETE /api/v2/me/payment-codes/:codeId', { params: { codeId: input.id }, body: input.data, requestId: pending.key, requestScope: viewer.scope });
      accepted=true;
      if (!active.current) return;
      const cleared = input.command === 'create' ? blank() : { form: draft.form };
      if (!await record.persist(cleared,false,uiText("操作已送出，但無法保存確認狀態；請保留原操作並核對結果。"))) throw Error('storage'); setDraft(cleared);
      if ('id' in result) queryClient.setQueryData(queryKey, (previous: z.infer<typeof PaymentCodeLibrary> | undefined) => previous ? { codes: [result, ...previous.codes.filter(code => code.id !== result.id)] } : undefined);
      else if (input.command === 'archive') queryClient.setQueryData(queryKey, (previous: z.infer<typeof PaymentCodeLibrary> | undefined) => previous ? { codes: previous.codes.filter(code => code.id !== input.id) } : undefined);
      void queryClient.invalidateQueries({ queryKey }); setMessage(input.command === 'create' ? uiText("收款碼已保存。") : uiText("已從我的收款碼移除。"));
    } catch (failure) {
      if (!active.current) return;
      if (!accepted && failure instanceof ApiError && failure.status < 500 && failure.status !== 429) { const cleared={form:draft.form}; if(await record.persist(cleared)) setDraft(cleared); setError(errorText(failure)); }
      else setError(uiText("尚未確認操作結果。原圖與操作編號已保留，請按「確認操作結果」安全重試。"));
    } finally { if (active.current) setBusy(false); }
  }
  return <>
    {blocker.state === 'blocked' && <Surface role="alert"><Heading level={2}>還有未完成的收款碼操作</Heading><Text>圖片草稿與操作編號保留在此瀏覽器。</Text><Button onClick={() => blocker.reset()}>繼續處理</Button><Button variant="secondary" disabled={busy} onClick={() => void record.leave()}>保留草稿並離開</Button></Surface>}
    {draft.pending && <Surface role="status"><Text>有待確認的{draft.pending.input.command === 'create' ? '保存' : '移除'}操作。</Text><Button loading={busy} disabled={record.unavailable} onClick={() => void send()}>確認操作結果</Button></Surface>}
    <DraftFeedback form={record} navigation={false}/>
    {error && <Text role="alert">{error}</Text>}{message && <Text role="status">{message}</Text>}
    {requestedSource && <Surface className="detail"><Heading level={2}>從結算保存收款碼</Heading>{importQuery.isPending ? <Notice>正在核對原版收款碼…</Notice> : importQuery.error ? <Failure error={importQuery.error} retry={() => void importQuery.refetch()} /> : !importQuery.data?.can_save ? <Text role="alert">只能保存自己發布結算時使用的收款碼。</Text> : (() => { const code = importQuery.data.codes.find(code => code.kind === requestedSource.kind); return code ? <><Text>第 {requestedSource.version} 版 · {paymentKindLabels[code.kind]}{code.name ? ' · ' + code.name : ''}</Text><PaymentAssetImage url={code.url} scope={viewer.scope} label="原版收款碼" /><Button disabled={blocked || dirty} onClick={() => { change({ kind: code.kind, name: code.name, image: '', source: requestedSource }); }}>帶入原版收款碼</Button>{dirty && !draft.form.source && <Text>先完成或清除下方圖片草稿，再帶入原版收款碼。</Text>}</> : <Text role="alert">原版收款碼不存在，請重新選擇。</Text>; })()}<Link to={'/activities/' + encodeURIComponent(requestedSource.event_id) + '/settlement/images?version=' + requestedSource.version}>回到結算原圖</Link></Surface>}
    {library.isPending ? <Notice>正在讀取收款碼…</Notice> : library.error ? <Failure error={library.error} retry={() => void library.refetch()} /> : <Surface className="detail"><Heading level={2}>已保存（{library.data.codes.length}／30）</Heading>{library.data.codes.length ? <ul className="payment-library">{library.data.codes.map(code => <li key={code.id}><Heading level={3}>{paymentKindLabels[code.kind]}{code.name ? ' · ' + code.name : ''}</Heading><PaymentAssetImage url={code.url} scope={viewer.scope} label={paymentKindLabels[code.kind] + '收款碼' + (code.name ? ' ' + code.name : '')} /><Button variant="secondary" disabled={blocked} onClick={() => setRemove(code)}>移除 {code.name || paymentKindLabels[code.kind] + '收款碼'}</Button></li>)}</ul> : <Text>尚未保存收款碼，可在下方新增。</Text>}</Surface>}
    {remove && <Surface role="alert"><Heading level={2}>移除 {remove.name || paymentKindLabels[remove.kind] + '收款碼'}？</Heading><Text>已發布帳單及歷史圖片會保留。</Text><Button disabled={blocked} onClick={() => void send({ command: 'archive', id: remove.id, data: { confirm: true } })}>確認移除</Button><Button variant="secondary" onClick={() => setRemove(undefined)}>取消移除</Button></Surface>}
    <Surface className="detail"><Heading level={2}>新增收款碼</Heading><form onSubmit={event => { event.preventDefault(); void send({ command: 'create', data: { kind: draft.form.kind, name: draft.form.name, confirm: true, ...(draft.form.source ? { source: draft.form.source } : { image: draft.form.image }) } }); }}>
      <fieldset disabled={blocked}><div className="account-field"><label htmlFor="payment-kind">收款方式</label><select id="payment-kind" value={draft.form.kind} onChange={event => change({ ...draft.form, kind: PaymentKind.parse(event.target.value) })}>{Object.entries(paymentKindLabels).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select></div>
      <label className="account-field">名稱（選填）<input value={draft.form.name} maxLength={80} onChange={event => change({ ...draft.form, name: event.target.value })} /></label>
      <label className="account-field">收款碼圖片<input type="file" accept="image/png,image/jpeg,image/webp" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void upload(file); }} /></label>
      <Text>PNG、JPEG 或 WebP，原始檔最多 15 MB；在瀏覽器轉為最長邊 1600 像素、最多 2 MB 的 PNG。圖片只供本人與使用該碼的活動結算讀取。</Text>
      {draft.form.image && <div className="payment-asset"><img className="payment-asset-thumb" src={'data:image/png;base64,' + draft.form.image} alt="待保存收款碼" /><Button variant="secondary" onClick={() => change({ ...draft.form, image: '' })}>清除待保存圖片</Button></div>}
      {draft.form.source && <><Text>待保存原圖：結算第 {draft.form.source.version} 版 · {paymentKindLabels[draft.form.source.kind]}</Text><Button variant="secondary" onClick={() => change({ ...draft.form, source: undefined })}>清除原圖選擇</Button></>}
      <Button type="submit" disabled={!draft.form.image && !draft.form.source} loading={busy}>保存收款碼</Button></fieldset>
    </form></Surface>
  </>;
}
