/** Interpret old naive timestamps in the event zone, with Python ZoneInfo fold=0. */
function zoneName(zone:string|null){try{new Intl.DateTimeFormat('en',{timeZone:zone||'UTC'});return zone||'UTC';}catch{return 'UTC';}}
function parts(at:number,zone:string){
  const values=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(at));
  const get=(type:string)=>Number(values.find(part=>part.type===type)!.value);
  return {year:get('year'),month:get('month'),day:get('day'),hour:get('hour'),minute:get('minute'),second:get('second')};
}
function asUTC(p:ReturnType<typeof parts>){const date=new Date(0);date.setUTCFullYear(p.year,p.month-1,p.day);date.setUTCHours(p.hour,p.minute,p.second,0);return date.getTime();}
export function botMoment(value:string,zone:string|null):number{
  if(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value))return Date.parse(value);
  const match=/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/.exec(value);
  if(!match)return NaN;
  const [,year,month,day,hour,minute,second='0',fraction='0']=match;
  const p={year:Number(year),month:Number(month),day:Number(day),hour:Number(hour),minute:Number(minute),second:Number(second)};
  const utc=asUTC(p),zoneId=zoneName(zone);if(!Number.isFinite(utc))return NaN;
  const offsets=new Set([-48,-24,0,24,48].map(hours=>{const at=utc+hours*3600000;return asUTC(parts(at,zoneId))-at;}));
  const candidates=[...offsets].map(offset=>utc-offset).sort((a,b)=>a-b);
  const matched=candidates.filter(at=>asUTC(parts(at,zoneId))===utc);
  // For a nonexistent wall time fold=0 uses the offset before the transition.
  return (matched[0]??candidates.at(-1)??NaN)+Number(('0.'+fraction))*1000;
}
export function botLocalTime(value:string|null,zone:string|null=''){
  if(!value)return '未设定';
  const at=botMoment(value,zone);if(!Number.isFinite(at))return Array.from(value).slice(0,16).join('');
  // datetime.astimezone(the same ZoneInfo) preserves a naive gap's original wall time.
  if(!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value))return value.slice(0,10)+' '+value.slice(11,16);
  const p=parts(at,zoneName(zone));const pad=(v:number)=>String(v).padStart(2,'0');
  return String(p.year).padStart(4,'0')+'-'+pad(p.month)+'-'+pad(p.day)+' '+pad(p.hour)+':'+pad(p.minute);
}
export function botStartCountdown(event:{lifecycle:string;starts_at:string;timezone:string|null}|null|undefined,at:Date):string{
  if(!event||event.lifecycle!=='scheduled')return '';
  const seconds=(botMoment(event.starts_at,event.timezone)-at.getTime())/1000;if(!Number.isFinite(seconds))return '';
  if(seconds<=0)return '已到计划开始时间';if(seconds<60)return '距开始：不足 1 分钟';
  let minutes=Math.floor(seconds/60);const days=Math.floor(minutes/1440);minutes%=1440;const hours=Math.floor(minutes/60);minutes%=60;
  return '距开始：'+[[days,'天'],[hours,'小时'],[minutes,'分钟']].filter(([v])=>v).map(([v,label])=>v+' '+label).join(' ');
}
