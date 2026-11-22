import { z } from 'zod';
import { ConditionArrangement } from './activity-arrangements';
import { LegacyRequestCheck,LegacyRequestReceipt } from './legacy-local';
import { originalString } from './legacy-values';
const text=(max:number)=>z.string().refine(v=>Array.from(v).length<=max);
const revision=z.number().int().min(0).optional(),conditionsVersion=z.number().int().min(1).optional();
export const LegacyRegistrationPerson=z.object({isSelf:z.boolean(),name:text(24),note:text(100),payerKind:z.enum(['self','manager'])}).strict();
export const LegacyRegistrationCommand=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('signup'),revision,conditionsVersion,people:z.array(LegacyRegistrationPerson).min(1).max(20),queueMode:z.enum(['individual','together']),intent:z.enum(['registered','tentative']),previewToken:z.string().regex(/^[a-f0-9]{64}$/).optional(),acceptPartial:z.boolean(),originalPreviewRequired:z.boolean()}).strict(),
 z.object({kind:z.literal('person'),revision,personId:z.string(),action:z.enum(['edit','confirm','split','withdraw','approve','reject']),name:text(24),note:text(100),payerKind:z.enum(['self','manager']),reason:text(200)}).strict(),
 z.object({kind:z.literal('conditions'),revision,personId:z.string(),conditionsVersion:z.number().int().min(1),decision:z.enum(['accepted','declined']),reason:text(200)}).strict(),
 z.object({kind:z.literal('noop'),revision}).strict(),
]);
export function legacyRegistrationPath(input:Pick<z.infer<typeof LegacyRequestCheck>,'method'|'path'>){
 const m=/^\/api\/events\/([A-Za-z0-9_-]{1,80})(\/roster\/parties|\/registration|\/attendees\/([a-f0-9]{16})(\/withdrawal|\/conditions)?)$/.exec(input.path);
 if(!m||!(m[2]==='/roster/parties'?input.method==='POST':m[2]==='/registration'?['PUT','DELETE'].includes(input.method):m[4]?input.method==='PATCH':['PATCH','DELETE'].includes(input.method)))throw Error('原名冊方法或路徑不符。');
 return {id:m[1]!,personId:m[3],kind:m[2]==='/roster/parties'?'signup':m[2]==='/registration'?'self':m[4]==='/conditions'?'conditions':m[4]==='/withdrawal'?'decision':'person'} as const;
}
const allowed=z.object(Object.fromEntries(['base_revision','people','queue_mode','intent','preview_token','allocation','accept_partial','conditions_version','action','name','note','payer_kind','reason','decision'].map(k=>[k,z.unknown().optional()]))).strict();
type Person={id:string;name:string;payer_kind:string;user_id?:string|null};
export function decodeLegacyRegistration(input:z.infer<typeof LegacyRequestCheck>,person?:Person){
 const path=legacyRegistrationPath(input),raw=allowed.parse(input.data),value=(k:string,fallback:unknown)=>raw[k]===undefined?fallback:raw[k],common={revision:raw.base_revision};
 if(path.kind==='self'&&input.method==='DELETE'&&!person)return LegacyRegistrationCommand.parse({kind:'noop',...common});
 if(path.kind==='signup'||path.kind==='self'&&input.method==='PUT'&&!person){
  const people=path.kind==='self'?[{is_self:true,note:value('note','')}]:z.array(z.record(z.string(),z.unknown())).min(1).max(20).parse(raw.people);
  let own=false;
  const normalized=people.map(p=>{const isSelf=p.is_self===undefined?false:z.boolean().parse(p.is_self);if(isSelf&&own)throw Error('本人只能報名一次。');own ||= isSelf;return {isSelf,name:isSelf?'':originalString(p.name===undefined?'':p.name),note:originalString(p.note===undefined?'':p.note),payerKind:p.payer_kind===undefined?isSelf?'self':'manager':p.payer_kind};});
  return LegacyRegistrationCommand.parse({kind:'signup',...common,conditionsVersion:raw.conditions_version,people:normalized,queueMode:path.kind==='self'?'individual':value('queue_mode','individual'),intent:path.kind==='self'?'registered':value('intent','registered'),previewToken:path.kind==='self'?undefined:raw.preview_token,acceptPartial:path.kind!=='self'&&raw.accept_partial===true,originalPreviewRequired:path.kind!=='self'});
 }
 if(path.kind==='conditions')return LegacyRegistrationCommand.parse({kind:'conditions',...common,personId:path.personId,conditionsVersion:raw.conditions_version,decision:raw.decision,reason:originalString(value('reason',''))});
 if(!person)throw Error('原報名不存在。');
 const action=path.kind==='decision'?raw.decision:input.method==='DELETE'?'withdraw':path.kind==='self'?'edit':value('action','edit');
 if(path.kind==='decision'&&!['approve','reject'].includes(String(action))||path.kind==='person'&&input.method==='PATCH'&&!['edit','confirm','split'].includes(String(action)))throw Error('原名冊操作不符。');
 return LegacyRegistrationCommand.parse({kind:'person',...common,personId:person.id,action,name:person.name,note:action==='edit'?originalString(value('note','')):'',payerKind:path.kind==='self'||action!=='edit'?person.payer_kind:value('payer_kind',person.payer_kind),reason:path.kind==='self'&&action==='edit'?'':originalString(value('reason','')),...(action==='edit'&&path.kind!=='self'&&!person.user_id?{name:originalString(value('name',''))}:{})});
}
export const LegacyRegistrationResult=z.object({state:z.literal('committed'),receipt:LegacyRequestReceipt,route:z.enum(['registration','conditions'])}).strict();
export const LegacyRegistrationInspection=z.discriminatedUnion('state',[
 LegacyRegistrationResult,
 z.object({state:z.literal('retryable'),command:LegacyRegistrationCommand,title:z.string(),currentRevision:z.number().int(),conditionsVersion:z.number().int(),arrangement:ConditionArrangement,allocation:z.array(z.object({name:z.string(),status:z.string()})),currentPerson:z.object({name:z.string(),isGuest:z.boolean(),status:z.string(),payerKind:z.string(),payerName:z.string(),paymentLocked:z.boolean(),acceptedVersion:z.number().int().nullable(),confirmation:z.string(),withdrawalRequested:z.boolean()}).nullable(),effect:z.enum(['signup','edit','confirm','split','withdraw','withdrawal_request','approve','reject','accepted','declined','noop']),recovery_token:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
]);
export const LegacyRegistrationRetry=LegacyRequestCheck.extend({confirm:z.literal(true),recovery_token:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
