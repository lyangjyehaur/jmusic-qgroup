import React, { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Heading,
  Spinner,
  Surface,
  Text,
} from "yahha-ui";
import { errorStatus } from "../errors.ts";
import {
  shortDate,
  timeRange,
  wallDate,
  wallToISO,
  zoneLabel,
} from "./domain.ts";
import {
  Check,
  Field,
  Fold,
  Form,
  optionsFrom,
  useBoard,
  useForm,
  useModal,
} from "./primitives.tsx";
import type * as D from "./types.ts";
export const scopes: Record<string, string> = {
  schedule: "修改安排与开始／结束",
  roster: "管理报名",
  attendance: "核对出席",
  settlement: "发布结算、管理账款与使用本人收款码",
};
const attendanceNames: Record<string, string> = {
  unknown: "未核对",
  present: "到场",
  absent: "缺席",
  late: "迟到",
  left: "早退",
};
const mapped = (map: Record<string, string>) =>
  Object.entries(map).map(([value, label]) => ({ value, label }));
export function ActivityAlerts({ event: e }: D.EventProps) {
  const app = useBoard(),
    open = (action: string, id?: number) =>
      app.open("activity", { event: e, action, id });
  return (
    <>
      {e.lifecycle === "draft" && (
        <Alert>草稿，仅发起者与已接受邀请的协办可见。</Alert>
      )}
      {!!e.estimated_over && (
        <Alert tone="warning">已过预计结束时间，待确认结束或延长。</Alert>
      )}
      {!!e.archived_at && <Alert>已归档，名单与结算记录保留。</Alert>}
      {!!e.cancellation_reason && (
        <Alert tone="warning">取消原因：{e.cancellation_reason}</Alert>
      )}
      {e.minimum_participants > 0 &&
        !["ended", "cancelled"].includes(e.lifecycle) && (
          <Text>
            成团 {e.confirmed_count}/{e.minimum_participants} 人 ·{" "}
            {e.formation_state === "confirmed"
              ? "已确认成团"
              : e.minimum_met
                ? "已达最低人数，待发起者确认"
                : "尚未达到最低人数"}
          </Text>
        )}
      {(e.pending_confirmation_count > 0 ||
        e.declined_confirmation_count > 0) && (
        <Alert tone="warning">
          安排已变更 · {e.pending_confirmation_count || 0} 人待确认 ·{" "}
          {e.declined_confirmation_count || 0} 人暂不同意{" "}
          <Button
            variant="ghost"
            onClick={() => app.open("conditions", { event: e })}
          >
            查看安排
          </Button>
        </Alert>
      )}
      {!!e.fee_policy && (
        <Fold title="费用与退出规则">
          <Text className="board-pre-wrap">{e.fee_policy}</Text>
          <Text size="sm">
            退出期限：{shortDate(e.withdrawal_deadline, e.timezone)}
            。期限后退出需提交申请；是否负担费用须按已接受的约定协调，不会自动加收。
          </Text>
        </Fold>
      )}
      {(e.actual_started_at || e.actual_ended_at) && (
        <Text size="sm">
          {!!e.actual_started_at &&
            "实际开始 " + shortDate(e.actual_started_at, e.timezone)}{" "}
          {!!e.actual_ended_at &&
            "实际结束 " + shortDate(e.actual_ended_at, e.timezone)}
        </Text>
      )}
      {!!e.cohosts?.length && (
        <Text size="sm">
          协办：
          {e.cohosts
            .map(
              (person) =>
                person.name +
                (person.permissions.includes("settlement") ? "（结算人）" : ""),
            )
            .join("、")}
        </Text>
      )}
      {(e.is_owner || e.management_scopes?.includes("settlement")) && (
        <Fold title={"QQ 群同步 · " + (e.bot_enabled ? "已开启" : "未开启")}>
          <Text size="sm">
            {e.bot_feature_enabled
              ? "通知是否实际发送，以投递记录为准；已发送不代表群友已读。"
              : "管理员尚未启用机器人，当前不会排入通知。"}
          </Text>
          <Delivery
            rows={e.bot_delivery}
            zone={e.timezone}
            retry={e.bot_enabled ? (id) => open("bot_retry", id) : null}
          />
        </Fold>
      )}
    </>
  );
}
export function Delivery({
  rows = [],
  zone,
  retry,
}: {
  rows?: D.DeliveryRow[];
  zone?: string | null;
  retry?: ((id: number) => unknown) | null;
}) {
  const states: Record<string, string> = {
    pending: "待送",
    sending: "投递中",
    sent: "已发送",
    failed: "失败",
    skipped: "已作废",
    simulated: "模拟，未发送",
  };
  return rows.length ? (
    rows.map((row) => (
      <Text size="sm" key={row.id}>
        {states[row.state] || row.state} ·{" "}
        {shortDate(row.sent_at || row.simulated_at || row.created_at, zone)}
        {!!row.last_error && row.state !== "simulated"
          ? " · " + row.last_error
          : ""}
        {retry && ["failed", "simulated"].includes(row.state) && (
          <Button variant="ghost" onClick={() => retry(row.id)}>
            重送通知
          </Button>
        )}
      </Text>
    ))
  ) : (
    <Text size="sm">暂无投递记录</Text>
  );
}
export function ActivityTools({ event: e }: D.EventProps) {
  const app = useBoard(),
    button = (
      action: string,
      label: string,
      props: React.ComponentProps<typeof Button> = {},
    ) => (
      <Button
        key={action}
        variant="ghost"
        data-activity={action}
        {...props}
        onClick={() =>
          action === "management" ||
          action === "attendance" ||
          action === "onsite"
            ? app.open(action, { event: e })
            : app.open("activity", { event: e, action })
        }
      >
        {label}
      </Button>
    );
  if (!e.is_owner && !e.is_cohost) return null;
  return (
    <div className="owner-tools">
      {!!e.can_edit_schedule &&
        e.lifecycle !== "draft" &&
        e.management_scopes?.includes("schedule") && (
          <>
            {e.phase === "scheduled" &&
              button(
                e.registration_open ? "pause" : "resume",
                e.registration_open ? "暂停报名" : "恢复报名",
              )}
            {!e.actual_started_at && button("start", "确认实际开始")}
          </>
        )}
      {!!e.can_manage_roster && (
        <Button
          variant="ghost"
          onClick={() => app.open("party", { event: e, invite: true })}
        >
          邀请补报名
        </Button>
      )}
      {!!e.can_attendance && button("attendance", "出席管理")}
      {!!e.can_onsite && button("onsite", "现场补录")}
      {!!e.is_owner && (
        <>
          {!e.archived_at && (
            <>
              {button("bot_sync", "QQ 群同步设置")}
              {button("management", "协办与转交")}
            </>
          )}
          {e.lifecycle !== "draft" &&
            !["ended", "cancelled"].includes(e.lifecycle) &&
            !e.archived_at &&
            e.formation_state !== "confirmed" &&
            button("formation", "确认成团")}
          {e.lifecycle !== "draft" &&
            e.lifecycle !== "cancelled" &&
            !e.archived_at &&
            button("cancel", "取消活动", { destructive: true })}
          {["ended", "cancelled"].includes(e.lifecycle) &&
            button(
              e.archived_at ? "unarchive" : "archive",
              e.archived_at ? "取消归档" : "归档",
            )}
          {!!e.removal_blocker && <Text size="sm">{e.removal_blocker}</Text>}
        </>
      )}
    </div>
  );
}
export function ActivityAction({
  event: e,
  action,
  id,
}: D.ModalProps["activity"]) {
  const app = useBoard(),
    modal = useModal(),
    f = useForm({ reason: "", bot_enabled: !!e.bot_enabled });
  const configs: Record<string, [string, string, boolean, string]> = {
    cancel: [
      "取消活动",
      "取消原因",
      true,
      "保留名单与所有帐务，仍可结算已发生的费用。",
    ],
    archive: [
      "归档活动",
      "备注",
      false,
      "从默认往期列表收起，原链接与所有记录仍可查看。",
    ],
    unarchive: [
      "取消归档",
      "备注",
      false,
      "重新显示于往期列表，不会重新开放报名。",
    ],
    publish: ["发布草稿", "备注", false, "发布当前安排，并自动为发起者报名。"],
    start: [
      "确认实际开始",
      "备注",
      false,
      "记录现在为实际开始时间，停止普通报名；临时加入使用现场补录。",
    ],
    formation: [
      "确认成团",
      "原因",
      !e.minimum_met,
      "未达到最低人数仍可决定照常举行，请写明原因。",
    ],
    pause: ["暂停报名", "备注", false, "现有名单与候补保留。"],
    resume: ["恢复报名", "备注", false, "在截止时间内按原候补顺序递补。"],
    bot_sync: [
      "QQ 群同步设置",
      "备注",
      false,
      "只控制主动通知。关闭后停止主动通知，已发布的公开活动仍可在群内查询。",
    ],
    bot_retry: [
      "重送 QQ 通知",
      "备注",
      false,
      "只重新排入这条通知。请核对原活动信息仍适合群成员查看；模拟模式会继续模拟。",
    ],
    revoke_role: [
      "撤销协办",
      "原因",
      true,
      "撤销管理权限；对方自己的报名管理权保留。",
    ],
    revoke_invite: ["撤销交接邀请", "原因", true, "尚未接受的链接将失效。"],
  };
  const config = configs[action];
  useEffect(() => {
    if (config) modal.setTitle(config[0]);
  }, []);
  if (!config) return <Alert tone="error">不支持此操作</Alert>;
  return (
    <Form
      form={f}
      id="activity-action-form"
      onSubmit={() =>
        f.run(async () => {
          let path = "/api/events/" + e.id;
          let method: D.ApiMethod = "PATCH";
          if (action.startsWith("revoke_")) {
            path +=
              "/management/" +
              (action === "revoke_role" ? "roles" : "invitations") +
              "/" +
              id;
            method = "DELETE";
          }
          const data: D.EventWrite = {
            action,
            base_revision: e.revision,
            reason: f.values.reason.trim(),
          };
          if (action === "bot_sync") data.bot_enabled = f.values.bot_enabled;
          if (action === "bot_retry") data.outbox_id = Number(id);
          const updated = await app.api<D.BoardEvent>(path, method, data);
          modal.close();
          app.apply(updated);
          await app.refresh();
          if (action.startsWith("revoke_"))
            app.open("management", { event: updated });
          app.toast("活动已更新");
        })
      }
      footer={<Button type="submit">{config[0]}</Button>}
    >
      <Text>{config[3]}</Text>
      {action === "bot_sync" && (
        <>
          <Check
            form={f}
            name="bot_enabled"
            label="开启 QQ 群主动通知"
            disabled={e.visibility !== "public"}
          />
          <Text className="board-pre-wrap">
            {[
              e.title,
              timeRange(e),
              "地点：" + e.location,
              e.description,
              e.fee_policy,
            ]
              .filter(Boolean)
              .join("\n")}
          </Text>
        </>
      )}
      <Field
        form={f}
        name="reason"
        label={config[1] + (config[2] ? "" : "（选填）")}
        multiline
        maxLength={300}
        required={config[2]}
      />
    </Form>
  );
}
function Arrangement({
  arrangement: a,
  event: e,
}: {
  arrangement: D.Arrangement | null | undefined;
  event: D.BoardEvent;
}) {
  if (!a) return null;
  return (
    <dl className="arrangement-facts">
      <dt>时间</dt>
      <dd>
        {timeRange({
          ...e,
          ...a,
          ends_at: a.duration_hours
            ? new Date(
                Date.parse(a.starts_at) + a.duration_hours * 3600000,
              ).toISOString()
            : null,
        })}
      </dd>
      <dt>地点</dt>
      <dd>{a.location}</dd>
      <dt>费用</dt>
      <dd>{a.fee_policy || "原记录未填写费用规则"}</dd>
      <dt>注意事项</dt>
      <dd>{a.description || "无"}</dd>
      <dt>退出期限</dt>
      <dd>{shortDate(a.withdrawal_deadline || e.deadline, a.timezone)}</dd>
    </dl>
  );
}
export function ConditionsForm({ event: e }: D.EventProps) {
  const app = useBoard(),
    modal = useModal(),
    people = e.my_attendees
      .filter((person) => person.can_respond)
      .sort(
        (a, b) =>
          Number(a.confirmation_state === "accepted") -
          Number(b.confirmation_state === "accepted"),
      ),
    [versions, setVersions] = useState<D.Conditions[]>([]),
    f = useForm({ person_id: people[0]?.id || "", reason: "" });
  useEffect(() => {
    f.run(async () =>
      setVersions(
        (
          await app.api<{ versions: D.Conditions[] }>(
            `/api/events/${e.id}/conditions`,
          )
        ).versions,
      ),
    );
  }, []);
  const person = people.find((person) => person.id === f.values.person_id),
    prior = versions.find(
      (version) => version.version === person?.accepted_conditions_version,
    );
  const respond = (decision: "accepted" | "declined") =>
    f.run(async () => {
      const updated = await app.api<D.BoardEvent>(
        `/api/events/${e.id}/attendees/${f.values.person_id}/conditions`,
        "PATCH",
        {
          base_revision: e.revision,
          conditions_version: e.conditions_version,
          decision,
          reason: f.values.reason.trim(),
        },
      );
      modal.close();
      app.apply(updated);
      await app.refresh();
      app.toast(
        decision === "accepted"
          ? "已接受当前安排"
          : "已通知发起者协调，原报名和约定保留",
      );
    });
  return (
    <Form
      id="conditions-form"
      form={f}
      onSubmit={() => respond("accepted")}
      footer={
        people.length > 0 && (
          <>
            <Button variant="secondary" onClick={() => respond("declined")}>
              暂不同意，联系协调
            </Button>
            <Button type="submit">接受当前安排</Button>
          </>
        )
      }
    >
      <Heading level={3}>当前安排 · 第 {e.conditions_version} 版</Heading>
      <Text>{e.conditions?.summary}</Text>
      <Arrangement arrangement={e.conditions?.arrangement} event={e} />
      <Button
        variant="ghost"
        onClick={() =>
          f.run(async () => {
            let link;
            try {
              link = app.eventUrl(e);
            } catch {
              link = "请向发起者索取活动邀请链接。";
            }
            await app.copy(
              `${e.title}\n${e.conditions.summary}\n${timeRange(e)}\n地点：${e.conditions.arrangement.location}\n费用规则：${e.conditions.arrangement.fee_policy || "未填写"}\n请打开活动核对安排，原报名与原约定保留，变更需要逐人确认。\n${link}`,
              "变更摘要",
            );
          })
        }
      >
        复制变更摘要
      </Button>
      {people.length > 0 && (
        <>
          <Field
            form={f}
            name="person_id"
            label="参加者"
            options={people.map((person) => ({
              value: person.id,
              label:
                person.nickname +
                " · " +
                ({
                  accepted: "已接受",
                  declined: "暂不同意",
                  pending: "待确认",
                }[person.confirmation_state] || "待确认"),
            }))}
          />
          {prior && prior.version !== e.conditions_version && (
            <Fold title={"上次接受的安排 · 第 " + prior.version + " 版"}>
              <Arrangement arrangement={prior.arrangement} event={e} />
            </Fold>
          )}
          <Field
            form={f}
            name="reason"
            label="说明（选填）"
            multiline
            rows={2}
            maxLength={300}
          />
        </>
      )}
    </Form>
  );
}
export function ManagementForm({
  event: e,
  settlement = false,
}: D.ModalProps["management"]) {
  const app = useBoard(),
    f = useForm({
      kind: settlement ? "settlement" : "cohost",
      attendee_id: "",
      target_name: "",
      permissions: ["schedule", "roster", "attendance"],
      reason: "",
    });
  return (
    <Form
      id="management-form"
      form={f}
      onSubmit={() =>
        f.run(async () => {
          const v = f.values,
            updated = await app.api<D.BoardEvent>(
              `/api/events/${e.id}/management/invitations`,
              "POST",
              {
                base_revision: e.revision,
                kind: v.kind === "settlement" ? "cohost" : v.kind,
                target_name: v.target_name.trim(),
                attendee_id: v.attendee_id || null,
                permissions:
                  v.kind === "settlement" ? ["settlement"] : v.permissions,
                reason: v.reason.trim(),
              },
            );
          app.apply(updated);
          await app.refresh();
          app.open("management", { event: updated });
          app.toast("交接邀请已生成，请只发送给指定接任人");
        })
      }
      footer={
        <Button id="save-management" type="submit">
          生成交接邀请
        </Button>
      }
    >
      <Heading level={3}>当前协办</Heading>
      {e.cohosts?.map((person) => (
        <Surface key={person.id} variant="note">
          <Text>
            {person.name} ·{" "}
            {person.permissions.map((scope) => scopes[scope]).join("、")}
          </Text>
          <Button
            variant="ghost"
            destructive
            onClick={() =>
              app.open("activity", {
                event: e,
                action: "revoke_role",
                id: person.id,
              })
            }
          >
            撤销
          </Button>
        </Surface>
      ))}
      {!e.cohosts?.length && <Text size="sm">暂无协办</Text>}
      {!!e.pending_management?.length && (
        <Heading level={3}>待接受邀请</Heading>
      )}
      {e.pending_management?.map((person) => (
        <Surface key={person.id} variant="note">
          <Text>
            {person.target_name} ·{" "}
            {person.kind === "transfer"
              ? "接任发起者"
              : person.permissions.includes("settlement")
                ? "结算人"
                : "协办"}
          </Text>
          <Text size="sm">{shortDate(person.expires_at)} 前有效</Text>
          <Button
            variant="ghost"
            onClick={() =>
              app.copy(
                location.origin +
                  "/?event=" +
                  e.id +
                  "&management_invite=" +
                  person.token,
              )
            }
          >
            复制链接
          </Button>
          <Button
            variant="ghost"
            destructive
            onClick={() =>
              app.open("activity", {
                event: e,
                action: "revoke_invite",
                id: person.id,
              })
            }
          >
            撤销
          </Button>
        </Surface>
      ))}
      <Heading level={3}>新增邀请</Heading>
      <Field
        form={f}
        name="kind"
        label="交接类型"
        options={[
          { value: "cohost", label: "协办" },
          { value: "settlement", label: "指定结算人" },
          { value: "transfer", label: "转交发起者" },
        ]}
      />
      <Field
        form={{
          ...f,
          set: (name, value) => {
            f.set(name, value);
            const p = e.participants.find((p) => p.id === value);
            if (p) f.set("target_name", p.nickname);
          },
        }}
        name="attendee_id"
        label="指定参加者"
        options={[
          { value: "", label: "专属链接，由持链接者接受" },
          ...optionsFrom(e.participants.filter((p) => !p.is_guest && !p.is_me)),
        ]}
      />
      <Field
        form={f}
        name="target_name"
        label="接任人称呼"
        required
        maxLength={24}
      />
      {f.values.kind === "cohost" && (
        <div>
          {Object.entries(scopes).map(([scope, label]) => (
            <Checkbox
              key={scope}
              label={label}
              checked={f.values.permissions.includes(scope)}
              onChange={(event) =>
                f.set(
                  "permissions",
                  event.target.checked
                    ? [...f.values.permissions, scope]
                    : f.values.permissions.filter((value) => value !== scope),
                )
              }
            />
          ))}
        </div>
      )}
      <Field
        form={f}
        name="reason"
        label="交接说明"
        multiline
        maxLength={300}
      />
    </Form>
  );
}
export function AcceptRole({ eventId, token }: D.ModalProps["role"]) {
  const app = useBoard(),
    modal = useModal(),
    [info, setInfo] = useState<D.RoleInfo | null>(null),
    f = useForm({ accept_responsibility: false });
  const load = async () =>
    setInfo(
      await app.api<D.RoleInfo>(
        `/api/events/${eventId}/management/invitations/${token}`,
      ),
    );
  useEffect(() => {
    f.run(load);
  }, []);
  return (
    <Form
      form={f}
      id="accept-role-form"
      onSubmit={() =>
        app.withProfile(() =>
          f.run(async () => {
            if (!info) return;
            try {
              const updated = await app.api<D.BoardEvent>(
                `/api/events/${eventId}/management/invitations/${token}/accept`,
                "POST",
                {
                  base_revision: info.base_revision,
                  accept_responsibility: f.values.accept_responsibility,
                },
              );
              const url = new URL(location.href);
              url.searchParams.delete("management_invite");
              history.replaceState(null, "", url);
              modal.close();
              await app.openDetail(updated.id);
              app.toast("已接受交接");
            } catch (error) {
              if (errorStatus(error) === 409) await load();
              throw error;
            }
          }),
        )
      }
      footer={info && <Button type="submit">接受交接</Button>}
    >
      {info ? (
        <>
          <Heading level={3}>
            {info.kind === "transfer"
              ? "接任发起者"
              : info.permissions.includes("settlement")
                ? "接受结算责任"
                : "接受协办"}
          </Heading>
          <Text>
            {info.title} · {info.owner_name} 邀请 {info.target_name}
          </Text>
          <Text>
            {info.kind === "transfer"
              ? "接受后将管理名单、安排和全部结算；原发起者不再拥有发起者权限。"
              : info.permissions.map((scope) => scopes[scope]).join("、") +
                (info.permissions.includes("settlement")
                  ? "。结算使用自己的收款码；发起者保留管理权。"
                  : "。协办不能转交活动。")}
          </Text>
          <Check
            form={f}
            name="accept_responsibility"
            label="已了解并接受管理责任"
            required
          />
        </>
      ) : (
        <Spinner label="加载交接邀请" />
      )}
    </Form>
  );
}
export function AttendanceForm({ event: initial }: D.EventProps) {
  const app = useBoard(),
    [e, setEvent] = useState(initial),
    first = e.attendance_roster[0],
    f = useForm({
      person_id: first?.id || "",
      attendance: first?.attendance || "unknown",
      attendance_note: first?.attendance_note || "",
      arrived_at: first?.arrived_at
        ? wallDate(first.arrived_at, e.timezone)
        : "",
      left_at: first?.left_at ? wallDate(first.left_at, e.timezone) : "",
      reason: "",
    });
  const fields = {
    ...f,
    set: ((name, value) => {
      if (name === "person_id") {
        const p = e.attendance_roster.find((p) => p.id === value);
        if (!p) return;
        f.patch({
          person_id: String(value),
          attendance: p.attendance,
          attendance_note: p.attendance_note,
          arrived_at: p.arrived_at ? wallDate(p.arrived_at, e.timezone) : "",
          left_at: p.left_at ? wallDate(p.left_at, e.timezone) : "",
          reason: "",
        });
      } else f.set(name, value);
    }) as typeof f.set,
  };
  return (
    <Form
      form={f}
      id="attendance-form"
      onSubmit={() =>
        f.run(async () => {
          const v = f.values,
            updated = await app.api<D.BoardEvent>(
              `/api/events/${e.id}/attendance/${v.person_id}`,
              "PATCH",
              {
                base_revision: e.revision,
                attendance: v.attendance,
                attendance_note: v.attendance_note.trim(),
                reason: v.reason.trim(),
                arrived_at: v.arrived_at
                  ? wallToISO(v.arrived_at, e.timezone)
                  : null,
                left_at: v.left_at ? wallToISO(v.left_at, e.timezone) : null,
              },
            );
          setEvent(updated);
          app.apply(updated);
          await app.refresh();
          app.toast("出席已记录");
        })
      }
      footer={
        <Button type="submit" disabled={!first}>
          保存出席
        </Button>
      }
    >
      {first ? (
        <>
          <Field
            form={fields}
            name="person_id"
            label="参加者"
            options={e.attendance_roster.map((p) => ({
              value: p.id,
              label:
                p.nickname +
                " · " +
                attendanceNames[p.attendance] +
                (p.status === "withdrawn" ? "（已退出）" : ""),
            }))}
          />
          <Field
            form={f}
            name="attendance"
            label="出席状态"
            options={mapped(attendanceNames)}
          />
          <Field
            form={f}
            name="attendance_note"
            label="出席备注"
            multiline
            maxLength={300}
          />
          <Text size="sm">实际到离场时间（{zoneLabel(e.timezone)}，选填）</Text>
          <Field
            form={f}
            name="arrived_at"
            label="到场时间"
            type="datetime-local"
          />
          <Field
            form={f}
            name="left_at"
            label="离场时间"
            type="datetime-local"
          />
          <Field
            form={f}
            name="reason"
            label="更正原因"
            multiline
            maxLength={300}
            required={["ended", "cancelled"].includes(e.lifecycle)}
          />
          <Text size="sm">
            出席状态不自动改动费用或已发布结算。活动结束或取消后更正需填写原因。
          </Text>
        </>
      ) : (
        <Text>暂无可核对人员</Text>
      )}
    </Form>
  );
}
export function OnsiteForm({ event: e }: D.EventProps) {
  const app = useBoard(),
    modal = useModal(),
    f = useForm({
      name: "",
      note: "",
      payer_kind: "self",
      reason: "",
      allow_over_capacity: false,
      override_waitlist: false,
      accept_terms: false,
    });
  return (
    <Form
      form={f}
      id="onsite-form"
      onSubmit={() =>
        f.run(async () => {
          const v = f.values,
            updated = await app.api<D.BoardEvent>(
              `/api/events/${e.id}/onsite`,
              "POST",
              {
                base_revision: e.revision,
                conditions_version: e.conditions_version,
                people: [
                  {
                    name: v.name.trim(),
                    note: v.note.trim(),
                    payer_kind: v.payer_kind,
                  },
                ],
                reason: v.reason.trim(),
                allow_over_capacity: v.allow_over_capacity,
                override_waitlist: v.override_waitlist,
                accept_terms: v.accept_terms,
              },
            );
          modal.close();
          app.apply(updated);
          await app.refresh();
          app.toast("已补录为正式到场人员");
        })
      }
      footer={<Button type="submit">保存现场补录</Button>}
    >
      <Text>
        目前正式 {e.confirmed_count} 人，上限 {e.capacity || "不限"}，候补{" "}
        {e.waiting_count || 0} 人。
      </Text>
      <Field form={f} name="name" label="参加者称呼" required maxLength={24} />
      <Field form={f} name="note" label="备注" multiline maxLength={200} />
      <Field
        form={f}
        name="payer_kind"
        label="默认付款人"
        options={[
          { value: "self", label: "参加者自己付款" },
          { value: "manager", label: "由我代付" },
        ]}
      />
      <Field
        form={f}
        name="reason"
        label="补录原因"
        multiline
        required
        maxLength={300}
      />
      <Check form={f} name="allow_over_capacity" label="允许超过人数上限" />
      <Check
        form={f}
        name="override_waitlist"
        label="已核对候补，允许现场人员先加入"
      />
      <Text className="board-pre-wrap">
        {e.fee_policy || "费用按双方已确认的实际约定处理。"}
      </Text>
      <Check
        form={f}
        name="accept_terms"
        label="已与参加者确认安排和费用约定"
        required
      />
    </Form>
  );
}
