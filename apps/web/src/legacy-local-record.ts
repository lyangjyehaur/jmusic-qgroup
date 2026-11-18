import { z } from 'zod';
import { LegacyRequestCheck } from '@qgroup/contracts';
export const legacyScope=(scope:string)=>z.string().regex(/^[a-f0-9]{64}$/).parse(scope);
const object=z.record(z.string(),z.unknown());
export const LegacyFields=z.array(z.object({name:z.string(),value:z.string(),checked:z.boolean().optional()}).strict());
export type LegacyDescription={kind:'draft'|'request'|'unknown';label:string;route?:string;request?:z.infer<typeof LegacyRequestCheck>;data?:Record<string,unknown>};
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
  const record={kind:'draft' as const,data:value};
  if(suffix==='event:new'||new RegExp('^(event|copy):'+id+'$').test(suffix)){
    if(!fields.success||!object.safeParse(value.dataset).success)return {kind:'unknown',label:'無法辨識的舊活動草稿'};
    const event=fields.data.find(f=>f.name==='id')?.value;
    return {...record,label:'舊活動草稿',route:event&&new RegExp('^'+id+'$').test(event)?'/activities/'+encodeURIComponent(event):'/activities/new'};
  }
  if(suffix==='time-poll:new'&&fields.success)return {...record,label:'舊時間投票草稿',route:'/time-polls/new'};
  const route=new RegExp('^(rooms|invoice|finance):('+id+')(?:[:].*)?$').exec(suffix);
  if(route){
    const labels={rooms:'舊包廂草稿',invoice:'舊結算草稿',finance:'舊款項草稿'},part=route[1] as keyof typeof labels;
    if(part==='rooms'&&!Array.isArray(value.rooms)||part==='invoice'&&(!fields.success||!Array.isArray(value.people)||!Array.isArray(value.items))||part==='finance'&&(!fields.success||!object.safeParse(value.edit).success))return {kind:'unknown',label:'無法辨識的'+labels[part].slice(1)};
    return {...record,label:labels[part],route:'/activities/'+encodeURIComponent(route[2]!)+(part==='rooms'?'/rooms':part==='invoice'?'/settlement/edit':'/finance')};
  }
  return {kind:'unknown',label:'尚未支援轉換的舊草稿'};
}
/** Tagged tree retains undefined fields, property order, -0 and embedded image strings.
 * Real BoardStore captures are plain structured values. Unsupported types remain in source. */
export function encodeLegacy(value:unknown):unknown{
  if(value===undefined)return ['undefined'];
  if(value===null)return ['null'];
  if(typeof value==='string'||typeof value==='boolean')return [typeof value,value];
  if(typeof value==='number'&&Number.isFinite(value))return ['number',Object.is(value,-0)?'-0':String(value)];
  if(Array.isArray(value))return ['array',Array.from({length:value.length},(_,i)=>i in value?encodeLegacy(value[i]):['hole'])];
  if(typeof value==='object'&&value&&[Object.prototype,null].includes(Object.getPrototypeOf(value)))return ['object',Object.entries(value).map(([key,item])=>[key,encodeLegacy(item)])];
  throw Error('舊紀錄包含未支援的資料類型；原儲存保留，不能轉換或發布。');
}
export function legacyRaw(value:unknown){return JSON.stringify({format:'kanban-local-v1-preserved',version:1,source:encodeLegacy(value)});}
export function legacyBlocks(row:LegacyDescription,path:string){
  if(row.kind==='unknown')return true;
  if(row.request){const p=row.request.path;return path==='/activities/new'&&p==='/api/events'||path==='/time-polls/new'&&p==='/api/time-polls'||p.startsWith('/api/events/')&&path.startsWith('/activities/'+p.split('/')[3]+'/');}
  if(!row.route)return false;
  return row.route===path||row.route.startsWith('/activities/')&&!row.route.slice('/activities/'.length).includes('/')&&path.startsWith(row.route+'/');
}
