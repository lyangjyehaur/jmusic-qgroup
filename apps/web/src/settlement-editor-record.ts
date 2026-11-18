import { z } from 'zod';
import { ActualRoomInput,SaveSettlement,SettlementAllocation,SettlementInput,SettlementItemInput,SettlementPaymentInput,SettlementPersonInput,SettlementMerchantPayment,SettlementPaymentChoice } from '@qgroup/contracts';
import { LegacyDraftSource } from './legacy-draft-source';
export const SettlementEditorValue = SettlementInput.extend({
  legacySource: LegacyDraftSource.extend({baseVersion:z.number().int().nonnegative().nullable(),collectorId:z.string().nullable()}).optional(),
  retained_people: z.array(SettlementPersonInput.extend({share:z.string(),reason:z.string(),payments:z.array(SettlementPaymentInput.extend({payer_id:z.string(),share:z.string().optional(),amount:z.string().optional()})).max(20).optional()})).max(500).optional(),
  retained_rooms: z.array(ActualRoomInput.extend({name:z.string(),payer_id:z.string(),amount:z.string(),paid_amount:z.string().optional()})).max(50).optional(),
  retained_merchant_payment: SettlementMerchantPayment.extend({mode:z.enum(['','unpaid','paid','recorded']),amount:z.string().optional(),payer_id:z.string().optional(),merchant:z.string(),note:z.string(),reason:z.string()}).optional(),
  merchant_payment: SettlementMerchantPayment.extend({
    mode:z.enum(['','unpaid','paid','recorded']),
    merchant:z.string(),note:z.string(),reason:z.string(),
    amount: z.string().optional(),
    payer_id: z.string().optional(),
  }).optional(),
  payment_codes:z.array(z.union([SettlementPaymentChoice.options[0],SettlementPaymentChoice.options[1].extend({name:z.string()}),SettlementPaymentChoice.options[2]])).max(3).refine(codes=>new Set(codes.map(c=>c.kind)).size===codes.length),
  note:z.string(),reason:z.string(),
  reviewed_roster: z.boolean(),
  people: z
    .array(
      SettlementPersonInput.extend({
        share: z.string(),reason:z.string(),
        payments: z
          .array(
            SettlementPaymentInput.extend({
              payer_id: z.string(),
              share: z.string().optional(),
              amount: z.string().optional(),
            }),
          )
          .max(20)
          .optional(),
      }),
    )
    .max(500),
  items: z
    .array(
      SettlementItemInput.extend({
        name: z.string(),
        amount: z.string(),reason:z.string(),
        allocations: z
          .array(SettlementAllocation.extend({ amount: z.string().optional(), weight: z.string().optional(),minutes:z.number().optional() }))
          .max(500),
      }),
    )
    .max(50),
  custom_payers: z.array(z.object({ id: z.string().regex(/^custom:[a-f0-9]{16}$/), name: z.string() })).max(50),
  rooms: z
    .array(
      ActualRoomInput.extend({
        name: z.string(),
        payer_id: z.string(),
        amount: z.string(),
        paid_amount: z.string().optional(),
      }),
    )
    .max(50)
    .optional(),
});
export type SettlementEditorInput = z.infer<typeof SettlementEditorValue>;
type EditableInput = SettlementEditorInput;
export const settlementCalculation = (value: EditableInput) => {
 const {legacySource,retained_people,retained_rooms,retained_merchant_payment,...input}=value;
 void legacySource;void retained_people;void retained_rooms;void retained_merchant_payment;
 return ({
  ...input,
  payment_codes: value.rooms!==undefined?[]:value.payment_codes,
  rooms:value.rooms?.map(({paid_amount,...room})=>({...room,...(room.merchant_mode==='paid'&&paid_amount?{paid_amount}: {})})),
  people: value.people.map((p) => ({
    ...p,
    payments: p.payments?.map((v) => ({
      payer_id: v.payer_id,
      ...(p.payment_mode === 'fixed' ? { amount: v.amount } : { share: v.share ?? '1' }),
    })),
  })),
  items: value.rooms?.length
    ? []
    : value.items.map((i) => ({
        ...i,
        allocations: i.scope==='common'&&['shares','equal'].includes(i.mode)?[]:i.allocations.filter(a=>value.people.some(p=>p.id===a.person_id)).map((a) => ({
          person_id: a.person_id,
          ...(i.mode === 'fixed'
            ? { amount: a.amount }
            : i.mode === 'weights'
              ? { weight: a.weight }
              : i.mode === 'duration'
                ? { minutes: a.minutes }
                : {}),
        })),
      })),
  merchant_payment:
    value.merchant_payment?.mode === 'paid'||value.merchant_payment?.mode === ''
      ? value.merchant_payment
      : value.merchant_payment
        ? { mode: value.merchant_payment.mode, method: 'other', merchant: '', note: '', reason: '' }
        : undefined,
});
};
export const SettlementEditorRecord=z.object({value:SettlementEditorValue,dirty:z.boolean(),pending:z.object({key:z.string().uuid(),input:SaveSettlement}).strict().optional()}).strict();

type Person=SettlementEditorInput['people'][number];
export const settlementPersonSeed=(person:{id:string;payer_id:string}):Person=>({id:person.id,share:'1',reason:'',payment_mode:'shares',payments:[{payer_id:person.payer_id,share:'1'}]});
export function settlementPersonValue(value:SettlementEditorInput,person:{id:string;payer_id:string}){return value.people.find(p=>p.id===person.id)??value.retained_people?.find(p=>p.id===person.id)??settlementPersonSeed(person);}
export function updateSettlementPerson(value:SettlementEditorInput,person:{id:string;payer_id:string},patch:Partial<Person>){
 const next={...settlementPersonValue(value,person),...patch};
 return value.people.some(p=>p.id===person.id)?{people:value.people.map(p=>p.id===person.id?next:p)}:{retained_people:[...(value.retained_people??[]).filter(p=>p.id!==person.id),next]};
}
export function includeSettlementPerson(value:SettlementEditorInput,person:{id:string;payer_id:string},include:boolean){
 const current=settlementPersonValue(value,person),people=value.people.filter(p=>p.id!==person.id),retained=(value.retained_people??[]).filter(p=>p.id!==person.id);
 return include?{people:[...people,current],retained_people:retained}:{people,retained_people:[...retained,current]};
}
export function settlementMode(value:SettlementEditorInput,rooms:boolean,fallback:NonNullable<SettlementEditorInput['merchant_payment']>){
 return rooms?{rooms:value.retained_rooms??[],retained_rooms:undefined,retained_merchant_payment:value.merchant_payment??value.retained_merchant_payment,merchant_payment:undefined}:{retained_rooms:value.rooms??value.retained_rooms,rooms:undefined,merchant_payment:value.retained_merchant_payment??fallback,retained_merchant_payment:undefined};
}
