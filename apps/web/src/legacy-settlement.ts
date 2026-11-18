import { z } from 'zod';
import { PaymentKind,SettlementContext } from '@qgroup/contracts';
import { LegacyFields,describeLegacy } from './legacy-local-record';
import type { LegacySnapshot } from './legacy-local-store';
import { SettlementEditorRecord } from './settlement-editor-record';
import { originalDeviceTime } from './legacy-settlement-time';
const text=z.string(),object=z.record(z.string(),z.unknown()),revision=z.number().int().nonnegative(),id=z.string().regex(/^[a-f0-9]{16}$/);
const Choice=z.object({kind:PaymentKind,code_id:id.optional(),version:revision.optional(),image:text.optional(),name:text.optional()}).strict();
const Allocation=z.object({person_id:text,amount:text.optional(),weight:text.optional(),minutes:z.number().optional(),amount_cents:z.number().optional(),item_id:text.optional()}).strict();
const Payment=z.object({payer_id:text,share:text.optional(),amount:text.optional(),amount_cents:z.number().optional(),name:text.optional(),label:text.optional()}).strict();
const Person=z.object({id:text,share:text,reason:text,include:z.boolean(),payment_mode:z.enum(['shares','fixed']),payments:z.array(Payment)}).strict();
const Item=z.object({id,name:text,amount:text,kind:z.enum(['expense','refund','discount']),scope:z.enum(['common','selected']),mode:z.enum(['shares','equal','weights','fixed','duration']),reason:text,allocations:z.array(Allocation),receipt:z.union([text,z.object({version:revision.optional(),item_id:id}).strict()]).nullable(),receipt_digest:text.nullable().optional(),amount_cents:z.number().optional(),has_receipt:z.boolean().optional(),breakdown:z.array(Allocation).optional()}).strict();
const Room=z.object({id,name:text,payer_id:text,person_ids:z.array(text),amount:text,merchant_mode:z.enum(['unpaid','paid','recorded']),paid_amount:text.optional(),payer_name:text.optional(),payer_label:text.optional(),payment_codes:z.array(object).optional(),codes:z.array(Choice).optional()}).strict();
const Custom=z.object({id:text,name:text,label:text.optional()}).strict();
const Values=z.object({people:z.array(Person).max(500),items:z.array(Item).max(50),rooms:z.array(Room).max(50),custom:z.array(Custom).max(50),room_mode:z.boolean(),note:text,reason:text,reviewed_roster:z.boolean(),convert_legacy:z.boolean(),merchant_mode:z.enum(['','unpaid','paid','recorded']),merchant_payer:text,merchant_amount:text,merchant_name:text,merchant_time:text,merchant_method:z.enum(['wechat','alipay','qq','cash','other']),group_notice:z.boolean(),codes:z.array(Choice).max(3)}).strict();
export type SettlementSource={eventId:string;baseRevision:number|null;baseVersion:number|null;collectorId:string|null;durationHours:number|null;value:z.infer<typeof Values>;legacyQR:string|null};
const booleans=['room_mode','reviewed_roster','convert_legacy','group_notice'];
function fieldsValues(fields:z.infer<typeof LegacyFields>){const values:Record<string,unknown>={};for(const f of fields){if(!(f.name in Values.shape)||['people','items','rooms','custom','codes'].includes(f.name)||f.name in values)throw Error('原結算有未知或重複欄位，不能略過。');if(booleans.includes(f.name)){if(typeof f.checked!=='boolean')throw Error('原結算勾選狀態缺失，不能依欄位文字猜測。');values[f.name]=f.checked;}else values[f.name]=f.value;}
 const required=Object.keys(Values.shape).filter(key=>!['people','items','rooms','custom','codes'].includes(key));if(required.some(key=>!(key in values)))throw Error('原結算欄位缺失，不能套用目前設定。');return values;}
