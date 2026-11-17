import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DB } from '@qgroup/database';
import {
  CreateTimePoll,
  ManageTimePoll,
  PollHistoryDetails,
  TimePollList,
  TimePollResult,
  VoteTimePoll,
} from '@qgroup/contracts';
import { DomainError } from '@qgroup/domain';
import { z } from 'zod';
import {
  activityDate,
  appendEventAudit,
  arrangementSnapshot,
  arrangementValues,
  eventRow,
  eventSnapshot,
  legacyStamp,
} from './activity-arrangements';
import { createActivityBot, type ActivityBotDefaults } from './activity-bot';
import { allocateActivity } from './activity-publish';
import { hash, type Security } from './security';
import { announcePoll, pollShareable } from './time-poll-bot';
import { deliveryRetryBlocker } from './bot-delivery-rules';
import {
  pollAvailable,
  pollDate,
  pollDateStart,
  pollDeadline,
  pollExpires,
  pollOptions,
  pollRow,
  pollTotals,
  pollView,
  type PollRow,
} from './time-poll-context';
const identifier = z.object({ id: z.string().min(1).max(80) });
function changed(poll: PollRow, revision: number) {
  if (poll.revision !== revision)
    throw new DomainError('POLL_CHANGED', '投票安排已有更新，請保留輸入並核對最新版', 409);
}
function record(
  db: DB,
  id: string,
  actor: string,
  action: string,
  details: z.infer<typeof PollHistoryDetails>,
  stamp: string,
) {
  db.prepare('INSERT INTO time_poll_history(poll_id,actor_id,action,details_json,created_at) VALUES(?,?,?,?,?)').run(
    id,
    actor,
    action,
    JSON.stringify(PollHistoryDetails.parse(details)),
    stamp,
  );
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
  const v = arrangementValues(
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
    false,
  );
  const id = randomBytes(8).toString('hex'),
    stamp = legacyStamp(now());
  db.prepare(
    `INSERT INTO events(id,owner_id,title,category,location,starts_at,deadline,capacity,description,duration_hours,created_at,withdrawal_deadline,visibility,invite_token,lifecycle,registration_open,status,timezone,minimum_participants,fee_policy,draft_join_owner,bot_enabled)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,'public',?,'scheduled',1,'open',?,?,?,1,?)`,
  ).run(
    id,
    user.id,
    v.title,
    v.category,
    v.location,
    v.startsAt,
    v.deadline,
    v.capacity,
    v.description,
    v.durationHours,
    stamp,
    randomBytes(24).toString('base64url'),
    v.timezone,
    v.minimumParticipants,
    v.feePolicy,
    Number(v.botEnabled),
  );
  db.prepare('INSERT INTO event_access VALUES(?,?,?)').run(id, user.id, stamp);
  let event = eventRow(db, id)!;
  db.prepare('INSERT INTO event_conditions VALUES(?,?,?,?,?,?)').run(
    id,
    1,
    JSON.stringify(arrangementSnapshot(event)),
    '初始安排',
    user.nickname,
    stamp,
  );
  appendEventAudit(db, event, user, 'event_created', {}, eventSnapshot(event), '', stamp);
  const party = randomBytes(8).toString('hex'),
    person = randomBytes(8).toString('hex'),
    status = allocateActivity([], event.capacity, [person]).get(person)!;
  db.prepare(
    "INSERT INTO roster_parties(id,event_id,manager_id,queue_mode,created_at) VALUES(?,?,?,'individual',?)",
  ).run(party, id, user.id, stamp);
  db.prepare(
    "INSERT INTO attendees(id,event_id,manager_id,user_id,party_id,name,note,payer_kind,status,created_at,updated_at,accepted_conditions_version,confirmation_state) VALUES(?,?,?,?,?,?,'','self',?,?,?,1,'accepted')",
  ).run(person, id, user.id, user.id, party, user.nickname, status, stamp, stamp);
  db.prepare(
    "INSERT INTO attendee_consents(attendee_id,event_id,version,decision,actor_id,actor_name,reason,created_at) VALUES(?,?,1,'accepted',?,?,'报名时接受当前安排',?)",
  ).run(person, id, user.id, user.nickname, stamp);
  const participants = db
    .prepare(
      `SELECT a.id,COALESCE(u.nickname,a.name) AS nickname,a.note,a.status,a.payer_kind,m.nickname AS manager_name,a.withdrawal_requested,a.withdrawal_reason,a.created_at,a.updated_at,a.party_id,p.queue_mode,a.accepted_conditions_version,a.confirmation_state,a.attendance,a.attendance_note,a.arrived_at,a.left_at FROM attendees a LEFT JOIN users u ON u.id=a.user_id JOIN users m ON m.id=a.manager_id LEFT JOIN roster_parties p ON p.id=a.party_id WHERE a.id=?`,
    )
    .all(person);
  event = eventRow(db, id)!;
  appendEventAudit(db, event, user, 'signup', { participants: [] }, { participants }, '', stamp);
  hook(() => createActivityBot(db, now, defaults).publication(id));
  return id;
}
export function registerTimePolls(
  app: FastifyInstance,
  db: DB,
  security: Security,
  now: () => Date,
  defaults: ActivityBotDefaults = {},
) {
  function viewer(request: FastifyRequest) {
    return security.scoped(request);
  }
  app.get('/api/v2/time-polls', async (request) =>
    db.transaction(() => {
      const device = viewer(request),
        user = device.kind === 'member' ? device.id : null;
      const { page, period } = z
        .object({
          page: z.coerce.number().int().min(1).max(10000).default(1),
          period: z.enum(['active', 'history']).default('active'),
        })
        .strict()
        .parse(request.query);
      // Explicit history offers a permanent route to every public retained result.
      const clause = period === 'active' ? "status IN ('open','closed')" : "status IN ('finalized','cancelled')";
      const polls = db
        .prepare(`SELECT * FROM time_polls WHERE ${clause} ORDER BY created_at DESC,id DESC LIMIT 21 OFFSET ?`)
        .all((page - 1) * 20) as PollRow[];
      return TimePollList.parse({
        polls: polls.slice(0, 20).map((p) => pollView(db, p, user, now(), defaults)),
        page,
        hasMore: polls.length > 20,
      });
    })(),
  );
  app.get('/api/v2/time-polls/:id', async (request) =>
    db.transaction(() => {
      const device = viewer(request);
      return pollView(
        db,
        pollRow(db, identifier.parse(request.params).id),
        device.kind === 'member' ? device.id : null,
        now(),
        defaults,
      );
    })(),
  );
  app.get('/api/v2/time-polls/:id/manage', async (request) =>
    db.transaction(() => {
      const user = security.scopedMember(request),
        poll = pollRow(db, identifier.parse(request.params).id, true);
      if (poll.owner_id !== user.id) throw new DomainError('POLL_PERMISSION', '只有發起者可以管理時間投票', 403);
      return pollView(db, poll, user.id, now(), defaults);
    })(),
  );
  const limited = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };
  function write(
    request: FastifyRequest,
    input: unknown,
    id: string | null,
    owner: boolean,
    run: (user: ReturnType<Security['memberWrite']>, hook: (work: () => unknown) => void) => string,
  ) {
    return db
      .transaction(() => {
        const user = security.memberWrite(request),
          key = z.string().uuid().parse(request.headers['idempotency-key']);
        if (id && owner && pollRow(db, id, true).owner_id !== user.id)
          throw new DomainError('POLL_PERMISSION', '只有發起者可以管理時間投票', 403);
        const signature =
          'time-poll:' + hash(request.method + ':' + request.url.split('?')[0] + ':' + JSON.stringify(input));
        const previous = db
          .prepare('SELECT signature,response_json FROM request_results WHERE user_id=? AND request_key=?')
          .get(user.id, key) as { signature: string; response_json: string } | undefined;
        if (previous) {
          if (previous.signature !== signature)
            throw new DomainError('REQUEST_CONFLICT', '這個操作編號已用於另一份內容', 409);
          const result = TimePollResult.parse(JSON.parse(previous.response_json));
          if (!id && pollRow(db, result.id, true).owner_id !== user.id)
            throw new DomainError('POLL_NOT_FOUND', '找不到原操作', 404);
          return result;
        }
        const hook = (work: () => unknown) => {
          try {
            db.transaction(work)();
          } catch {
            request.log.error({ pollId: id }, 'Poll bot hook failed; required business preserved');
          }
        };
        const target = run(user, hook),
          poll = pollRow(db, target, true),
          result = TimePollResult.parse({
            id: target,
            revision: poll.revision,
            vote_revision: poll.vote_revision,
            event_id: poll.event_id,
            removed: poll.status === 'deleted',
          });
        db.prepare('INSERT INTO request_results VALUES(?,?,?,?,?,?)').run(
          user.id,
          key,
          signature,
          JSON.stringify(result),
          200,
          legacyStamp(now()),
        );
        return result;
      })
      .immediate();
  }
  app.post('/api/v2/time-polls', limited, async (request) => {
    const input = CreateTimePoll.parse(request.body);
    return write(request, input, null, true, (user, hook) => {
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
        now(),
        true,
      );
      if (new Set(starts).size !== starts.length) throw new DomainError('POLL_DUPLICATE', '候選時段不能重複', 400);
      const candidates = starts.map((starts_at) => ({ starts_at }));
      if (candidates.some((o) => !pollAvailable(o, definition, now())))
        throw new DomainError('POLL_EXPIRED', '候選已過期，請選擇尚未失效的日期或時間', 400);
      pollDeadline(deadline, candidates, definition, now());
      const id = randomBytes(8).toString('hex'),
        stamp = legacyStamp(now());
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
      record(db, id, user.id, 'created', { options: starts, deadline, time_mode: input.time_mode }, stamp);
      hook(() => announcePoll(db, pollRow(db, id), now(), defaults));
      return id;
    });
  });
  app.post('/api/v2/time-polls/:id/votes', limited, async (request) => {
    const { id } = identifier.parse(request.params),
      input = VoteTimePoll.parse(request.body);
    return write(request, input, id, false, (user) => {
      const poll = pollRow(db, id);
      changed(poll, input.revision);
      if (poll.status !== 'open' || Date.parse(poll.deadline) <= now().getTime())
        throw new DomainError('POLL_CLOSED', '投票已截止，請查看最終安排', 409);
      const options = pollOptions(db, id),
        active = new Set(options.filter((o) => pollAvailable(o, poll, now())).map((o) => o.id)),
        submitted = new Set(input.choices.map((c) => c.option_id));
      if (!active.size) throw new DomainError('POLL_EXPIRED', '候選時段均已過期', 409);
      if (
        submitted.size !== input.choices.length ||
        [...active].some((id) => !submitted.has(id)) ||
        [...submitted].some((id) => !options.some((o) => o.id === id))
      )
        throw new DomainError('POLL_OPTIONS_CHANGED', '請為每個未過期候選填寫選擇，並核對最新版', 409);
      const stamp = legacyStamp(now());
      db.prepare(
        'INSERT INTO time_poll_ballots VALUES(?,?,?) ON CONFLICT(poll_id,user_id) DO UPDATE SET updated_at=excluded.updated_at',
      ).run(id, user.id, stamp);
      for (const c of input.choices)
        if (active.has(c.option_id))
          db.prepare(
            'INSERT INTO time_poll_votes VALUES(?,?,?,?) ON CONFLICT(poll_id,user_id,option_id) DO UPDATE SET choice=excluded.choice',
          ).run(id, user.id, c.option_id, c.choice);
      db.prepare('UPDATE time_polls SET vote_revision=vote_revision+1 WHERE id=?').run(id);
      return id;
    });
  });
  app.post('/api/v2/time-polls/:id/manage', limited, async (request) => {
    const { id } = identifier.parse(request.params),
      input = ManageTimePoll.parse(request.body);
    return write(request, input, id, true, (user, hook) => {
      const poll = pollRow(db, id);
      changed(poll, input.revision);
      const stamp = legacyStamp(now()),
        action = input.action;
      const details: z.infer<typeof PollHistoryDetails> = { reason: input.reason };
      const skip = (message: string) =>
        db
          .prepare(
            "UPDATE bot_outbox SET status='skipped',last_error=? WHERE poll_id=? AND status IN ('pending','sending')",
          )
          .run(message, id);
      if (action === 'remove') {
        db.prepare("UPDATE time_polls SET status='deleted',bot_enabled=0,revision=revision+1 WHERE id=?").run(id);
        skip('时间投票已删除');
        record(db, id, user.id, action, { previous_status: poll.status }, stamp);
        return id;
      }
      if (!['open', 'closed'].includes(poll.status)) throw new DomainError('POLL_FINAL', '時間投票已定案或取消', 409);
      if (action === 'close') db.prepare("UPDATE time_polls SET status='closed' WHERE id=?").run(id);
      else if (action === 'extend') {
        const deadline = activityDate(input.deadline);
        pollDeadline(deadline, pollOptions(db, id), poll, now());
        db.prepare("UPDATE time_polls SET deadline=?,status='open' WHERE id=?").run(deadline, id);
        details.deadline = deadline;
      } else if (action === 'cancel') {
        if (!input.reason) throw new DomainError('POLL_REASON', '請填寫取消投票原因', 400);
        db.prepare("UPDATE time_polls SET status='cancelled',reason=?,decided_at=? WHERE id=?").run(
          input.reason,
          stamp,
          id,
        );
      } else if (action === 'bot_sync') {
        db.prepare('UPDATE time_polls SET bot_enabled=? WHERE id=?').run(Number(input.bot_enabled), id);
        details.bot_enabled = input.bot_enabled;
        if (input.bot_enabled) hook(() => announcePoll(db, pollRow(db, id), now(), defaults, 'sync:' + poll.revision));
        else skip('投票已关闭群同步');
      } else if (action === 'bot_retry') {
        if (!pollShareable(poll, now())) throw new DomainError('POLL_BOT_RETRY', '目前投票未開放群同步，無法重送', 409);
        const row = db
          .prepare("SELECT status,sent_at,simulated_at,last_error FROM bot_outbox WHERE id=? AND poll_id=? AND channel='group'")
          .get(input.outbox_id, id) as { status: string; sent_at:string|null; simulated_at: string | null; last_error: string } | undefined;
        const blocked=row?deliveryRetryBlocker(row):'找不到群通知紀錄';
        if (blocked)throw new DomainError('POLL_BOT_RETRY', blocked, 409);
        if (db.prepare("SELECT 1 FROM bot_outbox WHERE poll_id=? AND status IN ('pending','sending')").get(id))
          throw new DomainError('POLL_BOT_PENDING', '已有通知等待發送', 409);
        if (!announcePoll(db, poll, now(), defaults, 'retry:' + randomUUID().replaceAll('-', '')))
          throw new DomainError('POLL_BOT_DISABLED', '管理員尚未開啟此類通知或未設定目標群', 409);
      } else if (action === 'finalize') {
        if (input.base_vote_revision !== poll.vote_revision)
          throw new DomainError('POLL_VOTES_CHANGED', '票數已有更新，請重新核對後定案', 409);
        const options = pollOptions(db, id),
          selected = options.find((o) => o.id === input.option_id);
        if (!selected) throw new DomainError('POLL_OPTION', '請選擇本次投票的候選時段', 400);
        if (!pollAvailable(selected, poll, now())) throw new DomainError('POLL_EXPIRED', '候選時段已過期', 409);
        const counts = pollTotals(db, poll),
          support = counts[selected.id]!.yes,
          max = Math.max(0, ...options.filter((o) => pollAvailable(o, poll, now())).map((o) => counts[o.id]!.yes));
        if ((support === 0 || support < poll.minimum_participants || support < max) && !input.reason)
          throw new DomainError('POLL_REASON', '未選最高票或未達最低人數，請填寫仍決定舉行的原因', 400);
        const start = poll.time_mode === 'date' ? activityDate(input.starts_at ?? '') : selected.starts_at,
          duration = poll.time_mode === 'date' ? input.duration_hours : poll.duration_hours;
        if (
          poll.time_mode === 'date' &&
          pollDate({ starts_at: start }, poll.timezone) !== pollDate(selected, poll.timezone)
        )
          throw new DomainError('POLL_DATE', '開始時間必須在選定的候選日期內', 400);
        if (!duration) throw new DomainError('POLL_DURATION', '請選擇持續時間（1–24 小時）', 400);
        const deadline = activityDate(input.registration_deadline);
        if (!(now().getTime() < Date.parse(deadline) && deadline <= start))
          throw new DomainError('POLL_REGISTRATION_DEADLINE', '報名截止須晚於現在，且不能晚於選定的開始時間', 400);
        const event = finalizedEvent(db, poll, user, start, deadline, duration, now, defaults, hook),
          respondents = (
            db.prepare('SELECT count(*) AS n FROM time_poll_ballots WHERE poll_id=?').get(id) as { n: number }
          ).n;
        db.prepare(
          "UPDATE time_polls SET status='finalized',event_id=?,selected_option_id=?,reason=?,decided_at=?,result_json=?,respondent_count=? WHERE id=?",
        ).run(event, selected.id, input.reason, stamp, JSON.stringify(counts), respondents, id);
        for (const row of db
          .prepare('SELECT user_id FROM time_poll_ballots WHERE poll_id=? AND user_id!=?')
          .all(id, user.id) as { user_id: string }[])
          db.prepare(
            "INSERT INTO notifications(user_id,event_id,kind,message,created_at) VALUES(?,?,'time_poll_finalized',?,?)",
          ).run(row.user_id, event, poll.title + ' 的时间已确定，请查看安排后报名', stamp);
        Object.assign(details, {
          event_id: event,
          option_id: selected.id,
          counts,
          starts_at: start,
          duration_hours: duration,
        });
      }
      if (['close', 'cancel', 'finalize'].includes(action)) skip('投票已截止、定案或取消');
      db.prepare('UPDATE time_polls SET revision=revision+1 WHERE id=?').run(id);
      record(db, id, user.id, action, details, stamp);
      return id;
    });
  });
}
