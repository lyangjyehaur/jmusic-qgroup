import { z } from 'zod';
import { ActivityArrangementInput } from './activity-arrangements';
export const ActivityAccessPreview=z.object({id:z.string(),title:z.string(),revision:z.number().int().nonnegative()}).strict();
export const AcceptActivityAccess=z.object({revision:z.number().int().nonnegative(),confirm:z.literal(true)}).strict();
export const ActivityAccessResult=z.object({id:z.string(),granted:z.literal(true)}).strict();
export const ActivityShare=z.object({id:z.string(),path:z.string(),invitation:z.boolean()}).strict();
// A copy contains arrangements only. New dates and notification consent are always explicit.
export const ActivityCopy=z.object({id:z.string(),values:ActivityArrangementInput.omit({startsAt:true,deadline:true,withdrawalDeadline:true,botEnabled:true,joinOwner:true})}).strict();
