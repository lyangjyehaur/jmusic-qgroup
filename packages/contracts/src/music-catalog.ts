import { z } from 'zod';
export const MusicCatalogEntry = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['main', 'sub']),
  category: z.string(),
  aliases: z.array(z.string()),
  count: z.number().int().nonnegative(),
  creatorName: z.string(),
  createdAt: z.number().nullable(),
});
export const MusicCatalog = z.object({
  entries: z.array(MusicCatalogEntry),
  categories: z.array(z.string()),
});
export const MusicEntryMembers = z.object({
  entryId: z.string(),
  members: z.array(z.object({
    id: z.string(),
    name: z.string(),
    contactQQ: z.string(),
    contactSource: z.enum(['legacy', 'self_reported', '']),
  })),
});
export const MyMusicEntries = z.object({
  profileId: z.string().nullable(),
  musicEpoch: z.number().int().nonnegative(),
  entries: z.array(MusicCatalogEntry.extend({ revision: z.string() })),
  createdCounts: z.object({ main: z.number().int().nonnegative(), sub: z.number().int().nonnegative() }),
  limits: z.object({ main: z.literal(2), sub: z.literal(8) }),
  categories: z.array(z.string()),
});
const fields = { name: z.string().max(16384), kind: z.enum(['main', 'sub']), category: z.string().max(256) };
const owner = {
  profileId: z.string().max(80).nullable(),
  musicEpoch: z.number().int().nonnegative(),
  confirm: z.literal(true),
};
const target = {
  ...owner,
  profileId: z.string().min(1).max(80),
  id: z.string().min(1).max(80),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
};
export const MusicEntryCommand = z.discriminatedUnion('command', [
  z.object({ command: z.literal('create'), ...owner, ...fields }).strict(),
  z.object({ command: z.literal('update'), ...target, ...fields }).strict(),
  z.object({ command: z.literal('delete'), ...target }).strict(),
]);
export const MusicEntryResult = z.object({
  id: z.string(),
  command: z.enum(['create', 'update', 'delete']),
  changed: z.boolean(),
});
