import { z } from 'zod';
import { ConditionArrangement } from './activity-arrangements';
import { RegistrationPerson } from './activity-registration';
const text=(max:number)=>z.string().trim().refine(value=>Array.from(value).length<=max);
export const AttendanceState=z.enum(['unknown','present','absent','late','left']);
export const ChangeAttendance=z.object({revision:z.number().int().min(0),attendance:AttendanceState,note:text(200),arrivedAt:z.string().max(40).nullable(),leftAt:z.string().max(40).nullable(),reason:text(200),confirm:z.literal(true)}).strict();
export const AddOnsite=z.object({revision:z.number().int().min(0),conditionsVersion:z.number().int().min(1),people:z.array(RegistrationPerson).min(1).max(20),reason:text(200).refine(value=>value.length>0),acceptConditions:z.literal(true),allowOverCapacity:z.boolean(),overrideWaitlist:z.boolean(),confirm:z.literal(true)}).strict().refine(value=>value.people.filter(person=>person.isSelf).length<=1);
export const ActivityAttendance=z.object({id:z.string(),title:z.string(),revision:z.number().int(),conditionsVersion:z.number().int(),arrangement:ConditionArrangement,phase:z.string(),serverTime:z.string(),canObserve:z.boolean(),canAdd:z.boolean(),observationBlocker:z.string(),onsiteBlocker:z.string(),reasonRequired:z.boolean(),nickname:z.string(),selfRegistered:z.boolean(),capacity:z.number().int(),confirmed:z.number().int(),waiting:z.number().int(),people:z.array(z.object({id:z.string(),name:z.string(),status:z.string(),isGuest:z.boolean(),payerKind:z.string(),payerName:z.string(),attendance:AttendanceState,note:z.string(),arrivedAt:z.string().nullable(),leftAt:z.string().nullable()}))});
export const AttendanceResult=z.object({id:z.string(),revision:z.number().int()});
