import { z } from 'zod';

export const Selection = z.object({ entryId: z.string().min(1).max(80), level: z.number().int().min(1).max(4) }).strict();
export const SaveProfile = z.object({
  revision: z.number().int().min(0),
  selections: z.array(Selection).min(1).max(20),
}).strict().refine(value => new Set(value.selections.map(s => s.entryId)).size === value.selections.length, '詞條不能重複');
export type SaveProfileInput = z.infer<typeof SaveProfile>;
export const Entry = z.object({ id: z.string(), name: z.string(), kind: z.enum(['main', 'sub']) });
export type MusicEntry = z.infer<typeof Entry>;
export const Catalog = z.object({ entries: z.array(Entry) });
export const Profile = z.object({ id: z.string(), revision: z.number().int(), selections: z.array(Selection), updatedAt: z.string() }).nullable();
export type MusicProfile = z.infer<typeof Profile>;
export const Session = z.discriminatedUnion('authenticated', [
  z.object({ authenticated: z.literal(false) }),
  z.object({ authenticated: z.literal(true), nickname: z.string(), scope: z.string(), csrf: z.string() }),
]);
export type Viewer = z.infer<typeof Session>;
export const Activity = z.object({
  id: z.string(), title: z.string(), category: z.string(), location: z.string(),
  startsAt: z.string(), deadline: z.string(), durationHours: z.number().nullable(), timezone: z.string().nullable(),
  description: z.string(), capacity: z.number().int(), minimumParticipants: z.number().int(),
  lifecycle: z.string(), phase: z.string(), registrationOpen: z.boolean(), estimatedOver: z.boolean(),
  archived: z.boolean(), confirmed: z.number().int(), waiting: z.number().int(), tentative: z.number().int(),
});
export type ActivityView = z.infer<typeof Activity>;
export const ActivityList = z.object({ events: z.array(Activity), page: z.number().int(), hasMore: z.boolean() });
export const ApiFailure = z.object({ code: z.string(), message: z.string() });