export function decodeSettlement(row:LegacySnapshot,scope:string):SettlementSource{
 try{
  if(row.scope!==scope||(row.source as {key?:unknown})?.key!==row.sourceKey)throw Error('原紀錄身份或來源 key 不一致。');
  const description=describeLegacy(row.source,scope),match=new RegExp('^draft:'+scope+':invoice:([A-Za-z0-9_-]{1,80})$').exec(row.sourceKey);
  if(description.kind!=='draft'||!match)throw Error('原結算種類或活動編號無法辨識。');
  const data=object.parse(description.data),eventId=match[1]!;
  if(data.react===1){const capture=z.object({react:z.literal(1),value:Values,revision:revision.optional(),warning:text.optional()}).strict().parse(data);return {eventId,baseRevision:capture.revision??null,baseVersion:null,collectorId:null,durationHours:null,value:capture.value,legacyQR:null};}
  const Event=z.object({id:text,revision,settlement:z.object({version:revision}).passthrough().nullable().optional(),duration_hours:z.number().finite().min(0).max(24).optional()}).passthrough();
  const capture=z.object({event:Event,roster:z.object({collector:z.object({id:text}).passthrough()}).passthrough(),people:z.array(Person),items:z.array(Item),rooms:z.array(Room),custom:z.array(Custom),paymentCodes:z.array(Choice).optional(),qr:z.union([text,z.literal(false),z.null()]).optional(),fields:LegacyFields}).strict().parse(data);
  if(capture.event.id!==eventId)throw Error('原結算活動編號與來源 key 不同，不能轉移到另一活動。');
  const legacyQR=typeof capture.qr==='string'&&capture.qr?capture.qr:null;
  const value=Values.parse({...fieldsValues(capture.fields),people:capture.people,items:capture.items,rooms:capture.rooms,custom:capture.custom,codes:capture.paymentCodes??[]});
  if(!capture.paymentCodes&&legacyQR)value.codes=[{kind:'other',image:legacyQR,name:''}];
  return {eventId,baseRevision:capture.event.revision,baseVersion:capture.event.settlement===null?0:capture.event.settlement?.version??null,collectorId:capture.roster.collector.id,durationHours:capture.event.duration_hours??null,value,legacyQR:capture.paymentCodes?legacyQR:null};
 }catch(error){if(error instanceof z.ZodError)throw Error('原結算欄位或圖片引用缺失、或格式尚未支援；原稿保留。');throw error;}
}
function imageRaw(raw:string){const value=raw.startsWith('data:image/png;base64,')?raw.slice(22):raw;if(!/^[A-Za-z0-9+/]+={0,2}$/.test(value)||!value.startsWith('iVBOR'))throw Error('原圖不是支援的 PNG 原稿；不能更換或重新壓縮原圖。');return value;}
export function settlementDraft(row:LegacySnapshot,source:SettlementSource,current:z.infer<typeof SettlementContext>,zone='',originalDuration=''){
 const v=source.value,notes:{field:string;original:string;message:string}[]=[],legacySource={id:row.id,baseRevision:source.baseRevision,baseVersion:source.baseVersion,collectorId:source.collectorId,reviewRequired:true,notes};
 if(source.durationHours===null&&originalDuration&&!/^\d+(?:\.\d+)?$/.test(originalDuration))throw Error('原活動時長須填寫 0–24 小時的數字。');
 const duration=source.durationHours??(originalDuration?Number(originalDuration):null);
 if(duration!==null&&(!Number.isFinite(duration)||duration<0||duration>24||!Number.isInteger(duration*60)))throw Error('原活動時長須為 0–24 小時，且可換算為整數分鐘。');
 const person=(p:z.infer<typeof Person>)=>({id:p.id,share:p.share,reason:p.reason,payment_mode:p.payment_mode,payments:p.payments.map(({payer_id,share,amount})=>({payer_id,...(share!==undefined?{share}:{}),...(amount!==undefined?{amount}:{})}))});
 const people=v.people.filter(p=>p.include).map(person),retained_people=v.people.filter(p=>!p.include).map(person);
 const rooms=v.rooms.map(({id,name,payer_id,person_ids,amount,merchant_mode,paid_amount})=>({id,name,payer_id,person_ids,amount,merchant_mode,...(paid_amount!==undefined?{paid_amount}:{})}));
 const items=v.items.map(item=>{
  const allocations=item.allocations.map(({person_id,amount,weight,minutes})=>({person_id,...(amount!==undefined?{amount}:{}),...(weight!==undefined?{weight}:{}),...(minutes!==undefined?{minutes}:{})}));
  if(item.scope==='common'&&['fixed','weights','duration'].includes(item.mode))for(const p of v.people)if(!allocations.some(a=>a.person_id===p.id))allocations.push({person_id:p.id});
  for(const a of allocations){if(item.mode==='fixed'&&!a.amount)a.amount='0.00';if(item.mode==='weights'&&!a.weight)a.weight='1';if(item.mode==='duration'&&a.minutes===undefined){if(duration!==null)a.minutes=duration*60;else notes.push({field:item.name+'／'+a.person_id,original:'',message:'原參與分鐘未填，且原活動時長未保存；請補填每位人員的分鐘。'});}}
  return {id:item.id,name:item.name,kind:item.kind,amount:item.amount,scope:item.scope,mode:item.mode,reason:item.reason,allocations,receipt:typeof item.receipt==='string'?imageRaw(item.receipt):item.receipt};
 });
 const payment_codes=v.codes.map(choice=>choice.code_id?{kind:choice.kind,code_id:choice.code_id}:choice.image?{kind:choice.kind,image:imageRaw(choice.image),name:choice.name??''}:choice.version&&choice.version>0?{kind:choice.kind,version:choice.version}:(()=>{throw Error('原收款碼沒有明確圖片、碼庫 ID 或歷史版本，不能套用目前收款碼。');})());
 let occurred_at='';try{const time=originalDeviceTime(v.merchant_time,zone);occurred_at=time.iso;if(time.resolution!=='normal')notes.push({field:'原實際付款時間',original:v.merchant_time,message:time.resolution==='earlier'?'沿用原裝置解析，夏令時重複時段取較早時刻；請核對。':'沿用原裝置解析，夏令時缺失時段向後移動；請核對。'});}catch(error){notes.push({field:'原實際付款時間',original:v.merchant_time,message:error instanceof Error?error.message:'原付款時間無法解析。'});}
 if(v.reviewed_roster)notes.push({field:'原名單核對',original:'已勾選',message:'帶入後須核對目前名冊並重新勾選。'});
 if(v.group_notice)notes.push({field:'原群通知',original:'已勾選',message:'原選擇保全；發布前須重新同意公開逐人金額與附圖。'});
 if(source.legacyQR)notes.push({field:'原單張收款碼',original:'原圖已保全',message:'原表單已選用多碼清單；備用單張原圖不自動附到本版。'});
 const payment={mode:v.merchant_mode,payer_id:v.merchant_payer,amount:v.merchant_amount,merchant:v.merchant_name,occurred_at,method:v.merchant_method,note:'',reason:''};
 return JSON.stringify(SettlementEditorRecord.parse({dirty:true,value:{revision:source.baseRevision??0,base_version:source.baseVersion??current.bill?.version??0,legacySource,people,retained_people,items,custom_payers:v.custom.map(({id,name})=>({id,name})),...(v.room_mode?{rooms,retained_merchant_payment:payment}:{retained_rooms:rooms,merchant_payment:payment}),room_payment_details:{occurred_at,method:v.merchant_method,note:'',reason:''},note:v.note,reason:v.reason,payment_codes,reviewed_roster:false,convert_legacy:v.convert_legacy,group_notice:false}}));
}
