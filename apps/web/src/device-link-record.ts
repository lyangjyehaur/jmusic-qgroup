import { z } from 'zod';
export const DeviceLinkRecord=z.object({token:z.string().regex(/^[A-Za-z0-9_-]{32}$/).nullable(),expiresAt:z.number().int().positive(),capturedAt:z.number().int().nonnegative()}).strict().superRefine((value,ctx)=>{
  if(value.expiresAt>value.capturedAt+600000||value.expiresAt<=value.capturedAt)ctx.addIssue({code:'custom',message:'裝置連結期限不符'});
});
export type SavedDeviceLink=z.infer<typeof DeviceLinkRecord>;
export function parseDeviceLink(raw:string){return DeviceLinkRecord.parse(JSON.parse(raw));}
export const deviceToken=(value:string|null):value is string=>!!value&&/^[A-Za-z0-9_-]{32}$/.test(value);
export const deviceSlot=(scope?:string)=>scope?'issued:'+z.string().regex(/^[a-f0-9]{64}$/).parse(scope):'received';
