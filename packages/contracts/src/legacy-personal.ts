import { z } from 'zod';
import { LegacyRequestCheck } from './legacy-local';
import { PaymentKind,PaymentCodeSource,PaymentImage } from './payment-assets';
import { originalString } from './legacy-values';
const text=(max:number,required=false)=>z.string().refine(v=>Array.from(v).length<=max&&(!required||!!v));
export function legacyPersonalPath(input:Pick<z.infer<typeof LegacyRequestCheck>,'method'|'path'>){
 if(input.method==='POST'&&input.path==='/api/profile')return {kind:'profile' as const};
 if(input.method==='POST'&&input.path==='/api/notifications/read')return {kind:'notifications' as const};
 if(input.method==='POST'&&input.path==='/api/payment-codes')return {kind:'code-create' as const};
 const m=/^\/api\/payment-codes\/([a-f0-9]{16})$/.exec(input.path);
 if(input.method==='DELETE'&&m)return {kind:'code-archive' as const,id:m[1]!};throw Error('原個人操作方法或路徑不符。');
}
export const LegacyPersonalCommand=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('profile'),nickname:text(24,true)}).strict(),
 z.object({kind:z.literal('notifications'),ids:z.array(z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER)).max(100)}).strict(),
 z.object({kind:z.literal('code-create'),code:z.union([z.object({kind:PaymentKind,name:text(40),image:PaymentImage}).strict(),z.object({kind:PaymentKind,name:text(40),source:PaymentCodeSource.extend({event_id:z.string().regex(/^[a-f0-9]{16}$/)}).strict()}).strict()])}).strict(),
 z.object({kind:z.literal('code-archive'),id:z.string().regex(/^[a-f0-9]{16}$/)}).strict(),
]);
export function decodeLegacyPersonal(input:z.infer<typeof LegacyRequestCheck>){
 const p=legacyPersonalPath(input);
 if(p.kind==='profile'){const raw=z.object({nickname:z.unknown()}).strict().parse(input.data);return LegacyPersonalCommand.parse({...p,nickname:originalString(raw.nickname)});}
 if(p.kind==='notifications'){const raw=z.object({ids:z.unknown()}).strict().parse(input.data);return LegacyPersonalCommand.parse({...p,ids:raw.ids});}
 if(p.kind==='code-archive'){z.object({}).strict().parse(input.data);return LegacyPersonalCommand.parse(p);}
 const raw=z.union([z.object({kind:PaymentKind,name:z.unknown().optional(),image:PaymentImage}).strict(),z.object({kind:PaymentKind,name:z.unknown().optional(),source:PaymentCodeSource}).strict()]).parse(input.data);
 return LegacyPersonalCommand.parse({...p,code:{...raw,name:originalString(raw.name===undefined?'':raw.name)}});
}
export const LegacyPersonalResult=z.object({state:z.literal('committed'),route:z.enum(['/me/profile','/inbox','/me/payment-codes'])}).strict();
export const LegacyPersonalInspection=z.discriminatedUnion('state',[
 LegacyPersonalResult,
 z.object({state:z.literal('retryable'),kind:z.enum(['profile','notifications','code-create','code-archive']),route:z.enum(['/me/profile','/inbox','/me/payment-codes']),currentNickname:z.string(),nickname:z.string().nullable(),affectedActivities:z.number().int().nonnegative(),notificationIds:z.array(z.number().int()),ownedNotifications:z.number().int().nonnegative(),unreadNotifications:z.number().int().nonnegative(),code:z.object({id:z.string().nullable(),kind:PaymentKind,name:z.string(),digest:z.string(),source:z.object({eventId:z.string(),version:z.number().int(),kind:PaymentKind}).nullable()}).nullable(),recovery_token:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
]);
export const LegacyPersonalRetry=LegacyRequestCheck.extend({confirm:z.literal(true),recovery_token:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
