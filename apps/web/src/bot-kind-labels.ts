import type { BotKind } from '@qgroup/contracts';
import { uiText } from './language';
// Display labels only; shared bot templates and protocol values stay canonical.
export const botKindLabels = {
  time_poll_published: uiText('活动时间投票'),
  activity_published: uiText('活动发起'),
  formation_confirmed: uiText('已成团'),
  conditions_changed: uiText('安排变更'),
  event_started: uiText('活动开始'),
  event_finished: uiText('活动结束'),
  event_cancelled: uiText('活动取消'),
  settlement_updated: uiText('结算发布'),
  deadline_reminder: uiText('报名即将截止'),
  estimated_over_reminder: uiText('活动时间已到'),
  registration_paused: uiText('暂停报名'),
  registration_resumed: uiText('恢复报名'),
  finance_closed: uiText('账务已结清'),
  finance_reopened: uiText('账务重新核对'),
  ownership_changed: uiText('管理交接'),
  registration_added: uiText('有人报名'),
  registration_changed: uiText('退出／候补递补'),
} satisfies Record<BotKind, string>;
