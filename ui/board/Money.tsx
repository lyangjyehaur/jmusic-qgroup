import React, { useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Heading,
  Image,
  Input,
  Link,
  Select,
  Spinner,
  Surface,
  Text,
} from "yahha-ui";
import {
  centsText,
  prepareCode,
  shortDate,
  wallDate,
  wallToISO,
} from "./domain.ts";
import type { FormController } from "./primitives.tsx";
import {
  Advanced,
  Check,
  clone,
  ErrorMessage,
  Field,
  fieldValues,
  Fold,
  Form,
  optionsFrom,
  uid,
  useBoard,
  useDraft,
  useForm,
  useModal,
} from "./primitives.tsx";
import {
  financeBalanceLabel,
  FinanceText,
  settlementItemsPayload,
} from "./rules.ts";
import type * as D from "./types.ts";
const nameOf = (p?: { label?: string; nickname?: string; name?: string }) =>
  p?.label || p?.nickname || p?.name || "参加者";
const codeKinds: Record<string, string> = {
  wechat: "微信",
  alipay: "支付宝",
  other: "其他",
};
const allocationModes: Record<string, string> = {
  shares: "共同 AA 份数",
  equal: "所选人员均分（含免 A 者）",
  weights: "本项比例",
  fixed: "固定金额",
  duration: "参与分钟",
};
const itemKinds: Record<string, string> = {
  expense: "消费",
  refund: "店家退款",
  discount: "减免",
};
const mappedOptions = (map: Record<string, string>) =>
  Object.entries(map).map(([value, label]) => ({ value, label }));
