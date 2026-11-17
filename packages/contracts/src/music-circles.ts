import { z } from 'zod';
const identity = z.object({ id: z.string(), name: z.string() });
const entry = z.object({ id: z.string(), kind: z.enum(['main', 'sub']) });
export const MusicCircles = z.object({
  minLink: z.number().int().min(1).max(100), membersWithSelection: z.number().int().nonnegative(), singles: z.number().int().nonnegative(),
  clusters: z.array(z.object({ size: z.number().int().min(2), members: z.array(identity), tags: z.array(z.object({ name: z.string(), count: z.number().int().positive(), entries: z.array(entry) })).max(6) })),
  singleMembers: z.array(identity.extend({ picks: z.array(entry.extend({ name: z.string() })).max(8), pickCount: z.number().int().nonnegative() })),
});
