import { z } from 'zod';
export const LegacyDraftSource=z.object({
  id:z.string().regex(/^[a-f0-9]{64}$/),
  baseRevision:z.number().int().nonnegative().nullable(),
  reviewRequired:z.boolean(),
  resolvedId:z.string().min(1).max(80).optional(),
  notes:z.array(z.object({field:z.string(),original:z.string(),message:z.string()}).strict()),
}).strict();
