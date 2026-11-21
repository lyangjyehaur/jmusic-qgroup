import { z } from 'zod';

// Administrative downloads retain historical scalar values and user extensions.
// Identity and erasure projection remain the exporter's responsibility.
const time = z.union([z.number(), z.string(), z.null()]);
const selection = z.union([
  z.string(),
  z.object({ id: z.string().optional(), entryId: z.string().optional(), level: z.union([z.number(), z.string(), z.boolean(), z.null()]).optional() }).catchall(z.json()),
]);
const entry = z.object({
  id: z.string(), text: z.string(), kind: z.string().optional(), category: z.string().optional(),
  aliases: z.array(z.string()).optional(), createdBy: z.string().optional(), createdAt: time.optional(), updatedAt: time.optional(),
}).catchall(z.json());
const member = z.object({
  qq: z.string(), name: z.string().optional(), consent: z.boolean().optional(), selection: z.array(selection), created: z.array(z.string()),
  pinHash: z.string(), boardUserId: z.string(), contactQQ: z.string(), gender: z.string().optional(), genderPublic: z.boolean().optional(),
  note: z.string().optional(), createdAt: time.optional(), lastJoinAt: time.optional(), noteAt: time.optional(), lastShoutAt: time.optional(),
}).catchall(z.json());
const shout = z.object({ qq: z.string(), text: z.string(), id: z.string().optional(), name: z.string().optional(), createdAt: time.optional(), archivedAt: time.optional() }).catchall(z.json());
const trend = z.object({ t: z.number(), counts: z.record(z.string(), z.number()) }).catchall(z.json());

export const HttpMusicExport = z.object({
  entries: z.record(z.string(), entry), members: z.record(z.string(), member), settings: z.strictObject({}),
  shouts: z.array(shout), shoutHistory: z.array(shout), trend: z.array(trend),
}).catchall(z.json()).superRefine((value, ctx) => {
  for (const [key, entry] of Object.entries(value.entries)) if (entry.id !== key) ctx.addIssue({ code: 'custom', path: ['entries', key, 'id'], message: 'Entry key differs' });
  for (const [key, member] of Object.entries(value.members)) if (member.qq !== key) ctx.addIssue({ code: 'custom', path: ['members', key, 'qq'], message: 'Member key differs' });
});
