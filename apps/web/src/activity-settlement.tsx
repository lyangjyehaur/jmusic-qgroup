import { DraftFeedback } from './draft-feedback';
export { DraftFeedback } from './draft-feedback';
import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Heading, Surface, Text } from 'yahha-ui';
import { z } from 'zod';
import {
  ActualRoomInput,
  SaveSettlement,
  SettlementAllocation,
  SettlementBill,
  SettlementContext,
  SettlementHistory,
  SettlementInput,
  SettlementItemInput,
  SettlementPaymentInput,
  SettlementPersonInput,
  SettlementMerchantPayment,
  SettlementPreview,
  SettlementResult,
  SettlementSnapshot,
  SettlementView,
  type Viewer,
  PaymentCodeLibrary,
} from '@qgroup/contracts';
import { api } from './api';
import { Failure, Notice, PageIntro, useSession } from './shared';
import { MemberAccess, type Member } from './member-access';
import { useReviewedDraft } from './reviewed-draft';
import { Field, money, newSettlementId, PayerSelect, RoomFields, type Payer } from './settlement-controls';
import { PaymentAssetImage, preparePaymentImage } from './payment-image';
import { paymentKindLabels } from './payment-codes';
const base = (id: string) => '/activities/' + encodeURIComponent(id),
  scoped = (viewer: Viewer) => ({ 'X-Account-Scope': viewer.scope });
type Context = z.infer<typeof SettlementContext>;
type Invoice = z.infer<typeof SettlementSnapshot>;
const modeLabels = {
    shares: '共同份數',
    equal: '人數均分',
    weights: '指定比例',
    fixed: '固定金額',
    duration: '參與時長',
  },
  kindLabels = { expense: '消費', refund: '店家退款', discount: '減免' };
