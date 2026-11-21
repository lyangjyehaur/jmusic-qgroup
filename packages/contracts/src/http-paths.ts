import { z } from 'zod';
import { BotDeliveryId } from './bot-deliveries';
import { PaymentCodeId, PaymentKind } from './payment-assets';

// These are the existing decoded Fastify path rules. Keep Number coercion and
// string delivery IDs intact; callers validate without rewriting URL values.
export const ActivityPath = z.object({ id: z.string().min(1).max(80) });
export const Identifier128Path = z.object({ id: z.string().min(1).max(128) });
export const MusicProfilePath = z.object({ id: z.string().regex(/^m_[a-f0-9]{24,40}$/) });
export const ActivityTokenPath = ActivityPath.extend({ token: z.string().regex(/^[A-Za-z0-9_-]{32}$/) });
export const ActivityPersonPath = ActivityPath.extend({ personId: z.string().min(1).max(80) });
export const ActivityAttendeePath = ActivityPath.extend({ attendeeId: z.string().min(1).max(80) });
export const ActivityClaimPath = ActivityPath.extend({ claimId: z.string().regex(/^[a-f0-9]{16}$/) });
export const ActivityItemPath = ActivityPath.extend({ itemId: z.string().min(1).max(80) });
export const ActivityVersionPath = ActivityPath.extend({ version: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER) });
export const RequestIdPath = z.object({ requestId: z.string().uuid() });
export const RequestKeyPath = z.object({ key: z.string().uuid() });
export const StrictRequestKeyPath = RequestKeyPath.strict();
export const WallpaperPath = z.object({ id: z.string().regex(/^w_(?:[a-f0-9]{24}|[a-f0-9]{32})$/) });
export const BotDeliveryPath = z.object({ deliveryId: BotDeliveryId });
export const BotDeliveryEntityPath = ActivityPath.extend({ deliveryId: BotDeliveryId.optional() });
export const PaymentLibraryPath = z.object({ codeId: PaymentCodeId });
export const PaymentHistoryPath = z.object({ id: z.string().min(1).max(80), version: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER) });
export const PaymentHistoryKindPath = PaymentHistoryPath.extend({ kind: PaymentKind });
export const PaymentHistoryReceiptPath = PaymentHistoryPath.extend({ itemId: PaymentCodeId });
