import { displayError, displayLocale, uiText } from './language';

// Calendar arithmetic and unique-offset validation retained from ui/board/domain.ts.
// Keep seconds from saved arrangements; inputs use the selected zone, never the device zone.
export const activityZone=(zone?:string|null)=>zone||'Asia/Shanghai';
export function wallDate(value:string|number|Date,zone?:string|null){
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:activityZone(zone),year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(value));
  const get=(kind:Intl.DateTimeFormatPartTypes)=>parts.find(p=>p.type===kind)!.value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
}
export function wallToISO(value:string,zone?:string|null){
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value))throw displayError(new Error('Incomplete date'),'請填寫完整日期與時間');
  const normalized=value.length===16?value+':00':value,target=Date.parse(normalized+'Z');
  if(!Number.isFinite(target)||new Date(target).toISOString().slice(0,19)!==normalized)throw displayError(new Error('Invalid date'),'請填寫有效日期與時間');
  const offsets=new Set<number>();
  for(const hours of [-36,-24,-12,0,12,24,36]){
    const sample=target+hours*3600000;
    offsets.add(Date.parse(wallDate(sample,zone)+'Z')-sample);
  }
  const candidates=[...offsets].map(offset=>target-offset).filter(stamp=>wallDate(stamp,zone)===normalized);
  if(candidates.length!==1)throw candidates.length?displayError(new Error('Ambiguous time'),'這個時間處於夏令時重複時段，請選一個明確的時間'):displayError(new Error('Missing local time'),'這個時區沒有這個本地時間，請重新選擇');
  return new Date(candidates[0]!).toISOString();
}
export const isEarlyTime=(value:string)=>/^0[0-6]:[0-5]\d(?::[0-5]\d)?$/.test(value);
export function shiftCalendarDate(value:string,days:number){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value))throw displayError(new Error('Incomplete date'),'請填寫完整日期');
  const date=new Date(value+'T12:00:00Z');
  if(!Number.isFinite(+date)||date.toISOString().slice(0,10)!==value)throw displayError(new Error('Invalid date'),'請填寫有效日期');
  date.setUTCDate(date.getUTCDate()+days);return date.toISOString().slice(0,10);
}
export const calendarLabel=(value:string)=>new Intl.DateTimeFormat(displayLocale(),{timeZone:'UTC',year:'numeric',month:'long',day:'numeric',weekday:'short'}).format(new Date(value+'T12:00:00Z'));
export function eventStartValue(date:string,time:string,offset='0'){
  if(isEarlyTime(time)){
    if(!['0','1'].includes(offset))throw displayError(new Error('Unconfirmed early date'),'請選擇凌晨屬於哪一晚');
    return shiftCalendarDate(date,Number(offset))+'T'+time;
  }
  return date+'T'+time;
}
export function schedulePreview(start:Date,end:Date,zone?:string|null){
  const startValue=wallDate(start,zone),endValue=wallDate(end,zone);
  const full=(value:string)=>calendarLabel(value.slice(0,10))+' '+value.slice(11,value.endsWith(':00')?16:19);
  const crossDay=startValue.slice(0,10)!==endValue.slice(0,10);
  const lines=[uiText('開始：')+full(startValue),uiText('結束：')+full(endValue)+(crossDay?uiText('（跨日）'):'')];
  if(isEarlyTime(startValue.slice(11)))lines.unshift(calendarLabel(shiftCalendarDate(startValue.slice(0,10),-1))+uiText('晚上過後的凌晨場。'));
  if(!['Asia/Shanghai','Asia/Taipei','Asia/Hong_Kong'].includes(activityZone(zone)))lines.push(activityZone(zone));
  return {text:lines.join('\n'),requiresConfirmation:crossDay||isEarlyTime(startValue.slice(11))};
}
export function startCountdownText(start:string|number|Date,now=Date.now()){
  const difference=new Date(start).getTime()-now;if(!Number.isFinite(difference))return '';
  if(difference===0)return uiText('開始時間已到，請核對日期與時間');
  const future=difference>0,absolute=Math.abs(difference);
  let duration=uiText('不到 1 分鐘');
  if(absolute>=60000){
    const minutes=future?Math.ceil(absolute/60000):Math.floor(absolute/60000),parts=[];
    const days=Math.floor(minutes/1440),hours=Math.floor(minutes%1440/60),remaining=minutes%60;
    if(days)parts.push(days+uiText(' 天'));if(hours)parts.push(hours+uiText(' 小時'));if(remaining)parts.push(remaining+uiText(' 分鐘'));duration=parts.join(' ');
  }
  return future?uiText('距離開始還有 ')+duration:uiText('開始時間已過 ')+duration+uiText('，請核對日期與時間');
}
