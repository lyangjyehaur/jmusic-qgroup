import { z } from 'zod';
import legacyTimezones from '../../domain/src/legacy-timezones.json';
const allowedTimezones = new Set(legacyTimezones);
export const BOT_KINDS = {
  time_poll_published: '活动时间投票',
  activity_published: '活动发起',
  formation_confirmed: '已成团',
  conditions_changed: '安排变更',
  event_started: '活动开始',
  event_finished: '活动结束',
  event_cancelled: '活动取消',
  settlement_updated: '结算发布',
  deadline_reminder: '报名即将截止',
  estimated_over_reminder: '活动时间已到',
  registration_paused: '暂停报名',
  registration_resumed: '恢复报名',
  finance_closed: '账务已结清',
  finance_reopened: '账务重新核对',
  ownership_changed: '管理交接',
  registration_added: '有人报名',
  registration_changed: '退出／候补递补',
} as const;
export type BotKind = keyof typeof BOT_KINDS;
export const BotGroup = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    name: z.string().refine((value) => Array.from(value).length <= 60 && !/[\x00-\x1f]/.test(value)),
    replies: z.boolean(),
    broadcast: z.boolean(),
  })
  .strict();
export type BotGroup = z.infer<typeof BotGroup>;
export const BotGroups = z
  .array(BotGroup)
  .max(100)
  .refine(
    (groups) =>
      new Set(groups.map((g) => g.id)).size === groups.length && groups.filter((g) => g.broadcast).length <= 1,
  )
  .nullable();
const clock = z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/);
export const BotPolicy = z
  .object({
    enabled: z.boolean(),
    replies_enabled: z.boolean(),
    dry_run: z.boolean().nullable(),
    broadcast_kinds: z
      .array(z.enum(Object.keys(BOT_KINDS) as [BotKind, ...BotKind[]]))
      .refine((kinds) => new Set(kinds).size === kinds.length),
    schedule_enabled: z.boolean(),
    deadline_hours: z.number().int().min(1).max(720),
    estimated_over_delay_minutes: z.number().int().min(0).max(1440),
    quiet_enabled: z.boolean(),
    quiet_start: clock,
    quiet_end: clock,
    timezone: z
      .string()
      .max(80)
      .refine((zone) => allowedTimezones.has(zone)),
    min_interval_seconds: z.number().int().min(0).max(3600),
    templates: z.record(
      z.string().refine((key) => Object.hasOwn(BOT_KINDS, key.endsWith('@md') ? key.slice(0, -3) : key)),
      z.string(),
    ),
    groups: BotGroups,
  })
  .strict()
  .refine((config) => !config.quiet_enabled || config.quiet_start !== config.quiet_end);
export type BotPolicy = z.infer<typeof BotPolicy>;
export const BotPolicyCommand = z.discriminatedUnion('command', [
  z
    .object({
      command: z.literal('save'),
      revision: z.number().int().nonnegative(),
      config: BotPolicy,
      confirm: z.literal(true),
    })
    .strict(),
  z
    .object({ command: z.literal('revert'), revision: z.number().int().nonnegative(), confirm: z.literal(true) })
    .strict(),
]);
export type BotPolicyCommand = z.infer<typeof BotPolicyCommand>;
export const BotPolicyResult = z
  .object({ revision: z.number().int().nonnegative(), command: z.enum(['save', 'revert']), changed: z.boolean() })
  .strict();
export const BotPolicyView = z.object({
  revision: z.number().int().nonnegative(),
  config: BotPolicy,
  updated_at: z.string(),
  history: z.array(
    z.object({ revision: z.number().int(), created_at: z.string(), action: z.string(), changes: z.array(z.string()) }),
  ),
  runtime: z.object({ applied_revision: z.number().int().nullable(), checked_at: z.string().nullable() }),
  group_status: z.object({
    inherited: z.boolean(),
    groups: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        replies: z.boolean(),
        broadcast: z.boolean(),
        configured: z.boolean(),
        reference: z.string(),
        deployment_default: z.boolean(),
        first_seen: z.string().nullable(),
        last_seen: z.string().nullable(),
        last_event: z.string(),
        membership: z.string(),
      }),
    ),
    ignores: z.array(z.object({ group_id: z.string(), reason: z.string(), created_at: z.string() })),
  }),
});
export type BotPolicyView = z.infer<typeof BotPolicyView>;

// Preview keeps its existing validation order: body shape, policy, then kind.
export const PreviewBotPolicy = /* @__PURE__ */ (() => z.object({
  config: BotPolicyCommand.options[0].shape.config,
  kind: z.string(),
}).strict())();
