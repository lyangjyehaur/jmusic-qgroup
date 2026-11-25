import { cloneElement, useId, type ReactElement } from 'react';
import { Text } from 'yahha-ui';
import { Button } from './kimi-ui';
import type { SettlementPayer, SettlementRosterPerson } from '@qgroup/contracts';
import type { z } from 'zod';
export type Payer = z.infer<typeof SettlementPayer>;
export type RosterPerson = z.infer<typeof SettlementRosterPerson>;
export const newSettlementId = () => crypto.randomUUID().replaceAll('-', '').slice(0, 16);
export const money = (cents: number) => '¥' + (cents / 100).toFixed(2);
export function Field({ label, children }: { label: string; children: ReactElement<{ id?: string }> }) {
  const id = useId();
  return (
    <div className="account-field">
      <label htmlFor={id}>{label}</label>
      {cloneElement(children, { id })}
    </div>
  );
}
export function PayerSelect({
  label,
  value,
  payers,
  change,
}: {
  label: string;
  value: string;
  payers: Payer[];
  change: (id: string) => void;
}) {
  return (
    <Field label={label}>
      <select value={value} onChange={(e) => change(e.target.value)}>
        <option value="">請選擇</option>
        {payers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
        {value && !payers.some((p) => p.id === value) && <option value={value}>原付款人目前不可選，請核對</option>}
      </select>
    </Field>
  );
}
export type Room = {
  id: string;
  name: string;
  payer_id: string;
  person_ids: string[];
  amount?: string;
  merchant_mode?: 'unpaid' | 'paid' | 'recorded';
  paid_amount?: string;
};
export function RoomFields<T extends Room>({
  rooms,
  people,
  payers,
  actual = false,
  arrange = true,
  change,
  create,
}: {
  rooms: T[];
  people: RosterPerson[];
  payers: Payer[];
  actual?: boolean;
  arrange?: boolean;
  change: (rooms: T[]) => void;
  create: () => T;
}) {
  const edit = (id: string, patch: Partial<T>) => change(rooms.map((r) => (r.id === id ? { ...r, ...patch } : r))),
    assigned = new Set(rooms.flatMap((r) => r.person_ids)),
    unassigned = people.filter((p) => !assigned.has(p.id));
  return (
    <>
      {rooms.map((room, index) => (
        <fieldset key={room.id} className="settlement-room">
          <legend>
            包間 {index + 1}
            {room.name ? ' · ' + room.name : ''}
          </legend>
          <fieldset disabled={!arrange}>
            <legend>包間安排</legend>
            <Field label="包間名稱">
              <input value={room.name} onChange={(e) => edit(room.id, { name: e.target.value } as Partial<T>)} />
            </Field>
            <PayerSelect
              label="包間付款人"
              value={room.payer_id}
              payers={payers}
              change={(payer_id) => edit(room.id, { payer_id } as Partial<T>)}
            />
            <details>
              <summary>包間人員 · {room.person_ids.length} 人</summary>
              {people.map((p) => (
                <label key={p.id} className="consent">
                  <input
                    type="checkbox"
                    checked={room.person_ids.includes(p.id)}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      change(
                        rooms.map((r) => ({
                          ...r,
                          person_ids:
                            r.id === room.id
                              ? checked
                                ? [...r.person_ids.filter((id) => id !== p.id), p.id]
                                : r.person_ids.filter((id) => id !== p.id)
                              : checked
                                ? r.person_ids.filter((id) => id !== p.id)
                                : r.person_ids,
                        })),
                      );
                    }}
                  />
                  <span>{p.label}</span>
                </label>
              ))}
              {room.person_ids.filter((id) => !people.some((p) => p.id === id)).length > 0 && (
                <div><Text role="alert">{actual ? '原包間含未列入本版的人員，請移除或重新納入結算。' : '原包間含已不在名冊的人員，請核對後移除。'}</Text>{room.person_ids.filter(id=>!people.some(p=>p.id===id)).map(id=><label key={id} className="consent"><input type="checkbox" checked onChange={()=>edit(room.id,{person_ids:room.person_ids.filter(person=>person!==id)} as Partial<T>)}/><span>原人員 {id}（本版未列入，取消勾選可移除）</span></label>)}</div>
              )}
            </details>
            <Button variant="ghost" onClick={() => change(rooms.filter((r) => r.id !== room.id))}>
              移除包間 {index + 1}
            </Button>
          </fieldset>
          {actual && (
            <>
              <Field label="包間消費金額">
                <input
                  inputMode="decimal"
                  value={room.amount ?? ''}
                  onChange={(e) => edit(room.id, { amount: e.target.value } as Partial<T>)}
                />
              </Field>
              <Field label="店家款項狀態">
                <select
                  value={room.merchant_mode ?? 'unpaid'}
                  onChange={(e) => edit(room.id, { merchant_mode: e.target.value } as Partial<T>)}
                >
                  <option value="unpaid">尚未付款</option>
                  <option value="paid">已付款，這次登記</option>
                  <option value="recorded">已登記到帳本</option>
                </select>
              </Field>
              {room.merchant_mode === 'paid' && (
                <Field label="實際付款金額（留空同消費金額）">
                  <input
                    inputMode="decimal"
                    value={room.paid_amount ?? ''}
                    onChange={(e) => edit(room.id, { paid_amount: e.target.value || undefined } as Partial<T>)}
                  />
                </Field>
              )}
            </>
          )}
        </fieldset>
      ))}
      {arrange && (
        <Button variant="secondary" disabled={rooms.length >= 50} onClick={() => change([...rooms, create()])}>
          新增包間
        </Button>
      )}
      <section aria-label="未分配人員">
        {unassigned.length ? (
          <details open={rooms.length === 0}>
            <summary>未分配 · {unassigned.length} 人</summary>
            <ul>{unassigned.map((p) => <li key={p.id}>{p.label}</li>)}</ul>
          </details>
        ) : <Text>{people.length ? '全部人員已分配。' : '目前名冊沒有可分配人員。'}</Text>}
      </section>
    </>
  );
}
