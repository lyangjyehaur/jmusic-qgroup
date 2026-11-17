import { z } from 'zod';

// Presence only. A receipt does not grant access to its original target or authorize a replay.
export const OperationReceipt = z.object({ committed: z.boolean() }).strict();
