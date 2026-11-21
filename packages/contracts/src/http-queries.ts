import { z } from 'zod';
import { BackupId } from './backups';
import { BotDeliveryId } from './bot-deliveries';
import { NotificationId } from './inbox';

// Preserve each existing query's coercion, defaults, strictness and refinements.
// Query values arrive as strings; parsed values remain server domain inputs.
export const EmptyHttpQuery = /* @__PURE__ */ (() => z.object({}).strict())();
export const OptionalPositiveCursorQuery = /* @__PURE__ */ (() => z.object({before:z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional()}).strict())();
export const PageQuery = /* @__PURE__ */ (() => z.object({page:z.coerce.number().int().min(1).max(10000).default(1)}).strict())();
export const ActivityHistoryQuery = /* @__PURE__ */ (() => z.object({before:z.string().regex(/^[0-9]{1,18}$/).optional()}).strict())();
export const PositiveVersionQuery = /* @__PURE__ */ (() => z.object({before:z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional()}).strict())();
export const MinVersionQuery = /* @__PURE__ */ (() => z.object({before:z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional()}).strict())();
export const MusicBackupQuery = /* @__PURE__ */ (() => z.object({backup:BackupId.optional()}).strict())();
export const PositiveCursorQuery = /* @__PURE__ */ (() => z.object({before:z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(Number.MAX_SAFE_INTEGER)}).strict())();
export const SignedCursorQuery = /* @__PURE__ */ (() => z.object({before:z.coerce.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).default(Number.MAX_SAFE_INTEGER)}).strict())();
export const OffsetQuery = /* @__PURE__ */ (() => z.object({offset:z.coerce.number().int().min(0).max(1000000).default(0)}).strict())();
export const AdminUsersQuery = /* @__PURE__ */ (() => z.object({search:z.string().trim().refine(value=>Array.from(value).length<=100).default(''),offset:z.coerce.number().int().min(0).max(1000000).default(0),unionid:z.enum(['all','bound','missing','unbound']).default('all')}).strict())();
export const ActivitiesQuery = /* @__PURE__ */ (() => z.object({page:z.coerce.number().int().min(1).max(10000).default(1),period:z.enum(['upcoming','history']).default('upcoming')}).strict())();
export const BotDeliveriesQuery = /* @__PURE__ */ (() => z.object({before:BotDeliveryId.optional(),status:z.enum(['pending','sending','sent','failed','skipped']).optional(),kind:z.string().min(1).max(80).optional()}).strict())();
export const RoomContextQuery = /* @__PURE__ */ (() => z.object({eventId:z.string().min(1).max(80).optional()}).strict())();
export const FinanceHistoryQuery = /* @__PURE__ */ (() => {
 const cursor=z.string().regex(/^[1-9][0-9]{0,17}$/).transform(BigInt);
 return z.object({before:cursor.optional(),before_report:cursor.optional()}).strict();
})();
export const NotificationsQuery = /* @__PURE__ */ (() => z.object({before:NotificationId.optional()}).strict())();
export const TodosQuery = /* @__PURE__ */ (() => z.object({event:z.string().min(1).max(80).optional()}).strict())();
export const MusicCirclesQuery = /* @__PURE__ */ (() => z.object({minLink:z.coerce.number().int().min(1).max(100).default(40)}).strict())();
export const MusicClaimQuery = /* @__PURE__ */ (() => z.object({requestId:z.string().uuid().optional()}).strict())();
export const MusicSortQuery = /* @__PURE__ */ (() => z.object({sort:z.enum(['rare','familiar']).default('rare')}).strict())();
export const MusicShoutsQuery = /* @__PURE__ */ (() => z.object({offset:z.coerce.number().int().min(0).max(1000000).default(0),limit:z.coerce.number().int().min(1).max(50).default(10)}).strict())();
export const AdminMusicShoutsQuery = /* @__PURE__ */ (() => MusicShoutsQuery.extend({period:z.enum(['active','history']).default('active')}))();
export const TimePollsQuery = /* @__PURE__ */ (() => z.object({page:z.coerce.number().int().min(1).max(10000).default(1),period:z.enum(['active','history']).default('active')}).strict())();
