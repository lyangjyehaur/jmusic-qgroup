import type { StoredSettlementSnapshot } from '@qgroup/contracts';
import type { z } from 'zod';
import { money } from './settlement-context';
const cut = (s: string, n: number) => Array.from(s).slice(0, n).join('');
export function settlementNotice(snapshot: z.infer<typeof StoredSettlementSnapshot>) {
  if (snapshot.rooms?.length) {
    const lines = ['按实际包间结算：'];
    for (const room of (snapshot.room_balances ?? []).slice(0, 10)) {
      lines.push(
        cut(room.name, 40) +
          ' · ' +
          money(room.total_cents) +
          ' 元 · 收款人：' +
          cut(room.payer_label ?? room.payer_name, 36),
      );
      for (const t of room.transfers.slice(0, 10))
        lines.push(cut(t.from_name, 36) + ' → ' + cut(t.to_name, 36) + '：' + money(t.amount_cents) + ' 元');
      if (room.transfers.length > 10) lines.push('其余转款请到活动页查看');
    }
    lines.push('逐人 AA、全部包间及后续收退款请到活动页和账本核对；本版不附统一收款码。');
    return lines;
  }
  const lines = [
    '收款人：' + (snapshot.collector?.name ?? '请到站内核对'),
    '逐人 AA：',
    ...snapshot.people.slice(0, 20).map((p) => cut(p.label || p.name, 36) + '：' + money(p.due_cents) + ' 元'),
  ];
  if (snapshot.people.length > 20) lines.push('其余人员 AA 请到活动页查看');
  if (!snapshot.balances) {
    lines.push(
      '付款账户应付合计：',
      ...snapshot.payers.slice(0, 20).map((p) => cut(p.label || p.name, 36) + '：' + money(p.amount_cents) + ' 元'),
    );
    if (snapshot.payers.length > 20) lines.push('其余付款账户请到活动页查看');
    lines.push('本版未保存收付款快照，待补与退款请到站内账本核对。');
    return lines;
  }
  lines.push('付款账户待补／应退：');
  for (const p of snapshot.balances.slice(0, 20)) {
    const n = p.balance_cents;
    lines.push(
      cut(p.label || p.name, 36) +
        '：AA ' +
        money(p.due_cents) +
        ' 元，' +
        (n > 0 ? '待补 ' + money(n) + ' 元' : n < 0 ? '应退／待偿还 ' + money(-n) + ' 元' : '无需补款'),
    );
  }
  if (snapshot.balances.length > 20) lines.push('其余人员请到活动页查看');
  lines.push('以上为本版发布时金额，后续收退款以站内账本为准。');
  return lines;
}
