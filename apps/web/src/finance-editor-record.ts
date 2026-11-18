import { z } from 'zod';
import { FinanceCommand,FinanceTransaction,FinanceSaveInput } from '@qgroup/contracts';
import { LegacyDraftSource } from './legacy-draft-source';
export const EditableFinanceCommand=z.discriminatedUnion('command',[
 FinanceCommand.options[0].extend({transaction:FinanceTransaction.extend({amount:z.string(),occurred_at:z.string(),note:z.string(),reason:z.string(),merchant:z.string().optional(),custom_parties:z.array(z.object({id:z.string().regex(/^custom:[a-f0-9]{16}$/),name:z.string()}).strict()).max(500)})}).strict(),
 FinanceCommand.options[1].extend({reason:z.string()}).strict(),FinanceCommand.options[2].extend({reason:z.string()}).strict(),FinanceCommand.options[3].strict(),FinanceCommand.options[4].extend({reason:z.string()}).strict()
]);
export const FinanceEditorDraft=z.object({revision:z.number().int().nonnegative(),operation:EditableFinanceCommand,dirty:z.boolean(),pending:z.object({key:z.string().uuid(),input:FinanceSaveInput}).strict().optional(),legacySource:LegacyDraftSource.optional()}).strict();

/** Keep dormant form options locally; only operative identities belong in a strict command. */
export function financeOperationInput(operation:z.infer<typeof EditableFinanceCommand>){
 if(!('transaction' in operation))return operation;
 const tx=operation.transaction,fields:string[]=[],kind=tx.kind;
 if(['collection','refund','reimbursement'].includes(kind)){
   fields.push('payer_id','actual_party_id');
   fields.push(kind==='collection'||tx.funding!=='payer'?'custodian_id':'funder_id');
 }else if(['expense','deposit','merchant_refund','deposit_return'].includes(kind))fields.push(tx.funding==='payer'?'payer_id':'custodian_id');
 else if(['cash_transfer','credit_transfer'].includes(kind))fields.push('from_id','to_id');
 const used=fields.map(field=>tx[field as keyof typeof tx]);
 return {...operation,transaction:{...tx,custom_parties:tx.custom_parties.filter(p=>used.includes(p.id))}};
}
