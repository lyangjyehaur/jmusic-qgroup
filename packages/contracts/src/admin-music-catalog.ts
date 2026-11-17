import { z } from 'zod';
import { MusicCatalogEntry } from './music-catalog';
export const AdminMusicCatalog = z.object({
  revision:z.string().regex(/^[a-f0-9]{64}$/),
  entries:z.array(MusicCatalogEntry.extend({creationCount:z.number().int().nonnegative()})),
  categories:z.array(z.string()),
});
const common={revision:z.string().regex(/^[a-f0-9]{64}$/),confirm:z.literal(true)};
const id=z.string().min(1).max(80);
const fields={name:z.string().max(16384),kind:z.enum(['main','sub']),category:z.string().max(256)};
export const AdminMusicEntryCommand=z.discriminatedUnion('command',[
  z.object({command:z.literal('create'),...common,...fields}).strict(),
  z.object({command:z.literal('update'),...common,id,...fields}).strict(),
  z.object({command:z.literal('delete'),...common,id}).strict(),
  z.object({command:z.literal('merge'),...common,id,toId:id}).strict(),
]);
export const AdminMusicEntryResult=z.object({id:z.string(),command:z.enum(['create','update','delete','merge']),targetId:z.string(),affectedProfiles:z.number().int().nonnegative()});
