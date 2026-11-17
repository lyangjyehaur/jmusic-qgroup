import { z } from 'zod';
const contact = { contactQQ: z.string(), contactSource: z.enum(['legacy', 'self_reported', '']) };
export const MusicShareContext = z.object({
  profileId: z.string().nullable(), musicEpoch: z.number().int().nonnegative(), name: z.string(), ...contact,
  sort: z.enum(['rare', 'familiar']),
  topMatch: z.object({ id: z.string(), name: z.string(), ...contact, matchPercent: z.number().int().min(0).max(100), sharedCount: z.number().int().nonnegative() }).nullable(),
});
