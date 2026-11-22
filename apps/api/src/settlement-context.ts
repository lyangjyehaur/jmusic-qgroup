import type { DB } from '@qgroup/database';
import {
  ConditionArrangement,
  SettlementRosterPerson,
  SettlementRoom,
  SettlementSnapshot,
  SettlementBill,
} from '@qgroup/contracts';
import { DomainError, pythonCasefold } from '@qgroup/domain';
import { z } from 'zod';
import { eventScopes, type EventRow } from './activity-arrangements';
import { accountKey, financeEntries, storedFinance } from './finance-context';
import { projectJournal } from './finance-projection';
export type SettlementUser = { id: string; nickname: string };
export const settlementFail = (message: string, status = 400): never => {
  throw new DomainError('SETTLEMENT', message, status);
};
export function requireSettlement(db: DB, event: EventRow, userId: string) {
  if (!eventScopes(db, event, userId).has('settlement')) settlementFail('只有發起者或指定結算人可以管理結算', 403);
}
export const settlementVersion = (db: DB, id: string) =>
  (
    db.prepare('SELECT COALESCE(MAX(version),0) AS version FROM settlement_history WHERE event_id=?').get(id) as {
      version: number;
    }
  ).version;
export function settlementDetail(db: DB, id: string, version = settlementVersion(db, id)) {
  const row = db
    .prepare('SELECT snapshot_json FROM settlement_details WHERE event_id=? AND version=?')
    .get(id, version) as { snapshot_json: string } | undefined;
  return row ? storedFinance(SettlementSnapshot, row.snapshot_json) : null;
}
/** Room reads need the preserved room/name projection, including older bills
 * whose financial schema differs from the native settlement editor. */
