import { z } from 'zod';
import { ActivityArrangementInput } from './activity-arrangements';
import { LegacyRequestCheck, LegacyRequestReceipt } from './legacy-local';
import { originalString } from './legacy-values';
const text=(max:number,required=false)=>z.string().refine(v=>Array.from(v).length<=max&&(!required||!!v));
export const LegacyActivityCreationValues=ActivityArrangementInput.extend({title:text(60,true),location:text(120,true),description:text(3000).default(''),feePolicy:text(1000).default(''),timezone:text(100,true).nullable().default('Asia/Shanghai'),startsAt:text(40,true),deadline:text(40,true),withdrawalDeadline:text(40,true).nullable().default(null)}).strict();
export const LegacyActivityCreationCommand=z.object({lifecycle:z.enum(['draft','scheduled']),values:LegacyActivityCreationValues}).strict();
const fields=['title','category','location','description','starts_at','deadline','capacity','duration_hours','withdrawal_deadline','visibility','timezone','minimum_participants','fee_policy','bot_enabled','join_owner','lifecycle','client_intent','reason'] as const;
const original=z.object(Object.fromEntries(fields.map(name=>[name,z.unknown().optional()]))).strict();
export function decodeLegacyActivityCreation(input:z.infer<typeof LegacyRequestCheck>){
 if(input.method!=='POST'||input.path!=='/api/events')throw Error('原建立活動方法或路徑不符。');
 const raw=original.parse(input.data),value=(key:string,fallback:unknown)=>raw[key]===undefined?fallback:raw[key],zone=value('timezone','Asia/Shanghai');
 if(zone!==null){if(typeof zone!=='string'||zone!==zone.trim()||zone.length>100)throw Error('原時區無效。');new Intl.DateTimeFormat('en',{timeZone:zone});}
 return LegacyActivityCreationCommand.parse({lifecycle:value('lifecycle','scheduled'),values:{title:originalString(raw.title),category:originalString(raw.category),location:originalString(raw.location),description:originalString(value('description','')),startsAt:originalString(raw.starts_at),deadline:originalString(raw.deadline),capacity:raw.capacity,durationHours:value('duration_hours',3),withdrawalDeadline:originalString(value('withdrawal_deadline',null)),visibility:value('visibility','public'),timezone:zone,minimumParticipants:value('minimum_participants',0),feePolicy:originalString(value('fee_policy','')),botEnabled:value('bot_enabled',false),joinOwner:value('join_owner',true)}});
}
const route=z.enum(['draft','arrangements','view']);
const target=z.object({kind:z.literal('activity'),id:z.string().min(1).max(80)}).strict();
export const LegacyActivityCreationResult=z.discriminatedUnion('state',[
 z.object({state:z.literal('committed'),receipt:LegacyRequestReceipt,route}).strict(),
 z.object({state:z.literal('existing'),target,route}).strict(),
]);
export const LegacyActivityCreationInspection=z.discriminatedUnion('state',[
 ...LegacyActivityCreationResult.options,
 z.object({state:z.literal('retryable'),command:LegacyActivityCreationCommand,owner_name:z.string(),group_target:z.string().nullable(),group_preview:z.string(),reminders:z.boolean(),recovery_token:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
]);
export const LegacyActivityCreationRetry=LegacyRequestCheck.extend({confirm:z.literal(true),recovery_token:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
