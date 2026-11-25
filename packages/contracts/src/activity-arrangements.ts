import { z } from 'zod';
import { originalString } from './legacy-values';
import { CreateIntent } from './create-intents';

// Values are part of the existing SQLite / Python bot protocol.
export const ActivityCategory = z.enum(['约K', '聚餐', '运动', '出游', '游戏', '其他']);
const text = (maximum: number, required = false) => z.string().transform(value=>originalString(value) as string).refine(value => Array.from(value).length <= maximum && (!required || value.length > 0));
export const ActivityArrangementInput = z.object({
  title: text(60, true), category: ActivityCategory, location: text(120, true),
  startsAt: text(40, true), deadline: text(40, true), capacity: z.number().int().min(0).max(500),
  description: text(3000).default(''), durationHours: z.number().int().min(1).max(24).default(3),
  withdrawalDeadline: text(40, true).nullable().default(null),
  visibility: z.enum(['public', 'invitation']).default('public'), timezone: text(100, true).nullable().default('Asia/Shanghai'),
  minimumParticipants: z.number().int().min(0).max(500).default(0), feePolicy: text(1000).default(''),
  botEnabled: z.boolean().default(false), joinOwner: z.boolean().default(true),
}).strict();
export const ActivityDraft = z.object({
  id: z.string(), revision: z.number().int().min(0), ownerName: z.string(), isOwner: z.boolean(),
  canEdit: z.boolean(), canRemove: z.boolean(), removalBlocker: z.string(),
  values: ActivityArrangementInput,
});
// Omitted flags retain the original draft payload and its create-intent signature.
export const CreateActivityDraft = z.object({ values: ActivityArrangementInput,clientIntent:CreateIntent.optional(),publish:z.literal(true).optional(),confirm:z.literal(true).optional(),acceptConditions:z.literal(true).optional() }).strict().refine(input=>!input.publish||(input.confirm===true&&input.acceptConditions===true));
export const SaveActivityDraft = z.object({ revision: z.number().int().min(0), values: ActivityArrangementInput, reason: text(200).default('') }).strict();
export const RemoveActivityDraft = z.object({ revision: z.number().int().min(0), confirm: z.literal(true) }).strict();
export const PublishActivityDraft = z.object({ revision: z.number().int().min(0), confirm: z.literal(true), acceptConditions: z.literal(true) }).strict();
export const ActivityDraftResult = z.object({ id: z.string(), revision: z.number().int().min(0), removed: z.boolean() });
export const ActivityDraftOperationResult = z.discriminatedUnion('state', [z.object({state:z.literal('not_found')}),z.object({state:z.literal('completed'),result:ActivityDraftResult})]);
export const ActivityDraftList = z.object({ drafts: z.array(z.object({ id: z.string(), title: z.string(), startsAt: z.string(), ownerName: z.string(), isOwner: z.boolean(), canEdit: z.boolean(), revision: z.number().int() })), page: z.number().int(), hasMore: z.boolean() });
export const ActivityArrangements = ActivityDraft.extend({assisted:z.boolean()});
export const ConditionArrangement = z.object({category:z.string(),starts_at:z.string(),duration_hours:z.number().nullable(),location:z.string(),description:z.string(),withdrawal_deadline:z.string(),timezone:z.string().nullable(),fee_policy:z.string()});
export const ConditionVersion = z.object({version:z.number().int(),arrangement:ConditionArrangement,summary:z.string(),createdAt:z.string(),actorName:z.string()});
export const ActivityConditions = z.object({id:z.string(),revision:z.number().int(),current:ConditionVersion,history:z.array(ConditionVersion),page:z.number().int(),hasMore:z.boolean(),canRespond:z.boolean(),people:z.array(z.object({id:z.string(),name:z.string(),status:z.string(),confirmationState:z.string(),acceptedVersion:z.number().int().nullable()}))});
export const RespondActivityConditions = z.object({revision:z.number().int().min(0),conditionsVersion:z.number().int().min(1),decision:z.enum(['accepted','declined']),reason:text(200).default('')}).strict().refine(value=>value.decision!=='declined'||!!value.reason);
export const ActivityLifecycleAction = z.enum(['pause','resume','formation','start','finish','cancel','archive','unarchive','remove']);
export const ChangeActivityLifecycle = z.object({revision:z.number().int().min(0),action:ActivityLifecycleAction,reason:text(200).default(''),confirm:z.literal(true)}).strict();
export const ActivityLifecycle = z.object({
  id:z.string(),title:z.string(),revision:z.number().int(),lifecycle:z.string(),registrationOpen:z.boolean(),formationState:z.string(),
  actualStartedAt:z.string().nullable(),actualEndedAt:z.string().nullable(),archivedAt:z.string().nullable(),cancellationReason:z.string(),removed:z.boolean(),
  actions:z.array(z.object({action:ActivityLifecycleAction,blockedReason:z.string(),requiresReason:z.boolean()})),
});
