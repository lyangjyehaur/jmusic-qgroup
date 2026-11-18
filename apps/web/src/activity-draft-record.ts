import { z } from 'zod';
import { CreateActivityDraft,CreateIntent,SaveActivityDraft,RemoveActivityDraft,PublishActivityDraft } from '@qgroup/contracts';
import { LegacyDraftSource } from './legacy-draft-source';
export const ActivityEditorForm=z.object({title:z.string(),category:z.string(),location:z.string(),startsAt:z.string(),deadline:z.string(),capacity:z.string(),description:z.string(),durationHours:z.string(),withdrawalDeadline:z.string(),visibility:z.enum(['public','invitation']),timezone:z.string(),minimumParticipants:z.string(),feePolicy:z.string(),botEnabled:z.boolean(),joinOwner:z.boolean()}).strict();
const Pending=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('create'),key:z.string().uuid(),input:CreateActivityDraft}).strict(),
  z.object({kind:z.literal('save'),key:z.string().uuid(),input:SaveActivityDraft}).strict(),
  z.object({kind:z.literal('remove'),key:z.string().uuid(),input:RemoveActivityDraft}).strict(),
  z.object({kind:z.literal('publish'),key:z.string().uuid(),input:PublishActivityDraft}).strict(),
]);
export const ActivityEditorDraft=z.object({id:z.string().nullable(),revision:z.number().int().min(0),form:ActivityEditorForm,reason:z.string().default(''),clientIntent:CreateIntent.optional(),pending:Pending.optional(),legacySource:LegacyDraftSource.optional()}).strict();
