import { useEffect, useState } from "react";
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Heading,
  Link,
  Popover,
  Surface,
  Text,
} from "yahha-ui";
import { errorMessage, errorStatus } from "../errors.ts";
import { dateFormat, eventStatus, shortDate, timeRange } from "./domain.ts";
import { MemberMusic } from "./MemberMusic.tsx";
import { ClaimsSection } from "./Identity.tsx";
import { ActivityAlerts, ActivityTools } from "./Management.tsx";
import { FinanceSection, RoomPlan, SettlementSection } from "./Money.tsx";
import {
  Advanced,
  Check,
  ErrorMessage,
  Field,
  Fold,
  Form,
  uid,
  useBoard,
  useForm,
  useModal,
} from "./primitives.tsx";
import { actionNames } from "./rules.ts";
import type * as D from "./types.ts";
export const personLabels: Record<string, string> = {
  confirmed: "正式",
  waiting: "候补",
  tentative: "待确认",
  invited: "待接受邀请",
  withdrawn: "已退出",
};
const attendanceLabels: Record<string, string> = {
  present: "到场",
  absent: "缺席",
  late: "迟到",
  left: "早退",
};
export function EventDetail({
  eventId,
  advanced = false,
}: D.ModalProps["detail"]) {
  const app = useBoard(),
    modal = useModal(),
    event = app.events.find((value) => value.id === eventId),
    f = useForm({ note: "" });
  useEffect(() => {
    if (event) modal.setTitle(event.title);
  }, [event?.title]);
  if (!event) return <Text>活动已无法访问，请刷新看板。</Text>;
  const e = event,
    [label, kind] = eventStatus(e),
    past = ["ended", "cancelled"].includes(e.lifecycle);
  const own = e.my_registration;
  const join = () =>
    app.withProfile(() =>
      f.run(async () => {
        try {
          const updated = await app.api<D.BoardEvent>(
            `/api/events/${e.id}/registration`,
            "PUT",
            {
              note: f.values.note,
              base_revision: e.revision,
              conditions_version: e.conditions_version,
            },
          );
          app.apply(updated);
          await app.refresh();
          app.toast(
            updated.my_registration?.status === "waiting"
              ? "已加入候补，有空位会自动递补"
              : "报名已保存",
          );
        } catch (error) {
          if (errorStatus(error) === 409)
            app.apply(await app.api<D.BoardEvent>("/api/events/" + e.id));
          throw error;
        }
      }),
    );
  const remove = () =>
    app.confirm(
      "删除这个活动？",
      "活动将从看板移除，原链接失效，未发送的通知会停止。已发到 QQ 群的消息不会撤回。",
      async () => {
        await app.api<D.BoardEvent>("/api/events/" + e.id, "PATCH", {
          status: "deleted",
          base_revision: e.revision,
        });
        modal.close();
        await app.refresh();
        app.toast("活动已删除");
      },
    );
  const finish = () =>
    app.confirm(
      "结束活动并结算？",
      "结束后将停止报名并移入往期，报名名单保留。",
      async () => {
        const updated = await app.api<D.BoardEvent>(
          "/api/events/" + e.id,
          "PATCH",
          {
            status: "finished",
            base_revision: e.revision,
          },
        );
        app.apply(updated);
        await app.refresh();
        if (updated.can_settle) app.open("settlement", { event: updated });
        else app.toast("活动已结束，由发起者填写结算");
      },
    );
  const summary = () =>
    app.copy(
      `${e.title}\n${timeRange(e)}\n地点：${e.location}\n${e.description ? e.description + "\n" : ""}${e.fee_policy ? "费用：" + e.fee_policy + "\n" : ""}报名截止：${dateFormat(e.deadline, e.timezone)}\n${e.conditions?.summary ? "本版变更：" + e.conditions.summary + "\n" : ""}${app.eventUrl(e)}`,
      "活动摘要",
    );
  return (
    <div id="detail-content" className="board-detail">
      <div className="detail-top">
        <div className="detail-meta">
          <Badge>{app.i18n.category(e.category)}</Badge>
          <Badge
            tone={
              kind === "waiting"
                ? "accent"
                : kind === "closed"
                  ? "neutral"
                  : "success"
            }
          >
            {label}
          </Badge>
        </div>
        <dl className="detail-facts">
          <dt>时间</dt>
          <dd>{timeRange(e)}</dd>
          <dt>地点</dt>
          <dd>
            {e.location}{" "}
            <Link
              external
              href={
                "https://uri.amap.com/search?keyword=" +
                encodeURIComponent(e.location)
              }
            >
              导航
            </Link>
          </dd>
        </dl>
        <Text size="sm" tone="muted">
          {shortDate(e.deadline, e.timezone)} 截止报名 · {e.owner_name} 发起
          {e.withdrawal_deadline !== e.deadline && (
            <>
              <br />
              {shortDate(e.withdrawal_deadline, e.timezone)} 后退出需申请
            </>
          )}
        </Text>
      </div>
      <div className="detail-main">
        <ActivityAlerts event={e} />
        <RoomPlan event={e} />
        <SettlementSection event={e} />
        {(e.finance?.has_records || (e.finance?.pending_count ?? 0) > 0) && (
          <FinanceSection event={e} />
        )}
        {!!e.description && (
          <section className="event-notes">
            <Heading level={3}>
              {e.category === "约K" ? "注意事项" : "活动说明"}
            </Heading>
            <Text className="board-pre-wrap">{e.description}</Text>
          </section>
        )}
        <People event={e} />
        {e.claim_invitations?.some(
          (claim) => claim.can_decide || claim.status === "requested",
        ) && <ClaimsSection event={e} />}
        <div className="detail-tools">
          {!!e.is_owner && !e.archived_at && (
            <Button
              variant="ghost"
              data-activity="appoint_settlement"
              onClick={() =>
                app.open("management", { event: e, settlement: true })
              }
            >
              指定结算人
            </Button>
          )}
          <Button
            variant="ghost"
            data-detail-action="share"
            onClick={() => f.run(() => app.copy(app.eventUrl(e)))}
          >
            复制活动链接
          </Button>
          {!!e.can_remove && (
            <Button
              variant="ghost"
              destructive
              data-detail-action="remove"
              onClick={remove}
            >
              删除活动
            </Button>
          )}
          {!!e.can_edit_schedule && (
            <Button
              variant="ghost"
              data-activity="edit"
              onClick={() => app.open("eventForm", { event: e })}
            >
              {e.can_assist_schedule ? "管理员协助编辑" : "编辑活动"}
            </Button>
          )}
          {!!e.is_owner && e.lifecycle === "draft" && (
            <Button
              variant="ghost"
              data-activity="publish"
              onClick={() =>
                app.open("activity", { event: e, action: "publish" })
              }
            >
              发布草稿
            </Button>
          )}
        </div>
      </div>
      <div className="join-panel">
        {e.my_attendees?.some(
          (person) =>
            !!person.can_respond && person.confirmation_state !== "accepted",
        ) && (
          <Button
            data-activity="conditions"
            onClick={() => app.open("conditions", { event: e })}
          >
            确认变更后的安排
          </Button>
        )}
        {e.lifecycle === "draft" ? (
          <Text>草稿尚未开放报名</Text>
        ) : past ? (
          e.can_settle ? (
            <Button
              data-detail-action="settle"
              onClick={() => app.open("settlement", { event: e })}
            >
              {e.settlement
                ? e.settlement.mode === "detailed"
                  ? "编辑结算"
                  : "核对并转逐人结算"
                : "填写结算"}
            </Button>
          ) : (
            <Text>
              {e.settlement
                ? "结算已公布"
                : e.lifecycle === "cancelled"
                  ? "活动已取消"
                  : "活动已结束"}
            </Text>
          )
        ) : (
          <>
            {own ? (
              <div className="joined-row">
                <Badge tone="accent">
                  {own.status === "confirmed"
                    ? "已报名"
                    : own.status === "waiting"
                      ? `候补第 ${own.waiting_position} 位`
                      : "待确认参加"}
                </Badge>
                {(own.can_change || own.can_withdraw) && (
                  <Button
                    variant="ghost"
                    data-roster-action="manage"
                    data-person={own.id}
                    onClick={() =>
                      app.open("attendee", { event: e, personId: own.id })
                    }
                  >
                    管理本人报名
                  </Button>
                )}
              </div>
            ) : e.can_join ? (
              <Form
                id="join-form"
                form={f}
                onSubmit={join}
                footer={
                  <Button type="submit">
                    {e.queue_blocked ||
                    (!!e.capacity && e.confirmed_count >= e.capacity)
                      ? "本人加入候补"
                      : "本人报名"}
                  </Button>
                }
              >
                <Fold title="备注与报名规则">
                  <Field
                    form={f}
                    name="note"
                    label="报名备注（活动内可见）"
                    maxLength={100}
                  />
                  <Text size="sm">
                    {e.fee_policy || "请先查看活动安排与注意事项。"} 退出期限：
                    {shortDate(e.withdrawal_deadline, e.timezone)}。
                  </Text>
                </Fold>
                <Text size="sm">
                  提交表示接受当前安排与费用规则{" "}
                  <Button
                    variant="ghost"
                    size="sm"
                    data-activity="conditions"
                    onClick={() => app.open("conditions", { event: e })}
                  >
                    查看
                  </Button>
                </Text>
              </Form>
            ) : (
              <Text>报名已截止</Text>
            )}
          </>
        )}
        {!!e.can_finish && (
          <Button
            variant="secondary"
            data-detail-action="finish"
            onClick={finish}
          >
            结束并结算
          </Button>
        )}
        <Advanced defaultOpen={advanced}>
          {!!e.can_join && (
            <div className="detail-tools">
              <Button
                variant="ghost"
                data-roster-action="add"
                onClick={() =>
                  app.withProfile(() => app.open("party", { event: e }))
                }
              >
                同行／代报名
              </Button>
              {!own && (
                <Button
                  variant="ghost"
                  data-roster-action="tentative"
                  onClick={() =>
                    app.withProfile(() =>
                      app.open("party", { event: e, tentative: true }),
                    )
                  }
                >
                  暂待确认
                </Button>
              )}
            </div>
          )}
          {!e.finance?.has_records && !e.finance?.pending_count && (
            <FinanceSection event={e} />
          )}
          {!e.claim_invitations?.some(
            (claim) => claim.can_decide || claim.status === "requested",
          ) && <ClaimsSection event={e} />}
          <div className="detail-tools">
            <Button
              variant="ghost"
              data-detail-action="summary"
              onClick={() => f.run(summary)}
            >
              复制活动摘要
            </Button>
            <Button
              variant="ghost"
              data-detail-action="copy"
              onClick={() =>
                app.withProfile(() =>
                  app.open("eventForm", { event: e, copy: true }),
                )
              }
            >
              复制为新活动
            </Button>
            <Button
              variant="ghost"
              data-roster-action="history"
              onClick={() => app.open("history", { event: e })}
            >
              活动记录
            </Button>
          </div>
          <ActivityTools event={e} />
        </Advanced>
      </div>
    </div>
  );
}
export function People({ event: e }: D.EventProps) {
  const [musicPerson, setMusicPerson] = useState<string | null>(null);
  const modal = useModal();
  const app = useBoard(),
    manage = (person: D.Person) =>
      app.open("attendee", { event: e, personId: person.id });
  return (
    <>
      {e.my_attendees?.some((person) => !person.is_me) && (
        <Fold title={`我的报名／同行 · ${e.my_attendees.length} 人`}>
          {e.my_attendees.map((person) => (
            <div key={person.id} className="board-person-summary">
              <Text>
                {person.nickname} · {personLabels[person.status]}
                {person.waiting_position
                  ? " · 候补 " + person.waiting_position
                  : ""}
                {person.payer_kind === "manager"
                  ? " · 由" +
                    (person.payer_name || person.manager_name) +
                    "统一付款"
                  : " · 本人付款"}
              </Text>
              {!!person.can_manage &&
                (person.can_change ||
                  person.can_withdraw ||
                  person.can_claim) && (
                  <Button variant="ghost" onClick={() => manage(person)}>
                    管理
                  </Button>
                )}
            </div>
          ))}
        </Fold>
      )}
      {["confirmed", "waiting", "tentative"].map((status) => {
        const people = (e.participants || []).filter(
          (person) => person.status === status,
        );
        return (
          people.length > 0 && (
            <section key={status}>
              <div className="detail-section-heading">
                <Heading level={3}>
                  {status === "confirmed"
                    ? e.can_attendance
                      ? "现场名单"
                      : "报名名单"
                    : personLabels[status]}
                </Heading>
                <Text size="sm">{people.length} 人</Text>
              </div>
              <ol className="participant-list">
                {people.map((person, index) => (
                  <li key={person.id} className={`participant ${status}`}>
                    <Text size="sm">
                      {status === "waiting" ? "候补 " : ""}
                      {index + 1}
                    </Text>
                    <div className="participant-text">
                      <div className="participant-heading">
                        <Popover
                          className="member-music-popover"
                          title={`${person.nickname}的成分`}
                          closeLabel="关闭成分卡"
                          side="right"
                          align="start"
                          open={musicPerson === person.id}
                          onOpenChange={(open) => setMusicPerson((current) =>
                            open ? person.id : current === person.id ? null : current)}
                          portalContainer={modal.id ? document.getElementById(modal.id) : undefined}
                          trigger={
                            <Button variant="ghost" className="participant-profile"
                              aria-label={`查看${person.nickname}的成分`}>
                              <Avatar src={person.avatar_url} name={person.nickname} size="sm" />
                              <span>{person.nickname}</span>
                            </Button>
                          }
                        >
                          {musicPerson === person.id && (
                            <MemberMusic eventId={e.id} personId={person.id} />
                          )}
                        </Popover>
                        {!!person.is_me && <Badge tone="accent">我</Badge>}
                        {attendanceLabels[person.attendance] && (
                          <Badge>{attendanceLabels[person.attendance]}</Badge>
                        )}
                      </div>
                      {person.payment_locked ? (
                        <Text size="sm">
                          保留原报名付款人：{person.payer_name}
                        </Text>
                      ) : (
                        !!person.is_guest && (
                          <Text size="sm">
                            {person.manager_name}代报 ·{" "}
                            {person.payer_kind === "manager"
                              ? "由" +
                                (person.payer_name || person.manager_name) +
                                "统一付款"
                              : "本人付款"}
                          </Text>
                        )
                      )}
                      {!!person.note && (
                        <Text size="sm" className="board-pre-wrap">
                          {person.note}
                        </Text>
                      )}
                      {person.confirmation_state === "pending" && (
                        <Text size="sm">新安排待确认</Text>
                      )}
                      {person.confirmation_state === "declined" && (
                        <Text size="sm">暂不同意新安排</Text>
                      )}
                      {!!person.withdrawal_requested && (
                        <Text size="sm">已申请退出，待发起者处理</Text>
                      )}
                    </div>
                    {!!person.can_manage &&
                      (person.can_change ||
                        person.can_withdraw ||
                        person.can_claim) && (
                        <Button
                          variant="ghost"
                          size="sm"
                          data-roster-action="manage"
                          data-person={person.id}
                          onClick={() => manage(person)}
                        >
                          管理
                        </Button>
                      )}
                  </li>
                ))}
              </ol>
            </section>
          )
        );
      })}
      {!e.participants?.length && <Text tone="muted">暂无报名</Text>}
      {!!e.pending_invitations?.length && (
        <Fold
          title={`待接受邀请 · ${e.pending_invitations.length} 人`}
          defaultOpen
        >
          {e.pending_invitations.map((person) => (
            <Surface key={person.id} variant="note">
              <Text>{person.nickname}</Text>
              <Button
                variant="ghost"
                onClick={() =>
                  app.copy(app.eventUrl(e, person.invitation_token))
                }
              >
                复制邀请
              </Button>
              <Button variant="ghost" onClick={() => manage(person)}>
                管理
              </Button>
            </Surface>
          ))}
        </Fold>
      )}
    </>
  );
}
export function PartyForm({
  event: e,
  tentative = false,
  invite = false,
}: D.ModalProps["party"]) {
  const app = useBoard(),
    modal = useModal(),
    f = useForm({
      include_self: tentative && !e.my_registration,
      intent: tentative ? "tentative" : "registered",
      queue_mode: "individual",
      reason: "",
      accept_partial: false,
      guests: tentative
        ? []
        : [
            {
              id: uid(),
              name: "",
              note: "",
              payer_kind: invite ? "self" : "manager",
            },
          ],
    }),
    [base, setBase] = useState(e),
    [preview, setPreview] = useState<D.PartyPreview | null>(null);
  useEffect(() => modal.setTitle(invite ? "邀请补报名" : "同行／代报名"), []);
  const v = f.values,
    updateGuest = (
      id: string,
      name: keyof (typeof v.guests)[number],
      value: string,
    ) =>
      f.patch((previous) => ({
        guests: previous.guests.map((person) =>
          person.id === id ? { ...person, [name]: value } : person,
        ),
      }));
  const fields = {
    ...f,
    set: ((name, value) => {
      f.set(name, value);
      if (name !== "accept_partial") setPreview(null);
    }) as typeof f.set,
  };
  const submit = () =>
    f.run(async () => {
      const people = [
        ...(!!v.include_self && !invite && !base.my_registration
          ? [{ is_self: true }]
          : []),
        ...v.guests.map((person) => ({
          name: person.name.trim(),
          note: person.note.trim(),
          payer_kind: person.payer_kind,
        })),
      ];
      if (!people.length) throw new Error("请勾选本人参加，或添加一位参加者");
      const data = {
        people,
        base_revision: base.revision,
        queue_mode: v.queue_mode,
        intent: v.intent,
        reason: v.reason.trim(),
      };
      try {
        if (invite) {
          const updated = await app.api<D.BoardEvent>(
            `/api/events/${base.id}/roster/invitations`,
            "POST",
            data,
          );
          modal.close();
          app.apply(updated);
          await app.refresh();
          app.toast("邀请已生成，请复制链接给受邀者");
          return;
        }
        if (!preview) {
          const at = f.revision.current,
            result = await app.api<D.PartyPreview>(
              `/api/events/${base.id}/roster/preview`,
              "POST",
              data,
            );
          if (f.revision.current === at) {
            setPreview(result);
          }
          return;
        }
        const updated = await app.api<D.BoardEvent>(
          `/api/events/${base.id}/roster/parties`,
          "POST",
          { ...data, ...preview, accept_partial: v.accept_partial },
        );
        modal.close();
        app.apply(updated);
        await app.refresh();
        app.toast("报名已保存");
      } catch (error) {
        if (errorStatus(error) === 409) {
          setPreview(null);
          setBase(await app.api<D.BoardEvent>("/api/events/" + base.id));
          throw new Error(errorMessage(error) + "；请核对最新规则后重新预览。");
        }
        throw error;
      }
    });
  const mixed =
    preview?.allocation.some((person) => person.status === "confirmed") &&
    preview.allocation.some((person) => person.status === "waiting");
  return (
    <Form
      id="party-form"
      form={f}
      onSubmit={submit}
      footer={
        <Button id="save-party" type="submit">
          {invite
            ? "生成邀请"
            : preview
              ? v.intent === "tentative"
                ? "保存待确认"
                : "确认报名"
              : "预览报名"}
        </Button>
      }
    >
      {!invite && !base.my_registration && (
        <Check form={fields} name="include_self" label="同时为我报名" />
      )}
      <div id="party-rows">
        {v.guests.map((person) => (
          <Surface variant="note" className="guest-row" key={person.id}>
            <Field
              form={{
                ...f,
                values: { guest_name: person.name },
                set: (_, value) => {
                  updateGuest(person.id, "name", value);
                  setPreview(null);
                },
              }}
              name="guest_name"
              label="参加者称呼"
              maxLength={24}
              required
              autoComplete="off"
            />
            <Button
              variant="ghost"
              size="sm"
              data-remove-guest
              aria-label="移除这位参加者"
              onClick={() => {
                f.patch({
                  guests: v.guests.filter((item) => item.id !== person.id),
                });
                setPreview(null);
              }}
            >
              移除
            </Button>
            <Fold title={invite ? "备注（选填）" : "备注与付款"}>
              <Field
                form={{
                  ...f,
                  values: { guest_note: person.note },
                  set: (_, value) => {
                    updateGuest(person.id, "note", value);
                    setPreview(null);
                  },
                }}
                name="guest_note"
                label="备注（选填）"
                maxLength={100}
              />
              {!invite && (
                <Field
                  form={{
                    ...f,
                    values: { guest_payer: person.payer_kind },
                    set: (_, value) => {
                      updateGuest(person.id, "payer_kind", value);
                      setPreview(null);
                    },
                  }}
                  name="guest_payer"
                  label="付款归属"
                  options={[
                    { value: "manager", label: "由我统一付款" },
                    { value: "self", label: "参加者自己付款" },
                  ]}
                />
              )}
            </Fold>
          </Surface>
        ))}
      </div>
      <Button
        id="add-guest"
        variant="ghost"
        disabled={v.guests.length >= 20}
        onClick={() => {
          f.patch({
            guests: [
              ...v.guests,
              {
                id: uid(),
                name: "",
                note: "",
                payer_kind: invite ? "self" : "manager",
              },
            ],
          });
          setPreview(null);
        }}
      >
        ＋ 添加参加者
      </Button>
      {!invite && (
        <>
          <Field
            form={fields}
            name="intent"
            label="参加意愿"
            options={[
              { value: "registered", label: "确定参加" },
              { value: "tentative", label: "待确认，不占名额" },
            ]}
          />
          <Field
            form={fields}
            name="queue_mode"
            label="多人排队方式"
            options={[
              { value: "individual", label: "可分开，接受部分人候补" },
              { value: "together", label: "必须一起参加，整组候补" },
            ]}
            help="后加的人员重新排队。整组候补名额不足时，后续人员不会自动超车。"
          />
        </>
      )}
      {invite && (
        <Field
          form={fields}
          name="reason"
          label="补报名原因"
          maxLength={200}
          required
          help="邀请不预留名额，需对方接受后才加入名单。"
        />
      )}
      {preview && (
        <div
          id="party-preview"
          className="allocation-preview"
          aria-live="polite"
        >
          {preview.allocation.map((person, index) => (
            <Text key={index}>
              {person.name} · {personLabels[person.status]}
            </Text>
          ))}
          {mixed && (
            <Check
              form={fields}
              name="accept_partial"
              label="接受部分人正式、部分人候补"
            />
          )}
        </div>
      )}
      <Text size="sm">
        {invite
          ? "对方接受邀请时自行确认安排与费用。"
          : (base.fee_policy || "请先查看活动安排与注意事项。") +
            " 提交表示已与本人及代报者确认当前安排与费用规则。"}
      </Text>
    </Form>
  );
}
export function AttendeeForm({ event: e, personId }: D.ModalProps["attendee"]) {
  const app = useBoard(),
    modal = useModal(),
    base = e,
    person = [
      ...(base.participants || []),
      ...(base.pending_invitations || []),
    ].find((item) => item.id === personId);
  const f = useForm({
    name: person?.nickname || "",
    note: person?.note || "",
    payer_kind: person?.payer_kind || "manager",
    reason: "",
  });
  useEffect(() => {
    if (person) modal.setTitle(person.nickname);
  }, [person?.nickname]);
  if (!person) return <Text>这位参加者已不在当前名单中，请重新核对。</Text>;
  const p = person,
    v = f.values;
  const act = (action: string) =>
    f.run(async () => {
      let path = `/api/events/${base.id}/attendees/${p.id}`;
      let method: D.ApiMethod = "PATCH";
      const data: {
        base_revision: number;
        reason: string;
        decision?: string;
        action?: string;
        name?: string;
        note?: string;
        payer_kind?: string;
      } = { base_revision: base.revision, reason: v.reason.trim() };
      if (action === "withdraw") method = "DELETE";
      else if (["approve", "reject"].includes(action)) {
        path += "/withdrawal";
        data.decision = action;
      } else if (action === "save")
        Object.assign(data, {
          name: v.name.trim(),
          note: v.note.trim(),
          payer_kind: v.payer_kind,
        });
      else data.action = action;
      try {
        const updated = await app.api<D.BoardEvent>(path, method, data);
        modal.close();
        app.apply(updated);
        await app.refresh();
        app.toast(
          action === "withdraw" &&
            !!p.needs_withdrawal_request &&
            p.managed_by_me
            ? "退出申请已提交"
            : "名单已更新",
        );
      } catch (error) {
        throw error;
      }
    });
  const claim = () =>
    app.confirm(
      "邀请本人认领？",
      "只把链接发给这位参加者。对方先申请，你再核对同意；原名额、排队与款项均保留。",
      async () => {
        const latest = await app.api<D.BoardEvent>("/api/events/" + base.id),
          updated = await app.api<D.BoardEvent>(
            `/api/events/${base.id}/claims`,
            "POST",
            {
              base_revision: latest.revision,
              attendee_id: p.id,
              reason: "管理人邀请本人核对认领",
            },
          );
        modal.close();
        app.apply(updated);
        await app.refresh();
        const claim = updated.claim_invitations.find(
          (item) => item.attendee_id === p.id && item.status === "invited",
        );
        if (claim)
          app.copy(
            location.origin + "/?event=" + base.id + "&claim=" + claim.token,
            "认领链接",
          );
      },
    );
  return (
    <Form
      id="attendee-form"
      form={f}
      onSubmit={() => act("save")}
      footer={
        <>
          {!!f.error && (
            <Button
              id="reload-attendee"
              variant="ghost"
              onClick={() =>
                f.run(async () => {
                  const latest = await app.api<D.BoardEvent>(
                    "/api/events/" + base.id,
                  );
                  app.apply(latest);
                  app.open("attendee", { event: latest, personId });
                })
              }
            >
              载入最新报名
            </Button>
          )}
          {!!p.can_change && p.status !== "invited" && (
            <Button id="save-attendee" type="submit">
              保存修改
            </Button>
          )}
          {!!p.can_change && p.status === "tentative" && (
            <Button
              id="confirm-attendee"
              variant="secondary"
              onClick={() => act("confirm")}
            >
              {p.queue_mode === "together" ? "确认整组参加" : "确认参加"}
            </Button>
          )}
          {!!p.can_change &&
            p.status === "waiting" &&
            p.queue_mode === "together" && (
              <Button
                id="split-attendee"
                variant="secondary"
                onClick={() => act("split")}
              >
                整组改为分开排队
              </Button>
            )}
          {!!base.can_manage_roster && !!p.withdrawal_requested && (
            <>
              <Button
                id="approve-withdrawal"
                variant="secondary"
                onClick={() => act("approve")}
              >
                同意退出
              </Button>
              <Button
                id="reject-withdrawal"
                variant="secondary"
                onClick={() => act("reject")}
              >
                拒绝退出
              </Button>
            </>
          )}
          {!!p.can_withdraw && !p.withdrawal_requested && (
            <Button
              id="withdraw-attendee"
              variant="ghost"
              destructive
              onClick={() => act("withdraw")}
            >
              {p.status === "invited"
                ? "撤销邀请"
                : !!p.needs_withdrawal_request && p.managed_by_me
                  ? "申请退出"
                  : "撤销这位报名"}
            </Button>
          )}
        </>
      }
    >
      <Text>
        {personLabels[p.status]}
        {p.withdrawal_requested ? " · 已申请退出" : ""}
      </Text>
      {!!p.payment_locked && (
        <Alert tone="info">
          原报名付款人：{p.payer_name}；已有账单以对应版本的付款分配为准。
        </Alert>
      )}
      {!!p.withdrawal_requested && <Text>退出原因：{p.withdrawal_reason}</Text>}
      {!!p.can_change && (
        <>
          {!!p.is_guest && (
            <Field
              form={f}
              name="name"
              label="参加者称呼"
              maxLength={24}
              required
            />
          )}
          <Field form={f} name="note" label="备注（选填）" maxLength={100} />
        </>
      )}
      <Field
        form={f}
        name="reason"
        label="操作原因（按需填写）"
        multiline
        rows={2}
        maxLength={200}
      />
      <Advanced>
        {!!p.can_claim && (
          <Button id="claim-attendee" variant="secondary" onClick={claim}>
            邀请本人认领
          </Button>
        )}
        {!!p.can_change && (
          <Field
            form={f}
            name="payer_kind"
            label="付款归属"
            disabled={!p.is_guest || !!p.payment_locked}
            options={[
              { value: "manager", label: "由代报者统一付款" },
              { value: "self", label: "参加者自己付款" },
            ]}
          />
        )}
        <Text size="sm">
          特殊操作需填写原因并保存记录；同行默认按人数分摊。
        </Text>
      </Advanced>
    </Form>
  );
}
export function InvitationForm({ eventId, token }: D.ModalProps["invitation"]) {
  const app = useBoard(),
    modal = useModal(),
    f = useForm({ accept_waiting: false }),
    [info, setInfo] = useState<D.InvitationInfo | null>(null);
  const load = async () =>
    setInfo(
      await app.api<D.InvitationInfo>(
        `/api/events/${eventId}/invitations/${token}`,
      ),
    );
  useEffect(() => {
    f.run(load);
  }, []);
  const submit = () =>
    app.withProfile(() =>
      f.run(async () => {
        if (!info) return;
        try {
          const updated = await app.api<D.BoardEvent>(
            `/api/events/${eventId}/invitations/${token}/accept`,
            "POST",
            {
              base_revision: info.base_revision,
              conditions_version: info.conditions.version,
              accept_waiting: f.values.accept_waiting,
            },
          );
          const url = new URL(location.href);
          url.searchParams.delete("attendee_invite");
          history.replaceState(null, "", url);
          modal.close();
          app.apply(updated);
          await app.openDetail(updated.id);
          await app.refresh();
          app.toast("邀请已接受");
        } catch (error) {
          if (errorStatus(error) === 409) await load();
          throw error;
        }
      }),
    );
  return (
    <Form
      id="accept-invitation-form"
      form={f}
      onSubmit={submit}
      footer={
        <Button id="accept-invitation-button" type="submit" disabled={!info}>
          接受为本人报名
        </Button>
      }
    >
      {info && (
        <>
          <Heading level={3}>
            {info.title} · {info.name}
          </Heading>
          <Text>
            {shortDate(info.starts_at, info.timezone)} · {info.location}
          </Text>
          <Text>
            {info.conditions.arrangement.fee_policy ||
              "活动未填写费用规则，请先与发起者确认。"}
          </Text>
          <Text className="board-pre-wrap">
            {info.conditions.arrangement.description}
          </Text>
          <Text size="sm">
            接受后以你的群内称呼为本人报名，由你管理及付款，并接受当前安排与费用规则；接受前不占名额。
          </Text>
          <Check
            form={f}
            name="accept_waiting"
            label="如果名额已满，我接受候补"
          />
        </>
      )}
    </Form>
  );
}
export function HistoryView({ event: e }: D.EventProps) {
  const app = useBoard(),
    f = useForm({}),
    [entries, setEntries] = useState<D.AuditEntry[]>([]),
    [before, setBefore] = useState<number | null>(null);
  const load = (cursor?: number | null) =>
    f.run(async () => {
      const result = await app.api<{
        entries: D.AuditEntry[];
        next_before: number | null;
      }>(`/api/events/${e.id}/history${cursor ? "?before=" + cursor : ""}`);
      setEntries((previous) =>
        cursor ? [...previous, ...result.entries] : result.entries,
      );
      setBefore(result.next_before);
    });
  useEffect(() => {
    load();
  }, []);
  const labels: Record<string, string> = {
    lifecycle: "活动阶段",
    registration_open: "报名开关",
    actual_started_at: "实际开始",
    actual_ended_at: "实际结束",
    archived_at: "归档时间",
    timezone: "活动时区",
    minimum_participants: "最低成团人数",
    formation_state: "成团状态",
    fee_policy: "费用规则",
    conditions_version: "安排版本",
    cancellation_reason: "取消原因",
    title: "标题",
    category: "类型",
    location: "地点",
    starts_at: "开始时间",
    deadline: "报名截止",
    capacity: "人数上限",
    description: "注意事项",
    duration_hours: "持续小时",
    status: "活动状态",
    withdrawal_deadline: "退出期限",
    visibility: "可见性",
  };
  const value = (key: string, v: unknown, zone?: string | null) =>
    v == null || v === ""
      ? "未设置"
      : key.endsWith("_at") ||
          ["starts_at", "deadline", "withdrawal_deadline"].includes(key)
        ? shortDate(String(v), zone)
        : key === "category"
          ? app.i18n.category(String(v))
          : typeof v === "boolean"
            ? v
              ? "是"
              : "否"
            : String(v);
  return (
    <>
      <ErrorMessage error={f.error} />
      {entries.map((entry) => {
        const prior = entry.before.event || entry.before,
          after = entry.after.event || entry.after;
        return (
          <Fold
            key={entry.id}
            title={`${entry.actor_name} · ${shortDate(entry.created_at)} · ${actionNames[entry.action] || "更新记录"}`}
          >
            <Text className="board-pre-wrap">{entry.reason}</Text>
            {(Object.keys(labels) as (keyof D.BoardEvent)[])
              .filter(
                (key) =>
                  key in after &&
                  JSON.stringify(prior[key]) !== JSON.stringify(after[key]),
              )
              .map((key) => (
                <Text key={key}>
                  {labels[key]}：{value(key, prior[key], prior.timezone)} →{" "}
                  {value(key, after[key], after.timezone)}
                </Text>
              ))}
            {entry.action.startsWith("finance_") && (
              <Text size="sm">金额、流向及冲销关系详见「收付款账本」。</Text>
            )}
            {entry.action === "settlement_saved" && (
              <Text size="sm">金额及收款码详见「结算记录」。</Text>
            )}
            {[entry.before, entry.after].map((data, index) => (
              <HistoryPeople
                key={index}
                data={data}
                label={index ? "变更后" : "变更前"}
              />
            ))}
          </Fold>
        );
      })}
      {!entries.length && !f.busy && (
        <Text tone="muted">暂无新增记录；旧报名已按原顺序保留。</Text>
      )}
      {before && (
        <Button variant="ghost" onClick={() => load(before)}>
          加载更早记录
        </Button>
      )}
    </>
  );
}
function HistoryPeople({ data, label }: { data: D.AuditData; label: string }) {
  const people =
    data.people || data.participants || (data.attendee ? [data.attendee] : []);
  const confirmations: Record<string, string> = {
    accepted: "已接受",
    declined: "暂不同意新安排",
    pending: "新安排待确认",
  };
  if (
    !people.length &&
    !data.nickname &&
    !data.owner_name &&
    !data.roles?.length &&
    !data.target_name
  )
    return null;
  return (
    <section>
      <Heading level={4}>{label}</Heading>
      {people.map((person, index) => (
        <Text size="sm" key={person.id || index}>
          {[
            person.nickname || person.name,
            personLabels[person.status] || person.status,
            person.note,
            person.withdrawal_requested && "申请退出",
            person.manager_name && person.manager_name + "管理",
            person.payer_kind === "manager" && "统一付款",
            person.payer_name && "付款人 " + person.payer_name,
            person.confirmation_state !== "accepted" &&
              confirmations[person.confirmation_state],
            attendanceLabels[person.attendance],
            person.attendance_note,
            person.arrived_at && "到场 " + shortDate(person.arrived_at),
            person.left_at && "离场 " + shortDate(person.left_at),
          ]
            .filter(Boolean)
            .join(" · ")}
        </Text>
      ))}
      {!!data.nickname && (
        <Text size="sm">
          {data.nickname} · {confirmations[data.confirmation || ""]}
          {data.accepted_version
            ? " · 保留已接受的第 " + data.accepted_version + " 版约定"
            : ""}
        </Text>
      )}
      {!!data.owner_name && <Text size="sm">发起者：{data.owner_name}</Text>}
      {data.roles?.map((role, index) => (
        <Text size="sm" key={index}>
          协办 {role.name} ·{" "}
          {role.permissions
            .map(
              (scope) =>
                ({
                  schedule: "修改安排",
                  roster: "管理报名",
                  attendance: "核对出席",
                  settlement: "发布结算",
                })[scope] || scope,
            )
            .join("、")}
        </Text>
      ))}
      {!!data.target_name && (
        <Text size="sm">
          {data.target_name} ·{" "}
          {data.kind === "transfer" ? "接任发起者" : "协办"}
        </Text>
      )}
    </section>
  );
}
