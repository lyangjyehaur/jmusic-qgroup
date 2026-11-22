import { ActivityPath } from '@qgroup/contracts/http-paths';
import { withApiError } from './error-display';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DB } from '@qgroup/database';
import { TimePollsQuery,
  CreateTimePoll,
  ManageTimePoll,
  TimePollList,
  TimePollResult,
  VoteTimePoll,
} from '@qgroup/contracts';
import { DomainError } from '@qgroup/domain';
import { z } from 'zod';
import {
  legacyStamp,
} from './activity-arrangements';
import type { ActivityBotDefaults } from './activity-bot';
import { hash, type Security } from './security';
import { preparePollVote, executePollVote, preparePollManagement, executePollManagement, preparePollCreation, executePollCreation } from './time-poll-command';
import { priorCreateIntent,recordCreateIntent } from './create-intents';
import {
  pollRow,
  pollView,
  type PollRow,
} from './time-poll-context';

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
      const { page, period } = TimePollsQuery
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
        pollRow(db, ActivityPath.parse(request.params).id),
        device.kind === 'member' ? device.id : null,
        now(),
        defaults,
      );
    })(),
  );
  app.get('/api/v2/time-polls/:id/manage', async (request) =>
    db.transaction(() => {
      const user = security.scopedMember(request),
        poll = pollRow(db, ActivityPath.parse(request.params).id, true);
      if (poll.owner_id !== user.id) throw withApiError(new DomainError('POLL_PERMISSION', '只有發起者可以管理時間投票', 403));
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
          throw withApiError(new DomainError('POLL_PERMISSION', '只有發起者可以管理時間投票', 403));
        const signature =
          'time-poll:' + hash(request.method + ':' + request.url.split('?')[0] + ':' + JSON.stringify(input));
        const previous = db
          .prepare('SELECT signature,response_json FROM request_results WHERE user_id=? AND request_key=?')
          .get(user.id, key) as { signature: string; response_json: string } | undefined;
        if (previous) {
          if (previous.signature !== signature)
            throw withApiError(new DomainError('REQUEST_CONFLICT', '這個操作編號已用於另一份內容', 409));
          const result = TimePollResult.parse(JSON.parse(previous.response_json));
          if (!id && pollRow(db, result.id, true).owner_id !== user.id)
            throw withApiError(new DomainError('POLL_NOT_FOUND', '找不到原操作', 404));
          return result;
        }
        const hook = (work: () => unknown) => {
          try {
            db.transaction(work)();
          } catch {
            request.log.error({ pollId: id }, 'Poll bot hook failed; required business preserved');
          }
        };
        const intent=!id&&input&&typeof input==='object'&&'client_intent' in input&&typeof input.client_intent==='string'?input.client_intent:undefined;
        const oldIntent=priorCreateIntent<z.infer<typeof TimePollResult>>(db,user.id,'poll',intent,input);
        const target = oldIntent?.id??run(user, hook),
          poll = pollRow(db, target, true),
          result = TimePollResult.parse({
            id: target,
            revision: poll.revision,
            vote_revision: poll.vote_revision,
            event_id: poll.event_id,
            removed: poll.status === 'deleted',
          });
        if(!oldIntent)recordCreateIntent(db,user.id,'poll',intent,input,result,legacyStamp(now()));
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
      const time = now();
      return executePollCreation(db, preparePollCreation(input, time), user, time, defaults, hook);
    });
  });
  app.post('/api/v2/time-polls/:id/votes', limited, async (request) => {
    const { id } = ActivityPath.parse(request.params), input = VoteTimePoll.parse(request.body);
    return write(request, input, id, false, user => { const time = now(); return executePollVote(db, preparePollVote(db, pollRow(db, id), input, time), user, time); });
  });
  app.post('/api/v2/time-polls/:id/manage', limited, async (request) => {
    const { id } = ActivityPath.parse(request.params), input = ManageTimePoll.parse(request.body);
    return write(request, input, id, true, (user, hook) => { const time = now(); return executePollManagement(db, preparePollManagement(db, pollRow(db, id), user, input, time, defaults), user, time, defaults, hook); });
  });
}
