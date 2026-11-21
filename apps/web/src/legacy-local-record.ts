import { z } from 'zod';
import { CreateIntent,LegacyRequestCheck } from '@qgroup/contracts';
export { encodeLegacy,legacyRaw } from './legacy-local-codec';
export const legacyScope=(scope:string)=>z.string().regex(/^[a-f0-9]{64}$/).parse(scope);
const object=z.record(z.string(),z.unknown());
export const LegacyFields=z.array(z.object({name:z.string(),value:z.string(),checked:z.boolean().optional()}).strict());
export type LegacyDescription={kind:'draft'|'request'|'unknown';label:string;route?:string;request?:z.infer<typeof LegacyRequestCheck>;data?:Record<string,unknown>};
export function legacyCreateIntent(description:LegacyDescription):{kind:'activity'|'poll';intent:string}|null{
  if(description.kind!=='draft'||!description.data)return null;
  const kind=description.route==='/activities/new'?'activity':description.route==='/time-polls/new'?'poll':null;if(!kind)return null;
  const data=description.data,reactValue=object.safeParse(data.value);if(data.react===1&&!reactValue.success)return null;
  const v=data.react===1?reactValue.data!:data;
  const raw=data.react===1?v[kind==='activity'?'_intent':'client_intent']:kind==='activity'?object.safeParse(data.dataset).data?.intent:data.intent;
  const intent=CreateIntent.safeParse(raw);return intent.success?{kind,intent:intent.data}:null;
}
const id='[A-Za-z0-9_-]{1,80}';
export function describeLegacy(source:unknown,scope:string):LegacyDescription{
  legacyScope(scope);const row=object.safeParse(source);
  if(!row.success||typeof row.data.key!=='string')return {kind:'unknown',label:'無法辨識的舊紀錄'};
  const key=row.data.key;
  if(key.startsWith('request:'+scope+':')){
    const input=LegacyRequestCheck.safeParse({requestKey:row.data.requestKey,method:row.data.method,path:row.data.path,data:row.data.data});
    if(!input.success||row.data.scope!==scope||!['pending','done'].includes(String(row.data.status))||!new RegExp('^request:'+scope+':[a-f0-9]{64}$').test(key))return {kind:'unknown',label:'無法辨識的舊請求'};
    return {kind:'request',label:input.data.path==='/api/events'?'舊活動建立結果':input.data.path==='/api/time-polls'?'舊時間投票建立結果':'舊看板操作結果',request:input.data};
  }
  if(!key.startsWith('draft:'+scope+':'))return {kind:'unknown',label:'原紀錄身份不符'};
  const suffix=key.slice(('draft:'+scope+':').length),data=object.safeParse(row.data.data);
  if(!data.success)return {kind:'unknown',label:'無法辨識的舊草稿'};
  const value=data.data,fields=LegacyFields.safeParse(value.fields);
  const react=z.object({react:z.literal(1),value:object,revision:z.number().int().min(-1).optional(),warning:z.string().optional()}).strict().safeParse(value);
  const record={kind:'draft' as const,data:value};
  if(suffix==='event:new'||new RegExp('^(event|copy):'+id+'$').test(suffix)){
    if(react.success){
      const v=z.object({id:z.string(),title:z.string(),_intent:z.string(),_revision:z.union([z.string(),z.number()]),_lifecycle:z.string()}).safeParse(react.data.value);
      if(!v.success||v.data.id&&!new RegExp('^'+id+'$').test(v.data.id))return {kind:'unknown',label:'無法辨識的舊活動草稿'};
      // A form key and its embedded identity must agree; never route a damaged edit to a new create.
      const recovered=v.data.id&&CreateIntent.safeParse(v.data._intent).success&&(v.data._revision===-1||v.data._revision==='-1'||suffix==='event:new'||suffix.startsWith('copy:'));
      if(suffix.startsWith('event:')&&suffix!=='event:new'&&v.data.id!==suffix.slice(6)&&!recovered||(suffix==='event:new'||suffix.startsWith('copy:'))&&v.data.id&&!recovered)return {kind:'unknown',label:'原活動草稿編號不符'};
      return {...record,label:'舊活動草稿',route:v.data.id?'/activities/'+encodeURIComponent(v.data.id):'/activities/new'};
    }
    if(!fields.success||!object.safeParse(value.dataset).success)return {kind:'unknown',label:'無法辨識的舊活動草稿'};
    const event=fields.data.find(f=>f.name==='id')?.value;
    const dataset=object.parse(value.dataset),recovered=event&&CreateIntent.safeParse(dataset.intent).success&&(dataset.revision===-1||dataset.revision==='-1'||suffix==='event:new'||suffix.startsWith('copy:'));
    if(suffix.startsWith('event:')&&suffix!=='event:new'&&event!==suffix.slice(6)&&!recovered||(suffix==='event:new'||suffix.startsWith('copy:'))&&event&&!recovered)return {kind:'unknown',label:'原活動草稿編號不符'};
    return {...record,label:'舊活動草稿',route:event&&new RegExp('^'+id+'$').test(event)?'/activities/'+encodeURIComponent(event):'/activities/new'};
  }
  if(suffix==='time-poll:new'&&(fields.success||react.success&&z.object({title:z.string(),client_intent:z.string(),slots:z.array(z.object({key:z.string(),date:z.string(),time:z.string()}))}).safeParse(react.data.value).success))return {...record,label:'舊時間投票草稿',route:'/time-polls/new'};
  const route=new RegExp('^(rooms|invoice|finance):('+id+')(?:[:].*)?$').exec(suffix);
  if(route){
    const labels={rooms:'舊包廂草稿',invoice:'舊結算草稿',finance:'舊款項草稿'},part=route[1] as keyof typeof labels;
    if(react.success){
      const v=react.data.value;
      if(part==='rooms'&&!Array.isArray(v.rooms)||part==='invoice'&&(!Array.isArray(v.people)||!Array.isArray(v.items)||!Array.isArray(v.codes))||part==='finance'&&(typeof v.recordId!=='string'||typeof v.kind!=='string'))return {kind:'unknown',label:'無法辨識的'+labels[part].slice(1)};
      return {...record,label:labels[part],route:'/activities/'+encodeURIComponent(route[2]!)+(part==='rooms'?'/rooms':part==='invoice'?'/settlement/edit':'/finance')};
    }
    if(part==='rooms'&&!Array.isArray(value.rooms)||part==='invoice'&&(!fields.success||!Array.isArray(value.people)||!Array.isArray(value.items))||part==='finance'&&(!fields.success||!object.safeParse(value.edit).success))return {kind:'unknown',label:'無法辨識的'+labels[part].slice(1)};
    return {...record,label:labels[part],route:'/activities/'+encodeURIComponent(route[2]!)+(part==='rooms'?'/rooms':part==='invoice'?'/settlement/edit':'/finance')};
  }
  return {kind:'unknown',label:'尚未支援轉換的舊草稿'};
}
export function hasLegacyCredentials(value:unknown):boolean{
  if(!value||typeof value!=='object')return false;
  const credential=(key:string)=>/token|(?:^|_)pin(?:_|$)|csrf|cookie|secret|oauth|authorization/i.test(key);
  if(Array.isArray(value))return value.some(hasLegacyCredentials);
  if('name' in value&&'value' in value&&typeof value.name==='string'&&credential(value.name))return true;
  return Object.entries(value).some(([key,item])=>credential(key)||hasLegacyCredentials(item));
}
export function legacyBlocks(row:LegacyDescription,path:string){
  if(row.kind==='unknown')return true;
  if(row.request){const p=row.request.path;return path==='/activities/new'&&p==='/api/events'||path==='/time-polls/new'&&p==='/api/time-polls'||p.startsWith('/api/events/')&&path.startsWith('/activities/'+p.split('/')[3]+'/');}
  if(!row.route)return false;
  return row.route===path||row.route.startsWith('/activities/')&&!row.route.slice('/activities/'.length).includes('/')&&path.startsWith(row.route+'/');
}
