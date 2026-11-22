import { z } from 'zod';
import { LegacyRequestCheck, LegacyRequestReceipt } from './legacy-local';
import { RoomPlanInput, RoomPlanView, SettlementRoom } from './settlements';
import { originalString } from './legacy-values';

// The original editor cloned persisted rooms, including derived payer labels.
// Those known display fields stay in the original signature, but never grant authority.
const Original = z.object({
  base_revision: z.number().int().nonnegative(),
  rooms: z.array(RoomPlanInput.extend({ payer_name: z.unknown().optional(), payer_label: z.unknown().optional() }).strict()).max(50),
  reason: z.string().transform(value=>originalString(value) as string).refine(v => Array.from(v).length <= 300).default(''),
}).strict();
export function decodeLegacyRooms(request: z.infer<typeof LegacyRequestCheck>) {
  const match = /^\/api\/events\/([A-Za-z0-9_-]{1,80})\/rooms$/.exec(request.path);
  if (request.method !== 'PUT' || !match) throw Error('這份原請求不是已支援的包間操作。');
  const raw = Original.parse(request.data);
  return { eventId: match[1]!, input: { revision: raw.base_revision, rooms: raw.rooms.map(({ id, name, payer_id, person_ids }) => ({ id, name, payer_id, person_ids })), reason: raw.reason, confirm: true as const } };
}
export const LegacyRoomsRetry = LegacyRequestCheck.extend({ confirm: z.literal(true), recovery_token: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const LegacyRoomsInspection = z.discriminatedUnion('state', [
  z.object({ state: z.literal('committed'), receipt: LegacyRequestReceipt }).strict(),
  z.object({ state: z.literal('retryable'), current: RoomPlanView, rooms: z.array(SettlementRoom), changed: z.boolean(), recovery_token: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
]);
