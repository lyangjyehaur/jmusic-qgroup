import { z } from 'zod';
export const BackupId = z.string().regex(/^[0-9]{8}-[0-9]{6}-[a-f0-9]{32}$/);
export const MusicBackups = z.object({ available: z.boolean(), backups: z.array(z.object({ id: BackupId, createdAt: z.iso.datetime(), size: z.number().int().nonnegative().safe(), schema: z.number().int().positive() }).strict()) }).strict();
