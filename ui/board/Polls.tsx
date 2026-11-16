import { useEffect, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Heading,
  Input,
  Link,
  SegmentedControl,
  Surface,
  Text,
} from "yahha-ui";
import { errorMessage } from "../errors.ts";
import {
  deviceZone,
  shortDate,
  timeRange,
  wallDate,
  wallToISO,
} from "./domain.ts";
import { Delivery } from "./Management.tsx";
import {
  pollAddDays,
  pollDeadlineBounds,
  pollDeadlineValue,
  pollMonthDays,
  pollShiftMonth,
  pollToggleCalendarDate,
} from "./poll-rules.ts";
import {
  Check,
  Field,
  fieldValues,
  Fold,
  Form,
  uid,
  useBoard,
  useDraft,
  useForm,
  useModal,
} from "./primitives.tsx";
import type * as D from "./types.ts";
const labels: Record<string, string> = {
    open: "时间投票中",
    closed: "投票截止 · 待定案",
    finalized: "已确定时间",
    cancelled: "投票已取消",
  },
  choices: Record<string, string> = {
    yes: "可以",
    maybe: "勉强可以",
    no: "不行",
  };
const mapped = (map: Record<string, string>) =>
  Object.entries(map).map(([value, label]) => ({ value, label }));
const newSlot = () => ({ key: uid(), date: "", time: "18:00" });
const optionFuture = (p: D.Poll, o: D.PollOption, now = Date.now()) =>
  !o.expired &&
  (p.time_mode === "date"
    ? o.date >= wallDate(now, p.timezone).slice(0, 10)
    : Date.parse(o.starts_at || "") > now);
