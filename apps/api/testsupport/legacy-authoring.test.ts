import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe,it,expect } from 'vitest';
import { authoringDraft,decodeAuthoring,originalWallISO } from '../../web/src/legacy-authoring';
import { legacyRaw } from '../../web/src/legacy-local-record';
import type { LegacySnapshot } from '../../web/src/legacy-local-store';
const scope='a'.repeat(64),intent='11111111-1111-4111-8111-111111111111';
const activity=()=>({id:'',_intent:intent,_revision:'',_lifecycle:'',title:' 原標題 ',category:'约K',location:' 原地點 ',description:'第一行\n第二行',fee_policy:' 原費用 ',capacity_unlimited:false,capacity:'8',minimum_participants:'2',timezone:'America/New_York',visibility:'public',event_date:'2026-03-07',start_time:'01:30',start_day_offset:'1',duration_hours:'3',deadline:'2026-03-06T23:59',withdrawal_deadline:'2026-03-07T00:30',bot_enabled:true,reason:'原原因'});
const poll=()=>({title:'原投票',category:'约K',location:'原地點',description:'原說明',timezone:'America/New_York',bot_enabled:false,duration_hours:'3',capacity:'',minimum_participants:'2',deadline_date:'2026-03-06',deadline_time:'12:34',exact_time:false,slots:[{key:'second',date:'2026-03-09',time:'20:00'},{key:'first',date:'2026-03-08',time:'18:00'}],client_intent:intent,deadlineTouched:true});
const row=(value:unknown,kind='event:new',extra={})=>{const source={key:'draft:'+scope+':'+kind,data:{react:1,value,revision:undefined,...extra},at:123};return {id:'b'.repeat(64),scope,sourceKey:source.key,source,raw:legacyRaw(source),savedAt:456} satisfies LegacySnapshot;};
const draft=(record:LegacySnapshot,target:{id:string;route:'draft'|'arrangements'|'poll'}|null=null,zone='')=>JSON.parse(authoringDraft(record,decodeAuthoring(record,scope),target,zone).raw);
describe('actual legacy activity/poll form conversion',()=>{
  it('preserves text, settings, intent and calendar-day shifts across DST in the original event zone',()=>{
    const r=row(activity()),result=draft(r);expect(result).toMatchObject({id:null,revision:0,clientIntent:intent,reason:'原原因',form:{title:' 原標題 ',location:' 原地點 ',description:'第一行\n第二行',feePolicy:' 原費用 ',capacity:'8',minimumParticipants:'2',botEnabled:true,joinOwner:true,timezone:'America/New_York',startsAt:'2026-03-08T01:30:00',deadline:'2026-03-06T23:59:00',withdrawalDeadline:'2026-03-07T00:30:00'},legacySource:{id:r.id,baseRevision:null,reviewRequired:false,notes:[]}});expect(r.raw).toContain(intent);
    const unlimited=draft(row({...activity(),capacity_unlimited:true}));expect(unlimited.form.capacity).toBe('0');expect(unlimited.form.durationHours).toBe('3');
    expect(originalWallISO(result.form.startsAt.slice(0,16),result.form.timezone)).toBe('2026-03-08T06:30:00.000Z');
  });
  it('matches original wallToISO and rejects repeated, nonexistent, skipped and invalid wall calendars',()=>{
    const source=readFileSync('public/app.js','utf8'),from=source.indexOf('function wallDate('),to=source.indexOf('const zoneLabel=',from);
    const original=runInNewContext('const effectiveZone=z=>z;'+source.slice(from,to)+';wallToISO',{Intl,Date,Set});
    for(const [time,zone] of [['2026-03-08T01:30','America/New_York'],['2026-04-05T01:20','Australia/Lord_Howe'],['2026-11-18T18:00','Asia/Taipei'],['2026-11-18T18:00','Asia/Kathmandu']])expect(originalWallISO(time!,zone!)).toBe(original(time,zone));
    for(const [time,zone] of [['2026-03-08T02:30','America/New_York'],['2026-11-01T01:30','America/New_York'],['2011-12-30T18:00','Pacific/Apia'],['2026-04-05T01:40','Australia/Lord_Howe'],['2026-02-30T18:00','Asia/Taipei']])expect(()=>originalWallISO(time!,zone!)).toThrow();
  });
  it('keeps ambiguous/incomplete original times and missing zones as notes without making up inputs',()=>{
    const ambiguous=draft(row({...activity(),event_date:'2026-11-01',start_day_offset:'0'}));expect(ambiguous.form.startsAt).toBe('');expect(ambiguous.legacySource.notes).toContainEqual(expect.objectContaining({field:'開始時間',original:'2026-11-01T01:30',message:expect.stringContaining('重複')}));
    const incomplete=draft(row({...activity(),event_date:'',start_day_offset:''}));expect(incomplete.form.startsAt).toBe('');expect(incomplete.legacySource.notes[0].original).toContain('01:30');
    const missing=row({...activity(),timezone:''});expect(draft(missing).form.startsAt).toBe('');expect(draft(missing).form.timezone).toBe('');expect(draft(missing,null,'America/New_York').form.startsAt).toBe('2026-03-08T01:30:00');
  });
  it('preserves date/exact candidate order and empty numbers; date deadline uses 23:59, not the captured clock',()=>{
    const dates=draft(row(poll(),'time-poll:new'));expect(dates.value).toMatchObject({options:['2026-03-09','2026-03-08'],capacity:'',minimum_participants:'2',deadline:'2026-03-07T04:59:00.000Z',time_mode:'date',client_intent:intent,bot_enabled:false});
    const exact=draft(row({...poll(),exact_time:true},'time-poll:new'));expect(exact.value.options).toEqual(['2026-03-10T00:00:00.000Z','2026-03-08T22:00:00.000Z']);expect(exact.value.deadline).toBe('2026-03-06T17:34:00.000Z');
  });
  it('binds known existing outcomes and retains missing/stale base revisions until explicit review, including original markEventCreated captures',()=>{
    const recovered=row({...activity(),id:'original-id',_revision:-1,_lifecycle:'scheduled'},'event:new',{revision:-1,warning:'原活动已创建；请保留需要的文字，载入该活动最新版后再编辑'});
    const result=draft(recovered,{id:'original-id',route:'arrangements'});expect(result).toMatchObject({id:'original-id',revision:0,legacySource:{baseRevision:null,reviewRequired:true,resolvedId:'original-id'},form:{title:' 原標題 '}});
    const edit=row({...activity(),id:'original-id',_revision:7,_lifecycle:'draft'},'event:original-id',{revision:7});expect(draft(edit,{id:'original-id',route:'draft'})).toMatchObject({revision:7,legacySource:{baseRevision:7,reviewRequired:true}});expect(decodeAuthoring(edit,scope).creation).toBe(false);
    expect(draft(row(poll(),'time-poll:new'),{id:'original-poll',route:'poll'}).value.legacySource).toMatchObject({resolvedId:'original-poll'});
  });
  it('decodes original fields/checkboxes/dataset and rejects unknown or duplicate fields instead of dropping them',()=>{
    const value=activity(),fields=Object.entries(value).filter(([name])=>!name.startsWith('_')).map(([name,value])=>({name,value:typeof value==='boolean'?'on':String(value),checked:typeof value==='boolean'?value:undefined}));
    const source={key:'draft:'+scope+':event:new',at:123,data:{fields,dataset:{intent,revision:'',lifecycle:'',previousEarly:'true'}}},record={...row(activity()),sourceKey:source.key,source,raw:legacyRaw(source)};
    expect(draft(record).form.startsAt).toBe('2026-03-08T01:30:00');expect(()=>decodeAuthoring(row({...value,unknown:'retained'}),scope)).toThrow('格式尚未支援');
    for(const extra of [{name:'future-field',value:'retained'},{name:'title',value:'different'}])expect(()=>decodeAuthoring({...record,source:{...source,data:{...source.data,fields:[...fields,extra]}}},scope)).toThrow('重複欄位');
  });
  it('requires exact poll candidate coverage and rejects extra, missing, duplicate or mismatched calendar fields',()=>{
    const value=poll(),fields=[...Object.entries(value).filter(([name])=>!['slots','client_intent','deadlineTouched'].includes(name)).map(([name,v])=>({name,value:typeof v==='boolean'?'on':String(v),...(typeof v==='boolean'?{checked:v}:{})})),...value.slots.flatMap(slot=>[{name:'poll_day_'+slot.key,value:slot.date},{name:'poll_time_'+slot.key,value:slot.time}])];
    const record=(fields:unknown[],slots:unknown=value.slots)=>{const source={key:'draft:'+scope+':time-poll:new',at:123,data:{fields,...(slots===null?{}:{slots}),intent}};return {...row(value,'time-poll:new'),source,raw:legacyRaw(source)};};
    expect(draft(record(fields)).value.options).toEqual(['2026-03-09','2026-03-08']);
    for(const bad of [[...fields,{name:'poll_day_extra',value:'2026-03-11'}],fields.filter(f=>f.name!=='poll_time_first'),fields.map(f=>f.name==='poll_day_first'?{...f,value:''}:f),[...fields,{name:'slot_0',value:'2026-03-11T18:00'}], [...fields,{name:'poll_day_first',value:'2026-03-08'}]])expect(()=>decodeAuthoring(record(bad),scope)).toThrow();
    expect(()=>decodeAuthoring(record(fields,[value.slots[0],{...value.slots[1],key:'second'}]),scope)).toThrow('重複');
    const oldFields=fields.filter(f=>!/^poll_(day|time)_|^deadline_(date|time)$|^exact_time$/.test(f.name)).concat([{name:'option_count',value:'2'},{name:'deadline',value:'2026-03-06T12:34'},{name:'slot_0',value:'2026-03-09T20:00'},{name:'slot_1',value:'2026-03-08T18:00'}]);
    expect(draft(record(oldFields,null)).value.options).toEqual(['2026-03-10T00:00:00.000Z','2026-03-08T22:00:00.000Z']);
    expect(()=>decodeAuthoring(record([...oldFields,{name:'slot_2',value:'2026-03-11T18:00'}],null),scope)).toThrow('數量');
  });
});
