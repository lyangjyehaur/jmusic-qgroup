import { z } from 'zod';
import { ActivityCategory,CreateIntent } from '@qgroup/contracts';
import { ActivityEditorDraft } from './activity-draft-record';
import { PollCreateRecord } from './poll-create-record';
import { describeLegacy,LegacyFields } from './legacy-local-record';
import type { LegacySnapshot } from './legacy-local-store';
const object=z.record(z.string(),z.unknown());
const text=z.string(),revision=z.union([text,z.number().int().min(-1)]);
const ActivityCapture=z.object({id:text,_intent:text,_revision:revision,_lifecycle:text,title:text,category:text,location:text,description:text,fee_policy:text,capacity_unlimited:z.boolean(),capacity:text,minimum_participants:text,timezone:text,visibility:z.enum(['public','invitation']),event_date:text,start_time:text,start_day_offset:text,duration_hours:text,deadline:text,withdrawal_deadline:text,bot_enabled:z.boolean(),reason:text}).strict();
const Slot=z.object({key:z.union([text,z.number()]).optional(),date:text,time:text}).strict();
const PollCapture=z.object({title:text,category:ActivityCategory,location:text,description:text,timezone:text,bot_enabled:z.boolean(),duration_hours:text,capacity:text,minimum_participants:text,deadline_date:text,deadline_time:text,exact_time:z.boolean(),slots:z.array(Slot),client_intent:text,deadlineTouched:z.boolean().optional()}).strict();
const ReactCapture=z.object({react:z.literal(1),value:object,revision:z.number().int().min(-1).optional(),warning:text.optional()}).strict();
export type OriginalActivity=z.infer<typeof ActivityCapture>;
export type OriginalPoll=z.infer<typeof PollCapture>;
export type AuthoringSource={kind:'activity';value:OriginalActivity;baseRevision:number|null;intent:string|null;creation:boolean}|{kind:'poll';value:OriginalPoll;baseRevision:null;intent:string;creation:true};
function fieldValues(fields:unknown,allowed:Set<string>,booleanFields:Set<string>){
  const result:Record<string,string|boolean>={};
  for(const field of LegacyFields.parse(fields)){
    if(!allowed.has(field.name)||field.name in result)throw Error('原稿包含未完成映射或重複欄位，原內容保留。');
    if(booleanFields.has(field.name)){if(typeof field.checked!=='boolean')throw Error('原勾選狀態不完整，不能推測設定。');result[field.name]=field.checked;}
    else result[field.name]=field.value;
  }return result;
}
const storedRevision=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:typeof value==='string'&&/^\d+$/.test(value)&&Number.isSafeInteger(Number(value))?Number(value):null;
/** Decode exact known protocols. Unknown fields stay in the vault and stop adoption. */
function decode(row:LegacySnapshot,scope:string):AuthoringSource{
  const description=describeLegacy(row.source,scope),source=object.parse(row.source),data=object.parse(source.data);
  if(description.kind!=='draft'||!['舊活動草稿','舊時間投票草稿'].includes(description.label))throw Error('此原稿尚未支援轉換。');
  const react=data.react===1?ReactCapture.parse(data):null;
  if(description.label==='舊活動草稿'){
    let value:OriginalActivity;
    if(react)value=ActivityCapture.parse(react.value);
    else{
      const capture=z.object({fields:LegacyFields,dataset:z.object({intent:text,revision:revision.optional(),lifecycle:text.optional(),previousDeadline:text.optional(),previousStart:text.optional(),previousEarly:text.optional(),presetDuration:text.optional()}).strict(),warning:text.optional()}).strict().parse(data);
      const booleans=new Set(['capacity_unlimited','bot_enabled']),allowed=new Set([...Object.keys(ActivityCapture.shape).filter(key=>!key.startsWith('_')), 'starts_at']);
      const v=fieldValues(capture.fields,allowed,booleans),get=(key:string)=>typeof v[key]==='string'?v[key] as string:'';
      value=ActivityCapture.parse({id:get('id'),_intent:capture.dataset.intent,_revision:capture.dataset.revision??'',_lifecycle:capture.dataset.lifecycle??'',title:get('title'),category:get('category'),location:get('location'),description:get('description'),fee_policy:get('fee_policy'),capacity_unlimited:v.capacity_unlimited??get('capacity')==='0',capacity:get('capacity'),minimum_participants:get('minimum_participants'),timezone:get('timezone'),visibility:get('visibility')||'public',event_date:get('event_date')||get('starts_at').slice(0,10),start_time:get('start_time')||get('starts_at').slice(11,16),start_day_offset:get('start_day_offset'),duration_hours:get('duration_hours'),deadline:get('deadline'),withdrawal_deadline:get('withdrawal_deadline'),bot_enabled:v.bot_enabled,reason:get('reason')});
    }
    const base=storedRevision(value._revision),outer=react?.revision;
    if(outer!==undefined&&base!==null&&outer!==base)throw Error('原稿內外版本不一致，請保留原稿並核對。');
    const parsedIntent=CreateIntent.safeParse(value._intent);if(!value.id&&!parsedIntent.success)throw Error('原建立識別缺失或無法辨識，不能產生另一個識別重建。');
    const creation=!String(source.key).endsWith(':event:'+value.id)||value._revision===-1||value._revision==='-1';
    if(creation&&!parsedIntent.success)throw Error('原建立識別缺失，不能將原結果改成另一筆建立。');
    return {kind:'activity',value,baseRevision:base??(outer===-1?null:outer)??null,intent:parsedIntent.success?parsedIntent.data:null,creation};
  }
  let value:OriginalPoll;
  if(react)value=PollCapture.parse(react.value);
  else{
    const capture=z.object({fields:LegacyFields,slots:z.array(Slot).optional(),intent:text}).strict().parse(data);
    const names=Object.keys(PollCapture.shape).filter(k=>!['slots','client_intent','deadlineTouched'].includes(k));
    const allowed=new Set([...names,'option_count','deadline']);
    for(const f of capture.fields)if(/^slot_\d+$/.test(f.name)||/^poll_(?:day|time)_[A-Za-z0-9_-]+$/.test(f.name))allowed.add(f.name);
    const v=fieldValues(capture.fields,allowed,new Set(['exact_time','bot_enabled'])),get=(key:string)=>typeof v[key]==='string'?v[key] as string:'';
    let slots=capture.slots;
    const dynamic=capture.fields.filter(f=>/^slot_|^poll_(?:day|time)_/.test(f.name));
    if(!slots){
      const count=Number(get('option_count'));if(!/^\d+$/.test(get('option_count'))||!Number.isSafeInteger(count)||count<2||count>10000)throw Error('原候選數量不完整，不能生成或刪除候選。');
      const expected=new Set(Array.from({length:count},(_,i)=>'slot_'+i));
      if(dynamic.length!==count||dynamic.some(f=>!expected.has(f.name)))throw Error('原候選欄位與數量不同，不能遺漏候選。');
      slots=Array.from({length:count},(_,i)=>{const s=get('slot_'+i);return {date:s.slice(0,10),time:s.slice(11,16)};});
    }else{
      const keys=slots.map(slot=>String(slot.key));
      if(keys.some(k=>k==='undefined')||new Set(keys).size!==keys.length)throw Error('原候選識別缺失或重複，不能推測順序。');
      const expected=new Map(slots.flatMap(slot=>[['poll_day_'+slot.key,slot.date],['poll_time_'+slot.key,slot.time]] as [string,string][]));
      if(dynamic.length!==expected.size||dynamic.some(f=>!expected.has(f.name)||expected.get(f.name)!==f.value)||'option_count' in v||'deadline' in v)throw Error('原候選欄位與保存候選不一致，不能推測順序或時間。');
    }
    value=PollCapture.parse({title:get('title'),category:get('category'),location:get('location'),description:get('description'),timezone:get('timezone'),bot_enabled:v.bot_enabled,duration_hours:get('duration_hours'),capacity:get('capacity'),minimum_participants:get('minimum_participants'),deadline_date:get('deadline_date')||get('deadline').slice(0,10),deadline_time:get('deadline_time')||get('deadline').slice(11,16),exact_time:capture.slots?v.exact_time:true,slots,client_intent:capture.intent});
  }
  return {kind:'poll',value,baseRevision:null,intent:CreateIntent.parse(value.client_intent),creation:true};
}
export function decodeAuthoring(row:LegacySnapshot,scope:string):AuthoringSource{
  try{return decode(row,scope);}catch(error){if(error instanceof z.ZodError)throw Error('原稿欄位缺失或格式尚未支援，原資料保留。');throw error;}
}
function calendar(value:string){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value))throw Error('日期未完整');const at=new Date(value+'T12:00:00Z');
  if(!Number.isFinite(at.getTime())||at.toISOString().slice(0,10)!==value||value.startsWith('0000'))throw Error('日期無效');return at;
}
export function originalWallISO(value:string,zone:string){
  if(!zone)throw Error('原時區未保存，請明確填寫原 IANA 時區');
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))throw Error('原日期與時間未完整');calendar(value.slice(0,10));
  const format=new Intl.DateTimeFormat('en-GB',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const wall=(at:number)=>{const parts=format.formatToParts(new Date(at)),get=(kind:string)=>parts.find(p=>p.type===kind)!.value;return get('year')+'-'+get('month')+'-'+get('day')+'T'+get('hour')+':'+get('minute');};
  const target=Date.parse(value+'Z');if(!Number.isFinite(target))throw Error('原時間無效');const offsets=new Set<number>();
  for(const hours of [-36,-24,-12,0,12,24,36]){const at=target+hours*3600000;offsets.add(Date.parse(wall(at)+'Z')-Math.floor(at/60000)*60000);}
  const candidates=[...offsets].map(offset=>target-offset).filter(at=>wall(at)===value);
  if(candidates.length!==1)throw Error(candidates.length?'原時間位於夏令時重複區間，請填寫含偏移的明確時間':'原時區不存在此時間，請重新核對');
  return new Date(candidates[0]!).toISOString();
}
export function authoringDraft(row:LegacySnapshot,source:AuthoringSource,target:{id:string;route:'draft'|'arrangements'|'poll'}|null,originalZone=''){
  const notes:{field:string;original:string;message:string}[]=[],zone=source.value.timezone||originalZone;
  const time=(field:string,raw:string,taipei=false,optional=false)=>{if(optional&&!raw)return '';try{const iso=originalWallISO(raw,zone);return taipei?new Date(Date.parse(iso)+8*3600000).toISOString().slice(0,19):iso;}catch(error){notes.push({field,original:raw,message:error instanceof Error?error.message:'原時間無法轉換'});return '';}};
  const metadata={id:row.id,baseRevision:source.baseRevision,reviewRequired:source.kind==='activity'&&!!target,...(target?{resolvedId:target.id}:{}),notes};
  if(source.kind==='activity'){
    const v=source.value;let start=v.event_date+'T'+v.start_time;
    if(/^0[0-6]:[0-5]\d$/.test(v.start_time)){
      if(!['0','1'].includes(v.start_day_offset))start+='（凌晨日期偏移未選擇）';
      else try{const date=calendar(v.event_date);date.setUTCDate(date.getUTCDate()+Number(v.start_day_offset));start=date.toISOString().slice(0,10)+'T'+v.start_time;}catch{/* The raw date is retained in the time note. */}
    }
    return {kind:'activity' as const,raw:JSON.stringify(ActivityEditorDraft.parse({id:target?.id??null,revision:source.baseRevision??0,clientIntent:source.intent??undefined,reason:v.reason,legacySource:metadata,form:{title:v.title,category:v.category,location:v.location,description:v.description,feePolicy:v.fee_policy,capacity:v.capacity_unlimited?'0':v.capacity,minimumParticipants:v.minimum_participants,durationHours:v.duration_hours,visibility:v.visibility,botEnabled:v.bot_enabled,joinOwner:true,timezone:zone,startsAt:time('開始時間',start,true),deadline:time('報名截止',v.deadline,true),withdrawalDeadline:time('退出期限',v.withdrawal_deadline,true,true)}}))};
  }
  const v=source.value;
  const options=v.slots.map((slot,i)=>{if(v.exact_time)return time('候選時間 '+(i+1),slot.date+'T'+slot.time);try{calendar(slot.date);return slot.date;}catch(error){notes.push({field:'候選日期 '+(i+1),original:slot.date,message:error instanceof Error?error.message:'日期無效'});return slot.date;}});
  return {kind:'poll' as const,raw:JSON.stringify(PollCreateRecord.parse({dirty:true,value:{client_intent:source.intent,title:v.title,category:v.category,location:v.location,description:v.description,timezone:zone,capacity:v.capacity,minimum_participants:v.minimum_participants,fee_policy:'',bot_enabled:v.bot_enabled,time_mode:v.exact_time?'exact':'date',duration_hours:v.duration_hours,options,deadline:time('投票截止',v.deadline_date+'T'+(v.exact_time?v.deadline_time:'23:59')),legacySource:metadata}}))};
}