function dayLabel(day: string, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(new Date(day + "T12:00:00Z"));
}
export function PollCard({ poll: p }: { poll: D.Poll }) {
  const app = useBoard();
  return (
    <Link
      className="event-card poll-card"
      href={"/?poll=" + p.id}
      data-time-poll={p.id}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
          return;
        event.preventDefault();
        app.openPoll(p.id);
      }}
    >
      <Surface className="board-event-paper">
        <div className="card-heading">
          <Heading level={3}>{p.title}</Heading>
          <Badge tone="accent">{labels[p.status]}</Badge>
        </div>
        <div className="card-facts">
          <Text size="sm">
            {p.options.length} 个候选时段 · {p.respondent_count} 人已投票
          </Text>
          <Text size="sm">{shortDate(p.deadline, p.timezone)} 截止投票</Text>
          <Text size="sm">{p.location}</Text>
        </div>
        <div className="card-bottom">
          <Text size="sm">
            {p.has_voted ? "已投票" : p.is_owner ? "我发起的" : "一起选时间"}
          </Text>
          <span aria-hidden="true">›</span>
        </div>
      </Surface>
    </Link>
  );
}
export function PollForm() {
  const app = useBoard(),
    modal = useModal(),
    f = useForm(() => ({
      title: "",
      category: "约K",
      location: "",
      description: "",
      timezone: deviceZone(),
      bot_enabled: true,
      duration_hours: "3",
      capacity: "0",
      minimum_participants: "0",
      deadline_date: pollAddDays(
        wallDate(Date.now(), deviceZone()).slice(0, 10),
        1,
      ),
      deadline_time: "23:59",
      exact_time: false,
      slots: [newSlot(), newSlot()],
      client_intent: uid(),
      deadlineTouched: false,
    }));
  const v = f.values,
    [month, setMonth] = useState(
      pollAddDays(wallDate(Date.now(), v.timezone).slice(0, 10), 1).slice(0, 7),
    ),
    [calendarMessage, setCalendarMessage] = useState("");
  const draft = useDraft(
    "time-poll:new",
    v,
    (value) => {
      f.replace(value);
      const first = value.slots.find((slot) => slot.date);
      if (first) setMonth(first.date.slice(0, 7));
    },
    {
      decode: (data) => {
        const old = fieldValues(data.fields);
        return {
          ...v,
          ...old,
          exact_time: !!old.exact_time,
          slots:
            data.slots?.map((slot) => ({ ...slot, key: uid() })) ||
            Array.from(
              { length: Math.max(2, Number(old.option_count) || 3) },
              (_, i) => ({
                key: uid(),
                date: String(old["slot_" + i] || "").slice(0, 10),
                time: String(old["slot_" + i] || "").slice(11, 16) || "18:00",
              }),
            ),
          deadline_date:
            String(old.deadline_date || "") ||
            String(old.deadline || "").slice(0, 10),
          deadline_time:
            String(old.deadline_time || "") ||
            String(old.deadline || "").slice(11, 16) ||
            "23:59",
          client_intent: data.intent || uid(),
          deadlineTouched: true,
        };
      },
    },
  );
  let bounds = null,
    hint = "请选择候选日期";
  try {
    bounds = pollDeadlineBounds(
      v.slots,
      v.exact_time,
      v.timezone,
      wallDate,
      wallToISO,
    );
    if (bounds)
      hint =
        (v.exact_time
          ? "最晚可选 " + bounds.latest.replace("T", " ")
          : "截止日当天 23:59 结束，最晚可选 " + bounds.latest.slice(0, 10)) +
        "（" +
        v.timezone +
        "）";
  } catch (error) {
    hint = errorMessage(error);
  }
  const suggestion = bounds?.suggested;
  useEffect(() => {
    if (!v.deadlineTouched && suggestion)
      f.patch({
        deadline_date: suggestion.slice(0, 10),
        deadline_time: suggestion.slice(11, 16),
      });
  }, [suggestion, v.deadlineTouched]);
  const fields = {
    ...f,
    set: ((name, value) =>
      f.patch({
        [name]: value,
        ...(["deadline_date", "deadline_time"].includes(name)
          ? { deadlineTouched: true }
          : {}),
      })) as typeof f.set,
  };
  const today = wallDate(Date.now(), v.timezone).slice(0, 10),
    { offset, days } = pollMonthDays(month),
    selected = new Set(v.slots.map((slot) => slot.date).filter(Boolean));
  const updateSlot = (key: string, name: "date" | "time", value: string) =>
    f.set(
      "slots",
      v.slots.map((slot) =>
        slot.key === key ? { ...slot, [name]: value } : slot,
      ),
    );
  return (
    <Form
      id="time-poll-form"
      form={f}
      draft={draft}
      onSubmit={() =>
        f.run(async () => {
          const deadline = pollDeadlineValue(
              v.deadline_date,
              v.deadline_time,
              v.exact_time,
              v.timezone,
              bounds,
              wallToISO,
            ),
            data = {
              title: v.title.trim(),
              category: v.category,
              location: v.location.trim(),
              description: v.description.trim(),
              timezone: v.timezone,
              bot_enabled: v.bot_enabled,
              duration_hours: Number(v.duration_hours),
              capacity: Number(v.capacity),
              minimum_participants: Number(v.minimum_participants),
              deadline,
              time_mode: v.exact_time ? "exact" : "date",
              options: v.slots.map((slot) =>
                v.exact_time
                  ? {
                      starts_at: wallToISO(
                        slot.date + "T" + slot.time,
                        v.timezone,
                      ),
                    }
                  : { date: slot.date },
              ),
              client_intent: v.client_intent,
            };
          const poll = await app.api<D.Poll>("/api/time-polls", "POST", data);
          await draft.clear();
          modal.close();
          await app.refresh();
          await app.openPoll(poll.id);
          app.toast("时间投票已发起，可复制链接发给群友");
        })
      }
      footer={<Button type="submit">发起时间投票</Button>}
    >
      <Field form={f} name="title" label="活动名称" required maxLength={60} />
      <Field
        form={f}
        name="category"
        label="活动类型"
        options={["约K", "聚餐", "运动", "出游", "游戏", "其他"].map(
          (value) => ({ value, label: app.i18n.category(value) }),
        )}
      />
      <Field form={f} name="location" label="地点" required maxLength={100} />
      <Field
        form={f}
        name="description"
        label="说明（选填）"
        multiline
        maxLength={2000}
      />
      <Field
        form={f}
        name="timezone"
        label="时区"
        options={[
          ...new Set([
            deviceZone(),
            "Asia/Shanghai",
            "Asia/Taipei",
            "Asia/Tokyo",
            "Europe/London",
            "America/New_York",
            v.timezone,
          ]),
        ].map((value) => ({ value, label: value }))}
      />
      <Check
        form={fields}
        name="exact_time"
        label="逐项指定准确开始时间"
        switchControl
      />
      <Text size="sm">
        {v.exact_time
          ? "发布前核对开始与结束；凌晨按实际日期选择。"
          : "先投日期，开始时间与持续时长在定案时补充。定案后需要正式报名。"}
      </Text>
      {!!v.exact_time && (
        <Field
          form={fields}
          name="duration_hours"
          label="持续小时"
          type="number"
          min="1"
          max="24"
          required
        />
      )}
      <section className="poll-calendar" aria-label="选择候选日期">
        <div className="poll-calendar-toolbar">
          <Button
            variant="ghost"
            aria-label="上个月"
            disabled={month <= today.slice(0, 7)}
            onClick={() => setMonth(pollShiftMonth(month, -1))}
          >
            ‹
          </Button>
          <Heading level={3} id="poll-calendar-month">
            {new Intl.DateTimeFormat(app.i18n.locale, {
              timeZone: "UTC",
              year: "numeric",
              month: "long",
            }).format(new Date(month + "-01T12:00:00Z"))}
          </Heading>
          <Button
            variant="ghost"
            aria-label="下个月"
            onClick={() => setMonth(pollShiftMonth(month, 1))}
          >
            ›
          </Button>
          <Button variant="ghost" onClick={() => setMonth(today.slice(0, 7))}>
            本月
          </Button>
        </div>
        <div className="poll-calendar-weekdays">
          {Array.from({ length: 7 }, (_, i) => (
            <Text size="sm" key={i}>
              {new Intl.DateTimeFormat(app.i18n.locale, {
                timeZone: "UTC",
                weekday: "short",
              }).format(new Date("2024-01-0" + (i + 1) + "T12:00:00Z"))}
            </Text>
          ))}
        </div>
        <div id="poll-calendar-days" className="poll-calendar-days">
          {Array.from({ length: offset }, (_, i) => (
            <span key={"space" + i} />
          ))}
          {days.map((day) => (
            <Button
              key={day}
              variant={selected.has(day) ? "primary" : "ghost"}
              className="poll-calendar-day"
              aria-label={dayLabel(day, app.i18n.locale)}
              aria-pressed={selected.has(day)}
              aria-current={day === today ? "date" : undefined}
              disabled={!selected.has(day) && day < today}
              data-day={day}
              onClick={() => {
                f.set("slots", pollToggleCalendarDate(v.slots, day, newSlot));
                setCalendarMessage(
                  selected.has(day)
                    ? "已取消该日期，其他日期保留。"
                    : "已加入候选，可继续点选。",
                );
              }}
            >
              {Number(day.slice(-2))}
            </Button>
          ))}
        </div>
        <Text size="sm" id="poll-calendar-selection">
          已选 {selected.size} 个日期，可跨月选择。
        </Text>
        <Text size="sm" role="status">
          {calendarMessage}
        </Text>
      </section>
      <div id="poll-slots">
        {v.slots.map((slot, index) => {
          let preview = "请选择候选日期";
          try {
            if (slot.date)
              preview = v.exact_time
                ? timeRange({
                    starts_at: wallToISO(
                      slot.date + "T" + slot.time,
                      v.timezone,
                    ),
                    ends_at: new Date(
                      Date.parse(
                        wallToISO(slot.date + "T" + slot.time, v.timezone),
                      ) +
                        Number(v.duration_hours) * 3600000,
                    ).toISOString(),
                    timezone: v.timezone,
                  })
                : dayLabel(slot.date, app.i18n.locale) + " · 具体时间待定";
          } catch {}
          return (
            <Surface className="poll-slot" variant="note" key={slot.key}>
              <div className="poll-slot-heading">
                <Heading level={4}>选项 {index + 1}</Heading>
                <Button
                  variant="ghost"
                  destructive
                  disabled={v.slots.length <= 2}
                  onClick={() =>
                    f.set(
                      "slots",
                      v.slots.filter((s) => s.key !== slot.key),
                    )
                  }
                >
                  移除
                </Button>
              </div>
              <Input
                label={"候选日期 " + (index + 1)}
                name={"poll_day_" + slot.key}
                type="date"
                min={today}
                value={slot.date}
                required
                onChange={(event) =>
                  updateSlot(slot.key, "date", event.target.value)
                }
              />
              {!!v.exact_time && (
                <Input
                  label={"开始时间 " + (index + 1)}
                  type="time"
                  value={slot.time}
                  required
                  onChange={(event) =>
                    updateSlot(slot.key, "time", event.target.value)
                  }
                />
              )}
              <Text size="sm" className="poll-slot-preview">
                {preview}
              </Text>
            </Surface>
          );
        })}
      </div>
      <Button
        variant="ghost"
        onClick={() => f.set("slots", [...v.slots, newSlot()])}
      >
        增加选项
      </Button>
      <Text size="sm">
        {v.slots.length} 个选项，至少保留 2 项。
        {v.slots.length > 14 ? "选项较多，建议聚焦最可能的日期。" : ""}
      </Text>
      <Field
        form={fields}
        name="deadline_date"
        label="投票截止日期"
        type="date"
        required
        min={today}
        max={bounds?.latest.slice(0, 10)}
      />
      {!!v.exact_time && (
        <Field
          form={fields}
          name="deadline_time"
          label="投票截止时间"
          type="time"
          required
        />
      )}
      <Text size="sm" id="poll-deadline-hint">
        {hint}
      </Text>
      <Field
        form={f}
        name="capacity"
        label="正式活动人数上限（0 不限）"
        type="number"
        min="0"
        max="999"
      />
      <Field
        form={f}
        name="minimum_participants"
        label="最低成团人数（0 不设）"
        type="number"
        min="0"
        max="999"
      />
      <Check form={f} name="bot_enabled" label="开启 QQ 群主动通知" />
    </Form>
  );
}
export function PollDetail({ pollId }: D.ModalProps["poll"]) {
  const app = useBoard(),
    modal = useModal(),
    p = app.polls.find((p) => p.id === pollId),
    f = useForm(() => ({ ...p?.my_choices })),
    [now, setNow] = useState(Date.now());
  const update = async (updated: D.Poll) => {
    app.setPolls((previous) =>
      previous.map((p) => (p.id === updated.id ? updated : p)),
    );
    await app.refresh();
  };
  const reload = () =>
    f.run(async () => {
      const updated = await app.api<D.Poll>("/api/time-polls/" + pollId);
      await update(updated);
      f.replace({ ...updated.my_choices });
    });
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10000);
    return () => clearInterval(timer);
  }, []);
  if (!p) return null;
  const active = p.options.filter((o) => optionFuture(p, o, now)),
    canVote =
      !!p.can_vote &&
      p.status === "open" &&
      Date.parse(p.deadline) > now &&
      active.length > 0;
  const patch = (action: string, extra: object = {}) =>
    f.run(async () =>
      update(
        await app.api<D.Poll>("/api/time-polls/" + p.id, "PATCH", {
          action,
          base_revision: p.revision,
          ...extra,
        }),
      ),
    );
  return (
    <div className="board-poll">
      <Text id="time-poll-live-status">
        {p.status === "open" && !canVote && app.me.authenticated
          ? labels.closed
          : labels[p.status]}{" "}
        · {p.respondent_count} 人已投票
      </Text>
      <Text size="sm">
        {shortDate(p.deadline, p.timezone)} 截止 · {p.owner_name} 发起 ·{" "}
        {p.timezone}
      </Text>
      <Text>地点：{p.location}</Text>
      {!!p.description && (
        <Text className="board-pre-wrap">{p.description}</Text>
      )}
      {!!p.fee_policy && <Text>费用约定：{p.fee_policy}</Text>}
      <Text size="sm">
        {p.capacity ? "正式活动上限 " + p.capacity + " 人" : "正式活动人数不限"}
        {p.minimum_participants
          ? " · 最低成团 " + p.minimum_participants + " 人"
          : ""}
        。投票不占名额；定案后请重新报名。
      </Text>
      {!!p.reason && <Alert>发起者说明：{p.reason}</Alert>}
      <Form
        form={f}
        id="time-poll-vote-form"
        onSubmit={() =>
          f.run(async () => {
            if (!canVote) throw new Error("投票已截止，请刷新安排");
            if (active.some((o) => !f.values[o.id]))
              throw new Error("请为每个未过期候选选择意愿");
            const updated = await app.api<D.Poll>(
              `/api/time-polls/${p.id}/votes`,
              "PUT",
              {
                base_revision: p.revision,
                choices: active.map((o) => ({
                  option_id: o.id,
                  choice: f.values[o.id],
                })),
              },
            );
            await update(updated);
            app.toast("选择已保存；投票不占正式报名名额");
          })
        }
        footer={
          canVote ? (
            <Button type="submit">
              {p.has_voted ? "保存修改" : "保存我的选择"}
            </Button>
          ) : (
            !app.me.authenticated &&
            p.status === "open" && (
              <Button onClick={() => app.open("account")}>登录后投票</Button>
            )
          )
        }
      >
        {canVote && (
          <div className="poll-vote-toolbar">
            <Text id="poll-vote-progress" role="status">
              已选 {active.filter((o) => f.values[o.id]).length} /{" "}
              {active.length} 个未过期候选
            </Text>
            <Text size="sm">
              点选每个候选的意愿，最后统一保存。批次填写只补未选项。
            </Text>
            <div className="owner-tools">
              {(Object.entries(choices) as [D.Vote, string][]).map(
                ([choice, label]) => (
                  <Button
                    key={choice}
                    variant="ghost"
                    onClick={() =>
                      f.patch(
                        Object.fromEntries(
                          active
                            .filter((o) => !f.values[o.id])
                            .map((o) => [o.id, choice]),
                        ),
                      )
                    }
                  >
                    未选填「{label}」
                  </Button>
                ),
              )}
            </div>
          </div>
        )}
        {p.options.map((option, index) => (
          <Surface
            variant="note"
            className="poll-option"
            key={option.id}
            data-poll-option={option.id}
          >
            <div className="poll-option-heading">
              <Heading level={3}>
                {p.time_mode === "date"
                  ? dayLabel(option.date, app.i18n.locale)
                  : "时段 " + (index + 1)}
              </Heading>
              {p.selected_option_id === option.id ? (
                <Badge>已选定</Badge>
              ) : (
                p.leading_option_ids.includes(option.id) &&
                optionFuture(p, option, now) && <Badge>最多人可以</Badge>
              )}
              {!optionFuture(p, option, now) && (
                <Badge>已过期 · 停止收票</Badge>
              )}
            </div>
            {p.time_mode !== "date" && (
              <Text>
                {timeRange({
                  ...option,
                  starts_at: option.starts_at || "",
                  timezone: p.timezone,
                })}
              </Text>
            )}
            <Text size="sm">
              {option.yes} 人可以 · {option.maybe} 人勉强可以 · {option.no}{" "}
              人不行
            </Text>
            {canVote && optionFuture(p, option, now) ? (
              <SegmentedControl
                label="我的选择"
                value={f.values[option.id] || ""}
                onValueChange={(value) => {
                  if (value === "yes" || value === "maybe" || value === "no")
                    f.set(option.id, value);
                }}
                options={mapped(choices)}
                disabled={f.busy}
              />
            ) : (
              p.my_choices[option.id] && (
                <Text size="sm">
                  我的选择：{choices[p.my_choices[option.id]]}
                </Text>
              )
            )}
          </Surface>
        ))}
      </Form>
      {!!p.event_id && (
        <Button
          onClick={() => {
            modal.close();
            if (p.event_id) app.openDetail(p.event_id);
          }}
        >
          查看已定案活动并报名
        </Button>
      )}
      {!!p.can_manage && (
        <PollManagement
          key={p.revision + ":" + p.vote_revision}
          poll={p}
          onUpdate={update}
        />
      )}
      <div className="owner-tools">
        <Button variant="ghost" onClick={reload}>
          刷新票数与安排
        </Button>
        <Button
          variant="ghost"
          onClick={() =>
            app.copy(
              `${p.title}\n一起选择活动时间：\n${location.origin}/?poll=${p.id}`,
              "时间投票链接",
            )
          }
        >
          复制投票链接
        </Button>
      </div>
      {!!p.is_owner && (
        <Fold title={"QQ 群通知 · " + (p.bot_enabled ? "已开启" : "未开启")}>
          <Text size="sm">
            {p.bot_notice_enabled
              ? "实际发送以投递记录为准，已发送不代表群友已读。"
              : "管理员尚未启用机器人。"}
          </Text>
          <Delivery
            rows={p.bot_delivery}
            zone={p.timezone}
            retry={
              !!p.can_manage && p.status === "open" && p.bot_enabled
                ? (id) => patch("bot_retry", { outbox_id: Number(id) })
                : null
            }
          />
          {!!p.can_manage && (
            <Button
              variant="secondary"
              onClick={() => patch("bot_sync", { bot_enabled: !p.bot_enabled })}
            >
              {p.bot_enabled ? "关闭主动群通知" : "开启主动群通知"}
            </Button>
          )}
        </Fold>
      )}
      {!!p.event_time && (
        <Alert>正式活动当前安排：{timeRange(p.event_time)}</Alert>
      )}
      {!!p.event_deleted && <Text>已定案的正式活动已删除。</Text>}
      {!!p.can_remove && (
        <Button
          variant="ghost"
          destructive
          onClick={() =>
            app.confirm(
              "删除这次时间投票？",
              "投票及已有选择将移除，原链接失效，未发送通知会停止。已生成的正式活动保留，已发送的 QQ 消息不会撤回。",
              () =>
                f.run(async () => {
                  await app.api<D.Poll>("/api/time-polls/" + p.id, "PATCH", {
                    action: "remove",
                    base_revision: p.revision,
                  });
                  modal.close();
                  await app.refresh();
                  app.toast("投票已删除");
                }),
            )
          }
        >
          删除投票
        </Button>
      )}
    </div>
  );
}
function PollManagement({
  poll: p,
  onUpdate,
}: {
  poll: D.Poll;
  onUpdate: (poll: D.Poll) => unknown;
}) {
  const app = useBoard(),
    suggested =
      p.options.find(
        (o) => p.leading_option_ids.includes(o.id) && optionFuture(p, o),
      ) || p.options.find((o) => optionFuture(p, o)),
    deadline = (o?: D.PollOption) =>
      o
        ? wallDate(
            new Date(
              Math.max(
                Date.now() + 60000,
                Date.parse(
                  p.time_mode === "date"
                    ? wallToISO(o.date + "T18:00", p.timezone)
                    : o.starts_at || "",
                ) - 3600000,
              ),
            ),
            p.timezone,
          )
        : "";
  const f = useForm({
      option_id: suggested?.id || "",
      final_start_time: "18:00",
      final_duration_hours: "3",
      registration_deadline: deadline(suggested),
      reason: "",
      accept_terms: false,
    }),
    extend = useForm({ deadline: wallDate(p.deadline, p.timezone) }),
    cancel = useForm({ reason: "" }),
    [deadlineTouched, setDeadlineTouched] = useState(false);
  const option = p.options.find((o) => o.id === f.values.option_id);
  let preview = "请选择日期、开始时间与持续时长";
  try {
    if (option && p.time_mode === "date") {
      const start = wallToISO(
        option.date + "T" + f.values.final_start_time,
        p.timezone,
      );
      preview = timeRange({
        starts_at: start,
        ends_at: new Date(
          Date.parse(start) + Number(f.values.final_duration_hours) * 3600000,
        ).toISOString(),
        timezone: p.timezone,
      });
    }
  } catch {}
  const fields = {
    ...f,
    set: ((name, value) => {
      f.set(name, value);
      if (name === "registration_deadline") setDeadlineTouched(true);
      if (
        !deadlineTouched &&
        ["option_id", "final_start_time", "final_duration_hours"].includes(name)
      ) {
        try {
          const o = p.options.find(
              (o) =>
                o.id === (name === "option_id" ? value : f.values.option_id),
            ),
            start =
              p.time_mode === "date" && o
                ? wallToISO(
                    o.date +
                      "T" +
                      (name === "final_start_time"
                        ? value
                        : f.values.final_start_time),
                    p.timezone,
                  )
                : o?.starts_at;
          if (!start) return;
          f.set(
            "registration_deadline",
            wallDate(
              new Date(
                Math.max(Date.now() + 60000, Date.parse(start) - 3600000),
              ),
              p.timezone,
            ),
          );
        } catch {}
      }
    }) as typeof f.set,
  };
  return (
    <section className="poll-management">
      <Heading level={3}>发起者定案</Heading>
      <Text size="sm">
        先确认场地与费用。未选最高票或未达最低人数时须说明原因。
      </Text>
      <Form
        form={f}
        id="time-poll-finalize-form"
        onSubmit={() =>
          f.run(async () => {
            if (!option) throw new Error("请选择有效时段");
            const v = f.values,
              data: {
                action: string;
                base_revision: number;
                base_vote_revision: number;
                option_id: string;
                registration_deadline: string;
                reason: string;
                accept_terms: boolean;
                starts_at?: string;
                duration_hours?: number;
              } = {
                action: "finalize",
                base_revision: p.revision,
                base_vote_revision: p.vote_revision,
                option_id: v.option_id,
                registration_deadline: wallToISO(
                  v.registration_deadline,
                  p.timezone,
                ),
                reason: v.reason.trim(),
                accept_terms: v.accept_terms,
              };
            if (p.time_mode === "date") {
              data.starts_at = wallToISO(
                option.date + "T" + v.final_start_time,
                p.timezone,
              );
              data.duration_hours = Number(v.final_duration_hours);
            }
            await onUpdate(
              await app.api<D.Poll>("/api/time-polls/" + p.id, "PATCH", data),
            );
            app.toast("时间已确定，已通知投票者到活动页报名");
          })
        }
        footer={
          <Button type="submit" disabled={!option}>
            确定时间并发布活动
          </Button>
        }
      >
        <Field
          form={fields}
          name="option_id"
          label="最终时段"
          required
          options={p.options.map((o, index) => ({
            value: o.id,
            label: `时段 ${index + 1} · ${p.time_mode === "date" ? dayLabel(o.date, app.i18n.locale) : shortDate(o.starts_at || "", p.timezone)} · ${o.yes} 人可以`,
            disabled: !optionFuture(p, o),
          }))}
        />
        {p.time_mode === "date" && (
          <>
            <Field
              form={fields}
              name="final_start_time"
              label="活动开始时间"
              type="time"
              required
            />
            <Field
              form={fields}
              name="final_duration_hours"
              label="持续小时"
              type="number"
              min="1"
              max="24"
              required
            />
            <Text className="poll-final-preview" size="sm">
              {preview}
            </Text>
          </>
        )}
        <Field
          form={fields}
          name="registration_deadline"
          label="正式报名截止"
          type="datetime-local"
          required
        />
        <Field
          form={fields}
          name="reason"
          label="定案说明（选填）"
          multiline
          maxLength={200}
        />
        <Check
          form={f}
          name="accept_terms"
          label="已确认场地与安排；本人自动报名，其他投票者需另行报名。"
          required
        />
      </Form>
      <Fold title="截止、重新开放与取消">
        {p.status === "open" && (
          <Button
            variant="secondary"
            disabled={f.busy}
            onClick={() =>
              f.run(async () =>
                onUpdate(
                  await app.api<D.Poll>("/api/time-polls/" + p.id, "PATCH", {
                    action: "close",
                    base_revision: p.revision,
                  }),
                ),
              )
            }
          >
            提前截止投票
          </Button>
        )}
        <Form
          form={extend}
          id="time-poll-extend-form"
          onSubmit={() =>
            extend.run(async () =>
              onUpdate(
                await app.api<D.Poll>("/api/time-polls/" + p.id, "PATCH", {
                  action: "extend",
                  base_revision: p.revision,
                  deadline: wallToISO(extend.values.deadline, p.timezone),
                }),
              ),
            )
          }
          footer={
            <Button variant="secondary" type="submit">
              调整截止并开放投票
            </Button>
          }
        >
          <Field
            form={extend}
            name="deadline"
            label="新的投票截止"
            type="datetime-local"
            required
          />
          <Text size="sm">
            须早于最后一个候选失效；过期候选停止收票，已有选择保留。
          </Text>
        </Form>
        <Form
          form={cancel}
          id="time-poll-cancel-form"
          onSubmit={() =>
            cancel.run(async () =>
              onUpdate(
                await app.api<D.Poll>("/api/time-polls/" + p.id, "PATCH", {
                  action: "cancel",
                  base_revision: p.revision,
                  reason: cancel.values.reason.trim(),
                }),
              ),
            )
          }
          footer={
            <Button type="submit" variant="secondary" destructive>
              取消这次时间投票
            </Button>
          }
        >
          <Field
            form={cancel}
            name="reason"
            label="取消原因"
            multiline
            required
            maxLength={200}
          />
        </Form>
      </Fold>
      <Fold title="查看个人选择（仅发起者）">
        {(p.respondents || []).map((person) => (
          <Surface variant="note" key={person.id || person.name}>
            <Text>{person.name}</Text>
            <Text size="sm">
              {p.options
                .map(
                  (o, i) =>
                    "时段 " +
                    (i + 1) +
                    "：" +
                    (choices[person.choices[o.id]] || "未选择"),
                )
                .join(" · ")}
            </Text>
          </Surface>
        ))}
        {!(p.respondents || []).length && <Text size="sm">尚无人投票。</Text>}
      </Fold>
    </section>
  );
}
