import type { BotPolicy } from '@qgroup/contracts';
import type { DB } from '@qgroup/database';
import { botContentProblem, botLocalTime, botStrip, renderBotBroadcast, renderBotTemplate } from '@qgroup/domain';
import { activityBotPolicy, type ActivityBotDefaults } from './activity-bot';
import { legacyStamp } from './activity-arrangements';
import { hash } from './security';
import { pollAvailable, pollDate, pollOptions, type PollRow } from './time-poll-context';
export function pollShareable(poll: PollRow, now: Date) {
  return !!poll.bot_enabled && poll.status === 'open' && Date.parse(poll.deadline) > now.getTime();
}
export function preparePollAnnouncement(
  db: DB,
  poll: PollRow,
  now: Date,
  defaults: ActivityBotDefaults,
) {
  const policy = activityBotPolicy(db, defaults).config,
    kind = 'time_poll_published';
  if (!policy.enabled || !policy.broadcast_kinds.includes(kind) || !pollShareable(poll, now)) return undefined;
  const target = policy.groups === null ? '' : policy.groups.find((g) => g.broadcast)?.id;
  if (target === undefined) return undefined;
  const candidates = pollOptions(db, poll.id).filter((o) => pollAvailable(o, poll, now));
  if (!candidates.length) return undefined;
  const { payload } = composeTimePollBotMessage(poll, candidates, policy, defaults);
  return { target, payload };
}
export function enqueuePollAnnouncement(db: DB, poll: PollRow, now: Date, notice: NonNullable<ReturnType<typeof preparePollAnnouncement>>, fact = 'poll:' + poll.id) {
  const kind = 'time_poll_published';
  return (
    db
      .prepare(
        "INSERT OR IGNORE INTO bot_outbox(event_id,poll_id,kind,dedupe_key,channel,target,payload_json,status,created_at) VALUES(NULL,?,?,?,'group',?,?,'pending',?)",
      )
      .run(
        poll.id,
        kind,
        hash(kind + '\ngroup\n' + notice.target + '\n\n' + fact).slice(0, 32),
        notice.target,
        JSON.stringify(notice.payload),
        legacyStamp(now),
      ).changes > 0
  );
}
export function announcePoll(db: DB, poll: PollRow, now: Date, defaults: ActivityBotDefaults, fact = 'poll:' + poll.id) {
  const notice = preparePollAnnouncement(db, poll, now, defaults);
  return !!notice && enqueuePollAnnouncement(db, poll, now, notice, fact);
}

export function composeTimePollBotMessage(
  poll: PollRow,
  candidates: { starts_at: string }[],
  policy: BotPolicy,
  defaults: ActivityBotDefaults = {},
) {
  const kind = 'time_poll_published';
  const title = Array.from(poll.title).slice(0, 40).join(''),
    label = '活动时间投票',
    heading = '【' + label + '】' + title;
  const days = [...new Set(candidates.map((o) => pollDate(o, poll.timezone)))].sort(),
    dateOnly = poll.time_mode === 'date';
  const lines = [
    '请一起选择方便参加的时段：',
    '共 ' + candidates.length + ' 个候选' + (dateOnly ? '日期（具体时间待定）' : '时段'),
    days.length <= 5
      ? '候选日期：' + days.join('、')
      : '候选日期范围：' + days[0] + ' 至 ' + days.at(-1) + '（日期可不连续）',
  ];
  if (!dateOnly) lines.push('每场预计 ' + poll.duration_hours + ' 小时');
  lines.push('过期候选停止收票，其余候选可继续投票。', '完整候选日期与安排请打开投票页查看。');
  if (dateOnly) lines.push('先选择可以参加的日期，开始时间与时长由发起者定案时补充，请再核对后报名。');
  lines.push(
    '时区：' + poll.timezone,
    '预计地点：' + poll.location,
    '投票截止：' + botLocalTime(poll.deadline, poll.timezone),
    '每个时段可选：可以／勉强可以／不行，截止前可改票。',
    '投票不占名额，发起者定案后需另行报名。',
  );
  const url = (defaults.baseURL ?? 'https://kanban.danndann.cn').replace(/\/+$/, '') + '/?poll=' + poll.id;
  const context = {
    ...Object.fromEntries(
      [
        'heading',
        'details',
        'url',
        'title',
        'starts_at',
        'deadline',
        'previous_starts_at',
        'location',
        'confirmed',
        'waiting',
        'fee_policy',
        'description',
        'version',
        'change_summary',
        'cancellation_reason',
      ].map((k) => [k, '']),
    ),
    heading,
    details: lines.join('\n'),
    url,
    title,
    starts_at: '待投票确定',
    deadline: botLocalTime(poll.deadline, poll.timezone),
    location: poll.location,
    description: Array.from(poll.description).slice(0, 120).join(''),
    fee_policy: Array.from(poll.fee_policy).slice(0, 120).join(''),
    _label: label,
    _details_lines: lines,
    _default_text: heading + '\n' + lines.join('\n') + '\n\n' + url,
  };
  const text = Object.hasOwn(policy.templates, kind)
    ? renderBotTemplate(policy.templates, kind, context)!
    : context._default_text;
  let rich: string | null = null;
  try {
    rich = renderBotTemplate(policy.templates, kind, context, true) || renderBotBroadcast(label, title, lines, url);
    if (botContentProblem(rich)) rich = null;
  } catch {
    /* plain fallback */
  }
  const payload = {
    text,
    msg_type: 0,
    _template_context: context,
    ...(rich && botStrip(rich) ? { markdown_text: rich } : {}),
    ...(defaults.keyboard
      ? {
          keyboard: {
            content: {
              rows: [
                {
                  buttons: [
                    {
                      id: '1',
                      render_data: { label: '选择活动时间', visited_label: '选择活动时间', style: 1 },
                      action: { type: 0, permission: { type: 2 }, data: url },
                    },
                  ],
                },
              ],
            },
          },
        }
      : {}),
  };
  return { text, markdown: rich, payload, context };
}
