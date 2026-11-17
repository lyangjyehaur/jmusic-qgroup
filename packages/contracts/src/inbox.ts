import { z } from 'zod';
export const NotificationId=z.string().regex(/^(0|[1-9][0-9]{0,17})$/);
export const Notifications=z.object({notifications:z.array(z.object({id:NotificationId,eventId:z.string(),kind:z.string(),message:z.string(),createdAt:z.string(),readAt:z.string().nullable()})),unreadCount:z.number().int().nonnegative(),nextBefore:NotificationId.nullable()});
export const NotificationCount=z.object({unreadCount:z.number().int().nonnegative()});
export const MarkNotificationsRead=z.object({ids:z.array(NotificationId).max(100)}).strict();
export const TodoKind=z.enum(['conditions','claims','withdrawal','formation','finish','settlement','reports','payment','refund','reconcile']);
export const InboxTodos=z.object({todos:z.array(z.object({eventId:z.string(),title:z.string(),kind:TodoKind,count:z.number().int().nonnegative().optional(),amountCents:z.number().int().nonnegative().safe().optional()})),eventTitle:z.string().nullable(),serverTime:z.string()});
