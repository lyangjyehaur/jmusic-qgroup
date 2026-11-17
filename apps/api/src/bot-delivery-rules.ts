import type { DB } from '@qgroup/database';
import type { BotPolicy } from '@qgroup/contracts';
import { botBroadcastTarget, botMoment } from '@qgroup/domain';
import { botShareable, createActivityBot } from './activity-bot';
import { eventRow, eventScopes } from './activity-arrangements';
import { pollShareable } from './time-poll-bot';
import type { PollRow } from './time-poll-context';
export interface DeliveryIntent { event_id:string|null;poll_id:string|null;kind:string;channel:string;target:string;payload_json:string;due_at:string|null }
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
export const reminderKinds = new Set(['deadline_reminder', 'estimated_over_reminder']);
export function deliveryRetryBlocker(row:{status:string;sent_at:string|null;simulated_at:string|null;last_error:string}) {
  if(row.status==='sent'||row.sent_at)return '已確認送出的通知不能重送';
  if(row.status==='sending')return '工作正在投遞或結果尚未核對，不能重送；程序異常停止時請由維運人員離線對帳';
  if(row.status==='pending')return '這條通知仍在待送，請等待投遞結果';
  if(/未.?确认|未確認|不確定|unconfirmed|uncertain/i.test(row.last_error))return '投遞結果未確認，請先由維運人員離線對帳；不能直接重送';
  if(!(row.status==='failed'||(row.status==='skipped'&&(row.simulated_at||row.last_error==='dry-run'))))return '只能重送失敗或模擬通知';
  return null;
}
export function outboxPayload(row: Pick<DeliveryIntent,'payload_json'>) {
  const payload:unknown=JSON.parse(row.payload_json);
  if(!object(payload))throw Error('Invalid outbox payload');
  return payload;
}
export function outboxSkipReason(db: DB, row: DeliveryIntent, policy: BotPolicy, fallback: string, now: Date) {
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
