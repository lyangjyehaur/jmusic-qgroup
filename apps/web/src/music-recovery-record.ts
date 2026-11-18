import { z } from 'zod';
// A lookup pointer and a confirmed action only. PINs, digests and OAuth proofs never enter storage.
export const MusicRecoveryRecord=z.object({requestId:z.string().uuid(),legacyQQ:z.string().regex(/^[0-9]{4,12}$/),action:z.enum(['finish','cancel']).optional()}).strict();
export type MusicRecoveryRecord=z.infer<typeof MusicRecoveryRecord>;