export function SettlementSnapshotView({ snapshot: s }: { snapshot: Invoice }) {
  const { id = '' } = useParams();
  return (
    <>
      <Text>
        消費淨額 {money(s.total_cents)} · {s.people.length} 人{s.collector ? ' · 收款人 ' + s.collector.name : ''}
      </Text>
      <Notice>
        以下金額凍結於本版發布時，後續收退款請到<Link to={base(id) + '/finance'}>收付款帳本</Link>核對。
        {s.rooms?.length ? '各包間分開核對，不能互相抵款。' : ''}
      </Notice>
      <details open>
        <summary>逐人費用與付款歸屬</summary>
        {s.people.map((p) => (
          <details key={p.id}>
            <summary>
              {p.label} · {money(p.due_cents)} · {p.share} 份
            </summary>
            <ul>
              {p.allocations.map((a) => (
                <li key={a.item_id}>
                  {s.items.find((i) => i.id === a.item_id)?.name}：{money(a.amount_cents)}
                </li>
              ))}
            </ul>
            <Text>付款歸屬：{p.payments.map((v) => v.label + ' ' + money(v.amount_cents)).join('、')}</Text>
            <Text>
              出席：{p.attendance === 'absent' ? '缺席' : p.attendance === 'present' ? '出席' : '未確認'} · 接受約定：
              {p.accepted_conditions_version ? '第 ' + p.accepted_conditions_version + ' 版' : '尚未接受'}
            </Text>
            {p.accepted_arrangement && (
              <details>
                <summary>本版採用的費用約定</summary>
                <Text>{p.accepted_arrangement.fee_policy || '未填費用約定'}</Text>
                <Text>
                  {p.accepted_arrangement.location} · {p.accepted_arrangement.starts_at}
                </Text>
                {p.accepted_arrangement.description && <Text>{p.accepted_arrangement.description}</Text>}
              </details>
            )}
            {p.reason && <Text>核對原因：{p.reason}</Text>}
          </details>
        ))}
      </details>
      <details>
        <summary>費用項目</summary>
        {s.items.map((i) => (
          <details key={i.id}>
            <summary>
              {i.name} · {kindLabels[i.kind]} · {money(i.amount_cents)} · {modeLabels[i.mode]}
            </summary>
            {i.reason && <Text>分攤依據：{i.reason}</Text>}
            <ul>
              {i.breakdown.map((a) => (
                <li key={a.person_id}>
                  {s.people.find((p) => p.id === a.person_id)?.label}：{money(a.amount_cents)}
                  {a.weight !== undefined ? ' · 比例 ' + a.weight : ''}
                  {a.minutes !== undefined ? ' · ' + a.minutes + ' 分鐘' : ''}
                </li>
              ))}
            </ul>
            {i.has_receipt && <Text>本項附有消費憑證，請查看本版原圖。</Text>}
          </details>
        ))}
      </details>
      {s.room_balances?.length ? (
        s.room_balances.map((r) => (
          <details key={r.id}>
            <summary>
              {r.name} · {money(r.total_cents)} · 收款人 {r.payer_label ?? r.payer_name}
            </summary>
            <ul>
              {r.transfers.map((t, i) => (
                <li key={i}>
                  {t.from_name} → {t.to_name}：{money(t.amount_cents)}
                </li>
              ))}
            </ul>
          </details>
        ))
      ) : (
        <details>
          <summary>發布時待補／應退</summary>
          <ul>
            {s.balances.map((p) => (
              <li key={p.id}>
                {p.label}：應付 {money(p.due_cents)} · 已投入 {money(p.contributed_cents)} ·{' '}
                {p.balance_cents < 0 ? '應退／待償還 ' + money(-p.balance_cents) : '待補 ' + money(p.balance_cents)}
              </li>
            ))}
          </ul>
        </details>
      )}
      {s.note && <Text className="preserve-lines">備註：{s.note}</Text>}
      <details>
        <summary>本版變更</summary>
        <ul>
          {s.changes.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
        {s.reason && <Text>原因：{s.reason}</Text>}
      </details>
      <Text>{s.rounding_rule}</Text>
    </>
  );
}
function Bill({ bill, id }: { bill: z.infer<typeof SettlementBill>; id: string }) {
  return (
    <Surface className="detail">
      <Heading level={2}>
        第 {bill.version} 版 · {bill.mode === 'detailed' ? '逐人結算' : '舊人均帳單'}
      </Heading>
      <Text>
        {bill.actor_name} · {bill.updated_at}
      </Text>
      {bill.detail ? (
        <SettlementSnapshotView snapshot={bill.detail} />
      ) : (
        <>
          <Text>
            總額 {bill.total_amount} 元 · {bill.headcount} 人 · 人均 {bill.per_person_amount} 元
          </Text>
          <Text>四捨五入差額：{bill.rounding_difference_cents} 分</Text>
          {bill.note && <Text>{bill.note}</Text>}
        </>
      )}
      <Link to={base(id) + '/settlement/images?version=' + bill.version}>查看本版收款碼與消費憑證</Link>
    </Surface>
  );
}
export function ActivitySettlementPage() {
  const { id = '' } = useParams(),
    session = useSession();
  return (
    <>
      <PageIntro title="逐人結算" />
      <div className="page-actions">
        <Link to={base(id)}>回到活動</Link>
        <Link to={base(id) + '/finance'}>收付款帳本</Link>
        <Link to={base(id) + '/settlement/images'}>結算原圖</Link>
      </div>
      {session.error ? (
        <Failure error={session.error} retry={() => void session.refetch()} />
      ) : session.data ? (
        <SettlementLoader key={session.data.scope + ':' + id} id={id} viewer={session.data} />
      ) : (
        <Notice>正在確認帳號…</Notice>
      )}
    </>
  );
}
function SettlementLoader({ id, viewer }: { id: string; viewer: Viewer }) {
  const query = useQuery({
      queryKey: ['private', viewer.scope, 'settlement', id],
      queryFn: () => api(base(id) + '/settlement', SettlementView, { headers: scoped(viewer) }),
    }),
    history = useQuery({
      queryKey: ['private', viewer.scope, 'settlement-history', id],
      queryFn: () => api(base(id) + '/settlement/history', SettlementHistory, { headers: scoped(viewer) }),
    }),
    [search, setSearch] = useSearchParams(),
    [extra, setExtra] = useState<z.infer<typeof SettlementHistory>['revisions']>([]),
    [next, setNext] = useState<number | null | undefined>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    version = Number(search.get('version')),
    selected = useQuery({
      queryKey: ['private', viewer.scope, 'settlement-version', id, version],
      queryFn: () => api(base(id) + '/settlement/history/' + version, SettlementBill, { headers: scoped(viewer) }),
      enabled: !!search.get('version') && Number.isSafeInteger(version) && version > 0,
    });
  async function more() {
    const cursor = next === undefined ? history.data?.next_before : next;
    if (!cursor || busy) return;
    setBusy(true);
    try {
      const page = await api(base(id) + '/settlement/history?before=' + cursor, SettlementHistory, {
        headers: scoped(viewer),
      });
      setExtra([...extra, ...page.revisions]);
      setNext(page.next_before);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '讀取失敗');
    } finally {
      setBusy(false);
    }
  }
  if (query.isPending) return <Notice>正在讀取結算…</Notice>;
  if (query.error) return <Failure error={query.error} retry={() => void query.refetch()} />;
  const bill = search.get('version') ? selected.data : query.data.bill;
  return (
    <>
      <Heading level={2}>{query.data.title}</Heading>
      {query.data.can_manage && (
        <div className="page-actions">
          <Link to={base(id) + '/settlement/edit'}>核對並發布逐人結算</Link>
          <Link to={base(id) + '/rooms'}>預分包間</Link>
        </div>
      )}
      {search.get('version') && (!Number.isSafeInteger(version) || version <= 0) ? (
        <Text role="alert">版本格式不正確，請重新選擇。</Text>
      ) : selected.error ? (
        <Failure error={selected.error} retry={() => void selected.refetch()} />
      ) : bill ? (
        <Bill bill={bill} id={id} />
      ) : (
        <Notice>{selected.isFetching ? '正在讀取版本…' : '尚未發布結算。'}</Notice>
      )}
      {history.error ? (
        <Failure error={history.error} retry={() => void history.refetch()} />
      ) : (
        history.data &&
        history.data.revisions.length > 0 && (
          <Surface className="detail">
            <Heading level={2}>結算歷史</Heading>
            <div className="page-actions">
              <Button variant="secondary" onClick={() => setSearch({})}>
                最新版本
              </Button>
              {[...history.data.revisions, ...extra].map((row) => (
                <Button
                  key={row.version}
                  variant="secondary"
                  aria-pressed={bill?.version === row.version}
                  onClick={() => setSearch({ version: String(row.version) })}
                >
                  第 {row.version} 版 · {row.total_amount} 元
                </Button>
              ))}
            </div>
            {(next === undefined ? history.data.next_before : next) && (
              <Button loading={busy} onClick={() => void more()}>
                載入較早版本
              </Button>
            )}
            {error && <Text role="alert">{error}</Text>}
          </Surface>
        )
      )}
    </>
  );
}
const Editable = SettlementInput.extend({
  merchant_payment: SettlementMerchantPayment.extend({
    amount: z.string().optional(),
    payer_id: z.string().optional(),
  }).optional(),
  reviewed_roster: z.boolean(),
  people: z
    .array(
      SettlementPersonInput.extend({
        share: z.string(),
        payments: z
          .array(
            SettlementPaymentInput.extend({
              payer_id: z.string(),
              share: z.string().optional(),
              amount: z.string().optional(),
            }),
          )
          .max(20)
          .optional(),
      }),
    )
    .max(500),
  items: z
    .array(
      SettlementItemInput.extend({
        name: z.string(),
        amount: z.string(),
        allocations: z
          .array(SettlementAllocation.extend({ amount: z.string().optional(), weight: z.string().optional() }))
          .max(500),
      }),
    )
    .max(50),
  custom_payers: z.array(z.object({ id: z.string().regex(/^custom:[a-f0-9]{16}$/), name: z.string() })).max(50),
  rooms: z
    .array(
      ActualRoomInput.extend({
        name: z.string(),
        payer_id: z.string(),
        amount: z.string(),
        paid_amount: z.string().optional(),
      }),
    )
    .max(50)
    .optional(),
});
type EditableInput = z.infer<typeof Editable>;
const calculation = (value: EditableInput) => ({
  ...value,
  people: value.people.map((p) => ({
    ...p,
    payments: p.payments?.map((v) => ({
      payer_id: v.payer_id,
      ...(p.payment_mode === 'fixed' ? { amount: v.amount } : { share: v.share ?? '1' }),
    })),
  })),
  items: value.rooms?.length
    ? []
    : value.items.map((i) => ({
        ...i,
        allocations: i.allocations.map((a) => ({
          person_id: a.person_id,
          ...(i.mode === 'fixed'
            ? { amount: a.amount }
            : i.mode === 'weights'
              ? { weight: a.weight }
              : i.mode === 'duration'
                ? { minutes: a.minutes }
                : {}),
        })),
      })),
  merchant_payment:
    value.merchant_payment?.mode === 'paid'
      ? value.merchant_payment
      : value.merchant_payment
        ? { mode: value.merchant_payment.mode, method: 'other', merchant: '', note: '', reason: '' }
        : undefined,
});
function blank(ctx: Context): EditableInput {
  const prior = ctx.bill?.detail,
    version = ctx.bill?.version ?? 0,
    rooms = prior?.input.rooms ?? ctx.rooms;
  return {
    revision: ctx.revision,
    base_version: version,
    reviewed_roster: false,
    convert_legacy: false,
    people: ctx.people
      .filter((p) => p.status === 'confirmed' || prior?.people.some((q) => q.id === p.id))
      .map(
        (p) =>
          prior?.input.people.find((q) => q.id === p.id) ?? {
            id: p.id,
            share: '1',
            reason: '',
            payment_mode: 'shares',
            payments: [{ payer_id: p.payer_id, share: '1' }],
          },
      ),
    items: prior?.input.items.map((i) => ({
      id: i.id,
      name: i.name,
      kind: i.kind,
      amount: i.amount,
      scope: i.scope,
      mode: i.mode,
      reason: i.reason,
      allocations: i.allocations,
      receipt: i.receipt_digest ? { version, item_id: i.id } : null,
    })) ?? [
      {
        id: newSettlementId(),
        name: '消費',
        amount: '',
        kind: 'expense',
        scope: 'common',
        mode: 'shares',
        reason: '',
        allocations: [],
        receipt: null,
      },
    ],
    custom_payers: prior?.input.custom_payers ?? [],
    ...(rooms.length
      ? {
          rooms: rooms.map((r) => ({
            id: r.id,
            name: r.name,
            payer_id: r.payer_id,
            person_ids: r.person_ids,
            amount: 'amount' in r ? String(r.amount) : '',
            merchant_mode: ctx.room_record_ids.includes(r.id) ? 'recorded' : 'unpaid',
          })),
        }
      : {}),
    merchant_payment: rooms.length
      ? undefined
      : {
          mode: ctx.has_merchant_records ? 'recorded' : 'unpaid',
          method: 'other',
          merchant: '',
          note: '',
          reason: '',
          occurred_at: new Date().toISOString().slice(0, 19) + '+00:00',
        },
    room_payment_details: {
      method: 'other',
      note: '',
      reason: '',
      occurred_at: new Date().toISOString().slice(0, 19) + '+00:00',
    },
    note: prior?.note ?? '',
    reason: '',
    payment_codes:
      ctx.bill?.publisher_key === ctx.collector.id
        ? (prior?.payment_codes ?? []).map((c) => ({ kind: c.kind, version }))
        : [],
    group_notice: false,
  };
}
export function ActivitySettlementEditor() {
  const { id = '' } = useParams();
  return (
    <>
      <PageIntro title="核對逐人結算" />
      <div className="page-actions">
        <Link to={base(id) + '/settlement'}>查看已發布結算</Link>
        <Link to={base(id) + '/rooms'}>預分包間</Link>
        <Link to={base(id) + '/finance'}>收付款帳本</Link>
      </div>
      <MemberAccess>{(viewer) => <ContextLoader key={viewer.scope + ':' + id} id={id} viewer={viewer} />}</MemberAccess>
    </>
  );
}
function ContextLoader({ id, viewer }: { id: string; viewer: Member }) {
  const query = useQuery({
    queryKey: ['private', viewer.scope, 'settlement-context', id],
    queryFn: () => api(base(id) + '/settlement/context', SettlementContext, { headers: scoped(viewer) }),
    refetchOnWindowFocus: false,
  });
  return query.isPending ? (
    <Notice>正在讀取核對名冊…</Notice>
  ) : query.error ? (
    <Failure error={query.error} retry={() => void query.refetch()} />
  ) : (
    <Editor initial={query.data} viewer={viewer} />
  );
}
function Editor({ initial, viewer }: { initial: Context; viewer: Member }) {
  const endpoint = base(initial.id) + '/settlement',
    client = useQueryClient(),
    form = useReviewedDraft({
      key: 'qgroup:rebuild:activity-draft:settlement:v1:' + viewer.scope + ':' + initial.id,
      viewer,
      initial,
      blank,
      valueSchema: Editable,
      saveSchema: SaveSettlement,
      resultSchema: SettlementResult,
      endpoint,
      latest: () => api(endpoint + '/context', SettlementContext, { headers: scoped(viewer) }),
      fromPending: ({ preview_token, confirm, ...value }) => {
        void preview_token;
        void confirm;
        return value;
      },
      matches: (value, input) => {
        const parsed = SettlementInput.safeParse(calculation(value));
        const { preview_token, confirm, ...rest } = input;
        void preview_token;
        void confirm;
        return parsed.success && JSON.stringify(parsed.data) === JSON.stringify(rest);
      },
      after: (fresh) => {
        client.setQueryData(['private', viewer.scope, 'settlement-context', initial.id], fresh);
        for (const name of [
          'settlement',
          'settlement-history',
          'settlement-asset-versions',
          'room-overview',
          'room-plan',
          'finance',
          'activity-history',
          'inbox-todos',
          'notification-count',
        ])
          void client.invalidateQueries({ queryKey: ['private', viewer.scope, name] });
      },
    }),
    value = form.draft.value,
    ctx = form.data;
  const [preview, setPreview] = useState<z.infer<typeof SettlementPreview> | null>(null),
    [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    setPreview(null);
    setConfirmed(false);
  }, [form.epoch]);
  const edit = (patch: Partial<EditableInput>) => {
      form.edit({ ...value, ...patch });
      setPreview(null);
      setConfirmed(false);
    },
    payers: Payer[] = [
      ...ctx.payers.filter((p) => !value.custom_payers.some((c) => c.id === p.id)),
      ...value.custom_payers.map((p, i) => ({ ...p, label: p.name || '額外付款人 ' + (i + 1) })),
    ],
    stale = value.revision !== ctx.revision || value.base_version !== (ctx.bill?.version ?? 0),
    allowed = ['ended', 'cancelled'].includes(ctx.lifecycle),
    included = ctx.people.filter((p) => value.people.some((v) => v.id === p.id));
  async function check() {
    if (form.locked || stale || !allowed) return;
    if (value.rooms !== undefined && !value.rooms.length) {
      form.setMessage('請新增實際包間，或改用費用項目結算。');
      return;
    }
    const parsed = SettlementInput.safeParse(calculation(value));
    if (!parsed.success) {
      form.setMessage('請核對名單、金額、付款人及分攤依據；金額最多七位整數、兩位小數。');
      return;
    }
    form.setBusy(true);
    setPreview(null);
    setConfirmed(false);
    try {
      const p = await api(endpoint + '/preview', SettlementPreview, {
        method: 'POST',
        headers: { ...scoped(viewer), 'Content-Type': 'application/json', 'X-CSRF-Token': viewer.csrf },
        body: JSON.stringify(parsed.data),
      });
      if (form.active.current) {
        setPreview(p);
        form.setMessage('');
      }
    } catch (e) {
      if (form.active.current) form.setMessage(e instanceof Error ? e.message : '預覽失敗');
    } finally {
      if (form.active.current) form.setBusy(false);
    }
  }
  async function image(file: File, apply: (value: string) => void) {
    if (form.locked) return;
    form.setBusy(true);
    try {
      const result = await preparePaymentImage(file);
      if (form.active.current) apply(result);
    } catch (e) {
      if (form.active.current) form.setMessage(e instanceof Error ? e.message : '圖片讀取失敗');
    } finally {
      if (form.active.current) form.setBusy(false);
    }
  }
  function person(id: string, patch: Partial<EditableInput['people'][number]>) {
    edit({ people: value.people.map((p) => (p.id === id ? { ...p, ...patch } : p)) });
  }
  return (
    <Surface className="detail activity-editor">
      <Heading level={2}>{ctx.title}</Heading>
      {!allowed && <Notice>實際結束或取消活動後才能發布結算；目前可保留核對原稿。</Notice>}
      <Notice>結算分攤與實際付款分別核對；發布不會自動轉帳。結算名單、付款歸屬及附圖會對有權查看活動的人公開。</Notice>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (form.draft.pending) void form.submit();
          else if (preview && confirmed && !stale)
            void form.submit(
              SaveSettlement.parse({ ...calculation(value), preview_token: preview.preview_token, confirm: true }),
            );
        }}
      >
        <fieldset disabled={form.locked}>
          <legend>逐人核對</legend>
          {ctx.people.map((p) => {
            const current = value.people.find((v) => v.id === p.id);
            return (
              <details key={p.id} className="settlement-person">
                <summary>
                  {p.label} ·{' '}
                  {p.status === 'confirmed'
                    ? '正式'
                    : p.status === 'withdrawn'
                      ? '已退出'
                      : p.status === 'waiting'
                        ? '候補'
                        : '待定'}
                  {p.attendance === 'absent' ? ' · 缺席' : ''}
                  {p.withdrawal_requested ? ' · 申請退出' : ''}
                  {p.confirmation_state !== 'accepted' ? ' · 約定待核對' : ''}
                </summary>
                <label className="consent">
                  <input
                    type="checkbox"
                    checked={!!current}
                    disabled={p.status === 'confirmed'}
                    onChange={(e) =>
                      edit({
                        people: e.target.checked
                          ? [
                              ...value.people,
                              {
                                id: p.id,
                                share: '1',
                                reason: '',
                                payment_mode: 'shares',
                                payments: [{ payer_id: p.payer_id, share: '1' }],
                              },
                            ]
                          : value.people.filter((v) => v.id !== p.id),
                      })
                    }
                  />
                  <span>列入本版結算</span>
                </label>
                <Text>
                  管理人 {p.manager_name} · 原付款人 {ctx.payers.find((v) => v.id === p.payer_id)?.label} · 接受約定{' '}
                  {p.accepted_conditions_version ?? '尚未接受'}
                </Text>
                {p.accepted_arrangement && (
                  <details>
                    <summary>已接受的費用約定</summary>
                    <Text>{p.accepted_arrangement.fee_policy || '未填費用約定'}</Text>
                    <Text>
                      {p.accepted_arrangement.starts_at} · {p.accepted_arrangement.location}
                    </Text>
                  </details>
                )}
                {current && (
                  <>
                    <Field label="共同份數（0 表示免 A）">
                      <input
                        inputMode="decimal"
                        value={current.share}
                        onChange={(e) => person(p.id, { share: e.target.value })}
                      />
                    </Field>
                    <Field label="核對原因">
                      <textarea
                        rows={2}
                        value={current.reason}
                        onChange={(e) => person(p.id, { reason: e.target.value })}
                      />
                    </Field>
                    <Field label="付款歸屬分配方式">
                      <select
                        value={current.payment_mode}
                        onChange={(e) => person(p.id, { payment_mode: e.target.value as 'shares' | 'fixed' })}
                      >
                        <option value="shares">依比例分配</option>
                        <option value="fixed">固定付款金額</option>
                      </select>
                    </Field>
                    {(current.payments ?? []).map((payment, index) => (
                      <fieldset key={index}>
                        <legend>付款歸屬 {index + 1}</legend>
                        <PayerSelect
                          label="付款人"
                          value={payment.payer_id}
                          payers={payers}
                          change={(payer_id) =>
                            person(p.id, {
                              payments: current.payments!.map((v, i) => (i === index ? { ...v, payer_id } : v)),
                            })
                          }
                        />
                        <Field label={current.payment_mode === 'fixed' ? '付款金額' : '付款比例'}>
                          <input
                            inputMode="decimal"
                            value={(current.payment_mode === 'fixed' ? payment.amount : payment.share) ?? ''}
                            onChange={(e) =>
                              person(p.id, {
                                payments: current.payments!.map((v, i) =>
                                  i === index
                                    ? { ...v, [current.payment_mode === 'fixed' ? 'amount' : 'share']: e.target.value }
                                    : v,
                                ),
                              })
                            }
                          />
                        </Field>
                        <Button
                          variant="ghost"
                          disabled={current.payments!.length <= 1}
                          onClick={() => person(p.id, { payments: current.payments!.filter((_, i) => i !== index) })}
                        >
                          移除付款歸屬 {index + 1}
                        </Button>
                      </fieldset>
                    ))}
                    <Button
                      variant="secondary"
                      disabled={(current.payments?.length ?? 0) >= 20}
                      onClick={() =>
                        person(p.id, { payments: [...(current.payments ?? []), { payer_id: '', share: '1' }] })
                      }
                    >
                      新增付款歸屬
                    </Button>
                  </>
                )}
              </details>
            );
          })}
          {value.people.some((p) => !ctx.people.some((q) => q.id === p.id)) && (
            <Notice>
              原稿含已不在目前名冊的人員，請核對後移除。
              <Button
                onClick={() => edit({ people: value.people.filter((p) => ctx.people.some((q) => q.id === p.id)) })}
              >
                移除已失效名單
              </Button>
            </Notice>
          )}
          <details>
            <summary>額外付款人 · {value.custom_payers.length}</summary>
            {value.custom_payers.map((p, index) => (
              <div key={p.id}>
                <Field label={'額外付款人 ' + (index + 1) + ' 稱呼'}>
                  <input
                    value={p.name}
                    onChange={(e) =>
                      edit({
                        custom_payers: value.custom_payers.map((v) =>
                          v.id === p.id ? { ...v, name: e.target.value } : v,
                        ),
                      })
                    }
                  />
                </Field>
                <Button
                  variant="ghost"
                  onClick={() => edit({ custom_payers: value.custom_payers.filter((v) => v.id !== p.id) })}
                >
                  移除額外付款人 {index + 1}
                </Button>
              </div>
            ))}
            <Button
              variant="secondary"
              disabled={value.custom_payers.length >= 50}
              onClick={() =>
                edit({ custom_payers: [...value.custom_payers, { id: 'custom:' + newSettlementId(), name: '' }] })
              }
            >
              新增額外付款人
            </Button>
          </details>
          <Field label="結算方式">
            <select
              disabled={!ctx.is_owner}
              value={value.rooms !== undefined ? 'rooms' : 'items'}
              onChange={(e) =>
                edit(
                  e.target.value === 'rooms'
                    ? { rooms: [], merchant_payment: undefined, payment_codes: [] }
                    : {
                        rooms: undefined,
                        merchant_payment: {
                          mode: ctx.has_merchant_records ? 'recorded' : 'unpaid',
                          method: 'other',
                          merchant: '',
                          note: '',
                          reason: '',
                        },
                      },
                )
              }
            >
              <option value="items">依費用項目</option>
              <option value="rooms">依實際包間</option>
            </select>
          </Field>
          {value.rooms !== undefined ? (
            <>
              <Notice>每位結算人員都須分配一個實際包間，包含免 A 者。預分包間不代表已付款。</Notice>
              <RoomFields
                rooms={value.rooms}
                people={included}
                payers={payers}
                actual
                arrange={ctx.is_owner}
                change={(rooms) => edit({ rooms })}
                create={() => ({
                  id: newSettlementId(),
                  name: '',
                  payer_id: '',
                  person_ids: [],
                  amount: '',
                  merchant_mode: 'unpaid',
                })}
              />
              {value.rooms.some((r) => r.merchant_mode === 'paid') && (
                <MerchantDetails
                  payment={value.room_payment_details ?? { method: 'other', note: '', reason: '' }}
                  change={(room_payment_details) => edit({ room_payment_details })}
                />
              )}
            </>
          ) : (
            <>
              <ItemFields value={value} people={included} change={(items) => edit({ items })} image={image} />
              <Heading level={3}>店家款項</Heading>
              <Field label="店家款項狀態">
                <select
                  value={value.merchant_payment?.mode ?? 'unpaid'}
                  onChange={(e) =>
                    edit({
                      merchant_payment: {
                        method: 'other',
                        merchant: '',
                        note: '',
                        reason: '',
                        ...value.merchant_payment,
                        mode: e.target.value as 'paid' | 'unpaid' | 'recorded',
                      },
                    })
                  }
                >
                  <option value="unpaid">尚未付款</option>
                  <option value="paid">已付款，這次登記</option>
                  <option value="recorded">已登記到帳本</option>
                </select>
              </Field>
              {value.merchant_payment?.mode === 'paid' && (
                <>
                  <Field label="實際付款金額">
                    <input
                      inputMode="decimal"
                      value={value.merchant_payment.amount ?? ''}
                      onChange={(e) =>
                        edit({ merchant_payment: { ...value.merchant_payment!, amount: e.target.value } })
                      }
                    />
                  </Field>
                  <PayerSelect
                    label="實際付款人"
                    value={value.merchant_payment.payer_id ?? ''}
                    payers={payers}
                    change={(payer_id) => edit({ merchant_payment: { ...value.merchant_payment!, payer_id } })}
                  />
                  <Field label="店家">
                    <input
                      value={value.merchant_payment.merchant}
                      onChange={(e) =>
                        edit({ merchant_payment: { ...value.merchant_payment!, merchant: e.target.value } })
                      }
                    />
                  </Field>
                  <MerchantDetails
                    payment={value.merchant_payment}
                    change={(payment) => edit({ merchant_payment: { ...value.merchant_payment!, ...payment } })}
                  />
                </>
              )}
              <PaymentCodes
                viewer={viewer}
                value={value}
                change={(payment_codes) => edit({ payment_codes })}
                image={image}
              />
            </>
          )}
          <Field label="結算備註（最多 1000 字）">
            <textarea value={value.note} rows={3} onChange={(e) => edit({ note: e.target.value })} />
          </Field>
          <Field label="發布／修改原因（最多 300 字）">
            <textarea value={value.reason} rows={2} onChange={(e) => edit({ reason: e.target.value })} />
          </Field>
          {ctx.bill?.mode === 'legacy' && (
            <label className="consent">
              <input
                type="checkbox"
                checked={value.convert_legacy}
                onChange={(e) => edit({ convert_legacy: e.target.checked })}
              />
              <span>確認將舊人均帳單轉為逐人結算；歷史版本保留。</span>
            </label>
          )}
          <label className="consent">
            <input
              type="checkbox"
              checked={value.group_notice}
              onChange={(e) => edit({ group_notice: e.target.checked })}
            />
            <span>
              允許群通知包含逐人金額、付款歸屬{value.rooms !== undefined ? '' : '及本版收款碼'}
              ；請確認群成員可查看這些資料。
            </span>
          </label>
          <label className="consent">
            <input
              type="checkbox"
              checked={value.reviewed_roster}
              onChange={(e) => edit({ reviewed_roster: e.target.checked })}
            />
            <span>已逐人核對名單、費用約定、出席與付款歸屬。</span>
          </label>
          {stale && <Notice>原稿使用較舊版本，請保留輸入並核對最新版。</Notice>}
          <Button variant="secondary" disabled={stale || !allowed} onClick={() => void check()}>
            預覽逐人結算
          </Button>
        </fieldset>
        {preview && (
          <section aria-label="逐人結算預覽">
            <Heading level={3}>第 {preview.base_version + 1} 版預覽</Heading>
            <SettlementSnapshotView snapshot={preview.snapshot} />
            <PreviewAssets viewer={viewer} id={ctx.id} value={value} />
            {preview.group_preview && (
              <details open>
                <summary>群通知明細預覽</summary>
                <Text className="preserve-lines">{preview.group_preview}</Text>
              </details>
            )}
            <label className="consent">
              <input
                type="checkbox"
                checked={confirmed}
                disabled={form.locked}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              <span>已核對本版金額、圖片與群通知，確認發布。</span>
            </label>
          </section>
        )}
        <Button
          type="submit"
          loading={form.busy}
          disabled={!!form.readError || (!form.draft.pending && (!preview || !confirmed || stale || !allowed))}
        >
          {form.draft.pending ? '確認原結算發布結果' : '發布逐人結算'}
        </Button>
      </form>
      <Button
        variant="secondary"
        disabled={form.locked}
        onClick={() =>
          void form.refresh((old, fresh) => ({
            ...old,
            revision: fresh.revision,
            base_version: fresh.bill?.version ?? 0,
            reviewed_roster: false,
          }))
        }
      >
        核對最新名冊與帳本，保留輸入
      </Button>
      <DraftFeedback form={form} />
    </Surface>
  );
}
function ItemFields({
  value,
  people,
  change,
  image,
}: {
  value: EditableInput;
  people: Context['people'];
  change: (items: EditableInput['items']) => void;
  image: (file: File, apply: (raw: string) => void) => Promise<void>;
}) {
  const edit = (id: string, patch: Partial<EditableInput['items'][number]>) =>
    change(value.items.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  return (
    <>
      <Heading level={3}>費用項目</Heading>
      {value.items.map((item, index) => (
        <fieldset key={item.id}>
          <legend>費用 {index + 1}</legend>
          <Field label="費用名稱">
            <input value={item.name} onChange={(e) => edit(item.id, { name: e.target.value })} />
          </Field>
          <Field label="類別">
            <select value={item.kind} onChange={(e) => edit(item.id, { kind: e.target.value as typeof item.kind })}>
              {Object.entries(kindLabels).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="費用金額">
            <input
              inputMode="decimal"
              value={item.amount}
              onChange={(e) => edit(item.id, { amount: e.target.value })}
            />
          </Field>
          <Field label="分攤範圍">
            <select
              value={item.scope}
              onChange={(e) => edit(item.id, { scope: e.target.value as 'common' | 'selected' })}
            >
              <option value="common">所有本版人員</option>
              <option value="selected">指定人員</option>
            </select>
          </Field>
          <Field label="分攤方式">
            <select value={item.mode} onChange={(e) => edit(item.id, { mode: e.target.value as typeof item.mode })}>
              {Object.entries(modeLabels).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="分攤依據">
            <textarea rows={2} value={item.reason} onChange={(e) => edit(item.id, { reason: e.target.value })} />
          </Field>
          {(item.scope === 'selected' || ['fixed', 'weights', 'duration'].includes(item.mode)) && (
            <details open>
              <summary>分配數值／人員</summary>
              {people.map((p) => {
                const a = item.allocations.find((a) => a.person_id === p.id),
                  selected = item.scope === 'common' || !!a;
                const update = (patch: Partial<NonNullable<typeof a>>) =>
                  edit(item.id, {
                    allocations: [
                      ...item.allocations.filter((v) => v.person_id !== p.id),
                      { person_id: p.id, ...a, ...patch },
                    ],
                  });
                return (
                  <div key={p.id}>
                    <label className="consent">
                      <input
                        type="checkbox"
                        checked={selected}
                        disabled={item.scope === 'common'}
                        onChange={(e) =>
                          edit(item.id, {
                            allocations: e.target.checked
                              ? [...item.allocations, { person_id: p.id }]
                              : item.allocations.filter((v) => v.person_id !== p.id),
                          })
                        }
                      />
                      <span>{p.label}</span>
                    </label>
                    {selected && item.mode === 'fixed' && (
                      <Field label={p.label + ' 固定金額'}>
                        <input
                          inputMode="decimal"
                          value={a?.amount ?? ''}
                          onChange={(e) => update({ amount: e.target.value })}
                        />
                      </Field>
                    )}
                    {selected && item.mode === 'weights' && (
                      <Field label={p.label + ' 比例'}>
                        <input
                          inputMode="decimal"
                          value={a?.weight ?? ''}
                          onChange={(e) => update({ weight: e.target.value })}
                        />
                      </Field>
                    )}
                    {selected && item.mode === 'duration' && (
                      <Field label={p.label + ' 分鐘（0–1440）'}>
                        <input
                          type="number"
                          min={0}
                          max={1440}
                          value={a?.minutes ?? ''}
                          onChange={(e) =>
                            update({ minutes: e.target.value === '' ? undefined : Number(e.target.value) })
                          }
                        />
                      </Field>
                    )}
                  </div>
                );
              })}
            </details>
          )}
          <Field label="消費憑證（最多三項附圖）">
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void image(file, (receipt) => edit(item.id, { receipt }));
              }}
            />
          </Field>
          {item.receipt && (
            <>
              <Text>
                {typeof item.receipt === 'string' ? '已選擇新憑證' : '沿用第 ' + item.receipt.version + ' 版憑證'}
              </Text>
              {typeof item.receipt === 'string' && (
                <img
                  className="payment-asset-thumb"
                  alt={'新消費憑證 · ' + item.name}
                  src={'data:image/png;base64,' + item.receipt}
                />
              )}
              <Button variant="ghost" onClick={() => edit(item.id, { receipt: null })}>
                移除本項憑證
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            disabled={value.items.length <= 1}
            onClick={() => change(value.items.filter((v) => v.id !== item.id))}
          >
            移除費用 {index + 1}
          </Button>
        </fieldset>
      ))}
      <Button
        variant="secondary"
        disabled={value.items.length >= 50}
        onClick={() =>
          change([
            ...value.items,
            {
              id: newSettlementId(),
              name: '',
              amount: '',
              kind: 'expense',
              scope: 'common',
              mode: 'shares',
              reason: '',
              allocations: [],
              receipt: null,
            },
          ])
        }
      >
        新增費用
      </Button>
    </>
  );
}
type PaymentDetails = NonNullable<EditableInput['room_payment_details']>;
function MerchantDetails({ payment, change }: { payment: PaymentDetails; change: (payment: PaymentDetails) => void }) {
  return (
    <>
      <Field label="實際付款時間（含時區）">
        <input
          value={payment.occurred_at ?? ''}
          onChange={(e) => change({ ...payment, occurred_at: e.target.value })}
        />
      </Field>
      <Field label="付款方式">
        <select
          value={payment.method}
          onChange={(e) => change({ ...payment, method: e.target.value as PaymentDetails['method'] })}
        >
          {Object.entries({ wechat: '微信', alipay: '支付寶', qq: 'QQ', cash: '現金', other: '其他' }).map(
            ([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ),
          )}
        </select>
      </Field>
      <Field label="付款備註">
        <textarea value={payment.note} onChange={(e) => change({ ...payment, note: e.target.value })} />
      </Field>
      <Field label="付款依據">
        <textarea value={payment.reason} onChange={(e) => change({ ...payment, reason: e.target.value })} />
      </Field>
    </>
  );
}
function PaymentCodes({
  viewer,
  value,
  change,
  image,
}: {
  viewer: Member;
  value: EditableInput;
  change: (codes: EditableInput['payment_codes']) => void;
  image: (file: File, apply: (raw: string) => void) => Promise<void>;
}) {
  const library = useQuery({
    queryKey: ['private', viewer.scope, 'payment-codes'],
    queryFn: () => api('/me/payment-codes', PaymentCodeLibrary, { headers: scoped(viewer) }),
  });
  return (
    <details>
      <summary>本版收款碼 · {value.payment_codes.length} 張</summary>
      {library.error && <Failure error={library.error} retry={() => void library.refetch()} />}
      <Link to="/me/payment-codes">管理我的收款碼</Link>
      {(['wechat', 'alipay', 'other'] as const).map((kind) => {
        const current = value.payment_codes.find((p) => p.kind === kind),
          update = (choice: EditableInput['payment_codes'][number] | null) =>
            change([...value.payment_codes.filter((p) => p.kind !== kind), ...(choice ? [choice] : [])]);
        return (
          <fieldset key={kind}>
            <legend>{paymentKindLabels[kind]}</legend>
            <Field label={paymentKindLabels[kind] + '收款碼來源'}>
              <select
                value={current && 'code_id' in current ? current.code_id : current ? 'selected' : ''}
                onChange={(e) => {
                  const id = e.target.value;
                  if (!id) update(null);
                  else if (id !== 'selected') update({ kind, code_id: id });
                }}
              >
                <option value="">不附收款碼</option>
                {current && !('code_id' in current) && (
                  <option value="selected">
                    {'version' in current ? '沿用第 ' + current.version + ' 版' : '新上傳圖片'}
                  </option>
                )}
                {library.data?.codes
                  .filter((p) => p.kind === kind)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name || paymentKindLabels[kind]}
                    </option>
                  ))}
                {current && 'code_id' in current && !library.data?.codes.some((p) => p.id === current.code_id) && (
                  <option value={current.code_id}>原收款碼目前不可用，請重新選擇</option>
                )}
              </select>
            </Field>
            <Field label={'上傳' + paymentKindLabels[kind] + '收款碼'}>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void image(file, (raw) => update({ kind, name: '', image: raw }));
                }}
              />
            </Field>
            {current && 'image' in current && (
              <>
                <Field label="收款方式名稱">
                  <input value={current.name} onChange={(e) => update({ ...current, name: e.target.value })} />
                </Field>
                <img
                  className="payment-asset-thumb"
                  alt={paymentKindLabels[kind] + '新收款碼'}
                  src={'data:image/png;base64,' + current.image}
                />
              </>
            )}
            {current && (
              <Button variant="ghost" onClick={() => update(null)}>
                移除{paymentKindLabels[kind]}收款碼
              </Button>
            )}
          </fieldset>
        );
      })}
    </details>
  );
}
function PreviewAssets({ viewer, id, value }: { viewer: Member; id: string; value: EditableInput }) {
  const library = useQuery({
    queryKey: ['private', viewer.scope, 'payment-codes'],
    queryFn: () => api('/me/payment-codes', PaymentCodeLibrary, { headers: scoped(viewer) }),
  });
  return (
    <>
      {value.payment_codes.map((code) => (
        <details key={code.kind} open>
          <summary>{paymentKindLabels[code.kind]}收款碼</summary>
          {'image' in code ? (
            <img className="payment-asset-thumb" alt="本版收款碼預覽" src={'data:image/png;base64,' + code.image} />
          ) : (
            <PaymentAssetImage
              url={
                'version' in code
                  ? '/api/v2' + base(id) + '/settlement/history/' + code.version + '/payment-codes/' + code.kind
                  : (library.data?.codes.find((c) => c.id === code.code_id)?.url ??
                    '/api/v2/me/payment-codes/' + code.code_id + '/image')
              }
              scope={viewer.scope}
              label="本版收款碼預覽"
            />
          )}
        </details>
      ))}
      {(value.rooms?.length ? [] : value.items)
        .filter((item) => item.receipt)
        .map((item) => (
          <details key={item.id} open>
            <summary>{item.name} · 消費憑證</summary>
            {typeof item.receipt === 'string' ? (
              <img
                className="payment-asset-thumb"
                alt="本版消費憑證預覽"
                src={'data:image/png;base64,' + item.receipt}
              />
            ) : (
              item.receipt && (
                <PaymentAssetImage
                  url={
                    '/api/v2' +
                    base(id) +
                    '/settlement/history/' +
                    item.receipt.version +
                    '/receipts/' +
                    item.receipt.item_id
                  }
                  scope={viewer.scope}
                  label="本版消費憑證預覽"
                />
              )
            )}
          </details>
        ))}
    </>
  );
}
