import { z } from 'zod';
import { LegacyRequestCheck, LegacyRequestReceipt } from './legacy-local';
import { SettlementInput, SettlementPreview } from './settlements';
import { PaymentKind } from './payment-assets';
const inert = z.unknown().optional();
const Choice=z.object({kind:PaymentKind,code_id:inert,image:inert,name:inert,version:inert}).strict();
const Payment = z.object({payer_id:z.string(), share:inert, amount:inert, amount_cents:inert, name:inert, label:inert}).strict();
const Person = SettlementInput.shape.people.element.extend({payments:z.array(Payment).min(1).max(20).optional()}).strict();
const Allocation = z.object({person_id:z.string(), amount:inert, weight:inert, minutes:inert, amount_cents:inert, item_id:inert}).strict();
const Item = SettlementInput.shape.items.unwrap().element.extend({allocations:z.array(Allocation).max(500).default([]), amount_cents:inert, has_receipt:inert, breakdown:inert, receipt_digest:inert}).strict();
const Room = SettlementInput.shape.rooms.unwrap().element.extend({paid_amount:inert, payer_name:inert, payer_label:inert}).strict();
const Merchant = z.object({mode:z.enum(['unpaid','paid','recorded']),amount:inert,payer_id:inert,occurred_at:inert,method:inert,merchant:inert,note:inert,reason:inert}).strict();
const Original = SettlementInput.omit({revision:true,people:true,items:true,custom_payers:true,rooms:true,merchant_payment:true,payment_codes:true}).extend({
  base_revision:z.number().int().nonnegative(), preview_token:z.string().regex(/^[a-f0-9]{64}$/),
  people:z.array(Person).max(500), items:z.array(Item).max(50).optional(),
  custom_payers:z.array(z.object({id:z.string(),name:z.string(),label:inert}).strict()).max(50).default([]),
  rooms:z.array(Room).max(50).optional(), merchant_payment:Merchant.nullable().optional(),
  payment_codes:z.array(Choice).max(3).optional(), qr_image:z.string().nullable().optional(),
}).strict();
/** Decode only original wire requests. Draft conversion and new preview tokens do not apply. */
export function decodeLegacyDetailedSettlement(request:z.infer<typeof LegacyRequestCheck>){
  const match=/^\/api\/events\/([A-Za-z0-9_-]{1,80})\/settlement\/detailed$/.exec(request.path);
  if(request.method!=='PUT'||!match)throw Error('這份原請求不是逐人結算操作。');
  const raw=Original.parse(request.data);
  if(raw.rooms?.length){
    if(raw.payment_codes?.length||Object.hasOwn(request.data,'qr_image'))throw Error('原包間結算不能附統一收款碼。');
    if(raw.merchant_payment!==undefined&&raw.merchant_payment!==null)throw Error('原包間不能附統一店家付款。');
  }else if(raw.payment_codes!==undefined&&Object.hasOwn(request.data,'qr_image'))throw Error('原收款碼欄位衝突。');
  const {base_revision,preview_token,qr_image,...value}=raw;
  const input=SettlementInput.parse({...value,revision:base_revision,
    payment_codes:raw.payment_codes?.map(c=>Object.hasOwn(c,'code_id')?{kind:c.kind,code_id:c.code_id}:Object.hasOwn(c,'image')?{kind:c.kind,image:c.image,name:c.name===undefined?'':c.name}:{kind:c.kind,version:c.version}),
    people:raw.people.map(p=>({...p,payments:p.payments?.map(v=>({payer_id:v.payer_id,...(p.payment_mode==='fixed'?{amount:v.amount}:{share:v.share===undefined?'1':v.share})}))})),
    items:raw.rooms?.length?[]:raw.items?.map(({amount_cents,has_receipt,breakdown,receipt_digest,...item})=>{
      void amount_cents;void has_receipt;void breakdown;void receipt_digest;
      return {...item,allocations:item.allocations.map(v=>({person_id:v.person_id,...(item.mode==='fixed'?{amount:v.amount}:item.mode==='weights'?{weight:v.weight}:item.mode==='duration'?{minutes:v.minutes}:{})}))};
    }),
    custom_payers:raw.custom_payers.map(({id,name})=>({id,name})),
    rooms:raw.rooms?.map(({payer_name,payer_label,paid_amount,...room})=>{void payer_name;void payer_label;return {...room,...(room.merchant_mode==='paid'?{paid_amount:paid_amount===undefined?room.amount:paid_amount}:{})};}),
    merchant_payment:raw.merchant_payment==null?undefined:raw.merchant_payment.mode==='paid'?raw.merchant_payment:{mode:raw.merchant_payment.mode},
  });
  return {eventId:match[1]!,input,previewToken:preview_token,
    paymentChoice:raw.rooms?.length?'rooms' as const:raw.payment_codes!==undefined?'explicit' as const:Object.hasOwn(request.data,'qr_image')?'qr' as const:'inherit' as const,qrImage:qr_image};
}
export const LegacyDetailedSettlementRetry=LegacyRequestCheck.extend({confirm:z.literal(true),recovery_token:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const LegacyDetailedSettlementInspection=z.discriminatedUnion('state',[
  z.object({state:z.literal('committed'),receipt:LegacyRequestReceipt}).strict(),
  z.object({state:z.literal('retryable'),title:z.string(),preview:SettlementPreview,assets:SettlementInput,recovery_token:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
]);
