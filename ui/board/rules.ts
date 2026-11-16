import type { BoardEvent, SettlementItem } from "./types.ts";
function boardTodos(events: BoardEvent[]) {
  const rows: {
    eventId: string;
    title: string;
    label: string;
    kind: string;
  }[] = [];
  const add = (e: BoardEvent, label: string, kind = "detail") =>
    rows.push({ eventId: e.id, title: e.title, label, kind });
  for (const e of events) {
    const active =
      !["ended", "cancelled", "draft"].includes(e.lifecycle) && !e.archived_at;
    if (
      e.my_attendees?.some(
        (p) => p.can_respond && p.confirmation_state !== "accepted",
      )
    )
      add(e, "确认变更后的安排", "conditions");
    if (e.claim_invitations?.some((c) => c.can_decide)) add(e, "核对报名认领");
    if (
      e.can_manage_roster &&
      e.participants?.some((p) => p.withdrawal_requested)
    )
      add(e, "处理退出申请");
    if (
      active &&
      e.is_owner &&
      e.minimum_participants &&
      e.formation_state !== "confirmed" &&
      (e.minimum_met || new Date(e.deadline) <= new Date())
    )
      add(e, "决定是否成团");
    if (e.can_finish && e.estimated_over) add(e, "确认活动结束／延长");
    if (e.can_settle && !e.settlement && !e.archived_at)
      add(e, "核对并发布结算", "settle");
    if (e.finance?.can_manage && e.finance.pending_count)
      add(e, `${e.finance.pending_count} 笔款项申报待核对`, "finance");
    if ((e.finance?.my_outstanding_cents ?? 0) > 0)
      add(e, "我的款项待补", "finance");
    if ((e.finance?.my_refund_due_cents ?? 0) > 0)
      add(e, "我的退款／垫付待收回", "finance");
    if (
      e.finance?.can_manage &&
      e.finance.detailed &&
      e.finance.state !== "closed"
    )
      add(e, "核对收退款与结清", "finance");
  }
  return rows;
}

// Navigation only. A URL must never submit, approve, or record a business action.
function boardEntryPlan(
  action: string,
  e: BoardEvent | null,
  authenticated: boolean,
) {
  const known = new Set([
    "detail",
    "create",
    "mine",
    "join",
    "party",
    "tentative",
    "withdraw",
    "conditions",
    "finance",
    "report",
    "invite",
    "claim",
    "management",
    "manage",
    "copy",
    "todos",
    "attendance",
    "onsite",
    "settlement",
  ]);
  if (!known.has(action)) return { kind: "unknown" };
  if (
    !authenticated &&
    !["detail", "settlement", "conditions"].includes(action)
  )
    return { kind: "login" };
  if (["create", "mine"].includes(action)) return { kind: action };
  if (!e) return { kind: "missing" };
  const permission: Record<string, boolean> = {
    party: e.can_join,
    tentative: e.can_join,
    invite: e.can_manage_roster,
    attendance: e.can_attendance,
    onsite: e.can_onsite,
    management: e.is_owner,
    manage: e.is_owner || e.is_cohost,
    report: !!e.finance?.can_report,
  };
  if (action in permission && !permission[action]) return { kind: "denied" };
  return { kind: action };
}

export { boardEntryPlan, boardTodos };

const FinanceText: Record<
  "kinds" | "methods" | "states" | "reports",
  Record<string, string>
> = {
  kinds: {
    collection: "收款",
    refund: "退还参加者",
    reimbursement: "偿还垫付",
    expense: "支付店家",
    merchant_refund: "店家退差价",
    deposit: "支付订金／押金",
    deposit_return: "店家退订金／押金",
    deposit_apply: "订金抵消费／押金转损失",
    credit_transfer: "更正款项归属",
    cash_transfer: "移交代收资金",
    reversal: "冲销记录",
    close: "确认结清",
    reopen: "重新核对",
  },
  methods: {
    wechat: "微信",
    alipay: "支付宝",
    qq: "QQ",
    cash: "现金",
    other: "其他",
  },
  states: {
    closed: "已结清",
    collecting: "收退款中",
    unpublished: "尚未发布逐人结算",
  },
  reports: {
    pending: "待发起者核对",
    accepted: "已确认",
    rejected: "未确认",
    withdrawn: "已撤回",
  },
};
function financeBalanceLabel(
  balance: number | null | undefined,
  centsText: (value: number) => string,
) {
  return balance == null
    ? "结算前预收／垫付"
    : balance > 0
      ? "待补 ¥" + centsText(balance)
      : balance < 0
        ? "应退／待偿还 ¥" + centsText(-balance)
        : "已对平";
}

function settlementItemsPayload(
  items: SettlementItem[],
  people: { id: string }[],
  durationHours: number,
) {
  return items.map((item) => {
    const copy = structuredClone(item);
    delete copy.receipt_digest;
    const targets =
      item.scope === "common"
        ? people
        : people.filter((p) =>
            item.allocations.some((a) => a.person_id === p.id),
          );
    if (item.scope === "common" && ["shares", "equal"].includes(item.mode))
      copy.allocations = [];
    else
      copy.allocations = targets.map((p) => {
        const a = item.allocations.find((v) => v.person_id === p.id);
        return {
          person_id: p.id,
          ...(item.mode === "fixed"
            ? { amount: a?.amount || "0.00" }
            : item.mode === "duration"
              ? { minutes: a?.minutes ?? (durationHours || 0) * 60 }
              : item.mode === "weights"
                ? { weight: a?.weight || "1" }
                : {}),
        };
      });
    return copy;
  });
}

export { financeBalanceLabel, FinanceText, settlementItemsPayload };

const actionNames: Record<string, string> = {
  claim_invited: "邀请本人认领",
  claim_requested: "申请认领",
  claim_approved: "核对通过认领",
  claim_reject: "拒绝认领",
  claim_revoke: "撤销认领",
  finance_record: "登记款项",
  finance_report: "申报款项",
  finance_accept: "确认款项申报",
  finance_reject: "暂不确认申报",
  finance_withdraw: "撤回款项申报",
  finance_reverse: "冲销款项",
  finance_close: "确认账务结清",
  finance_reopen: "重新核对账务",
  event_publish: "发布草稿",
  event_pause: "暂停报名",
  event_resume: "恢复报名",
  event_start: "确认实际开始",
  event_finish: "确认实际结束",
  event_cancel: "取消活动",
  event_archive: "归档",
  event_unarchive: "取消归档",
  event_formation: "确认成团",
  conditions_response: "确认新安排",
  attendance_updated: "核对出席",
  onsite_added: "现场补录",
  management_invited: "发出管理邀请",
  management_invitation_revoked: "撤销管理邀请",
  cohost_joined: "接受协办",
  cohost_removed: "撤销协办",
  ownership_transferred: "转交发起者",
  event_created: "发起活动",
  event_updated: "修改活动",
  event_admin_updated: "管理员协助修改活动",
  signup: "报名",
  attendee_edit: "修改报名",
  attendee_confirm: "确认参加",
  attendee_split: "改为分开排队",
  withdraw: "退出报名",
  withdrawal_request: "申请退出",
  withdrawal_approve: "同意退出",
  withdrawal_reject: "拒绝退出",
  invite: "邀请补报名",
  invitation_accepted: "接受补报名",
  nickname_changed: "修改称呼",
  settlement_saved: "保存结算",
};
export { actionNames };
