import { z } from 'zod';
export const ActivityHistory = z.object({
  id:z.string(),title:z.string(),entries:z.array(z.object({
    id:z.string().regex(/^[0-9]+$/),version:z.number().int(),actorName:z.string(),action:z.string(),
    before:z.record(z.string(),z.json()),after:z.record(z.string(),z.json()),reason:z.string(),createdAt:z.string(),
  })),nextBefore:z.string().regex(/^[0-9]+$/).nullable(),
});
export type ActivityHistoryEntry=z.infer<typeof ActivityHistory>['entries'][number];
