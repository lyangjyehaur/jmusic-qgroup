import { z } from 'zod';

// Values are part of the existing SQLite / Python bot protocol.
export const ActivityCategory = z.enum(['约K', '聚餐', '运动', '出游', '游戏', '其他']);
const text = (maximum: number, required = false) => z.string().trim().refine(value => Array.from(value).length <= maximum && (!required || value.length > 0));
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
export const CreateActivityDraft = z.object({ values: ActivityArrangementInput }).strict();
export const SaveActivityDraft = z.object({ revision: z.number().int().min(0), values: ActivityArrangementInput, reason: text(200).default('') }).strict();
export const RemoveActivityDraft = z.object({ revision: z.number().int().min(0), confirm: z.literal(true) }).strict();
export const ActivityDraftResult = z.object({ id: z.string(), revision: z.number().int().min(0), removed: z.boolean() });
export const ActivityDraftOperationResult = z.discriminatedUnion('state', [z.object({state:z.literal('not_found')}),z.object({state:z.literal('completed'),result:ActivityDraftResult})]);
export const ActivityDraftList = z.object({ drafts: z.array(z.object({ id: z.string(), title: z.string(), startsAt: z.string(), ownerName: z.string(), isOwner: z.boolean(), canEdit: z.boolean(), revision: z.number().int() })), page: z.number().int(), hasMore: z.boolean() });
