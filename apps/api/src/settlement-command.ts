import type { DB } from '@qgroup/database';
import { SettlementResult } from '@qgroup/contracts';
import { appendEventAudit, eventRow, legacyStamp, type EventRow } from './activity-arrangements';
import { canonicalSettlement, storedSettlement, type calculateSettlement } from './settlement-calculation';
import { money, settlementDetail, type SettlementUser } from './settlement-context';
import { attachPaymentCodes } from './payment-codes';
import { putPaymentImage } from './payment-media';
import { hash } from './security';
import type { createActivityBot } from './activity-bot';

// Caller owns the immediate transaction and preview-proof validation. Both protocols
// use this same immutable publication, finance, notification and bot write path.
export function publishSettlement(db: DB, event: EventRow, user: SettlementUser,
  baseVersion: number, {snapshot, images, codes}: ReturnType<typeof calculateSettlement>,
  now: () => Date, bot: ReturnType<typeof createActivityBot>, onBotFailure: (id: string) => void) {
  const previous = settlementDetail(db, event.id),
    comparable = ({ reason, changes, ...rest }: typeof snapshot) => {
      void reason;
      void changes;
      return rest;
    },
    changed =
      !previous || canonicalSettlement(comparable(previous)) !== canonicalSettlement(comparable(snapshot)),
    next = baseVersion + (changed ? 1 : 0),
    stamp = legacyStamp(now());
  if (changed) {
    const fields = (
        [
          'people',
          'items',
          'payers',
          'note',
          'qr_digest',
          'payment_codes',
          'collector',
          'merchant_payment',
          'merchant_payments',
          'rooms',
          'group_notice',
        ] as const
      ).filter((k) => !previous || canonicalSettlement(previous[k]) !== canonicalSettlement(snapshot[k])),
      row = db.prepare('SELECT total_cents FROM settlements WHERE event_id=?').get(event.id) as
        | { total_cents: number }
        | undefined;
    db.prepare(
      'INSERT INTO settlement_history(event_id,version,total_cents,headcount,note,qr_image,updated_at,actor_id,actor_name,kind,changed_fields) VALUES(?,?,?,?,?,NULL,?,?,?,?,?)',
    ).run(
      event.id,
      next,
      snapshot.total_cents,
      Math.max(1, snapshot.people.length),
      snapshot.note,
      stamp,
      user.id,
      user.nickname,
      previous ? 'detailed_edited' : row ? 'converted' : 'detailed_published',
      JSON.stringify(fields),
    );
    db.prepare('INSERT INTO settlement_details VALUES(?,?,?)').run(event.id, next, storedSettlement(snapshot));
    attachPaymentCodes(db, event.id, next, codes, now());
    for (const [id, raw] of images)
      db.prepare('INSERT INTO settlement_receipt_images VALUES(?,?,?,?)').run(
        event.id,
        next,
        id,
        putPaymentImage(db, raw, now()),
      );
    db.prepare(
      'INSERT INTO settlements(event_id,total_cents,headcount,qr_image,note,updated_at) VALUES(?,?,?,NULL,?,?) ON CONFLICT(event_id) DO UPDATE SET total_cents=excluded.total_cents,headcount=excluded.headcount,qr_image=NULL,note=excluded.note,updated_at=excluded.updated_at',
    ).run(event.id, snapshot.total_cents, Math.max(1, snapshot.people.length), snapshot.note, stamp);
    const txs = [
      ...(snapshot.merchant_payments ?? []).map((tx, i) => ({ tx, suffix: 'room:' + i })),
      ...(snapshot.merchant_payment ? [{ tx: snapshot.merchant_payment, suffix: 'expense' }] : []),
    ];
    for (const { tx, suffix } of txs) {
      const id = hash(event.id + ':settlement:' + next + ':' + suffix).slice(0, 16);
      db.prepare(
        'INSERT INTO finance_entries(id,event_id,kind,payload_json,occurred_at,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?)',
      ).run(id, event.id, 'expense', JSON.stringify(tx), tx.occurred_at!, user.id, user.nickname, stamp);
      appendEventAudit(
        db,
        event,
        user,
        'finance_record',
        {},
        { operation: { id, transaction: tx } },
        snapshot.reason,
        stamp,
      );
    }
    appendEventAudit(
      db,
      event,
      user,
      'settlement_saved',
      row ? { version: baseVersion, total_amount: money(row.total_cents) } : {},
      { version: next, total_amount: money(snapshot.total_cents), mode: 'detailed', changed_fields: fields },
      snapshot.reason,
      stamp,
    );
    for (const recipient of db
      .prepare("SELECT DISTINCT manager_id FROM attendees WHERE event_id=? AND status!='invited'")
      .all(event.id) as { manager_id: string }[])
      db.prepare(
        "INSERT INTO notifications(user_id,event_id,kind,message,created_at) VALUES(?,?,'settlement_updated',?,?)",
      ).run(
        recipient.manager_id,
        event.id,
        event.title + ' 已发布逐人结算第 ' + next + ' 版，请查看应付与付款归属',
        stamp,
      );
    try {
      db.transaction(() => bot.broadcast(eventRow(db, event.id)!, 'settlement_updated'))();
    } catch {
      onBotFailure(event.id);
    }
  }
  const result = SettlementResult.parse({
    id: event.id,
    revision: eventRow(db, event.id)!.revision,
    version: next,
    changed,
  });
  return result;
}
