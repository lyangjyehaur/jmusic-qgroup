import { z } from 'zod';
import { LegacyRequestCheck, LegacyRequestReceipt } from './legacy-local';
import { CreateTimePoll } from './time-polls';
const rawCreation = z.object({title:z.unknown().optional(),category:z.unknown().optional(),location:z.unknown().optional(),description:z.unknown().optional(),timezone:z.unknown().optional(),capacity:z.unknown().optional(),minimum_participants:z.unknown().optional(),fee_policy:z.unknown().optional(),deadline:z.unknown().optional(),bot_enabled:z.unknown().optional(),visibility:z.unknown().optional(),time_mode:z.unknown().optional(),options:z.unknown().optional(),duration_hours:z.unknown().optional(),client_intent:z.unknown().optional()}).strict();
export function originalPollCreateKey(input:z.infer<typeof LegacyRequestCheck>, digest:(text:string)=>string) {
 const intent = input.data.client_intent;
 // Match the original JavaScript client's truthiness and primitive string coercion.
 if (!intent) return undefined;
 if (!['string','number','boolean'].includes(typeof intent)) throw Error('原建立識別格式尚未支援；原請求保留。');
 return digest('create time-poll '+String(intent));
}
// Normalized original strings retain Python whitespace semantics. No display parser trims user content again.
const originalText=(max:number,required=false)=>z.string().refine(v=>Array.from(v).length<=max&&(!required||!!v));
const originalFields={title:originalText(60,true),location:originalText(120,true),description:originalText(3000).default(''),timezone:originalText(100,true),fee_policy:originalText(1000).default(''),deadline:originalText(40,true)};
export const LegacyPollCreationCommand=z.discriminatedUnion('time_mode',[
 CreateTimePoll.options[0].omit({client_intent:true}).extend({...originalFields,options:z.array(z.object({date:originalText(10,true)}).strict()).min(2)}).strict(),
 CreateTimePoll.options[1].omit({client_intent:true}).extend({...originalFields,options:z.array(z.object({starts_at:originalText(40,true)}).strict()).min(2)}).strict(),
]);
export function decodeLegacyPollCreation(input:z.infer<typeof LegacyRequestCheck>) {
 if (input.method!=='POST'||input.path!=='/api/time-polls') throw Error('原建立投票方法或路徑不符。');
 const raw=rawCreation.parse(input.data), mode=raw.time_mode===undefined?'exact':raw.time_mode, zone=raw.timezone===undefined?'Asia/Shanghai':raw.timezone;
 // ZoneInfo validates the original value, without trimming into a different valid zone.
 if (typeof zone!=='string'||zone!==zone.trim()||zone.length>100) throw Error('原時區不符。');
 new Intl.DateTimeFormat('en',{timeZone:zone});
 const text=(value:unknown)=>typeof value==='string'?value.replace(/^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu,''):value;
 const options=Array.isArray(raw.options)?raw.options.map(option=>option&&typeof option==='object'&&!Array.isArray(option)?Object.fromEntries(Object.entries(option).map(([k,v])=>[k,k==='starts_at'?text(v):v])):option):raw.options;
 return LegacyPollCreationCommand.parse({title:text(raw.title),category:text(raw.category),location:text(raw.location),description:raw.description===undefined?'':text(raw.description),timezone:zone,capacity:raw.capacity,minimum_participants:raw.minimum_participants===undefined?0:raw.minimum_participants,fee_policy:raw.fee_policy===undefined?'':text(raw.fee_policy),deadline:text(raw.deadline),bot_enabled:raw.bot_enabled===undefined?true:raw.bot_enabled,visibility:raw.visibility===undefined?'public':raw.visibility,time_mode:mode,options,...(mode==='exact'?{duration_hours:raw.duration_hours===undefined?3:raw.duration_hours}:{})});
}
export const LegacyPollCreationRetry=LegacyRequestCheck.extend({confirm:z.literal(true),recovery_token:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const LegacyPollCreationResult=z.discriminatedUnion('state',[
 z.object({state:z.literal('committed'),receipt:LegacyRequestReceipt}).strict(),
 z.object({state:z.literal('existing'),target:z.object({kind:z.literal('poll'),id:z.string().min(1).max(80)}).strict()}).strict(),
]);
export const LegacyPollCreationInspection=z.discriminatedUnion('state',[
 ...LegacyPollCreationResult.options,
 z.object({state:z.literal('retryable'),command:LegacyPollCreationCommand,starts:z.array(z.string()),deadline:z.string(),owner_name:z.string(),group_target:z.string().nullable(),group_preview:z.string(),recovery_token:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
]);
