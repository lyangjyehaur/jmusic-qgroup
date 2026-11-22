import { z } from 'zod';
import { LegacyRequestCheck,LegacyRequestReceipt } from './legacy-local';
import { LegacyRegistrationPerson } from './legacy-registration';
import { AttendanceState } from './activity-attendance';
import { ConditionArrangement } from './activity-arrangements';
import { originalString } from './legacy-values';
const revision=z.number().int().min(0),text=(max:number,required=false)=>z.string().refine(v=>Array.from(v).length<=max&&(!required||v.length>0));
export const LegacyParticipantCommand=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('claim-issue'),revision,attendeeId:z.string().regex(/^[a-f0-9]{16}$/),reason:text(200,true)}).strict(),
 z.object({kind:z.literal('claim-request'),revision,confirmIdentity:z.literal(true),keepPayment:z.literal(true)}).strict(),
 z.object({kind:z.literal('claim-decision'),revision,decision:z.enum(['approve','reject','revoke']),confirmPerson:z.boolean(),reason:text(200,true)}).strict().refine(c=>c.decision!=='approve'||c.confirmPerson),
 z.object({kind:z.literal('attendance'),revision,attendance:AttendanceState,note:text(200),arrivedAt:z.string().max(40).nullable(),leftAt:z.string().max(40).nullable(),reason:text(200)}).strict(),
 z.object({kind:z.literal('onsite'),revision,conditionsVersion:z.number().int().min(1),people:z.array(LegacyRegistrationPerson).min(1).max(20),reason:text(200,true),acceptConditions:z.literal(true),allowOverCapacity:z.boolean(),overrideWaitlist:z.boolean()}).strict().refine(c=>c.people.filter(p=>p.isSelf).length<=1&&c.people.every(p=>p.isSelf||!!p.name)),
]);
export function legacyParticipantPath(input:Pick<z.infer<typeof LegacyRequestCheck>,'method'|'path'>){
 const m=/^\/api\/events\/([A-Za-z0-9_-]{1,80})(\/claims(?:\/([A-Za-z0-9_-]{32})\/request|\/([a-f0-9]{16}))?|\/attendance\/([a-f0-9]{16})|\/onsite)$/.exec(input.path);
 if(!m||input.method!==(m[5]?'PATCH':'POST'))throw Error('原認領或出席方法／路徑不符。');
 return {id:m[1]!,kind:m[3]?'claim-request':m[4]?'claim-decision':m[5]?'attendance':m[2]==='/onsite'?'onsite':'claim-issue',token:m[3],claimId:m[4],personId:m[5]} as const;
}
export function decodeLegacyParticipant(input:z.infer<typeof LegacyRequestCheck>){
 const path=legacyParticipantPath(input),raw=z.object(Object.fromEntries(['base_revision','attendee_id','reason','confirm_identity','keep_payment','decision','confirm_person','attendance','attendance_note','arrived_at','left_at','people','accept_terms','conditions_version','allow_over_capacity','override_waitlist'].map(k=>[k,z.unknown().optional()]))).strict().parse(input.data),common={kind:path.kind,revision:raw.base_revision};
 if(path.kind==='claim-issue')return LegacyParticipantCommand.parse({...common,attendeeId:originalString(raw.attendee_id),reason:originalString(raw.reason)});
 if(path.kind==='claim-request')return LegacyParticipantCommand.parse({...common,confirmIdentity:raw.confirm_identity,keepPayment:raw.keep_payment});
 if(path.kind==='claim-decision')return LegacyParticipantCommand.parse({...common,decision:raw.decision,confirmPerson:raw.confirm_person===true,reason:originalString(raw.reason)});
 if(path.kind==='attendance')return LegacyParticipantCommand.parse({...common,attendance:raw.attendance,note:originalString(raw.attendance_note===undefined?'':raw.attendance_note),arrivedAt:raw.arrived_at||null,leftAt:raw.left_at||null,reason:originalString(raw.reason===undefined?'':raw.reason)});
 const people=z.array(z.record(z.string(),z.unknown())).min(1).max(20).parse(raw.people).map(p=>{const isSelf=z.boolean().parse(p.is_self===undefined?false:p.is_self);return {isSelf,name:isSelf?'':originalString(p.name),note:originalString(p.note===undefined?'':p.note),payerKind:p.payer_kind===undefined?isSelf?'self':'manager':p.payer_kind};});
 return LegacyParticipantCommand.parse({...common,people,reason:originalString(raw.reason),conditionsVersion:raw.conditions_version,acceptConditions:raw.accept_terms,allowOverCapacity:raw.allow_over_capacity===true,overrideWaitlist:raw.override_waitlist===true});
}
export const LegacyParticipantResult=z.object({state:z.literal('committed'),receipt:LegacyRequestReceipt,route:z.enum(['claims','attendance']),requestStatus:z.string().nullable()}).strict();
export const LegacyParticipantInspection=z.discriminatedUnion('state',[
 LegacyParticipantResult,
 z.object({state:z.literal('retryable'),command:LegacyParticipantCommand,title:z.string(),currentRevision:revision,phase:z.string(),currentPerson:z.object({name:z.string(),status:z.string(),payerName:z.string(),payerKind:z.enum(['self','manager']),paymentLocked:z.boolean(),attendance:AttendanceState,note:z.string(),arrivedAt:z.string().nullable(),leftAt:z.string().nullable()}).nullable(),claim:z.object({status:z.string(),requesterName:z.string().nullable(),expiresAt:z.string()}).nullable(),capacity:z.number().int(),confirmed:z.number().int(),waiting:z.number().int(),onsiteNames:z.array(z.string()),conditionsVersion:z.number().int().min(1),arrangement:ConditionArrangement,recovery_token:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
]);
export const LegacyParticipantRetry=LegacyRequestCheck.extend({confirm:z.literal(true),recovery_token:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
