import { z } from 'zod';
import { MusicEntryNames, MusicEntryTranslations } from './music-catalog';

export const SearchQuery = z.object({
  q: z.string().trim().min(1).max(100),
  group: z.enum(['all', 'activities', 'music', 'people']).default('all'),
  page: z.coerce.number().int().min(1).max(10000).default(1),
}).strict().refine(value => value.group !== 'all' || value.page === 1, '全部結果只提供第一頁；請選擇分類繼續查看');

const group = <T extends z.ZodType>(item: T) => z.object({
  items: z.array(item).max(10), total: z.number().int().nonnegative(), hasMore: z.boolean(),
}).strict();
export const SearchResults = z.object({
  q: z.string(), group: z.enum(['all', 'activities', 'music', 'people']), page: z.number().int().positive(),
  activities: group(z.object({
    id: z.string(), title: z.string(), category: z.string(), location: z.string(), startsAt: z.string(), timezone: z.string().nullable(),
    phase: z.enum(['draft', 'scheduled', 'ongoing', 'ended', 'cancelled']), archived: z.boolean(),
  }).strict()),
  music: group(z.object({ id: z.string(), name: z.string(), kind: z.enum(['main', 'sub']), category: z.string(), names:MusicEntryNames.optional(),translations:MusicEntryTranslations.optional() }).strict()),
  people: group(z.object({ id: z.string(), name: z.string() }).strict()).extend({
    access: z.enum(['ready', 'login_required', 'music_required']),
  }).strict(),
}).strict();
