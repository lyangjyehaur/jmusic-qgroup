import type { DB } from '@qgroup/database';
import { DomainError } from '@qgroup/domain';
import { z } from 'zod';
import { hash } from './security';
const cents=z.number().int().nonnegative().safe();
const payload=z.object({amount_cents:cents.optional(),payer_id:z.string().optional(),custodian_id:z.string().optional(),funder_id:z.string().optional(),from_id:z.string().optional(),to_id:z.string().optional(),reference_id:z.string().optional(),funding:z.enum(['pool','payer']).optional(),room_id:z.string().optional(),bill_version:z.number().int().optional()});
function stored<T>(schema:z.ZodType<T>,raw:string):T{const parsed=schema.safeParse(JSON.parse(raw));if(!parsed.success)throw Error('Invalid stored finance projection');return parsed.data;}
export type JournalEntry={id:string;seq:number;kind:string;reversal_of:string|null;payload:z.infer<typeof payload>};
const kinds=new Set(['collection','refund','reimbursement','expense','merchant_refund','deposit','deposit_return','deposit_apply','credit_transfer','cash_transfer']);
function exact(value:number){if(!Number.isSafeInteger(value))throw Error('Unsafe journal amount');return value;}
const sum=(values:Iterable<number>)=>Array.from(values).reduce((total,value)=>exact(total+value),0);
/** Native read projection shared by inbox and the forthcoming ledger. Never changes money. */
export function projectJournal(entries:JournalEntry[]){
  const reversed=new Set(entries.filter(e=>e.kind==='reversal').map(e=>e.reversal_of));
  const active=entries.filter(e=>!reversed.has(e.id)&&kinds.has(e.kind)),credit=new Map<string,number>(),cash=new Map<string,number>(),deposits=new Map<string,{seq:number;remaining:number}>(),expenses=new Map<string,{seq:number;remaining:number}>();let cost=0;
  function bump(target:Map<string,number>,key:string|undefined,amount:number){if(!key)throw Error('Missing journal party');target.set(key,exact((target.get(key)??0)+amount));}
  for(const e of active){const p=e.payload,amount=p.amount_cents;if(amount===undefined)throw Error('Missing journal amount');
    if(e.kind==='collection'){bump(credit,p.payer_id,amount);bump(cash,p.custodian_id,amount);}
    else if(['refund','reimbursement'].includes(e.kind)){bump(credit,p.payer_id,-amount);if(p.funding==='payer')bump(credit,p.funder_id,amount);else bump(cash,p.custodian_id,-amount);}
    else if(['expense','deposit'].includes(e.kind)){if(!p.funding)throw Error('Missing journal funding');if(p.funding==='payer')bump(credit,p.payer_id,amount);else bump(cash,p.custodian_id,-amount);if(e.kind==='expense'){cost=exact(cost+amount);expenses.set(e.id,{seq:e.seq,remaining:amount});}else deposits.set(e.id,{seq:e.seq,remaining:amount});}
    else if(['merchant_refund','deposit_return'].includes(e.kind)){if(!p.funding)throw Error('Missing journal funding');if(e.kind==='merchant_refund')cost=exact(cost-amount);if(p.funding==='payer')bump(credit,p.payer_id,-amount);else bump(cash,p.custodian_id,amount);}
    else if(e.kind==='deposit_apply'){cost=exact(cost+amount);expenses.set(e.id,{seq:e.seq,remaining:amount});}
    else if(e.kind==='credit_transfer'){bump(credit,p.from_id,-amount);bump(credit,p.to_id,amount);}
    else if(e.kind==='cash_transfer'){bump(cash,p.from_id,-amount);bump(cash,p.to_id,amount);}
  }
  for(const e of active)if(['deposit_return','deposit_apply','merchant_refund'].includes(e.kind)){
    const target=(e.kind==='merchant_refund'?expenses:deposits).get(e.payload.reference_id??'');
    if(!target||target.seq>=e.seq)throw new DomainError('FINANCE_REFERENCE','關聯支出或訂金已被沖銷，請先核對後續記錄',409);
    target.remaining=exact(target.remaining-e.payload.amount_cents!);if(target.remaining<0)throw new DomainError('FINANCE_REFERENCE','退回或抵扣超過原支出的剩餘金額',409);
  }
  if([...credit.values(),...cash.values()].some(value=>value<0))throw new DomainError('FINANCE_BALANCE','已確認款項或代收資金不足，請核對關聯記錄',409);
  const deposit=sum([...deposits.values()].map(value=>value.remaining)),held=sum(cash.values());if(sum(credit.values())!==exact(cost+deposit+held))throw Error('Unbalanced cash journal');
  return {credit,cash,cost,deposit,held,reversed};
}
const invoice=z.object({payers:z.array(z.object({id:z.string(),amount_cents:cents})),rooms:z.array(z.object({id:z.string()})).optional(),items:z.array(z.object({id:z.string(),breakdown:z.array(z.object({person_id:z.string()}))})).optional(),people:z.array(z.object({id:z.string(),payments:z.array(z.object({payer_id:z.string(),amount_cents:cents}))})).optional()});
function balances(dues:Map<string,number>,credit:Map<string,number>){return [...new Set([...dues.keys(),...credit.keys()])].map(id=>({id,balance:exact((dues.get(id)??0)-(credit.get(id)??0))}));}
export function financeTodoSummary(db:DB,eventId:string,viewerId:string,canManage:boolean){
  const entries=(db.prepare('SELECT id,seq,kind,reversal_of,payload_json FROM finance_entries WHERE event_id=? ORDER BY seq').all(eventId) as {id:string;seq:number;kind:string;reversal_of:string|null;payload_json:string}[]).map(e=>({...e,payload:stored(payload,e.payload_json)}));
  const state=projectJournal(entries),version=(db.prepare('SELECT MAX(version) AS version FROM settlement_history WHERE event_id=?').get(eventId) as {version:number|null}).version;
  const raw=version?db.prepare('SELECT snapshot_json FROM settlement_details WHERE event_id=? AND version=?').get(eventId,version) as {snapshot_json:string}|undefined:undefined;
  const bill=raw?stored(invoice,raw.snapshot_json):null;
  const pending=db.prepare('SELECT r.reporter_id FROM finance_reports r LEFT JOIN finance_report_actions a ON a.report_id=r.id WHERE r.event_id=? AND a.decision IS NULL').all(eventId) as {reporter_id:string}[];
  const closed=entries.at(-1)?.kind==='close'&&entries.at(-1)!.payload.bill_version===version&&!pending.length;
  const mine=new Set(['account:'+hash(eventId+':'+viewerId).slice(0,16),...(db.prepare('SELECT o.payer_id FROM attendee_payment_origins o JOIN attendees a ON a.id=o.attendee_id WHERE a.event_id=? AND a.user_id=? AND o.claimant_owns=1').all(eventId,viewerId) as {payer_id:string}[]).map(row=>row.payer_id)]);
  let outstanding:number|null=null,refund:number|null=null;
  if(bill){
    const overall=balances(new Map(bill.payers.map(p=>[p.id,p.amount_cents])),state.credit);
    if(overall.some(b=>mine.has(b.id))){
      let selected=overall;
      if(bill.rooms?.length){
        selected=bill.rooms.flatMap(room=>{
          const scoped=projectJournal(entries.filter(e=>e.payload.room_id===room.id||e.kind==='reversal')),dues=new Map<string,number>(),item=bill.items?.find(item=>item.id===room.id);if(!item)throw Error('Missing room invoice');
          for(const allocation of item.breakdown){const person=bill.people?.find(p=>p.id===allocation.person_id);if(!person)throw Error('Missing room invoice person');for(const payment of person.payments)dues.set(payment.payer_id,exact((dues.get(payment.payer_id)??0)+payment.amount_cents));}
          return balances(dues,scoped.credit);
        });
      }
      const personal=selected.filter(b=>mine.has(b.id));outstanding=sum(personal.map(b=>Math.max(0,b.balance)));refund=sum(personal.map(b=>Math.max(0,-b.balance)));
    }
  }
  return {detailed:!!bill,state:closed?'closed':bill?'collecting':'unpublished',pendingCount:canManage?pending.length:pending.filter(row=>row.reporter_id===viewerId).length,myOutstandingCents:outstanding,myRefundDueCents:refund};
}
