import { z } from 'zod';
import { FinanceTransaction,FinanceCommand,FinancePreview } from './finance';
import { LegacyRequestCheck,LegacyRequestReceipt } from './legacy-local';
const text=(max:number)=>z.string().trim().refine(v=>Array.from(v).length<=max),id=z.string().regex(/^[a-f0-9]{16}$/),revision=z.number().int().nonnegative();
const RawTransaction=FinanceTransaction.extend({
 note:text(1000).default(''),reason:text(300).default(''),method:FinanceTransaction.shape.method.default('other'),
 custom_parties:FinanceTransaction.shape.custom_parties.unwrap().element.extend({label:z.unknown().optional()}).strict().array().max(2).default([]),
 payer_id:z.unknown().optional(),custodian_id:z.unknown().optional(),funder_id:z.unknown().optional(),actual_party_id:z.unknown().optional(),from_id:z.unknown().optional(),to_id:z.unknown().optional(),reference_id:z.unknown().optional(),funding:z.unknown().optional(),merchant:z.unknown().optional(),room_id:z.unknown().optional(),
}).strict();
const common={base_revision:revision,preview_token:z.string().regex(/^[a-f0-9]{64}$/)};
const Original=z.discriminatedUnion('command',[
 z.object({...common,command:z.enum(['record','report']),id,transaction:RawTransaction}).strict(),
 z.object({...common,command:z.enum(['accept','reject','withdraw']),report_id:id,reason:text(300).default('')}).strict(),
 z.object({...common,command:z.literal('reverse'),entry_id:id,reason:text(300).refine(v=>!!v)}).strict(),
 z.object({...common,command:z.literal('close'),reason:z.string().optional()}).strict(),
 z.object({...common,command:z.literal('reopen'),reason:text(300).refine(v=>!!v)}).strict(),
]);
/** Decode only known original fields. Keep the original body intact for its signature.
 * Inactive known fields are ignored exactly as the original finance.prepare did. */
export function decodeLegacyFinance(request:z.infer<typeof LegacyRequestCheck>){
 const match=/^\/api\/events\/([A-Za-z0-9_-]{1,80})\/finance$/.exec(request.path);
 if(request.method!=='POST'||!match)throw Error('這份原請求不是已支援的款項操作。');
 const {base_revision,preview_token,...original}=Original.parse(request.data);
 let operation:z.infer<typeof FinanceCommand>;
 if(original.command==='record'||original.command==='report'){
  const raw=original.transaction,kind=raw.kind,tx:Record<string,unknown>={kind,amount:raw.amount,occurred_at:raw.occurred_at,note:raw.note,reason:raw.reason,method:raw.method,custom_parties:raw.custom_parties.map(({id,name})=>({id,name}))};
  const copy=(...keys:(keyof typeof raw)[])=>{for(const key of keys)if(key in raw)tx[key]=raw[key];};
  if(['collection','refund','reimbursement'].includes(kind)){
   copy('payer_id');const funding=kind==='collection'?'pool':raw.funding===undefined?'pool':raw.funding;
   if(kind!=='collection')tx.funding=funding;
   if(funding==='payer')copy('funder_id');else copy('custodian_id');
   if(raw.actual_party_id!==undefined&&raw.actual_party_id!==null&&raw.actual_party_id!=='')copy('actual_party_id');
  }else if(['expense','deposit','merchant_refund','deposit_return'].includes(kind)){
   copy('funding');if(raw.funding==='payer')copy('payer_id');else copy('custodian_id');
   if(['expense','deposit'].includes(kind))copy('merchant');
  }else if(['credit_transfer','cash_transfer'].includes(kind))copy('from_id','to_id');
  if(['merchant_refund','deposit_return','deposit_apply'].includes(kind))copy('reference_id');
  if(raw.room_id)copy('room_id');
  operation={command:original.command,id:original.id,transaction:FinanceTransaction.parse(tx)};
 }else if(original.command==='close')operation={command:'close'};
 else if('report_id' in original)operation={command:original.command,report_id:original.report_id,reason:original.reason};
 else if('entry_id' in original)operation={command:'reverse',entry_id:original.entry_id,reason:original.reason};
 else if(original.command==='reopen')operation={command:'reopen',reason:original.reason};
 else throw Error('未知原款項操作。');
 return {eventId:match[1]!,revision:base_revision,preview_token,operation};
}
export const LegacyFinanceRetry=LegacyRequestCheck.extend({confirm:z.literal(true)}).strict();
export const LegacyFinanceInspection=z.discriminatedUnion('state',[
 z.object({state:z.literal('committed'),receipt:LegacyRequestReceipt}).strict(),
 z.object({state:z.literal('retryable'),event_id:z.string(),title:z.string(),preview:FinancePreview}).strict(),
]);
