import type { DB } from '@qgroup/database';
import { z } from 'zod';
import { BOT_MAX_CHARS, botContentProblem, botLength, botLocalTime, botMoment, botRosterName, botStartCountdown, botStrip, botTimeChange, renderBotBroadcast, renderBotTemplate, withBotRoster } from '@qgroup/domain';
import { eventRow, legacyStamp, type EventRow } from './activity-arrangements';
import { hash } from './security';

const labels={activity_published:'活动发起',formation_confirmed:'已成团',conditions_changed:'安排变更',event_started:'活动开始',event_finished:'活动结束',event_cancelled:'活动取消',deadline_reminder:'报名即将截止',estimated_over_reminder:'活动时间已到',registration_paused:'暂停报名',registration_resumed:'恢复报名',registration_added:'有人报名',registration_changed:'报名变动'};
type Kind=keyof typeof labels;
const allKinds=['time_poll_published',...Object.keys(labels),'settlement_updated','finance_closed','finance_reopened','ownership_changed'];
const rosterKinds=new Set<Kind>(['activity_published','formation_confirmed','conditions_changed','deadline_reminder','registration_paused','registration_resumed']);
const reminders=['deadline_reminder','estimated_over_reminder'] as const;
export interface ActivityBotDefaults {enabled?:boolean;scheduleEnabled?:boolean;broadcastKinds?:string[];baseURL?:string;keyboard?:boolean;personalQueue?:boolean}
const policySchema=z.object({enabled:z.boolean(),schedule_enabled:z.boolean(),broadcast_kinds:z.array(z.string()),deadline_hours:z.number().int().min(1).max(720),estimated_over_delay_minutes:z.number().int().min(0).max(1440),templates:z.record(z.string(),z.string()),groups:z.array(z.object({id:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),name:z.string(),replies:z.boolean(),broadcast:z.boolean()})).max(100).nullable()});
export function activityBotPolicy(db:DB,defaults:ActivityBotDefaults={}){
  const row=db.prepare('SELECT revision,config_json FROM bot_settings WHERE id=1').get() as {revision:number;config_json:string}|undefined;
  return {revision:row?.revision??0,config:policySchema.parse({enabled:defaults.enabled??false,schedule_enabled:defaults.scheduleEnabled??true,broadcast_kinds:defaults.broadcastKinds??allKinds,deadline_hours:24,estimated_over_delay_minutes:0,templates:{},groups:null,...(row?JSON.parse(row.config_json):{})})};
}
type Policy=ReturnType<typeof activityBotPolicy>['config'];
type Context=Record<string,string|number|boolean|null|string[]|{starts_at:string;timezone:string|null;lifecycle:string}>;
type Button=[label:string,data:string,jump:string];
const cut=(text:string,n:number)=>Array.from(text).slice(0,n).join('');
export function botShareable(event:EventRow|undefined){return !!event&&event.visibility==='public'&&event.lifecycle!=='draft'&&event.status!=='deleted'&&!!event.bot_enabled;}
export function botActivityURL(id:string,action:string|undefined,defaults:ActivityBotDefaults={}){
  return (defaults.baseURL??'https://kanban.danndann.cn').replace(/\/+$/,'')+'/?event='+id+(action?'&action='+encodeURIComponent(action):'');
}
function counts(db:DB,id:string){return db.prepare(`SELECT COALESCE(SUM(status='confirmed'),0) AS confirmed,COALESCE(SUM(status='waiting'),0) AS waiting,COALESCE(SUM(confirmation_state='pending' AND status IN ('confirmed','waiting','tentative')),0) AS pending FROM attendees WHERE event_id=?`).get(id) as {confirmed:number;waiting:number;pending:number};}
export function botRosterLines(db:DB,event:EventRow,options:{ids?:Set<string>;prefix?:string;groups?:[string,string][]}={}){
  if(event.visibility!=='public'||event.lifecycle==='draft'||event.status==='deleted')return [];
  const groups=options.groups??[['confirmed','正式报名'],['waiting','候补']];
  const people=db.prepare(`SELECT a.id,COALESCE(u.nickname,a.name) AS nickname,a.status FROM attendees a LEFT JOIN users u ON u.id=a.user_id LEFT JOIN roster_parties p ON p.id=a.party_id WHERE a.event_id=? AND a.status IN (${groups.map(()=>'?').join(',')}) ORDER BY p.seq,a.seq`).all(event.id,...groups.map(([status])=>status)) as {id:string;nickname:string;status:string}[];
  return groups.map(([status,label])=>{const names=people.filter(p=>p.status===status&&(!options.ids||options.ids.has(p.id))).map(p=>botRosterName(p.nickname));return (options.prefix??'')+label+'（'+names.length+' 人）：'+(names.slice(0,10).join('、')||'暂无')+(names.length>10?'；其余 '+(names.length-10)+' 人请到活动页查看':'');});
}
function registrationLabel(event:EventRow,now:Date){
  if(['ended','cancelled'].includes(event.lifecycle)||event.archived_at)return '已结束报名';
  if(event.lifecycle==='ongoing'||botMoment(event.starts_at,event.timezone)<=now.getTime())return '已开始，补报名请联系发起者';
  if(botMoment(event.deadline,event.timezone)<=now.getTime())return '已截止，补报名请联系发起者';return event.registration_open?'开放报名':'已暂停报名';
}
function withCountdown(text:string,countdown:string,markdown=false){if(!countdown)return text;const split=text.indexOf('\n');const head=split<0?text:text.slice(0,split);const rest=split<0?'':text.slice(split+1);const decorated=head+'\n'+(markdown?'**'+countdown+'**':countdown)+(split<0?'':'\n')+rest;return botLength(decorated)<=4000?decorated:text;}
export function renderActivityBot(config:Policy,kind:Kind,context:Context,now:Date,markdown=false):string|null{
  const timing=context._countdown_event;const countdown=botStartCountdown(timing&&typeof timing==='object'&&!Array.isArray(timing)?timing:null,now);
  const roster=rosterKinds.has(kind)&&Array.isArray(context._roster_lines)?context._roster_lines:null;
  if(!markdown){const text=Object.hasOwn(config.templates,kind)?renderBotTemplate(config.templates,kind,context)!:String(context._default_text);return withBotRoster(withCountdown(text,countdown),roster);}
  let custom:string|null;try{custom=renderBotTemplate(config.templates,kind,context,true);}catch{return null;}
  let text:string;
  if(custom)text=withCountdown(custom,countdown,true);
  else{
    const url=String(context.url??'');if(!url)return null;
    const facts=Array.isArray(context._details_lines)?context._details_lines:String(context.details??'').split('\n').filter(line=>botStrip(line));
    const comparison=kind==='conditions_changed'?botTimeChange(context.previous_starts_at,context.starts_at):null;
    text=renderBotBroadcast(String(context._label??labels[kind]),String(context.title??''),facts,url,{systemFacts:[...(countdown?['- **'+countdown+'**']:[]),...(comparison?[comparison]:[])]});
  }
  if(countdown&&botLength(text)>BOT_MAX_CHARS)return renderActivityBot(config,kind,{...context,_countdown_event:null},now,true);
  text=withBotRoster(text,roster,true);return botContentProblem(text)?null:text;
}
export function buildActivityBotMessage(db:DB,event:EventRow,kind:Kind,config:Policy,now:Date,defaults:ActivityBotDefaults={},attendeeIds?:string[]){
  if(!botShareable(event))return null;
  const actions:Partial<Record<Kind,string>>={activity_published:'join',conditions_changed:'conditions',event_finished:'settlement',event_cancelled:'finance',deadline_reminder:'join',estimated_over_reminder:'manage'};
  const url=botActivityURL(event.id,actions[kind],defaults),when=botLocalTime(event.starts_at,event.timezone),deadline=botLocalTime(event.deadline,event.timezone),title=cut(event.title,40);
  const {confirmed,waiting,pending}=counts(db,event.id);const head='【'+labels[kind]+'】'+title;
  let lines:string[],buttons:Button[];
  if(kind==='activity_published'){
    lines=[head,'时间：'+when,'地点：'+event.location,'报名截止：'+deadline];if(event.fee_policy)lines.push('费用：'+cut(event.fee_policy,120));if(event.minimum_participants)lines.push('最低成团：'+event.minimum_participants+' 人');if(event.description)lines.push(cut(event.description,120));lines.push('',url);buttons=[['我要报名','',url],['看名额','/名额',''],['待办','/待办','']];
  }else if(kind==='formation_confirmed'){lines=[head,'发起者已确认成团，当前正式报名 '+confirmed+' 人','时间：'+when,'地点：'+event.location,'',url];buttons=[['活动详情','',url],['看名额','/名额','']];
  }else if(kind==='conditions_changed'){lines=[head+'（第 '+event.conditions_version+' 版）',cut(event.change_summary||'重要安排有变更',120),'原报名与原约定保留，请到站内逐人确认。'];if(pending)lines.push('待确认：'+pending+' 人');lines.push('',url);buttons=[['去确认','',url],['待办','/待办','']];
  }else if(kind==='event_started'){lines=[head,'时间：'+when,'地点：'+event.location,'现场如需补录，请到站内「现场补录」操作。','',url];buttons=[['现场补录','',botActivityURL(event.id,'onsite',defaults)],['出席','/出席','']];
  }else if(kind==='event_finished'){lines=[head,'请核对出席与款项申报；结算由发起者发布后另行通知。','',url];buttons=[['活动页','',url],['待办','/待办','']];
  }else if(kind==='event_cancelled'){lines=[head,'原因：'+cut(event.cancellation_reason||'未填写',120),'名单与账务保留，费用以公布的结算为准。','',url];buttons=[['活动页','',url]];
  }else if(kind==='deadline_reminder'){lines=[head,'报名截止：'+deadline,'当前正式报名 '+confirmed+' 人',...(waiting?['候补 '+waiting+' 人']:[]),url];buttons=[['我要报名','',url],['看名额','/名额','']];
  }else if(kind==='estimated_over_reminder'){lines=[head,'已超过预计结束时间，请发起者确认实际结束或延长。','',url];buttons=[['活动页','',url],['待办','/待办','']];
  }else if(kind==='registration_paused'||kind==='registration_resumed'){lines=[head,registrationLabel(event,now),'原名单与候补保留，名额按当前队列分配。','',botActivityURL(event.id,'join',defaults)];buttons=[['看名额','/名额','']];
  }else{
    const changed=kind==='registration_changed';const names=attendeeIds?.length?botRosterLines(db,event,changed?{ids:new Set(attendeeIds),groups:[['withdrawn','本次退出'],['confirmed','递补为正式']]}:{ids:new Set(attendeeIds),prefix:'本次'}):[changed?'退出或候补递补详情请到活动页查看。':'本次新增报名请到活动页查看。'];
    lines=[head,'时间：'+when,'地点：'+event.location,...names,'当前正式报名 '+confirmed+' 人，候补 '+waiting+' 人','',url];buttons=[['活动详情','',url],['看名额','/名额','']];
  }
  const original=lines.join('\n');lines=original.split('\n');let previous='';
  try{const row=db.prepare('SELECT snapshot_json FROM event_conditions WHERE event_id=? AND version<? ORDER BY version DESC LIMIT 1').get(event.id,event.conditions_version) as {snapshot_json:string}|undefined;const prior=row?JSON.parse(row.snapshot_json):null;previous=prior?.starts_at?botLocalTime(prior.starts_at,event.timezone):'';}catch{/* Optional old comparison history never breaks composition. */}
  const context:Context={heading:lines[0]!,details:botStrip(lines.slice(1,-1).join('\n')),url:lines.at(-1)!,title,starts_at:when,previous_starts_at:previous,deadline,location:event.location,confirmed:String(confirmed),waiting:String(waiting),fee_policy:cut(event.fee_policy||'',120),description:cut(event.description||'',120),version:String(event.conditions_version),change_summary:cut(event.change_summary||'',120),cancellation_reason:cut(event.cancellation_reason||'',120),_default_text:original,_countdown_event:{starts_at:event.starts_at,timezone:event.timezone,lifecycle:event.lifecycle},_label:labels[kind],_details_lines:lines.slice(1,-1).filter(line=>botStrip(line))};
  if(rosterKinds.has(kind))context._roster_lines=botRosterLines(db,event);
  const text=renderActivityBot(config,kind,context,now)!;const markdown=renderActivityBot(config,kind,context,now,true);
  return {text,markdown,context,buttons};
}
export function createActivityBot(db:DB,now:()=>Date,defaults:ActivityBotDefaults={}){
  function enqueue(event:EventRow,kind:Kind,planned:NonNullable<ReturnType<typeof buildActivityBotMessage>>,policy:Policy,options:{factKey:string;dueAt?:string;scheduleKey?:string}){
    if(!policy.enabled||!policy.broadcast_kinds.includes(kind)||!botShareable(event))return false;
    const target=policy.groups===null?'':policy.groups.find(group=>group.broadcast)?.id;if(target===undefined)return false;
    const payload:Record<string,unknown>={text:planned.text,msg_type:0,_template_context:planned.context};if(planned.markdown&&botStrip(planned.markdown))payload.markdown_text=planned.markdown;
    if(options.scheduleKey)payload._schedule_key=options.scheduleKey;
    if(defaults.keyboard)payload.keyboard={content:{rows:planned.buttons.map(([label,data,jump],index)=>({buttons:[{id:String(index+1),render_data:{label,visited_label:label,style:1},action:jump?{type:0,permission:{type:2},data:jump}:{type:1,permission:{type:2},data:data?data+' '+event.id:''}}]}))}};
    const dedupe=hash(kind+'\ngroup\n'+target+'\n\n'+options.factKey).slice(0,32);
    return db.prepare("INSERT OR IGNORE INTO bot_outbox(event_id,kind,dedupe_key,channel,target,payload_json,due_at,status,created_at,recipient_user_id,poll_id) VALUES(?,?,?,'group',?,?,?,'pending',?,NULL,NULL)").run(event.id,kind,dedupe,target,JSON.stringify(payload),options.dueAt??null,legacyStamp(now())).changes>0;
  }
  function reminderPlan(event:EventRow,kind:typeof reminders[number],config:Policy){
    if(!botShareable(event)||!['scheduled','ongoing'].includes(event.lifecycle)||event.archived_at||!config.enabled||!config.schedule_enabled||!config.broadcast_kinds.includes(kind))return null;
    if(kind==='estimated_over_reminder'&&!event.duration_hours)return null;
    const at=kind==='deadline_reminder'?botMoment(event.deadline,event.timezone)-config.deadline_hours*3600000:botMoment(event.starts_at,event.timezone)+(event.duration_hours??0)*3600000+config.estimated_over_delay_minutes*60000;
    if(!Number.isFinite(at))return null;const due=legacyStamp(new Date(at));return {due,key:hash(kind+'|'+due).slice(0,32)};
  }
  function schedule(event:EventRow){
    const policy=activityBotPolicy(db,defaults);
    for(const kind of reminders){const plan=reminderPlan(event,kind,policy.config);let retained=false;
      const rows=db.prepare('SELECT id,payload_json,status,last_error,simulated_at FROM bot_outbox WHERE event_id=? AND kind=?').all(event.id,kind) as {id:number;payload_json:string;status:string;last_error:string;simulated_at:string|null}[];
      for(const row of rows){let key:unknown=null;try{key=JSON.parse(row.payload_json)?._schedule_key;}catch{/* Obsolete malformed work is skipped. */}
        if((!plan||key!==plan.key)&&['pending','sending'].includes(row.status))db.prepare("UPDATE bot_outbox SET status='skipped',last_error='安排或群同步设置已变更，旧提醒作废' WHERE id=?").run(row.id);
        else if(plan&&key===plan.key&&(row.status!=='skipped'||row.last_error==='dry-run'||row.simulated_at))retained=true;
      }
      if(plan&&Date.parse(plan.due)>now().getTime()&&!retained){const planned=buildActivityBotMessage(db,event,kind,policy.config,now(),defaults);if(planned)enqueue(event,kind,planned,policy.config,{dueAt:plan.due,scheduleKey:plan.key,factKey:'schedule:'+plan.key+':revision:'+event.revision+':config:'+policy.revision});}
    }
  }
  function broadcast(event:EventRow,kind:Kind,attendeeIds?:string[]){const policy=activityBotPolicy(db,defaults);if(!policy.config.enabled)return false;const planned=buildActivityBotMessage(db,event,kind,policy.config,now(),defaults,attendeeIds);if(!planned)return false;const created=enqueue(event,kind,planned,policy.config,{factKey:kind==='conditions_changed'?String(event.conditions_version):'revision:'+event.revision});if(created&&kind==='activity_published')schedule(event);return created;}
  function publication(id:string){const policy=activityBotPolicy(db,defaults);if(!policy.config.enabled)return;const event=eventRow(db,id);if(!event)return;
    if(!botShareable(event))db.prepare("UPDATE bot_outbox SET status='skipped',last_error='活动已关闭公开群同步' WHERE event_id=? AND channel='group' AND status IN ('pending','sending')").run(id);
    schedule(event);if(event.lifecycle!=='draft')broadcast(event,'activity_published');
  }
  function personal(eventId:string,userId:string,kind:'promoted'|'conditions_declined'|'withdrawal_request'|'withdrawal_decision'|'removed'){
    if(!defaults.personalQueue||!activityBotPolicy(db,defaults).config.enabled)return;
    const label={promoted:'你的报名已递补为正式名额',conditions_declined:'有人暂不同意新安排，请协调处理',withdrawal_request:'有一条退出申请待处理',withdrawal_decision:'退出申请已有处理结果',removed:'你的报名已被撤销'}[kind];
    const text=label+'\n'+botActivityURL(eventId,undefined,defaults);const dedupe=hash(kind+'\nprivate\n\n'+userId+'\n'+text).slice(0,32);
    db.prepare("INSERT OR IGNORE INTO bot_outbox(event_id,kind,dedupe_key,channel,target,payload_json,due_at,status,created_at,recipient_user_id,poll_id) VALUES(?,?,?,'private','',?,NULL,'pending',?,?,NULL)").run(eventId,kind,dedupe,JSON.stringify({text,msg_type:0,...(defaults.keyboard?{keyboard:{content:{rows:[]}}}:{})}),legacyStamp(now()),userId);
  }
  function arrangementsUpdated(before:EventRow,promotedIds:string[]){
    if(!activityBotPolicy(db,defaults).config.enabled)return;
    const event=eventRow(db,before.id)!;
    if(!botShareable(event))db.prepare("UPDATE bot_outbox SET status='skipped',last_error='活动已关闭公开群同步' WHERE event_id=? AND channel='group' AND status IN ('pending','sending')").run(event.id);
    schedule(event);
    if(promotedIds.length)broadcast(event,'registration_changed',promotedIds);
    if(event.conditions_version!==before.conditions_version)broadcast(event,'conditions_changed');
    if(!before.bot_enabled&&event.bot_enabled)broadcast(event,'activity_published');
  }
  function lifecycleUpdated(id:string,action:string,promotedIds:string[]){
    if(!activityBotPolicy(db,defaults).config.enabled)return;
    const event=eventRow(db,id)!;
    if(!botShareable(event))db.prepare("UPDATE bot_outbox SET status='skipped',last_error='活动已关闭公开群同步' WHERE event_id=? AND channel='group' AND status IN ('pending','sending')").run(id);
    schedule(event);
    if(promotedIds.length)broadcast(event,'registration_changed',promotedIds);
    const kinds:Record<string,Kind>={formation:'formation_confirmed',start:'event_started',finish:'event_finished',cancel:'event_cancelled',pause:'registration_paused',resume:'registration_resumed'};
    if(kinds[action])broadcast(event,kinds[action]);
  }
  function rosterUpdated(id:string,action:string,before:{id:string;status:string}[],after:{id:string;status:string}[]){
    if(!activityBotPolicy(db,defaults).config.enabled)return;
    const event=eventRow(db,id)!,previous=new Map(before.map(person=>[person.id,person.status]));
    if(!botShareable(event))db.prepare("UPDATE bot_outbox SET status='skipped',last_error='活动已关闭公开群同步' WHERE event_id=? AND channel='group' AND status IN ('pending','sending')").run(id);
    const changed=after.filter(person=>(person.status==='withdrawn'&&['confirmed','waiting'].includes(previous.get(person.id)??''))||(person.status==='confirmed'&&previous.get(person.id)==='waiting')).map(person=>person.id);
    if(changed.length)broadcast(event,'registration_changed',changed);
    if(['signup','attendee_confirm','invitation_accepted'].includes(action)){
      const added=after.filter(person=>['confirmed','waiting'].includes(person.status)&&!['confirmed','waiting'].includes(previous.get(person.id)??'')).map(person=>person.id);
      if(added.length)broadcast(event,'registration_added',added);
    }
  }
  return {schedule,broadcast,publication,reminderPlan,personal,promoted:(eventId:string,userId:string)=>personal(eventId,userId,'promoted'),arrangementsUpdated,lifecycleUpdated,rosterUpdated};
}
