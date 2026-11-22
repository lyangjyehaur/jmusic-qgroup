import { randomBytes, randomUUID } from 'node:crypto';
import type { DB } from '@qgroup/database';
import { CreateTimePoll, PollHistoryDetails, type VoteTimePoll, type ManageTimePoll } from '@qgroup/contracts';
import { DomainError } from '@qgroup/domain';
import type { z } from 'zod';
import { withApiError } from './error-display';
import { activityDate, arrangementValues, legacyStamp } from './activity-arrangements';
import { type ActivityBotDefaults } from './activity-bot';
import { prepareActivityCreation, executeActivityCreation } from './activity-create-command';
import { announcePoll, preparePollAnnouncement, enqueuePollAnnouncement, pollShareable } from './time-poll-bot';
import { deliveryRetryBlocker } from './bot-delivery-rules';
import { pollAvailable, pollDate, pollDateStart, pollExpires, pollRow, pollDeadline, pollOptions, pollTotals, type PollRow } from './time-poll-context';
type User = { id: string; nickname: string };
type Vote = z.infer<typeof VoteTimePoll>;
type Manage = z.infer<typeof ManageTimePoll>;
export function requirePollOwner(poll: PollRow, userId: string) {
  if (poll.owner_id !== userId) throw withApiError(new DomainError('POLL_PERMISSION', '只有發起者可以管理時間投票', 403));
}
function changed(poll: PollRow, revision: number) {
  if (poll.revision !== revision) throw withApiError(new DomainError('POLL_CHANGED', '投票安排已有更新，請保留輸入並核對最新版', 409));
}
export function recordPoll(db: DB, id: string, actor: string, action: string, details: z.infer<typeof PollHistoryDetails>, stamp: string) {
  db.prepare('INSERT INTO time_poll_history(poll_id,actor_id,action,details_json,created_at) VALUES(?,?,?,?,?)').run(id, actor, action, JSON.stringify(PollHistoryDetails.parse(details)), stamp);
}
/** Original event-create sequence: conditions -> created audit -> owner consent/roster -> signup audit -> bot. */
function finalizedEvent(
  db: DB,
  poll: PollRow,
  user: { id: string; nickname: string },
  start: string,
  deadline: string,
  duration: number,
  now: () => Date,
  defaults: ActivityBotDefaults,
  hook: (work: () => unknown) => void,
) {
  const plan = prepareActivityCreation(
    {
      title: poll.title,
      category: poll.category as z.infer<typeof CreateTimePoll>['category'],
      location: poll.location,
      description: poll.description,
      timezone: poll.timezone,
      durationHours: duration,
      capacity: poll.capacity,
      minimumParticipants: poll.minimum_participants,
      feePolicy: poll.fee_policy,
      startsAt: start,
      deadline,
      visibility: 'public',
      botEnabled: !!poll.bot_enabled,
      joinOwner: true,
      withdrawalDeadline: null,
    },
    now(),
    'scheduled',
  );
  return executeActivityCreation(db,plan,user,now(),defaults,hook);
}
/** Preparation only reads; an inspection must never create trial events or jobs. */
export function preparePollVote(db: DB, poll: PollRow, input: Vote, time: Date) {
  changed(poll, input.revision);
  if (poll.status !== 'open' || Date.parse(poll.deadline) <= time.getTime()) throw withApiError(new DomainError('POLL_CLOSED', '投票已截止，請查看最終安排', 409));
  const options = pollOptions(db, poll.id), active = new Set(options.filter(o => pollAvailable(o, poll, time)).map(o => o.id)), submitted = new Set(input.choices.map(c => c.option_id));
  if (!active.size) throw withApiError(new DomainError('POLL_EXPIRED', '候選時段均已過期', 409));
  if (submitted.size !== input.choices.length || [...active].some(id => !submitted.has(id)) || [...submitted].some(id => !options.some(o => o.id === id))) throw withApiError(new DomainError('POLL_OPTIONS_CHANGED', '請為每個未過期候選填寫選擇，並核對最新版', 409));
  return { poll, input, active };
}
export function executePollVote(db: DB, plan: ReturnType<typeof preparePollVote>, user: User, time: Date) {
  const { poll, input, active } = plan, stamp = legacyStamp(time);
  db.prepare('INSERT INTO time_poll_ballots VALUES(?,?,?) ON CONFLICT(poll_id,user_id) DO UPDATE SET updated_at=excluded.updated_at').run(poll.id, user.id, stamp);
  for (const c of input.choices) if (active.has(c.option_id)) db.prepare('INSERT INTO time_poll_votes VALUES(?,?,?,?) ON CONFLICT(poll_id,user_id,option_id) DO UPDATE SET choice=excluded.choice').run(poll.id, user.id, c.option_id, c.choice);
  db.prepare('UPDATE time_polls SET vote_revision=vote_revision+1 WHERE id=?').run(poll.id);
  return poll.id;
}
export function preparePollManagement(db: DB, poll: PollRow, user: User, input: Manage, time: Date, defaults: ActivityBotDefaults = {}) {
  requirePollOwner(poll, user.id); changed(poll, input.revision);
  if (poll.status === 'deleted') throw withApiError(new DomainError('POLL_NOT_FOUND', '時間投票不存在或已刪除', 404));
  if (input.action !== 'remove' && !['open', 'closed'].includes(poll.status)) throw withApiError(new DomainError('POLL_FINAL', '時間投票已定案或取消', 409));
  let deadline: string | undefined, finalization: { starts_at: string; duration_hours: number; registration_deadline: string; counts: ReturnType<typeof pollTotals>; respondent_count: number } | undefined;
  let retryNotice: ReturnType<typeof preparePollAnnouncement> = undefined;
  if (input.action === 'extend') { deadline = activityDate(input.deadline); pollDeadline(deadline, pollOptions(db, poll.id), poll, time); }
  if (input.action === 'cancel' && !input.reason) throw withApiError(new DomainError('POLL_REASON', '請填寫取消投票原因', 400));
  if (input.action === 'bot_retry') {
    if (!pollShareable(poll, time)) throw withApiError(new DomainError('POLL_BOT_RETRY', '目前投票未開放群同步，無法重送', 409));
    const row = db.prepare("SELECT status,sent_at,simulated_at,last_error FROM bot_outbox WHERE id=? AND poll_id=? AND channel='group'").get(input.outbox_id, poll.id) as { status: string; sent_at: string | null; simulated_at: string | null; last_error: string } | undefined;
    const blocked = row ? deliveryRetryBlocker(row) : '找不到群通知紀錄';
    if (blocked) throw new DomainError('POLL_BOT_RETRY', blocked, 409);
    if (db.prepare("SELECT 1 FROM bot_outbox WHERE poll_id=? AND status IN ('pending','sending')").get(poll.id)) throw withApiError(new DomainError('POLL_BOT_PENDING', '已有通知等待發送', 409));
    retryNotice = preparePollAnnouncement(db, poll, time, defaults);
    if (!retryNotice) throw withApiError(new DomainError('POLL_BOT_DISABLED', '管理員尚未開啟此類通知或未設定目標群', 409));
  }
  if (input.action === 'finalize') {
    if (input.base_vote_revision !== poll.vote_revision) throw withApiError(new DomainError('POLL_VOTES_CHANGED', '票數已有更新，請重新核對後定案', 409));
    const options = pollOptions(db, poll.id), selected = options.find(o => o.id === input.option_id);
    if (!selected) throw withApiError(new DomainError('POLL_OPTION', '請選擇本次投票的候選時段', 400));
    if (!pollAvailable(selected, poll, time)) throw withApiError(new DomainError('POLL_EXPIRED', '候選時段已過期', 409));
    const counts = pollTotals(db, poll), support = counts[selected.id]!.yes, max = Math.max(0, ...options.filter(o => pollAvailable(o, poll, time)).map(o => counts[o.id]!.yes));
    if ((support === 0 || support < poll.minimum_participants || support < max) && !input.reason) throw withApiError(new DomainError('POLL_REASON', '未選最高票或未達最低人數，請填寫仍決定舉行的原因', 400));
    const start = poll.time_mode === 'date' ? activityDate(input.starts_at ?? '') : selected.starts_at, duration = poll.time_mode === 'date' ? input.duration_hours : poll.duration_hours;
    if (poll.time_mode === 'date' && pollDate({ starts_at: start }, poll.timezone) !== pollDate(selected, poll.timezone)) throw withApiError(new DomainError('POLL_DATE', '開始時間必須在選定的候選日期內', 400));
    if (!duration || !Number.isInteger(duration) || duration < 1 || duration > 24) throw withApiError(new DomainError('POLL_DURATION', '請選擇持續時間（1–24 小時）', 400));
    const registration = activityDate(input.registration_deadline);
    if (!(time.getTime() < Date.parse(registration) && registration <= start)) throw withApiError(new DomainError('POLL_REGISTRATION_DEADLINE', '報名截止須晚於現在，且不能晚於選定的開始時間', 400));
    // Validate the full event arrangement before any mutation or optional bot hook.
    arrangementValues({ title: poll.title, category: poll.category as z.infer<typeof CreateTimePoll>['category'], location: poll.location, description: poll.description, timezone: poll.timezone, durationHours: duration, capacity: poll.capacity, minimumParticipants: poll.minimum_participants, feePolicy: poll.fee_policy, startsAt: start, deadline: registration, visibility: 'public', botEnabled: !!poll.bot_enabled, joinOwner: true, withdrawalDeadline: null }, time, false);
    const respondents = (db.prepare('SELECT count(*) AS n FROM time_poll_ballots WHERE poll_id=?').get(poll.id) as { n: number }).n;
    finalization = { starts_at: start, duration_hours: duration, registration_deadline: registration, counts, respondent_count: respondents };
  }
  return { poll, input, deadline, finalization, retryNotice };
}
export function executePollManagement(db: DB, plan: ReturnType<typeof preparePollManagement>, user: User, time: Date, defaults: ActivityBotDefaults, hook: (work: () => unknown) => void) {
  const { poll, input } = plan, id = poll.id, action = input.action, stamp = legacyStamp(time), details: z.infer<typeof PollHistoryDetails> = { reason: input.reason };
  const skip = (message: string) => db.prepare("UPDATE bot_outbox SET status='skipped',last_error=? WHERE poll_id=? AND status IN ('pending','sending')").run(message, id);
  if (action === 'remove') {
    db.prepare("UPDATE time_polls SET status='deleted',bot_enabled=0,revision=revision+1 WHERE id=?").run(id); skip('时间投票已删除'); recordPoll(db, id, user.id, action, { previous_status: poll.status }, stamp); return id;
  }
  if (action === 'close') db.prepare("UPDATE time_polls SET status='closed' WHERE id=?").run(id);
  else if (action === 'extend') { db.prepare("UPDATE time_polls SET deadline=?,status='open' WHERE id=?").run(plan.deadline!, id); details.deadline = plan.deadline!; }
  else if (action === 'cancel') db.prepare("UPDATE time_polls SET status='cancelled',reason=?,decided_at=? WHERE id=?").run(input.reason, stamp, id);
  else if (action === 'bot_sync') {
    db.prepare('UPDATE time_polls SET bot_enabled=? WHERE id=?').run(Number(input.bot_enabled), id); details.bot_enabled = input.bot_enabled;
    if (input.bot_enabled) hook(() => announcePoll(db, { ...poll, bot_enabled: 1 }, time, defaults, 'sync:' + poll.revision)); else skip('投票已关闭群同步');
  } else if (action === 'bot_retry') {
    if (!plan.retryNotice || !enqueuePollAnnouncement(db, poll, time, plan.retryNotice, 'retry:' + randomUUID().replaceAll('-', ''))) throw withApiError(new DomainError('POLL_BOT_DISABLED', '管理員尚未開啟此類通知或未設定目標群', 409));
  } else if (action === 'finalize') {
    const f = plan.finalization!, event = finalizedEvent(db, poll, user, f.starts_at, f.registration_deadline, f.duration_hours, () => time, defaults, hook);
    db.prepare("UPDATE time_polls SET status='finalized',event_id=?,selected_option_id=?,reason=?,decided_at=?,result_json=?,respondent_count=? WHERE id=?").run(event, input.option_id, input.reason, stamp, JSON.stringify(f.counts), f.respondent_count, id);
    for (const row of db.prepare('SELECT user_id FROM time_poll_ballots WHERE poll_id=? AND user_id!=?').all(id, user.id) as { user_id: string }[]) db.prepare("INSERT INTO notifications(user_id,event_id,kind,message,created_at) VALUES(?,?,'time_poll_finalized',?,?)").run(row.user_id, event, poll.title + ' 的时间已确定，请查看安排后报名', stamp);
    Object.assign(details, { event_id: event, option_id: input.option_id, counts: f.counts, starts_at: f.starts_at, duration_hours: f.duration_hours });
  }
  if (['close', 'cancel', 'finalize'].includes(action)) skip('投票已截止、定案或取消');
  db.prepare('UPDATE time_polls SET revision=revision+1 WHERE id=?').run(id); recordPoll(db, id, user.id, action, details, stamp); return id;
}

