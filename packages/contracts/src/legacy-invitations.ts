import { z } from 'zod';
import { LegacyRequestCheck,LegacyRequestReceipt } from './legacy-local';
import { originalString } from './legacy-values';
import { ActivityScope } from './activity-delegation';
import { ConditionArrangement } from './activity-arrangements';
const text=(max:number,required=false)=>z.string().refine(v=>Array.from(v).length<=max&&(!required||v.length>0));
const revision=z.number().int().min(0);
export const LegacyInvitationCommand=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('roster-issue'),revision,people:z.array(z.object({name:text(24,true),note:text(100)}).strict()).min(1).max(20),reason:text(200,true)}).strict(),
 z.object({kind:z.literal('roster-accept'),revision,conditionsVersion:z.number().int().min(1).optional(),acceptWaiting:z.boolean()}).strict(),
 z.object({kind:z.literal('manager-issue'),revision,role:z.enum(['cohost','transfer']),targetName:text(24,true),attendeeId:z.string().min(1).max(80).nullable(),permissions:z.array(ActivityScope),reason:text(200,true)}).strict().refine(v=>v.role==='transfer'||v.permissions.length>0),
 z.object({kind:z.literal('manager-accept'),revision,acceptResponsibility:z.literal(true)}).strict(),
 z.object({kind:z.enum(['invitation-revoke','role-revoke']),revision,reason:text(200,true)}).strict(),
]);
export function legacyInvitationPath(input:Pick<z.infer<typeof LegacyRequestCheck>,'method'|'path'>){
 const match=/^\/api\/events\/([A-Za-z0-9_-]{1,80})(\/roster\/invitations|\/invitations\/([A-Za-z0-9_-]{32})\/accept|\/management\/invitations(?:\/([A-Za-z0-9_-]{32})\/accept|\/([a-f0-9]{16}))?|\/management\/roles\/([a-f0-9]{16}))$/.exec(input.path);
 if(!match)throw Error('原邀請方法或路徑不符。');
 const kind=match[3]?'roster-accept':match[4]?'manager-accept':match[5]?'invitation-revoke':match[6]?'role-revoke':match[2]==='/roster/invitations'?'roster-issue':'manager-issue';
 if(input.method!==(['invitation-revoke','role-revoke'].includes(kind)?'DELETE':'POST'))throw Error('原邀請方法不符。');
 return {id:match[1]!,kind,token:match[3]??match[4],itemId:match[5]??match[6]} as const;
}
export function decodeLegacyInvitation(input:z.infer<typeof LegacyRequestCheck>){
 const path=legacyInvitationPath(input),raw=z.object(Object.fromEntries(['base_revision','people','queue_mode','intent','reason','conditions_version','accept_waiting','kind','target_name','attendee_id','permissions','accept_responsibility'].map(k=>[k,z.unknown().optional()]))).strict().parse(input.data),common={kind:path.kind,revision:raw.base_revision};
 if(path.kind==='roster-issue'){
  const people=z.array(z.record(z.string(),z.unknown())).min(1).max(20).parse(raw.people).map(p=>{
   if(z.boolean().parse(p.is_self===undefined?false:p.is_self))throw Error('請填寫受邀者稱呼。');
   z.enum(['self','manager']).parse(p.payer_kind===undefined?'manager':p.payer_kind);
   return {name:originalString(p.name),note:originalString(p.note===undefined?'':p.note)};
  });
  return LegacyInvitationCommand.parse({...common,people,reason:originalString(raw.reason)});
 }
 if(path.kind==='roster-accept')return LegacyInvitationCommand.parse({...common,conditionsVersion:raw.conditions_version,acceptWaiting:raw.accept_waiting===true});
 if(path.kind==='manager-issue'){
  const permissions=z.array(ActivityScope).parse(raw.permissions===undefined?[]:raw.permissions);
  return LegacyInvitationCommand.parse({...common,role:raw.kind,targetName:originalString(raw.target_name),attendeeId:raw.attendee_id?raw.attendee_id:null,permissions:raw.kind==='transfer'?[]:[...new Set(permissions)].sort(),reason:originalString(raw.reason)});
 }
 if(path.kind==='manager-accept')return LegacyInvitationCommand.parse({...common,acceptResponsibility:raw.accept_responsibility});
 return LegacyInvitationCommand.parse({...common,reason:originalString(raw.reason)});
}
export const LegacyInvitationResult=z.object({state:z.literal('committed'),receipt:LegacyRequestReceipt,route:z.enum(['invitations','delegation','registration'])}).strict();
export const LegacyInvitationInspection=z.discriminatedUnion('state',[
 LegacyInvitationResult,
 z.object({state:z.literal('retryable'),command:LegacyInvitationCommand,title:z.string(),currentRevision:revision,ownerName:z.string(),targetName:z.string(),permissions:z.array(ActivityScope),priorRoles:z.array(z.object({name:z.string(),permissions:z.array(ActivityScope)})),expiresAt:z.string().nullable(),status:z.enum(['confirmed','waiting']).nullable(),conditionsVersion:z.number().int().min(1),arrangement:ConditionArrangement,recovery_token:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
]);
export const LegacyInvitationRetry=LegacyRequestCheck.extend({confirm:z.literal(true),recovery_token:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
