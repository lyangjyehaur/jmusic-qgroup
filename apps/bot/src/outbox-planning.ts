import type { DB } from '@qgroup/database';
import type { BotPolicy } from '@qgroup/contracts';
import {
  botBroadcastTarget,
  botContentProblem,
  botHasUnapprovedLink,
  botLength,
  botLocalTime,
  botMoment,
  botStrip,
} from '@qgroup/domain';
import {
  buildActivityBotMessage,
  botShareable,
  createActivityBot,
  renderActivityBot,
  type ActivityBotDefaults,
} from '../../api/src/activity-bot';
import { eventRow, eventScopes, type EventRow } from '../../api/src/activity-arrangements';
import { composeTimePollBotMessage, pollShareable } from '../../api/src/time-poll-bot';
import { pollAvailable, pollOptions, type PollRow } from '../../api/src/time-poll-context';
import { object, type APIObject } from './protocol';
import type { OutboxRow } from './outbox-store';

export const reminderKinds = new Set(['deadline_reminder', 'estimated_over_reminder']);
type Context = Parameters<typeof renderActivityBot>[2];
export function outboxPayload(row: OutboxRow) {
  const payload: unknown = JSON.parse(row.payload_json);
  if (!object(payload)) throw Error('Invalid outbox payload');
  return payload;
}
export function deliveryContext(context: Context, event: EventRow | undefined): Context {
  const frozen = context._countdown_event;
  const same =
    event &&
    (object(frozen)
      ? frozen.starts_at === event.starts_at && frozen.timezone === event.timezone
      : context.starts_at === botLocalTime(event.starts_at, event.timezone));
  return {
    ...context,
    _countdown_event: same
      ? { starts_at: event.starts_at, timezone: event.timezone, lifecycle: event.lifecycle }
      : null,
  };
}
export function outboxSkipReason(db: DB, row: OutboxRow, policy: BotPolicy, fallback: string, now: Date) {
  if (row.channel === 'private') return 'no binding: 个人通知尚未启用，不能改发到群';
  if (row.channel !== 'group') return '不支持的通知渠道';
  const target = botBroadcastTarget(policy, fallback);
  if (!target) return '后台未设置主动通知目标群';
  if (row.target && row.target !== target) return '目标群不在允许范围内';
  if (
    !policy.enabled ||
    !policy.broadcast_kinds.includes(row.kind as keyof typeof import('@qgroup/contracts').BOT_KINDS)
  )
    return '后台已关闭此类通知';
  if (row.poll_id) {
    const poll = db.prepare('SELECT * FROM time_polls WHERE id=?').get(row.poll_id) as PollRow | undefined;
    return row.kind === 'time_poll_published' && poll && pollShareable(poll, now)
      ? null
      : '投票已截止、定案、取消或关闭群同步';
  }
  const event = row.event_id ? eventRow(db, row.event_id) : undefined;
  if (!botShareable(event)) return '活动不再公开或已关闭群同步';
  const payload = outboxPayload(row);
  if (
    payload._settlement_image &&
    (row.kind !== 'settlement_updated' ||
      !Number.isSafeInteger(payload._settlement_version) ||
      Number(payload._settlement_version) < 1)
  )
    return '收款码与本版结算不一致';
  if (payload._settlement_version) {
    const latest = (
      db
        .prepare('SELECT COALESCE(MAX(version),0) version FROM settlement_history WHERE event_id=?')
        .get(row.event_id) as { version: number }
    ).version;
    if (payload._settlement_version !== latest) return '结算已更新，旧版通知作废';
    const actor = db
      .prepare('SELECT actor_id FROM settlement_history WHERE event_id=? AND version=?')
      .get(row.event_id, latest) as { actor_id: string | null } | undefined;
    if (!actor?.actor_id || !eventScopes(db, event!, actor.actor_id).has('settlement'))
      return '原发布者的结算权限已撤销，请重新核对收款人并发布';
    if (payload._settlement_image) {
      const stored = db
        .prepare('SELECT snapshot_json FROM settlement_details WHERE event_id=? AND version=?')
        .get(row.event_id, latest) as { snapshot_json: string } | undefined;
      const detail: unknown = stored ? JSON.parse(stored.snapshot_json) : null;
      const image = payload._settlement_image;
      const matches =
        object(image) &&
        Object.keys(image).length === 3 &&
        db
          .prepare(
            'SELECT 1 FROM settlement_code_images WHERE event_id=? AND version=? AND kind=? AND name=? AND digest=?',
          )
          .get(row.event_id, latest, image.kind, image.name, image.digest);
      if (!object(detail) || !detail.group_notice || !matches) return '收款码与本版结算不一致';
    }
  }
  if (reminderKinds.has(row.kind)) {
    if (event!.archived_at || ['ended', 'cancelled'].includes(event!.lifecycle))
      return '活动已结束／取消／归档，排程提醒过期';
    const plan = createActivityBot(db, () => now).reminderPlan(
      event!,
      row.kind as 'deadline_reminder' | 'estimated_over_reminder',
      policy,
    );
    if (!plan || payload._schedule_key !== plan.key || row.due_at !== plan.due)
      return '活动安排已变更，旧提醒作废';
    if (
      row.kind === 'deadline_reminder' &&
      (botMoment(event!.deadline, event!.timezone) <= now.getTime() ||
        !event!.registration_open ||
        event!.lifecycle !== 'scheduled')
    )
      return '报名已截止或暂停，提醒作废';
  }
  return null;
}
export function prepareOutboxPayload(
  db: DB,
  row: OutboxRow,
  policy: BotPolicy,
  now: Date,
  defaults: ActivityBotDefaults,
): APIObject | null {
  const payload = outboxPayload(row);
  if (row.poll_id) {
    const poll = db.prepare('SELECT * FROM time_polls WHERE id=?').get(row.poll_id) as PollRow;
    const candidates = pollOptions(db, poll.id).filter((option) => pollAvailable(option, poll, now));
    if (!candidates.length) return null;
    return composeTimePollBotMessage(poll, candidates, policy, defaults).payload;
  }
  const event = row.event_id ? eventRow(db, row.event_id) : undefined;
  if (reminderKinds.has(row.kind)) {
    if (!event) return null;
    const message = buildActivityBotMessage(
      db,
      event,
      row.kind as 'deadline_reminder' | 'estimated_over_reminder',
      policy,
      now,
      defaults,
    );
    if (!message) return null;
    return {
      text: message.text,
      msg_type: 0,
      markdown_text: message.markdown,
      ...(defaults.keyboard
        ? {
            keyboard: {
              content: {
                rows: message.buttons.map(([label, data, jump], index) => ({
                  buttons: [
                    {
                      id: String(index + 1),
                      render_data: { label, visited_label: label, style: 1 },
                      action: jump
                        ? { type: 0, permission: { type: 2 }, data: jump }
                        : { type: 1, permission: { type: 2 }, data: data ? data + ' ' + row.event_id : '' },
                    },
                  ],
                })),
              },
            },
          }
        : {}),
    };
  }
  if (object(payload._template_context)) {
    const context = deliveryContext(payload._template_context as Context, event);
    payload.text = renderActivityBot(
      policy,
      row.kind as Parameters<typeof renderActivityBot>[1],
      context,
      now,
    );
    try {
      payload.markdown_text = renderActivityBot(
        policy,
        row.kind as Parameters<typeof renderActivityBot>[1],
        context,
        now,
        true,
      );
    } catch {
      payload.markdown_text = null;
    }
  }
  return payload;
}
export function outboxBody(
  payload: APIObject,
  markdown: boolean,
  hosts: readonly string[],
): { body: APIObject; problem?: undefined } | { problem: string; body?: undefined } {
  let body: APIObject = { msg_type: payload.msg_type ?? 0 };
  const rich = payload.markdown_text;
  if (body.msg_type === 0 && markdown && typeof rich === 'string' && !botContentProblem(rich, hosts))
    body = { msg_type: 2, markdown: { content: rich } };
  else if (body.msg_type === 0) {
    const text = payload.text;
    if (typeof text !== 'string' || !botStrip(text)) return { problem: '文字内容为空，拒绝发送' };
    if (/[\x00-\x08\x0b-\x1f]/.test(text)) return { problem: '文字含控制字符，拒绝发送' };
    if (botLength(text) > 4000) return { problem: '文字超过 4000 字，拒绝发送' };
    if (botHasUnapprovedLink(text, hosts)) return { problem: '文字含未报备域名，拒绝发送' };
    body.content = text;
  } else {
    const extra = Object.fromEntries(
      Object.entries(payload).filter(([key]) =>
        ['content', 'media', 'file_info', 'markdown', 'image'].includes(key),
      ),
    );
    if (object(payload._settlement_image)) body.media = { settlement_image: payload._settlement_image.kind };
    else if (Object.keys(extra).length) Object.assign(body, extra);
    else return { problem: '非文字消息缺少内容字段，拒绝发送' };
  }
  if (payload.keyboard) {
    if (
      !object(payload.keyboard) ||
      !object(payload.keyboard.content) ||
      !Array.isArray(payload.keyboard.content.rows)
    )
      return { problem: '按钮格式无效，拒绝发送' };
    for (const row of payload.keyboard.content.rows) {
      if (!object(row) || !Array.isArray(row.buttons)) return { problem: '按钮格式无效，拒绝发送' };
      for (const button of row.buttons) {
        if (!object(button) || !object(button.action)) return { problem: '按钮格式无效，拒绝发送' };
        if (button.action.type === 0 && botHasUnapprovedLink(String(button.action.data ?? ''), hosts))
          return { problem: '按钮含未报备域名，拒绝发送' };
      }
    }
    body.keyboard = payload.keyboard;
  }
  return { body };
}
