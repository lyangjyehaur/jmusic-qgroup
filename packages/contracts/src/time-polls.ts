import { z } from 'zod';
import { ActivityCategory } from './activity-arrangements';
const text = (max: number, required = false) =>
  z
    .string()
    .trim()
    .refine((v) => Array.from(v).length <= max && (!required || !!v));
const id = z.string().min(1).max(80),
  revision = z.number().int().nonnegative();
export const PollChoice = z.enum(['yes', 'maybe', 'no']);
export const PollCounts = z.object({ yes: revision, maybe: revision, no: revision });
export const PollDefinition = z.object({
  title: text(60, true),
  category: ActivityCategory,
  location: text(120, true),
  description: text(3000).default(''),
  timezone: text(100, true),
  capacity: z.number().int().min(0).max(500),
  minimum_participants: z.number().int().min(0).max(500).default(0),
  fee_policy: text(1000).default(''),
  deadline: text(40, true),
  bot_enabled: z.boolean().default(true),
  visibility: z.literal('public').default('public'),
});
export const CreateTimePoll = z.discriminatedUnion('time_mode', [
  PollDefinition.extend({
    time_mode: z.literal('date'),
    options: z.array(z.object({ date: text(10, true) }).strict()).min(2),
  }).strict(),
  PollDefinition.extend({
    time_mode: z.literal('exact'),
    duration_hours: z.number().int().min(1).max(24),
    options: z.array(z.object({ starts_at: text(40, true) }).strict()).min(2),
  }).strict(),
]);
export const VoteTimePoll = z
  .object({ revision, choices: z.array(z.object({ option_id: id, choice: PollChoice }).strict()) })
  .strict();
const command = z.object({ revision, reason: text(200).default(''), confirm: z.literal(true) });
export const ManageTimePoll = z.discriminatedUnion('action', [
  command.extend({ action: z.literal('close') }).strict(),
  command.extend({ action: z.literal('extend'), deadline: text(40, true) }).strict(),
  command.extend({ action: z.literal('cancel') }).strict(),
  command.extend({ action: z.literal('remove') }).strict(),
  command.extend({ action: z.literal('bot_sync'), bot_enabled: z.boolean() }).strict(),
  command.extend({ action: z.literal('bot_retry'), outbox_id: z.number().int().positive() }).strict(),
  command
    .extend({
      action: z.literal('finalize'),
      base_vote_revision: revision,
      option_id: id,
      accept_terms: z.literal(true),
      registration_deadline: text(40, true),
      starts_at: text(40, true).optional(),
      duration_hours: z.number().int().min(1).max(24).optional(),
    })
    .strict(),
]);
export const TimePollResult = z.object({
  id,
  revision,
  vote_revision: revision,
  event_id: id.nullable(),
  removed: z.boolean(),
});
export const PollOption = PollCounts.extend({
  id,
  date: z.string(),
  starts_at: z.string().nullable(),
  ends_at: z.string().nullable(),
  expired: z.boolean(),
  can_vote: z.boolean(),
});
export const PollHistoryDetails = z.object({
  reason: z.string().optional(),
  options: z.array(z.string()).optional(),
  deadline: z.string().optional(),
  time_mode: z.enum(['date', 'exact']).optional(),
  previous_status: z.string().optional(),
  bot_enabled: z.boolean().optional(),
  event_id: z.string().optional(),
  option_id: z.string().optional(),
  counts: z.record(z.string(), PollCounts).optional(),
  starts_at: z.string().optional(),
  duration_hours: z.number().optional(),
});
export const TimePoll = z.object({
  id,
  title: z.string(),
  category: z.string(),
  location: z.string(),
  description: z.string(),
  timezone: z.string(),
  time_mode: z.enum(['date', 'exact']),
  duration_hours: z.number().nullable(),
  capacity: z.number(),
  minimum_participants: z.number(),
  fee_policy: z.string(),
  deadline: z.string(),
  status: z.enum(['open', 'closed', 'cancelled', 'finalized', 'deleted']),
  revision,
  vote_revision: revision,
  created_at: z.string(),
  decided_at: z.string().nullable(),
  selected_option_id: id.nullable(),
  event_id: id.nullable(),
  reason: z.string(),
  event_deleted: z.boolean().optional(),
  event_time: z.object({ starts_at: z.string(), ends_at: z.string(), timezone: z.string().nullable() }).optional(),
  time_poll: z.literal(true),
  is_owner: z.boolean(),
  can_remove: z.boolean(),
  can_manage: z.boolean(),
  can_vote: z.boolean(),
  my_choices: z.record(z.string(), PollChoice),
  has_voted: z.boolean(),
  options: z.array(PollOption),
  leading_option_ids: z.array(id),
  respondent_count: revision,
  owner_name: z.string(),
  bot_enabled: z.boolean().optional(),
  bot_feature_enabled: z.boolean().optional(),
  bot_notice_enabled: z.boolean().optional(),
  bot_delivery: z
    .array(
      z.object({
        id: z.number().int(),
        status: z.string(),
        state: z.string(),
        attempts: revision,
        last_error: z.string(),
        created_at: z.string(),
        sent_at: z.string().nullable(),
        simulated_at: z.string().nullable(),
      }),
    )
    .optional(),
  respondents: z
    .array(z.object({ name: z.string(), updated_at: z.string(), choices: z.record(z.string(), PollChoice) }))
    .optional(),
  history: z.array(z.object({ action: z.string(), details: PollHistoryDetails, created_at: z.string() })).optional(),
});
export const TimePollList = z.object({
  polls: z.array(TimePoll),
  page: z.number().int().positive(),
  hasMore: z.boolean(),
});
