import { z } from 'zod';
import { ErasureProof } from './erasure-proof';
export const AdminMusicErasurePreview = z.object({
  command:z.enum(['delete_profile','reset_music']),revision:z.string().regex(/^[a-f0-9]{64}$/),
  profile:z.object({id:z.string(),name:z.string(),contactQQ:z.string().optional(),ownerName:z.string().optional(),ownerId:z.string().nullable()}).nullable(),
  profiles:z.number().int().nonnegative(),selections:z.number().int().nonnegative(),
  entries:z.number().int().nonnegative(),shouts:z.number().int().nonnegative(),
  historyRecords:z.number().int().nonnegative().default(0),
});
export const AdminMusicErasureInput = ErasureProof.extend({
  revision:z.string().regex(/^[a-f0-9]{64}$/),confirm:z.enum(['DELETE','RESET']),
}).strict();
export const AdminMusicErasureResult = z.object({
  requestId:z.string().uuid(),target:z.literal('admin_music'),command:z.enum(['delete_profile','reset_music']),
  status:z.literal('completed'),profiles:z.number().int().nonnegative(),entries:z.number().int().nonnegative(),
});