export function settlementRoomDetail(db: DB, id: string, version = settlementVersion(db, id)) {
  const row = db.prepare('SELECT snapshot_json FROM settlement_details WHERE event_id=? AND version=?')
    .get(id, version) as { snapshot_json: string } | undefined;
  return row ? z.object({
    rooms: z.array(SettlementRoom).nullish(),
    people: z.array(z.object({ id: z.string(), label: z.string(), status: z.string() })),
  }).parse(JSON.parse(row.snapshot_json)) : null;
}
export function roomPlan(db: DB, id: string) {
  const row = db
    .prepare('SELECT version,snapshot_json FROM event_room_plans WHERE event_id=? ORDER BY version DESC LIMIT 1')
    .get(id) as { version: number; snapshot_json: string } | undefined;
  return { version: row?.version ?? 0, rooms: row ? z.array(SettlementRoom).parse(JSON.parse(row.snapshot_json)) : [] };
}
export function currentRooms(db: DB, id: string) {
  const detail = settlementDetail(db, id);
  return detail ? (detail.rooms ?? []) : roomPlan(db, id).rooms;
}
export function journalRoomIds(db: DB, id: string) {
  const entries = financeEntries(db, id),
    state = projectJournal(entries);
  return new Set(entries.filter((e) => !state.reversed.has(e.id) && e.payload.room_id).map((e) => e.payload.room_id!));
}
export function settlementRoster(db: DB, event: EventRow, user: SettlementUser) {
  const payers = new Map<string, string>(),
    versions = new Map(
      (
        db.prepare('SELECT version,snapshot_json FROM event_conditions WHERE event_id=?').all(event.id) as {
          version: number;
          snapshot_json: string;
        }[]
      ).map((r) => [r.version, ConditionArrangement.parse(JSON.parse(r.snapshot_json))]),
    );
  payers.set(
    accountKey(event.id, event.owner_id),
    (db.prepare('SELECT nickname FROM users WHERE id=?').get(event.owner_id) as { nickname: string }).nickname,
  );
  for (const r of db
    .prepare('SELECT r.user_id,u.nickname FROM event_roles r JOIN users u ON u.id=r.user_id WHERE r.event_id=?')
    .all(event.id) as { user_id: string; nickname: string }[])
    payers.set(accountKey(event.id, r.user_id), r.nickname);
  const rows = db
    .prepare(
      `SELECT a.id,a.status,a.attendance,a.manager_id,a.user_id,a.payer_kind,a.accepted_conditions_version,a.confirmation_state,a.withdrawal_requested,COALESCE(u.nickname,a.name) AS name,m.nickname AS manager_name,o.payer_id AS origin_id,o.payer_name AS origin_name FROM attendees a JOIN users m ON m.id=a.manager_id LEFT JOIN users u ON u.id=a.user_id LEFT JOIN roster_parties p ON p.id=a.party_id LEFT JOIN attendee_payment_origins o ON o.attendee_id=a.id WHERE a.event_id=? AND a.status!='invited' ORDER BY p.seq,a.seq`,
    )
    .all(event.id) as {
    id: string;
    status: string;
    attendance: string;
    manager_id: string;
    user_id: string | null;
    payer_kind: string;
    accepted_conditions_version: number | null;
    confirmation_state: string;
    withdrawal_requested: number;
    name: string;
    manager_name: string;
    origin_id: string | null;
    origin_name: string | null;
  }[];
  const people: z.infer<typeof SettlementRosterPerson>[] = rows.map((r) => {
    const manager = accountKey(event.id, r.manager_id),
      own = r.user_id ? accountKey(event.id, r.user_id) : 'person:' + r.id;
    payers.set(manager, r.manager_name);
    payers.set(own, r.name);
    if (r.origin_id && !payers.has(r.origin_id)) payers.set(r.origin_id, r.origin_name!);
    return {
      id: r.id,
      name: r.name,
      label: r.name,
      status: r.status,
      attendance: r.attendance,
      manager_name: r.manager_name,
      payer_id: r.origin_id ?? (r.payer_kind === 'manager' ? manager : own),
      accepted_conditions_version: r.accepted_conditions_version,
      confirmation_state: r.confirmation_state,
      accepted_arrangement: versions.get(r.accepted_conditions_version!) ?? null,
      withdrawal_requested: !!r.withdrawal_requested,
    };
  });
  for (const e of financeEntries(db, event.id))
    for (const p of e.payload.parties ?? []) if (!payers.has(p.id)) payers.set(p.id, p.name);
  people.forEach((p, i) => {
    p.label = p.name + (people.filter((q) => q.name === p.name).length > 1 ? '（报名 ' + (i + 1) + '）' : '');
  });
  return {
    people,
    payers: [...payers].map(([id, name], i) => ({
      id,
      name,
      label: name + ([...payers.values()].filter((n) => n === name).length > 1 ? '（付款人 ' + (i + 1) + '）' : ''),
    })),
    collector: { id: accountKey(event.id, user.id), name: user.nickname },
  };
}
export function normalizeRooms<T extends { id: string; name: string; payer_id: string; person_ids: string[] }>(
  source: T[],
  people: Map<string, unknown>,
  payers: Map<string, string>,
  final = false,
) {
  const ids = new Set<string>(),
    names = new Set<string>(),
    assigned = new Set<string>();
  const result = source.map((room) => {
    if (ids.has(room.id)) settlementFail('包間標識重複');
    ids.add(room.id);
    const key = pythonCasefold(room.name);
    if (names.has(key)) settlementFail('同一活動的包間名稱不能重複');
    names.add(key);
    if (!payers.has(room.payer_id)) settlementFail('請選擇本活動的包間付款人');
    for (const id of room.person_ids) {
      if (!people.has(id) || assigned.has(id)) settlementFail('包間人員重複、未列入本版或不屬於本活動');
      assigned.add(id);
    }
    return {
      ...room,
      payer_name: payers.get(room.payer_id)!,
      person_ids: [...people.keys()].filter((id) => room.person_ids.includes(id)),
    };
  });
  if (final && (assigned.size !== people.size || [...people.keys()].some((id) => !assigned.has(id))))
    settlementFail('請為每位結算人員分配實際包間；免 A 者也須保留');
  return result;
}
export function settlementBill(db: DB, id: string, version = settlementVersion(db, id)) {
  const row = db
    .prepare(
      'SELECT version,total_cents,headcount,note,updated_at,actor_id,actor_name,kind,changed_fields FROM settlement_history WHERE event_id=? AND version=?',
    )
    .get(id, version) as
    | {
        version: number;
        total_cents: number;
        headcount: number;
        note: string;
        updated_at: string;
        actor_id: string | null;
        actor_name: string;
        kind: string;
        changed_fields: string;
      }
    | undefined;
  if (!row) return null;
  const detail = settlementDetail(db, id, version),
    per = Math.floor((row.total_cents + Math.floor(row.headcount / 2)) / row.headcount);
  return SettlementBill.parse({
    ...row,
    total_amount: money(row.total_cents),
    headcount: detail ? detail.people.length : row.headcount,
    per_person_amount: detail ? null : money(per),
    rounding_difference_cents: detail ? 0 : per * row.headcount - row.total_cents,
    changed_fields: JSON.parse(row.changed_fields),
    mode: detail ? 'detailed' : 'legacy',
    publisher_key: row.actor_id ? accountKey(id, row.actor_id) : null,
    detail,
  });
}
export const money = (cents: number | bigint) => {
  const n = BigInt(cents),
    sign = n < 0n ? '-' : '',
    v = n < 0n ? -n : n;
  return sign + v / 100n + '.' + String(v % 100n).padStart(2, '0');
};
