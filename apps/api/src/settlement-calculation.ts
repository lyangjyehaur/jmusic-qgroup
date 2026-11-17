import type { DB } from '@qgroup/database';
import { FinanceTransaction, SettlementInput, SettlementSnapshot } from '@qgroup/contracts';
import { parseAmount, parseWeight, splitCents } from '@qgroup/domain';
import { z } from 'zod';
import { legacyStamp, type EventRow } from './activity-arrangements';
import { financeEntries, financeParties, roomReconciliation, validateRoomJournal } from './finance-context';
import { projectJournal } from './finance-projection';
import { financeTransaction } from './finance';
import { imageDigest } from './payment-media';
import { resolvePaymentCodes, resolveSettlementReceipt } from './payment-codes';
import {
  currentRooms,
  journalRoomIds,
  money,
  normalizeRooms,
  requireSettlement,
  roomPlan,
  settlementDetail,
  settlementFail as fail,
  settlementRoster,
  settlementVersion,
  type SettlementUser,
} from './settlement-context';
import { hash } from './security';
export type Invoice = z.infer<typeof SettlementSnapshot>;
export function canonicalSettlement(value: unknown): string {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return '[' + value.map(canonicalSettlement).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonicalSettlement(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
const equal = (a: unknown, b: unknown) => canonicalSettlement(a) === canonicalSettlement(b);
/** Native token protocol; journal sequence is a JSON integer on disk, a decimal string on the wire. */
export const settlementToken = (event: EventRow, snapshot: Invoice, version: number) =>
  hash(
    canonicalSettlement({
      event_id: event.id,
      revision: event.revision,
      version,
      snapshot: { ...snapshot, journal_seq: BigInt(snapshot.journal_seq) },
    }),
  );
export const storedSettlement = (snapshot: Invoice) =>
  canonicalSettlement({ ...snapshot, journal_seq: BigInt(snapshot.journal_seq) });
export function settlementChanges(before: Invoice | null, after: Invoice): string[] {
  if (!before) return ['发布逐人核对后的费用与付款归属；旧人均版本如有则保留原样。'];
  const result: string[] = [];
  for (const key of ['people', 'items', 'payers'] as const) {
    const prior = new Map<string, any>(before[key].map((p) => [p.id, p])),
      current = new Map<string, any>(after[key].map((p) => [p.id, p]));
    for (const id of new Set([...prior.keys(), ...current.keys()])) {
      const old = prior.get(id),
        now = current.get(id),
        label = (now ?? old).label ?? (now ?? old).name;
      if (!old) result.push('新增' + label);
      else if (!now) result.push('不再列入本版：' + label);
      else if (!equal(old, now)) {
        if (key === 'people') {
          result.push(
            label +
              '：应付 ' +
              money(old.due_cents) +
              ' → ' +
              money(now.due_cents) +
              ' 元；共同份数 ' +
              old.share +
              ' → ' +
              now.share,
          );
          if (old.name !== now.name) result.push('称呼：' + old.name + ' → ' + now.name);
          if (!equal(old.payments, now.payments)) {
            const describe = (p: Invoice['people'][number]) =>
              p.payments.map((v) => v.name + ' ' + money(v.amount_cents)).join('、');
            result.push(label + ' 付款归属：' + describe(old) + ' → ' + describe(now));
          }
          if (old.attendance !== now.attendance)
            result.push(label + ' 出席：' + old.attendance + ' → ' + now.attendance);
          if (old.accepted_conditions_version !== now.accepted_conditions_version)
            result.push(label + ' 接受约定版本已更新');
          if (old.reason !== now.reason) result.push(label + ' 核对原因：' + old.reason + ' → ' + now.reason);
        } else if (key === 'items') {
          result.push(
            label +
              '：' +
              money(old.amount_cents) +
              ' → ' +
              money(now.amount_cents) +
              ' 元；' +
              (!equal(old.breakdown, now.breakdown) ? '分摊明细有调整' : '分摊明细不变'),
          );
          if (old.name !== now.name) result.push('项目名称：' + old.name + ' → ' + now.name);
          if (old.receipt_digest !== now.receipt_digest) result.push(label + '：消费凭证已变更，原图保留于旧版本');
          if (old.reason !== now.reason) result.push(label + ' 分摊依据：' + old.reason + ' → ' + now.reason);
        } else {
          result.push(label + ' 付款合计：' + money(old.amount_cents) + ' → ' + money(now.amount_cents) + ' 元');
          if (old.name !== now.name) result.push('付款人称呼：' + old.name + ' → ' + now.name);
        }
      }
    }
  }
  if (before.note !== after.note) result.push('备注：' + (before.note || '无') + ' → ' + (after.note || '无'));
  if (before.qr_digest !== after.qr_digest || !equal(before.payment_codes, after.payment_codes))
    result.push('收款码或收款方式已变更，旧图仍可在历史版本查看');
  return result;
}
export function calculateSettlement(
  db: DB,
  event: EventRow,
  user: SettlementUser,
  raw: z.infer<typeof SettlementInput>,
  now: Date,
) {
  requireSettlement(db, event, user.id);
  const data = SettlementInput.parse(raw),
    version = settlementVersion(db, event.id);
  if (!['ended', 'cancelled'].includes(event.lifecycle)) fail('實際結束或取消後才能發布結算', 409);
  if (data.base_version !== version) fail('結算已有更新；請保留輸入後載入最新版本重新核對', 409);
  const ctx = settlementRoster(db, event, user),
    previous = settlementDetail(db, event.id, version);
  if (data.rooms === undefined && (roomPlan(db, event.id).rooms.length || previous?.rooms?.length))
    fail('活動已設定包間，請核對實際包間後結算', 409);
  if (db.prepare('SELECT 1 FROM settlements WHERE event_id=?').get(event.id) && !previous && !data.convert_legacy)
    fail('舊人均帳單需要明確確認轉換；舊版本將完整保留');
  const payers = new Map(ctx.payers.map((p) => [p.id, p.name])),
    customSeen = new Set<string>();
  for (const p of data.custom_payers) {
    if (customSeen.has(p.id)) fail('額外付款人標識重複');
    customSeen.add(p.id);
    payers.set(p.id, p.name);
  }
  const labels = new Map(
      [...payers].map(([id, name], i) => [
        id,
        name + ([...payers.values()].filter((n) => n === name).length > 1 ? '（付款人 ' + (i + 1) + '）' : ''),
      ]),
    ),
    known = new Map(ctx.people.map((p) => [p.id, p])),
    submitted = new Map<string, z.infer<typeof SettlementInput>['people'][number]>();
  for (const p of data.people) {
    if (!known.has(p.id) || submitted.has(p.id)) fail('結算名單含重複或其他活動的人員');
    submitted.set(p.id, p);
  }
  const people: Invoice['people'] = [],
    inputs: Invoice['input']['people'] = [];
  for (const original of ctx.people) {
    const p = submitted.get(original.id);
    if (!p) {
      if (original.status === 'confirmed') fail('請保留所有正式人員；不分攤共同費用可設為免 A 並寫原因');
      continue;
    }
    if (
      (parseWeight(p.share) !== 1000n ||
        original.status !== 'confirmed' ||
        original.attendance === 'absent' ||
        original.withdrawal_requested ||
        original.confirmation_state !== 'accepted') &&
      !p.reason
    )
      fail(original.name + ' 的份數、缺席／退出或約定差異需要核對原因');
    const payments = p.payments ?? [{ payer_id: original.payer_id, share: '1' }],
      used = new Set<string>(),
      normalized: Invoice['input']['people'][number]['payments'] = [];
    for (const payment of payments) {
      if (!payers.has(payment.payer_id) || used.has(payment.payer_id)) fail('付款人不正確或重複');
      used.add(payment.payer_id);
      if (p.payment_mode === 'fixed') {
        if (payment.amount === undefined) fail('請填寫固定付款金額');
        parseAmount(payment.amount!);
        normalized.push({ payer_id: payment.payer_id, amount: payment.amount });
      } else {
        const share = payment.share ?? '1';
        parseWeight(share);
        normalized.push({ payer_id: payment.payer_id, share });
      }
    }
    if ((payments.length !== 1 || payments[0]!.payer_id !== original.payer_id) && !p.reason)
      fail('變更付款歸屬請填寫核對原因');
    people.push({ ...original, share: p.share, reason: p.reason, due_cents: 0, allocations: [], payments: [] });
    inputs.push({ id: p.id, share: p.share, reason: p.reason, payment_mode: p.payment_mode, payments: normalized });
  }
  if (!data.rooms?.length && journalRoomIds(db, event.id).size)
    fail('已有包間款項，請保留包間結算並核對各包間費用', 409);
  const rooms = data.rooms?.length
    ? normalizeRooms(data.rooms, new Map(people.map((p) => [p.id, p])), payers, true).map((r) => ({
        ...r,
        payer_label: labels.get(r.payer_id)!,
        ...(r.merchant_mode === 'paid' ? { paid_amount: r.paid_amount ?? r.amount } : { paid_amount: undefined }),
      }))
    : [];
  const arrangement = (rows: { id: string; name: string; payer_id: string; person_ids: string[] }[]) =>
    rows.map(({ id, name, payer_id, person_ids }) => ({ id, name, payer_id, person_ids }));
  if (event.owner_id !== user.id && !equal(arrangement(rooms), arrangement(currentRooms(db, event.id))))
    fail('只有發起者可以調整實際包間人員及付款人', 403);
  const items: z.infer<typeof SettlementInput>['items'] = rooms.length
    ? rooms.map((r) => ({
        id: r.id,
        name: r.name,
        amount: r.amount,
        scope: 'selected',
        mode: 'shares',
        kind: 'expense',
        reason: '按已核对的实际包间分摊',
        allocations: r.person_ids.map((person_id) => ({ person_id })),
        receipt: null,
      }))
    : data.items;
  if (!items.length) fail('請填寫 1–50 項費用，免費活動可填 0 元');
  const images = new Map<string, Buffer>(),
    calculated: Invoice['items'] = [],
    itemInputs: Invoice['input']['items'] = [],
    seen = new Set<string>();
  let total = 0;
  for (const item of items) {
    if (seen.has(item.id)) fail('費用項標識重複');
    seen.add(item.id);
    const unsigned = parseAmount(item.amount),
      signed = item.kind === 'expense' ? unsigned : -unsigned;
    if ((item.kind !== 'expense' || item.scope === 'selected' || item.mode !== 'shares') && !item.reason)
      fail('指定消費、退款、減免或特殊分攤需要填寫依據');
    const allocations = new Map<string, z.infer<typeof SettlementInput>['items'][number]['allocations'][number]>();
    for (const a of item.allocations) {
      if (!people.some((p) => p.id === a.person_id) || allocations.has(a.person_id))
        fail('費用含重複或名單以外的分攤對象');
      allocations.set(a.person_id, a);
    }
    const selected = item.scope === 'common' ? people : people.filter((p) => allocations.has(p.id));
    if (
      ['fixed', 'weights', 'duration'].includes(item.mode) &&
      (allocations.size !== selected.length || selected.some((p) => !allocations.has(p.id)))
    )
      fail('固定金額、比例及按時長分攤需為每位選中人員填寫數值');
    const entries: Invoice['input']['items'][number]['allocations'] = [],
      weights: bigint[] = [];
    for (const p of selected) {
      const a = allocations.get(p.id);
      if (item.mode === 'fixed') {
        if (a?.amount === undefined) fail('請填寫每位人員固定金額');
        const value = parseAmount(a!.amount!);
        weights.push(value);
        entries.push({ person_id: p.id, amount: money(value) });
      } else if (item.mode === 'weights') {
        if (a?.weight === undefined) fail('請填寫每位人員分攤比例');
        weights.push(parseWeight(a!.weight!));
        entries.push({ person_id: p.id, weight: a!.weight! });
      } else if (item.mode === 'duration') {
        if (a?.minutes === undefined) fail('請填寫每位人員參與時長');
        weights.push(BigInt(a!.minutes!));
        entries.push({ person_id: p.id, minutes: a!.minutes! });
      } else {
        weights.push(item.mode === 'shares' ? parseWeight(p.share) : 1000n);
        entries.push({ person_id: p.id });
      }
    }
    if (item.mode === 'fixed' && weights.reduce((a, b) => a + b, 0n) !== unsigned)
      fail('固定指定金額合計必須等於這項費用');
    const allocated = splitCents(signed, weights),
      image = resolveSettlementReceipt(db, event.id, version, item.receipt);
    if (image) {
      images.set(item.id, image);
      if (images.size > 3) fail('每版最多三張消費憑證');
    }
    const normalized = {
      id: item.id,
      name: item.name,
      kind: item.kind,
      amount: money(unsigned),
      scope: item.scope,
      mode: item.mode,
      reason: item.reason,
      allocations: entries,
      receipt_digest: image ? imageDigest(image) : null,
    };
    const breakdown = selected.map((p, i) => {
      const amount_cents = Number(allocated[i]!);
      p.due_cents += amount_cents;
      p.allocations.push({ item_id: item.id, amount_cents });
      return { ...entries[i]!, amount_cents };
    });
    calculated.push({ ...normalized, amount_cents: Number(signed), breakdown, has_receipt: !!image });
    itemInputs.push(normalized);
    total += Number(signed);
  }
  if (total < 0 || total > 999999999) fail('結算淨額需為 0–9999999.99 元；預收款退款請使用後續收退款帳本');
  const payerTotals = new Map<string, number>();
  for (let i = 0; i < people.length; i++) {
    const p = people[i]!,
      input = inputs[i]!;
    if (p.due_cents < 0) fail(p.name + ' 的退款／減免超過其消費，請核對對應項目');
    const amounts =
      input.payment_mode === 'fixed'
        ? input.payments.map((v) => parseAmount(v.amount!))
        : splitCents(
            BigInt(p.due_cents),
            input.payments.map((v) => parseWeight(v.share!)),
          );
    if (amounts.reduce((a, b) => a + b, 0n) !== BigInt(p.due_cents))
      fail(p.name + ' 的固定付款歸屬合計須等於其應付金額');
    input.payments.forEach((v, j) => {
      const amount_cents = Number(amounts[j]!);
      payerTotals.set(v.payer_id, (payerTotals.get(v.payer_id) ?? 0) + amount_cents);
      p.payments.push({
        payer_id: v.payer_id,
        name: payers.get(v.payer_id)!,
        label: labels.get(v.payer_id)!,
        amount_cents,
      });
    });
  }
  if (rooms.length && data.payment_codes.length) fail('包間結算請按各包間收款人轉帳，本版不附統一收款碼');
  const codes = resolvePaymentCodes(db, event.id, user.id, version, data.payment_codes);
  if ([...images.values(), ...codes.map((c) => c.raw)].reduce((n, b) => n + b.length, 0) > 6 * 1024 * 1024)
    fail('本版圖片合計超過 6 MiB，請壓縮後重試');
  if (version && !data.reason) fail('修改或轉換結算請填寫原因');
  const usedPayers = new Set([
      ...inputs.flatMap((p) => p.payments.map((v) => v.payer_id)),
      ...(data.merchant_payment?.payer_id ? [data.merchant_payment.payer_id] : []),
      ...rooms.map((r) => r.payer_id),
    ]),
    custom = data.custom_payers.filter((p) => usedPayers.has(p.id));
  let journal = financeEntries(db, event.id),
    state = projectJournal(journal);
  const seq = journal.at(-1)?.seq ?? 0n;
  const snapshot: Invoice = {
    people,
    items: calculated,
    payers: [...payerTotals].map(([id, amount_cents]) => ({
      id,
      name: payers.get(id)!,
      label: labels.get(id)!,
      amount_cents,
    })),
    total_cents: total,
    note: data.note,
    reason: data.reason,
    qr_digest: codes[0]?.meta.digest ?? null,
    payment_codes: codes.map((c) => c.meta),
    rounding_rule: '按最大余数补分，余数相同按本版冻结的报名顺序；每项独立分配。',
    input: { people: inputs, items: itemInputs, custom_payers: custom },
    journal_seq: seq.toString(),
    balances: [],
    group_notice: data.group_notice,
    changes: [],
  };
  if (rooms.length) {
    snapshot.rooms = rooms.map(({ id, name, payer_id, payer_name, payer_label, person_ids }) => ({
      id,
      name,
      payer_id,
      payer_name,
      payer_label,
      person_ids,
    }));
    snapshot.input.rooms = rooms;
  } else snapshot.collector = ctx.collector;
  const append = (id: string, tx: NonNullable<Invoice['merchant_payment']>) => {
    journal.push({
      id,
      seq: BigInt(journal.at(-1)?.seq ?? 0) + 1n,
      kind: 'expense',
      payload: tx,
      reversal_of: null,
      occurred_at: tx.occurred_at!,
      created_at: legacyStamp(now),
      actor_name: user.nickname,
      source_report_id: null,
    });
    state = projectJournal(journal);
  };
  const knownFinance = financeParties(db, event, user.id).parties;
  function merchantTx(
    payment: {
      amount?: string;
      payer_id?: string;
      occurred_at?: string;
      method: string;
      merchant?: string;
      note: string;
      reason: string;
    },
    room?: { id: string; name: string },
  ) {
    if (!payment.amount || !payment.payer_id) fail('請填寫實際付款金額及付款人');
    return financeTransaction(
      db,
      event,
      user,
      FinanceTransaction.parse({
        kind: 'expense',
        amount: payment.amount,
        payer_id: payment.payer_id,
        occurred_at: payment.occurred_at ?? legacyStamp(now),
        method: payment.method,
        merchant: payment.merchant ?? '',
        note: payment.note,
        reason: payment.reason,
        funding: 'payer',
        ...(room ? { room_id: room.id, merchant: room.name } : {}),
        custom_parties: custom.filter((p) => p.id === payment.payer_id && !knownFinance.has(p.id)),
      }),
      false,
      now,
      snapshot.rooms,
    );
  }
  if (rooms.length) {
    if (data.merchant_payment) fail('包間結算請分別核對各包間付款情況');
    validateRoomJournal(journal, snapshot.rooms!, true);
    snapshot.merchant_payments = [];
    for (const room of rooms) {
      const scoped = projectJournal(journal.filter((e) => e.kind === 'reversal' || e.payload.room_id === room.id)),
        has = scoped.expenses.size || scoped.deposits.size;
      if (room.merchant_mode === 'recorded' && !has) fail('該包間尚無店家款項記錄，請確認實際付款情況');
      if (room.merchant_mode !== 'paid') continue;
      if (has) fail('該包間已有店家款項，請選已登記並到帳本補錄', 409);
      const tx = merchantTx(
        {
          method: 'other',
          note: '',
          reason: '',
          ...data.room_payment_details,
          amount: room.paid_amount!,
          payer_id: room.payer_id,
        },
        room,
      );
      snapshot.merchant_payments.push(tx);
      append('preview:' + room.id, tx);
    }
    validateRoomJournal(journal, snapshot.rooms!, true);
    snapshot.room_balances = roomReconciliation(snapshot, journal);
  } else if (data.merchant_payment) {
    const p = data.merchant_payment,
      has = state.expenses.size || state.deposits.size;
    if (p.mode === 'paid') {
      if (has) fail('已有店家款項記錄，請選擇已登記並到帳本核對或補錄', 409);
      snapshot.merchant_payment = merchantTx(p);
      append('preview', snapshot.merchant_payment);
    } else if (p.mode === 'recorded' && !has) fail('尚無店家款項記錄，請確認實際付款情況');
  }
  snapshot.balances = [...new Set([...payerTotals.keys(), ...state.credit.keys()])].map((id) => ({
    id,
    name: payers.get(id) ?? journal.flatMap((e) => e.payload.parties ?? []).find((p) => p.id === id)?.name ?? '付款人',
    label: labels.get(id) ?? payers.get(id) ?? '付款人',
    due_cents: payerTotals.get(id) ?? 0,
    contributed_cents: state.credit.get(id) ?? 0,
    balance_cents: (payerTotals.get(id) ?? 0) - (state.credit.get(id) ?? 0),
  }));
  snapshot.changes = settlementChanges(previous, snapshot);
  if (previous && snapshot.collector && !equal(previous.collector, snapshot.collector))
    snapshot.changes.push('本版收款人：' + snapshot.collector.name);
  if (previous && !equal(previous.rooms ?? [], snapshot.rooms ?? []))
    snapshot.changes.push('包间人员或付款人已变更，请核对各包间收款明细');
  return { snapshot: SettlementSnapshot.parse(snapshot), images, codes };
}
