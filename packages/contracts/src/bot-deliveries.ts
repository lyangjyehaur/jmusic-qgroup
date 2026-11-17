import { z } from 'zod';
export const BotDeliveryId=z.string().regex(/^[1-9][0-9]{0,18}$/).refine(value=>/^[1-9][0-9]{0,18}$/.test(value)&&BigInt(value)<=9223372036854775807n);
export const BotDeliveryState=z.enum(['pending','sending','sent','failed','skipped']);
export const BotDelivery=z.object({
  id:BotDeliveryId,entity:z.enum(['activity','poll']),entityId:z.string(),title:z.string(),kind:z.string(),
  status:BotDeliveryState,attempts:z.number().int().nonnegative(),target:z.string(),lastError:z.string(),
  createdAt:z.string(),dueAt:z.string().nullable(),retryAt:z.string().nullable(),sentAt:z.string().nullable(),simulatedAt:z.string().nullable(),
});
export const BotDeliveries=z.object({entries:z.array(BotDelivery),nextBefore:BotDeliveryId.nullable(),mode:z.enum(['inherit','simulate','live'])});
export const BotDeliveryReview=z.object({delivery:BotDelivery,target:z.string(),mode:z.enum(['inherit','simulate','live']),originalText:z.string().nullable(),preparedText:z.string().nullable(),deliveredText:z.string().nullable(),imageName:z.string().nullable(),blocker:z.string().nullable(),reviewToken:z.string().regex(/^[a-f0-9]{64}$/).nullable()});
export const RetryBotDelivery=z.object({reviewToken:z.string().regex(/^[a-f0-9]{64}$/),confirm:z.literal(true)}).strict();
export const BotDeliveryResult=z.object({originalId:BotDeliveryId,queuedId:BotDeliveryId,entity:z.enum(['activity','poll']),entityId:z.string()});
export const BotDeliveryReceipt=z.discriminatedUnion('state',[z.object({state:z.literal('not_found')}),z.object({state:z.literal('completed'),result:BotDeliveryResult})]);
