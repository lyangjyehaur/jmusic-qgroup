import { z } from 'zod';
import { LegacyRequestCheck, LegacyRequestReceipt } from './legacy-local';
import { ManageTimePoll, VoteTimePoll, TimePoll, PollCounts } from './time-polls';
const revision = z.number().int().nonnegative();
export function legacyTimePollId(request: z.infer<typeof LegacyRequestCheck>) {
  const match = /^\/api\/time-polls\/([A-Za-z0-9_-]{1,80})(\/votes)?$/.exec(request.path);
  if (!match || (match[2] ? request.method !== 'PUT' : request.method !== 'PATCH')) throw Error('這份原請求不是已支援的時間投票操作。');
  return { id: match[1]!, vote: !!match[2] };
}
// Known inactive fields remain in the original signature. Only active command fields are decoded.
const OriginalManage = z.object({ action: z.enum(['close','extend','cancel','remove','bot_sync','bot_retry','finalize']), base_revision: revision, reason: z.unknown().optional(), deadline: z.unknown().optional(), bot_enabled: z.unknown().optional(), outbox_id: z.unknown().optional(), base_vote_revision: z.unknown().optional(), option_id: z.unknown().optional(), registration_deadline: z.unknown().optional(), accept_terms: z.unknown().optional(), starts_at: z.unknown().optional(), duration_hours: z.unknown().optional() }).strict();
export function decodeLegacyTimePoll(request: z.infer<typeof LegacyRequestCheck>, current: { time_mode: 'date'|'exact'; bot_enabled: number }) {
  const route = legacyTimePollId(request);
  if (route.vote) {
    const raw = VoteTimePoll.omit({revision:true}).extend({base_revision:revision}).strict().parse(request.data);
    return { ...route, kind: 'vote' as const, input: VoteTimePoll.parse({revision:raw.base_revision, choices:raw.choices}) };
  }
  const raw = OriginalManage.parse(request.data), common = { action:raw.action, revision:raw.base_revision, confirm:true, reason: raw.action === 'remove' ? '' : raw.reason === undefined ? '' : raw.reason };
  const input = ManageTimePoll.parse({...common,
    ...(raw.action === 'extend' ? {deadline:raw.deadline} : raw.action === 'bot_sync' ? {bot_enabled:raw.bot_enabled === undefined ? !!current.bot_enabled : raw.bot_enabled} : raw.action === 'bot_retry' ? {outbox_id:raw.outbox_id} : raw.action === 'finalize' ? {base_vote_revision:raw.base_vote_revision,option_id:raw.option_id,registration_deadline:raw.registration_deadline,accept_terms:raw.accept_terms,...(current.time_mode === 'date' ? {starts_at:raw.starts_at,duration_hours:raw.duration_hours} : {})} : {})});
  return {...route, kind:'manage' as const, input};
}
export const LegacyTimePollRetry = LegacyRequestCheck.extend({confirm:z.literal(true),recovery_token:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const LegacyTimePollFinalization = z.object({starts_at:z.string(),duration_hours:z.number().int().min(1).max(24),registration_deadline:z.string(),counts:z.record(z.string(),PollCounts),respondent_count:revision}).strict();
export const LegacyTimePollInspection = z.discriminatedUnion('state',[
  z.object({state:z.literal('committed'),receipt:LegacyRequestReceipt}).strict(),
  z.object({state:z.literal('retryable'),current:TimePoll,command:z.union([VoteTimePoll,ManageTimePoll]),finalization:LegacyTimePollFinalization.optional(),group_preview:z.string(),recovery_token:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
]);
