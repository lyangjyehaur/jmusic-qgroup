import { useEffect, useState } from "react";
import { Alert, Button, Text } from "yahha-ui";
import { errorMessage } from "../errors.ts";
import {
  calendarLabel,
  eventStartValue,
  isEarlyTime,
  schedulePreview,
  shiftCalendarDate,
  startCountdownText,
  wallDate,
  wallToISO,
} from "./domain.ts";
import {
  Advanced,
  Check,
  Field,
  fieldValues,
  Form,
  uid,
  useBoard,
  useDraft,
  useForm,
  useModal,
} from "./primitives.tsx";
import type * as D from "./types.ts";
const durations: Record<string, string> = {
  约K: "3",
  聚餐: "2",
  运动: "2",
  出游: "8",
  游戏: "3",
  其他: "3",
};
function initialValues(event: D.BoardEvent | null, copy: boolean) {
  const e = copy ? null : event,
    source = copy ? event : null,
    timezone = event?.timezone ?? "Asia/Shanghai";
  const tomorrow = shiftCalendarDate(
    wallDate(Date.now(), "Asia/Shanghai").slice(0, 10),
    1,
  );
  const start = e ? wallDate(e.starts_at, timezone) : tomorrow + "T18:00";
  return {
    id: e?.id || "",
    _intent: uid(),
    _revision: e?.revision ?? "",
    _lifecycle: e?.lifecycle || "",
    title: event?.title || "",
    category: event?.category || "约K",
    location: event?.location || "",
    description: event?.description || "",
    fee_policy: event?.fee_policy || "",
    capacity_unlimited: !event?.capacity,
    capacity: String(event?.capacity || 8),
    minimum_participants: String(event?.minimum_participants || 0),
    timezone,
    visibility: event?.visibility || "public",
    event_date: source ? "" : start.slice(0, 10),
    start_time: source
      ? wallDate(source.starts_at, timezone).slice(11, 16)
      : start.slice(11, 16),
    start_day_offset: source ? "" : "0",
    duration_hours: String(event?.duration_hours || 3),
    deadline: source ? "" : e ? wallDate(e.deadline, timezone) : start,
    withdrawal_deadline: source
      ? ""
      : e
        ? wallDate(e.withdrawal_deadline, timezone)
        : start,
    bot_enabled: e ? !!e.bot_enabled : true,
    reason: "",
  };
}
export function EventForm({
  event = null,
  copy = false,
}: D.ModalProps["eventForm"]) {
  const app = useBoard(),
    modal = useModal(),
    f = useForm(() => initialValues(event, copy)),
    v = f.values;
  const [now, setNow] = useState(Date.now());
  const editing = !copy && !!event,
    assist = editing && event.can_assist_schedule,
    early = isEarlyTime(v.start_time);
  const title = copy
    ? "复制活动"
    : editing
      ? assist
        ? "管理员协助编辑"
        : "编辑活动"
      : "发起活动";
  useEffect(() => modal.setTitle(title), [title]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  const draft = useDraft(
    editing ? "event:" + event!.id : copy ? "copy:" + event!.id : "event:new",
    v,
    f.replace,
    {
      revision: event?.revision,
      decode: (data) => ({
        ...initialValues(event, copy),
        ...fieldValues(data.fields),
        _intent: data.dataset?.intent || uid(),
        _revision: data.dataset?.revision ?? event?.revision ?? "",
        _lifecycle: data.dataset?.lifecycle || "",
        id: data.fields?.find((field) => field.name === "id")?.value || "",
      }),
    },
  );
  const set: typeof f.set = (name, value) => {
    let patch: Partial<typeof v> = { [name]: value };
    if (name === "visibility" && value === "invitation")
      patch.bot_enabled = false;
    if (
      name === "category" &&
      !v.id &&
      v.duration_hours === (durations[v.category] || "3")
    )
      patch.duration_hours = durations[String(value)] || "3";
    if (name === "start_time") {
      if (isEarlyTime(String(value)) && !early) patch.start_day_offset = "";
      if (!isEarlyTime(String(value))) patch.start_day_offset = "0";
    }
    if (
      name === "deadline" &&
      (!v.withdrawal_deadline || v.withdrawal_deadline === v.deadline)
    )
      patch.withdrawal_deadline = String(value);
    if (
      [
        "event_date",
        "start_time",
        "start_day_offset",
        "duration_hours",
        "timezone",
        "category",
      ].includes(name)
    )
      try {
        const next = { ...v, ...patch };
        const nextStart = eventStartValue(
          next.event_date,
          next.start_time,
          next.start_day_offset,
        );
        wallToISO(nextStart, next.timezone);
        let oldStart = "";
        try {
          oldStart = eventStartValue(
            v.event_date,
            v.start_time,
            v.start_day_offset,
          );
        } catch {}
        if (!v.deadline || v.deadline === oldStart || v.deadline > nextStart) {
          patch.deadline = nextStart;
          if (!v.withdrawal_deadline || v.withdrawal_deadline === v.deadline)
            patch.withdrawal_deadline = nextStart;
        }
      } catch {}
    f.patch(patch);
  };
  const fields = { ...f, set };
  let start = null,
    end = null,
    schedule = "";
  try {
    start = new Date(
      wallToISO(
        eventStartValue(v.event_date, v.start_time, v.start_day_offset),
        v.timezone,
      ),
    );
    end = new Date(+start + Number(v.duration_hours) * 3600000);
    schedule = schedulePreview(start, end, v.timezone);
  } catch (error) {
    if (!!v.event_date && v.start_time) schedule = errorMessage(error);
  }
  const submit = async (intent = "publish", confirmed = false) =>
    f.run(async () => {
      if (!start || !end) throw new Error("请核对完整的日期、时间与凌晨日期");
      const isDraft = intent === "draft",
        at = f.revision.current;
      if (
        !isDraft &&
        !confirmed &&
        (early ||
          wallDate(start, v.timezone).slice(0, 10) !==
            wallDate(end, v.timezone).slice(0, 10))
      ) {
        app.confirm(
          "核对通宵／跨日活动时间",
          startCountdownText(start) + "\n" + schedule,
          () => {
            if (f.revision.current === at) submit(intent, true);
          },
          { confirm: "日期无误，继续", cancel: "返回修改" },
        );
        return;
      }
      if (await app.client.hasPending(v.id || "new"))
        throw new Error("先在消息的「待确认操作」查询上次保存结果，再继续发布");
      const data: D.EventWrite = {
        client_intent: v._intent,
        title: v.title,
        category: v.category,
        location: v.location,
        description: v.description,
        minimum_participants: Number(v.minimum_participants),
        capacity: v.capacity_unlimited ? 0 : Number(v.capacity),
        duration_hours: Number(v.duration_hours),
        timezone: v.timezone || null,
        starts_at: start.toISOString(),
        deadline: wallToISO(v.deadline, v.timezone),
        withdrawal_deadline: wallToISO(v.withdrawal_deadline, v.timezone),
        reason: v.reason,
      };
      if (!assist) data.visibility = v.visibility;
      if (!editing || event.is_owner) data.fee_policy = v.fee_policy;
      if (v.visibility !== "invitation" && (!editing || event.is_owner))
        data.bot_enabled = !!v.bot_enabled;
      if (!v.id || v._lifecycle === "draft") data.join_owner = true;
      if (v.id) data.base_revision = Number(v._revision);
      else data.lifecycle = isDraft ? "draft" : "scheduled";
      let result = await app.api<D.BoardEvent>(
        "/api/events" + (v.id ? "/" + v.id : ""),
        v.id ? "PATCH" : "POST",
        data,
      );
      if (!!v.id && v._lifecycle === "draft" && !isDraft)
        result = await app.api<D.BoardEvent>("/api/events/" + v.id, "PATCH", {
          action: "publish",
          base_revision: result.revision,
        });
      await draft.clear();
      modal.close();
      await app.refresh();
      if (result.lifecycle === "draft") app.setFilter("mine");
      await app.openDetail(result.id);
      app.toast(
        result.lifecycle === "draft"
          ? "草稿已保存"
          : v.id
            ? "活动已更新"
            : "活动已发布",
      );
    });
  const reload = () =>
    f.run(async () => {
      const latest = await app.api<D.BoardEvent>(
        "/api/events/" + (v.id || event?.id),
      );
      await draft.clear();
      app.open("eventForm", { event: latest });
    });
  const zones = [
    "Asia/Shanghai",
    "Asia/Taipei",
    "Asia/Hong_Kong",
    "Asia/Tokyo",
    "UTC",
    "",
  ];
  if (!!v.timezone && !zones.includes(v.timezone)) zones.push(v.timezone);
  return (
    <Form
      id="event-form"
      form={f}
      draft={draft}
      onSubmit={submit}
      footer={
        <>
          {(f.error || draft.warning) && !!v.id && (
            <Button id="event-reload" variant="ghost" onClick={reload}>
              载入最新版（替换当前输入）
            </Button>
          )}
          <Button
            id="publish-button"
            type="submit"
            name="intent"
            value="publish"
            appearance="soft"
          >
            {editing
              ? event.lifecycle === "draft"
                ? "发布草稿"
                : "保存修改"
              : "发布活动"}
          </Button>
          {(!editing || event.lifecycle === "draft") && (
            <Button
              id="save-draft"
              type="submit"
              name="intent"
              value="draft"
              variant="ghost"
            >
              保存草稿
            </Button>
          )}
        </>
      }
    >
      {assist && (
        <Alert tone="warning">管理员协助编辑，请填写原因并核对原安排。</Alert>
      )}
      <Field
        form={fields}
        name="title"
        label="活动名称"
        required
        maxLength={80}
      />
      <Field
        form={fields}
        name="category"
        label="类型"
        options={["约K", "聚餐", "运动", "出游", "游戏", "其他"].map(
          (value) => ({ value, label: app.i18n.category(value) }),
        )}
      />
      <div className="form-row">
        <Field
          form={fields}
          name="event_date"
          label="活动日期"
          type="date"
          required
        />
        <Field
          form={fields}
          name="start_time"
          label="开始时间"
          type="time"
          required
        />
        <Field
          form={fields}
          name="duration_hours"
          label="持续时间"
          options={Array.from({ length: 24 }, (_, index) => ({
            value: String(index + 1),
            label: `${index + 1} 小时`,
          }))}
        />
      </div>
      {early && (
        <Field
          form={fields}
          name="start_day_offset"
          label="凌晨属于哪一晚？"
          required
          options={[
            { value: "", label: "请选择凌晨日期" },
            {
              value: "0",
              label: v.event_date
                ? `当天凌晨 · ${calendarLabel(v.event_date, false)}`
                : "当天凌晨（前一晚过后）",
            },
            {
              value: "1",
              label: v.event_date
                ? `次日凌晨 · ${calendarLabel(shiftCalendarDate(v.event_date, 1), false)}`
                : "次日凌晨（相约当晚过后）",
            },
          ]}
          help="00:00 是一天的开始。若约的是这一天晚上过后的凌晨，请选「次日凌晨」。"
        />
      )}
      {start && (
        <Text id="start-countdown" role="status">
          {startCountdownText(start, now)}
        </Text>
      )}
      <Text id="end-time-preview" role="status" className="board-pre-wrap">
        {schedule}
      </Text>
      <Field
        form={fields}
        name="location"
        label="地点"
        required
        maxLength={120}
        placeholder="集合地点、场地名称或地址"
      />
      <Field
        form={fields}
        name="description"
        label="注意事项（选填）"
        multiline
        rows={3}
        maxLength={3000}
        placeholder="费用、集合方式、其他要求等"
      />
      {!!v.fee_policy && (
        <Alert tone="info">
          <Text>旧版费用说明已完整保留。保存其他修改不会清除。</Text>
          <Text className="board-pre-wrap">{v.fee_policy}</Text>
          {(!editing || event.is_owner) && (
            <Button
              variant="ghost"
              id="event-merge-fee"
              onClick={() => {
                const description = [v.description, v.fee_policy]
                  .filter(Boolean)
                  .join("\n\n");
                if (description.length > 3000) {
                  f.setError(
                    "合并后超出注意事项字数上限；旧版费用说明仍完整保留。",
                  );
                  return;
                }
                f.patch({ description, fee_policy: "" });
              }}
            >
              并入注意事项
            </Button>
          )}
        </Alert>
      )}
      <Field
        form={fields}
        name="minimum_participants"
        label="最低成团人数"
        type="number"
        min={0}
        max={500}
        inputMode="numeric"
        help="0 表示不设置；未达标由发起者决定，不自动取消。"
      />
      <Check
        form={fields}
        name="bot_enabled"
        label="主动将公开活动信息与重要节点发送到通知目标 QQ 群"
        disabled={v.visibility === "invitation" || (editing && !event.is_owner)}
      />
      <Text size="sm" tone="muted">
        此开关只控制主动通知。允许回复的群可查询公开活动；邀请活动和草稿不对群公开。机器人模拟模式只记录，不发送。
      </Text>
      {v.visibility === "invitation" && (
        <Alert tone="info">
          当前为邀请可见，不对群公开，也不会主动发送通知。
        </Alert>
      )}
      <Advanced>
        <Check form={fields} name="capacity_unlimited" label="人数不限" />
        {!v.capacity_unlimited && (
          <Field
            form={fields}
            name="capacity"
            label="人数上限"
            type="number"
            min={1}
            max={500}
            required
          />
        )}
        <Field
          form={fields}
          name="deadline"
          label="报名截止"
          type="datetime-local"
          required
        />
        <Field
          form={fields}
          name="withdrawal_deadline"
          label="退出期限"
          type="datetime-local"
          required
          disabled={assist}
        />
        <Field
          form={fields}
          name="visibility"
          label="可见性"
          disabled={assist}
          options={[
            { value: "public", label: "公开" },
            { value: "invitation", label: "持邀请链接可见" },
          ]}
        />
        <Field
          form={fields}
          name="timezone"
          label="活动时区"
          options={zones.map((value) => ({
            value,
            label:
              {
                "Asia/Shanghai": "北京时间（UTC+8）",
                "Asia/Taipei": "台北时间（UTC+8）",
                "Asia/Hong_Kong": "香港时间（UTC+8）",
                "Asia/Tokyo": "东京时间（UTC+9）",
                UTC: "UTC",
                "": "原记录未设置，按当前设备显示",
              }[value] || value,
          }))}
          help="日期和截止时间按所选活动时区填写；跨日会显示完整结束日期。"
        />
      </Advanced>
      {editing && event.lifecycle !== "draft" && (
        <Field
          form={fields}
          name="reason"
          label="修改原因"
          multiline
          rows={2}
          maxLength={200}
          required={assist}
          help="已有报名时，更改时间、地点、费用等安排需原因，并请参加者重新确认。"
        />
      )}
    </Form>
  );
}