/** Pure creation validation shared by native writes and original request recovery. */
export function preparePollCreation(input: z.infer<typeof CreateTimePoll>, time: Date) {
      const starts = input.options.map((o) =>
        'date' in o ? pollDateStart(o.date, input.timezone) : activityDate(o.starts_at),
      );
      const definition = { time_mode: input.time_mode, timezone: input.timezone };
      // Validate the shared arrangement (including IANA zone) before date expiry calculations.
      const latest = starts
          .map((starts_at) => pollExpires({ starts_at }, definition))
          .reduce((a, b) => (a > b ? a : b)),
        deadline = activityDate(input.deadline);
      arrangementValues(
        {
          title: input.title,
          category: input.category,
          location: input.location,
          description: input.description,
          timezone: input.timezone,
          capacity: input.capacity,
          minimumParticipants: input.minimum_participants,
          feePolicy: input.fee_policy,
          startsAt: latest,
          deadline,
          durationHours: input.time_mode === 'exact' ? input.duration_hours : 3,
          withdrawalDeadline: null,
          visibility: 'public',
          botEnabled: input.bot_enabled,
          joinOwner: false,
        },
        time,
        true,
      );
      if (new Set(starts).size !== starts.length) throw withApiError(new DomainError('POLL_DUPLICATE', '候選時段不能重複', 400));
      const candidates = starts.map((starts_at) => ({ starts_at }));
      if (candidates.some((o) => !pollAvailable(o, definition, time)))
        throw withApiError(new DomainError('POLL_EXPIRED', '候選已過期，請選擇尚未失效的日期或時間', 400));
      pollDeadline(deadline, candidates, definition, time);

      return { input, starts, deadline };
}
export function executePollCreation(db: DB, plan: ReturnType<typeof preparePollCreation>, user: User, time: Date, defaults: ActivityBotDefaults, hook: (work: () => unknown) => void) {
      const { input, starts, deadline } = plan;
      const id = randomBytes(8).toString('hex'),
        stamp = legacyStamp(time);
      db.prepare(
        'INSERT INTO time_polls(id,owner_id,title,category,location,description,timezone,duration_hours,capacity,minimum_participants,fee_policy,deadline,created_at,time_mode,bot_enabled) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      ).run(
        id,
        user.id,
        input.title,
        input.category,
        input.location,
        input.description,
        input.timezone,
        input.time_mode === 'date' ? 0 : input.duration_hours,
        input.capacity,
        input.minimum_participants,
        input.fee_policy,
        deadline,
        stamp,
        input.time_mode,
        Number(input.bot_enabled),
      );
      starts.forEach((start, i) =>
        db.prepare('INSERT INTO time_poll_options VALUES(?,?,?,?)').run(randomBytes(8).toString('hex'), id, i, start),
      );
      recordPoll(db, id, user.id, 'created', { options: starts, deadline, time_mode: input.time_mode }, stamp);
      hook(() => announcePoll(db, pollRow(db, id), time, defaults));
      return id;
}
