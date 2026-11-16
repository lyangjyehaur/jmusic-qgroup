import { randomBytes } from 'node:crypto';
import type { DB } from '@qgroup/database';
import { DomainError } from '@qgroup/domain';
import { activityState } from '@qgroup/domain';
import { appendEventAudit, arrangementSnapshot, arrangementValues, eventRow, eventSnapshot, legacyStamp, type EventRow } from './activity-arrangements';
import type { ActivityArrangementInput } from '@qgroup/contracts';
import type { z } from 'zod';
import { createActivityBot, type ActivityBotDefaults } from './activity-bot';
const rosterFields=['id','nickname','note','status','payer_kind','manager_name','withdrawal_requested','withdrawal_reason','created_at','updated_at','party_id','queue_mode','accepted_conditions_version','confirmation_state','attendance','attendance_note','arrived_at','left_at'] as const;
type Person=Record<string,string|number|null> & {id:string;nickname:string;manager_id:string;party_id:string|null;status:string;queue_mode:string|null};
export function activityPeople(db:DB,id:string){return db.prepare(`SELECT a.*,COALESCE(u.nickname,a.name) AS nickname,m.nickname AS manager_name,p.queue_mode FROM attendees a JOIN users m ON m.id=a.manager_id LEFT JOIN users u ON u.id=a.user_id LEFT JOIN roster_parties p ON p.id=a.party_id WHERE a.event_id=? ORDER BY p.seq,a.seq`).all(id) as Person[];}
export function activityPeopleSnapshot(db:DB,id:string){return new Map(activityPeople(db,id).map(row=>[row.id,Object.fromEntries(rosterFields.map(key=>[key,row[key]]))]));}
export function rosterDelta(before:ReturnType<typeof activityPeopleSnapshot>,after:ReturnType<typeof activityPeopleSnapshot>){const changed=[...new Set([...before.keys(),...after.keys()])].sort().filter(id=>JSON.stringify(before.get(id))!==JSON.stringify(after.get(id)));return {prior:changed.filter(id=>before.has(id)).map(id=>before.get(id)!),current:changed.filter(id=>after.has(id)).map(id=>after.get(id)!)};}
/** Keep confirmed places; a blocked together party prevents every later waiting party. */
export function allocateActivity(existing:readonly {id:string;party_id:string|null;status:string;queue_mode:string|null}[],capacity:number,candidates:readonly string[]=[],mode='individual'){
  let remaining=capacity===0?1000000:Math.max(0,capacity-existing.filter(person=>person.status==='confirmed').length);let blocked=false;
  const groups:{partyId:string|null;mode:string|null;ids:string[]}[]=[];
  for(const person of existing){if(person.status!=='waiting')continue;const last=groups.at(-1);if(last&&last.partyId===person.party_id)last.ids.push(person.id);else groups.push({partyId:person.party_id,mode:person.queue_mode,ids:[person.id]});}
  if(candidates.length)groups.push({partyId:'new',mode,ids:[...candidates]});const result=new Map<string,'waiting'|'confirmed'>();
  for(const group of groups){if(group.mode==='together'&&group.ids.length>remaining)blocked=true;for(const id of group.ids){const status=blocked||remaining<=0?'waiting':'confirmed';result.set(id,status);if(status==='confirmed')remaining--;}}
  return result;
}
export function publishActivityDraft(db:DB,event:EventRow,user:{id:string;nickname:string},now:()=>Date,values:z.infer<typeof ActivityArrangementInput>,defaults:ActivityBotDefaults,hookError:(eventId:string)=>void){
  if(event.lifecycle!=='draft')throw new DomainError('NOT_A_DRAFT','只有草稿可以發布',409);
  // Validate the stored arrangement as well as the revision supplied by the caller.
  arrangementValues(values,now(),false,event);
  const stamp=legacyStamp(now());
  if(Date.parse(event.starts_at)<=now().getTime())throw new DomainError('ACTIVITY_START_PASSED','請先把草稿的活動時間調整到將來',409);
  if(Date.parse(event.deadline)<=now().getTime())throw new DomainError('ACTIVITY_DEADLINE_PASSED','報名截止已過，請先調整截止時間',409);
  if(event.archived_at||db.prepare('SELECT 1 FROM settlements WHERE event_id=?').get(event.id))throw new DomainError('ACTIVITY_LOCKED','活動已有歸檔或結算記錄，不能發布',409);
  if(db.prepare("SELECT 1 FROM attendees WHERE event_id=? AND user_id=? AND status!='withdrawn'").get(event.id,user.id))throw new DomainError('ALREADY_REGISTERED','你已報名或待確認，請先核對原報名',409);
  const before=eventSnapshot(event),rosterBefore=activityPeopleSnapshot(db,event.id);
  db.prepare("UPDATE events SET lifecycle='scheduled',registration_open=1,status='open',draft_join_owner=1 WHERE id=?").run(event.id);
  const published=eventRow(db,event.id)!;
  db.prepare('INSERT INTO event_conditions(event_id,version,snapshot_json,summary,actor_name,created_at) VALUES(?,?,?,?,?,?)').run(event.id,published.conditions_version,JSON.stringify(arrangementSnapshot(published)),'初始安排',user.nickname,stamp);
  const partyId=randomBytes(8).toString('hex'),personId=randomBytes(8).toString('hex');
  const allocation=allocateActivity(activityPeople(db,event.id),event.capacity,[personId]);const status=allocation.get(personId)!;
  db.prepare("INSERT INTO roster_parties(id,event_id,manager_id,queue_mode,created_at) VALUES(?,?,?,'individual',?)").run(partyId,event.id,user.id,stamp);
  db.prepare("INSERT INTO attendees(id,event_id,manager_id,user_id,party_id,name,note,payer_kind,status,created_at,updated_at,accepted_conditions_version,confirmation_state) VALUES(?,?,?,?,?,?,'','self',?,?,?,?, 'accepted')").run(personId,event.id,user.id,user.id,partyId,user.nickname,status,stamp,stamp,published.conditions_version);
  db.prepare("INSERT INTO attendee_consents(attendee_id,event_id,version,decision,actor_id,actor_name,reason,created_at) VALUES(?,?,?,'accepted',?,?,'报名时接受当前安排',?)").run(personId,event.id,published.conditions_version,user.id,user.nickname,stamp);
  db.prepare('INSERT OR IGNORE INTO event_access(event_id,user_id,created_at) VALUES(?,?,?)').run(event.id,user.id,stamp);
  const bot=createActivityBot(db,now,defaults);
  if(activityState(published,now()).registrationOpen){
    const people=activityPeople(db,event.id),assignments=allocateActivity(people,event.capacity);
    for(const person of people)if(person.status==='waiting'&&assignments.get(person.id)==='confirmed'){
      db.prepare("UPDATE attendees SET status='confirmed',updated_at=? WHERE id=?").run(stamp,person.id);
      db.prepare("INSERT INTO notifications(user_id,event_id,kind,message,created_at) VALUES(?,?,'promoted',?,?)").run(person.manager_id,event.id,person.nickname+' 已递补为正式报名',stamp);
      try{db.transaction(()=>bot.promoted(event.id,person.manager_id))();}catch{hookError(event.id);}
    }
  }
  const after=activityPeopleSnapshot(db,event.id),delta=rosterDelta(rosterBefore,after);
  appendEventAudit(db,published,user,'signup',{participants:delta.prior},{participants:delta.current},'',stamp);
  appendEventAudit(db,event,user,'event_publish',{event:before,participants:delta.prior},{event:eventSnapshot(eventRow(db,event.id)!),participants:delta.current},'',stamp);
  // Publication includes the final auto-signup roster. No duplicate signup broadcast.
  try{db.transaction(()=>bot.publication(event.id))();}catch{hookError(event.id);}
  return {id:event.id,revision:eventRow(db,event.id)!.revision,removed:false};
}
