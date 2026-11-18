import { z } from 'zod';
import { FinanceKind } from '@qgroup/contracts';
import { LegacyFields,describeLegacy } from './legacy-local-record';
import { originalWallISO } from './legacy-authoring';
import type { LegacySnapshot } from './legacy-local-store';
import { RoomEditorRecord } from './room-editor-record';
import { FinanceEditorDraft } from './finance-editor-record';
const text=z.string(),revision=z.number().int().nonnegative(),object=z.record(z.string(),z.unknown());
const Room=z.object({id:text,name:text,payer_id:text,person_ids:z.array(text),payer_name:text.optional(),payer_label:text.optional(),payment_codes:z.array(object).optional(),codes:z.array(object).optional(),amount:text.optional(),merchant_mode:z.enum(['unpaid','paid','recorded']).optional(),paid_amount:text.optional()}).strict();
const Custom=z.object({id:text,name:text,label:text.optional()}).strict();
const FinanceValues=z.object({kind:FinanceKind,amount:text,funding:z.enum(['payer','pool']),room_id:text,payer_id:text,custodian_id:text,funder_id:text,from_id:text,to_id:text,merchant:text,reference_id:text,actual_party_id:text,actual_reason:text,reason:text,method:z.enum(['wechat','alipay','qq','cash','other']),occurred_at:text,note:text,custom:z.array(Custom),recordId:text}).strict();
const command=z.enum(['record','report','accept','reject','withdraw','reverse','close','reopen']);
const ReactCapture=z.object({react:z.literal(1),value:object,revision:revision.optional(),warning:text.optional()}).strict();
export type MoneySource={kind:'rooms';eventId:string;baseRevision:number|null;rooms:z.infer<typeof Room>[]}|{kind:'finance';eventId:string;baseRevision:number|null;command:z.infer<typeof command>;targetId:string|null;format:'fields'|'react';value:z.infer<typeof FinanceValues>};
function values(fields:unknown){const out:Record<string,string>={};for(const field of LegacyFields.parse(fields)){if(!(field.name in FinanceValues.shape)||['custom','recordId'].includes(field.name)||field.name in out)throw Error('原款項稿有未知或重複欄位，不能略過。');out[field.name]=field.value;}return out;}
export function decodeMoney(row:LegacySnapshot,scope:string):MoneySource{
  try{
    if(row.scope!==scope||(row.source as {key?:unknown})?.key!==row.sourceKey)throw Error('原紀錄身份或來源 key 不一致。');
    const description=describeLegacy(row.source,scope),data=object.parse(description.data),react=data.react===1?ReactCapture.parse(data):null;
    const match=new RegExp('^draft:'+scope+':(rooms|finance):([A-Za-z0-9_-]{1,80})(?::(record|report|accept|reject|withdraw|reverse|close|reopen):([a-f0-9]{16}|new))?$').exec(row.sourceKey);
    if(description.kind!=='draft'||!match)throw Error('原稿種類或目的編號無法辨識。');
    const eventId=match[2]!;
    if(match[1]==='rooms'){
      if(match[3])throw Error('包間原 key 不完整。');
      const input=react?z.object({rooms:z.array(Room)}).strict().parse(react.value):z.object({rooms:z.array(Room),revision}).strict().parse(data);
      return {kind:'rooms',eventId,rooms:input.rooms,baseRevision:react?.revision??('revision' in input?input.revision as number:null)};
    }
    const action=command.parse(match[3]),targetId=match[4]==='new'?null:match[4]!;let value:z.infer<typeof FinanceValues>,baseRevision:number|null;
    if(react){value=FinanceValues.parse(react.value);baseRevision=react.revision??null;}
    else{
      const capture=z.object({fields:LegacyFields,revision,edit:z.object({command,id:text.nullable(),custom:z.array(Custom),recordId:text,preview:z.null()}).strict()}).strict().parse(data);
      if(capture.edit.command!==action||capture.edit.id!==targetId)throw Error('原款項操作與原 key 不一致，請保留並核對。');
      const fields=values(capture.fields),get=(key:string)=>fields[key]??'';
      if(action==='record'||action==='report'){
        const required=Object.keys(FinanceValues.shape).filter(key=>!['custom','recordId','room_id'].includes(key));
        if(required.some(key=>!(key in fields)))throw Error('原款項稿缺少業務欄位，不能套用目前預設值。');
      }else if(Object.keys(fields).some(key=>key!=='reason'))throw Error('原非登記操作含未知欄位，不能略過。');
      value=FinanceValues.parse({kind:action==='record'||action==='report'?get('kind'):'collection',amount:get('amount'),funding:action==='record'||action==='report'?get('funding'):'payer',room_id:get('room_id'),payer_id:get('payer_id'),custodian_id:get('custodian_id'),funder_id:get('funder_id'),from_id:get('from_id'),to_id:get('to_id'),merchant:get('merchant'),reference_id:get('reference_id'),actual_party_id:get('actual_party_id'),actual_reason:get('actual_reason'),reason:get('reason'),method:action==='record'||action==='report'?get('method'):'other',occurred_at:get('occurred_at'),note:get('note'),custom:capture.edit.custom,recordId:capture.edit.recordId});baseRevision=capture.revision;
    }
    if(!/^[a-f0-9]{16}$/.test(value.recordId))throw Error('原款項編號缺失或不合法，不能另產生編號。');
    if(['record','report','close','reopen'].includes(action)&&targetId||['accept','reject','withdraw','reverse'].includes(action)&&!targetId)throw Error('原操作的目標編號缺失或不符，不能另產生編號。');
    return {kind:'finance',eventId,command:action,targetId,format:react?'react':'fields',value,baseRevision};
  }catch(error){if(error instanceof z.ZodError)throw Error('原包間／款項欄位缺失或格式尚未支援，原稿保留。');throw error;}
}
export function moneyDraft(row:LegacySnapshot,source:MoneySource,zone='',resolved=false){
  const notes:{field:string;original:string;message:string}[]=[],legacySource={id:row.id,baseRevision:source.baseRevision,reviewRequired:true,...(resolved&&source.kind==='finance'?{resolvedId:source.value.recordId}:{}),notes};
  if(source.kind==='rooms'){
    for(const room of source.rooms)if(room.amount||room.paid_amount||room.merchant_mode&&room.merchant_mode!=='unpaid')notes.push({field:room.name||room.id,original:[room.amount,room.paid_amount,room.merchant_mode].filter(Boolean).join('／'),message:'原預分欄位不登記款項；原內容保全，實際包間與付款請於結算核對。'});
    return JSON.stringify(RoomEditorRecord.parse({dirty:true,value:{revision:source.baseRevision??0,rooms:source.rooms.map(({id,name,payer_id,person_ids})=>({id,name,payer_id,person_ids})),reason:'',legacySource}}));
  }
  const v=source.value;let operation:unknown;
  if(source.command==='record'||source.command==='report'){
    let occurred_at='';try{occurred_at=originalWallISO(v.occurred_at,zone);}catch(error){notes.push({field:'實際款項時間',original:v.occurred_at,message:error instanceof Error?error.message:'原時間無法轉換'});}
    const requiredReason=['deposit_apply','cash_transfer','credit_transfer'].includes(v.kind),actual=['collection','refund','reimbursement'].includes(v.kind),reason=requiredReason?v.reason:source.format==='fields'&&!actual?'':v.actual_reason;
    if(source.format==='fields'&&!actual&&v.actual_reason)notes.push({field:'原代付依據',original:v.actual_reason,message:'原欄位在此款項類型停用，不會當成本次依據；原值保全。'});
    const method=['credit_transfer','deposit_apply'].includes(v.kind)?'other':v.method;
    if(method!==v.method)notes.push({field:'原付款方式',original:v.method,message:'原操作未選用付款方式，帶入為其他；原選項保留。'});
    if(v.reason&&!requiredReason)notes.push({field:'原一般依據',original:v.reason,message:'此原一般依據未送出，原值仍保全。'});
    const funding=source.command==='report'&&['expense','deposit'].includes(v.kind)?'payer':v.funding;
    if(funding!==v.funding)notes.push({field:'原資金選項',original:v.funding,message:'原本人申報按個人墊付處理；帶入仍依原操作語意。'});
    operation={command:source.command,id:v.recordId,transaction:{kind:v.kind,amount:v.amount,occurred_at,note:v.note,reason,method,funding,room_id:v.room_id,payer_id:v.payer_id,custodian_id:v.custodian_id,funder_id:v.funder_id,from_id:v.from_id,to_id:v.to_id,merchant:v.merchant,reference_id:v.reference_id,actual_party_id:v.actual_party_id,custom_parties:v.custom.map(({id,name})=>({id,name}))}};
  }else if(source.command==='reverse')operation={command:source.command,entry_id:source.targetId,reason:v.reason};
  else if(['accept','reject','withdraw'].includes(source.command))operation={command:source.command,report_id:source.targetId,reason:v.reason};
  else operation=source.command==='close'?{command:'close'}:{command:'reopen',reason:v.reason};
  return JSON.stringify(FinanceEditorDraft.parse({revision:source.baseRevision??0,operation,dirty:true,legacySource}));
}
