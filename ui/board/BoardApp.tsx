import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import {
  Avatar,
  Badge,
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  Heading,
  IconButton,
  Input,
  Link,
  SegmentedControl,
  Select,
  Spinner,
  Surface,
  Text,
  ThemeProvider,
  Toast,
} from "yahha-ui";
import { errorMessage } from "../errors.ts";
import {
  centsText,
  configureLocale,
  eventStatus,
  shortDate,
  timeRange,
} from "./domain.ts";
import { EventForm } from "./EventForm.tsx";
import {
  AccountView,
  ClaimView,
  DeviceView,
  PrivacyReceipt,
  ProfileForm,
  QQReminder,
  QQReturn,
} from "./Identity.tsx";
import {
  AcceptRole,
  ActivityAction,
  AttendanceForm,
  ConditionsForm,
  ManagementForm,
  OnsiteForm,
} from "./Management.tsx";
import {
  FinanceForm,
  FinanceView,
  RoomsForm,
  SettlementForm,
  SettlementHistory,
} from "./Money.tsx";
import { PollCard, PollDetail, PollForm } from "./Polls.tsx";
import {
  BoardContext,
  ErrorMessage,
  Field,
  Form,
  ModalContext,
  useBoard,
  useForm,
  useModal,
} from "./primitives.tsx";
import { markEventCreated } from "./recovery.ts";
import {
  AttendeeForm,
  EventDetail,
  HistoryView,
  InvitationForm,
  PartyForm,
} from "./Roster.tsx";
import { boardEntryPlan, boardTodos } from "./rules.ts";
import type * as D from "./types.ts";

