import { z } from 'zod';
import { ActivityLifecycleAction } from './activity-arrangements';
import { LegacyActivityCreationValues, decodeLegacyActivityCreation } from './legacy-activity-create';
import { LegacyRequestCheck, LegacyRequestReceipt } from './legacy-local';
import { originalString } from './legacy-values';
const reason=z.string().refine(v=>Array.from(v).length<=200);
const revision=z.number().int().min(0).optional();
export const LegacyActivityPatchCommand=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('edit'),values:LegacyActivityCreationValues,reason,revision,action:z.string().nullable()}).strict(),
 z.object({kind:z.literal('lifecycle'),action:ActivityLifecycleAction,reason,revision}).strict(),
 z.object({kind:z.literal('publish'),reason,revision}).strict(),
 z.object({kind:z.literal('bot_sync'),botEnabled:z.boolean(),reason,revision}).strict(),
 z.object({kind:z.literal('bot_retry'),outboxId:z.number().int().positive().refine(Number.isSafeInteger),reason,revision}).strict(),
]);
export function legacyActivityPatchId(input:z.infer<typeof LegacyRequestCheck>){
 const m=/^\/api\/events\/([A-Za-z0-9_-]{1,80})$/.exec(input.path);
 if(input.method!=='PATCH'||!m)throw Error('原活動方法或路徑不符。');return m[1]!;
}
const fields=['title','category','location','description','starts_at','deadline','capacity','duration_hours','withdrawal_deadline','visibility','timezone','minimum_participants','fee_policy','bot_enabled','join_owner','action','status','outbox_id','base_revision','reason','client_intent'] as const;
const original=z.object(Object.fromEntries(fields.map(name=>[name,z.unknown().optional()]))).strict();
type Existing={visibility:string;bot_enabled:number;withdrawal_deadline:string|null;timezone:string|null;minimum_participants:number;fee_policy:string;draft_join_owner:number};
export function decodeLegacyActivityPatch(input:z.infer<typeof LegacyRequestCheck>,event:Existing){
 legacyActivityPatchId(input);const raw=original.parse(input.data),edit=Object.hasOwn(input.data,'title');
 let action=raw.action??null;
 if(action===null&&!edit)action=({finished:'finish',cancelled:'cancel',open:'resume',closed:'pause',deleted:'remove'} as Record<string,string>)[String(raw.status)]??null;
 const common={reason:originalString(raw.reason===undefined?'':raw.reason),revision:raw.base_revision};
 if(edit){
  const visibility=raw.visibility===undefined?event.visibility:raw.visibility,data:Record<string,unknown>={...input.data,visibility};
  // Required fields have no inherited defaults in the original edit request.
  for(const name of ['action','status','outbox_id','base_revision','reason'])delete data[name];
  const fallback={withdrawal_deadline:event.withdrawal_deadline,timezone:event.timezone,minimum_participants:event.minimum_participants,fee_policy:event.fee_policy,join_owner:!!event.draft_join_owner,bot_enabled:!!event.bot_enabled};
  for(const [key,value] of Object.entries(fallback))if(!Object.hasOwn(data,key))(data as Record<string,unknown>)[key]=value;
  if(visibility!=='public'&&!Object.hasOwn(input.data,'bot_enabled'))(data as Record<string,unknown>).bot_enabled=false;
  const values=decodeLegacyActivityCreation({...input,method:'POST',path:'/api/events',data}).values;
  return LegacyActivityPatchCommand.parse({kind:'edit',values,action,...common});
 }
 if(action==='publish')return LegacyActivityPatchCommand.parse({kind:'publish',...common});
 if(action==='bot_retry')return LegacyActivityPatchCommand.parse({kind:'bot_retry',outboxId:raw.outbox_id,...common});
 if(action==='bot_sync')return LegacyActivityPatchCommand.parse({kind:'bot_sync',botEnabled:event.visibility==='public'?(raw.bot_enabled===undefined?!!event.bot_enabled:raw.bot_enabled):Object.hasOwn(input.data,'bot_enabled')?raw.bot_enabled:false,...common});
 return LegacyActivityPatchCommand.parse({kind:'lifecycle',action,...common});
}
export const LegacyActivityPatchResult=z.object({state:z.literal('committed'),receipt:LegacyRequestReceipt,route:z.enum(['draft','arrangements','lifecycle','history','bot-deliveries','view'])}).strict();
export const LegacyActivityPatchInspection=z.discriminatedUnion('state',[
 LegacyActivityPatchResult,
 z.object({state:z.literal('retryable'),command:LegacyActivityPatchCommand,current:LegacyActivityCreationValues,title:z.string(),lifecycle:z.string(),registrationOpen:z.boolean(),archived:z.boolean(),currentRevision:z.number().int(),ownerName:z.string(),requiresOwnerSignup:z.boolean(),noticeTarget:z.string().nullable(),noticeText:z.string(),recovery_token:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
]);
export const LegacyActivityPatchRetry=LegacyRequestCheck.extend({confirm:z.literal(true),recovery_token:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
