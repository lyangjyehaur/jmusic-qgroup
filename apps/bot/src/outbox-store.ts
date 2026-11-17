import { randomUUID } from 'node:crypto';
import { assertDatabaseUsable, type DB } from '@qgroup/database';

export interface OutboxRow {
  id: number;
  event_id: string | null;
  poll_id: string | null;
  kind: string;
  channel: string;
  target: string;
  payload_json: string;
  due_at: string | null;
  retry_at: string | null;
  status: string;
  attempts: number;
  claim_token: string;
  created_at: string;
}
export const outboxStamp = (date: Date) => date.toISOString().slice(0, 19) + '+00:00';

/** Claim and token assignment share the same SQLite writer lock. No network inside transactions. */
export function claimOutbox(db: DB, now: Date, timeout: number, batch: number): OutboxRow[] {
  if (!Number.isSafeInteger(batch) || batch < 1 || !Number.isFinite(timeout) || timeout < 1)
    throw Error('Invalid outbox claim limits');
  return db
    .transaction(() => {
      assertDatabaseUsable(db);
      const stamp = outboxStamp(now),
        stale = outboxStamp(new Date(now.getTime() - timeout * 1000));
      const rows = db
        .prepare(
          `SELECT * FROM bot_outbox
      WHERE (status='pending' AND (due_at IS NULL OR due_at<=?) AND (retry_at IS NULL OR retry_at<=?))
      OR (status='sending' AND (claimed_at IS NULL OR claimed_at<=?))
      ORDER BY COALESCE(due_at,created_at),id LIMIT ?`,
        )
        .all(stamp, stamp, stale, batch) as OutboxRow[];
      for (const row of rows) {
        row.claim_token = randomUUID().replaceAll('-', '');
        db.prepare("UPDATE bot_outbox SET status='sending',claimed_at=?,claim_token=? WHERE id=?").run(
          stamp,
          row.claim_token,
          row.id,
        );
      }
      return rows;
    })
    .immediate();
}
export function ownsOutbox(db: DB, row: OutboxRow) {
  return !!db
    .prepare("SELECT 1 FROM bot_outbox WHERE id=? AND status='sending' AND claim_token=?")
    .get(row.id, row.claim_token);
}
export function renewOutbox(db: DB, row: OutboxRow, now: Date) {
  assertDatabaseUsable(db);
  return (
    db
      .prepare("UPDATE bot_outbox SET claimed_at=? WHERE id=? AND status='sending' AND claim_token=?")
      .run(outboxStamp(now), row.id, row.claim_token).changes === 1
  );
}
export function markOutbox(
  db: DB,
  row: OutboxRow,
  now: Date,
  status: string,
  error = '',
  options: {
    retryAt?: string | null;
    sent?: boolean;
    simulated?: boolean;
    payload?: Record<string, unknown>;
    failure?: boolean;
  } = {},
) {
  assertDatabaseUsable(db);
  return (
    db
      .prepare(
        `UPDATE bot_outbox SET status=?,last_error=?,sent_at=?,retry_at=?,simulated_at=?,
    delivered_payload_json=?,attempts=attempts+? WHERE id=? AND status='sending' AND claim_token=?`,
      )
      .run(
        status,
        Array.from(error).slice(0, 300).join(''),
        options.sent ? outboxStamp(now) : null,
        options.retryAt ?? null,
        options.simulated ? outboxStamp(now) : null,
        options.payload ? JSON.stringify(options.payload) : null,
        Number(!!options.failure),
        row.id,
        row.claim_token,
      ).changes === 1
  );
}
