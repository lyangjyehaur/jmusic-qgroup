import { z } from 'zod';
const id=z.string().regex(/^w_(?:[a-f0-9]{24}|[a-f0-9]{32})$/),revision=z.string().regex(/^[a-f0-9]{64}$/);
export const Wallpaper=z.object({id,name:z.string(),url:z.string().regex(/^\/api\/v2\/appearance\/walls\/w_(?:[a-f0-9]{24}|[a-f0-9]{32})\/image$/),enabled:z.boolean(),size:z.number().int().nonnegative(),missing:z.boolean()});
export const Appearance=z.object({revision,rotateSeconds:z.number().int().min(8).max(600),items:z.array(Wallpaper)});
const common={revision,confirm:z.literal(true)};
export const AppearanceCommand=z.discriminatedUnion('command',[
  z.object({command:z.literal('upload'),...common,name:z.string().max(1024),mime:z.enum(['image/png','image/jpeg','image/webp']),data:z.string().max(2800000)}).strict(),
  z.object({command:z.literal('config'),...common,rotateSeconds:z.number().int().min(8).max(600)}).strict(),
  z.object({command:z.literal('toggle'),...common,id,enabled:z.boolean()}).strict(),
  z.object({command:z.literal('move'),...common,id,direction:z.union([z.literal(-1),z.literal(1)])}).strict(),
  z.object({command:z.literal('delete'),...common,id}).strict(),
]);
export const AppearanceResult=z.object({id:z.string(),command:z.enum(['upload','config','toggle','move','delete']),revision});