const registry = {
  detail: ["detail-dialog", "活动详情", EventDetail],
  eventForm: ["event-form-dialog", "发起活动", EventForm],
  party: ["party-dialog", "同行／代报名", PartyForm],
  attendee: ["attendee-dialog", "管理报名", AttendeeForm],
  invitation: ["accept-invitation-dialog", "受邀报名", InvitationForm],
  history: ["activity-history-dialog", "活动记录", HistoryView],
  rooms: ["rooms-dialog", "预分包间", RoomsForm],
  settlement: ["invoice-dialog", "活动结算", SettlementForm],
  settlementHistory: [
    "settlement-history-dialog",
    "结算记录",
    SettlementHistory,
  ],
  finance: ["finance-dialog", "收付款账本", FinanceView],
  financeForm: ["finance-form-dialog", "登记款项", FinanceForm],
  activity: ["activity-action-dialog", "管理活动", ActivityAction],
  conditions: ["conditions-dialog", "活动安排确认", ConditionsForm],
  management: ["management-dialog", "协办与转交", ManagementForm],
  role: ["accept-role-dialog", "接受交接", AcceptRole],
  attendance: ["attendance-dialog", "出席管理", AttendanceForm],
  onsite: ["onsite-dialog", "现场补录", OnsiteForm],
  pollForm: ["time-poll-form-dialog", "发起时间投票", PollForm],
  poll: ["time-poll-dialog", "时间投票", PollDetail],
  profile: ["profile-dialog", "个人资料", ProfileForm],
  receipt: ["identity-dialog", "注销与资料删除", PrivacyReceipt],
  account: ["identity-dialog", "账号与设备", AccountView],
  qqReturn: ["identity-dialog", "QQ 登录", QQReturn],
  claim: ["identity-dialog", "认领我的报名", ClaimView],
  device: ["identity-dialog", "连接另一设备上的账号", DeviceView],
  qqReminder: ["qq-refresh-dialog", "更新 QQ 登录资料", QQReminder],
  notifications: ["notifications-dialog", "消息", Notifications],
  confirm: ["confirm-dialog", "确认操作", Confirm],
  draftClose: ["draft-close-dialog", "有尚未发布的修改", DraftClose],
  link: ["link-dialog", "复制链接", CopyFallback],
} as const satisfies {
  [K in D.ModalName]: readonly [
    string,
    string,
    React.ComponentType<D.ModalProps[K]>,
  ];
};
const mainTypes = new Set(["detail", "poll"]);
function ModalHost({
  entries,
  index = 0,
  app,
  portalRoot,
}: {
  entries: D.ModalEntry[];
  portalRoot?: HTMLElement;
  index?: number;
  app: D.BoardContextValue;
}) {
  const entry = entries[index],
    [container, setContainer] = useState<HTMLElement | null>(null),
    status = useRef<D.FormStatus>({});
  const [title, setTitle] = useState<string | null>(null);
  if (!entry) return null;
  const [id, defaultTitle, View] = registry[entry.type];
  // open() checks the matching props for each registry key; erase the union only at dispatch.
  const Component = View as React.ComponentType<D.ModalProps[D.ModalName]>;
  const modal = {
    id,
    entry,
    setTitle,
    register: (value: D.FormStatus) => {
      status.current = value;
      app.formStates.current.set(entry.key, value);
    },
    close: () => app.close(entry.key),
    requestClose: () => app.requestClose(entry.key),
  };
  const content = (
    <section id={id} data-react-dialog data-open="true" ref={setContainer}>
      {container && (
        <ModalContext.Provider value={modal}>
          <Dialog
            open
            title={
              title ||
              ("title" in entry.props ? entry.props.title : undefined) ||
              defaultTitle
            }
            closeLabel="关闭"
            className={`ui-dialog board-dialog ${entry.type === "detail" ? "board-detail-dialog" : ""}`}
            portalContainer={container}
            onOpenChange={(open) => {
              if (!open) modal.requestClose();
            }}
          >
            <Component key={entry.version} {...entry.props} />
            <ModalHost
              key={entries[index + 1]?.key || "end"}
              entries={entries}
              index={index + 1}
              app={app}
              portalRoot={portalRoot || container}
            />
          </Dialog>
        </ModalContext.Provider>
      )}
    </section>
  );
  // Keep React's nested dialog context, while avoiding transformed, scrolling popups as DOM ancestors.
  return portalRoot ? createPortal(content, portalRoot) : content;
}
export function BoardApp({ client, storage, i18n }: D.BoardServices) {
  const [me, setMe] = useState<D.Me>({
      authenticated: false,
      draft_scope: "",
      nickname: "",
      qq: {},
    }),
    [events, setEvents] = useState<D.BoardEvent[]>([]),
    [polls, setPolls] = useState<D.Poll[]>([]),
    [loaded, setLoaded] = useState(false),
    [loadError, setLoadError] = useState("");
  const [filter, setFilter] = useState("upcoming"),
    [search, setSearch] = useState(""),
    [category, setCategory] = useState("全部"),
    [archived, setArchived] = useState(false);
  const [modals, setModals] = useState<D.ModalEntry[]>([]),
    [message, setMessage] = useState(""),
    [unread, setUnread] = useState(0),
    [bootReady, setBootReady] = useState(false);
  const latest = useRef({ me, events, polls, modals });
  latest.current = { me, events, polls, modals };
  const formStates = useRef(new Map<string, D.FormStatus>()),
    refreshing = useRef<ReturnType<D.BoardContextValue["refresh"]> | null>(
      null,
    ),
    ignoringPop = useRef<false | { url: string }>(false),
    booted = useRef(false),
    reminded = useRef(new Set<string>());
  const api = client.request;
  const toast = useCallback((text: string) => setMessage(text), []);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(""), 3500);
    return () => clearTimeout(timer);
  }, [message]);
  const setURL = (type: string, id: string | null, replace = false) => {
    const url = new URL(location.href);
    url.searchParams.delete(type === "poll" ? "event" : "poll");
    if (id) url.searchParams.set(type === "poll" ? "poll" : "event", id);
    else url.searchParams.delete(type === "poll" ? "poll" : "event");
    if (url.href !== location.href)
      history[replace ? "replaceState" : "pushState"](null, "", url);
  };
  const open: D.OpenModal = useCallback(
    (
      type: D.ModalName,
      props: D.ModalProps[D.ModalName] = {},
      options: { historyless?: boolean } = {},
    ) => {
      const existing = latest.current.modals.find(
        (value) => registry[value.type][0] === registry[type][0],
      );
      const entry: D.ModalEntry = {
        type,
        props,
        key: existing?.key || crypto.randomUUID(),
        version: crypto.randomUUID(),
      };
      const previous = latest.current.modals;
      const found = previous.findIndex((value) => value.key === entry.key);
      const removed = found >= 0 ? previous.slice(found + 1) : [];
      removed.forEach((value) => formStates.current.delete(value.key));
      const next =
        found >= 0
          ? [...previous.slice(0, found), entry]
          : [...previous, entry];
      latest.current.modals = next;
      setModals(next);
      if (removed.some((value) => value.key === history.state?.kanbanDialog)) {
        ignoringPop.current = { url: location.href };
        history.go(
          -removed.filter((value) => !mainTypes.has(value.type)).length,
        );
      }
      if (!existing && !mainTypes.has(type) && !options.historyless)
        history.pushState({ kanbanDialog: entry.key }, "", location.href);
      return entry.key;
    },
    [],
  );
  const close = useCallback((key?: string, fromHistory = false) => {
    const stack = latest.current.modals,
      index = key
        ? stack.findIndex((value) => value.key === key)
        : stack.length - 1;
    if (index < 0) return;
    const entry = stack[index],
      removed = stack.slice(index);
    latest.current.modals = stack.slice(0, index);
    setModals(latest.current.modals);
    removed.forEach((value) => formStates.current.delete(value.key));
    if (
      !fromHistory &&
      removed.some((value) => value.key === history.state?.kanbanDialog)
    ) {
      // Closing a parent also removes its confirmation layer from browser history.
      const count = removed.filter(
        (value) => !mainTypes.has(value.type),
      ).length;
      const url = new URL(location.href);
      if (mainTypes.has(entry.type))
        url.searchParams.delete(entry.type === "poll" ? "poll" : "event");
      ignoringPop.current = { url: url.href };
      history.go(-count);
    } else if (mainTypes.has(entry.type) && !fromHistory)
      setURL(entry.type, null);
  }, []);
  const requestClose = useCallback(
    (key: string, fromHistory = false) => {
      const status = formStates.current.get(key);
      if (status?.busy) {
        toast("正在提交，请稍候");
        return false;
      }
      if (status?.dirty) {
        open("draftClose", { target: key, status });
        return false;
      }
      close(key, fromHistory);
      return true;
    },
    [close, open, toast],
  );
  const apply = useCallback((event: D.BoardEvent) => {
    setEvents((previous) =>
      previous.some((item) => item.id === event.id)
        ? previous.map((item) => (item.id === event.id ? event : item))
        : [...previous, event],
    );
  }, []);
  const refreshNotifications = async () => {
    try {
      const [result, operations] = await Promise.all([
        api<{ notifications: D.Notice[]; unread_count: number }>(
          "/api/notifications",
        ),
        client.pending(),
      ]);
      setUnread(
        result.unread_count +
          operations.length +
          boardTodos(latest.current.events).length,
      );
    } catch {}
  };
  const refresh = useCallback(async ({ loud = false } = {}) => {
    if (refreshing.current) return refreshing.current;
    refreshing.current = (async () => {
      try {
        const result = await api<{
          events: D.BoardEvent[];
          time_polls?: D.Poll[];
        }>("/api/events");
        setEvents(result.events);
        setPolls(result.time_polls || []);
        setLoaded(true);
        setLoadError("");
        await refreshNotifications();
        if (loud) toast("活动已更新");
        return result;
      } catch (error) {
        setLoadError(errorMessage(error) + "，请刷新重试。");
        return null;
      } finally {
        refreshing.current = null;
      }
    })();
    return refreshing.current;
  }, []);
  const updateMe = useCallback((value: D.Me) => {
    setMe(value);
    client.setIdentity(value.draft_scope);
  }, []);
  const openDetail = async (id: string, changeURL = true) => {
    try {
      const event = await api<D.BoardEvent>("/api/events/" + id);
      apply(event);
      open("detail", { eventId: id, title: event.title });
      if (changeURL) setURL("detail", id);
      return event;
    } catch (error) {
      toast(errorMessage(error));
      return null;
    }
  };
  const openPoll = async (id: string, changeURL = true) => {
    try {
      const poll = await api<D.Poll>("/api/time-polls/" + id);
      setPolls((previous) =>
        previous.some((item) => item.id === id)
          ? previous.map((item) => (item.id === id ? poll : item))
          : [...previous, poll],
      );
      open("poll", { pollId: id, title: poll.title });
      if (changeURL) setURL("poll", id);
      return poll;
    } catch (error) {
      toast(errorMessage(error));
    }
  };
  const withProfile = (task: () => unknown) => {
    if (!latest.current.me.authenticated) return open("account");
    if (!latest.current.me.nickname) return open("profile", { next: task });
    return task();
  };
  const eventUrl = (event: D.BoardEvent, participantToken?: string) => {
    const url = new URL("/?event=" + event.id, location.origin);
    let invite = event.share_token;
    try {
      invite ||= sessionStorage.getItem("kanban-invite-" + event.id);
    } catch {}
    if (event.visibility === "invitation" && !participantToken) {
      if (!invite) throw new Error("请向发起者索取可转发的邀请链接");
      url.searchParams.set("invite", invite);
    }
    if (participantToken)
      url.searchParams.set("attendee_invite", participantToken);
    return url.href;
  };
  const copy = async (text: string, label = "链接") => {
    try {
      await navigator.clipboard.writeText(text);
      toast(label + "已复制");
    } catch {
      open("link", { text, title: "手动复制" + label });
    }
  };
  const confirm = (
    title: string,
    text: string,
    action: () => unknown,
    labels: { confirm?: string; cancel?: string } = {},
  ) => open("confirm", { title, text, action, ...labels });
  const app: D.BoardContextValue = {
    api,
    client,
    storage,
    i18n,
    me,
    updateMe,
    events,
    polls,
    setPolls,
    apply,
    refresh,
    toast,
    open,
    close,
    requestClose,
    openDetail,
    openPoll,
    withProfile,
    eventUrl,
    copy,
    confirm,
    formStates,
    setFilter,
    modals,
  };
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      const dirty = [...formStates.current.values()].filter(
        (value) => value.dirty,
      );
      if (dirty.length) {
        dirty.forEach((value) => value.save?.().catch(() => {}));
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const visible = () => {
      if (document.visibilityState === "visible") refresh();
      else
        [...formStates.current.values()]
          .filter((value) => value.dirty)
          .forEach((value) => value.save?.().catch(() => {}));
    };
    const pop = () => {
      if (ignoringPop.current) {
        const pending = ignoringPop.current;
        ignoringPop.current = false;
        if (pending.url) history.replaceState(history.state, "", pending.url);
        return;
      }
      const top = latest.current.modals.at(-1);
      if (top && !mainTypes.has(top.type)) {
        const status = formStates.current.get(top.key);
        if (status?.dirty || status?.busy)
          history.pushState({ kanbanDialog: top.key }, "", location.href);
        requestClose(top.key, true);
        return;
      }
      const query = new URL(location.href).searchParams,
        pollId = query.get("poll"),
        eventId = query.get("event");
      setModals([]);
      if (pollId) openPoll(pollId, false);
      else if (eventId) openDetail(eventId, false);
    };
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("popstate", pop);
    document.addEventListener("visibilitychange", visible);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 30000);
    return () => {
      clearInterval(timer);
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("popstate", pop);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    (async () => {
      let account;
      try {
        account = await api<D.Me>("/api/me");
        updateMe(account);
      } catch (error) {
        toast(errorMessage(error));
      }
      const params = new URL(location.href).searchParams,
        id = params.get("event"),
        invite = params.get("invite"),
        accountLink = params.get("account_link"),
        claim = params.get("claim"),
        managementInvite = params.get("management_invite"),
        attendeeInvite = params.get("attendee_invite"),
        pollId = params.get("poll");
      if (id && invite && !!account?.authenticated)
        try {
          await api<D.BoardEvent>(`/api/events/${id}/access`, "POST", {
            invite_token: invite,
          });
          sessionStorage.setItem("kanban-invite-" + id, invite);
        } catch (error) {
          toast(errorMessage(error));
        }
      await refresh();
      if (params.get("qq") === "return") open("qqReturn");
      else if (accountLink && !!account?.authenticated)
        open("device", { token: accountLink });
      else if (id && claim && !!account?.authenticated)
        open("claim", { eventId: id, token: claim });
      else if (id && managementInvite)
        open("role", { eventId: id, token: managementInvite });
      else if (id && attendeeInvite)
        open("invitation", {
          eventId: id,
          token: attendeeInvite,
        });
      else if (params.has("action")) {
        const action = params.get("action") || "",
          event = id ? await openDetail(id, false) : null,
          plan = boardEntryPlan(action, event, !!account?.authenticated);
        if (plan.kind === "login") open("account");
        else if (
          plan.kind === "denied" ||
          plan.kind === "missing" ||
          plan.kind === "unknown"
        )
          toast("当前身份或活动阶段不允许此操作，请在活动页核对权限");
        else if (action === "create") open("eventForm");
        else if (action === "mine") setFilter("mine");
        else if (action === "todos") open("notifications");
        else if (event) {
          if (action === "manage")
            open("detail", {
              eventId: event.id,
              title: event.title,
              advanced: true,
            });
          else if (action === "party") open("party", { event });
          else if (action === "tentative")
            open("party", { event, tentative: true });
          else if (action === "invite") open("party", { event, invite: true });
          else if (action === "conditions") open("conditions", { event });
          else if (action === "management") open("management", { event });
          else if (action === "attendance") open("attendance", { event });
          else if (action === "onsite") open("onsite", { event });
          else if (action === "copy") open("eventForm", { event, copy: true });
          else if (action === "finance") open("finance", { event });
          else if (action === "report")
            open("finance", { event, report: true });
          else if (action === "withdraw") {
            const mine = event.my_attendees.filter(
              (person) =>
                !!person.can_manage &&
                (person.can_change || person.can_withdraw),
            );
            if (mine.length === 1)
              open("attendee", { event, personId: mine[0].id });
            else toast("请从我的报名／同行选择要管理的人员");
          } else if (action === "join")
            toast("请先查看安排，再在页面提交报名；目前尚未占位");
          else if (action === "claim") toast("请联系原管理人获取本人认领链接");
        }
        if (plan.kind !== "login") {
          const url = new URL(location.href);
          url.searchParams.delete("action");
          history.replaceState(history.state, "", url);
        }
      } else if (pollId) await openPoll(pollId, false);
      else if (id) await openDetail(id, false);
      try {
        const receipt = JSON.parse(
          sessionStorage.getItem("kanban-privacy-receipt") || "null",
        );
        sessionStorage.removeItem("kanban-privacy-receipt");
        if (receipt?.request_id) open("receipt", { receipt });
        const authorized = sessionStorage.getItem("kanban-qq-authorized");
        sessionStorage.removeItem("kanban-qq-authorized");
        if (authorized && account?.authenticated && account.qq?.bound) {
          if (account.qq.needs_reauth) {
            localStorage.setItem(
              "kanban-qq-reauth-v1:" + account.draft_scope,
              String(Date.now()),
            );
            toast("QQ 资料未补齐，bot 仍无法识别账号。可在账号与设备重试。");
          } else if (authorized === "refresh") toast("QQ 登录资料已更新。");
        }
        sessionStorage.removeItem("kanban-welcome");
      } catch {}
      setBootReady(true);
    })();
  }, []);
  useEffect(() => {
    if (
      !bootReady ||
      modals.length ||
      !me.authenticated ||
      !me.qq?.enabled ||
      !me.qq.bound ||
      !me.qq.needs_reauth ||
      !me.draft_scope ||
      reminded.current.has(me.draft_scope)
    )
      return;
    try {
      const stamp = Number(
        localStorage.getItem("kanban-qq-reauth-v1:" + me.draft_scope),
      );
      if (stamp > 0 && Date.now() - stamp < 86400000) return;
    } catch {}
    reminded.current.add(me.draft_scope);
    open("qqReminder");
  }, [bootReady, modals.length, me]);
  const upcoming = events.filter(
    (event) =>
      !["ended", "cancelled", "draft"].includes(event.lifecycle) &&
      !event.archived_at &&
      !event.estimated_over,
  );
  const matches = (
    event: Pick<
      D.BoardEvent,
      "category" | "title" | "location" | "description" | "owner_name"
    >,
  ) =>
    (category === "全部" || event.category === category) &&
    (!search ||
      `${event.title} ${event.location} ${event.description} ${event.owner_name}`
        .toLowerCase()
        .includes(search.toLowerCase()));
  const list = events.filter(
    (event) =>
      matches(event) &&
      (filter === "upcoming"
        ? upcoming.includes(event)
        : filter === "past"
          ? ["ended", "cancelled"].includes(event.lifecycle) &&
            (!event.archived_at || archived)
          : event.my_attendees?.length ||
            event.is_owner ||
            event.is_cohost ||
            event.finance?.my_balance_cents != null),
  );
  if (filter === "past") list.reverse();
  const shownPolls = polls.filter(
    (poll) =>
      poll.status !== "deleted" &&
      matches(poll) &&
      (filter === "upcoming"
        ? ["open", "closed"].includes(poll.status)
        : filter === "mine"
          ? poll.is_owner || poll.has_voted
          : ["finalized", "cancelled"].includes(poll.status)),
  );
  return (
    <BoardContext.Provider value={app}>
      <ThemeProvider theme="pink" className="ui-root react-board">
        <header className="site-header">
          <div className="header-inner">
            <h1>
              <Link href="/" aria-label="群聚看板首页">
                群聚看板
              </Link>
              <Badge id="event-count" aria-label="近期活动数">
                {upcoming.length}
              </Badge>
            </h1>
            <Link className="site-switch" href="/music/" aria-label="成分站">
              <span aria-hidden="true">♫</span><span>成分站</span>
            </Link>
            <IconButton
              id="notifications-button"
              variant="ghost"
              aria-label={unread ? `${unread} 项待办或未读消息` : "消息"}
              onClick={() => open("notifications")}
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                aria-hidden="true"
              >
                <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
              </svg>
              {unread > 0 && (
                <Badge id="notification-count">
                  {unread > 99 ? "99+" : unread}
                </Badge>
              )}
            </IconButton>
            <Button
              id="profile-button"
              variant="ghost"
              onClick={() =>
                me.authenticated ? open("profile") : open("account")
              }
            >
              {!!me.qq?.bound && (
                <Avatar
                  size="sm"
                  src={me.qq.avatar_url || undefined}
                  name={me.nickname}
                />
              )}
              <span id="my-name">
                {me.authenticated ? me.nickname || "设置称呼" : "登录"}
              </span>
            </Button>
            <Button
              id="create-button"
              appearance="soft"
              onClick={() => withProfile(() => open("eventForm"))}
            >
              发起活动
            </Button>
          </div>
        </header>
        <main className="page">
          <Surface
            className="home-account board-account"
            aria-label="QQ登录与账号"
          >
            <div>
              <Heading level={2} id="home-account-title">
                {me.authenticated ? "我的账号" : "QQ 登录"}
              </Heading>
              {!!me.qq?.bound && (
                <div className="qq-profile">
                  <Avatar
                    size="md"
                    src={me.qq.avatar_url || undefined}
                    name={me.qq.nickname || me.nickname}
                  />
                  <Text id="home-qq-name">QQ：{me.qq.nickname}</Text>
                </div>
              )}
              <Text size="sm" id="home-qq-status">
                {me.authenticated
                  ? me.qq?.needs_reauth
                    ? "QQ 资料待更新，bot 暂时无法识别账号。"
                    : "已登录，可在个人资料中修改称呼。"
                  : "登录后即可发起活动和报名。"}
              </Text>
            </div>
            <Button
              id="home-qq-button"
              variant="secondary"
              data-identity="account"
              onClick={() => open("account")}
            >
              {me.authenticated ? "账号与设备" : "QQ 登录"}
            </Button>
          </Surface>
          <section className="board-section" aria-label="活动列表">
            <div className="toolbar">
              <SegmentedControl
                label="筛选活动"
                className="board-filters"
                value={filter}
                onValueChange={setFilter}
                options={[
                  { value: "upcoming", label: "近期活动" },
                  { value: "mine", label: "我参与的" },
                  { value: "past", label: "往期" },
                ]}
              />
              <Button
                variant="ghost"
                id="refresh-button"
                aria-label="刷新活动"
                onClick={() => refresh({ loud: true })}
              >
                刷新
              </Button>
            </div>
            <div className="filters">
              <Input
                id="search"
                type="search"
                label={null}
                placeholder="搜索活动"
                aria-label="搜索活动"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <Select
                id="category-filter"
                label={null}
                aria-label="活动类型"
                value={category}
                onValueChange={(value) => setCategory(value ?? "全部")}
                options={[
                  "全部",
                  "约K",
                  "聚餐",
                  "运动",
                  "出游",
                  "游戏",
                  "其他",
                ].map((value) => ({
                  value,
                  label: value === "全部" ? "全部类型" : i18n.category(value),
                }))}
              />
              {filter === "past" && (
                <Checkbox
                  id="include-archived"
                  label="含已归档"
                  checked={archived}
                  onChange={(event) => setArchived(event.target.checked)}
                />
              )}
            </div>
            <div className="poll-invite">
              <Button
                variant="secondary"
                data-poll-action="create"
                onClick={() => withProfile(() => open("pollForm"))}
              >
                发起时间投票
              </Button>
            </div>
            <ErrorMessage id="load-error" error={loadError} />
            <div className="board" id="board">
              {!loaded && !loadError ? (
                <Spinner label="加载活动" />
              ) : (
                list.map((event) => <EventCard key={event.id} event={event} />)
              )}
              {loaded && !list.length && !shownPolls.length && (
                <EmptyState
                  title={
                    search || category !== "全部"
                      ? "没有符合条件的活动"
                      : filter === "mine"
                        ? "暂无参与的活动"
                        : filter === "past"
                          ? "暂无往期活动"
                          : "暂无活动"
                  }
                  action={
                    filter === "mine" && (
                      <Button
                        variant="secondary"
                        onClick={() => setFilter("upcoming")}
                      >
                        查看活动
                      </Button>
                    )
                  }
                />
              )}
            </div>
            <div id="time-poll-board" className="board">
              {shownPolls.map((poll) => (
                <PollCard key={poll.id} poll={poll} />
              ))}
            </div>
          </section>
          <footer className="site-footer">
            <Link href="/guide.html">使用说明</Link>
            <Link href="/privacy">隐私政策</Link>
            <Link href="/contact">联系运营者</Link>
            <Link href="/admin">管理</Link>
            <Link href="https://beian.miit.gov.cn/" external translate="no" className="footer-filing">
              渝ICP备16002872号-1
            </Link>
            <span className="footer-author">
              由{" "}
              <Link href="https://danndann.cn" external translate="no">
                飯糰
              </Link>{" "}
              制作
            </span>
          </footer>
        </main>
        <ModalHost key={modals[0]?.key || "empty"} entries={modals} app={app} />
        {message && (
          <Toast
            className="board-toast"
            open
            onClose={() => setMessage("")}
            title={<span id="toast">{message}</span>}
          />
        )}
      </ThemeProvider>
    </BoardContext.Provider>
  );
}
function EventCard({ event: e }: D.EventProps) {
  const app = useBoard(),
    [label, kind] = eventStatus(e),
    f = e.finance;
  const mine = f?.detailed
    ? f.state === "closed"
      ? "已结清"
      : f.my_outstanding_cents != null && f.my_outstanding_cents > 0
        ? "待补 ¥" + centsText(f.my_outstanding_cents)
        : f.my_refund_due_cents != null && f.my_refund_due_cents > 0
          ? "应退 ¥" + centsText(f.my_refund_due_cents)
          : "已对平"
    : e.settlement
      ? e.settlement.mode === "detailed"
        ? e.my_payable_cents != null
          ? "我应付 ¥" + centsText(e.my_payable_cents)
          : "已公布结算"
        : `每人 ¥${e.settlement.per_person_amount}`
      : e.my_registration
        ? e.my_registration.status === "waiting"
          ? "候补中"
          : e.my_registration.status === "tentative"
            ? "待确认"
            : "已报名"
        : e.my_attendees?.length
          ? `代报 ${e.my_attendees.length} 人`
          : e.is_owner
            ? "我发起的"
            : e.is_cohost
              ? "我协办的"
              : "";
  return (
    <Link
      className="event-card"
      href={"/?event=" + e.id}
      data-event={e.id}
      aria-label={`${e.title}，${label}`}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
          return;
        event.preventDefault();
        app.openDetail(e.id);
      }}
    >
      <Surface className="ui-paper board-event-paper">
        <div className="card-heading">
          <Heading level={3} className="card-title">
            {e.title}
          </Heading>
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
        <div className="card-facts">
          <Text size="sm">{timeRange(e)}</Text>
          <Text size="sm" className="card-location">
            {e.location}
          </Text>
        </div>
        <div className="card-bottom">
          <Text size="sm" className="capacity">
            {e.capacity
              ? `${e.confirmed_count}/${e.capacity} 人`
              : `${e.confirmed_count} 人报名`}
          </Text>
          {e.waiting_count > 0 && <Text size="sm">候补 {e.waiting_count}</Text>}
          {mine && (
            <Text size="sm" className="my-state">
              {mine}
            </Text>
          )}
          <span aria-hidden="true">›</span>
        </div>
      </Surface>
    </Link>
  );
}
function Confirm({
  text,
  action,
  confirm = "确认",
  cancel = "返回",
}: D.ModalProps["confirm"]) {
  const app = useBoard(),
    modal = useModal(),
    f = useForm({});
  return (
    <Form
      form={f}
      onSubmit={() =>
        f.run(async () => {
          await action?.();
          modal.close();
        })
      }
      footer={
        <>
          <Button
            variant="secondary"
            id="confirm-cancel"
            onClick={() => app.close()}
          >
            {cancel}
          </Button>
          <Button id="confirm-action" type="submit">
            {confirm}
          </Button>
        </>
      }
    >
      <Text className="board-pre-wrap">{text}</Text>
    </Form>
  );
}
function DraftClose({ target, status }: D.ModalProps["draftClose"]) {
  const app = useBoard(),
    f = useForm({});
  return (
    <Form
      form={f}
      footer={
        <>
          <Button
            id="draft-save-close"
            onClick={() =>
              f.run(async () => {
                if (status.choice) throw new Error("请先恢复或舍弃旧草稿");
                if (!status.save) throw new Error("Draft unavailable");
                await status.save();
                app.close(target);
              })
            }
          >
            暂存并关闭
          </Button>
          <Button
            id="draft-discard-close"
            variant="ghost"
            destructive
            onClick={() =>
              f.run(async () => {
                if (!status.discard) throw new Error("Draft unavailable");
                await status.discard();
                app.close(target);
              })
            }
          >
            舍弃修改并关闭
          </Button>
        </>
      }
    >
      <Text>暂存仅保存在当前浏览器，换设备无法恢复。</Text>
    </Form>
  );
}
function CopyFallback({ text }: D.ModalProps["link"]) {
  const f = useForm({ link: text });
  return (
    <Field form={f} name="link" label="分享链接" multiline rows={6} readOnly />
  );
}
function Notifications() {
  const app = useBoard(),
    f = useForm({}),
    [notifications, setNotifications] = useState<D.Notice[]>([]),
    [operations, setOperations] = useState<D.PendingOperation[]>([]),
    [results, setResults] = useState<
      Record<string, { done: boolean; message: string }>
    >({});
  const todos = boardTodos(app.events);
  useEffect(() => {
    f.run(async () => {
      const [response, operations] = await Promise.all([
        app.api<{ notifications: D.Notice[]; unread_count: number }>(
          "/api/notifications",
        ),
        app.client.pending(),
      ]);
      setNotifications(response.notifications);
      setOperations(operations);
      const ids = response.notifications
        .filter((item) => !item.read_at)
        .map((item) => item.id);
      if (ids.length)
        await app.api<{ notifications: D.Notice[]; unread_count: number }>(
          "/api/notifications/read",
          "POST",
          { ids },
        );
    });
  }, []);
  const go = async (eventId: string, kind?: string) => {
    app.close();
    const event = await app.openDetail(eventId);
    if (
      event &&
      (kind === "finance" || kind === "settle" || kind === "conditions")
    )
      app.open(kind === "settle" ? "settlement" : kind, { event });
  };
  return (
    <>
      <ErrorMessage error={f.error} />
      {operations.length > 0 && (
        <section>
          <Heading level={3}>待确认操作</Heading>
          {operations.map((operation) => (
            <Surface variant="note" key={operation.key}>
              <Text>{operation.path}</Text>
              <Text>{results[operation.key]?.message}</Text>
              {!results[operation.key]?.done && (
                <Button
                  variant="ghost"
                  onClick={() =>
                    f.run(async () => {
                      const result = await app.client.recover(
                        operation.key,
                        !!results[operation.key],
                      );
                      setResults((previous) => ({
                        ...previous,
                        [operation.key]: {
                          done: result.committed,
                          message: result.committed
                            ? "原操作已成功，请以最新活动／账本为准。"
                            : "服务器尚未提交；可按原内容、原版本安全重试。",
                        },
                      }));
                      if (result.committed) {
                        if (
                          operation.path === "/api/events" &&
                          operation.data.client_intent
                        )
                          await markEventCreated(
                            app.storage,
                            app.me.draft_scope,
                            operation.data.client_intent,
                            result.result,
                          );
                        await app.refresh();
                      }
                    })
                  }
                >
                  {results[operation.key]
                    ? "原结果未提交，安全重试"
                    : "查询原结果"}
                </Button>
              )}
            </Surface>
          ))}
        </section>
      )}
      {todos.length > 0 && (
        <section>
          <Heading level={3}>待办</Heading>
          {todos.map((todo, index) => (
            <Button
              key={index}
              className="notification-entry"
              variant="ghost"
              onClick={() => go(todo.eventId, todo.kind)}
            >
              {todo.title} · {todo.label}
            </Button>
          ))}
        </section>
      )}
      <Heading level={3}>通知</Heading>
      {notifications.map((item) => (
        <Button
          key={item.id}
          className="notification-entry"
          variant="ghost"
          onClick={() => go(item.event_id)}
        >
          {item.message}
          <time>{shortDate(item.created_at)}</time>
        </Button>
      ))}
      {!notifications.length && <Text tone="muted">暂无消息</Text>}
    </>
  );
}
export function mountBoard(services: D.BoardServices) {
  configureLocale(services.i18n);
  createRoot(document.getElementById("board-root")!).render(
    <BoardApp {...services} />,
  );
}
