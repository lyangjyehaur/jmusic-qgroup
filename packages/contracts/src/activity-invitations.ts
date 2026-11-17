import { z } from 'zod';
import { ConditionArrangement } from './activity-arrangements';
import { RegistrationPerson } from './activity-registration';
const reason=z.string().trim().refine(value=>Array.from(value).length>0&&Array.from(value).length<=200);
export const IssueActivityInvitations=z.object({revision:z.number().int().min(0),people:z.array(RegistrationPerson).min(1).max(20),reason,confirm:z.literal(true)}).strict().refine(value=>value.people.every(person=>!person.isSelf&&!!person.name));
export const AcceptActivityInvitation=z.object({revision:z.number().int().min(0),conditionsVersion:z.number().int().min(1),acceptConditions:z.literal(true),acceptWaiting:z.boolean(),confirm:z.literal(true)}).strict();
export const ActivityInvitations=z.object({id:z.string(),title:z.string(),revision:z.number().int(),blocker:z.string(),canIssue:z.boolean(),people:z.array(z.object({id:z.string(),name:z.string(),note:z.string(),token:z.string().regex(/^[A-Za-z0-9_-]{32}$/)}))});
export const ActivityInvitationPreview=z.object({id:z.string(),title:z.string(),name:z.string(),revision:z.number().int(),conditionsVersion:z.number().int(),arrangement:ConditionArrangement,status:z.enum(['confirmed','waiting']),blocker:z.string()});
export const ActivityInvitationResult=z.object({id:z.string(),revision:z.number().int(),attendeeId:z.string().nullable()});
