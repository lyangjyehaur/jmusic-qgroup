import { z } from 'zod';
export const BackupId = z.string().regex(/^(?:[0-9]{8}-[0-9]{6}-[a-f0-9]{32}|legacy-(?:pair|json)-[0-9]{8}-[0-9]{6})$/);
const Backup = z.object({ id: BackupId, createdAt: z.iso.datetime().nullable(), size: z.number().int().nonnegative().safe(), schema: z.number().int().positive().nullable(), source: z.enum(['native', 'legacy_pair', 'legacy_json']).default('native'), sourceStamp: z.string().regex(/^[0-9]{8}-[0-9]{6}$/).optional() }).strict().refine(item=>item.source==='native'
  ? !item.id.startsWith('legacy-') && item.createdAt!==null && item.schema!==null && item.sourceStamp===undefined
  : item.createdAt===null && item.schema===null && item.sourceStamp!==undefined && item.id==='legacy-'+(item.source==='legacy_pair'?'pair':'json')+'-'+item.sourceStamp);
export const MusicBackups = z.object({ available: z.boolean(), backups: z.array(Backup) }).strict();
