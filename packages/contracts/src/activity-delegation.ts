import { z } from 'zod';
const text=(max:number)=>z.string().trim().refine(value=>Array.from(value).length>0&&Array.from(value).length<=max);
export const ActivityScope=z.enum(['schedule','roster','attendance','settlement']);
export const InviteActivityManager=z.object({revision:z.number().int().min(0),kind:z.enum(['cohost','transfer']),targetName:text(24),attendeeId:z.string().min(1).max(80).nullable().default(null),permissions:z.array(ActivityScope),reason:text(200),confirm:z.literal(true)}).strict().refine(value=>value.kind!=='cohost'||value.permissions.length>0);
export const AcceptActivityManager=z.object({revision:z.number().int().min(0),acceptResponsibility:z.literal(true),confirm:z.literal(true)}).strict();
export const RevokeActivityManager=z.object({revision:z.number().int().min(0),reason:text(200),confirm:z.literal(true)}).strict();
export const ActivityDelegationResult=z.object({id:z.string(),revision:z.number().int(),operationId:z.string()});
export const ActivityDelegation=z.object({id:z.string(),title:z.string(),revision:z.number().int(),ownerName:z.string(),isOwner:z.boolean(),blocker:z.string(),myScopes:z.array(z.string()),targets:z.array(z.object({id:z.string(),name:z.string()})),roles:z.array(z.object({id:z.string(),name:z.string(),permissions:z.array(ActivityScope)})),invitations:z.array(z.object({id:z.string(),token:z.string(),kind:z.enum(['cohost','transfer']),targetName:z.string(),permissions:z.array(ActivityScope),expiresAt:z.string()}))});
export const ActivityDelegationPreview=z.object({id:z.string(),title:z.string(),ownerName:z.string(),kind:z.enum(['cohost','transfer']),targetName:z.string(),permissions:z.array(ActivityScope),expiresAt:z.string(),revision:z.number().int(),isOwner:z.boolean()});