const newRoom = (rooms: D.Room[], payers: D.Named[]): D.RoomInput => ({
  id: uid(),
  name: "包间 " + (rooms.length + 1),
  payer_id: payers[0]?.id || "",
  person_ids: [],
  amount: "",
  merchant_mode: "unpaid",
});
const newItem = (): D.SettlementItem => ({
  id: uid(),
  name: "活动费用",
  amount: "",
  kind: "expense",
  scope: "common",
  mode: "shares",
  reason: "",
  allocations: [],
  receipt: null,
});
export function Picture({ src, alt }: { src: string; alt: string }) {
  const [retry, setRetry] = useState(0),
    [failed, setFailed] = useState(false);
  const url =
    retry && !src.startsWith("data:")
      ? src + (src.includes("?") ? "&" : "?") + "retry=" + retry
      : src;
  return (
    <div className="board-picture">
      <Link href={src} external>
        <Image
          key={url}
          src={url}
          alt={alt}
          onError={() => setFailed(true)}
          onLoad={() => setFailed(false)}
          fallback="图片加载失败"
        />
      </Link>
      {failed && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setFailed(false);
            setRetry(Date.now());
          }}
        >
          重新加载图片
        </Button>
      )}
      <Link href={src} download>
        保存原图
      </Link>
    </div>
  );
}
export function CodeCards({ codes = [] }: { codes?: D.PaymentCode[] }) {
  return (
    codes.length > 0 && (
      <div className="settlement-codes" data-count={codes.length}>
        {codes.map((code) => (
          <section key={code.kind} className="settlement-code">
            <Heading level={4}>
              {codeKinds[code.kind] || codeKinds.other}
              {code.name ? " · " + code.name : ""}
            </Heading>
            <Picture
              src={code.url}
              alt={(codeKinds[code.kind] || codeKinds.other) + "收款码"}
            />
          </section>
        ))}
      </div>
    )
  );
}
export function RoomPlan({ event: e }: D.EventProps) {
  const app = useBoard(),
    d = e.settlement?.detail,
    actual = d?.rooms,
    rooms = actual || e.room_plan || [],
    people = actual ? d.people || [] : e.participants || [];
  if (!rooms.length && !e.can_manage_rooms) return null;
  const live = e.participants || [],
    self = live.find((p) => p.is_me),
    mine = self && rooms.find((room) => room.person_ids.includes(self.id)),
    assigned = new Set(rooms.flatMap((room) => room.person_ids));
  const member = (id: string) => {
    const person = people.find((p) => p.id === id),
      current = live.find((p) => p.id === id);
    return (
      <li key={id} className="room-person">
        <Text size="sm">{person ? nameOf(person) : "名单已变更"}</Text>
        {!!current?.is_me && <Text size="sm">我</Text>}
        {!!current?.is_guest && !!current.managed_by_me && (
          <Text size="sm">我代报</Text>
        )}
        {!!person?.status && person.status !== "confirmed" && (
          <Text size="sm">
            {
              {
                waiting: "候补",
                tentative: "待确认",
                withdrawn: "已退出",
                invited: "待接受邀请",
              }[person.status]
            }
          </Text>
        )}
      </li>
    );
  };
  return (
    <section
      className="settlement-section room-assignments"
      aria-label="包间安排"
    >
      <div className="settlement-heading">
        <Heading level={3}>{actual ? "实际包间" : "预分包间"}</Heading>
        {!!e.can_manage_rooms && (
          <Button
            variant="ghost"
            data-detail-action="rooms"
            onClick={() => app.open("rooms", { event: e })}
          >
            分配包间
          </Button>
        )}
      </div>
      {self && rooms.length > 0 && (
        <Text>
          我的包间：{mine ? mine.name : "待分配"}
          {mine && self.status === "waiting"
            ? " · 候补预分，不代表正式名额"
            : ""}
        </Text>
      )}
      <div className="room-assignment-grid">
        {rooms.map((room) => (
          <Surface className="room-assignment-card" key={room.id}>
            <Heading level={4}>
              {room.name} · {room.person_ids.length} 人
            </Heading>
            <Text size="sm">
              店家付款／收款人：
              {room.payer_label || room.payer_name || "待指定"}
            </Text>
            <ul className="room-assignment-people">
              {room.person_ids.map(member)}
            </ul>
          </Surface>
        ))}
      </div>
      {people.some((p) => !assigned.has(p.id)) && (
        <Fold title="待分配人员">
          <ul>
            {people.filter((p) => !assigned.has(p.id)).map((p) => member(p.id))}
          </ul>
        </Fold>
      )}
      <Text size="sm" tone="muted">
        {actual
          ? "以上为本版结算确认的实际分配。"
          : "预分安排不代表正式名额或已经付款，最终按核对后的实际包间结算。"}
      </Text>
    </section>
  );
}
export function RoomEditor({
  rooms,
  people,
  payers,
  onChange,
  final = false,
  canArrange = true,
  recordIds = [],
}: {
  rooms: D.RoomInput[];
  people: D.Named[];
  payers: D.Named[];
  onChange: (rooms: D.RoomInput[]) => void;
  final?: boolean;
  canArrange?: boolean;
  recordIds?: string[];
}) {
  const update = <K extends keyof D.RoomInput>(
    id: string,
    name: K,
    value: D.RoomInput[K],
  ) =>
    onChange(
      rooms.map((room) => (room.id === id ? { ...room, [name]: value } : room)),
    );
  const assigned = new Set(rooms.flatMap((room) => room.person_ids));
  return (
    <div className="board-room-editor">
      {rooms.map((room) => {
        const local = {
          values: room,
          busy: false,
          set: <K extends keyof D.RoomInput>(name: K, value: D.RoomInput[K]) =>
            update(room.id, name, value),
        };
        return (
          <Surface variant="note" key={room.id} className="invoice-item">
            <Heading level={4}>{room.name}</Heading>
            <Field
              form={local}
              name="name"
              label="包间名称"
              maxLength={40}
              required
              readOnly={!canArrange}
              data-room={room.id}
              data-room-field="name"
            />
            <Field
              form={local}
              name="payer_id"
              label="店家付款／收款人"
              required
              disabled={!canArrange}
              options={[{ value: "", label: "请选择" }, ...optionsFrom(payers)]}
              data-room={room.id}
              data-room-field="payer_id"
            />
            <Text size="sm">
              {room.person_ids.length} 人；指定付款人不会改变参加者的 AA 责任。
            </Text>
            {final && (
              <>
                <Field
                  form={local}
                  name="amount"
                  label="本包间实际费用（元）"
                  required
                  inputMode="decimal"
                  placeholder="0.00"
                />
                <Field
                  form={local}
                  name="merchant_mode"
                  label="店家实际付款情况"
                  options={[
                    { value: "unpaid", label: "尚未登记付款" },
                    { value: "paid", label: "指定付款人已垫付，随结算登记" },
                    { value: "recorded", label: "已在本包间账本登记" },
                  ]}
                />
                {room.merchant_mode === "paid" && (
                  <Field
                    form={local}
                    name="paid_amount"
                    label="实际已垫付金额（元）"
                    required
                    inputMode="decimal"
                    placeholder="0.00"
                  />
                )}
                {recordIds.includes(room.id) && (
                  <Text size="sm">
                    已有该包间的店家记录，请选已登记；补付、退款或更正请到账本处理。
                  </Text>
                )}
              </>
            )}
            {canArrange && (
              <Button
                variant="ghost"
                destructive
                data-room-remove={room.id}
                onClick={() =>
                  onChange(rooms.filter((item) => item.id !== room.id))
                }
              >
                移除包间
              </Button>
            )}
          </Surface>
        );
      })}
      {canArrange && (
        <Button
          variant="ghost"
          data-room-add
          disabled={rooms.length >= 50}
          onClick={() => onChange([...rooms, newRoom(rooms, payers)])}
        >
          增加包间
        </Button>
      )}
      <Heading level={3}>{final ? "核对实际包间人员" : "分配报名人员"}</Heading>
      <Text size="sm">
        未分配 {people.filter((person) => !assigned.has(person.id)).length} 人
        {final
          ? "；发布前须全部分配，特殊份数在核对人员中调整。"
          : "；可以先保存部分安排。"}
      </Text>
      {people.map((person) => (
        <Select
          key={person.id}
          label={nameOf(person)}
          value={
            rooms.find((room) => room.person_ids.includes(person.id))?.id || ""
          }
          disabled={!canArrange}
          className="board-field"
          data-room-person={person.id}
          options={[
            { value: "", label: "未分配" },
            ...rooms.map((room) => ({ value: room.id, label: room.name })),
          ]}
          onValueChange={(value) =>
            onChange(
              rooms.map((room) => ({
                ...room,
                person_ids: [
                  ...room.person_ids.filter((id) => id !== person.id),
                  ...(room.id === value ? [person.id] : []),
                ],
              })),
            )
          }
        />
      ))}
      {rooms.some((room) =>
        room.person_ids.some(
          (id) => !people.some((person) => person.id === id),
        ),
      ) && (
        <Button
          variant="ghost"
          data-room-prune
          onClick={() =>
            onChange(
              rooms.map((room) => ({
                ...room,
                person_ids: room.person_ids.filter((id) =>
                  people.some((person) => person.id === id),
                ),
              })),
            )
          }
        >
          移除未列入名单的分配
        </Button>
      )}
    </div>
  );
}
export function RoomsForm({ event }: D.EventProps) {
  const app = useBoard(),
    f = useForm({}),
    [data, setData] = useState<{
      event: D.BoardEvent;
      roster: D.SettlementRoster;
    } | null>(null);
  useEffect(() => {
    let live = true;
    f.run(async () => {
      const [latest, roster] = await Promise.all([
        app.api<D.BoardEvent>("/api/events/" + event.id),
        app.api<D.SettlementRoster>(
          `/api/events/${event.id}/settlement/roster`,
        ),
      ]);
      if (!latest.can_manage_rooms)
        throw new Error("当前不能修改预分包间，请重新查看活动");
      if (live) setData({ event: latest, roster });
    });
    return () => {
      live = false;
    };
  }, []);
  return data ? (
    <RoomsEditor {...data} />
  ) : (
    <>
      <ErrorMessage error={f.error} />
      {!!f.busy && <Spinner label="加载包间" />}
    </>
  );
}
function RoomsEditor({
  event: e,
  roster,
}: D.EventProps & { roster: D.SettlementRoster }) {
  const app = useBoard(),
    modal = useModal(),
    f = useForm({
      rooms: clone(e.room_plan || []).map((room): D.RoomInput => ({
        ...room,
        amount: "",
        merchant_mode: "unpaid",
      })),
    }),
    draft = useDraft("rooms:" + e.id, f.values, f.replace, {
      revision: e.revision,
      decode: (data) => ({
        rooms: (data.rooms || []).map((room) => ({
          ...room,
          amount: room.amount || "",
          merchant_mode: room.merchant_mode || "unpaid",
        })),
      }),
    });
  const submit = () =>
    f.run(async () => {
      const updated = await app.api<D.BoardEvent>(
        `/api/events/${e.id}/rooms`,
        "PUT",
        {
          rooms: f.values.rooms,
          base_revision: e.revision,
        },
      );
      await draft.clear();
      modal.close();
      app.apply(updated);
      await app.refresh();
      app.toast("包间安排已保存");
    });
  return (
    <Form
      id="rooms-form"
      form={f}
      draft={draft}
      onSubmit={submit}
      footer={
        <>
          <Button id="rooms-save" type="submit">
            保存包间安排
          </Button>
          {(f.error || draft.warning) && (
            <Button
              id="rooms-reload"
              variant="ghost"
              onClick={() =>
                f.run(async () => {
                  await draft.clear();
                  app.open("rooms", { event: e });
                })
              }
            >
              载入最新版（替换当前输入）
            </Button>
          )}
        </>
      }
    >
      <div id="rooms-editor">
        <RoomEditor
          rooms={f.values.rooms}
          onChange={(rooms) => f.set("rooms", rooms)}
          people={roster.people.filter(
            (person) => person.status !== "withdrawn",
          )}
          payers={roster.payers}
        />
      </div>
    </Form>
  );
}
export function RoomTransfers({ rows = [] }: { rows?: D.RoomBalance[] }) {
  const recipients = new Map<string, { name: string; amount: number }>();
  rows.forEach((room) =>
    room.transfers?.forEach((transfer) => {
      const old = recipients.get(transfer.to_id) || {
        name: transfer.to_name,
        amount: 0,
      };
      old.amount += transfer.amount_cents;
      recipients.set(transfer.to_id, old);
    }),
  );
  return (
    <>
      {recipients.size > 0 && (
        <>
          <Heading level={4}>各收款人待收合计</Heading>
          {[...recipients.values()].map((person, index) => (
            <Text key={index}>
              {person.name} · ¥{centsText(person.amount)}
            </Text>
          ))}
        </>
      )}
      {rows.map((room) => (
        <Surface variant="note" key={room.id}>
          <Heading level={4}>
            {room.name} · ¥{centsText(room.total_cents)}
          </Heading>
          <Text size="sm">
            店家付款／收款人：{room.payer_label || room.payer_name} · 已付店家 ¥
            {centsText(room.cost_cents)}
            {room.held_cents
              ? " · 代收余额 ¥" + centsText(room.held_cents)
              : ""}
          </Text>
          {room.transfers?.map((transfer, index) => (
            <Text key={index}>
              {transfer.from_name} → {transfer.to_name}
              {transfer.kind === "reimbursement" ? "（退还／偿还）" : ""} · ¥
              {centsText(transfer.amount_cents)}
            </Text>
          ))}
          {!room.transfers?.length && (
            <Text size="sm">暂无人与人之间的待转款。</Text>
          )}
          {room.balances?.some(
            (person) =>
              person.id === room.payer_id && (person.balance_cents ?? 0) > 0,
          ) && (
            <Text size="sm">
              付款人自己的份额仍须投入本包间；支付店家或登记实际款项后抵扣。
            </Text>
          )}
        </Surface>
      ))}
    </>
  );
}
export function BillBody({ bill, eventId }: { bill: D.Bill; eventId: string }) {
  if (bill.mode !== "detailed")
    return (
      <>
        <Text>每人应付 ¥{bill.per_person_amount}</Text>
        <Text size="sm">
          总金额 ¥{bill.total_amount} ÷ {bill.headcount} 人
        </Text>
        {bill.rounding_difference_cents !== 0 &&
          bill.rounding_difference_cents != null && (
            <Text size="sm">
              四舍五入到分，尾差 ¥{centsText(bill.rounding_difference_cents)}
              ，由发起人处理。
            </Text>
          )}
        <Text className="board-pre-wrap">{bill.note}</Text>
        <CodeCards codes={bill.payment_codes} />
        {!!bill.has_qr && !bill.payment_codes?.length && (
          <Picture
            src={`/api/events/${eventId}/payment-code?v=${encodeURIComponent(bill.updated_at || "")}`}
            alt="收款码"
          />
        )}
      </>
    );
  const d = bill.detail;
  return (
    <>
      <Text className="settlement-amount">
        总费用 <strong>¥{centsText(d.total_cents)}</strong>
      </Text>
      <Text size="sm">
        {d.people.length} 位结算人员 ·{" "}
        {bill.version ? "第 " + bill.version + " 版" : "待发布"}
      </Text>
      {!!d.collector && (
        <Alert tone="info">本版收款人：{d.collector.name}</Alert>
      )}
      {!!d.room_balances && (
        <Fold title="按包间转款明细" defaultOpen>
          <RoomTransfers rows={d.room_balances} />
          <Text size="sm">
            以上为发布时快照；实际收付后以收付款账本的包间明细为准。
          </Text>
        </Fold>
      )}
      {!!d.balances?.length && !d.rooms && (
        <Fold title="本版发布时待补／应退">
          {d.balances.map((person) => (
            <Text key={person.id}>
              {nameOf(person)} · AA ¥
              {person.due_cents == null
                ? "待核对"
                : centsText(person.due_cents)}{" "}
              · 已投入 ¥{centsText(person.contributed_cents)} ·{" "}
              {financeBalanceLabel(person.balance_cents, centsText)}
            </Text>
          ))}
          <Text size="sm">后续收退款以收付款账本为准。</Text>
        </Fold>
      )}
      <Fold title="付款明细">
        {d.payers.map((person) => (
          <Text key={person.id}>
            {nameOf(person)} · ¥{centsText(person.amount_cents)}
          </Text>
        ))}
        {!d.payers.length && <Text>无需付款</Text>}
      </Fold>
      <Fold title="逐人应付与分摊明细">
        {d.people.map((person) => (
          <Fold
            key={person.id}
            title={`${nameOf(person)} · ¥${person.due_cents == null ? "待核对" : centsText(person.due_cents)}`}
          >
            <Text size="sm">
              共同 AA {person.share} 份
              {person.reason ? " · " + person.reason : ""}
            </Text>
            <Text size="sm">
              已接受约定第 {person.accepted_conditions_version || "—"} 版 ·{" "}
              {person.accepted_arrangement?.fee_policy ||
                "原记录未填写费用规则"}
            </Text>
            {person.allocations?.map((allocation) => (
              <Text key={allocation.item_id}>
                {d.items.find((item) => item.id === allocation.item_id)?.name} ·
                ¥{centsText(allocation.amount_cents ?? 0)}
              </Text>
            ))}
            {person.payments?.map((payment, index) => (
              <Text key={index}>
                {nameOf(payment)} · ¥{centsText(payment.amount_cents ?? 0)}
              </Text>
            ))}
          </Fold>
        ))}
      </Fold>
      <Fold title="费用项目与消费凭证">
        {d.items.map((item) => (
          <Fold
            key={item.id}
            title={`${item.name} · ${itemKinds[item.kind]} · ¥${centsText(item.amount_cents)}`}
          >
            <Text size="sm">
              {allocationModes[item.mode]}
              {item.reason ? " · " + item.reason : ""}
            </Text>
            {item.breakdown?.map((allocation, index) => (
              <Text key={index}>
                {nameOf(
                  d.people.find(
                    (person) => person.id === allocation.person_id,
                  ) || { name: "参加者" },
                )}
                {item.mode === "duration"
                  ? " · " + allocation.minutes + " 分钟"
                  : item.mode === "weights"
                    ? " · " + allocation.weight + " 份"
                    : ""}{" "}
                · ¥{centsText(allocation.amount_cents ?? 0)}
              </Text>
            ))}
            {!!item.has_receipt && !!bill.version && (
              <Picture
                src={`/api/events/${eventId}/settlement/history/${bill.version}/receipts/${item.id}`}
                alt={item.name + "消费凭证"}
              />
            )}
          </Fold>
        ))}
        <Text size="sm">{d.rounding_rule}</Text>
      </Fold>
      {!!d.note && <Text className="board-pre-wrap">{d.note}</Text>}
      {!!d.reason && <Text size="sm">本版原因：{d.reason}</Text>}
      {!!d.changes?.length && (
        <Fold title="本版更改">
          {d.changes.map((change, index) => (
            <Text size="sm" key={index}>
              {change}
            </Text>
          ))}
        </Fold>
      )}
      <CodeCards codes={bill.payment_codes} />
    </>
  );
}
export function SettlementSection({ event: e }: D.EventProps) {
  const app = useBoard();
  return (
    !!e.settlement && (
      <section className="settlement-section" aria-label="活动结算">
        <div className="settlement-heading">
          <Heading level={3}>活动结算</Heading>
          <Button
            variant="ghost"
            data-detail-action="settlement-history"
            onClick={() => app.open("settlementHistory", { event: e })}
          >
            结算记录
          </Button>
        </div>
        {e.settlement.mode === "detailed" && e.my_payable_cents != null && (
          <Text>我的应付合计 ¥{centsText(e.my_payable_cents)}</Text>
        )}
        <BillBody bill={e.settlement} eventId={e.id} />
      </section>
    )
  );
}
export function SettlementHistory({ event: e }: D.EventProps) {
  const app = useBoard(),
    f = useForm({}),
    [versions, setVersions] = useState<D.Bill[]>([]);
  useEffect(() => {
    f.run(async () => {
      const result = await app.api<{ revisions: D.Bill[] }>(
        `/api/events/${e.id}/settlement/history`,
      );
      setVersions(result.revisions || []);
    });
  }, []);
  return (
    <>
      <ErrorMessage error={f.error} />
      {versions.map((bill, index) => (
        <Fold
          key={bill.version || index}
          title={`第 ${bill.version} 版 · ${{ baseline: "原有结算", published: "首次发布", converted: "转为逐人结算", detailed_published: "发布逐人结算", detailed_edited: "修改逐人结算" }[bill.kind || ""] || "结算记录"} · ${shortDate(bill.updated_at || bill.created_at || "")} · ${bill.actor_name || ""}`}
        >
          {bill.kind === "baseline" && (
            <Text size="sm">启用记录前的已有结算，更早的修改未记录。</Text>
          )}
          <BillBody bill={bill} eventId={e.id} />
        </Fold>
      ))}
      {!versions.length && !f.busy && <Text tone="muted">暂无结算记录</Text>}
    </>
  );
}
export function SettlementForm({ event: e }: D.EventProps) {
  const app = useBoard(),
    f = useForm({}),
    [data, setData] = useState<{
      roster: D.SettlementRoster;
      library: D.LibraryCode[];
    } | null>(null);
  useEffect(() => {
    let active = true;
    f.run(async () => {
      const [roster, codes] = await Promise.all([
        app.api<D.SettlementRoster>(`/api/events/${e.id}/settlement/roster`),
        app.api<{ codes: D.LibraryCode[] }>("/api/payment-codes"),
      ]);
      if (active) setData({ roster, library: codes.codes });
    });
    return () => {
      active = false;
    };
  }, []);
  return data ? (
    <SettlementEditor event={e} {...data} />
  ) : (
    <>
      <ErrorMessage error={f.error} />
      {!!f.busy && <Spinner label="加载结算名单" />}
    </>
  );
}
function SettlementEditor({
  event: e,
  roster,
  library: initialLibrary,
}: D.EventProps & { roster: D.SettlementRoster; library: D.LibraryCode[] }) {
  const app = useBoard(),
    modal = useModal(),
    bill = e.settlement,
    detailed = bill?.mode === "detailed",
    input = detailed ? bill.detail.input : null;
  const [library, setLibrary] = useState(initialLibrary),
    [preview, setPreview] = useState<
      | (D.SettlementPreview & {
          data: D.SettlementWrite & { preview_token: string };
        })
      | null
    >(null),
    [customName, setCustomName] = useState("");
  const f = useForm(() => ({
    people: roster.people.map((person): D.PersonInput => {
      const old = input?.people.find((value) => value.id === person.id);
      return old
        ? { ...clone(old), include: true }
        : {
            id: person.id,
            share: "1",
            reason: "",
            include: !detailed && person.status === "confirmed",
            payment_mode: "shares",
            payments: [{ payer_id: person.payer_id, share: "1" }],
          };
    }),
    items: (input
      ? clone(input.items).map((item) => ({
          ...item,
          receipt: item.receipt_digest
            ? { version: bill?.version, item_id: item.id }
            : null,
        }))
      : [newItem()]) as D.SettlementItem[],
    rooms: clone(input?.rooms || roster.rooms || []).map(
      (room): D.RoomInput => ({
        ...room,
        amount: "amount" in room ? String(room.amount) : "",
        merchant_mode: (roster.room_record_ids || []).includes(room.id)
          ? "recorded"
          : "unpaid",
        paid_amount: "",
      }),
    ),
    custom: clone(input?.custom_payers || []),
    room_mode: detailed ? !!bill.detail.rooms?.length : !!roster.rooms?.length,
    note: bill?.note || "",
    reason: "",
    reviewed_roster: false,
    convert_legacy: false,
    merchant_mode: roster.has_merchant_records ? "recorded" : "",
    merchant_payer: roster.collector.id,
    merchant_amount: "",
    merchant_name: e.location,
    merchant_time: wallDate(Date.now(), null),
    merchant_method: "wechat",
    group_notice: !!e.bot_enabled,
    codes: (bill?.publisher_key === roster.collector.id
      ? (bill?.payment_codes || []).map((code) => ({
          kind: code.kind,
          version: bill.version,
        }))
      : []) as D.CodeChoice[],
  }));
  const v = f.values,
    payers = [...roster.payers, ...v.custom],
    included = v.people.filter((person) => person.include);
  const draft = useDraft("invoice:" + e.id, v, f.replace, {
    revision: e.revision,
    decode: (data) => ({
      ...v,
      ...fieldValues(data.fields),
      people: data.people || v.people,
      items: data.items || v.items,
      rooms: (data.rooms || []).map((room) => ({
        ...room,
        amount: room.amount || "",
        merchant_mode: room.merchant_mode || "unpaid",
      })),
      custom: data.custom || [],
      codes: data.paymentCodes || [],
      reviewed_roster: false,
    }),
  });
  const change = <K extends keyof typeof v>(
    name: K,
    value: React.SetStateAction<(typeof v)[K]>,
  ) => {
    setPreview(null);
    f.patch((previous) => ({
      ...previous,
      [name]:
        typeof value === "function"
          ? (value as (previous: (typeof v)[K]) => (typeof v)[K])(
              previous[name],
            )
          : value,
    }));
  };
  const fields = { ...f, set: change };
  const updatePerson = <K extends keyof D.PersonInput>(
    id: string,
    name: K,
    value: D.PersonInput[K],
  ) =>
    change(
      "people",
      v.people.map((person) =>
        person.id === id ? { ...person, [name]: value } : person,
      ),
    );
  const updateItem = <K extends keyof D.SettlementItem>(
    id: string,
    name: K,
    value: D.SettlementItem[K],
  ) =>
    change(
      "items",
      v.items.map((item) =>
        item.id === id ? { ...item, [name]: value } : item,
      ),
    );
  const codeCards = v.codes.flatMap((choice): D.PaymentCode[] => {
    const current = bill?.payment_codes?.find(
      (code) => code.kind === choice.kind,
    );
    if (choice.code_id) {
      const saved = library.find((code) => code.id === choice.code_id);
      return saved ? [saved] : [];
    }
    return [
      {
        kind: choice.kind,
        name: choice.name || current?.name || "",
        url: choice.image
          ? "data:image/png;base64," + choice.image
          : choice.version === bill?.version && current
            ? current.url
            : `/api/events/${e.id}/settlement/history/${choice.version}/payment-codes/${choice.kind}`,
      },
    ];
  });
  const payload = () => {
    const people = included.map(({ include, ...person }) => clone(person)),
      rooms = v.room_mode ? clone(v.rooms) : [];
    if (!!v.room_mode && !rooms.length)
      throw new Error("请至少建立一个实际包间");
    const data: D.SettlementWrite = {
      people,
      items: settlementItemsPayload(v.items, people, e.duration_hours),
      custom_payers: v.custom,
      note: v.note.trim(),
      reason: v.reason.trim(),
      base_revision: e.revision,
      base_version: bill?.version || 0,
      reviewed_roster: v.reviewed_roster,
      convert_legacy: v.convert_legacy,
      rooms,
      payment_codes: rooms.length ? [] : v.codes,
      group_notice:
        !!v.group_notice && !!e.bot_enabled && e.visibility === "public",
    };
    if (rooms.length) {
      if (rooms.some((room) => room.merchant_mode === "paid"))
        data.room_payment_details = {
          occurred_at: new Date(v.merchant_time).toISOString(),
          method: v.merchant_method,
        };
    } else {
      data.merchant_payment = { mode: v.merchant_mode };
      if (v.merchant_mode === "paid")
        Object.assign(data.merchant_payment, {
          payer_id: v.merchant_payer,
          amount: v.merchant_amount.trim(),
          merchant: v.merchant_name.trim(),
          occurred_at: new Date(v.merchant_time).toISOString(),
          method: v.merchant_method,
        });
    }
    return data;
  };
  const showPreview = () =>
    f.run(async () => {
      if (await app.client.hasPending(e.id))
        throw new Error("先在消息的「待确认操作」查询上次结果，再核对最新账本");
      const data = payload(),
        at = f.revision.current,
        result = await app.api<D.SettlementPreview>(
          `/api/events/${e.id}/settlement/preview`,
          "POST",
          data,
        );
      if (at === f.revision.current)
        setPreview({
          ...result,
          data: { ...data, preview_token: result.preview_token },
        });
    });
  const publish = () =>
    f.run(async () => {
      if (!preview) return;
      const updated = await app.api<D.BoardEvent>(
        `/api/events/${e.id}/settlement/detailed`,
        "PUT",
        preview.data,
      );
      await draft.clear();
      modal.close();
      app.apply(updated);
      await app.refresh();
      app.toast("逐人结算已发布");
    });
  const uploadReceipt = (id: string, file?: File) =>
    f.run(async () => {
      if (file)
        updateItem(id, "receipt", (await prepareCode(file)).split(",")[1]);
    });
  const codesProps = {
    event: e,
    library,
    setLibrary,
    choices: v.codes,
    setChoices: (codes: React.SetStateAction<D.CodeChoice[]>) =>
      change("codes", codes),
    form: f,
    cards: codeCards,
  };
  return (
    <Form
      id="invoice-form"
      form={f}
      draft={draft}
      onSubmit={showPreview}
      footer={
        <>
          {(f.error || draft.warning) && (
            <Button
              id="invoice-reload"
              variant="ghost"
              onClick={() =>
                f.run(async () => {
                  await draft.clear();
                  const latest = await app.api<D.BoardEvent>(
                    "/api/events/" + e.id,
                  );
                  app.open("settlement", { event: latest });
                })
              }
            >
              载入最新版（替换当前输入）
            </Button>
          )}
          {!preview ? (
            <Button id="preview-invoice" type="submit">
              预览核对
            </Button>
          ) : (
            <Button id="publish-invoice" onClick={publish}>
              发布结算
            </Button>
          )}
        </>
      }
    >
      {bill && !detailed && (
        <Alert tone="warning">
          原人均结算 ¥{bill.total_amount} ÷ {bill.headcount}{" "}
          人，转换会新增版本，原账单不变。
        </Alert>
      )}
      <Check
        form={fields}
        name="room_mode"
        label="按实际包间结算"
        disabled={!e.is_owner && v.rooms.length > 0}
      />
      {v.room_mode ? (
        <RoomEditor
          rooms={v.rooms}
          onChange={(rooms) => change("rooms", rooms)}
          people={roster.people.filter((person) =>
            included.some((value) => value.id === person.id),
          )}
          payers={payers}
          final
          canArrange={!!e.is_owner}
          recordIds={roster.room_record_ids}
        />
      ) : (
        <div id="invoice-items">
          {v.items.map((item, index) => (
            <Surface variant="note" className="invoice-item" key={item.id}>
              <Heading level={4}>
                {v.items.length > 1 ? "费用 " + (index + 1) : item.name}
              </Heading>
              <Field
                form={{
                  ...f,
                  values: item,
                  set: (name, value) => updateItem(item.id, name, value),
                }}
                name="amount"
                label={v.items.length === 1 ? "总金额（元）" : "金额（元）"}
                inputMode="decimal"
                required
                placeholder="0.00"
                data-item={item.id}
                data-prop="amount"
              />
              <Fold
                title="分摊设置与消费凭证"
                defaultOpen={
                  item.scope !== "common" ||
                  item.mode !== "shares" ||
                  item.kind !== "expense"
                }
              >
                <Field
                  form={{
                    ...f,
                    values: item,
                    set: (name, value) => updateItem(item.id, name, value),
                  }}
                  name="name"
                  label="项目名称"
                  maxLength={80}
                  required
                />
                {(["kind", "scope", "mode"] as const).map((name) => (
                  <Field
                    key={name}
                    form={{
                      ...f,
                      values: item,
                      set: (key, value) => {
                        let items = v.items.map((old) =>
                          old.id === item.id
                            ? {
                                ...old,
                                [key]: value,
                                ...(key === "scope" &&
                                value === "selected" &&
                                !old.allocations.length
                                  ? {
                                      allocations: included.map((person) => ({
                                        person_id: person.id,
                                      })),
                                    }
                                  : {}),
                              }
                            : old,
                        );
                        change("items", items);
                      },
                    }}
                    name={name}
                    label={
                      { kind: "类型", scope: "分摊范围", mode: "方式" }[name]
                    }
                    options={
                      name === "kind"
                        ? mappedOptions(itemKinds)
                        : name === "scope"
                          ? [
                              { value: "common", label: "本版所有结算人员" },
                              { value: "selected", label: "指定人员" },
                            ]
                          : mappedOptions(allocationModes)
                    }
                  />
                ))}
                {(item.scope === "selected" ||
                  ["weights", "fixed", "duration"].includes(item.mode)) &&
                  included.map((person) => {
                    const allocation = item.allocations.find(
                        (value) => value.person_id === person.id,
                      ),
                      info = roster.people.find(
                        (value) => value.id === person.id,
                      ),
                      prop =
                        item.mode === "fixed"
                          ? "amount"
                          : item.mode === "duration"
                            ? "minutes"
                            : "weight";
                    const alter = (
                      key: "selected" | "amount" | "minutes" | "weight",
                      value: string | boolean,
                    ) => {
                      const found = item.allocations.some(
                        (value) => value.person_id === person.id,
                      );
                      updateItem(
                        item.id,
                        "allocations",
                        key === "selected" && !value
                          ? item.allocations.filter(
                              (value) => value.person_id !== person.id,
                            )
                          : found
                            ? item.allocations.map((old) =>
                                old.person_id === person.id
                                  ? {
                                      ...old,
                                      [key]:
                                        key === "minutes"
                                          ? Number(value)
                                          : value,
                                    }
                                  : old,
                              )
                            : [
                                ...item.allocations,
                                {
                                  person_id: person.id,
                                  ...(key === "selected"
                                    ? {}
                                    : { [key]: value }),
                                },
                              ],
                      );
                    };
                    return (
                      <div key={person.id}>
                        <Checkbox
                          label={nameOf(info)}
                          checked={item.scope === "common" || !!allocation}
                          disabled={item.scope === "common"}
                          onChange={(event) =>
                            alter("selected", event.target.checked)
                          }
                        />
                        {["weights", "fixed", "duration"].includes(
                          item.mode,
                        ) && (
                          <Input
                            label={
                              nameOf(info) +
                              (prop === "amount"
                                ? "金额"
                                : prop === "minutes"
                                  ? "分钟"
                                  : "比例")
                            }
                            value={
                              allocation?.[prop] ??
                              (prop === "amount"
                                ? "0.00"
                                : prop === "minutes"
                                  ? (e.duration_hours || 0) * 60
                                  : "1")
                            }
                            disabled={item.scope === "selected" && !allocation}
                            inputMode="decimal"
                            onChange={(event) =>
                              alter(prop, event.target.value)
                            }
                          />
                        )}
                      </div>
                    );
                  })}
                <Field
                  form={{
                    ...f,
                    values: item,
                    set: (name, value) => updateItem(item.id, name, value),
                  }}
                  name="reason"
                  label="分摊依据"
                  multiline
                  rows={2}
                  maxLength={300}
                  required={
                    item.kind !== "expense" ||
                    item.scope === "selected" ||
                    item.mode !== "shares"
                  }
                />
                <Text size="sm">
                  退款／减免填正金额，由系统扣减消费；不代表已实际退款。按时长使用本项分钟数，不从出席状态推算。
                </Text>
                <Input
                  label="消费凭证（选填）"
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  disabled={f.busy}
                  onChange={(event) =>
                    uploadReceipt(item.id, event.target.files?.[0])
                  }
                />
                {!!item.receipt && (
                  <>
                    <Picture
                      src={
                        typeof item.receipt === "string"
                          ? "data:image/png;base64," + item.receipt
                          : `/api/events/${e.id}/settlement/history/${item.receipt.version}/receipts/${item.receipt.item_id}`
                      }
                      alt="消费凭证预览"
                    />
                    <Button
                      variant="ghost"
                      destructive
                      onClick={() => updateItem(item.id, "receipt", null)}
                    >
                      移除凭证
                    </Button>
                  </>
                )}
              </Fold>
              {v.items.length > 1 && (
                <Button
                  variant="ghost"
                  destructive
                  onClick={() =>
                    change(
                      "items",
                      v.items.filter((value) => value.id !== item.id),
                    )
                  }
                >
                  移除费用项目
                </Button>
              )}
            </Surface>
          ))}
        </div>
      )}
      {!v.room_mode && (
        <Button
          variant="ghost"
          disabled={v.items.length >= 50}
          data-invoice="add-item"
          onClick={() => change("items", [...v.items, newItem()])}
        >
          增加费用项目
        </Button>
      )}
      <div id="invoice-roster-summary">
        <Text>{included.length} 人分摊</Text>
        <Text size="sm">
          {included
            .map((person) =>
              nameOf(roster.people.find((value) => value.id === person.id)),
            )
            .join("、") || "暂无结算人员"}
        </Text>
      </div>
      <Advanced>
        <Heading level={3}>核对人员</Heading>
        <div id="invoice-people">
          {v.people.map((person) => {
            const info = roster.people.find((value) => value.id === person.id);
            if (!info) return null;
            return (
              <Fold
                key={person.id}
                title={`${nameOf(info)} · ${person.include ? person.share + " 份" : "不列入"}`}
              >
                <Checkbox
                  label="列入结算名单"
                  checked={person.include}
                  disabled={info.status === "confirmed"}
                  onChange={(event) =>
                    updatePerson(person.id, "include", event.target.checked)
                  }
                />
                <Text size="sm">
                  {info.status} · {info.attendance} · {info.manager_name} 管理
                </Text>
                <Text size="sm">
                  已接受约定第 {info.accepted_conditions_version || "—"} 版：
                  {info.accepted_arrangement?.fee_policy ||
                    "原记录未填写费用规则，请核对原约定。"}
                </Text>
                <Field
                  form={{
                    ...f,
                    values: person,
                    set: (name, value) => updatePerson(person.id, name, value),
                  }}
                  name="share"
                  label="共同 AA 份数"
                  inputMode="decimal"
                  help="1 正常、0.5 半 A、0 免共同费用；指定个人消费可另外计费。"
                />
                <Field
                  form={{
                    ...f,
                    values: person,
                    set: (name, value) => updatePerson(person.id, name, value),
                  }}
                  name="reason"
                  label="核对原因（特殊情况必填）"
                  multiline
                  maxLength={300}
                />
                <Fold title="付款归属与多人合付">
                  <Field
                    form={{
                      ...f,
                      values: person,
                      set: (name, value) =>
                        updatePerson(person.id, name, value),
                    }}
                    name="payment_mode"
                    label="归属方式"
                    options={[
                      { value: "shares", label: "按比例分配应付" },
                      { value: "fixed", label: "指定各付款人金额" },
                    ]}
                  />
                  {person.payments.map((payment, index) => (
                    <div className="board-payment-row" key={index}>
                      <Select
                        label="付款人"
                        value={payment.payer_id}
                        options={optionsFrom(payers)}
                        onValueChange={(value) =>
                          updatePerson(
                            person.id,
                            "payments",
                            person.payments.map((old, at) =>
                              at === index
                                ? { ...old, payer_id: value ?? "" }
                                : old,
                            ),
                          )
                        }
                      />
                      <Input
                        label={
                          person.payment_mode === "fixed"
                            ? "金额（元）"
                            : "比例"
                        }
                        value={
                          (person.payment_mode === "fixed"
                            ? payment.amount
                            : payment.share) ??
                          (person.payment_mode === "fixed" ? "0.00" : "1")
                        }
                        inputMode="decimal"
                        onChange={(event) =>
                          updatePerson(
                            person.id,
                            "payments",
                            person.payments.map((old, at) =>
                              at === index
                                ? {
                                    ...old,
                                    [person.payment_mode === "fixed"
                                      ? "amount"
                                      : "share"]: event.target.value,
                                  }
                                : old,
                            ),
                          )
                        }
                      />
                      <Button
                        variant="ghost"
                        disabled={person.payments.length < 2}
                        onClick={() =>
                          updatePerson(
                            person.id,
                            "payments",
                            person.payments.filter((_, at) => at !== index),
                          )
                        }
                      >
                        移除付款人
                      </Button>
                    </div>
                  ))}
                  <Button
                    variant="ghost"
                    onClick={() =>
                      updatePerson(person.id, "payments", [
                        ...person.payments,
                        {
                          payer_id:
                            payers.find(
                              (value) =>
                                !person.payments.some(
                                  (payment) => payment.payer_id === value.id,
                                ),
                            )?.id || "",
                          share: "1",
                          amount: "0.00",
                        },
                      ])
                    }
                  >
                    增加合付人
                  </Button>
                </Fold>
              </Fold>
            );
          })}
        </div>
        <Fold title="添加其他付款人">
          <Input
            id="invoice-custom-name"
            label="付款人称呼"
            value={customName}
            maxLength={24}
            onChange={(event) => setCustomName(event.target.value)}
          />
          <Button
            variant="ghost"
            onClick={() => {
              if (!customName.trim()) return;
              change("custom", [
                ...v.custom,
                { id: "custom:" + uid(), name: customName.trim() },
              ]);
              setCustomName("");
            }}
          >
            加入付款人选项
          </Button>
        </Fold>
      </Advanced>
      {!v.room_mode && (
        <Field
          form={fields}
          name="merchant_mode"
          label="店家款项：实际付款情况"
          required
          options={[
            { value: "", label: "请选择" },
            { value: "unpaid", label: "尚未支付店家" },
            { value: "paid", label: "一人已垫付，随结算登记" },
            { value: "recorded", label: "已在收付款账本登记" },
          ]}
        />
      )}
      {(v.room_mode
        ? v.rooms.some((room) => room.merchant_mode === "paid")
        : v.merchant_mode === "paid") && (
        <>
          {!v.room_mode && (
            <>
              <Field
                form={fields}
                name="merchant_payer"
                label="实际垫付人"
                options={optionsFrom(payers)}
                required
              />
              <Field
                form={fields}
                name="merchant_amount"
                label="实际已付金额（元）"
                required
                inputMode="decimal"
              />
              <Field
                form={fields}
                name="merchant_name"
                label="店家"
                required
                maxLength={80}
              />
            </>
          )}
          <Field
            form={fields}
            name="merchant_time"
            label="实际付款时间"
            type="datetime-local"
            required
          />
          <Field
            form={fields}
            name="merchant_method"
            label="付款方式"
            options={mappedOptions(FinanceText.methods)}
            required
          />
        </>
      )}
      <Text size="sm">
        垫付人仍承担自己的
        AA，已付店家的款项会抵扣应付；多人垫付或分次付款请到收付款账本登记。
      </Text>
      <Alert tone="info">
        {v.room_mode
          ? "按各包间指定付款人收款；本版不附统一收款码，请核对收款人后通过实际渠道转账。"
          : "本版收款人：" + roster.collector.name + "（当前发布账号）"}
      </Alert>
      <Field
        form={fields}
        name="note"
        label="结算备注（选填）"
        multiline
        rows={2}
        maxLength={1000}
      />
      {!v.room_mode && <CodePicker {...codesProps} />}
      <Check
        form={fields}
        name="group_notice"
        label="向 QQ 群发布本版 AA 明细、待补金额及收款码"
        disabled={!e.bot_enabled || e.visibility !== "public"}
      />
      <Text size="sm">实际发送结果请查看群同步记录。</Text>
      {bill && (
        <Field
          form={fields}
          name="reason"
          label="本次修改／转换原因"
          multiline
          rows={2}
          maxLength={300}
          required
        />
      )}
      {bill && !detailed && (
        <Check
          form={fields}
          name="convert_legacy"
          label="新增逐人结算版本，保留原人均账单"
        />
      )}
      <Check
        form={fields}
        name="reviewed_roster"
        required
        label="已核对结算名单、约定与金额"
      />
      {preview && (
        <Surface id="invoice-preview" variant="note">
          <Heading level={3}>发布预览</Heading>
          <BillBody
            bill={{
              detail: preview.snapshot,
              payment_codes: codeCards,
              mode: "detailed",
            }}
            eventId={e.id}
          />
          {!!preview.snapshot.group_notice && (
            <>
              <Heading level={3}>QQ 群通知预览</Heading>
              <Text className="board-pre-wrap">{preview.group_preview}</Text>
            </>
          )}
          <Text size="sm">
            发布将登记本次明确确认的店家垫付；其他收退款请在收付款账本登记。
          </Text>
        </Surface>
      )}
    </Form>
  );
}
function CodePicker({
  event: e,
  library,
  setLibrary,
  choices,
  setChoices,
  form: f,
  cards,
}: D.EventProps & {
  library: D.LibraryCode[];
  setLibrary: React.Dispatch<React.SetStateAction<D.LibraryCode[]>>;
  choices: D.CodeChoice[];
  setChoices: React.Dispatch<React.SetStateAction<D.CodeChoice[]>>;
  form: Pick<FormController<object>, "run" | "busy">;
  cards: D.PaymentCode[];
}) {
  const app = useBoard(),
    [names, setNames] = useState<Record<string, string>>({}),
    latest = useRef(choices);
  latest.current = choices;
  const saveChoice = (choice: D.CodeChoice) =>
    f.run(async () => {
      if (!latest.current.includes(choice)) return;
      const data = choice.image
        ? { kind: choice.kind, name: choice.name || "", image: choice.image }
        : {
            kind: choice.kind,
            name: cards.find((code) => code.kind === choice.kind)?.name || "",
            source: {
              event_id: e.id,
              version: choice.version,
              kind: choice.kind,
            },
          };
      const code = await app.api<D.LibraryCode>(
        "/api/payment-codes",
        "POST",
        data,
      );
      setLibrary((previous) => [
        code,
        ...previous.filter((item) => item.id !== code.id),
      ]);
      setChoices((previous) => [
        ...previous.filter((item) => item.kind !== choice.kind),
        { kind: choice.kind, code_id: code.id },
      ]);
    });
  return (
    <section className="invoice-codes">
      <Heading level={3}>收款码</Heading>
      <CodeCards codes={cards} />
      {!cards.length && <Text size="sm">未提供收款码</Text>}
      <Fold title="选择／上传收款码">
        {Object.entries(codeKinds).map(([kind, label]) => {
          const choice = choices.find((item) => item.kind === kind),
            current = e.settlement?.payment_codes?.find(
              (item) => item.kind === kind,
            );
          return (
            <section key={kind}>
              <Heading level={4}>{label}</Heading>
              <Select
                label={label + "收款码"}
                value={choice?.code_id || (choice ? "current" : "")}
                options={[
                  { value: "", label: "不提供" },
                  ...(current || (choice && !choice.code_id)
                    ? [
                        {
                          value: "current",
                          label: choice?.image
                            ? "本次上传的收款码"
                            : "保留本版收款码",
                        },
                      ]
                    : []),
                  ...library
                    .filter((code) => code.kind === kind)
                    .map((code, index) => ({
                      value: code.id,
                      label: code.name || "未命名 " + (index + 1),
                    })),
                ]}
                onValueChange={(value) =>
                  setChoices((previous) => [
                    ...previous.filter((item) => item.kind !== kind),
                    ...(value === "current"
                      ? [
                          choice && !choice.code_id
                            ? choice
                            : { kind, version: e.settlement?.version },
                        ]
                      : value
                        ? [{ kind, code_id: value }]
                        : []),
                  ])
                }
              />
              {choice?.code_id ? (
                <Button
                  variant="ghost"
                  destructive
                  onClick={() =>
                    app.confirm(
                      "从我的收款码移除？",
                      "已发布的结算和历史图片会保留。当前未发布的选择将清空。",
                      async () => {
                        await app.api<D.BoardEvent>(
                          "/api/payment-codes/" + choice.code_id,
                          "DELETE",
                          {},
                        );
                        setLibrary((previous) =>
                          previous.filter((code) => code.id !== choice.code_id),
                        );
                        setChoices((previous) =>
                          previous.filter(
                            (item) => item.code_id !== choice.code_id,
                          ),
                        );
                      },
                    )
                  }
                >
                  从我的收款码移除
                </Button>
              ) : (
                choice && (
                  <Button variant="ghost" onClick={() => saveChoice(choice)}>
                    保存到个人资料
                  </Button>
                )
              )}
              <Fold title="上传新码">
                <Input
                  label="名称（选填）"
                  value={names[kind] || ""}
                  maxLength={40}
                  onChange={(event) =>
                    setNames((previous) => ({
                      ...previous,
                      [kind]: event.target.value,
                    }))
                  }
                />
                <Input
                  label={label + "收款码图片"}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  disabled={f.busy}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    f.run(async () => {
                      const image = (await prepareCode(file)).split(",")[1],
                        choice = { kind, name: names[kind] || "", image };
                      setChoices((previous) => [
                        ...previous.filter((item) => item.kind !== kind),
                        choice,
                      ]);
                      app.confirm(
                        "保存到个人资料？",
                        "收款码已加入本次结算。保存后下次可直接选用，也可以仅用于本次结算。",
                        () => saveChoice(choice),
                        { confirm: "保存到资料", cancel: "仅本次使用" },
                      );
                    });
                  }}
                />
              </Fold>
            </section>
          );
        })}
      </Fold>
    </section>
  );
}
export function FinanceSection({ event: e }: D.EventProps) {
  const app = useBoard(),
    f = e.finance;
  if (
    !f ||
    e.lifecycle === "draft" ||
    (!f.can_manage && !f.can_report && !f.has_records && !f.detailed)
  )
    return null;
  return (
    <section className="settlement-section" aria-label="收付款">
      <div className="settlement-heading">
        <Heading level={3}>收付款</Heading>
        <Button
          variant="ghost"
          data-detail-action="finance"
          onClick={() => app.open("finance", { event: e })}
        >
          查看账本
        </Button>
      </div>
      <Text size="sm">
        {FinanceText.states[f.state]}
        {f.pending_count ? " · " + f.pending_count + " 笔申报待核对" : ""}
      </Text>
      {f.my_outstanding_cents != null && (
        <Text>
          我的待补 ¥{centsText(f.my_outstanding_cents)}
          {f.my_refund_due_cents
            ? " · 应退／待偿还 ¥" + centsText(f.my_refund_due_cents)
            : ""}
        </Text>
      )}
      {!!f.can_report && (
        <Button
          variant="ghost"
          onClick={() => app.open("finance", { event: e, report: true })}
        >
          已转账／垫付？申报款项
        </Button>
      )}
    </section>
  );
}
function Transaction({
  transaction: p,
  view,
  event: e,
}: {
  transaction: D.FinanceTransaction;
  view: D.FinanceViewData;
  event: D.BoardEvent;
}) {
  const name = (id?: string) =>
      p.parties?.find((p) => p.id === id)?.label ||
      view?.parties.find((p) => p.id === id)?.label ||
      "款项人员",
    k = p.kind,
    actual = p.actual_party_id || p.payer_id,
    attribution =
      actual !== p.payer_id ? " · 计入 " + name(p.payer_id) + " 的款项" : "";
  let flow;
  if (k === "collection")
    flow =
      name(actual) + " → " + name(p.custodian_id) + "（代收）" + attribution;
  else if (["refund", "reimbursement"].includes(k))
    flow =
      (p.funding === "payer"
        ? name(p.funder_id) + "（个人先垫）"
        : name(p.custodian_id) + "（代收资金）") +
      " → " +
      name(actual) +
      attribution;
  else if (["credit_transfer", "cash_transfer"].includes(k))
    flow =
      name(p.from_id) +
      " → " +
      name(p.to_id) +
      (k === "credit_transfer" ? "（仅更正归属）" : "（代收资金）");
  else if (k === "deposit_apply")
    flow = p.merchant + " · 已付订金转计实际消费／损失";
  else {
    const person =
      p.funding === "payer"
        ? name(p.payer_id)
        : name(p.custodian_id) + "（代收资金）";
    flow = ["merchant_refund", "deposit_return"].includes(k)
      ? p.merchant + " → " + person
      : person + " → " + p.merchant;
  }
  return (
    <>
      {!!p.room_name && <Text>包间：{p.room_name}</Text>}
      <Text>
        {FinanceText.kinds[k]} · ¥{centsText(p.amount_cents)}
      </Text>
      <Text>{flow}</Text>
      <Text size="sm">
        {["credit_transfer", "deposit_apply"].includes(k)
          ? "记账时间"
          : FinanceText.methods[p.method || ""]}{" "}
        · {shortDate(p.occurred_at || "", e.timezone)}
      </Text>
      {!!p.note && <Text className="board-pre-wrap">{p.note}</Text>}
      {!!p.reason && <Text size="sm">依据：{p.reason}</Text>}
      {!!p.reference_id && <Text size="sm">关联记录 {p.reference_id}</Text>}
    </>
  );
}
export function FinanceView({
  event: initial,
  report = false,
}: D.ModalProps["finance"]) {
  const app = useBoard(),
    f = useForm({}),
    [data, setData] = useState<D.FinanceViewData | null>(null),
    [e, setEvent] = useState(initial);
  const load = () =>
    f.run(async () => {
      const [latest, view] = await Promise.all([
        app.api<D.BoardEvent>("/api/events/" + initial.id),
        app.api<D.FinanceViewData>(`/api/events/${initial.id}/finance`),
      ]);
      setEvent(latest);
      app.apply(latest);
      setData(view);
      if (report && view.summary.can_report)
        app.open("financeForm", { event: latest, view, command: "report" });
    });
  useEffect(() => {
    load();
  }, []);
  if (!data)
    return (
      <>
        <ErrorMessage error={f.error} />
        {!!f.busy && <Spinner label="加载账本" />}
      </>
    );
  const v = data,
    s = v.summary,
    edit = (command: string, id?: string) =>
      app.withProfile(() =>
        app.open("financeForm", { event: e, view: v, command, id }),
      );
  return (
    <div className="board-finance">
      <ErrorMessage error={f.error} />
      <Text>{FinanceText.states[s.state]}</Text>
      {s.my_outstanding_cents != null && (
        <Text>
          我的待补 ¥{centsText(s.my_outstanding_cents)}
          {s.my_refund_due_cents
            ? " · 应退／待偿还 ¥" + centsText(s.my_refund_due_cents)
            : ""}
        </Text>
      )}
      <dl className="finance-totals">
        <dt>结算费用</dt>
        <dd>
          {s.total_due_cents == null
            ? "待核对"
            : "¥" + centsText(s.total_due_cents)}
        </dd>
        <dt>已付店家净消费</dt>
        <dd>¥{centsText(s.cost_cents)}</dd>
        <dt>活动代收资金余额</dt>
        <dd>¥{centsText(s.held_cents)}</dd>
        {!!s.deposit_cents && (
          <>
            <dt>待退／待抵订金押金</dt>
            <dd>¥{centsText(s.deposit_cents)}</dd>
          </>
        )}
      </dl>
      <div className="owner-tools">
        {!!s.can_manage && (
          <Button data-finance="record" onClick={() => edit("record")}>
            登记款项
          </Button>
        )}
        {!!s.can_report && (
          <Button
            variant="secondary"
            data-finance="report"
            onClick={() => edit("report")}
          >
            申报我已转账／垫付
          </Button>
        )}
      </div>
      {!!s.room_balances?.length ? (
        <Fold title="各包间当前转款明细" defaultOpen>
          <RoomTransfers rows={s.room_balances} />
          <Text size="sm">各包间分别对账，不跨包间抵销待补与应退。</Text>
        </Fold>
      ) : (
        <Fold
          title={
            "逐付款人对账" +
            (s.outstanding_cents != null
              ? " · 待补 ¥" + centsText(s.outstanding_cents)
              : "")
          }
        >
          {s.balances.map((b) => (
            <Surface variant="note" key={b.id}>
              <Heading level={4}>{b.label}</Heading>
              <Text>{financeBalanceLabel(b.balance_cents, centsText)}</Text>
              <Text size="sm">
                {b.due_cents == null
                  ? "尚未确定应付"
                  : "应付 ¥" + centsText(b.due_cents)}{" "}
                · 已确认净投入 ¥{centsText(b.contributed_cents)}
              </Text>
            </Surface>
          ))}
          <Text size="sm">
            净投入含预收与个人先付店家的款项，扣除已退还及已偿还垫付。改账不会移动原款项。
          </Text>
        </Fold>
      )}
      <Fold title="代收资金与订金">
        {s.custodians.map((p) => (
          <Text key={p.id}>
            {p.label} · 代收余额 ¥{centsText(p.held_cents ?? 0)}
          </Text>
        ))}
        {v.references
          .filter((r) => r.kind === "deposit")
          .map((r) => (
            <Text size="sm" key={r.id}>
              {r.payload.merchant}：订金／押金剩余 ¥
              {centsText(r.remaining_cents)} · {r.id}
            </Text>
          ))}
        <Text size="sm">
          个人垫付和活动代收资金分开记录。已含在最终账单的订金先抵扣，仅登记剩余店家支出；可退押金不计消费。
        </Text>
      </Fold>
      <Heading level={3}>款项申报</Heading>
      {v.reports.map((r) => (
        <Fold
          key={r.id}
          title={`${r.reporter_name} · ${FinanceText.reports[r.status]}${r.entry_reversed ? " · 入账已冲销" : ""} · ¥${centsText(r.payload.amount_cents)}`}
          defaultOpen={r.status === "pending"}
        >
          <Transaction transaction={r.payload} view={v} event={e} />
          {!!r.reason && (
            <Text size="sm">
              {r.decision_by}：{r.reason}
            </Text>
          )}
          {r.status === "pending" && !!s.can_manage && (
            <div className="owner-tools">
              <Button
                data-finance="accept"
                onClick={() => edit("accept", r.id)}
              >
                核对并确认
              </Button>
              <Button variant="ghost" onClick={() => edit("reject", r.id)}>
                暂不确认
              </Button>
            </div>
          )}
          {!!r.can_withdraw && (
            <Button variant="ghost" onClick={() => edit("withdraw", r.id)}>
              撤回申报
            </Button>
          )}
          {!!r.entry_id && <Text size="sm">入账记录 {r.entry_id}</Text>}
        </Fold>
      ))}
      {!v.reports.length && <Text size="sm">暂无可查看的申报。</Text>}
      {!!v.next_report_before && (
        <Button
          variant="ghost"
          disabled={f.busy}
          onClick={() =>
            f.run(async () => {
              const page = await app.api<D.FinanceViewData>(
                `/api/events/${e.id}/finance?before_report=${v.next_report_before}`,
              );
              setData(
                (previous) =>
                  previous && {
                    ...previous,
                    reports: [...previous.reports, ...page.reports],
                    next_report_before: page.next_report_before,
                  },
              );
            })
          }
        >
          更早申报
        </Button>
      )}
      <Heading level={3}>已确认记录</Heading>
      {v.entries.map((entry) => (
        <Fold
          key={entry.id}
          title={`${FinanceText.kinds[entry.kind] || entry.kind}${entry.reversed ? " · 已冲销" : ""}${entry.payload.amount_cents ? " · ¥" + centsText(entry.payload.amount_cents) : ""}`}
        >
          <Text size="sm">
            {shortDate(entry.created_at, e.timezone)} · {entry.actor_name} 确认
            · {entry.id}
          </Text>
          {entry.payload.amount_cents ? (
            <Transaction transaction={entry.payload} view={v} event={e} />
          ) : (
            <Text>
              {FinanceText.kinds[entry.kind]}
              {entry.kind === "close"
                ? " · 结算第 " + entry.payload.bill_version + " 版"
                : ""}{" "}
              {entry.payload.reason}
            </Text>
          )}
          {!!entry.reversal_of && (
            <Text size="sm">原款项 {entry.reversal_of}；原记录仍保留。</Text>
          )}
          {!!entry.source_report_id && (
            <Text size="sm">来自已确认申报；申报不会重复入账。</Text>
          )}
          {!!s.can_manage &&
            !entry.reversed &&
            !!entry.payload.amount_cents && (
              <Button
                variant="ghost"
                destructive
                onClick={() => edit("reverse", entry.id)}
              >
                冲销此笔记录
              </Button>
            )}
        </Fold>
      ))}
      {!v.entries.length && <Text size="sm">暂无已确认款项。</Text>}
      {!!v.next_before && (
        <Button
          variant="ghost"
          disabled={f.busy}
          onClick={() =>
            f.run(async () => {
              const page = await app.api<D.FinanceViewData>(
                `/api/events/${e.id}/finance?before=${v.next_before}`,
              );
              setData(
                (previous) =>
                  previous && {
                    ...previous,
                    entries: [...previous.entries, ...page.entries],
                    next_before: page.next_before,
                  },
              );
            })
          }
        >
          更早记录
        </Button>
      )}
      {!!s.can_manage && (
        <Fold title="账务结清">
          {s.state === "closed" ? (
            <>
              <Text>当前版本已结清，更正款项或结算会重新进入待处理。</Text>
              <Button variant="secondary" onClick={() => edit("reopen")}>
                重新打开核对
              </Button>
            </>
          ) : (
            <>
              {v.close_blockers.map((message, index) => (
                <Text size="sm" key={index}>
                  {message}
                </Text>
              ))}
              <Button
                variant="secondary"
                disabled={!!v.close_blockers.length}
                onClick={() => edit("close")}
              >
                确认账务结清
              </Button>
            </>
          )}
        </Fold>
      )}
      <Button variant="ghost" onClick={load}>
        刷新账本
      </Button>
    </div>
  );
}
export function FinanceForm({
  event: e,
  view: v,
  command,
  id,
}: D.ModalProps["financeForm"]) {
  const app = useBoard(),
    modal = useModal(),
    [preview, setPreview] = useState<
      | (D.FinancePreview & {
          data: D.FinanceCommand & { preview_token: string };
        })
      | null
    >(null),
    [customName, setCustomName] = useState("");
  const recording = ["record", "report"].includes(command),
    reporting = command === "report",
    room = v.summary.room_balances?.find((r) =>
      r.balances.some(
        (b) => (b.balance_cents ?? 0) > 0 && v.reportable_ids.includes(b.id),
      ),
    ),
    roomId = room?.id || v.rooms[0]?.id || "";
  const f = useForm({
    kind: "collection",
    amount: "",
    funding: reporting ? "payer" : v.summary.held_cents > 0 ? "pool" : "payer",
    room_id: roomId,
    payer_id: reporting
      ? v.reportable_ids[0]
      : v.summary.balances.find((p) => (p.balance_cents ?? 0) > 0)?.id ||
        v.default_custodian_id,
    custodian_id:
      v.rooms.find((r) => r.id === roomId)?.payer_id || v.default_custodian_id,
    funder_id: v.parties[0]?.id || "",
    from_id: v.default_custodian_id,
    to_id: v.parties.find((p) => p.id !== v.default_custodian_id)?.id || "",
    merchant: "",
    reference_id: "",
    actual_party_id: "",
    actual_reason: "",
    reason: "",
    method: "wechat",
    occurred_at: wallDate(Date.now(), e.timezone),
    note: "",
    custom: [] as D.Named[],
    recordId: uid(),
  });
  const draft = useDraft(
    `finance:${e.id}:${command}:${id || "new"}`,
    f.values,
    (value) => {
      f.replace(value);
      setPreview(null);
    },
    {
      revision: e.revision,
      decode: (data) => ({
        ...f.values,
        ...fieldValues(data.fields),
        custom: data.edit?.custom || [],
        recordId: data.edit?.recordId || uid(),
      }),
    },
  );
  const titles: Record<string, string> = {
    record: "登记实际款项",
    report: "申报我的款项",
    accept: "确认收到／已垫付",
    reject: "暂不确认申报",
    withdraw: "撤回申报",
    reverse: "冲销款项记录",
    close: "确认账务结清",
    reopen: "重新打开核对",
  };
  useEffect(() => modal.setTitle(titles[command]), []);
  const x = f.values,
    k = x.kind,
    refund = ["refund", "reimbursement"].includes(k),
    funded =
      ["expense", "deposit", "merchant_refund", "deposit_return"].includes(k) ||
      refund,
    transfer = ["cash_transfer", "credit_transfer"].includes(k),
    ref = ["deposit_apply", "deposit_return", "merchant_refund"].includes(k),
    payer = k === "collection" || refund || (funded && x.funding === "payer"),
    custodian = k === "collection" || (funded && x.funding === "pool"),
    reasonRequired = [
      "deposit_apply",
      "cash_transfer",
      "credit_transfer",
    ].includes(k),
    actual = ["collection", "refund", "reimbursement"].includes(k),
    hasMethod = !["credit_transfer", "deposit_apply"].includes(k);
  const references = v.references.filter(
    (r) =>
      (!v.rooms.length || r.payload.room_id === x.room_id) &&
      (k === "merchant_refund"
        ? ["expense", "deposit_apply"].includes(r.kind)
        : r.kind === "deposit"),
  );
  const reference = references.some((r) => r.id === x.reference_id)
    ? x.reference_id
    : references[0]?.id || "";
  const parties = [...v.parties, ...x.custom],
    fields = {
      ...f,
      set: ((name, value) => {
        setPreview(null);
        f.patch({
          [name]: value,
          ...(name === "room_id"
            ? {
                custodian_id:
                  v.rooms.find((r) => r.id === value)?.payer_id ||
                  x.custodian_id,
              }
            : {}),
        });
      }) as typeof f.set,
    };
  const party = (
    name:
      | "payer_id"
      | "custodian_id"
      | "funder_id"
      | "from_id"
      | "to_id"
      | "actual_party_id",
    label: string,
    limited = false,
  ) => (
    <Field
      form={fields}
      name={name}
      label={label}
      required
      options={[
        { value: "", label: "请选择" },
        ...optionsFrom(
          limited
            ? parties.filter((p) => v.reportable_ids.includes(p.id))
            : parties,
        ),
      ]}
    />
  );
  const transaction =
    v.reports.find((r) => r.id === id)?.payload ||
    v.entries.find((r) => r.id === id)?.payload;
  const payload = () => {
    const data: D.FinanceCommand = { command, base_revision: e.revision };
    if (!recording) {
      data.reason = x.reason.trim();
      if (["accept", "reject", "withdraw"].includes(command))
        data.report_id = id;
      if (command === "reverse") data.entry_id = id;
      return data;
    }
    const tx: D.TransactionWrite = {
      kind: k,
      amount: x.amount,
      occurred_at: wallToISO(x.occurred_at, e.timezone),
      note: x.note.trim(),
      reason: (reasonRequired ? x.reason : x.actual_reason).trim(),
    };
    if (v.rooms.length) tx.room_id = x.room_id;
    if (funded) tx.funding = reporting ? "payer" : x.funding;
    if (payer) tx.payer_id = x.payer_id;
    if (custodian) tx.custodian_id = x.custodian_id;
    if (refund && x.funding === "payer") tx.funder_id = x.funder_id;
    if (transfer) {
      tx.from_id = x.from_id;
      tx.to_id = x.to_id;
    }
    if (["expense", "deposit"].includes(k)) tx.merchant = x.merchant;
    if (ref) tx.reference_id = reference;
    if (actual) tx.actual_party_id = x.actual_party_id;
    if (hasMethod) tx.method = x.method;
    tx.custom_parties = x.custom.filter((p) =>
      (
        [
          "payer_id",
          "custodian_id",
          "from_id",
          "to_id",
          "actual_party_id",
          "funder_id",
        ] as const
      ).some((key) => tx[key] === p.id),
    );
    data.id = x.recordId;
    data.transaction = tx;
    return data;
  };
  const submit = () =>
    f.run(async () => {
      if (await app.client.hasPending(e.id))
        throw new Error("先在消息的「待确认操作」查询上次结果，再核对最新账本");
      const data = payload(),
        at = f.revision.current,
        result = await app.api<D.FinancePreview>(
          `/api/events/${e.id}/finance/preview`,
          "POST",
          data,
        );
      if (at === f.revision.current)
        setPreview({
          ...result,
          data: { ...data, preview_token: result.preview_token },
        });
    });
  return (
    <Form
      form={f}
      id="finance-form"
      draft={draft}
      onSubmit={submit}
      footer={
        <>
          {(f.error || draft.warning) && (
            <Button
              variant="ghost"
              onClick={() =>
                f.run(async () => {
                  await draft.clear();
                  const [latest, view] = await Promise.all([
                    app.api<D.BoardEvent>("/api/events/" + e.id),
                    app.api<D.FinanceViewData>(`/api/events/${e.id}/finance`),
                  ]);
                  app.open("financeForm", { event: latest, view, command, id });
                })
              }
            >
              载入最新版（替换当前输入）
            </Button>
          )}
          {preview ? (
            <Button
              id="finance-confirm"
              onClick={() =>
                f.run(async () => {
                  const updated = await app.api<D.BoardEvent>(
                    `/api/events/${e.id}/finance`,
                    "POST",
                    preview.data,
                  );
                  await draft.clear();
                  modal.close();
                  app.apply(updated);
                  await app.refresh();
                  app.open("finance", { event: updated });
                  app.toast("款项记录已保存");
                })
              }
            >
              {reporting ? "确认提交申报" : "确认登记"}
            </Button>
          ) : (
            <Button id="finance-preview-button" type="submit">
              预览核对
            </Button>
          )}
        </>
      }
    >
      {recording ? (
        <>
          {v.rooms.length > 0 && (
            <Field
              form={fields}
              name="room_id"
              label="款项所属包间"
              options={optionsFrom(v.rooms)}
              required
            />
          )}
          <Field
            form={fields}
            name="kind"
            label="款项类型"
            options={mappedOptions(FinanceText.kinds).filter((option) =>
              reporting
                ? ["collection", "expense", "deposit"].includes(option.value)
                : !["reversal", "close", "reopen"].includes(option.value),
            )}
          />
          <Text size="sm">
            {k === "credit_transfer"
              ? "只更正已有净投入归属，不代表实际转账；原记录保留。"
              : k === "deposit_apply"
                ? "不产生新转账。请核对结算费用，已经包含的订金不要再记一次店家支出。"
                : refund
                  ? "只登记实际已退还／已偿还的款项，不会发起真实转账。"
                  : "只登记实际款项；申报须发起者核对后才计入已收。"}
          </Text>
          <Field
            form={fields}
            name="amount"
            label="金额（元）"
            required
            inputMode="decimal"
            placeholder="0.00"
          />
          {funded && !reporting && (
            <Field
              form={fields}
              name="funding"
              label="资金来源／去向"
              options={[
                { value: "payer", label: "个人垫付／个人收回" },
                { value: "pool", label: "活动代收资金" },
              ]}
            />
          )}
          {payer && party("payer_id", "付款归属人员", reporting)}
          {custodian && party("custodian_id", "代收资金持有人")}
          {refund &&
            x.funding === "payer" &&
            party("funder_id", "个人垫退／偿还的出资人")}
          {transfer && (
            <>
              {party("from_id", "转出人员")}
              {party("to_id", "转入人员")}
            </>
          )}
          {["expense", "deposit"].includes(k) && (
            <Field
              form={fields}
              name="merchant"
              label="店家／项目"
              required
              maxLength={80}
            />
          )}
          {ref && (
            <Field
              form={{ ...fields, values: { ...x, reference_id: reference } }}
              name="reference_id"
              label="关联原记录"
              required
              options={references.map((r) => ({
                value: r.id,
                label: `${r.payload.merchant} · 剩 ¥${centsText(r.remaining_cents)} · ${r.id}`,
              }))}
            />
          )}
          {reasonRequired && (
            <Field
              form={fields}
              name="reason"
              label="依据／更正原因"
              multiline
              required
              maxLength={300}
            />
          )}
          {actual && (
            <Fold title="代付／代收说明">
              <Field
                form={fields}
                name="actual_party_id"
                label="实际转款／收款人"
                options={[
                  { value: "", label: "与款项归属人员相同" },
                  ...optionsFrom(parties),
                ]}
              />
              <Field
                form={fields}
                name="actual_reason"
                label="代付依据"
                multiline
                maxLength={300}
              />
            </Fold>
          )}
          <Fold title="付款方式、时间与备注">
            {hasMethod && (
              <Field
                form={fields}
                name="method"
                label="付款方式"
                options={mappedOptions(FinanceText.methods)}
              />
            )}
            <Field
              form={fields}
              name="occurred_at"
              label="实际款项时间（活动时区）"
              type="datetime-local"
              required
            />
            <Field
              form={fields}
              name="note"
              label="备注（选填）"
              multiline
              maxLength={1000}
            />
          </Fold>
          {!reporting && (
            <Fold title="添加未报名的款项人员">
              <Input
                label="称呼"
                value={customName}
                maxLength={24}
                onChange={(event) => setCustomName(event.target.value)}
              />
              <Button
                variant="ghost"
                disabled={x.custom.length >= 2}
                onClick={() => {
                  if (!customName.trim()) return;
                  fields.set("custom", [
                    ...x.custom,
                    {
                      id: "custom:" + uid(),
                      name: customName.trim(),
                      label: customName.trim() + "（本次新增）",
                    },
                  ]);
                  setCustomName("");
                }}
              >
                加入人员选项
              </Button>
            </Fold>
          )}
        </>
      ) : (
        <>
          {!!transaction?.amount_cents && (
            <Transaction transaction={transaction} view={v} event={e} />
          )}
          <Text>
            {command === "close"
              ? "所有应付、已确认款项、店家净消费、代收资金和订金均已对平，确认将保存结清记录。"
              : command === "reverse"
                ? "仅冲销账务记录，不会实际退钱；关联后续款项须先处理，原记录保留。"
                : command === "accept"
                  ? "请核对实际到账／店家支付情况及金额。内容不符时先选择暂不确认，再重新申报或登记。"
                  : ""}
          </Text>
          <Field
            form={fields}
            name="reason"
            label={
              ["reject", "reverse", "reopen"].includes(command)
                ? "处理原因"
                : "备注（选填）"
            }
            multiline
            required={["reject", "reverse", "reopen"].includes(command)}
            maxLength={300}
          />
        </>
      )}
      {preview && (
        <Surface variant="note" id="finance-preview">
          <Heading level={3}>核对预览</Heading>
          {preview.command.transaction ? (
            <Transaction
              transaction={preview.command.transaction}
              view={v}
              event={e}
            />
          ) : (
            <Text>
              {titles[command]} · {preview.command.reason}
            </Text>
          )}
          <Text size="sm">
            {reporting
              ? "提交后等待发起者核对，暂不计入已收款或店家支出。"
              : `登记后：店家净消费 ¥${centsText(preview.projection.cost_cents)} · 代收余额 ¥${centsText(preview.projection.held_cents)} · 订金押金 ¥${centsText(preview.projection.deposit_cents)}`}
          </Text>
        </Surface>
      )}
    </Form>
  );
}
