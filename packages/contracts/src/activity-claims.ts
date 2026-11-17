import { z } from 'zod';
const reason=z.string().trim().refine(value=>Array.from(value).length>0&&Array.from(value).length<=200);
const revision=z.number().int().min(0);
export const IssueAttendeeClaim=z.object({revision,attendeeId:z.string().min(1).max(80),reason,confirm:z.literal(true)}).strict();
export const RequestAttendeeClaim=z.object({revision,confirmIdentity:z.literal(true),keepPayment:z.literal(true),confirm:z.literal(true)}).strict();
export const DecideAttendeeClaim=z.object({revision,decision:z.enum(['approve','reject','revoke']),reason,confirmPerson:z.boolean(),confirm:z.literal(true)}).strict().refine(value=>value.decision!=='approve'||value.confirmPerson);
export const AttendeeClaimResult=z.object({id:z.string(),revision,claimId:z.string()});
export const AttendeeClaimContext=z.object({id:z.string(),title:z.string(),revision,people:z.array(z.object({id:z.string(),name:z.string(),status:z.string(),payerName:z.string(),blocker:z.string()})),claims:z.array(z.object({id:z.string(),attendeeId:z.string(),name:z.string(),status:z.string(),requesterName:z.string().nullable(),expiresAt:z.string(),token:z.string().nullable(),canDecide:z.boolean(),canRevoke:z.boolean()}))});
export const AttendeeClaimPreview=z.discriminatedUnion('state',[
  z.object({state:z.literal('claimed'),id:z.string(),title:z.string(),name:z.string()}),
  z.object({state:z.literal('open'),id:z.string(),title:z.string(),name:z.string(),status:z.string(),payerName:z.string(),payerKind:z.enum(['self','manager']),revision,expiresAt:z.string(),claimStatus:z.enum(['invited','requested']),requestedByMe:z.boolean(),duplicate:z.boolean(),isManager:z.boolean()}),
]);
