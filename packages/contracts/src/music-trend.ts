import { z } from 'zod';
export const MusicTrendPoint = z.object({ t: z.number().int(), counts: z.record(z.string(), z.number().int().nonnegative()) });
export const MusicTrend = z.object({
  points: z.array(MusicTrendPoint).max(48), intervalSeconds: z.literal(1800), asOf: z.number(),
  entries: z.array(z.object({ id: z.string(), name: z.string(), kind: z.enum(['main', 'sub']) })),
  recentEntries: z.array(z.object({ id: z.string(), name: z.string(), kind: z.enum(['main', 'sub']), category: z.string(), count: z.number().int().nonnegative(), createdAt: z.number().nullable() })).max(8),
  recent24h: z.object({ entries: z.number().int().nonnegative(), members: z.number().int().nonnegative() }),
  new7d: z.object({ entries: z.number().int().nonnegative(), members: z.number().int().nonnegative() }),
  totals: z.object({ entries: z.number().int().nonnegative(), members: z.number().int().nonnegative() }),
});
export const MusicTrendMembers = z.object({ members: z.array(z.object({ id: z.string(), name: z.string(), createdAt: z.number().nullable() })).max(8) });
