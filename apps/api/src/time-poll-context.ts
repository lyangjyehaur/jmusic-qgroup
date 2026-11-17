import type { DB } from '@qgroup/database';
import { PollCounts, PollHistoryDetails, TimePoll } from '@qgroup/contracts';
import { botLocalTime, botMoment, DomainError } from '@qgroup/domain';
import { z } from 'zod';
import { activityDate, legacyStamp } from './activity-arrangements';
import { activityBotPolicy, type ActivityBotDefaults } from './activity-bot';
export type PollRow = {
  id: string;
  owner_id: string;
  title: string;
  category: string;
  location: string;
  description: string;
  timezone: string;
  time_mode: 'date' | 'exact';
  duration_hours: number;
  capacity: number;
  minimum_participants: number;
  fee_policy: string;
  deadline: string;
  status: string;
  revision: number;
  vote_revision: number;
  created_at: string;
  decided_at: string | null;
  selected_option_id: string | null;
  event_id: string | null;
  reason: string;
  result_json: string | null;
  respondent_count: number | null;
  bot_enabled: number;
};
export type PollCandidate = { id: string; starts_at: string };
export function pollRow(db: DB, id: string, allowDeleted = false) {
  const row = db.prepare('SELECT * FROM time_polls WHERE id=?').get(id) as PollRow | undefined;
  if (!row || (!allowDeleted && row.status === 'deleted'))
    throw new DomainError('POLL_NOT_FOUND', '找不到時間投票或已刪除', 404);
  return row;
}
export function pollOptions(db: DB, id: string) {
  return db
    .prepare('SELECT id,starts_at FROM time_poll_options WHERE poll_id=? ORDER BY position')
    .all(id) as PollCandidate[];
}
export function pollDate(option: Pick<PollCandidate, 'starts_at'>, zone: string) {
  return botLocalTime(option.starts_at, zone).slice(0, 10);
}
export function pollDateStart(day: string, zone: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new DomainError('POLL_DATE', '請選擇有效候選日期', 400);
  activityDate(day + 'T00:00:00Z'); // Validate calendar before applying IANA wall time, including a DST gap.
  const at = botMoment(day + 'T00:00:00', zone);
  if (!Number.isFinite(at) || new Date(at).getUTCFullYear() < 1 || new Date(at).getUTCFullYear() > 9999)
    throw new DomainError('POLL_DATE', '候選日期超出範圍', 400);
  return legacyStamp(new Date(at));
}
export function pollExpires(option: Pick<PollCandidate, 'starts_at'>, poll: Pick<PollRow, 'time_mode' | 'timezone'>) {
  if (poll.time_mode === 'exact') return option.starts_at;
  const day = new Date(pollDate(option, poll.timezone) + 'T00:00:00Z');
  day.setUTCDate(day.getUTCDate() + 1);
  return pollDateStart(day.toISOString().slice(0, 10), poll.timezone);
}
export function pollAvailable(
  option: Pick<PollCandidate, 'starts_at'>,
  poll: Pick<PollRow, 'time_mode' | 'timezone'>,
  now: Date,
) {
  return Date.parse(pollExpires(option, poll)) > now.getTime();
}
export function pollDeadline(
  deadline: string,
  options: Pick<PollCandidate, 'starts_at'>[],
  poll: Pick<PollRow, 'time_mode' | 'timezone'>,
  now: Date,
) {
  if (
    !(
      now.getTime() < Date.parse(deadline) &&
      Date.parse(deadline) < Math.max(...options.map((o) => Date.parse(pollExpires(o, poll))))
    )
  )
    throw new DomainError('POLL_DEADLINE', '投票截止須晚於現在，並早於最後一個候選的失效時間', 400);
}
export function pollTotals(db: DB, poll: PollRow): Record<string, z.infer<typeof PollCounts>> {
  if (poll.result_json) return z.record(z.string(), PollCounts).parse(JSON.parse(poll.result_json));
  const counts = Object.fromEntries(pollOptions(db, poll.id).map((o) => [o.id, { yes: 0, maybe: 0, no: 0 }]));
  for (const row of db
    .prepare('SELECT option_id,choice,count(*) AS n FROM time_poll_votes WHERE poll_id=? GROUP BY option_id,choice')
    .all(poll.id) as { option_id: string; choice: 'yes' | 'maybe' | 'no'; n: number }[])
    counts[row.option_id]![row.choice] = row.n;
  return counts;
}
export function pollView(db: DB, poll: PollRow, viewer: string | null, now: Date, defaults: ActivityBotDefaults = {}) {
  const owner = viewer === poll.owner_id,
    totals = pollTotals(db, poll),
    candidates = pollOptions(db, poll.id),
    active = new Set(candidates.filter((o) => pollAvailable(o, poll, now)).map((o) => o.id));
  const status =
    poll.status === 'open' && (Date.parse(poll.deadline) <= now.getTime() || !active.size) ? 'closed' : poll.status;
  const votes = (user: string | null) =>
    Object.fromEntries(
      (
        db.prepare('SELECT option_id,choice FROM time_poll_votes WHERE poll_id=? AND user_id=?').all(poll.id, user) as {
          option_id: string;
          choice: string;
        }[]
      ).map((v) => [v.option_id, v.choice]),
    );
  const options = candidates.map((o) => ({
    id: o.id,
    date: pollDate(o, poll.timezone),
    starts_at: poll.time_mode === 'date' ? null : o.starts_at,
    ends_at:
      poll.time_mode === 'date' ? null : legacyStamp(new Date(Date.parse(o.starts_at) + poll.duration_hours * 3600000)),
    expired: !active.has(o.id),
    can_vote: !!viewer && status === 'open' && active.has(o.id),
    ...totals[o.id]!,
  }));
  const ranked = poll.status === 'finalized' ? options : options.filter((o) => active.has(o.id)),
    max = Math.max(0, ...ranked.map((o) => o.yes)),
    choices = votes(viewer);
  const event = poll.event_id
    ? (db.prepare('SELECT status,starts_at,duration_hours,timezone FROM events WHERE id=?').get(poll.event_id) as
        | { status: string; starts_at: string; duration_hours: number | null; timezone: string | null }
        | undefined)
    : undefined;
  const policy = owner ? activityBotPolicy(db, defaults).config : undefined;
  return TimePoll.parse({
    ...poll,
    bot_enabled: undefined,
    time_poll: true,
    status,
    is_owner: owner,
    can_remove: owner && poll.status !== 'deleted',
    can_manage: owner && ['open', 'closed'].includes(status),
    can_vote: !!viewer && status === 'open',
    duration_hours: poll.time_mode === 'date' ? null : poll.duration_hours,
    my_choices: choices,
    has_voted: !!Object.keys(choices).length,
    options,
    leading_option_ids: max ? ranked.filter((o) => o.yes === max).map((o) => o.id) : [],
    respondent_count:
      poll.respondent_count ??
      (db.prepare('SELECT count(*) AS n FROM time_poll_ballots WHERE poll_id=?').get(poll.id) as { n: number }).n,
    owner_name: (db.prepare('SELECT nickname FROM users WHERE id=?').get(poll.owner_id) as { nickname: string })
      .nickname,
    ...(event?.status === 'deleted'
      ? { event_id: null, event_deleted: true }
      : event
        ? {
            event_time: {
              starts_at: event.starts_at,
              ends_at: legacyStamp(new Date(Date.parse(event.starts_at) + (event.duration_hours ?? 0) * 3600000)),
              timezone: event.timezone,
            },
          }
        : {}),
    ...(owner
      ? {
          bot_enabled: !!poll.bot_enabled,
          bot_feature_enabled: policy!.enabled,
          bot_notice_enabled: policy!.enabled && policy!.broadcast_kinds.includes('time_poll_published'),
          bot_delivery: (
            db
              .prepare(
                "SELECT id,status,attempts,last_error,created_at,sent_at,simulated_at FROM bot_outbox WHERE poll_id=? AND channel='group' ORDER BY id DESC LIMIT 12",
              )
              .all(poll.id) as { status: string; last_error: string; simulated_at: string | null }[]
          ).map((r) => ({ ...r, state: r.simulated_at || r.last_error === 'dry-run' ? 'simulated' : r.status })),
          respondents: (
            db
              .prepare(
                'SELECT b.user_id,b.updated_at,u.nickname FROM time_poll_ballots b JOIN users u ON u.id=b.user_id WHERE b.poll_id=? ORDER BY b.updated_at',
              )
              .all(poll.id) as { user_id: string; updated_at: string; nickname: string }[]
          ).map((r) => ({ name: r.nickname, updated_at: r.updated_at, choices: votes(r.user_id) })),
          history: (
            db
              .prepare('SELECT action,details_json,created_at FROM time_poll_history WHERE poll_id=? ORDER BY id')
              .all(poll.id) as { action: string; details_json: string; created_at: string }[]
          ).map((r) => ({
            action: r.action,
            details: PollHistoryDetails.parse(JSON.parse(r.details_json)),
            created_at: r.created_at,
          })),
        }
      : {}),
  });
}
