/** The old invoice uses new Date(datetime-local), whose DST policy is compatible:
 * earlier instant for a repeated wall time and forward by the gap for a missing wall time. */
export function originalDeviceTime(value:string,zone:string){
 if(!zone)throw Error('原裝置時區未保存，請明確填寫原 IANA 時區');
 if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(value))throw Error('原付款日期與時間未完整');
 const target=Date.parse(value+'Z');if(!Number.isFinite(target))throw Error('原付款時間無效');
 const format=new Intl.DateTimeFormat('en-GB',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',fractionalSecondDigits:3,hourCycle:'h23'});
 const wall=(at:number)=>{const parts=format.formatToParts(new Date(at)),get=(kind:string)=>parts.find(p=>p.type===kind)!.value;return Date.parse(get('year')+'-'+get('month')+'-'+get('day')+'T'+get('hour')+':'+get('minute')+':'+get('second')+'.'+get('fractionalSecond')+'Z');};
 const offsets=new Set<number>();for(let hours=-72;hours<=72;hours+=6){const at=target+hours*3600000;offsets.add(wall(at)-at);}
 const candidates=[...offsets].map(offset=>target-offset),matches=candidates.filter(at=>wall(at)===target).sort((a,b)=>a-b);
 if(matches.length)return {iso:new Date(matches[0]!).toISOString(),resolution:matches.length>1?'earlier' as const:'normal' as const};
 const shifted=candidates.map(at=>({at,gap:wall(at)-target})).filter(c=>c.gap>0).sort((a,b)=>a.gap-b.gap||a.at-b.at);
 if(!shifted.length)throw Error('原装置時區無法解析此付款時間');
 return {iso:new Date(shifted[0]!.at).toISOString(),resolution:'shifted' as const};
}
