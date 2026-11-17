import { z } from 'zod';
export const ErasureProof = z.object({ requestId: z.string().uuid(), secret: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
