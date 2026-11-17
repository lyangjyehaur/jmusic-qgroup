import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  BOT_KINDS,
  BotPolicyCommand,
  BotPolicyResult,
  BotPolicyView,
  type BotPolicy,
} from '@qgroup/contracts';
import { botGroupStatus, currentBotTarget, openDatabase, readBotPolicy, type DB } from '@qgroup/database';
import { botLocalTime, defaultBotPolicy, DomainError, validateBotPolicy } from '@qgroup/domain';
import { hash } from './security';
import type { AdminSecurity } from './admin-security';
import {
  activityBotPolicy,
  buildActivityBotMessage,
  createActivityBot,
  type ActivityBotDefaults,
} from './activity-bot';
import { eventRow, legacyStamp, type EventRow } from './activity-arrangements';
import { composeTimePollBotMessage } from './time-poll-bot';
import type { PollRow } from './time-poll-context';
const canonical = (value: unknown): string =>
  JSON.stringify(
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => [key, JSON.parse(canonical(value))]),
        )
      : Array.isArray(value)
        ? value.map((v) => JSON.parse(canonical(v)))
        : (value ?? null),
  );
export function adminBotView(db: DB, defaults: ActivityBotDefaults = {}) {
  const current = activityBotPolicy(db, defaults),
    history = db
      .prepare(
        'SELECT revision,config_json,created_at,action FROM bot_settings_history ORDER BY revision DESC LIMIT 21',
      )
      .all() as {
      revision: number;
      config_json: string;
      created_at: string;
      action: string;
    }[];
  return BotPolicyView.parse({
    ...current,
    history: history.slice(0, 20).map((row, index) => {
      const before = history[index + 1] ? JSON.parse(history[index + 1]!.config_json) : {},
        after = JSON.parse(row.config_json);
      return {
        revision: row.revision,
        created_at: row.created_at,
        action: row.action,
        changes: [...new Set([...Object.keys(before), ...Object.keys(after)])]
          .filter((key) => canonical(before[key]) !== canonical(after[key]))
          .sort(),
      };
    }),
    runtime: db.prepare('SELECT applied_revision,checked_at FROM bot_runtime WHERE id=1').get(),
    group_status: botGroupStatus(db, current.config),
  });
}
export function previewBotPolicy(
  config: BotPolicy,
  kind: keyof typeof import('@qgroup/contracts').BOT_KINDS,
  now: Date,
  defaults: ActivityBotDefaults = {},
) {
  const date = new Date(now.getTime() + 7 * 86400000),
    day = botLocalTime(date.toISOString(), 'Asia/Taipei').slice(0, 10),
    starts_at = day + 'T18:00:00+08:00',
    deadline = new Date(Date.parse(starts_at) - 86400000).toISOString();
  const sample: EventRow = {
    id: 'preview',
    owner_id: '',
    title: '周末聚餐',
    category: '聚餐',
    location: '示例餐厅',
    starts_at,
    deadline,
    created_at: legacyStamp(now),
    capacity: 20,
    description: '示例活动说明',
    duration_hours: 2,
    status: 'open',
    revision: 2,
    withdrawal_deadline: null,
    visibility: 'public',
    lifecycle: 'scheduled',
    registration_open: Number(kind !== 'registration_paused'),
    actual_started_at: null,
    actual_ended_at: null,
    archived_at: null,
    timezone: 'Asia/Taipei',
    minimum_participants: 4,
    formation_state: 'pending',
    fee_policy: '按实际消费 AA',
    conditions_version: 2,
    change_summary: '集合时间调整',
    cancellation_reason: '天气原因',
    bot_enabled: 1,
    draft_join_owner: 0,
  };
  if (kind === 'time_poll_published') {
    const poll: PollRow = {
      ...sample,
      timezone: 'Asia/Taipei',
      time_mode: 'exact',
      duration_hours: 2,
      vote_revision: 0,
      decided_at: null,
      selected_option_id: null,
      event_id: null,
      reason: '',
      result_json: null,
      respondent_count: 0,
    };
    const planned = composeTimePollBotMessage(
      poll,
      Array.from({ length: 3 }, (_, offset) => ({
        starts_at: new Date(Date.parse(starts_at) + offset * 86400000).toISOString(),
      })),
      config,
      defaults,
    );
    return { text: planned.text, markdown: planned.markdown };
  }
  // The sample ID must never resolve real event attendees or settlement details.
  const isolated = openDatabase(':memory:');
  try {
    const planned = buildActivityBotMessage(isolated, sample, kind, config, now, defaults);
    if (!planned) throw Error('Bot preview unavailable');
    return { text: planned.text, markdown: planned.markdown };
  } finally {
    isolated.close();
  }
}
export function registerAdminBot(
  app: FastifyInstance,
  db: DB,
  admin: AdminSecurity,
  now: () => Date,
  defaults: ActivityBotDefaults = {},
) {
  const options = {
    bodyLimit: 512 * 1024,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  };
  app.get('/api/v2/admin/bot', async (request) =>
    db.transaction(() => {
      admin.authority(request);
      z.object({}).strict().parse(request.query);
      return adminBotView(db, defaults);
    })(),
  );
  app.post('/api/v2/admin/bot/preview', options, async (request) =>
    db.transaction(() => {
      admin.authority(request, true);
      const input = z
        .object({
          config: BotPolicyCommand.options[0].shape.config,
          kind: z.string(),
        })
        .strict()
        .parse(request.body);
      const config = validateBotPolicy(input.config);
      return previewBotPolicy(
        config,
        z
          .enum(Object.keys(BOT_KINDS) as [keyof typeof BOT_KINDS, ...(keyof typeof BOT_KINDS)[]])
          .parse(input.kind),
        now(),
        defaults,
      );
    })(),
  );
  app.post('/api/v2/admin/bot', options, async (request) =>
    db
      .transaction(() => {
        const access = admin.authority(request, true),
          input = BotPolicyCommand.parse(request.body),
          key = z.string().uuid().parse(request.headers['idempotency-key']),
          signature = hash('v2:bot-policy:' + canonical(input));
        const prior = db
          .prepare('SELECT signature,response_json FROM auth_requests WHERE token_hash=? AND request_key=?')
          .get(access.receiptScope, key) as { signature: string; response_json: string } | undefined;
        if (prior) {
          if (prior.signature !== signature)
            throw new DomainError('REQUEST_CONFLICT', '這個操作編號已用於其他內容', 409);
          return BotPolicyResult.parse(JSON.parse(prior.response_json));
        }
        const before = activityBotPolicy(db, defaults);
        if (input.revision !== before.revision)
          throw new DomainError('BOT_POLICY_CHANGED', 'bot 設定已有更新，請核對最新版後重新確認', 409);
        let raw: unknown;
        if (input.command === 'revert') {
          const previous = db
            .prepare('SELECT config_json FROM bot_settings_history WHERE revision=?')
            .get(input.revision - 1) as { config_json: string } | undefined;
          if (!previous) throw new DomainError('BOT_NO_PREVIOUS', '沒有可恢復的上一版設定', 409);
          raw = JSON.parse(previous.config_json);
          validateBotPolicy({ ...defaultBotPolicy(), ...(raw as object) });
        } else raw = validateBotPolicy(input.config);
        const stored = db.prepare('SELECT config_json FROM bot_settings WHERE id=1').get() as {
            config_json: string;
          },
          changed = canonical(JSON.parse(stored.config_json)) !== canonical(raw);
        if (changed) {
          admin.preserve(request);
          const stamp = legacyStamp(now()),
            oldTarget = currentBotTarget(db, before.config);
          db.prepare('UPDATE bot_settings SET revision=revision+1,config_json=?,updated_at=? WHERE id=1').run(
            canonical(raw),
            stamp,
          );
          db.prepare('INSERT INTO bot_settings_history VALUES(?,?,?,?,?)').run(
            before.revision + 1,
            canonical(raw),
            stamp,
            hash(access.userId ?? access.actorRef).slice(0, 16),
            input.command === 'revert' ? 'revert' : 'save',
          );
          const after = activityBotPolicy(db, defaults).config,
            newTarget = currentBotTarget(db, after);
          if (oldTarget !== newTarget)
            db.prepare(
              "UPDATE bot_outbox SET status='skipped',last_error='通知目标群已变更，旧通知作废' WHERE channel='group' AND status IN ('pending','sending')",
            ).run();
          db.prepare(
            "UPDATE bot_outbox SET retry_at=NULL,last_error='' WHERE status='pending' AND last_error='等待允许发送的时间'",
          ).run();
          for (const kind of Object.keys(BOT_KINDS))
            if (!after.enabled || !after.broadcast_kinds.includes(kind as keyof typeof BOT_KINDS))
              db.prepare(
                "UPDATE bot_outbox SET status='skipped',last_error='后台已关闭此类通知' WHERE channel='group' AND kind=? AND status IN ('pending','sending')",
              ).run(kind);
          const keys = [
            'enabled',
            'broadcast_kinds',
            'schedule_enabled',
            'deadline_hours',
            'estimated_over_delay_minutes',
          ] as const;
          if (
            oldTarget !== newTarget ||
            keys.some((key) => canonical(before.config[key]) !== canonical(after[key]))
          ) {
            const bot = createActivityBot(db, now, defaults);
            for (const row of db
              .prepare("SELECT id FROM events WHERE bot_enabled=1 AND lifecycle IN ('scheduled','ongoing')")
              .all() as { id: string }[])
              bot.schedule(eventRow(db, row.id)!);
          }
        }
        const result = BotPolicyResult.parse({
          revision: readBotPolicy(db).revision,
          command: input.command,
          changed,
        });
        db.prepare('INSERT INTO auth_requests VALUES(?,?,?,?,?)').run(
          access.receiptScope,
          key,
          signature,
          JSON.stringify(result),
          now().toISOString(),
        );
        return result;
      })
      .immediate(),
  );
}
