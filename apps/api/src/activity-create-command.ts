import { randomBytes } from 'node:crypto';
import type { DB } from '@qgroup/database';
import { LegacyActivityCreationValues, type ActivityArrangementInput } from '@qgroup/contracts';
import type { z } from 'zod';
import { DomainError } from '@qgroup/domain';
import { withApiError } from './error-display';
import { arrangementValues, validateArrangementValues, arrangementSnapshot, eventRow, eventSnapshot, appendEventAudit, legacyStamp } from './activity-arrangements';
import { createActivityBot, type ActivityBotDefaults } from './activity-bot';
import { allocateActivity } from './activity-publish';
/** No IDs, writes or bot work are allocated by preparation. */
export function prepareActivityCreation(input:z.infer<typeof ActivityArrangementInput>,time:Date,lifecycle:'draft'|'scheduled',original=false) {
 const values=original?validateArrangementValues(LegacyActivityCreationValues.parse(input),time,lifecycle==='draft'):arrangementValues(input,time,lifecycle==='draft');
 if(lifecycle==='scheduled'&&values.joinOwner&&Date.parse(values.deadline)<=time.getTime())throw withApiError(new DomainError('ACTIVITY_CREATE_DEADLINE','報名截止已過，請調整截止時間',400));
 return {values,lifecycle};
}
/** Original creation order: access -> conditions -> created audit -> optional owner signup audit -> bot. */
export function executeActivityCreation(db:DB,plan:ReturnType<typeof prepareActivityCreation>,user:{id:string;nickname:string},time:Date,defaults:ActivityBotDefaults,hook:(work:()=>unknown)=>void){
 const {values:v,lifecycle}=plan;
  const id = randomBytes(8).toString('hex'),
    stamp = legacyStamp(time);
  db.prepare(
    `INSERT INTO events(id,owner_id,title,category,location,starts_at,deadline,capacity,description,duration_hours,created_at,withdrawal_deadline,visibility,invite_token,lifecycle,registration_open,status,timezone,minimum_participants,fee_policy,draft_join_owner,bot_enabled)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    user.id,
    v.title,
    v.category,
    v.location,
    v.startsAt,
    v.deadline,
    v.capacity,
    v.description,
    v.durationHours,
    stamp,
    v.withdrawalDeadline,
    v.visibility,
    randomBytes(24).toString('base64url'),
    lifecycle,
    Number(lifecycle!=='draft'),
    lifecycle==='draft'?'closed':'open',
    v.timezone,
    v.minimumParticipants,
    v.feePolicy,
    Number(v.joinOwner),
    Number(v.botEnabled),
  );
  db.prepare('INSERT INTO event_access VALUES(?,?,?)').run(id, user.id, stamp);
  let event = eventRow(db, id)!;
  if(lifecycle!=='draft')db.prepare('INSERT INTO event_conditions VALUES(?,?,?,?,?,?)').run(
    id,
    1,
    JSON.stringify(arrangementSnapshot(event)),
    '初始安排',
    user.nickname,
    stamp,
  );
  appendEventAudit(db, event, user, 'event_created', {}, eventSnapshot(event), '', stamp);
  if(lifecycle!=='draft'&&v.joinOwner){
  const party = randomBytes(8).toString('hex'),
    person = randomBytes(8).toString('hex'),
    status = allocateActivity([], event.capacity, [person]).get(person)!;
  db.prepare(
    "INSERT INTO roster_parties(id,event_id,manager_id,queue_mode,created_at) VALUES(?,?,?,'individual',?)",
  ).run(party, id, user.id, stamp);
  db.prepare(
    "INSERT INTO attendees(id,event_id,manager_id,user_id,party_id,name,note,payer_kind,status,created_at,updated_at,accepted_conditions_version,confirmation_state) VALUES(?,?,?,?,?,?,'','self',?,?,?,1,'accepted')",
  ).run(person, id, user.id, user.id, party, user.nickname, status, stamp, stamp);
  db.prepare(
    "INSERT INTO attendee_consents(attendee_id,event_id,version,decision,actor_id,actor_name,reason,created_at) VALUES(?,?,1,'accepted',?,?,'报名时接受当前安排',?)",
  ).run(person, id, user.id, user.nickname, stamp);
  const participants = db
    .prepare(
      `SELECT a.id,COALESCE(u.nickname,a.name) AS nickname,a.note,a.status,a.payer_kind,m.nickname AS manager_name,a.withdrawal_requested,a.withdrawal_reason,a.created_at,a.updated_at,a.party_id,p.queue_mode,a.accepted_conditions_version,a.confirmation_state,a.attendance,a.attendance_note,a.arrived_at,a.left_at FROM attendees a LEFT JOIN users u ON u.id=a.user_id JOIN users m ON m.id=a.manager_id LEFT JOIN roster_parties p ON p.id=a.party_id WHERE a.id=?`,
    )
    .all(person);
  event = eventRow(db, id)!;
  appendEventAudit(db, event, user, 'signup', { participants: [] }, { participants }, '', stamp);
  }
  hook(() => createActivityBot(db,()=>time,defaults).publication(id));
  return id;
}
