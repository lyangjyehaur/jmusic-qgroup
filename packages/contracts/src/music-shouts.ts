import { z } from 'zod';
export const MusicShout = z.object({ id: z.string(), text: z.string(), author: z.object({ id: z.string(), name: z.string(), avatarUrl: z.string().optional(), contactQQ: z.string(), contactSource: z.enum(['legacy','self_reported','']) }).nullable(),
  name: z.string(), createdAt: z.number(), expiresAt: z.number(), archivedAt: z.number().nullable(), mine: z.boolean() });
export const MusicShouts = z.object({ items: z.array(MusicShout),total: z.number().int().nonnegative(),offset: z.number().int().nonnegative(),limit: z.number().int().min(1).max(50),now: z.number(),
  nextAllowedAt: z.number(),mine: MusicShout.nullable() });
export const PublishMusicShout = z.object({ profileId: z.string(), musicEpoch: z.number().int().nonnegative(),text: z.string().max(4096),confirm: z.literal(true) }).strict();
export const PublishedMusicShout = z.object({ id: z.string() });
export const AdminMusicShout=MusicShout.extend({revision:z.string()});
export const AdminMusicShouts = z.object({items:z.array(AdminMusicShout),total:z.number().int().nonnegative(),offset:z.number().int().nonnegative(),limit:z.number().int().min(1).max(50),now:z.number()});
export const DeleteMusicShout = z.object({revision:z.string().regex(/^[a-f0-9]{64}$/),confirm:z.literal(true)}).strict();
